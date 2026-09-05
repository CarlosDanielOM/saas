import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { FollowDefenseFollowPayload, FollowDefenseState } from './follow_defense_queue.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
let now = NOW;
let values: Map<string, string>;
let sorted: Map<string, Map<string, number>>;
let bans: string[];
let cacheCalls = 0;
let failure = '';
let slowRead = '';
let banResult: (user: string) => Promise<{ error: boolean; status?: number; message: string }>;
const cache = {
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
        return [...(sorted.get(key) || [])].filter(([, score]) => score >= min && score <= max).map(([id]) => id);
    },
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
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => ({ error: false }) } });
mock.module('../schemas/follow_defense_settings.schema.js', { namedExports: {
    FollowDefenseSettingsSchema: { findOne: () => ({ lean: async () => { throw new Error('settings lookup failed'); } }) }
} });
mock.module('../schemas/follow_attack_log.schema.js', { namedExports: { FollowAttackLogSchema: {} } });
mock.module('../schemas/follow_hate_raid_source.schema.js', { namedExports: { FollowHateRaidSourceSchema: {} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => null } });
mock.module('./ai/openrouter/ai.js', { namedExports: { chat: async () => assert.fail('No AI calls') } });
mock.module('./logger.js', { namedExports: { info: async () => undefined, warn: async () => undefined, error: async () => undefined } });
process.env.FOLLOW_DEFENSE_BAN_DELAY_MS = '0';
const { processDurableFollowDefenseFollow } = await import('./follow_defense.js');
const { followDefenseKeys } = await import('./follow_defense_queue.js');
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
    now = NOW; values = new Map(); sorted = new Map(); bans = []; cacheCalls = 0; failure = ''; slowRead = '';
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
