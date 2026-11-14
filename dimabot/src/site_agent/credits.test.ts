// Tool-call credits (site_agent/credits.ts): price table, the reserve Lua script (run in a Redis Lua 5.1
// WASM engine over an in-memory store), and settle through the REAL ingestPolarSHEvent with Polar mocked.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { LuaWasmEngine, type ReplyValue } from 'lua-redis-wasm';

// ---------------------------------------------------------------------------------------------------------
// In-memory Dragonfly: strings, hashes and lists; Lua through the WASM engine.
// ---------------------------------------------------------------------------------------------------------
type Entry = { kind: 'string'; value: string } | { kind: 'hash'; value: Map<string, string> } | { kind: 'list'; value: string[] };
const store = new Map<string, Entry>();
const pttl = new Map<string, number>();
const failures = { eval: false, rPush: false, hDel: false };

const hash = (key: string, create = false) => {
    const entry = store.get(key);
    if (entry?.kind === 'hash') return entry.value;
    if (!create) return null;
    const value = new Map<string, string>();
    store.set(key, { kind: 'hash', value });
    return value;
};
const list = (key: string) => {
    const entry = store.get(key);
    if (entry?.kind === 'list') return entry.value;
    const value: string[] = [];
    store.set(key, { kind: 'list', value });
    return value;
};
const getString = (key: string) => { const entry = store.get(key); return entry?.kind === 'string' ? entry.value : null; };
const dropEmptyHash = (key: string) => { if (hash(key)?.size === 0) store.delete(key); };

const engine = await LuaWasmEngine.create({
    host: {
        redisCall(args) {
            const [cmd, key, ...rest] = args.map((arg) => arg.toString());
            switch (cmd.toUpperCase()) {
                case 'GET': { const value = getString(key); return value === null ? null : Buffer.from(value); }
                case 'EXISTS': return store.has(key) ? 1 : 0;
                case 'HGETALL': return [...(hash(key)?.entries() ?? [])].flat().map((item) => Buffer.from(item));
                case 'HSET': { const map = hash(key, true)!; let added = 0; for (let i = 0; i < rest.length; i += 2) { if (!map.has(rest[i])) added++; map.set(rest[i], rest[i + 1]); } return added; }
                case 'HDEL': { const removed = rest.filter((field) => hash(key)?.delete(field)).length; dropEmptyHash(key); return removed; }
                case 'PEXPIRE': if (!store.has(key)) return 0; pttl.set(key, Number(rest[0])); return 1;
                default: return { err: Buffer.from(`ERR fake does not implement ${cmd}`) };
            }
        },
        redisPcall(args) { return this.redisCall(args); },
        log() {},
    },
});
const toJs = (reply: ReplyValue): unknown => {
    if (Buffer.isBuffer(reply)) return reply.toString();
    if (Array.isArray(reply)) return reply.map(toJs);
    if (reply && typeof reply === 'object' && 'err' in reply) throw new Error(reply.err.toString());
    return reply;
};
const evalCalls: string[][] = [];
const fakeCache = {
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
        if (failures.eval) throw new Error('dragonfly down');
        evalCalls.push(options.keys);
        return toJs(engine.evalWithArgs(script, options.keys, options.arguments));
    },
    async get(key: string) { return getString(key); },
    async set(key: string, value: string, options?: { NX?: boolean }) {
        if (options?.NX && store.has(key)) return null;
        store.set(key, { kind: 'string', value });
        return 'OK';
    },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async exists(key: string) { return store.has(key) ? 1 : 0; },
    async type(key: string) { return store.get(key)?.kind ?? 'none'; },
    async hDel(key: string, field: string) {
        if (failures.hDel) throw new Error('dragonfly down');
        const removed = hash(key)?.delete(field) ? 1 : 0;
        dropEmptyHash(key);
        return removed;
    },
    async rPush(key: string, values: string | string[]) {
        if (failures.rPush) throw new Error('dragonfly down');
        const target = list(key);
        target.push(...(Array.isArray(values) ? values : [values]));
        return target.length;
    },
    async lRange(key: string, start: number, stop: number) { const items = list(key); return items.slice(start, stop === -1 ? undefined : stop + 1); },
    async lTrim(key: string, start: number, _stop: number) { const items = list(key); items.splice(0, start); if (!items.length) store.delete(key); return 'OK'; },
};

// ---------------------------------------------------------------------------------------------------------
// Module mocks. polarsh.ts and ai_usage_event.ts stay real.
// ---------------------------------------------------------------------------------------------------------
const polarIngest = mock.fn(async ({ events }: { events: unknown[] }) => ({ inserted: events.length, duplicates: 0 }));
const recordAiCreditUsage = mock.fn(async (_channelID: string, _credits: number, _externalId?: string) => {});
const getAiCredits = mock.fn(async (_user: unknown, _channelId: string, _options?: { requireVerified?: boolean }) => ({}) as unknown);
const receipts: Array<Record<string, unknown>> = [];
const logs: Array<{ level: string; data: Record<string, unknown> }> = [];
let owner: { plan_tier: string; polar_sh_customer_id: string | null } | null = { plan_tier: 'free', polar_sh_customer_id: 'cust_1' };
const ownerQueries: unknown[] = [];

mock.module('@polar-sh/sdk', { namedExports: { Polar: class { events = { ingest: polarIngest }; } } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => fakeCache } });
mock.module('../utils/billing.js', { namedExports: { AI_CREDITS_CACHE_SCHEMA_VERSION: 3, getAiCredits, recordAiCreditUsage } });
mock.module('../schemas/users.schema.js', {
    defaultExport: {
        findOne: (query: unknown) => {
            ownerQueries.push(query);
            const chain = { select: () => chain, maxTimeMS: () => chain, lean: () => chain, exec: async () => owner };
            return chain;
        },
    },
});
const logAt = (level: string) => async (data: Record<string, unknown>) => { logs.push({ level, data }); return {}; };
mock.module('../utils/logger.js', { namedExports: { error: logAt('error'), warn: logAt('warn'), info: logAt('info') } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiUsageRecorded: () => {} } });
mock.module('../utils/ai_usage_ledger.js', {
    namedExports: {
        buildQueuedAiUsageReceipt: (input: Record<string, unknown>) => { receipts.push(input); return input; },
        enqueueAiUsageReceipt: async () => {},
    },
});
process.env.POLARSH_OAT = 'test-token';

const {
    toolPrice, PRICE_OVERRIDES, TOOL_KIND_PRICES, CreditError, reserveToolCredits, settleToolCredits, releaseToolCredits,
    polarCentsForCredits, toolCreditHoldsKey, TOOL_CREDIT_HOLD_TTL_MS, TOOL_CREDIT_MAX_HOLDS,
} = await import('./credits.js');

const CH = '533538623';
const HOLDS = toolCreditHoldsKey(CH);
const setSnapshot = (data: Record<string, unknown>, channelId = CH) =>
    store.set(`twitch:${channelId}:ai:credits`, { kind: 'string', value: JSON.stringify({ version: 3, used: 0, limit: 25000, available: true, status: 'available', ...data }) });
const holds = () => Object.fromEntries(hash(HOLDS) ?? []);
const rejectsWith = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (err: unknown) => err instanceof CreditError && err.code === code);

beforeEach(() => {
    store.clear(); pttl.clear(); evalCalls.length = 0; receipts.length = 0; logs.length = 0; ownerQueries.length = 0;
    Object.assign(failures, { eval: false, rPush: false, hDel: false });
    owner = { plan_tier: 'free', polar_sh_customer_id: 'cust_1' };
    for (const fn of [polarIngest, recordAiCreditUsage, getAiCredits]) fn.mock.resetCalls();
    polarIngest.mock.mockImplementation(async ({ events }) => ({ inserted: events.length, duplicates: 0 }));
    getAiCredits.mock.mockImplementation(async () => ({}));
});

// ---------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------
test('price table: site always free; MCP charges read/write/stream 1, knowledge/ui free; overrides win', () => {
    const kinds = ['knowledge', 'ui', 'read', 'write', 'stream'] as const;
    for (const kind of kinds) assert.equal(toolPrice({ name: `x_${kind}`, kind }, 'site'), 0, `site ${kind}`);
    assert.deepEqual(Object.fromEntries(kinds.map((kind) => [kind, toolPrice({ name: `x_${kind}`, kind }, 'mcp')])),
        { knowledge: 0, ui: 0, read: 1, write: 1, stream: 1 });
    assert.equal(toolPrice({ name: 'undo_change', kind: 'write' }, 'mcp'), 0, 'undo_change free until the owner decides');
    assert.equal(toolPrice({ name: 'undo_change', kind: 'write' }, 'site'), 0);
    // Prototype names are not overrides; an unknown kind is never free.
    assert.equal(toolPrice({ name: 'constructor', kind: 'read' }, 'mcp'), 1);
    assert.equal(toolPrice({ name: 'toString', kind: 'write' }, 'mcp'), 1);
    assert.equal(toolPrice({ name: 'new_tool', kind: 'future' as never }, 'mcp'), 1);
    for (const price of [...Object.values(PRICE_OVERRIDES), ...Object.values(TOOL_KIND_PRICES)]) assert.ok(Number.isSafeInteger(price) && price >= 0);
    assert.ok(Object.isFrozen(PRICE_OVERRIDES) && Object.isFrozen(TOOL_KIND_PRICES));
});

test('Polar cents bill exactly N credits through ceil(cost × 1000), including where N / 1000 lands an ulp high', (t) => {
    const naiveOverBills: number[] = [];
    for (let credits = 1; credits <= 100_000; credits++) {
        if (Math.ceil((credits / 1000) * 1000) !== credits) naiveOverBills.push(credits);
        const cents = polarCentsForCredits(credits);
        assert.equal(Math.ceil(cents * 1000), credits, `credits ${credits}`);
        assert.ok(Math.abs(cents - credits / 1000) <= 4 * Number.EPSILON * (credits / 1000), `cents ${credits} stays the price`);
    }
    assert.equal(naiveOverBills[0], 2007, 'plain credits / 1000 over-bills from 2007 credits on');
    t.diagnostic(`credits / 1000 over-bills ${naiveOverBills.length} of 100000 prices, first: ${naiveOverBills.slice(0, 8).join(', ')}`);
    assert.equal(polarCentsForCredits(1), 0.001, '1 credit = 0.001 cents = $0.00001');
});

// ---------------------------------------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------------------------------------
test('reserve holds the price with a ~10 minute expiry when the balance covers it', async () => {
    setSnapshot({ balance: 10 });
    const before = Date.now();
    assert.deepEqual(await reserveToolCredits(CH, 2, 'op-1'), { channelId: CH, credits: 2, operationId: 'op-1' });
    const [credits, expires] = holds()['op-1'].split(':').map(Number);
    assert.equal(credits, 2);
    assert.ok(expires >= before + TOOL_CREDIT_HOLD_TTL_MS && expires <= Date.now() + TOOL_CREDIT_HOLD_TTL_MS);
    assert.equal(TOOL_CREDIT_HOLD_TTL_MS, 600_000);
    assert.equal(pttl.get(HOLDS), TOOL_CREDIT_HOLD_TTL_MS, 'the holds hash expires on its own');
    assert.deepEqual(evalCalls[0], [`twitch:${CH}:ai:credits`, `twitch:${CH}:ai:exhaust`, `${CH}:ai:exhaust`, HOLDS]);
    assert.equal(getAiCredits.mock.callCount(), 0, 'a valid snapshot needs no Polar read');
});

test('reserve: balance minus pending holds short of the price → credits_exhausted', async () => {
    setSnapshot({ balance: 2 });
    await reserveToolCredits(CH, 1, 'a');
    await reserveToolCredits(CH, 1, 'b');
    await rejectsWith(reserveToolCredits(CH, 1, 'c'), 'credits_exhausted');
    assert.deepEqual(Object.keys(holds()).sort(), ['a', 'b']);
    setSnapshot({ balance: 3 });
    await rejectsWith(reserveToolCredits(CH, 2, 'd'), 'credits_exhausted');
    await reserveToolCredits(CH, 1, 'e');
    setSnapshot({ balance: 0 });
    store.delete(HOLDS);
    await rejectsWith(reserveToolCredits(CH, 1, 'f'), 'credits_exhausted');
    setSnapshot({ balance: 500, status: 'exhausted' });
    await rejectsWith(reserveToolCredits(CH, 1, 'g'), 'credits_exhausted');
    assert.equal(hash(HOLDS), null);
});

test('reserve: either exhaustion marker → credits_exhausted even with a balance', async () => {
    setSnapshot({ balance: 1000 });
    for (const marker of [`twitch:${CH}:ai:exhaust`, `${CH}:ai:exhaust`]) {
        store.set(marker, { kind: 'string', value: 'true' });
        await rejectsWith(reserveToolCredits(CH, 1, `op-${marker}`), 'credits_exhausted');
        store.delete(marker);
    }
    assert.equal(hash(HOLDS), null);
    await reserveToolCredits(CH, 1, 'after');
});

test('reserve: missing snapshot → loads it once through getAiCredits (verified) and retries', async () => {
    getAiCredits.mock.mockImplementation(async () => { setSnapshot({ balance: 5 }); return {}; });
    await reserveToolCredits(CH, 1, 'op-load');
    assert.equal(getAiCredits.mock.callCount(), 1);
    const [user, channelId, options] = getAiCredits.mock.calls[0].arguments;
    assert.deepEqual(user, owner);
    assert.equal(channelId, CH);
    assert.equal(options?.requireVerified, true);
    assert.deepEqual(ownerQueries[0], { accounts: { $elemMatch: { type: 'twitch', id: CH } } });
    assert.ok(holds()['op-load']);
});

test('reserve: still no usable snapshot after the load → credits_unavailable, no loop', async () => {
    await rejectsWith(reserveToolCredits(CH, 1, 'op-1'), 'credits_unavailable');
    assert.equal(getAiCredits.mock.callCount(), 1);
    assert.equal(evalCalls.length, 2);
    // Invalid snapshots count as unknown: wrong schema version, unverified, unreadable, no balance.
    for (const raw of [
        JSON.stringify({ version: 2, available: true, balance: 100 }),
        JSON.stringify({ version: 3, available: false, status: 'unavailable', balance: 100 }),
        JSON.stringify({ version: 3, available: true }),
        'not json',
    ]) {
        store.set(`twitch:${CH}:ai:credits`, { kind: 'string', value: raw });
        await rejectsWith(reserveToolCredits(CH, 1, 'op-2'), 'credits_unavailable');
    }
    assert.equal(getAiCredits.mock.callCount(), 5);
    // getAiCredits failing or exhausting while loading.
    store.delete(`twitch:${CH}:ai:credits`);
    getAiCredits.mock.mockImplementation(async () => { throw new Error('polar down'); });
    await rejectsWith(reserveToolCredits(CH, 1, 'op-3'), 'credits_unavailable');
    getAiCredits.mock.mockImplementation(async () => { store.set(`twitch:${CH}:ai:exhaust`, { kind: 'string', value: 'true' }); return {}; });
    await rejectsWith(reserveToolCredits(CH, 1, 'op-4'), 'credits_exhausted');
    assert.equal(hash(HOLDS), null);
});

test('reserve: a channel without a billing customer or owner is unavailable without a Polar read', async () => {
    owner = { plan_tier: 'pro', polar_sh_customer_id: null };
    await rejectsWith(reserveToolCredits(CH, 1, 'op-1'), 'credits_unavailable');
    owner = null;
    await rejectsWith(reserveToolCredits(CH, 1, 'op-2'), 'credits_unavailable');
    assert.equal(getAiCredits.mock.callCount(), 0);
});

test('reserve: Dragonfly failure → credits_unavailable', async () => {
    setSnapshot({ balance: 100 });
    failures.eval = true;
    await rejectsWith(reserveToolCredits(CH, 1, 'op-1'), 'credits_unavailable');
    assert.ok(logs.some((entry) => entry.level === 'error' && entry.data.function === 'siteAgent.credits.reserve'));
});

test('reserve: at most 8 concurrent holds per channel; a release frees a slot; other channels unaffected', async () => {
    setSnapshot({ balance: 1_000 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveToolCredits(CH, 1, `op-${i}`)));
    assert.equal(TOOL_CREDIT_MAX_HOLDS, 8);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
    for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(((r as PromiseRejectedResult).reason as InstanceType<typeof CreditError>).code, 'credits_unavailable');
    assert.equal(Object.keys(holds()).length, 8);
    await releaseToolCredits({ channelId: CH, credits: 1, operationId: 'op-0' });
    await reserveToolCredits(CH, 1, 'op-again');
    setSnapshot({ balance: 10 }, '42');
    await reserveToolCredits('42', 1, 'op-other');
});

test('reserve: concurrent calls never hold more than the balance', async () => {
    setSnapshot({ balance: 3 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => reserveToolCredits(CH, 1, `op-${i}`)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(Object.values(holds()).reduce((sum, value) => sum + Number(value.split(':')[0]), 0), 3);
});

test('reserve: expired and malformed holds are pruned and stop counting', async () => {
    setSnapshot({ balance: 1 });
    const map = hash(HOLDS, true)!;
    map.set('crashed', `1:${Date.now() - 1}`);
    map.set('garbage', 'nonsense');
    for (let i = 0; i < 8; i++) map.set(`old-${i}`, `5:${Date.now() - 60_000}`);
    await reserveToolCredits(CH, 1, 'fresh');
    assert.deepEqual(Object.keys(holds()), ['fresh']);
});

test('reserve: a duplicate operationId is refused and never double-holds', async () => {
    setSnapshot({ balance: 100 });
    await reserveToolCredits(CH, 3, 'op-dup');
    const before = holds()['op-dup'];
    await rejectsWith(reserveToolCredits(CH, 3, 'op-dup'), 'credits_unavailable');
    await rejectsWith(reserveToolCredits(CH, 1, 'op-dup'), 'credits_unavailable');
    assert.deepEqual(holds(), { 'op-dup': before });
});

test('reserve: 0 credits holds nothing; invalid input is a programming error', async () => {
    assert.deepEqual(await reserveToolCredits(CH, 0, 'free'), { channelId: CH, credits: 0, operationId: 'free' });
    assert.equal(evalCalls.length, 0);
    await assert.rejects(reserveToolCredits(CH, 1.5, 'op'), TypeError);
    await assert.rejects(reserveToolCredits(CH, -1, 'op'), TypeError);
    await assert.rejects(reserveToolCredits(CH, Number.NaN, 'op'), TypeError);
    await assert.rejects(reserveToolCredits('', 1, 'op'), TypeError);
    await assert.rejects(reserveToolCredits('a:b', 1, 'op'), TypeError);
    await assert.rejects(reserveToolCredits(CH, 1, ''), TypeError);
    await assert.rejects(reserveToolCredits(CH, 1, 'x'.repeat(129)), TypeError);
});

// ---------------------------------------------------------------------------------------------------------
// Settle and release (real ingestPolarSHEvent, batch mode)
// ---------------------------------------------------------------------------------------------------------
test('settle charges exactly the price for 1, 2, 5 and 2007 credits through the ai_usage path, then drops the hold', async () => {
    setSnapshot({ balance: 10_000 });
    for (const credits of [1, 2, 5, 2007]) {
        polarIngest.mock.resetCalls(); recordAiCreditUsage.mock.resetCalls(); receipts.length = 0;
        const operationId = `op-${credits}`;
        const reservation = await reserveToolCredits(CH, credits, operationId);
        await settleToolCredits(reservation, { tool: 'create_command', surface: 'mcp' });

        assert.equal(polarIngest.mock.callCount(), 1);
        const [event] = polarIngest.mock.calls[0].arguments[0].events as Array<{ name: string; customerId: string; externalId: string; metadata: Record<string, unknown> }>;
        const { cost, ...metadata } = event.metadata;
        assert.deepEqual({ ...event, metadata }, {
            name: 'ai_usage',
            customerId: 'cust_1',
            externalId: `mcp_tool:${operationId}`,
            metadata: {
                currency: 'usd', credits, reason: 'mcp_tool',
                schema_version: 1, pricing_version: 'legacy-polar-math-v1',
                entry_id: `mcp_tool:${operationId}`, request_id: operationId, entry_kind: 'usage',
                category: 'ai_agent', operation: 'create_command', usage_source: 'mcp', provider: 'dima', channel_id: CH,
            },
        });
        assert.equal(Math.ceil(Number(cost) * 1000), credits, 'cost is the price in cents');
        assert.ok(Math.abs(Number(cost) - credits / 1000) <= 4 * Number.EPSILON * (credits / 1000));
        // The local projection runs once, inside the Polar path, with exactly the price.
        assert.deepEqual(recordAiCreditUsage.mock.calls.map((call) => call.arguments.slice(0, 3)), [[CH, credits, `mcp_tool:${operationId}`]]);
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].credits, credits);
        assert.equal(receipts[0].costUsd, 0);
        assert.equal(holds()[operationId], undefined, 'hold removed after acceptance');
        assert.equal(store.has(`twitch:${CH}:ai:polarshevent`), false, 'flushed queue is empty');
    }
    assert.equal(logs.filter((entry) => entry.level === 'error').length, 0);
});

test('settle: Polar down but the event is durably queued → hold dropped, event kept for the next flush', async () => {
    setSnapshot({ balance: 10 });
    const reservation = await reserveToolCredits(CH, 1, 'op-q');
    polarIngest.mock.mockImplementation(async () => { throw new Error('polar 503'); });
    await settleToolCredits(reservation, { tool: 'list_commands', surface: 'mcp' });
    assert.equal(holds()['op-q'], undefined);
    const queued = (store.get(`twitch:${CH}:ai:polarshevent`) as { value: string[] }).value.map((raw) => JSON.parse(raw));
    assert.deepEqual(queued.map((event) => [event.externalId, event.metadata.credits]), [['mcp_tool:op-q', 1]]);
    assert.equal(recordAiCreditUsage.mock.callCount(), 1);
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.data.function === 'siteAgent.credits.settle'));

    // An incomplete ingest is also queued.
    const second = await reserveToolCredits(CH, 1, 'op-q2');
    polarIngest.mock.mockImplementation(async () => ({ inserted: 0, duplicates: 0 }));
    await settleToolCredits(second, { tool: 'list_commands', surface: 'mcp' });
    assert.equal(holds()['op-q2'], undefined);
});

test('settle: ingestion fails outright → hold kept until it expires, failure logged, nothing projected', async () => {
    setSnapshot({ balance: 10 });
    const reservation = await reserveToolCredits(CH, 1, 'op-fail');
    failures.rPush = true;
    await settleToolCredits(reservation, { tool: 'create_command', surface: 'mcp' });
    assert.ok(holds()['op-fail'], 'hold kept');
    assert.equal(recordAiCreditUsage.mock.callCount(), 0);
    assert.equal(polarIngest.mock.callCount(), 0);
    assert.ok(logs.some((entry) => entry.level === 'error' && entry.data.function === 'siteAgent.credits.settle' && entry.data.operationId === 'op-fail'));

    // No billing customer: nothing can be charged, the hold stays and the failure is logged.
    failures.rPush = false;
    const other = await reserveToolCredits(CH, 1, 'op-nocust');
    owner = { plan_tier: 'free', polar_sh_customer_id: null };
    await settleToolCredits(other, { tool: 'create_command', surface: 'mcp' });
    assert.ok(holds()['op-nocust']);
    assert.equal(polarIngest.mock.callCount(), 0);
});

test('settle and release of a free (0 credit) reservation touch nothing', async () => {
    const reservation = await reserveToolCredits(CH, 0, 'op-free');
    await settleToolCredits(reservation, { tool: 'search_docs', surface: 'mcp' });
    await releaseToolCredits(reservation);
    assert.equal(polarIngest.mock.callCount(), 0);
    assert.equal(ownerQueries.length, 0);
});

test('release drops the hold without charging; idempotent and never throws', async () => {
    setSnapshot({ balance: 10 });
    const reservation = await reserveToolCredits(CH, 2, 'op-r');
    await releaseToolCredits(reservation);
    assert.equal(holds()['op-r'], undefined);
    await releaseToolCredits(reservation);
    await releaseToolCredits({ channelId: CH, credits: 1, operationId: 'never-held' });
    assert.equal(polarIngest.mock.callCount(), 0);
    assert.equal(recordAiCreditUsage.mock.callCount(), 0);
    const kept = await reserveToolCredits(CH, 1, 'op-r2');
    failures.hDel = true;
    await releaseToolCredits(kept);
    assert.ok(holds()['op-r2'], 'Dragonfly down: the hold expires by itself');
});

test('reading the AI credit balance is free on MCP, so a channel that is out of credits can still check it', () => {
    assert.equal(toolPrice({ name: 'get_ai_credits', kind: 'read' }, 'mcp'), 0);
    assert.equal(toolPrice({ name: 'list_commands', kind: 'read' }, 'mcp'), 1);
});
