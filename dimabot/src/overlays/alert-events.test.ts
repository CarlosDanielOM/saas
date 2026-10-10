import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlertEventFilter, SUB_REPEAT_MS } from './alert-events.js';

test('a gift bomb shows only the gifter alert', () => {
  const filter = new AlertEventFilter();
  assert.equal(filter.kind('1', 'channel.subscription.gifted', { user_id: 'gifter', total: 5, tier: '1000' }, 0), 'sub');
  for (let i = 0; i < 5; i++) assert.equal(filter.kind('1', 'channel.subscription.received', { user_id: `r${i}`, is_gift: true }, 10), null);
});
test('subscribe and resub message from one viewer play once', () => {
  const filter = new AlertEventFilter();
  assert.equal(filter.kind('1', 'channel.subscription.received', { user_id: 'u', is_gift: false }, 0), 'sub');
  assert.equal(filter.kind('1', 'channel.subscription.received', { user_id: 'u', cumulative_months: 49 }, 8000), null);
  assert.equal(filter.kind('2', 'channel.subscription.received', { user_id: 'u', is_gift: false }, 8000), 'sub', 'other channels are independent');
  assert.equal(filter.kind('1', 'channel.subscription.received', { user_id: 'other', is_gift: false }, 9000), 'sub');
  assert.equal(filter.kind('1', 'channel.subscription.received', { user_id: 'u', cumulative_months: 50 }, SUB_REPEAT_MS + 1), 'sub', 'a later sub alerts again');
});
test('other alert types are unchanged', () => {
  const filter = new AlertEventFilter();
  assert.equal(filter.kind('1', 'channel.follow.received', { user_id: 'u' }, 0), 'follow');
  assert.equal(filter.kind('1', 'channel.follow.received', { user_id: 'u' }, 1), 'follow');
  assert.equal(filter.kind('1', 'channel.bits.received', { user_id: 'u', bits: 100 }, 0), 'bits');
  assert.equal(filter.kind('1', 'channel.raid.received', { from_broadcaster_user_id: 'u' }, 0), 'raid');
  assert.equal(filter.kind('1', 'channel.subscription.ended', { user_id: 'u' }, 0), null);
});
