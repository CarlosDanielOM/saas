import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { FollowDefenseRaidMarker, FollowDefenseState } from './follow_defense_queue.js';
import { runFollowDefenseStateLua } from './follow_defense_state.test-helper.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
let stored: FollowDefenseRaidMarker | undefined;
let calls: Array<{ script: string; keys: string[]; arguments: string[] }>;
let fail = false;
let failEval = false;
let cacheCalls = 0;
let now = NOW;
let values: Map<string, string>;
let sorted: Map<string, Map<string, number>>;
mock.module('./databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => {
        cacheCalls++;
        if (fail) throw new Error('cache unavailable');
        return {
            async eval(script: string, options: { keys: string[]; arguments: string[] }) {
                if (failEval) throw new Error('marker write failed');
                calls.push({ script, ...options });
                if (options.keys.length === 3) return runFollowDefenseStateLua(script, options, values, sorted, now);
                const incoming = JSON.parse(options.arguments[0]) as FollowDefenseRaidMarker;
                if (stored && (stored.createdAt > incoming.createdAt
                    || (stored.createdAt === incoming.createdAt && (stored.eventID || '') >= incoming.eventID!))) return 0;
                stored = incoming;
                return 1;
            },
            async set(key: string, value: string) { values.set(key, value); },
            async zAdd(key: string, item: { score: number; value: string }) {
                if (!sorted.has(key)) sorted.set(key, new Map());
                sorted.get(key)!.set(item.value, item.score);
            }
        };
    }
} });
mock.module('./logger.js', { namedExports: { error: async () => undefined } });
const { applyDurableFollowDefenseRaidMarker, projectFollowDefenseState, triggerFollowDefenseAttackMode, followDefenseKeys } = await import('./follow_defense_queue.js');
const keys = followDefenseKeys('channel');

function marker(eventID = 'raid', createdAt = NOW - 1000): FollowDefenseRaidMarker {
    return {
        eventID, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        raiderChannelID: 'raider', raiderChannelLogin: 'raider', raiderChannelName: 'Raider',
        raidViewers: 10, createdAt, expiresAt: createdAt + 300_000
    };
}

beforeEach((context) => {
    stored = undefined; calls = []; fail = false; failEval = false; cacheCalls = 0;
    now = NOW; values = new Map(); sorted = new Map();
    assert.ok('mock' in context);
    context.mock.method(Date, 'now', () => now);
});

test('marker uses one atomic compare/write with absolute expiry and stable event identity', async () => {
    const input = marker();
    await applyDurableFollowDefenseRaidMarker(input);
    await applyDurableFollowDefenseRaidMarker(input);
    assert.deepEqual(stored, input);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0].keys, ['twitch:channel:follow-defense:raid']);
    assert.deepEqual(calls[0].arguments, [JSON.stringify(input), String(input.createdAt), String(input.expiresAt), 'raid']);
    assert.match(calls[0].script, /redis.call\('TIME'\)/);
    assert.match(calls[0].script, /if tonumber\(ARGV\[3\]\) <= now then return 0 end/);
    assert.match(calls[0].script, /previous.createdAt > tonumber\(ARGV\[2\]\)/);
    assert.match(calls[0].script, /previous.eventID or ''/);
    assert.match(calls[0].script, /'PXAT', ARGV\[3\]/);
});

test('older replay cannot overwrite a newer raid and equal timestamps have a stable tie break', async () => {
    await applyDurableFollowDefenseRaidMarker(marker('z', NOW));
    await applyDurableFollowDefenseRaidMarker(marker('older', NOW - 1000));
    await applyDurableFollowDefenseRaidMarker(marker('a', NOW));
    assert.equal(stored?.eventID, 'z');
});

test('expired marker replay never recreates protection and required cache errors propagate', async () => {
    await applyDurableFollowDefenseRaidMarker(marker('expired', NOW - 300_000));
    assert.equal(cacheCalls, 0);
    fail = true;
    await assert.rejects(applyDurableFollowDefenseRaidMarker(marker()), /cache unavailable/);
    fail = false; failEval = true;
    await assert.rejects(applyDurableFollowDefenseRaidMarker(marker()), /marker write failed/);
    assert.equal(stored, undefined);
});

function state(mode: FollowDefenseState['mode'] = 'protection'): FollowDefenseState {
    return {
        mode, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        modeStartedAt: NOW - 1000, burstStartedAt: NOW - 2000, expiresAt: NOW + 59_000,
        triggeredBy: 'threshold', lastTransitionReason: 'test', lastUpdatedAt: NOW,
        triggerEventID: 'follow'
    };
}

test('Lua serializes both orderings of manual attack versus a lower threshold transition', async () => {
    for (const manualFirst of [true, false]) {
        values.clear(); sorted.clear();
        if (manualFirst) await triggerFollowDefenseAttackMode('channel');
        const transition = await projectFollowDefenseState('channel', { type: 'transition', state: state() });
        assert.equal(transition.changed, !manualFirst);
        if (!manualFirst) await triggerFollowDefenseAttackMode('channel');
        const current = await projectFollowDefenseState('channel');
        assert.equal(current.state?.mode, 'attack');
        assert.equal(current.state?.triggeredBy, 'manual');
        assert.equal(current.state?.triggerEventID, undefined);
        assert.ok(current.state?.version);
        assert.equal(sorted.get(keys.activeChannels)?.get('channel'), current.state?.expiresAt);
    }
});

test('Lua has exactly one threshold winner, keeps current burst metadata and repairs a lost index without rewriting state', async () => {
    const initial = state('silent');
    values.set(keys.state, JSON.stringify(initial, null, 2));
    const first = await projectFollowDefenseState('channel', { type: 'transition', state: { ...state('attack'), burstStartedAt: NOW } });
    const second = await projectFollowDefenseState('channel', { type: 'transition', state: state('attack') });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.state?.burstStartedAt, initial.burstStartedAt);
    assert.equal(second.state?.triggerEventID, 'follow');
    assert.equal(second.token, first.token);
    sorted.delete(keys.activeChannels);
    assert.deepEqual(await projectFollowDefenseState('channel'), { ...second, changed: false });
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), first.state?.expiresAt);
});

test('Lua uses current expiry and its own clock, not a stale application read', async () => {
    values.set(keys.state, JSON.stringify({ ...state('attack'), expiresAt: NOW - 1 }));
    assert.equal((await projectFollowDefenseState('channel', { type: 'transition', state: state('silent') })).changed, true);
    const snapshot = values.get(keys.state);
    now += 60_000;
    assert.equal((await projectFollowDefenseState('channel', { type: 'transition', state: state('attack') })).changed, false);
    assert.equal(values.get(keys.state), snapshot);
    now = NOW;
    assert.equal((await projectFollowDefenseState('channel', {
        type: 'transition', state: state('attack'), moderationExpiresAt: NOW
    })).changed, false);
});

test('reset compares exact legacy bytes and version before deleting state, tracked follows and index', async () => {
    const expired = { ...state(), expiresAt: NOW - 1 };
    const raw = JSON.stringify(expired, null, 2);
    values.set(keys.state, raw);
    sorted.set(keys.tracked, new Map([['old', NOW - 1000]]));
    const snapshot = await projectFollowDefenseState('channel');
    assert.equal(snapshot.token, raw);
    assert.equal((await projectFollowDefenseState('channel', { type: 'reset', token: JSON.stringify(expired) })).changed, false);
    await triggerFollowDefenseAttackMode('channel');
    sorted.get(keys.tracked)!.set('new', NOW);
    const manual = values.get(keys.state);
    assert.equal((await projectFollowDefenseState('channel', { type: 'reset', token: snapshot.token })).changed, false);
    assert.equal(values.get(keys.state), manual);
    assert.equal(sorted.get(keys.tracked)?.has('new'), true);
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), NOW + 60_000);
    const current = await projectFollowDefenseState('channel');
    assert.equal((await projectFollowDefenseState('channel', { type: 'reset', token: current.token })).changed, false);
    now += 60_000;
    assert.equal((await projectFollowDefenseState('channel', { type: 'reset', token: snapshot.token })).changed, false);
    assert.equal(values.get(keys.state), manual);
    assert.equal((await projectFollowDefenseState('channel', { type: 'reset', token: current.token })).changed, true);
    assert.equal(values.has(keys.state), false);
    assert.equal(sorted.has(keys.tracked), false);
    assert.equal(sorted.get(keys.activeChannels)?.has('channel'), false);
});

test('repair and stale reset project the current winner, and remove only dangling index entries', async () => {
    sorted.set(keys.activeChannels, new Map([['channel', NOW - 1], ['other', NOW + 1]]));
    assert.equal((await projectFollowDefenseState('channel')).state, null);
    assert.deepEqual([...sorted.get(keys.activeChannels)!], [['other', NOW + 1]]);
    const old = await projectFollowDefenseState('channel', { type: 'transition', state: state() });
    await triggerFollowDefenseAttackMode('channel');
    const manual = values.get(keys.state);
    sorted.get(keys.activeChannels)!.set('channel', NOW - 1);
    const repaired = await projectFollowDefenseState('channel', { type: 'reset', token: old.token });
    assert.equal(repaired.token, manual);
    assert.equal(repaired.state?.triggeredBy, 'manual');
    assert.equal(sorted.get(keys.activeChannels)?.get('channel'), repaired.state?.expiresAt);
});

test('manual override preserves live expiry and names, renews expired state, and fences older queued commands', async () => {
    values.set(keys.state, JSON.stringify(state('attack')));
    await triggerFollowDefenseAttackMode('channel');
    const immediate = (await projectFollowDefenseState('channel')).state!;
    assert.equal(immediate.expiresAt, NOW + 59_000);
    assert.equal(immediate.channelName, 'Channel');
    assert.equal(immediate.burstStartedAt, NOW - 2000);
    const configured = await projectFollowDefenseState('channel', { type: 'manual', state: { ...immediate, expiresAt: NOW + 120_000 } });
    assert.equal(configured.changed, true);
    assert.notEqual(configured.state?.version, immediate.version);
    now += 1000;
    await triggerFollowDefenseAttackMode('channel', 'new', 'New');
    const newest = values.get(keys.state);
    assert.equal((await projectFollowDefenseState('channel', { type: 'manual', state: immediate })).changed, false);
    assert.equal(values.get(keys.state), newest);
    now += 120_000;
    await triggerFollowDefenseAttackMode('channel');
    const renewed = (await projectFollowDefenseState('channel')).state!;
    assert.equal(renewed.expiresAt, now + 60_000);
    assert.equal(renewed.burstStartedAt, now);
});

test('wrong key types fail before any projection mutation and required errors propagate', async () => {
    for (const wrongKey of [keys.state, keys.activeChannels, keys.tracked]) {
        values.clear(); sorted.clear();
        if (wrongKey === keys.state) sorted.set(wrongKey, new Map([['bad', 1]]));
        else values.set(wrongKey, 'wrong-type');
        const before = [...values];
        const beforeSorted = [...sorted].map(([key, entries]) => [key, [...entries]]);
        await assert.rejects(projectFollowDefenseState('channel', { type: 'transition', state: state() }), /WRONGTYPE/);
        assert.deepEqual([...values], before);
        assert.deepEqual([...sorted].map(([key, entries]) => [key, [...entries]]), beforeSorted);
    }
    failEval = true;
    await assert.rejects(triggerFollowDefenseAttackMode('channel'), /marker write failed/);
    failEval = false; fail = true;
    await assert.rejects(projectFollowDefenseState('channel'), /cache unavailable/);
});
