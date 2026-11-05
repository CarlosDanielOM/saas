import { randomUUID } from 'node:crypto';
import { SIGNAL_LIMITS, SIGNAL_NAME, WIDGET_FEED_CHANNEL, widgetSignalRateKey, widgetSignalSkippedKey, type DimaSignal, type WidgetSignalMessage } from './types.js';

/** JSON numbers, booleans, arrays and objects; plain text (and non-finite numbers) stays text. Never evaluated. */
export function signalJson(value: string): unknown {
  const text = value.trim();
  if (!text || !/^[-\d[{]|^(true|false)$/.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : null;
    return typeof parsed === 'boolean' || (parsed !== null && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}
export function buildSignal(input: { name: string; value: string; user: DimaSignal['user']; source: DimaSignal['source']; target: string | null; id?: string; at?: number }): DimaSignal {
  const value = input.value.trim();
  return { id: input.id ?? randomUUID(), name: input.name, value, json: signalJson(value), args: value ? value.split(/\s+/) : [], at: input.at ?? Date.now(),
    user: input.user, source: input.source, target: input.target };
}
export function signalError(name: string, value: string, target: string | null): string | null {
  if (!SIGNAL_NAME.test(name)) return 'invalid_widget_signal_name';
  if (value.length > SIGNAL_LIMITS.value) return 'widget_signal_too_long';
  if (target !== null && (!target.trim() || target.length > SIGNAL_LIMITS.target)) return 'invalid_widget_signal_target';
  return null;
}

interface SignalRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; EX: number }): Promise<string | null>;
}
interface PublisherDeps { redis: () => Promise<SignalRedis>; publish: (topic: string, message: WidgetSignalMessage) => Promise<void> }

/**
 * Admission shared by the bot (commands) and the API (Studio tests): at most 30 signals per channel every 10 seconds,
 * counted atomically in Dragonfly before anything is published; drops are counted for Studio.
 */
export function createSignalAdmission(deps: Pick<PublisherDeps, 'redis'>) {
  return async function admit(channel: string): Promise<boolean> {
    const redis = await deps.redis();
    const count = await countWithExpiry(redis, widgetSignalRateKey(channel), SIGNAL_LIMITS.windowSeconds);
    if (count <= SIGNAL_LIMITS.perChannel) return true;
    await countSkipped(redis, channel);
    return false;
  };
}
/** INCR and its expiry in one step, so a counter never outlives its window (a key left without a TTL is repaired). */
const COUNT_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c";
async function countWithExpiry(redis: SignalRedis, key: string, seconds: number): Promise<number> {
  return Number(await redis.eval(COUNT_SCRIPT, { keys: [key], arguments: [String(seconds)] }));
}
async function countSkipped(redis: SignalRedis, channel: string): Promise<void> {
  await countWithExpiry(redis, widgetSignalSkippedKey(channel), 600);
}
/** Same action seen before: a day covers EventSub retries (10 min) and durable event redelivery. */
const SEEN_SECONDS = 86_400;

export function createSignalPublisher(deps: PublisherDeps) {
  const admit = createSignalAdmission(deps);
  /** 'sent', 'duplicate' (same action delivered before), 'limited' (dropped and counted) or 'failed'. */
  return async (channel: string, signal: DimaSignal, actionKey?: string): Promise<'sent' | 'duplicate' | 'limited' | 'failed'> => {
    try {
      const redis = await deps.redis();
      if (actionKey && await redis.set('widget-signal:seen:' + actionKey, '1', { NX: true, EX: SEEN_SECONDS }) === null) return 'duplicate';
      if (!await admit(channel)) return 'limited';
      await deps.publish(WIDGET_FEED_CHANNEL, { channel, type: 'signal', data: signal });
      return 'sent';
    } catch { return 'failed'; }
  };
}
async function redisClient(): Promise<SignalRedis> {
  const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
  return await getDragonflyClient('WidgetSignals') as unknown as SignalRedis;
}
export const widgetSignals = {
  publish: createSignalPublisher({
    redis: redisClient,
    publish: async (topic, message) => { const { pubSubManager } = await import('../classes/pubsub_manager.class.js'); await pubSubManager.publish(topic, message); }
  }),
  admit: createSignalAdmission({ redis: redisClient }),
  /** Per-run budget drops are counted for Studio too. */
  countSkipped: async (channel: string): Promise<void> => { try { await countSkipped(await redisClient(), channel); } catch { /* diagnostics only */ } }
};
/** Skipped signals in the last 10 minutes (Studio). */
export async function skippedSignals(channel: string): Promise<number> {
  try { const redis = await redisClient() as unknown as { get(key: string): Promise<string | null> }; return Number(await redis.get(widgetSignalSkippedKey(channel))) || 0; }
  catch { return 0; }
}
