import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSignal, createSignalPublisher, signalError } from './signals.js';
import type { WidgetSignalMessage } from './types.js';

function fakeRedis() {
  const values = new Map<string, number | string>(), expiries = new Map<string, number>();
  const seen = new Map<string, number>();
  return { values, expiries, seen, client: {
    // The counting script: INCR, then EXPIRE when new or when the key has no TTL (atomic in Dragonfly).
    eval: async (script: string, { keys: [key], arguments: [seconds] }: { keys: string[]; arguments: string[] }) => {
      assert.match(script, /INCR[\s\S]*TTL[\s\S]*EXPIRE/);
      const next = Number(values.get(key) ?? 0) + 1; values.set(key, next);
      if (next === 1 || !expiries.has(key)) expiries.set(key, Number(seconds));
      return next;
    },
    set: async (key: string, value: string, options: { EX: number }) => { if (values.has(key)) return null; values.set(key, value); seen.set(key, options.EX); return 'OK'; }
  } };
}
const signal = (name = 'feed') => buildSignal({ name, value: 'pizza', user: null, source: { kind: 'command', name: 'feed' }, target: null });

test('30 signals per channel per window, counted atomically before publishing; drops are counted', async () => {
  const redis = fakeRedis(), published: WidgetSignalMessage[] = [];
  const publish = createSignalPublisher({ redis: async () => redis.client, publish: async (_topic, message) => { published.push(message); } });
  const results = [];
  for (let i = 0; i < 32; i++) results.push(await publish('1', signal()));
  assert.deepEqual([results.filter(r => r === 'sent').length, results.filter(r => r === 'limited').length], [30, 2]);
  assert.equal(published.length, 30);
  assert.equal(redis.expiries.get('widget-signal:rate:1'), 10, 'the window starts with the first signal');
  assert.equal(redis.values.get('widget-signal:skipped:1'), 2);
  assert.equal(await publish('2', signal()), 'sent', 'other channels have their own window');
});

test('the same action is delivered once; failures never throw', async () => {
  const redis = fakeRedis();
  const publish = createSignalPublisher({ redis: async () => redis.client, publish: async () => {} });
  assert.equal(await publish('1', signal(), 'signal:v1:abc'), 'sent');
  assert.equal(await publish('1', signal(), 'signal:v1:abc'), 'duplicate');
  assert.equal(redis.seen.get('widget-signal:seen:signal:v1:abc'), 86_400, 'kept longer than EventSub retries (10 min)');
  const broken = createSignalPublisher({ redis: async () => { throw new Error('down'); }, publish: async () => {} });
  assert.equal(await broken('1', signal()), 'failed');
});

test('signal rules', () => {
  assert.equal(signalError('feed', 'x', null), null);
  assert.equal(signalError('Feed', '', null), 'invalid_widget_signal_name');
  assert.equal(signalError('a'.repeat(41), '', null), 'invalid_widget_signal_name');
  assert.equal(signalError('feed', 'x'.repeat(501), null), 'widget_signal_too_long');
  assert.equal(signalError('feed', '', ' '), 'invalid_widget_signal_target');
  assert.deepEqual(signal().args, ['pizza']);
});

test('a counter left without a TTL (crash between INCR and EXPIRE) is repaired on the next signal', async () => {
  const redis = fakeRedis();
  redis.values.set('widget-signal:rate:1', 45); // no expiry recorded: stuck before this fix
  const publish = createSignalPublisher({ redis: async () => redis.client, publish: async () => {} });
  assert.equal(await publish('1', signal()), 'limited');
  assert.equal(redis.expiries.get('widget-signal:rate:1'), 10, 'the stuck window gets its expiry back');
});
