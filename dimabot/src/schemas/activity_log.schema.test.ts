import assert from 'node:assert/strict';
import test from 'node:test';
import { activityProblemFilter, isActivityProblem } from './activity_log.schema.js';

test('a problem is a failure or a refusal that is not a setting; skips never are', () => {
    assert.equal(isActivityProblem('failed', 'error'), true);
    assert.equal(isActivityProblem('blocked', 'held_for_moderation'), true);
    assert.equal(isActivityProblem('blocked', 'permission_invalid'), true);
    assert.equal(isActivityProblem('blocked', 'permission_denied'), false, 'a viewer without the role: the setting at work');
    for (const reason of ['disabled', 'cooldown', 'empty_message', 'alert_disabled', 'chat_disabled', 'usage']) {
        assert.equal(isActivityProblem('skipped', reason), false, reason);
    }
    assert.equal(isActivityProblem('ok', ''), false);
});

test('the Mongo filters name the partial index exactly so problems_at applies', () => {
    assert.deepEqual(activityProblemFilter(), {
        outcome: { $in: ['skipped', 'blocked', 'failed'], $ne: 'skipped' },
        $nor: [{ outcome: 'blocked', reason: { $in: ['permission_denied'] } }]
    });
    assert.deepEqual(activityProblemFilter(true), { outcome: { $in: ['skipped', 'blocked', 'failed'], $eq: 'failed' } });
});
