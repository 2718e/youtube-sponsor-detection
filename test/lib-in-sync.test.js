import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// The extension ships its own copy of the pipeline (a browser cannot load
// files outside the extension folder). `npm run build:ext` refreshes it.
for (const name of ['transcript.js', 'jev.js']) {
  test(`extension/lib/${name} matches src/${name}`, async () => {
    const a = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    const b = await readFile(new URL(`../extension/lib/${name}`, import.meta.url), 'utf8');
    assert.equal(b, a, `run: npm run build:ext`);
  });
}

test('extension/lib/providers matches src/providers', async () => {
  const from = await readdir(new URL('../src/providers', import.meta.url));
  const to = await readdir(new URL('../extension/lib/providers', import.meta.url));
  assert.deepEqual(to.sort(), from.sort(), 'run: npm run build:ext');
  for (const name of from) {
    const a = await readFile(new URL(`../src/providers/${name}`, import.meta.url), 'utf8');
    const b = await readFile(new URL(`../extension/lib/providers/${name}`, import.meta.url), 'utf8');
    assert.equal(b, a, `extension/lib/providers/${name} is stale — run: npm run build:ext`);
  }
});
