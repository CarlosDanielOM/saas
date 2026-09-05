import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { FollowDefenseRaidMarker } from './follow_defense_queue.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
let stored: FollowDefenseRaidMarker | undefined;
let calls: Array<{ script: string; keys: string[]; arguments: string[] }>;
let fail = false;
let failEval = false;
let cacheCalls = 0;
mock.module('./databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => {
        cacheCalls++;
        if (fail) throw new Error('cache unavailable');
        return {
            async eval(script: string, options: { keys: string[]; arguments: string[] }) {
                if (failEval) throw new Error('marker write failed');
                calls.push({ script, ...options });
                const incoming = JSON.parse(options.arguments[0]) as FollowDefenseRaidMarker;
                if (stored && (stored.createdAt > incoming.createdAt
                    || (stored.createdAt === incoming.createdAt && (stored.eventID || '') >= incoming.eventID!))) return 0;
                stored = incoming;
                return 1;
            }
        };
    }
} });
mock.module('./logger.js', { namedExports: { error: async () => undefined } });
const { applyDurableFollowDefenseRaidMarker } = await import('./follow_defense_queue.js');

function marker(eventID = 'raid', createdAt = NOW - 1000): FollowDefenseRaidMarker {
    return {
        eventID, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        raiderChannelID: 'raider', raiderChannelLogin: 'raider', raiderChannelName: 'Raider',
        raidViewers: 10, createdAt, expiresAt: createdAt + 300_000
    };
}

beforeEach((context) => {
    stored = undefined; calls = []; fail = false; failEval = false; cacheCalls = 0;
    assert.ok('mock' in context);
    context.mock.method(Date, 'now', () => NOW);
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
