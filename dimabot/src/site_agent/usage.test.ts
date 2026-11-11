import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { LlmUsage } from './types.js';

/** In-memory subset of the Dragonfly client used by usage.ts. */
class FakeRedis {
    hashes = new Map<string, Map<string, string>>();
    lists = new Map<string, string[]>();
    ttl = new Map<string, number>();
    failNext = 0;

    private check() {
        if (this.failNext > 0) { this.failNext--; throw new Error('dragonfly down'); }
    }
    private hash(key: string) {
        let hash = this.hashes.get(key);
        if (!hash) this.hashes.set(key, hash = new Map());
        return hash;
    }
    private list(key: string) {
        let list = this.lists.get(key);
        if (!list) this.lists.set(key, list = []);
        return list;
    }
    async hIncrBy(key: string, field: string, by: number) {
        const hash = this.hash(key);
        const next = Number(hash.get(field) ?? 0) + by;
        hash.set(field, String(next));
        return next;
    }
    async hSet(key: string, field: string, value: string) { this.hash(key).set(field, value); return 1; }
    async hSetNX(key: string, field: string, value: string) {
        this.check();
        const hash = this.hash(key);
        if (hash.has(field)) return 0;
        hash.set(field, value);
        return 1;
    }
    async expire(key: string, seconds: number) { this.ttl.set(key, seconds); return 1; }
    async rPush(key: string, values: string | string[]) {
        const list = this.list(key);
        list.push(...(Array.isArray(values) ? values : [values]));
        return list.length;
    }
    async lTrim(key: string, start: number, stop: number) {
        const list = this.list(key);
        const from = start < 0 ? Math.max(0, list.length + start) : start;
        const to = stop < 0 ? list.length + stop : stop;
        this.lists.set(key, list.slice(from, to + 1));
        return 'OK';
    }
    async lPopCount(key: string, count: number) {
        this.check();
        const list = this.list(key);
        return list.length ? list.splice(0, count) : null;
    }
    multi() {
        const ops: (() => Promise<unknown>)[] = [];
        const chain: Record<string, unknown> = {};
        for (const name of ['hIncrBy', 'hSet', 'expire', 'rPush', 'lTrim'] as const) {
            chain[name] = (...args: unknown[]) => { ops.push(() => (this[name] as (...a: unknown[]) => Promise<unknown>)(...args)); return chain; };
        }
        chain.exec = async () => {
            this.check();
            const out = [];
            for (const op of ops) out.push(await op());
            return out;
        };
        return chain;
    }
    stats() {
        return Object.fromEntries(this.hashes.get(`site_agent:stats:${new Date().toISOString().slice(0, 10)}`) ?? []);
    }
}

const redis = new FakeRedis();
const ingest = mock.fn(async (_events: unknown[]) => ({ inserted: 1, duplicates: 0 }));
const accounts = new Map<string, { polar_sh_customer_id: string }>();
const reconcile = mock.fn(async (_id: string, _opts?: unknown): Promise<LlmUsage | null> => null);
const logged: unknown[] = [];

mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => redis } });
mock.module('../utils/polarsh.js', { namedExports: { ingestPolarNamedEvents: ingest } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async (id: string) => accounts.get(id) ?? null } });
mock.module('../utils/logger.js', { namedExports: { warn: async (data: unknown) => { logged.push(data); }, error: async (data: unknown) => { logged.push(data); } } });
mock.module('./llm/openrouter.js', { namedExports: { reconcileGeneration: reconcile, RECONCILE_SCHEDULE_MS: [5_000, 15_000, 45_000, 90_000] } });

const usageModule = await import('./usage.js');
const { recordStep, recordTurn, recordFeedback, queueReconcile, drainReconcile, drainPolarRetries, polarExternalId } = usageModule;

const base = { channelId: '533538623', plan: 'premium' as const, sessionId: 's1', turnId: 't1', step: 2, model: 'openai/gpt-6-luna', requesterId: 'u9', kind: 'step' as const };
const reported: LlmUsage = { promptTokens: 1200, cachedTokens: 900, completionTokens: 300, reasoningTokens: 120, upstreamCostUsd: 0.000271, routerCostUsd: 0, source: 'reported', isByok: true };

beforeEach(() => {
    redis.hashes.clear(); redis.lists.clear(); redis.ttl.clear(); redis.failNext = 0;
    ingest.mock.resetCalls();
    ingest.mock.mockImplementation(async () => ({ inserted: 1, duplicates: 0 }));
    reconcile.mock.resetCalls();
    accounts.clear();
    accounts.set('533538623', { polar_sh_customer_id: 'cust_1' });
    logged.length = 0;
});

test('recordStep writes daily stats and one ai_assistant event (no credits)', async () => {
    const result = await recordStep({ ...base, usage: reported });
    assert.deepEqual(result, { costUsd: 0.000271, costSource: 'reported', polar: 'sent' });
    assert.deepEqual(redis.stats(), {
        steps: '1', plan_premium_steps: '1', prompt_tokens: '1200', cached_tokens: '900', completion_tokens: '300',
        reasoning_tokens: '120', cost_micro_usd: '271',
    });
    assert.equal(redis.ttl.get(`site_agent:stats:${new Date().toISOString().slice(0, 10)}`), 120 * 86_400);
    assert.equal(ingest.mock.callCount(), 1);
    assert.deepEqual(ingest.mock.calls[0].arguments[0], [{
        name: 'ai_assistant', customerId: 'cust_1', externalId: 'site_agent:t1:2',
        metadata: {
            model: 'openai/gpt-6-luna', prompt_tokens: 1200, cached_tokens: 900, completion_tokens: 300, reasoning_tokens: 120,
            cost_usd: 0.000271, cost_source: 'reported', plan: 'premium', session_id: 's1', turn_id: 't1', step: 2, requester_id: 'u9', kind: 'step',
        },
    }]);
    const event = (ingest.mock.calls[0].arguments[0] as { metadata: Record<string, unknown> }[])[0];
    assert.equal('credits' in event.metadata, false);
});

test('estimated, unknown and compaction steps are counted apart', async () => {
    await recordStep({ ...base, usage: { ...reported, upstreamCostUsd: null } });
    await recordStep({ ...base, step: 3, usage: null });
    await recordStep({ ...base, kind: 'compaction', usage: reported });
    const stats = redis.stats();
    assert.equal(stats.steps, '2');
    assert.equal(stats.compactions, '1');
    assert.equal(stats.plan_premium_steps, '3');
    assert.equal(stats.cost_estimated_steps, '1');
    assert.equal(stats.cost_unknown_steps, '1');
    // estimate: 300 × 0.10/M + 900 × 0.01/M + 300 × 0.50/M = 0.000189
    assert.equal(stats.cost_micro_usd, String(189 + 271));
    const events = ingest.mock.calls.map((call) => (call.arguments[0] as { externalId: string; metadata: Record<string, unknown> }[])[0]);
    assert.equal(events[0].metadata.cost_source, 'estimated');
    assert.equal(events[0].metadata.cost_usd, 0.000189);
    assert.equal(events[1].metadata.cost_source, 'unknown');
    assert.equal('cost_usd' in events[1].metadata, false, 'unknown cost is left out, never 0');
    assert.equal(events[2].externalId, 'site_agent:t1:c2', 'compactions never collide with a step id');
    assert.equal(polarExternalId('t1', 2, 'step'), 'site_agent:t1:2');
    assert.equal(polarExternalId('t1', 'c2-1700', 'compaction'), 'site_agent:t1:c2-1700', 'string steps are used as given');
    await recordStep({ ...base, step: '4', usage: reported });
    const named = (ingest.mock.calls.at(-1)!.arguments[0] as { externalId: string; metadata: Record<string, unknown> }[])[0];
    assert.equal(named.externalId, 'site_agent:t1:4');
    assert.equal(named.metadata.step, '4');
});

test('no Polar customer: stats only, silently', async () => {
    accounts.clear();
    const result = await recordStep({ ...base, usage: reported });
    assert.equal(result.polar, 'skipped');
    assert.equal(ingest.mock.callCount(), 0);
    assert.equal(redis.stats().steps, '1');
    assert.equal(logged.length, 0);
});

test('Polar failures never throw: logged and kept for retry, then drained', async () => {
    ingest.mock.mockImplementation(async () => { throw new Error('polar 503'); });
    const result = await recordStep({ ...base, usage: reported });
    assert.equal(result.polar, 'queued');
    assert.equal(logged.length, 1);
    const queued = redis.lists.get('site_agent:polar:retry')!;
    assert.equal(queued.length, 1);
    assert.equal(JSON.parse(queued[0]).event.externalId, 'site_agent:t1:2');
    assert.equal(redis.ttl.get('site_agent:polar:retry'), 7 * 86_400);

    // Still failing: the events go back with one more attempt.
    assert.deepEqual(await drainPolarRetries(10), { sent: 0, failed: 1 });
    assert.equal(JSON.parse(redis.lists.get('site_agent:polar:retry')![0]).attempts, 2);

    ingest.mock.mockImplementation(async () => ({ inserted: 1, duplicates: 0 }));
    assert.deepEqual(await drainPolarRetries(10), { sent: 1, failed: 0 });
    assert.equal(redis.lists.get('site_agent:polar:retry')!.length, 0);
    const resent = (ingest.mock.calls.at(-1)!.arguments[0] as { externalId: string }[])[0];
    assert.equal(resent.externalId, 'site_agent:t1:2', 'same external id, so Polar dedupes');
    assert.deepEqual(await drainPolarRetries(10), { sent: 0, failed: 0 });
});

test('the Polar retry list is bounded', async () => {
    redis.lists.set('site_agent:polar:retry', Array.from({ length: 5_000 }, (_, i) => JSON.stringify({ event: { name: 'ai_assistant', externalId: `old${i}` }, attempts: 1 })));
    ingest.mock.mockImplementation(async () => { throw new Error('down'); });
    await recordStep({ ...base, usage: reported });
    const list = redis.lists.get('site_agent:polar:retry')!;
    assert.equal(list.length, 5_000);
    assert.equal(JSON.parse(list.at(-1)!).event.externalId, 'site_agent:t1:2', 'newest kept, oldest dropped');
});

test('Dragonfly down: recordStep still sends the Polar event and does not throw', async () => {
    redis.failNext = 1;
    const result = await recordStep({ ...base, usage: reported });
    assert.equal(result.polar, 'sent');
    assert.equal(logged.length, 1);
});

test('recordTurn counts messages only when counted', async () => {
    await recordTurn({ channelId: '1', plan: 'free', status: 'completed', steps: 3, toolCalls: 4, durationMs: 12_345, counted: true });
    await recordTurn({ channelId: '1', plan: 'free', status: 'failed', steps: 1, toolCalls: 0, durationMs: 200, counted: false });
    assert.deepEqual(redis.stats(), {
        turns: '2', turns_completed: '1', turns_failed: '1', tool_calls: '4', duration_ms_total: '12545', messages: '1', plan_free_messages: '1',
    });
});

test('recordFeedback: first rating wins', async () => {
    assert.equal(await recordFeedback('t1', true), true);
    assert.equal(await recordFeedback('t1', false), false);
    assert.equal(await recordFeedback('t2', false), true);
    assert.equal(await recordFeedback('', true), false);
    assert.equal(await recordFeedback('t3', 'yes' as unknown as boolean), false);
    assert.equal(redis.hashes.get('site_agent:feedback:t1')!.get('rating'), 'helpful');
    assert.equal(redis.ttl.get('site_agent:feedback:t1'), 30 * 86_400);
    const stats = redis.stats();
    assert.equal(stats.helpful, '1');
    assert.equal(stats.unhelpful, '1');
});

test('reconcile queue: waits until due, records found usage, gives up as unknown', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    await queueReconcile({ ...base, generationId: 'gen-found' });
    await queueReconcile({ ...base, turnId: 't2', generationId: 'gen-missing' });
    assert.equal(redis.ttl.get('site_agent:reconcile'), 86_400);

    // Not due yet (first lookup at +5 s).
    assert.deepEqual(await drainReconcile(10), { reconciled: 0, unknown: 0, pending: 2 });
    assert.equal(reconcile.mock.callCount(), 0);

    reconcile.mock.mockImplementation(async (id: string) => id === 'gen-found'
        ? { ...reported, source: 'reconciled', upstreamCostUsd: 0.0001611 } : null);
    t.mock.timers.setTime(1_000_000 + 5_000);
    assert.deepEqual(await drainReconcile(10), { reconciled: 1, unknown: 0, pending: 1 });
    assert.deepEqual(reconcile.mock.calls[0].arguments, ['gen-found', { scheduleMs: [] }], 'one lookup per drain, no waiting');
    assert.equal(ingest.mock.callCount(), 1);
    const event = (ingest.mock.calls[0].arguments[0] as { metadata: Record<string, unknown> }[])[0];
    assert.equal(event.metadata.cost_source, 'reconciled');
    assert.equal(event.metadata.cost_usd, 0.0001611);

    for (const at of [15_000, 45_000]) {
        t.mock.timers.setTime(1_000_000 + at);
        assert.deepEqual(await drainReconcile(10), { reconciled: 0, unknown: 0, pending: 1 });
    }
    t.mock.timers.setTime(1_000_000 + 90_000);
    assert.deepEqual(await drainReconcile(10), { reconciled: 0, unknown: 1, pending: 0 });
    assert.equal(redis.lists.get('site_agent:reconcile')!.length, 0);
    const stats = redis.stats();
    assert.equal(stats.steps, '2');
    assert.equal(stats.cost_unknown_steps, '1');
    assert.equal(reconcile.mock.callCount(), 5);
});

test('queueReconcile falls back to an unknown-cost step when Dragonfly fails', async () => {
    redis.failNext = 1;
    await queueReconcile({ ...base, generationId: 'gen-1' });
    assert.equal(ingest.mock.callCount(), 1);
    assert.equal((ingest.mock.calls[0].arguments[0] as { metadata: Record<string, unknown> }[])[0].metadata.cost_source, 'unknown');
});
