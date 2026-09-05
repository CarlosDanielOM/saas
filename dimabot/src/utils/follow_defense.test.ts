import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { FollowDefenseFollowPayload, FollowDefenseState } from './follow_defense_queue.js';
import { runFollowDefenseStateLua } from './follow_defense_state.test-helper.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
let now = NOW;
let values: Map<string, string>;
let sorted: Map<string, Map<string, number>>;
let bans: string[];
let messages: string[];
let cacheCalls = 0;
let failure = '';
let slowRead = '';
let banResult: (user: string) => Promise<{ error: boolean; status?: number; message: string }>;
const cache = {
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
        if (failure === options.keys[0]) throw new Error('cache read failed');
        if (failure === `write:${options.keys[0]}`) { failure = ''; throw new Error('cache write failed'); }
        return runFollowDefenseStateLua(script, options, values, sorted, now);
    },
    async get(key: string) {
        if (failure === key) throw new Error('cache read failed');
        if (slowRead === key) now += 60_000;
        return values.get(key) ?? null;
    },
    async set(key: string, value: string) {
        if (failure === `write:${key}`) { failure = ''; throw new Error('cache write failed'); }
        values.set(key, value);
    },
    async zAdd(key: string, item: { score: number; value: string }) {
        if (!sorted.has(key)) sorted.set(key, new Map());
        sorted.get(key)!.set(item.value, item.score);
    },
    async zRangeByScore(key: string, min: number, max: number) {
        return [...(sorted.get(key) || [])].filter(([, score]) => score >= min && score <= max)
            .sort(([a, x], [b, y]) => x - y || a.localeCompare(b)).map(([id]) => id);
    },
    async del(key: string) { values.delete(key); sorted.delete(key); },
    async zRem(key: string, value: string) { return Number(sorted.get(key)?.delete(value) || false); },
    async sendCommand([command, key, min, max]: string[]) {
        const entries = sorted.get(key) || new Map<string, number>();
        const matches = [...entries].filter(([, score]) => score >= (min === '-inf' ? -Infinity : Number(min)) && score <= Number(max));
        if (command === 'ZCOUNT') return matches.length;
        assert.equal(command, 'ZREMRANGEBYSCORE');
        for (const [id] of matches) entries.delete(id);
        return matches.length;
    }
};
mock.module('./databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => { cacheCalls++; if (failure === 'connect') throw new Error('cache unavailable'); return cache; }
} });
mock.module('../functions/moderation/ban.moderation.js', { namedExports: {
    ban: async (channel: string, user: string, moderator: string) => {
        assert.equal(channel, 'channel'); assert.equal(moderator, '698614112');
        bans.push(user); return banResult(user);
    }
} });
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async (_channel: string, message: string) => { messages.push(message); return { error: false }; } } });
mock.module('../schemas/follow_defense_settings.schema.js', { namedExports: {
    FollowDefenseSettingsSchema: { findOne: () => ({ lean: async () => { throw new Error('settings lookup failed'); } }) }
} });
mock.module('../schemas/follow_attack_log.schema.js', { namedExports: { FollowAttackLogSchema: { create: async () => undefined } } });
mock.module('../schemas/follow_hate_raid_source.schema.js', { namedExports: { FollowHateRaidSourceSchema: {} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => null } });
mock.module('./ai/openrouter/ai.js', { namedExports: { chat: async () => assert.fail('No AI calls') } });
mock.module('./logger.js', { namedExports: { info: async () => undefined, warn: async () => undefined, error: async () => undefined } });
process.env.FOLLOW_DEFENSE_BAN_DELAY_MS = '0';
const { processDurableFollowDefenseFollow, expireFollowDefenseModes, processFollowDefenseQueue } = await import('./follow_defense.js');
const { followDefenseKeys, triggerFollowDefenseAttackMode } = await import('./follow_defense_queue.js');
const keys = followDefenseKeys('channel');

function follow(eventID = 'stable-event', age = 1000): FollowDefenseFollowPayload {
    return {
        eventID, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        followerID: eventID, followerLogin: 'viewer', followerName: 'Viewer',
        followedAt: new Date(NOW - age).toISOString(), receivedAt: NOW - 500
    };
}

function state(mode: FollowDefenseState['mode']): void {
    values.set(keys.state, JSON.stringify({
        mode, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        expiresAt: NOW + 60_000, modeStartedAt: NOW - 1000, burstStartedAt: NOW - 1000,
        triggeredBy: 'threshold', lastTransitionReason: 'test', lastUpdatedAt: NOW
    }));
}

beforeEach((context) => {
    now = NOW; values = new Map(); sorted = new Map(); bans = []; messages = []; cacheCalls = 0; failure = ''; slowRead = '';
    assert.ok('mock' in context);
    context.mock.method(Date, 'now', () => now);
    values.set(keys.settings, JSON.stringify({ enabled: true, attackThreshold: 2 }));
    banResult = async () => ({ error: false, message: 'Success' });
});

test('direct processing uses occurrence scores and stable IDs on partial failure and retry', async () => {
    const payload = follow();
    failure = keys.state;
    await assert.rejects(processDurableFollowDefenseFollow(payload), /cache read failed/);
    assert.equal(values.has(`${keys.completedPrefix}${payload.eventID}`), false);
    now += 500;
    failure = '';
    await processDurableFollowDefenseFollow(payload);
    assert.deepEqual([...sorted.get(keys.recent)!], [[payload.eventID, NOW - 1000]]);
    assert.deepEqual(JSON.parse(values.get(`${keys.followDataPrefix}${payload.eventID}`)!), {
        ...payload, moderationExpiresAt: NOW + 59_000
    });
    assert.equal(values.get(`${keys.completedPrefix}${payload.eventID}`), '1');
    const snapshot = [...values];
    now += 500;
    await processDurableFollowDefenseFollow(payload);
    assert.deepEqual([...values], snapshot);
    assert.deepEqual(bans, []);
});

test('stale backlog and future follows do not touch cache, state or moderation', async () => {
    state('attack');
    for (const age of [60_000, 3600_000, -1]) await processDurableFollowDefenseFollow(follow('stale', age));
    assert.equal(cacheCalls, 0);
    assert.equal(sorted.size, 0);
    assert.deepEqual(bans, []);
});

test('delayed occurrences are not counted as a new burst at retry wallclock', async () => {
    for (let i = 0; i < 10; i++) await processDurableFollowDefenseFollow(follow(`delayed-${i}`, 30_000));
    assert.equal(values.has(keys.state), false);
    assert.deepEqual(bans, []);
});

test('delayed pre-wave follows cannot inherit the current attack or protection mode', async () => {
    for (const mode of ['attack', 'protection'] as const) {
        state(mode);
        await processDurableFollowDefenseFollow(follow(`before-${mode}`, 30_000));
    }
    assert.deepEqual(bans, []);
    assert.equal(sorted.has(keys.tracked), false);
});

test('cache and settings errors propagate without a completion receipt', async () => {
    failure = 'connect';
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /cache unavailable/);
    failure = '';
    values.delete(keys.settings);
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /settings lookup failed/);
    assert.equal(values.has(`${keys.completedPrefix}stable-event`), false);
});

test('external ban errors propagate, retry with the same identity, and dedupe successful effects', async () => {
    state('protection');
    const payload = follow();
    for (const status of [403, 429, 500, 400]) {
        banResult = async () => ({ error: true, status, message: 'dependency unavailable' });
        await assert.rejects(processDurableFollowDefenseFollow(payload), /Follow defense ban failed/);
        assert.equal(values.has(`${keys.completedPrefix}${payload.eventID}`), false);
    }
    banResult = async () => ({ error: false, message: 'Success' });
    await processDurableFollowDefenseFollow(payload);
    await processDurableFollowDefenseFollow(payload);
    assert.deepEqual(bans, Array(5).fill(payload.followerID));
    assert.equal(sorted.get(keys.recent)!.size, 1);
});

test('lost ban receipt recovers only the precise already-banned response as success', async () => {
    state('protection');
    failure = `write:${keys.banDataPrefix}stable-event`;
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /cache write failed/);
    banResult = async () => ({ error: true, status: 400, message: 'The user specified in the user_id field is already banned.' });
    await processDurableFollowDefenseFollow(follow());
    await processDurableFollowDefenseFollow(follow());
    assert.equal(bans.length, 2);
    assert.equal(JSON.parse(values.get(`${keys.banDataPrefix}stable-event`)!).banned, true);
});

test('partial attack wave retries unfinished bans even after the mode transition was saved', async () => {
    await processDurableFollowDefenseFollow(follow('first', 2000));
    banResult = async (user) => ({ error: user === 'second', status: 503, message: 'try again' });
    await assert.rejects(processDurableFollowDefenseFollow(follow('second')), /ban failed/);
    const attackState = JSON.parse(values.get(keys.state)!);
    assert.equal(attackState.mode, 'attack');
    assert.equal(attackState.triggerEventID, 'second');
    assert.equal(attackState.modeStartedAt, NOW - 1000);
    assert.equal(attackState.expiresAt, NOW + 59_000);
    now += 500;
    banResult = async () => ({ error: false, message: 'Success' });
    await processDurableFollowDefenseFollow(follow('second'));
    assert.deepEqual(bans, ['first', 'second', 'second']);
    assert.deepEqual(JSON.parse(values.get(keys.state)!), attackState);
});

test('attack retries and long-running waves never ban stale tracked followers', async () => {
    await processDurableFollowDefenseFollow(follow('first', 2000));
    const stale = follow('old-tracked', 3600_000);
    values.set(`${keys.followDataPrefix}${stale.eventID}`, JSON.stringify(stale));
    await cache.zAdd(keys.tracked, { score: NOW - 3600_000, value: stale.eventID });
    banResult = async () => { now += 60_000; return { error: false, message: 'Success' }; };
    await processDurableFollowDefenseFollow(follow('second'));
    assert.deepEqual(bans, ['first']);
    await processDurableFollowDefenseFollow(follow('second'));
    assert.deepEqual(bans, ['first']);
});

test('lost completion receipt does not repeat a successful ban', async () => {
    state('attack');
    failure = `write:${keys.completedPrefix}stable-event`;
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /cache write failed/);
    await processDurableFollowDefenseFollow(follow());
    assert.deepEqual(bans, ['stable-event']);
});

test('freshness is rechecked after slow ban-receipt reads', async () => {
    state('attack');
    slowRead = `${keys.banDataPrefix}stable-event`;
    await processDurableFollowDefenseFollow(follow());
    assert.deepEqual(bans, []);
});

test('an unrelated already-banned error is not treated as successful moderation', async () => {
    state('attack');
    banResult = async () => ({ error: true, status: 400, message: 'Cannot check whether user is already banned' });
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /ban failed/);
    assert.equal(values.has(`${keys.completedPrefix}stable-event`), false);
});

test('a live raid marker prevents automatic attack bans for a fresh burst', async () => {
    values.set(keys.raid, JSON.stringify({ createdAt: NOW - 1000, expiresAt: NOW + 299_000 }));
    await processDurableFollowDefenseFollow(follow('first', 2000));
    await processDurableFollowDefenseFollow(follow('second'));
    assert.equal(values.has(keys.state), false);
    assert.deepEqual(bans, []);
    assert.equal(sorted.get(keys.tracked)!.size, 2);
});

test('payload loss during a required ban is retried rather than silently completed', async (context) => {
    state('attack');
    const read = context.mock.method(cache, 'get', async (key: string) =>
        key === `${keys.followDataPrefix}stable-event` ? null : values.get(key) ?? null);
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /Missing required follow defense payload/);
    assert.equal(values.has(`${keys.completedPrefix}stable-event`), false);
    assert.deepEqual(bans, []);
    read.mock.restore();
    await processDurableFollowDefenseFollow(follow());
    assert.deepEqual(bans, ['stable-event']);
});

test('manual attack interleaved after threshold read cannot be downgraded or announce a losing transition', async (context) => {
    values.set(keys.settings, JSON.stringify({ attackModeEnabled: false, protectionThresholdB: 1 }));
    const original = cache.zRangeByScore;
    context.mock.method(cache, 'zRangeByScore', async (key: string, min: number, max: number) => {
        if (key === keys.recent) await triggerFollowDefenseAttackMode('channel');
        return original(key, min, max);
    });
    await processDurableFollowDefenseFollow(follow());
    assert.equal(JSON.parse(values.get(keys.state)!).triggeredBy, 'manual');
    assert.deepEqual(messages, []);
    assert.deepEqual(bans, []);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), JSON.parse(values.get(keys.state)!).expiresAt);
});

test('expiry of a stale index entry repairs the current live state index', async () => {
    state('attack');
    await cache.zAdd(keys.activeChannels, { value: 'channel', score: NOW - 1 });
    assert.equal(await expireFollowDefenseModes(), 0);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), NOW + 60_000);
});

test('expiry racing a manual command cannot delete the new state, tracked followers or index', async (context) => {
    state('silent');
    const expired = { ...JSON.parse(values.get(keys.state)!), expiresAt: NOW - 1 };
    values.set(keys.state, JSON.stringify(expired));
    await cache.zAdd(keys.activeChannels, { value: 'channel', score: NOW - 1 });
    const original = cache.get;
    context.mock.method(cache, 'get', async (key: string) => {
        if (key === keys.settings) {
            await triggerFollowDefenseAttackMode('channel');
            await cache.zAdd(keys.tracked, { value: 'new-follow', score: NOW });
        }
        return original(key);
    });
    assert.equal(await expireFollowDefenseModes(), 0);
    const current = JSON.parse(values.get(keys.state)!);
    assert.equal(current.triggeredBy, 'manual');
    assert.equal(current.expiresAt, NOW + 60_000);
    assert.equal(sorted.get(keys.tracked)?.has('new-follow'), true);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), current.expiresAt);
});

test('concurrent threshold contenders announce and start the attack wave only once', async () => {
    await Promise.all([
        processDurableFollowDefenseFollow(follow('first', 2000)),
        processDurableFollowDefenseFollow(follow('second'))
    ]);
    assert.equal(messages.length, 1);
    assert.deepEqual(bans.slice().sort(), ['first', 'second']);
});

test('trigger-event repair cannot rewrite a manual command committed after the retry snapshot', async (context) => {
    await processDurableFollowDefenseFollow(follow('first', 2000));
    banResult = async () => ({ error: true, status: 503, message: 'try again' });
    await assert.rejects(processDurableFollowDefenseFollow(follow('second')), /ban failed/);
    sorted.delete(keys.activeChannels);
    const original = cache.eval;
    let injected = false;
    context.mock.method(cache, 'eval', async (script: string, options: { keys: string[]; arguments: string[] }) => {
        const snapshot = await original(script, options);
        if (!injected && options.arguments[1] === 'repair') {
            injected = true;
            await triggerFollowDefenseAttackMode('channel');
        }
        return snapshot;
    });
    banResult = async () => ({ error: false, message: 'Success' });
    await processDurableFollowDefenseFollow(follow('second'));
    const current = JSON.parse(values.get(keys.state)!);
    assert.equal(current.triggeredBy, 'manual');
    assert.equal(current.triggerEventID, undefined);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), current.expiresAt);
    assert.equal(messages.length, 1);
});

test('required projection failure leaves no receipt and no partial state write', async () => {
    values.set(keys.activeChannels, 'wrong-type');
    await assert.rejects(processDurableFollowDefenseFollow(follow()), /WRONGTYPE/);
    assert.equal(values.has(`${keys.completedPrefix}stable-event`), false);
    assert.equal(values.has(keys.state), false);
    assert.deepEqual(bans, []);
});

test('queued manual completion applies configured duration through the atomic projection', async () => {
    values.set(keys.settings, JSON.stringify({ silentDurationSeconds: 120 }));
    await triggerFollowDefenseAttackMode('channel');
    assert.equal(await processFollowDefenseQueue(), 1);
    const current = JSON.parse(values.get(keys.state)!);
    assert.equal(current.triggeredBy, 'manual');
    assert.equal(current.expiresAt, NOW + 120_000);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), current.expiresAt);
    assert.equal(messages.length, 1);
});

test('superseded queued manual command does not announce or start a wave', async () => {
    await triggerFollowDefenseAttackMode('channel');
    now += 1000;
    await triggerFollowDefenseAttackMode('channel');
    assert.equal(await processFollowDefenseQueue(), 2);
    assert.equal(messages.length, 1);
    assert.equal(JSON.parse(values.get(keys.state)!).modeStartedAt, NOW + 1000);
});

test('same-millisecond manual commands use the last atomic writer, not random ID ordering', async (context) => {
    const random = context.mock.method(Math, 'random', () => 0.9);
    await triggerFollowDefenseAttackMode('channel', 'first', 'First');
    random.mock.restore();
    context.mock.method(Math, 'random', () => 0.1);
    await triggerFollowDefenseAttackMode('channel', 'second', 'Second');
    assert.equal(JSON.parse(values.get(keys.state)!).channelName, 'Second');
    assert.equal(await processFollowDefenseQueue(), 2);
    assert.equal(JSON.parse(values.get(keys.state)!).channelName, 'Second');
    assert.equal(messages.length, 1);
});

test('expiry errors retain state and index for the next tick instead of stranding the expired mode', async () => {
    state('attack');
    const expired = { ...JSON.parse(values.get(keys.state)!), expiresAt: NOW - 1 };
    values.set(keys.state, JSON.stringify(expired));
    await cache.zAdd(keys.activeChannels, { value: 'channel', score: NOW - 1 });
    failure = keys.settings;
    assert.equal(await expireFollowDefenseModes(), 0);
    assert.equal(values.get(keys.state), JSON.stringify(expired));
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), NOW - 1);
    failure = '';
    assert.equal(await expireFollowDefenseModes(), 1);
    assert.equal(values.has(keys.state), false);
    assert.equal(sorted.get(keys.activeChannels)?.has('channel'), false);
});
