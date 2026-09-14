import assert from 'node:assert/strict';
import test from 'node:test';
import { defenseActionID, defenseActionOutcome, adaptiveDefensePacing, DEFENSE_ACTION_HORIZON_MS } from './follow_defense_actions.js';

test('identities are stable and separate channels, events and effect kinds', () => {
    assert.equal(defenseActionID('a', 'event'), defenseActionID('a', 'event'));
    assert.equal(new Set([defenseActionID('a', 'event'), defenseActionID('b', 'event'),
        defenseActionID('a', 'other'), defenseActionID('a', 'event', 'announcement')]).size, 4);
});
test('429 respects reset and Retry-After without exhausting the failure budget', () => {
    const result = defenseActionOutcome({ error: true, status: 429, message: 'Rate limited', rateLimitResetAt: 100000, retryAfterMs: 150000 }, 7, 1000);
    assert.equal(result.status, 'pending');
    assert.equal(result.failures, 7);
    assert.equal(result.globalPause, 152000);
    assert.ok(result.retryAt >= result.globalPause);
});
test('success and precise already-banned responses complete, other client errors fail', () => {
    assert.equal(defenseActionOutcome({ error: false, message: 'Success' }, 0, 0).status, 'succeeded');
    assert.equal(defenseActionOutcome({ error: true, status: 400, message: 'The user specified in the user_id field is already banned.' }, 0, 0).status, 'succeeded');
    assert.equal(defenseActionOutcome({ error: true, status: 400, message: 'user is already banned' }, 0, 0).status, 'succeeded');
    assert.equal(defenseActionOutcome({ error: true, status: 400, message: 'Unable to tell if already banned' }, 0, 0).status, 'failed');
});

test('pacing starts at five, ramps to ten with healthy headers, and stays under the cap', () => {
    const result = { error: false, message: 'OK', rateLimitRemaining: 800, rateLimitResetAt: 60000 };
    let pacing = adaptiveDefensePacing({}, result, 0, 'global');
    assert.equal(pacing.ratePerSecond, 5);
    assert.equal(pacing.intervalMs, 200);
    for (let i = 0; i < 250; i++) pacing = adaptiveDefensePacing(pacing, result, 0, 'global');
    assert.equal(pacing.ratePerSecond, 10);
    assert.equal(pacing.intervalMs, 100);
    assert.equal(DEFENSE_ACTION_HORIZON_MS, 3600000);
});

test('remaining budget constrains speed and absent headers never increase it', () => {
    const limited = adaptiveDefensePacing({ ratePerSecond: 10 }, {
        error: false, message: 'OK', rateLimitRemaining: 40, rateLimitResetAt: 60000
    }, 0, 'global');
    assert.equal(limited.intervalMs, 3000);
    assert.equal(adaptiveDefensePacing({ ratePerSecond: 10 }, { error: false, message: 'OK' }, 0, 'global').ratePerSecond, 5);
    assert.equal(adaptiveDefensePacing({ ratePerSecond: 2 }, { error: false, message: 'OK' }, 0, 'global').ratePerSecond, 2);
});

test('endpoint throttling slows and pauses its channel without blocking a healthy shared bucket', () => {
    const limited = { error: true, status: 429, message: 'Too many bans', rateLimitRemaining: 700, rateLimitResetAt: 60000 };
    assert.equal(adaptiveDefensePacing({ ratePerSecond: 10 }, limited, 0, 'channel').ratePerSecond, 5);
    assert.equal(adaptiveDefensePacing({ ratePerSecond: 10 }, limited, 0, 'global').ratePerSecond, 10);
    assert.equal(defenseActionOutcome(limited, 0, 0).globalPause, 0);
    assert.equal(defenseActionOutcome(limited, 0, 0).channelPause, 61000);
    const globalLimit = { ...limited, rateLimitRemaining: 0 };
    assert.equal(adaptiveDefensePacing({ ratePerSecond: 10 }, globalLimit, 0, 'global').ratePerSecond, 5);
    assert.equal(defenseActionOutcome(globalLimit, 0, 0).globalPause, 61000);
});
test('low shared token budget pauses even after a successful ban', () => {
    const outcome = defenseActionOutcome({ error: false, message: 'OK', rateLimitRemaining: 0, rateLimitResetAt: 50000 }, 0, 1000);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.globalPause, 51000);
});
test('permission failures pause the channel, server errors back off and eventually fail', () => {
    const permission = defenseActionOutcome({ error: true, status: 403, message: 'Not a moderator' }, 0, 1000);
    assert.equal(permission.channelPause, 61000);
    assert.equal(permission.globalPause, 0);
    const server = { error: true, status: 503, message: 'Unavailable' };
    assert.equal(defenseActionOutcome(server, 0, 0).retryAt, 2000);
    assert.equal(defenseActionOutcome(server, 7, 0).status, 'failed');
});
