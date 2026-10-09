import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { initial, start } from './model.js';
import { applyDbdEventRules, defaultEventSettings, eventSettings, MIN_WHEEL_PERKS } from './event-model.js';
import { catalog } from './catalog.js';
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

const perkIds = (role: 'killer' | 'survivor') => catalog.entries.filter(e => e.kind === 'perk' && e.role === role && e.available).map(e => e.id);
const run = (action: Record<string, unknown>, state = initial(), bits = 100) => {
  applyDbdEventRules(state, eventSettings({ ...config(), rules: [{ ...rule, action }] }, 1000).rules, event(bits)); return state;
};

test('random perk adds bring back only perks that are off, for the requested role', () => {
  const killer = perkIds('killer'), state = initial();
  state.config.excludedIds = killer.slice(0, 3);
  run({ type: 'add-perks', role: 'current', amount: 2, perkIds: [] }, state);
  assert.equal(state.config.excludedIds.length, 1);
  run({ type: 'add-perks', role: 'killer', amount: 5, perkIds: [] }, state);
  assert.deepEqual(state.config.excludedIds, []);
  assert.deepEqual(state.config.perkTuning, {});
});

test('chosen perk adds turn a perk on, then add wheel slots up to the limit regardless of rule role', () => {
  const [perk] = perkIds('survivor'), state = initial();
  state.config.excludedIds = [perk];
  run({ type: 'add-perks', role: 'current', amount: 1, perkIds: [perk] }, state);
  assert.deepEqual(state.config.excludedIds, []); assert.equal(state.config.perkTuning?.[perk], undefined);
  run({ type: 'add-perks', role: 'killer', amount: 2, perkIds: [perk] }, state);
  assert.deepEqual(state.config.perkTuning?.[perk], { copies: 3, weight: 1 });
  run({ type: 'add-perks', role: 'both', amount: 5, perkIds: [perk] }, state);
  assert.deepEqual(state.config.perkTuning?.[perk], { copies: 5, weight: 1 });
});

test('perk removals keep at least four perks on the wheel and clear extra slots', () => {
  const killer = perkIds('killer'), state = initial();
  state.config.perkTuning = { [killer[0]]: { copies: 3, weight: 2 } };
  run({ type: 'remove-perks', role: 'killer', amount: 1, perkIds: [killer[0]] }, state);
  assert.deepEqual(state.config.excludedIds, [killer[0]]);
  assert.deepEqual(state.config.perkTuning, { [killer[0]]: { copies: 1, weight: 2 } }, 'weight survives, slots reset');
  state.config.excludedIds = killer.slice(6);
  run({ type: 'remove-perks', role: 'current', amount: 10, perkIds: [] }, state);
  assert.equal(killer.filter(id => !state.config.excludedIds.includes(id)).length, MIN_WHEEL_PERKS);
  run({ type: 'remove-perks', role: 'killer', amount: 1, perkIds: killer.slice(0, 4) }, state);
  assert.equal(killer.filter(id => !state.config.excludedIds.includes(id)).length, MIN_WHEEL_PERKS);
});

test('added win requirements stack up to twenty and keep current wins', () => {
  const state = initial(); state.wins = { killer: 2, survivor: 1 };
  run({ type: 'add-win-target', role: 'both', amount: 2 }, state);
  assert.deepEqual(state.config.targets, { killer: 5, survivor: 6 });
  run({ type: 'add-win-target', role: 'killer', amount: 20 }, state);
  assert.equal(state.config.targets!.killer, 20); assert.deepEqual(state.wins, { killer: 2, survivor: 1 });
});

test('perk actions reject non-perk IDs, too many perks and out-of-range amounts', () => {
  const character = catalog.entries.find(e => e.kind === 'character')!.id, perk = perkIds('killer')[0];
  for (const action of [
    { type: 'add-perks', role: 'killer', amount: 1, perkIds: [character] },
    { type: 'add-perks', role: 'killer', amount: 1, perkIds: perkIds('killer').slice(0, 21) },
    { type: 'add-perks', role: 'killer', amount: 6, perkIds: [perk] },
    { type: 'remove-perks', role: 'killer', amount: 11, perkIds: [] },
    { type: 'remove-perks', role: 'killer', amount: 1 },
    { type: 'add-win-target', role: 'killer', amount: 0 }
  ]) assert.throws(() => eventSettings({ ...config(), rules: [{ ...rule, action }] }, 1000), { code: 'invalid' });
});
