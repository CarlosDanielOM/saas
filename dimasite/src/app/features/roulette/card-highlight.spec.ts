import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSequence, cardHighlight } from './card-highlight';
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
