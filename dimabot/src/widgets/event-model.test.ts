import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { initial, start } from './model.js';
import { applyDbdEventRules, defaultEventSettings, eventSettings } from './event-model.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';

const rule = { id: 'remove', enabled: true, event: 'channel.bits.received', minBits: 100, maxBits: 100, action: { type: 'remove-wins', role: 'current', amount: 1 } };
const config = () => ({ enabled: true, active: true, allowTestEvents: false, rules: [structuredClone(rule)] });
const event = (bits: unknown): DomainEventEnvelope => ({ _id: new Types.ObjectId(), eventKey: 'receipt', sourceEventId: 'receipt', source: 'twitch-eventsub', channelID: '123', topic: 'channel', schemaVersion: 1, type: 'channel.bits.received', payload: { event: { bits } }, metadata: {}, occurredAt: new Date(), journaledAt: new Date(), expiresAt: new Date() });

test('legacy widgets default to disabled; eligibility boundaries are server owned', () => {
  assert.deepEqual(defaultEventSettings(), { enabled: false, active: false, activeSince: null, allowTestEvents: false, rules: [] });
  assert.equal(eventSettings(config(), 1000).activeSince, 1000);
  assert.equal(eventSettings({ ...config(), active: false }, 1000).activeSince, null);
  assert.equal(eventSettings({ ...config(), enabled: false }, 1000).activeSince, null);
  assert.throws(() => eventSettings({ ...config(), activeSince: 0 }, 1000), { code: 'invalid' });
});

test('exact bits and ranges respect disabled rules, zero floor and role isolation', () => {
  const settings = eventSettings(config(), 1000), state = initial();
  state.wins = { killer: 2, survivor: 3 };
  assert.equal(applyDbdEventRules(state, settings.rules, event(99)), false);
  assert.equal(applyDbdEventRules(state, settings.rules, event(101)), false);
  assert.equal(applyDbdEventRules(state, settings.rules, event(100)), true);
  assert.deepEqual(state.wins, { killer: 1, survivor: 3 });
  applyDbdEventRules(state, settings.rules, event(100)); applyDbdEventRules(state, settings.rules, event(100));
  assert.equal(state.wins.killer, 0);
  const range = eventSettings({ ...config(), rules: [{ ...rule, minBits: 500, maxBits: null, action: { type: 'reset-wins', role: 'both' } }] }, 1000);
  assert.equal(applyDbdEventRules(state, range.rules, event(499)), false);
  assert.equal(applyDbdEventRules(state, [{ ...range.rules[0], enabled: false }], event(500)), false);
  applyDbdEventRules(state, range.rules, event(500));
  assert.deepEqual(state.wins, { killer: 0, survivor: 0 });
});

test('server effects work during a hidden active draw without disturbing the run', () => {
  const state = initial(); state.packId = 'dbd-survivor-challenge'; start(state, 1000);
  const run = structuredClone(state.run), nextAt = state.nextAt;
  state.visible = false; state.wins = { killer: 2, survivor: 3 };
  const settings = eventSettings({ ...config(), rules: [{ ...rule, action: { type: 'set-win-target', role: 'current', amount: 2 } }] }, 1000);
  applyDbdEventRules(state, settings.rules, event(100));
  assert.deepEqual(state.config.targets, { killer: 3, survivor: 2 });
  assert.deepEqual(state.wins, { killer: 2, survivor: 2 });
  assert.deepEqual(state.run, run); assert.equal(state.nextAt, nextAt); assert.equal(state.visible, false);
});

test('invalid actions, duplicate IDs, unsafe amounts and unknown settings are rejected', () => {
  const invalid = [
    { ...config(), rules: [rule, rule] }, { ...config(), active: 'true' },
    { ...config(), rules: [{ ...rule, minBits: 0 }] }, { ...config(), rules: [{ ...rule, maxBits: 99 }] },
    { ...config(), rules: [{ ...rule, minBits: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...config(), rules: [{ ...rule, action: { type: 'send-chat', role: 'both' } }] },
    { ...config(), rules: [{ ...rule, action: { type: 'remove-wins', role: 'invalid', amount: 1 } }] },
    { ...config(), rules: [{ ...rule, action: { type: 'set-win-target', role: 'both', amount: 21 } }] },
    { ...config(), rules: [{ ...rule, action: { type: 'reset-wins', role: 'both', amount: 1 } }] },
    { ...config(), rules: [{ ...rule, event: 'billing.order.paid' }] },
    { ...config(), rules: [{ ...rule, secret: true }] }
  ];
  for (const value of invalid) assert.throws(() => eventSettings(value, 1000), { code: 'invalid' });
  for (const bits of [0, -1, 1.5, '100', NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(applyDbdEventRules(initial(), eventSettings(config(), 1000).rules, event(bits)), false);
});
