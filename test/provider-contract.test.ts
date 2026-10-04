// The provider contract.
//
// Every model backend has to turn a canonical typed question into an answer the
// pipeline can read. This file is that requirement as a test: a provider that
// passes it can be swapped in without ../src/decisionModel/ changing, which is the
// whole point of the layer. Adding a backend means adding a case here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { createProvider, PROTOCOLS, PROTOCOL_PRESETS } from '../src/providers/index.js';
import { assertCanonical, normalizeAnswer, type Questions } from '../src/providers/contract.js';
import { createSystemOneProvider, TYPESAFE_HOST } from '../src/providers/systemone.js';
import { resetLimiters } from '../src/providers/limit.js';
import { createStubClient } from './stub-client.js';
import { buildLines, type Cue } from '../src/transcript.js';
import { findSponsorSegment } from '../src/decisionModel/findSponsorSegment.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo-transcript.json', import.meta.url), 'utf8')) as {
  title: string;
  cues: Cue[];
};

const questions: Questions = {
  sponsor_starts_here: { type: 'noul', instructions: { question: 'yes?' }, criteria: { true: 'yes', false: 'no' } },
  anchor_line: { type: 'choice', instructions: { question: 'which?' }, criteria: { L001: null, L002: null, none: 'nothing' } }
};

// A stand-in Jev on a real socket, so the contract is exercised over HTTP.
const stub = createStubClient();
let server: http.Server;
let url: string;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const answer = await stub.systemOne(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server?.close());

test('the registry builds a provider from configuration alone', () => {
  assert.ok(PROTOCOLS.systemone);
  const provider = createProvider({ protocol: 'systemone', url, model: 'kev-0.8b' });
  assert.equal(provider.protocol, 'systemone');
  assert.equal(provider.endpoint, `${url}/v1/systemone`);
  assert.equal(provider.isLocal, true);
  assert.equal(provider.requiresKey, false);
  // The popup offers what the registry knows, so a new backend shows up in the UI.
  assert.ok(PROTOCOL_PRESETS.some((p) => p.protocol === 'systemone'));
});

test('an unknown protocol fails loudly rather than silently misbehaving', () => {
  assert.throws(() => createProvider({ protocol: 'not-a-protocol' }), /Unknown model protocol/);
});

test('every provider answer is canonical, whatever the server sent', async () => {
  const provider = createProvider({ protocol: 'systemone', url });
  const result = await provider.systemOne({ state: { a: 1 }, questions });
  assertCanonical(result, questions);
  assert.equal(typeof (result.answers.anchor_line as any).probabilities.L001, 'number');
  assert.ok(result.usage.input_tokens > 0);
});

test('a provider that omits labels still satisfies the pipeline', () => {
  const partial = { answers: { sponsor_starts_here: { noul: 0.9 }, anchor_line: { probabilities: { L001: 0.8 } } } };
  const normalized = normalizeAnswer(partial, questions);
  assertCanonical(normalized, questions);
  assert.equal((normalized.answers.anchor_line as any).probabilities.L002, 0);
  assert.equal((normalized.answers.anchor_line as any).probabilities.none, 0);
  assert.deepEqual(normalized.usage, { input_tokens: 0, output_tokens: 0 });
});

test('a provider that breaks the contract is caught', () => {
  const notAPhase = { answers: { sponsor_starts_here: { noul: 1.4 }, anchor_line: { probabilities: {} } }, usage: {} };
  assert.throws(() => assertCanonical(notAPhase as any, questions), /not a probability/);
});

test('the pipeline runs end to end against a provider, not a client shim', async () => {
  const provider = createProvider({ protocol: 'systemone', url, model: 'kev-0.8b' });
  const lines = buildLines(fixture.cues);
  const result = await findSponsorSegment(lines, { client: provider, model: provider.model, title: fixture.title });
  assert.equal(result.status, 'found');
  assert.equal(result.segments.length, 1);
  assert.ok(result.segments[0].end!.seconds > result.segments[0].start.seconds);
  assert.ok(result.usage.input_tokens > 0);
});

test('a local provider never receives the TypeSafe key', () => {
  const local = createSystemOneProvider({ url: 'http://127.0.0.1:8009', apiKey: 'secret' });
  assert.equal(local.requiresKey, false);
  // The key only travels to TypeSafe itself.
  const hosted = createSystemOneProvider({ url: `https://${TYPESAFE_HOST}`, apiKey: 'secret' });
  assert.equal(hosted.requiresKey, true);
  assert.equal(hosted.hasKey, true);
  const other = createSystemOneProvider({ url: 'https://models.example.com', apiKey: 'secret' });
  assert.equal(other.requiresKey, false);
});

test('health asks the provider itself, so it works for any server', async () => {
  const provider = createProvider({ protocol: 'systemone', url });
  const health = await provider.health();
  assert.equal(health.ok, true);
  assert.equal(health.endpoint, `${url}/v1/systemone`);
  assert.equal(typeof health.ms, 'number');
});

test('an unreachable server says so in words worth showing', async () => {
  const provider = createProvider({ protocol: 'systemone', url: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => provider.systemOne({ state: {}, questions }, { signal: AbortSignal.timeout(2000) }),
    /Could not reach/
  );
});

test('the default provider is a local server, not the hosted one', () => {
  const provider = createProvider({});
  assert.equal(provider.isLocal, true);
  assert.equal(provider.requiresKey, false);
  assert.equal(provider.url, 'http://localhost:8000');
});

// ---- the parallel request cap ---------------------------------------------

/** A Response stand-in: enough of one for the retry loop to read. */
const okResponse = { ok: true, status: 200, json: async () => ({ answers: {} }) } as unknown as Response;
const busyResponse = { ok: false, status: 500, text: async () => 'busy' } as unknown as Response;

test('the cap defaults to four for a local and a hosted endpoint alike', () => {
  resetLimiters();
  assert.equal(createSystemOneProvider({ url: 'http://127.0.0.1:8196' }).maxParallel, 4);
  assert.equal(createSystemOneProvider({ url: `https://${TYPESAFE_HOST}` }).maxParallel, 4);
  assert.equal(createSystemOneProvider({ url: 'http://127.0.0.1:8196', maxParallel: 2 }).maxParallel, 2);
});

test('no more than maxParallel requests are in flight at once', async () => {
  resetLimiters();
  const provider = createSystemOneProvider({ url: 'http://127.0.0.1:8197', maxParallel: 2 });
  let inFlight = 0;
  let peak = 0;
  const fakeFetch = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight -= 1;
    return okResponse;
  }) as unknown as typeof fetch;

  await Promise.all(
    Array.from({ length: 7 }, () => provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch }))
  );

  assert.equal(peak, 2);
  assert.equal(inFlight, 0);
});

test('a retry holds its slot, so retries count against the same cap', async (t) => {
  resetLimiters();
  // The first retry waits 5s, which the test does not.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createSystemOneProvider({ url: 'http://127.0.0.1:8198', maxParallel: 1 });
  let attempts = 0;
  let inFlight = 0;
  let peak = 0;
  const fakeFetch = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    attempts += 1;
    const first = attempts === 1;
    inFlight -= 1;
    return first ? busyResponse : okResponse;
  }) as unknown as typeof fetch;

  const first = provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch });
  const second = provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch });
  // Let the first attempt fail and enter its backoff; only microtasks run, so
  // the mocked timer cannot be what drains this.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.equal(attempts, 1, 'the second call waits while the first backs off');
  assert.equal(peak, 1);

  t.mock.timers.tick(5000);
  await Promise.all([first, second]);

  assert.equal(attempts, 3, 'the retry, then the second call');
  assert.equal(peak, 1, 'one slot held across the retry');
});

// ---- the metadata a local model may record --------------------------------

const EXAMPLE_URI = 'https://www.youtube.com/watch?v=abc';

/** A fake fetch that keeps the body of every request it is given. */
function bodyRecorder() {
  const bodies: Record<string, any>[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return okResponse;
  }) as unknown as typeof fetch;
  return { bodies, fakeFetch };
}

test('a local model is sent the video metadata when the flag is on', async () => {
  const { bodies, fakeFetch } = bodyRecorder();
  const provider = createSystemOneProvider({ url: 'http://127.0.0.1:8201', sendMetadata: true });
  await provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch, uri: EXAMPLE_URI });
  assert.deepEqual(bodies[0].metadata, { clientId: 'yt-sponsor-skip', uri: EXAMPLE_URI });
  assert.equal(bodies[0].uri, undefined, 'the uri travels as metadata, not as a protocol field');
});

test('a local model is sent nothing extra when the flag is off', async () => {
  const { bodies, fakeFetch } = bodyRecorder();
  const provider = createSystemOneProvider({ url: 'http://127.0.0.1:8202' });
  await provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch, uri: EXAMPLE_URI });
  assert.equal(bodies[0].metadata, undefined);
});

test('a hosted model never gets metadata, even with the flag on', async () => {
  const { bodies, fakeFetch } = bodyRecorder();
  const provider = createSystemOneProvider({ url: `https://${TYPESAFE_HOST}`, apiKey: 'key', sendMetadata: true });
  await provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch, uri: EXAMPLE_URI });
  assert.equal(bodies[0].metadata, undefined);
});

test('a request with no video uri carries no metadata', async () => {
  const { bodies, fakeFetch } = bodyRecorder();
  const provider = createSystemOneProvider({ url: 'http://127.0.0.1:8203', sendMetadata: true });
  await provider.systemOne({ state: {}, questions: {} }, { fetch: fakeFetch });
  assert.equal(bodies[0].metadata, undefined);
});
