import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSequence, cardHighlight, eliminationOrder, eliminatedCount, landingOffset } from './card-highlight';
test('cards scatter randomly without repeats, preserving a draw across reconnects', () => {
  const path = cardSequence('draw-one', 20, 4000);
  assert.deepEqual(path, cardSequence('draw-one', 20, 4000));
  assert.notDeepEqual(path, cardSequence('draw-two', 20, 4000));
  assert(path.every((index, n) => index >= 0 && index < 20 && (n === 0 || index !== path[n-1])));
  assert(path.slice(1).filter((v,i) => v !== (path[i]+1)%20).length > path.length/2);
  for (const progress of [0,.2,.5,.99]) assert(path.includes(cardHighlight(path,progress,19)));
  assert.equal(cardHighlight(path,1,19),19);
  assert.equal(cardHighlight(cardSequence('only',1,1000),.8,0),0);
});
test('last one standing knocks out every other slot exactly once and leaves the winner', () => {
  const order = eliminationOrder('draw-one', 12, 7);
  assert.deepEqual(order, eliminationOrder('draw-one', 12, 7));
  assert.equal(order.length, 11);
  assert(!order.includes(7));
  assert.equal(new Set(order).size, 11);
  assert.equal(eliminatedCount(11, 0), 0);
  assert.equal(eliminatedCount(11, 0.9), 11);
  assert.equal(eliminatedCount(11, 1), 11);
  let previous = 0;
  for (let p = 0; p <= 1; p += 0.01) {
    const out = eliminatedCount(11, p);
    assert(out >= previous && out <= 11);
    previous = out;
  }
  assert(eliminatedCount(11, 0.45) > 5, 'most slots fall in the first half');
  assert.deepEqual(eliminationOrder('solo', 1, 0), []);
  const offset = landingOffset('draw-one');
  assert(offset > -0.35 && offset < 0.35);
  assert.equal(offset, landingOffset('draw-one'));
});
