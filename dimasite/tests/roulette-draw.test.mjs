import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawTotals,
  expandSlots,
  selectSlot,
  randomTicket,
  parseBulkEntries,
} from '../src/app/features/landing-mocks/dev/roulette-draw.ts';
const fixture = [
  { id: 1, weight: 1, multiplier: 1 },
  { id: 2, weight: 1, multiplier: 1 },
  { id: 3, weight: 10, multiplier: 3 },
  { id: 4, weight: 1, multiplier: 1 },
];
test('four entries expand to six slots, with exactly 30 of 33 tickets for item three', () => {
  assert.deepEqual(drawTotals(fixture), { slots: 6, weight: 33 });
  const slots = expandSlots(fixture);
  assert.deepEqual(
    slots.map((s) => s.weight),
    [1, 1, 10, 10, 10, 1],
  );
  const counts = new Map();
  for (let ticket = 0; ticket < 33; ticket++) {
    const selected = selectSlot(slots, ticket);
    counts.set(selected.key, (counts.get(selected.key) || 0) + 1);
  }
  assert.deepEqual([...counts.values()], [1, 1, 10, 10, 10, 1]);
  assert.equal(selectSlot(slots, 2).key, '3:1');
  assert.equal(selectSlot(slots, 12).key, '3:2');
  assert.equal(selectSlot(slots, 22).key, '3:3');
  assert.equal(selectSlot(slots, 32).id, 4);
  assert.throws(() => selectSlot(slots, 33));
});
test('equal weights allocate equal tickets, with multiplier-one preserving existing behavior', () => {
  const slots = expandSlots(
    Array.from({ length: 300 }, (_, i) => ({ id: i, weight: 1000, multiplier: 1 })),
  );
  for (let i = 0; i < 300; i++) {
    assert.equal(selectSlot(slots, i * 1000).id, i);
    assert.equal(selectSlot(slots, i * 1000 + 999).id, i);
  }
});
test('unbiased random sampler rejects the incomplete bucket and handles numeric boundaries', () => {
  const values = [2 ** 53 - 1, 32];
  let reads = 0;
  assert.equal(
    randomTicket(33, () => {
      reads++;
      return values.shift();
    }),
    32,
  );
  assert.equal(reads, 2);
  assert.equal(
    randomTicket(1, () => 2 ** 53 - 1),
    0,
  );
  assert.equal(
    randomTicket(Number.MAX_SAFE_INTEGER, () => Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER - 1,
  );
  for (const value of [0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => randomTicket(value));
});
test('invalid numbers and unsafe totals fail without expansion', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => expandSlots([{ id: 1, weight: bad, multiplier: 1 }]));
    assert.throws(() => expandSlots([{ id: 1, weight: 1, multiplier: bad }]));
  }
  assert.throws(() => drawTotals([{ id: 1, weight: Number.MAX_SAFE_INTEGER, multiplier: 2 }]));
  assert.throws(() => expandSlots([{ id: 1, weight: 1, multiplier: 10001 }]));
  assert.deepEqual(expandSlots([]), []);
});
test('bulk paste accepts hundreds of lines and optional spreadsheet columns', () => {
  const rows = parseBulkEntries('Perk A\t25\t3\r\n\nPerk B\r\n');
  assert.deepEqual(rows, [
    { name: 'Perk A', weight: 25, multiplier: 3 },
    { name: 'Perk B', weight: 1, multiplier: 1 },
  ]);
  assert.equal(
    parseBulkEntries(Array.from({ length: 500 }, (_, i) => `Perk ${i}`).join('\n')).length,
    500,
  );
  assert.throws(() => parseBulkEntries('Good\nBad\t0\t1'));
  assert.throws(() => parseBulkEntries('Bad\t2\t3\textra'));
});
