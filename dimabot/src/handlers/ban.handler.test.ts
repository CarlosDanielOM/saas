import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { IEventsub } from '../schemas/eventsub.schema.js';
import type { IBanEvent } from '../interfaces/twitch/eventsub.interface.js';

let sendResult: unknown;
const sent: string[] = [];
mock.module('../functions/chats/send_message.chat.js', { namedExports: {
    sendTwitchChatMessage: async (_channel: string, message: string) => { sent.push(message); if (sendResult instanceof Error) throw sendResult; return sendResult; }
} });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, error: async () => undefined } });

const { banHandler } = await import('./ban.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');

const SENT = { error: false, type: 'success', data: { is_sent: true, message_id: 'tw-1' } };
const ban = (is_permanent: boolean) => ({ broadcaster_user_id: 'c1', user_id: '9', user_login: 'troll', user_name: 'Troll',
    moderator_user_login: 'mod', reason: 'spam', is_permanent }) as unknown as IBanEvent;
const config = { message: 'Bye $(user)', temporalBanMessage: '' } as IEventsub;
const rows = () => pendingActivityRowsForTests().map(row => [row.kind, row.name, row.outcome, row.reason, row.ref, row.actorLogin, row.data.permanent]);
beforeEach(() => { setActivityLogSinkForTests(async () => undefined); sendResult = SENT; sent.length = 0; });

test('ban alerts record sent, chat off, empty, rendered-empty, held, refused and crashed, with unchanged replies', async () => {
    assert.deepEqual(await banHandler(ban(true), config, true, 'm-1'), { error: false, message: 'Ban handled' });
    assert.deepEqual(await banHandler(ban(true), config, false, 'm-2'), { error: false, message: 'Chat is disabled' });
    assert.deepEqual(await banHandler(ban(false), config, true, 'm-3'), { error: false, message: 'No message to send' });
    sendResult = { error: false, type: 'success', data: undefined };
    await banHandler(ban(true), config, true, 'm-4');
    sendResult = { error: true, type: 'held_for_moderation', message: 'held' };
    await banHandler(ban(true), config, true, 'm-5');
    sendResult = { error: true, type: 'error', message: 'Twitch said no' };
    assert.deepEqual(await banHandler(ban(true), config, true, 'm-6'), { error: false, message: 'Ban handled' });
    sendResult = new Error('socket hang up');
    assert.deepEqual(await banHandler(ban(true), config, true, 'm-7'), { error: true, message: 'Internal server error' });
    assert.deepEqual(rows(), [
        ['alert', 'channel.ban', 'ok', '', 'm-1', 'troll', true],
        ['alert', 'channel.ban', 'skipped', 'chat_disabled', 'm-2', 'troll', true],
        ['alert', 'channel.ban', 'skipped', 'empty_message', 'm-3', 'troll', false],
        ['alert', 'channel.ban', 'skipped', 'empty_message', 'm-4', 'troll', true],
        ['alert', 'channel.ban', 'blocked', 'held_for_moderation', 'm-5', 'troll', true],
        ['alert', 'channel.ban', 'failed', 'send_failed', 'm-6', 'troll', true],
        ['alert', 'channel.ban', 'failed', 'handler_error', 'm-7', 'troll', true]
    ]);
    assert.equal(pendingActivityRowsForTests()[5]!.data.error, 'Twitch said no');
    assert.equal(sent.length, 5);
});
