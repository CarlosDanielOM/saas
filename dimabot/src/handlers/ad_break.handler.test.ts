import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { IEventsub } from '../schemas/eventsub.schema.js';
import type { IAdBreakEvent } from '../interfaces/twitch/eventsub.interface.js';

const results: unknown[] = [];
const SENT = { error: false, type: 'success', data: { is_sent: true, message_id: 'tw-1' } };
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => results.shift() ?? SENT } });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, error: async () => undefined } });

const { adBreakHandler } = await import('./ad_break.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');

const ad = { broadcaster_user_id: 'c1', duration_seconds: 0 } as unknown as IAdBreakEvent;
const rows = () => pendingActivityRowsForTests().map(row => [row.name, row.outcome, row.reason, row.ref, row.data.part ?? null]);
const later = () => new Promise(resolve => setTimeout(resolve, 20));
beforeEach(() => { setActivityLogSinkForTests(async () => undefined); results.length = 0; });

test('start and end messages are two alert rows of one ad break', async () => {
    assert.deepEqual(await adBreakHandler(ad, { message: 'Ads!', endEnabled: true, endMessage: 'Back!' } as IEventsub, true, 'm-1'),
        { error: false, message: 'Ad break handled' });
    await later();
    results.push({ error: true, type: 'error', message: 'Twitch said no' }, { error: true, type: 'held_for_moderation', message: 'held' });
    await adBreakHandler(ad, { message: 'Ads!', endEnabled: true, endMessage: 'Back!' } as IEventsub, true, 'm-2');
    await later();
    await adBreakHandler(ad, { message: '', endEnabled: true, endMessage: '' } as IEventsub, true, 'm-3');
    await later();
    await adBreakHandler(ad, { message: 'Ads!', endEnabled: true, endMessage: 'Back!' } as IEventsub, false, 'm-4');
    await later();
    assert.deepEqual(rows(), [
        ['channel.ad_break.begin', 'ok', '', 'm-1', null], ['channel.ad_break.begin', 'ok', '', 'm-1', 'end'],
        ['channel.ad_break.begin', 'failed', 'send_failed', 'm-2', null], ['channel.ad_break.begin', 'blocked', 'held_for_moderation', 'm-2', 'end'],
        ['channel.ad_break.begin', 'skipped', 'empty_message', 'm-3', null], ['channel.ad_break.begin', 'skipped', 'empty_message', 'm-3', 'end'],
        ['channel.ad_break.begin', 'skipped', 'chat_disabled', 'm-4', null]
    ]);
    const ids = pendingActivityRowsForTests().map(row => row._id);
    assert.equal(new Set(ids).size, ids.length, 'start and end rows never collapse into one');
});
