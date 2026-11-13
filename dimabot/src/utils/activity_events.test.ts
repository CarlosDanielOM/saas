import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityRow, pendingActivityRowsForTests, setActivityLogSinkForTests } from './activity_log.js';
import {
    alertActivity, chatSendDecision, deliveryOutcome, eventChannelID, handlerErrorActivity, recordAlert, recordHandlerError, recordRedemption,
    recordRevocation, recordTwitchEvent, redemptionActivity, revocationActivity, twitchEventActivity,
    type AlertSkipReason
} from './activity_events.js';

beforeEach(() => setActivityLogSinkForTests(async () => undefined));

const viewer = { user_id: '42', user_login: 'Viewer', user_name: 'Viewer' };

test('each unjournaled Twitch type keeps its plain facts, keyed by the message id', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string | null, string | null]> = [
        ['channel.update', { broadcaster_user_id: 'c1', title: 'New title', category_name: 'Chess', category_id: '1' },
            { title: 'New title', category: 'Chess' }, null, null],
        ['channel.ban', { broadcaster_user_id: 'c1', ...viewer, moderator_user_login: 'mod', reason: 'spam', is_permanent: true },
            { moderator: 'mod', reason: 'spam', permanent: true }, '42', null],
        ['channel.shoutout.receive', { broadcaster_user_id: 'c1', from_broadcaster_user_id: '7', from_broadcaster_user_login: 'friend',
            from_broadcaster_user_name: 'Friend', viewer_count: 31 }, { from: 'friend', viewers: 31 }, '7', null],
        ['automod.message.hold', { broadcaster_user_id: 'c1', ...viewer, category: 'swearing', level: 3, message: { text: 'held words' } },
            { category: 'swearing', level: 3 }, '42', 'held words'],
        ['automod.message.hold', { broadcaster_user_id: 'c1', ...viewer, automod: { category: 'aggression', level: 2 }, message: { text: 'v2' } },
            { category: 'aggression', level: 2 }, '42', 'v2'],
        ['channel.chat.clear', { broadcaster_user_id: 'c1' }, {}, null, null],
        ['channel.chat.clear_user_messages', { broadcaster_user_id: 'c1', target_user_id: '9', target_user_login: 'gone' }, {}, '9', null],
        ['channel.chat.message_delete', { broadcaster_user_id: 'c1', target_user_id: '9', target_user_login: 'gone', message_id: 'm-9' },
            { messageId: 'm-9' }, '9', null],
        ['user.update', { user_id: 'c1', user_login: 'streamer', user_name: 'Streamer', email: 'secret@example.com', description: 'bio' },
            {}, 'c1', null]
    ];
    for (const [type, event, data, actorID, text] of cases) {
        const input = twitchEventActivity(type, 'msg-1', event)!;
        assert.ok(input, type);
        const row = buildActivityRow(input)!;
        assert.equal(row.kind, 'twitch_event');
        assert.equal(row.name, type);
        assert.equal(row.channelID, 'c1', type);
        assert.equal(row.outcome, 'ok');
        assert.equal(row.ref, 'msg-1');
        assert.deepEqual(row.data, data, type);
        assert.equal(row.actorID, actorID || '', type);
        assert.equal(row.text, text || '', type);
        assert.doesNotMatch(JSON.stringify(row), /secret@example\.com/);
    }
});

test('chat messages, journaled types, redemptions and unknown types write nothing at ingress', () => {
    for (const type of ['channel.chat.message', 'channel.follow', 'channel.subscribe', 'stream.online', 'channel.poll.progress',
        'channel.channel_points_custom_reward_redemption.add', 'something.new']) {
        assert.equal(twitchEventActivity(type, 'msg-1', { broadcaster_user_id: 'c1' }), null, type);
        recordTwitchEvent(type, 'msg-1', { broadcaster_user_id: 'c1' });
    }
    assert.equal(pendingActivityRowsForTests().length, 0);
});

test('a retried delivery of the same message writes one row id', () => {
    const first = buildActivityRow(twitchEventActivity('channel.update', 'msg-1', { broadcaster_user_id: 'c1', title: 'a' })!)!;
    const retry = buildActivityRow(twitchEventActivity('channel.update', 'msg-1', { broadcaster_user_id: 'c1', title: 'a' })!)!;
    const other = buildActivityRow(twitchEventActivity('channel.update', 'msg-2', { broadcaster_user_id: 'c1', title: 'a' })!)!;
    assert.equal(first._id, retry._id);
    assert.notEqual(first._id, other._id);
});

test('the channel comes from the broadcaster, the raid direction or the user.update user', () => {
    assert.equal(eventChannelID('channel.raid', { from_broadcaster_user_id: 'a', to_broadcaster_user_id: 'b' }, { from_broadcaster_user_id: 'a' }), 'a');
    assert.equal(eventChannelID('channel.raid', { from_broadcaster_user_id: 'a', to_broadcaster_user_id: 'b' }, { to_broadcaster_user_id: 'b' }), 'b');
    assert.equal(eventChannelID('user.update', { user_id: 'u' }), 'u');
    assert.equal(eventChannelID('channel.update', null), '');
});

test('handler crashes are failed rows with a clipped error and the event key as ref', () => {
    const row = buildActivityRow(handlerErrorActivity('channel.follow', 'c1', 'twitch-eventsub:abc:channel.follow.received', new Error('x'.repeat(500))))!;
    assert.equal(row.kind, 'twitch_event');
    assert.equal(row.outcome, 'failed');
    assert.equal(row.reason, 'handler_error');
    assert.equal(row.ref, 'twitch-eventsub:abc:channel.follow.received');
    assert.equal(String(row.data.error).length, 200);
    recordHandlerError('channel.update', 'c1', 'msg-1', 'plain string');
    assert.equal(pendingActivityRowsForTests()[0]!.data.error, 'plain string');
});

test('redemptions say whether Dima manages the reward and what it did', () => {
    const event = { id: 'red-1', broadcaster_user_id: 'c1', ...viewer, user_input: 'play this', status: 'unfulfilled',
        reward: { id: 'rw-1', title: 'Hydrate', cost: 500, prompt: 'p' } };
    const unmanaged = buildActivityRow(redemptionActivity(event, 'msg-1', { outcome: 'ok', managed: false, action: 'none', chatEnabled: true }))!;
    assert.equal(unmanaged.outcome, 'ok');
    assert.equal(unmanaged.name, 'channel.channel_points_custom_reward_redemption.add');
    assert.equal(unmanaged.ref, 'msg-1');
    // Dima does nothing with this reward, so the viewer's text is not kept.
    assert.equal(unmanaged.text, '');
    assert.equal(unmanaged.actorLogin, 'viewer');
    assert.deepEqual(unmanaged.data, { rewardTitle: 'Hydrate', rewardCost: 500, rewardId: 'rw-1', status: 'unfulfilled',
        redemptionId: 'red-1', managed: false, action: 'none', chatEnabled: true });

    const trigger = buildActivityRow(redemptionActivity(event, 'msg-1', { outcome: 'ok', managed: true, action: 'trigger', trigger: 'Confetti' }))!;
    assert.equal(trigger.text, 'play this');
    assert.equal(trigger.data.action, 'trigger');
    assert.equal(trigger.data.trigger, 'Confetti');

    const failed = buildActivityRow(redemptionActivity(event, undefined, { outcome: 'failed', reason: 'vip_failed', managed: true, action: 'vip', error: 'Error adding VIP' }))!;
    assert.equal(failed.reason, 'vip_failed');
    assert.equal(failed.data.error, 'Error adding VIP');
    // Without a message id (manual event tests) the redemption id still keys the row.
    assert.equal(failed.ref, 'red-1');
    assert.equal(failed._id, buildActivityRow(redemptionActivity(event, undefined, { outcome: 'ok', managed: true, action: 'none' }))!._id);

    recordRedemption(null, undefined, { outcome: 'ok', managed: false, action: 'none' });
    assert.equal(pendingActivityRowsForTests().length, 1);
});

test('every alert decision maps to its row, with dedupe keys per event', () => {
    const source = { type: 'channel.follow', channelID: 'c1', payload: viewer, ref: 'key-1' };
    const sent = buildActivityRow(alertActivity(source, { outcome: 'ok' }))!;
    assert.equal(sent.kind, 'alert');
    assert.equal(sent.name, 'channel.follow');
    assert.equal(sent.outcome, 'ok');
    // The alert row never carries the template; the sent line is on the bot_message row.
    assert.equal(sent.text, '');
    assert.equal(sent.actorID, '42');
    assert.equal(sent.ref, 'key-1');

    const reasons: AlertSkipReason[] = ['chat_disabled', 'alert_disabled', 'follow_defense', 'empty_message', 'stale'];
    for (const reason of reasons) {
        const row = buildActivityRow(alertActivity(source, { outcome: 'skipped', reason }))!;
        assert.equal(row.outcome, 'skipped');
        assert.equal(row.reason, reason);
        assert.equal(row.text, '');
        // Same event, same row: a replay of a skipped alert is not counted twice.
        assert.equal(row._id, sent._id);
    }

    const failed = buildActivityRow(alertActivity(source, { outcome: 'failed', reason: 'send_failed', error: 'Twitch said no' }))!;
    assert.equal(failed.reason, 'send_failed');
    assert.equal(failed.data.error, 'Twitch said no');
    // A failed attempt keeps its own row so the retry that succeeds still records "ok".
    assert.notEqual(failed._id, sent._id);

    const anonymous = buildActivityRow(alertActivity({ type: 'channel.bits.use', channelID: 'c1', payload: { ...viewer, is_anonymous: true } },
        { outcome: 'ok' }))!;
    assert.equal(anonymous.actorID, '');
    // Without a ref (manual event tests) each call is its own row.
    assert.notEqual(anonymous._id, buildActivityRow(alertActivity({ type: 'channel.bits.use', channelID: 'c1', payload: {} }, { outcome: 'ok' }))!._id);

    recordAlert({ type: 'stream.online', channelID: 'c1', payload: { user_id: 'x' }, ref: 'k' }, { outcome: 'ok' });
    assert.equal(pendingActivityRowsForTests()[0]!.actorID, '');
});

test('revocations keep Twitch status, type and subscription id', () => {
    const row = buildActivityRow(revocationActivity({ id: 'sub-1', type: 'channel.follow', version: '2', status: 'authorization_revoked',
        condition: { broadcaster_user_id: 'c1', moderator_user_id: 'bot' } }))!;
    assert.equal(row.kind, 'system');
    assert.equal(row.name, 'eventsub.revoked');
    assert.equal(row.channelID, 'c1');
    assert.equal(row.outcome, 'failed');
    assert.equal(row.reason, 'authorization_revoked');
    assert.deepEqual(row.data, { type: 'channel.follow', subscriptionId: 'sub-1', version: '2' });
    assert.equal(buildActivityRow(revocationActivity({ id: 's', condition: { to_broadcaster_user_id: 'c2' } }), Date.now())!.channelID, 'c2');
    assert.equal(buildActivityRow(revocationActivity({ id: 's', condition: { broadcaster_user_id: 'c2' } }, 'stored'))!.channelID, 'stored');
    recordRevocation(undefined);
    assert.equal(pendingActivityRowsForTests()[0]!.reason, 'revoked');
});

test('a send is ok only with Twitch\'s sent message; empty renders, holds and refusals say so', () => {
    assert.deepEqual(chatSendDecision({ error: false, type: 'success', data: { is_sent: true, message_id: 'tw' } }), { outcome: 'ok' });
    assert.deepEqual(chatSendDecision({ error: false, type: 'success', data: undefined }), { outcome: 'skipped', reason: 'empty_message' });
    assert.deepEqual(chatSendDecision(undefined), { outcome: 'skipped', reason: 'empty_message' });
    // A template that is only "#(discord)": no text of its own, but the referenced command's reply went out.
    assert.deepEqual(chatSendDecision({ error: false, type: 'success', data: undefined, sent: 1 }), { outcome: 'ok' });
    // Only a reference to a command that does not exist: nothing was sent at all.
    assert.deepEqual(chatSendDecision({ error: false, type: 'success', data: undefined, sent: 0 }), { outcome: 'skipped', reason: 'empty_message' });
    assert.deepEqual(chatSendDecision({ error: true, type: 'held_for_moderation', message: 'held' }), { outcome: 'blocked', reason: 'held_for_moderation' });
    assert.deepEqual(chatSendDecision({ error: true, type: 'error', message: 'no token' }), { outcome: 'failed', reason: 'send_failed', error: 'no token' });
    assert.deepEqual(deliveryOutcome({ error: false, message: 'AST message delivered' }), { outcome: 'ok' });
    assert.deepEqual(deliveryOutcome({ error: true, type: 'held_for_moderation' }), { outcome: 'blocked', reason: 'held_for_moderation' });
    assert.deepEqual(deliveryOutcome({ error: true, message: 'Twitch said no' }), { outcome: 'failed', reason: 'send_failed', error: 'Twitch said no' });

    // Held and failed attempts keep their own rows; a later ok for the same event still lands.
    const source = { type: 'channel.follow', channelID: 'c1', payload: {}, ref: 'key-1' };
    const ids = (['ok', 'blocked', 'failed'] as const).map(outcome => buildActivityRow(alertActivity(source,
        outcome === 'ok' ? { outcome } : outcome === 'blocked' ? { outcome, reason: 'held_for_moderation' } : { outcome, reason: 'send_failed' }))!._id);
    assert.equal(new Set(ids).size, 3);
    const end = buildActivityRow(alertActivity({ ...source, part: 'end' }, { outcome: 'ok' }))!;
    assert.notEqual(end._id, ids[0]);
    assert.equal(end.data.part, 'end');
    const actor = buildActivityRow(alertActivity({ ...source, type: 'channel.raid', actor: { id: 't', login: 'Target' } }, { outcome: 'ok' }))!;
    assert.equal(actor.actorLogin, 'target');
});
