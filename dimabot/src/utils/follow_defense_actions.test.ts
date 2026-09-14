import assert from 'node:assert/strict';
import test from 'node:test';
import { defenseActionID, defenseActionOutcome } from './follow_defense_actions.js';

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
    assert.equal(defenseActionOutcome({ error: true, status: 400, message: 'Unable to tell if already banned' }, 0, 0).status, 'failed');
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
