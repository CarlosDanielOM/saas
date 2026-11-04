import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadinessCache } from './readiness-cache.js';

test('coalesces reads per channel and caches success and errors for bounded periods', async () => {
  let now = 0, calls = 0, fail = false;
  const cache = new ReadinessCache<string>(10, 5, 2, () => now);
  const load = async () => { calls++; await Promise.resolve(); if (fail) throw new Error('unavailable'); return `result-${calls}`; };
  assert.deepEqual(await Promise.all([cache.read('a', load), cache.read('a', load)]), ['result-1', 'result-1']);
  assert.equal(await cache.read('a', load), 'result-1'); assert.equal(calls, 1);
  now = 10; fail = true;
  await assert.rejects(cache.read('a', load), /unavailable/);
  await assert.rejects(cache.read('a', load), /unavailable/); assert.equal(calls, 2);
  now = 15; fail = false; assert.equal(await cache.read('a', load), 'result-3');
  await cache.read('b', load); await cache.read('c', load);
  await cache.read('a', load); assert.equal(calls, 6, 'bounded entries evict the oldest channel');
});

test('invalidation prevents an older in-flight read from repopulating the cache', async () => {
  const cache = new ReadinessCache<string>(100, 10, 2);
  let resolve!: (value: string) => void;
  const old = cache.read('a', () => new Promise<string>(r => { resolve = r; }));
  cache.invalidate('a');
  assert.equal(await cache.read('a', async () => 'fresh'), 'fresh');
  resolve('stale'); assert.equal(await old, 'stale');
  assert.equal(await cache.read('a', async () => 'unexpected'), 'fresh');
});
