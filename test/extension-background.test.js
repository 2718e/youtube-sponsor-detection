// Drives the extension's service worker logic in Node with a fake chrome.*
// and a fake fetch, so caching, stats, cost accounting and the provider switch
// are covered.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStubClient } from './stub-client.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo-transcript.json', import.meta.url), 'utf8'));

let listener;
const store = {};
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      },
      async set(values) {
        Object.assign(store, structuredClone(values));
      }
    }
  }
};

const stub = createStubClient();
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const answer = await stub.systemOne(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => answer };
};

function ask(message) {
  return new Promise((resolve) => listener(message, {}, resolve));
}

before(async () => {
  await import('../extension/background.js');
});

test('analyze needs a key, then finds the segment and records stats', async () => {
  const noKey = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /API key/);

  const saved = await ask({ type: 'set-settings', settings: { apiKey: 'apikey_test' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.autoSkip, true);
  assert.equal(saved.provider.requiresKey, true);
  assert.equal(saved.provider.hasKey, true);

  const first = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.cached, false);
  assert.equal(first.result.status, 'found');
  assert.equal(first.result.segments.length, 1);
  assert.ok(first.result.segments[0].end.seconds > first.result.segments[0].start.seconds);
  assert.equal(first.requests, 6);
  assert.equal(calls.length, 6);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.match(calls[0].headers.authorization, /^Bearer apikey_test$/);
  assert.equal(calls[0].body.model, 'jev-latest');
  assert.ok(first.usage.input_tokens > 0);
  assert.ok(Math.abs(first.cost - first.usage.input_tokens * 0.042 / 1e6) < 1e-12);

  const again = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 6, 'a cached video costs nothing');

  const forced = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues, force: true });
  assert.equal(forced.cached, false);
  assert.equal(calls.length, 12);

  const state = await ask({ type: 'get-state' });
  assert.equal(state.stats.videosAnalyzed, 2);
  assert.equal(state.stats.requests, 12);
  assert.equal(state.stats.sponsorsFound, 2);
  assert.equal(state.cachedVideos, 1);
  assert.ok(state.stats.estimatedCost > 0);

  const skipped = await ask({ type: 'skipped', seconds: 96 });
  assert.equal(skipped.stats.skips, 1);
  assert.equal(skipped.stats.secondsSkipped, 96);

  const reset = await ask({ type: 'reset-stats' });
  assert.equal(reset.stats.videosAnalyzed, 0);
  const cleared = await ask({ type: 'clear-cache' });
  assert.equal(cleared.cachedVideos, 0);
});

test('a changed price is reflected in the estimate', async () => {
  await ask({ type: 'set-settings', settings: { apiKey: 'apikey_test', pricePerMillionInput: 1 } });
  const r = await ask({ type: 'analyze', videoId: 'xyz', title: 't', cues: fixture.cues });
  assert.ok(Math.abs(r.cost - r.usage.input_tokens / 1e6) < 1e-12);
});

test('a local provider needs no key, gets no Authorization header and is not priced', async () => {
  const saved = await ask({
    type: 'set-settings',
    settings: { modelUrl: 'http://127.0.0.1:8009', model: 'kev-0.8b', apiKey: 'apikey_secret' }
  });
  assert.equal(saved.provider.isLocal, true);
  assert.equal(saved.provider.requiresKey, false);
  assert.equal(saved.provider.hasKey, true);

  const before = calls.length;
  const r = await ask({ type: 'analyze', videoId: 'local1', title: 't', cues: fixture.cues });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cost, 0, 'a local server is free');
  assert.equal(r.provider.isLocal, true);

  const mine = calls.slice(before);
  assert.ok(mine.length > 0);
  for (const call of mine) {
    assert.equal(call.url, 'http://127.0.0.1:8009/v1/systemone');
    assert.equal(call.headers.authorization, undefined, 'the TypeSafe key must not leave for a local host');
    assert.equal(call.body.model, 'kev-0.8b');
  }
});

test('test-provider uses the fields as typed, without saving them', async () => {
  const before = calls.length;
  const r = await ask({ type: 'test-provider', provider: { protocol: 'systemone', modelUrl: 'http://127.0.0.1:8010', model: 'kev-4b' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.health.ok, true);
  assert.equal(r.health.endpoint, 'http://127.0.0.1:8010/v1/systemone');
  assert.equal(r.provider.model, 'kev-4b');

  const mine = calls.slice(before);
  assert.equal(mine.length, 1, 'health is one question');
  assert.equal(mine[0].url, 'http://127.0.0.1:8010/v1/systemone');
  assert.equal(mine[0].headers.authorization, undefined);

  const state = await ask({ type: 'get-state' });
  assert.equal(state.provider.endpoint, 'http://127.0.0.1:8009/v1/systemone', 'Test must not change the settings');
});

test('the panel and popup are told what the provider is', async () => {
  const state = await ask({ type: 'get-state' });
  assert.equal(state.provider.protocol, 'systemone');
  assert.equal(state.provider.endpoint, 'http://127.0.0.1:8009/v1/systemone');
  assert.equal(state.provider.model, 'kev-0.8b');
  assert.deepEqual(state.engine, state.provider.thresholds);
  assert.ok(Array.isArray(state.protocols) && state.protocols.length > 0);
  assert.equal(JSON.stringify(state.provider).includes('apikey_secret'), false, 'the key must never be described');
});
