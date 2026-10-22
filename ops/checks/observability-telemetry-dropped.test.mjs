// Node's native TypeScript support runs the pure helper without Angular or a compiler.
// Run: node --test ops/checks/observability-telemetry-dropped.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as format from '../../admin/src/app/pages/observability/observability-format.ts';

const reading = row => format.telemetryDroppedReading(row);
const group = (lastValue, count = 360, average = lastValue, max = lastValue) => ({ lastValue, count, average, max });

test('repeated cumulative samples and repeated polls do not multiply losses', () => {
  for (const count of [1, 2, 90, 360, 8640]) {
    const response = group(7, count);
    assert.equal(reading(response), 7);
    assert.equal(reading(response), 7, 'polling the same overview is idempotent');
  }
});

test('a real counter increase follows the latest sample rather than its historical average', () => {
  assert.deepEqual([group(7), group(12, 361, 7.014), group(12, 362, 7.028)].map(reading), [7, 12, 12]);
});

test('process replacement resets the reading, even when the range includes a larger old counter', () => {
  assert.deepEqual([group(900), group(0, 361, 897.5, 900), group(3, 362, 895, 900)].map(reading), [900, 0, 3]);
});

test('changing the selected window cannot turn a lifetime reading into a range total', () => {
  const ranges = [group(12, 90, 12, 12), group(12, 360, 40, 900), group(12, 8640, 80, 900)];
  assert.deepEqual(ranges.map(reading), [12, 12, 12]);
});

test('the latest bucket average is preserved when samples from different instances share it', () => {
  // Ingestion discards instance identity: 100 before a restart and 0 after it
  // can share a bucket. Neither the latest raw value nor a window delta is recoverable.
  assert.equal(reading(group(50, 2, 50, 100)), 50);
  assert.equal(reading(group(1.5, 20, 17, 100)), 1.5);
});

test('an absent or invalid sample stays unknown, while a sampled zero stays zero', () => {
  for (const lastValue of [undefined, null, NaN, Infinity, -1, '7']) assert.equal(reading(group(lastValue)), null);
  assert.equal(reading(group(0, 90, 900, 900)), 0);
});
