import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { Types } from 'mongoose';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { getAiCredits, AI_CREDITS_METER_ID, buildAiCreditsDataFromMeter } from './billing.js';
import { ACCEPT_PLAN_CREDITS_SCRIPT, CHECK_PLAN_ACCOUNTS_SCRIPT, PLAN_CACHE_VERSION_FIELD,
    WRITE_PLAN_ACCOUNT_SCRIPT, planCacheFenceKey, planCacheVersion } from './plan_cache_fence.js';

let activeCache: unknown;
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => activeCache } });
mock.module('./crypto.js', { namedExports: { decrypt: () => null } });
mock.module('./logger.js', { namedExports: { error: async () => {}, info: () => {}, debug: async () => {}, warn: () => {} } });
mock.module('./posthog_events.js', { namedExports: { identifyStreamer: () => {} } });
mock.module('dotenv/config', { namedExports: {} });
const { TwitchStreamers } = await import('../classes/twitch_streamers.class.js');

const id = 'twitch-owner';
const customerId = 'polar-customer';
const at = new Date('2026-10-26T12:00:00Z');
const priorAt = new Date(at.getTime() - 1000);
const oldVersion = planCacheVersion(priorAt, 'old');
const version = planCacheVersion(at, 'new');
const creditKey = `twitch:${id}:ai:credits`;
const accountKey = `accounts:twitch:${id}:data`;
const meter = { meter_id: AI_CREDITS_METER_ID, consumed_units: 30, balance: -30 };

function user(tier: IUsers['plan_tier'], date = at, key = 'new'): IUsers {
    return { _id: new Types.ObjectId(), plan_tier: tier, plan_tier_until: null,
        polar_sh_customer_id: customerId, polar_plan_event_at: date, polar_plan_event_key: key,
        accounts: [{ id, type: 'twitch', name: 'owner', access_token: { iv: '', content: '' }, refresh_token: { iv: '', content: '' } }] } as IUsers;
}

function fixture(t: TestContext) {
    const values = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    // Service-free state model plus submitted Lua contract assertions. Candidate
    // verification must also execute these scripts against disposable Redis.
    const cache = {
        get: t.mock.fn(async (key: string) => values.get(key) ?? null),
        set: t.mock.fn(async (key: string, value: string) => { values.set(key, value); return 'OK'; }),
        exists: t.mock.fn(async (key: string) => values.has(key) ? 1 : 0),
        del: t.mock.fn(async (keys: string | string[]) => {
            for (const key of typeof keys === 'string' ? [keys] : keys) { values.delete(key); hashes.delete(key); }
            return 1;
        }),
        keys: t.mock.fn(async (_pattern: string) => [...hashes.keys()]),
        hGet: t.mock.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
        hGetAll: t.mock.fn(async (key: string) => ({ ...hashes.get(key) })),
        sAdd: t.mock.fn(async (_key: string, _id: string) => 1),
        eval: t.mock.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
            const { keys, arguments: args } = options;
            if (script === WRITE_PLAN_ACCOUNT_SCRIPT) {
                const fence = values.get(keys[0]);
                if (fence && fence > args[0]) return 0;
                const fields = { ...hashes.get(keys[1]) };
                for (let index = 1; index < args.length; index += 2) fields[args[index]] = args[index + 1];
                hashes.set(keys[1], fields);
                values.delete(keys[2]);
                return 1;
            }
            if (script === CHECK_PLAN_ACCOUNTS_SCRIPT) {
                for (let index = 0; index < args.length - 1; index++) {
                    const fence = values.get(keys[index]);
                    if (fence && fence > args[index]) return 0;
                }
                if (args.at(-1)) values.set(keys.at(-1)!, args.at(-1)!);
                return 1;
            }
            assert.equal(script, ACCEPT_PLAN_CREDITS_SCRIPT);
            const fence = values.get(keys[3]);
            if (fence && fence > args[0]) return 0;
            if (args[2] === 'read') { if (values.get(keys[0]) !== args[1]) return 0; }
            else values.set(keys[0], args[1]);
            if (args[3] === '1') { values.set(keys[1], 'true'); values.set(keys[2], 'true'); }
            else { values.delete(keys[1]); values.delete(keys[2]); }
            return 1;
        })
    };
    activeCache = cache;
    const current = user('free');
    const getCurrentPlan = t.mock.fn(async (_id: string, _customerId: string) => current as IUsers | null);
    const getState = t.mock.fn(async (_customerId: string, _signal?: AbortSignal) => ({ active_meters: [meter] }));
    const deps = { getCache: (async () => cache) as unknown as NonNullable<Parameters<typeof getAiCredits>[3]>['getCache'], getCurrentPlan, getState };
    const select = t.mock.fn((_fields: string) => ({ lean: async () => current }));
    const findOne = t.mock.method(UsersSchema, 'findOne', (() => ({ select })) as unknown as typeof UsersSchema.findOne);
    return { cache, values, hashes, current, deps, getCurrentPlan, getState, select, findOne };
}

test('fallback ignores bare Premium after a plan fence and resolves the exact current owner', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    const result = await getAiCredits(user('premium', priorAt, 'old'), id, {}, f.deps);
    assert.equal(result.limit, 25000);
    assert.equal(result.balance, 24970);
    assert.equal(result.available, true);
    assert.deepEqual(f.getCurrentPlan.mock.calls[0].arguments, [id, customerId]);
    assert.equal(PLAN_CACHE_VERSION_FIELD in result, false);
    assert.equal(JSON.parse(f.values.get(creditKey)!)[PLAN_CACHE_VERSION_FIELD], version);
});

test('fallback finishing after a new downgrade fence returns unavailable and preserves cache/flags/receipts', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), oldVersion);
    Object.assign(f.current, user('premium', priorAt, 'old'));
    f.getState.mock.mockImplementation(async () => {
        f.values.set(planCacheFenceKey(id), version);
        f.values.set(`twitch:${id}:ai:exhaust`, 'true');
        f.values.set(`${id}:ai:exhaust`, 'true');
        f.values.set(`${creditKey}:polar-version`, 'retained');
        return { active_meters: [meter] };
    });
    const result = await getAiCredits(user('premium'), id, {}, f.deps);
    assert.equal(result.available, false);
    assert.equal(result.balance, 0);
    assert.equal(result.limit, 25000);
    assert.equal(f.values.has(creditKey), false);
    assert.equal(f.values.get(`twitch:${id}:ai:exhaust`), 'true');
    assert.equal(f.values.get(`${id}:ai:exhaust`), 'true');
    assert.equal(f.values.get(`${creditKey}:polar-version`), 'retained');
});

test('a fence first created during legacy fallback fetch also rejects its stale caller allowance', async t => {
    const f = fixture(t);
    f.getState.mock.mockImplementation(async () => {
        f.values.set(planCacheFenceKey(id), version);
        return { active_meters: [meter] };
    });
    const result = await getAiCredits(user('premium'), id, {}, f.deps);
    assert.equal(result.available, false);
    assert.equal(result.balance, 0);
    assert.equal(f.values.has(creditKey), false);
});

test('cached Premium without current plan metadata is rejected; current Free cache remains usable without metadata leaking', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    f.values.set(creditKey, JSON.stringify(buildAiCreditsDataFromMeter(meter, 'premium')));
    assert.equal((await getAiCredits(user('premium'), id, {}, f.deps)).limit, 25000);
    f.getCurrentPlan.mock.mockImplementation(async () => { throw new Error('valid cached reads need no Mongo lookup'); });
    const result = await getAiCredits(user('premium'), id, {}, f.deps);
    assert.equal(result.limit, 25000);
    assert.equal(PLAN_CACHE_VERSION_FIELD in result, false);
});

test('cached snapshot read interrupted by invalidation cannot clear the new exhaustion flags', async t => {
    const f = fixture(t);
    const raw = JSON.stringify({ ...buildAiCreditsDataFromMeter(meter, 'premium'), [PLAN_CACHE_VERSION_FIELD]: oldVersion });
    f.values.set(creditKey, raw);
    let interrupted = false;
    f.cache.get.mock.mockImplementation(async key => {
        const value = f.values.get(key) ?? null;
        if (key === creditKey && !interrupted) {
            interrupted = true;
            f.values.delete(creditKey);
            f.values.set(planCacheFenceKey(id), version);
            f.values.set(`twitch:${id}:ai:exhaust`, 'true');
        }
        return value;
    });
    f.getCurrentPlan.mock.mockImplementation(async () => null);
    const result = await getAiCredits(user('premium'), id, {}, f.deps);
    assert.equal(result.available, false);
    assert.equal(f.values.get(`twitch:${id}:ai:exhaust`), 'true');
});

test('fenced fallback mapping/API lookup failures fail closed without changing flags', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    f.values.set(`twitch:${id}:ai:exhaust`, 'true');
    t.mock.method(console, 'error', () => {});
    f.getCurrentPlan.mock.mockImplementation(async () => null);
    assert.equal((await getAiCredits(user('premium'), id, {}, f.deps)).available, false);
    f.getCurrentPlan.mock.mockImplementation(async () => f.current);
    f.getState.mock.mockImplementation(async () => { throw new Error('provider unavailable'); });
    assert.equal((await getAiCredits(user('premium'), id, {}, f.deps)).balance, 0);
    assert.equal(f.values.get(`twitch:${id}:ai:exhaust`), 'true');
});

test('current plan lookup uses one exact Twitch array element and pins the caller customer', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    const { getCurrentPlan: _injected, ...deps } = f.deps;
    await getAiCredits(user('premium'), id, {}, deps);
    assert.deepEqual(f.findOne.mock.calls[0].arguments, [{ accounts: { $elemMatch: { type: 'twitch', id } }, polar_sh_customer_id: customerId }]);
    assert.match(f.select.mock.calls[0].arguments[0], /polar_plan_event_at polar_plan_event_key/);
});

test('lazy account hydration retries an old Mongo snapshot after downgrade and returns only current Free data', async t => {
    const f = fixture(t);
    const old = user('premium', priorAt, 'old');
    let reads = 0;
    f.select.mock.mockImplementation(() => ({ lean: async () => {
        if (reads++ === 0) { f.values.set(planCacheFenceKey(id), version); return old; }
        return f.current;
    } }));
    const result = await new TwitchStreamers().getTwitchAccountById(id);
    assert.equal(result?.plan_tier, 'free');
    assert.equal(PLAN_CACHE_VERSION_FIELD in result!, false);
    assert.equal(f.hashes.get(accountKey)?.plan_tier, 'free');
    assert.equal(f.hashes.get(accountKey)?.[PLAN_CACHE_VERSION_FIELD], version);
    assert.equal(reads, 2);
    assert.deepEqual(f.findOne.mock.calls[0].arguments, [{ accounts: { $elemMatch: { id, type: 'twitch' } } }]);
});

test('lazy hydration fails closed after two stale snapshots and never repopulates Premium', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    Object.assign(f.current, user('premium', priorAt, 'old'));
    assert.equal(await new TwitchStreamers().getTwitchAccountById(id), null);
    assert.equal(f.findOne.mock.callCount(), 2);
    assert.equal(f.hashes.has(accountKey), false);
});

test('bootstrap skips a stale paid snapshot and selects the Mongo plan version', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    const select = t.mock.fn((_fields: string) => ({ lean: async () => [user('premium', priorAt, 'old')] }));
    t.mock.method(UsersSchema, 'find', (() => ({ select })) as unknown as typeof UsersSchema.find);
    assert.deepEqual(await new TwitchStreamers().getTwitchAccountsFromDB(), []);
    assert.equal(f.hashes.has(accountKey), false);
    assert.match(select.mock.calls[0].arguments[0], /polar_plan_event_at polar_plan_event_key/);
});

test('account aggregate caches validate included plan versions before returning or republishing', async t => {
    const f = fixture(t);
    f.values.set(planCacheFenceKey(id), version);
    f.values.set('twitch:accounts', JSON.stringify([{ id, plan_tier: 'premium', [PLAN_CACHE_VERSION_FIELD]: oldVersion }]));
    f.hashes.set(accountKey, { id, plan_tier: 'free', [PLAN_CACHE_VERSION_FIELD]: version });
    const result = await new TwitchStreamers().getTwitchAccountsFromCache();
    assert.equal(result?.[0].plan_tier, 'free');
    assert.equal(PLAN_CACHE_VERSION_FIELD in result![0], false);
    assert.equal(JSON.parse(f.values.get('twitch:accounts')!)[0].plan_tier, 'free');
});

test('account aggregate assembled before invalidation cannot publish or return the old tier', async t => {
    const f = fixture(t);
    f.hashes.set(accountKey, { id, plan_tier: 'premium', [PLAN_CACHE_VERSION_FIELD]: oldVersion });
    f.cache.hGetAll.mock.mockImplementation(async key => {
        const old = { ...f.hashes.get(key) };
        f.values.set(planCacheFenceKey(id), version);
        return old;
    });
    assert.deepEqual(await new TwitchStreamers().getTwitchAccountsFromCache(), []);
    assert.equal(f.values.has('twitch:accounts'), false);
});

test('Lua fence guards precede every cache/flag write; cached reads compare the exact raw snapshot', () => {
    for (const script of [WRITE_PLAN_ACCOUNT_SCRIPT, ACCEPT_PLAN_CREDITS_SCRIPT]) {
        assert.match(script, /fence and fence > ARGV\[1\].*return 0/);
        assert.ok(script.indexOf('fence >') < script.indexOf("redis.call('SET'" ) || !script.includes("redis.call('SET'"));
    }
    assert.match(ACCEPT_PLAN_CREDITS_SCRIPT, /redis.call\('GET', KEYS\[1\]\) ~= ARGV\[2\].*return 0/);
    assert.ok(WRITE_PLAN_ACCOUNT_SCRIPT.indexOf('fence >') < WRITE_PLAN_ACCOUNT_SCRIPT.indexOf("redis.call('HSET'"));
    assert.ok(CHECK_PLAN_ACCOUNTS_SCRIPT.indexOf('fence >') < CHECK_PLAN_ACCOUNTS_SCRIPT.indexOf("redis.call('SET'"));
});
