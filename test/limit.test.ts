import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLimiter, limiterFor, resetLimiters } from '../src/providers/limit.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test('never more than the cap runs at once', async () => {
  const limiter = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active -= 1;
  };

  await Promise.all(Array.from({ length: 9 }, () => limiter.run(task)));

  assert.equal(peak, 2);
  assert.equal(active, 0, 'every slot comes back');
});

test('a task that throws still gives its slot back', async () => {
  const limiter = createLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limiter.run(async () => 'after'), 'after');
});

test('queued tasks run in the order they arrived', async () => {
  const limiter = createLimiter(1);
  const order: number[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));

  const first = limiter.run(async () => { order.push(0); await gate; });
  const rest = [1, 2, 3].map((i) => limiter.run(async () => { order.push(i); }));
  open();
  await Promise.all([first, ...rest]);

  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('raising the cap starts queued work', async () => {
  const limiter = createLimiter(1);
  const started: number[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));

  const first = limiter.run(async () => { started.push(1); await gate; });
  const second = limiter.run(async () => { started.push(2); });
  await flush();
  assert.deepEqual(started, [1], 'the second waits while the cap is one');

  limiter.setMax(2);
  await flush();
  assert.deepEqual(started, [1, 2]);

  open();
  await Promise.all([first, second]);
});

test('one limiter is shared per endpoint', () => {
  resetLimiters();
  assert.equal(limiterFor('http://localhost:8000/v1/systemone', 4), limiterFor('http://localhost:8000/v1/systemone', 4));
  assert.notEqual(limiterFor('http://localhost:8000/v1/systemone', 4), limiterFor('http://localhost:8009/v1/systemone', 4));
  resetLimiters();
});
