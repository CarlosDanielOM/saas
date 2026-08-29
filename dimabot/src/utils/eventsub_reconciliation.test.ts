import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExpectedEventsubCondition } from './eventsub_condition.js';

test('builds channel-specific EventSub conditions without replacing bot identities', () => {
    const chat = { type: 'channel.chat.message', condition: { broadcaster_user_id: 'template', user_id: '698614112' } };
    const follow = { type: 'channel.follow', condition: { broadcaster_user_id: 'template', moderator_user_id: '698614112' } };
    const raid = { type: 'channel.raid', condition: { to_broadcaster_user_id: 'template' } };
    const userUpdate = { type: 'user.update', condition: { user_id: 'template' } };

    assert.deepEqual(buildExpectedEventsubCondition(chat, 'channel-1'), {
        broadcaster_user_id: 'channel-1',
        user_id: '698614112'
    });
    assert.deepEqual(buildExpectedEventsubCondition(follow, 'channel-1'), {
        broadcaster_user_id: 'channel-1',
        moderator_user_id: '698614112'
    });
    assert.deepEqual(buildExpectedEventsubCondition(raid, 'channel-1'), {
        to_broadcaster_user_id: 'channel-1'
    });
    assert.deepEqual(buildExpectedEventsubCondition(userUpdate, 'channel-1'), {
        user_id: 'channel-1'
    });
});
