import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptRevisions } from './history.js';

const revs = (...numbers: number[]) => numbers.map(revision => ({ revision, size: 1 }));
const size = (r: { size: number }) => r.size;

test('keeps the 10 newest (latest included) plus published ones', () => {
  const all = revs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
  assert.deepEqual(keptRevisions(all, 14, r => r === 2, size).map(r => r.revision), [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(keptRevisions(revs(1, 2, 3), 3, () => false, size).map(r => r.revision), [1, 2, 3]);
});

test('the size budget counts latest and published first, then stops at the first newer revision that does not fit', () => {
  const all = [{ revision: 1, size: 40 }, { revision: 2, size: 10 }, { revision: 3, size: 30 }, { revision: 4, size: 10 }, { revision: 5, size: 20 }];
  // latest 5 (20) + pinned 1 (40) = 60; then 4 (+10 = 70) fits, 3 (+30 = 100) does not: stop, so 2 is dropped too.
  assert.deepEqual(keptRevisions(all, 5, r => r === 1, size, { count: 10, bytes: 90 }).map(r => r.revision), [1, 4, 5]);
});

test('latest and published revisions stay even when they alone exceed the budget', () => {
  const all = [{ revision: 1, size: 500 }, { revision: 2, size: 5 }, { revision: 3, size: 500 }];
  assert.deepEqual(keptRevisions(all, 3, r => r === 1, size, { count: 10, bytes: 100 }).map(r => r.revision), [1, 3]);
});
