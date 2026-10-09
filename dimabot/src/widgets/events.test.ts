import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import { createWidgetEventHandler, WIDGET_EVENT_MAX_AGE_MS, type WidgetEventAdapter, type WidgetEventTarget } from './events.js';

const now = Date.now();
const event = (patch: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope => ({
  _id: new Types.ObjectId(), eventKey: 'bits:receipt', source: 'twitch-eventsub', sourceEventId: 'receipt',
  type: 'channel.bits.received', topic: 'channel', schemaVersion: 1, channelID: '123',
  occurredAt: new Date(now), journaledAt: new Date(now), expiresAt: new Date(now + 86400_000),
  payload: { event: { bits: 500 } }, metadata: {}, ...patch
});
const target = (patch: Partial<WidgetEventTarget> = {}): WidgetEventTarget => ({
  id: 'widget-a', enabled: true, active: true, activeSince: now - 1000, allowTestEvents: false, ...patch
});

test('only enabled, active widgets in this activation evaluate effects', async () => {
  const applied: string[] = [];
  const adapter: WidgetEventAdapter = { id: 'game', eventTypes: ['channel.bits.received'],
    targets: async channel => {
      assert.equal(channel, '123');
      return [target(), target({ id: 'inactive', active: false }), target({ id: 'disabled', enabled: false }),
        target({ id: 'newly-active', activeSince: now + 1000 }), target({ id: 'legacy', activeSince: null })];
    }, apply: async widget => { applied.push(widget.id); }
  };
  await createWidgetEventHandler([adapter])(event());
  assert.deepEqual(applied, ['widget-a']);
});

test('one shared handler fans out to 100 widgets without retaining channel state', async () => {
  const applied: string[] = [], channels: string[] = [];
  const adapter: WidgetEventAdapter = { id: 'game', eventTypes: ['channel.bits.received'],
    targets: async channel => { channels.push(channel); return Array.from({ length: 100 }, (_, n) => target({ id: `${channel}:${n}` })); },
    apply: async widget => { applied.push(widget.id); }
  };
  const handle = createWidgetEventHandler([adapter]);
  await handle(event());
  await handle(event({ channelID: '456' }));
  assert.deepEqual(channels, ['123', '456']);
  assert.equal(applied.length, 200);
  assert.equal(new Set(applied).size, 200);
});

test('unsupported types and non-channel/provider/schema events never load targets', async () => {
  const adapter: WidgetEventAdapter = { id: 'game', eventTypes: ['channel.bits.received'],
    targets: async () => assert.fail('Unexpected widget lookup'), apply: async () => assert.fail('Unexpected effects') };
  const handle = createWidgetEventHandler([adapter]);
  for (const patch of [{ type: 'stream.started' }, { topic: 'domain' as const }, { source: 'polar-webhook' }, { channelID: undefined }, { schemaVersion: 2 }]) await handle(event(patch));
});

test('injected events require an explicit test opt-in per widget', async () => {
  const applied: string[] = [];
  await createWidgetEventHandler([{ id: 'game', eventTypes: ['channel.bits.received'],
    targets: async () => [target(), target({ id: 'test-opt-in', allowTestEvents: true })],
    apply: async widget => { applied.push(widget.id); }
  }])(event({ source: 'twitch-eventsub-test' }));
  assert.deepEqual(applied, ['test-opt-in']);
});

test('late historical and stale events do not evaluate rules after activation', async () => {
  const handle = createWidgetEventHandler([{ id: 'game', eventTypes: ['channel.bits.received'],
    targets: async () => [target()], apply: async () => assert.fail('Unexpected historical effect') }]);
  await handle(event({ occurredAt: new Date(now - 2000) }));
  await handle(event({ journaledAt: new Date(now - 2000) }));
  const old = new Date(now - WIDGET_EVENT_MAX_AGE_MS - 1000);
  await createWidgetEventHandler([{ id: 'game', eventTypes: ['channel.bits.received'],
    targets: async () => [target({ activeSince: 0 })], apply: async () => assert.fail('Unexpected stale effect') }])(event({ occurredAt: old, journaledAt: old }));
});

test('activation is read afresh on every delivery', async () => {
  let active = true, calls = 0;
  const handle = createWidgetEventHandler([{ id: 'game', eventTypes: ['channel.bits.received'],
    targets: async () => [target({ active })], apply: async () => { calls++; } }]);
  await handle(event()); active = false; await handle(event());
  assert.equal(calls, 1);
});

test('failed adapters/targets do not starve other widgets and failures propagate for retry', async () => {
  const applied: string[] = [];
  const handle = createWidgetEventHandler([
    { id: 'broken-reader', eventTypes: ['channel.bits.received'], targets: async () => { throw new Error('storage unavailable'); }, apply: async () => {} },
    { id: 'game', eventTypes: ['channel.bits.received'], targets: async () => [target({ id: 'broken-action' }), target()],
      apply: async widget => { if (widget.id === 'broken-action') throw new Error('effect unavailable'); applied.push(widget.id); } }
  ]);
  await assert.rejects(handle(event()), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(applied, ['widget-a']);
});
