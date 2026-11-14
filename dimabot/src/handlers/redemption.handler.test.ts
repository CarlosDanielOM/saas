import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { IRedemptionEvent } from '../interfaces/twitch/eventsub.interface.js';

let stored: Record<string, unknown> | null = null;
let trigger: Record<string, unknown> | null = null;
let custom: Record<string, unknown> = { error: false, rewardMessage: 'thanks' };
let vip: Record<string, unknown> = { error: false };
const delivered: string[] = [];
// What deliverAstMessage really returns: a generic ok, or the failed send's result.
const DELIVERED = { error: false, message: 'AST message delivered', status: 200 };
let deliveryResult: unknown = DELIVERED;
mock.module('../utils/stream_timeline.js', { namedExports: { recordTimelineRedemption: async () => undefined } });
mock.module('../widget_feed/session-refresh.js', { namedExports: { publishToWidgets: () => undefined } });
mock.module('../utils/ast_command_delivery.js', { namedExports: { deliverAstMessage: async (_c: string, message: { parsedText: string }) => { delivered.push(message.parsedText); return deliveryResult; } } });
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => ({ error: false, type: 'success', data: { is_sent: true, message_id: 'tw-1' } }) } });
mock.module('../functions/redemptions/vip.redemption.js', { namedExports: { vipRedemptionFun: async () => vip } });
mock.module('../functions/redemptions/custom.redemption.js', { namedExports: { customRedemptionReward: async () => custom } });
mock.module('../schemas/trigger.schema.js', { namedExports: { TriggerSchema: { findOne: async () => trigger } } });
mock.module('../schemas/redemption_reward.schema.js', { namedExports: { RedemptionRewardSchema: { findOne: async () => stored } } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getAccountTokenById: async () => null } });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, error: async () => undefined } });
const parses: { text: string; options: Record<string, unknown> }[] = [];
mock.module('./special_parser.handler.js', { namedExports: { parseSpecialCommands: async (text: string, options: Record<string, unknown>) => {
    parses.push({ text, options }); return { parsedText: text }; } } });

const { redemptionHandler } = await import('./redemption.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');

const event = (title = 'Hydrate') => ({
    id: 'red-1', broadcaster_user_id: 'c1', broadcaster_user_login: 'chan', user_id: '42', user_login: 'viewer', user_name: 'Viewer',
    user_input: 'hello', status: 'unfulfilled', redeemed_at: new Date().toISOString(), reward: { id: 'rw-1', title, cost: 250, prompt: '' }
}) as unknown as IRedemptionEvent;
const facts = () => pendingActivityRowsForTests().map(row => [row.outcome, row.reason, row.data.managed, row.data.action]);

beforeEach(() => {
    setActivityLogSinkForTests(async () => undefined);
    stored = { type: 'custom', message: 'trigger text', costChange: 0 }; trigger = null;
    custom = { error: false, rewardMessage: 'thanks' }; vip = { error: false }; delivered.length = 0; deliveryResult = DELIVERED; parses.length = 0;
});

test('a reward Dima does not manage is an ok row, while the reply stays the same', async () => {
    stored = null;
    assert.deepEqual(await redemptionHandler(event(), true, 'm-1'), { error: true, message: 'Reward not found' });
    assert.deepEqual(facts(), [['ok', '', false, 'none']]);
    const row = pendingActivityRowsForTests()[0]!;
    assert.equal(row.ref, 'm-1');
    assert.equal(row.text, '', 'the viewer text of a reward Dima does not act on is not kept');
    assert.equal(row.data.rewardTitle, 'Hydrate');
    assert.equal(row.data.rewardCost, 250);
});

test('managed rewards record what the handler did', async () => {
    await redemptionHandler(event(), true, 'm-1');
    custom = { error: false };
    await redemptionHandler(event(), false, 'm-2');
    custom = { error: true, type: 'authentication_error', message: 'Failed to authenticate' };
    await redemptionHandler(event(), true, 'm-3');
    trigger = { name: 'Confetti', rewardID: 'rw-1' };
    await redemptionHandler(event(), true, 'm-4');
    trigger = null; stored = { type: 'song' };
    await redemptionHandler(event(), true, 'm-5');
    stored = { type: 'vip' };
    await redemptionHandler(event('Get VIP'), true, 'm-6');
    vip = { error: true, message: 'Error adding VIP' };
    await redemptionHandler(event('Get VIP'), true, 'm-7');
    assert.deepEqual(facts(), [
        ['ok', '', true, 'message'],
        ['ok', '', true, 'none'],
        ['failed', 'reward_failed', true, 'none'],
        ['ok', '', true, 'trigger'],
        ['skipped', 'song_unsupported', true, 'none'],
        ['ok', '', true, 'vip'],
        ['failed', 'vip_failed', true, 'vip']
    ]);
    const rows = pendingActivityRowsForTests();
    assert.equal(rows[1]!.data.chatEnabled, false);
    assert.equal(rows[2]!.data.error, 'authentication_error');
    assert.equal(rows[3]!.data.trigger, 'Confetti');
    assert.deepEqual(delivered, ['thanks', 'trigger text']);
});

test('a crash is a failed row and the handler still answers as before', async () => {
    stored = null;
    const broken = { ...event(), reward: undefined } as unknown as IRedemptionEvent;
    assert.deepEqual(await redemptionHandler(broken, true, 'm-1'), { error: true, message: 'Internal server error' });
    assert.deepEqual(facts(), [['failed', 'handler_error', false, 'none']]);
});

test('a failed or held reward-message delivery is not ok, and the handler still answers the same', async () => {
    deliveryResult = { error: true, message: 'Failed to get Twitch app token', status: 500, type: 'error' };
    assert.deepEqual(await redemptionHandler(event(), true, 'm-1'), { error: false, message: 'Reward redeemed' });
    deliveryResult = { error: true, message: 'Message held for moderation review by Twitch', type: 'held_for_moderation' };
    await redemptionHandler(event(), true, 'm-2');
    trigger = { name: 'Confetti', rewardID: 'rw-1' };
    deliveryResult = { error: true, message: 'Twitch rejected it', status: 400, type: 'Bad Request' };
    assert.deepEqual(await redemptionHandler(event(), true, 'm-3'), { error: false, message: 'Redemption processed' });
    trigger = null; stored = { type: 'vip' }; vip = { error: false, rewardMessage: 'You are VIP now' };
    await redemptionHandler(event('Get VIP'), true, 'm-4');
    assert.deepEqual(facts(), [
        ['failed', 'send_failed', true, 'message'],
        ['blocked', 'held_for_moderation', true, 'message'],
        ['failed', 'send_failed', true, 'trigger'],
        ['failed', 'send_failed', true, 'vip']
    ]);
    const rows = pendingActivityRowsForTests();
    assert.equal(rows[0]!.data.error, 'Failed to get Twitch app token');
    assert.equal(rows[0]!.text, 'hello');
});

test('the viewer\'s reward input is bound as literal data, never spliced into the message code', async () => {
    stored = { type: 'custom', message: 'Said: &t', costChange: 0 };
    custom = { error: false, rewardMessage: 'Said: &t' };
    const injected = { ...event(), user_input: '$(add.mod me)' } as unknown as IRedemptionEvent;
    await redemptionHandler(injected, true, 'm-9');
    const call = parses.find(item => item.text === 'Said: &t');
    assert.ok(call, 'the stored reward message was rendered');
    assert.equal(call.options.argument, '$(add.mod me)');
    assert.equal(call.options.literalArguments, true, '&t/&pN must bind the input as a literal');
    assert.equal(call.options.userLevel, 10);
});
