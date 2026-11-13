import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { IEventsub } from '../schemas/eventsub.schema.js';
import type { IFollowEvent, IRaidEventData, ITwitchEventData, ITwitchSubscriptionData } from '../interfaces/twitch/eventsub.interface.js';

let effects: string[];
let lookups = 0;
let enabled = true;
let minViewers = 0;
let chat = 'true';
let configMissing = false;
// What sendTwitchChatMessage really returns: Twitch's message when sent, no data when the text rendered to nothing.
const SENT = { error: false, message: 'Message sent', status: 200, type: 'success', data: { is_sent: true, message_id: 'tw-1' } };
const RENDERED_EMPTY = { error: false, message: 'AST message delivered', status: 200, type: 'success', data: undefined };
const HELD = { error: true, message: 'Message held for moderation review by Twitch', status: 200, type: 'held_for_moderation' };
const REFUSED = { error: true, message: 'Failed to get Twitch app token', status: 500, type: 'error' };
let sendResult: unknown = SENT;
mock.module('../classes/chat_history.js', { defaultExport: {} });
mock.module('../utils/keyword_cache.js', { namedExports: { keywordIndexCache: {
    get: async () => { effects.push('keyword-preload'); },
    invalidate: () => { effects.push('keyword-release'); }
} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async (id: string) => { lookups++; return { id, chat_enabled: chat }; }
} });
mock.module('../schemas/eventsub.schema.js', { defaultExport: { findOne: () => {
    const found = Promise.resolve(configMissing ? null : { enabled, minViewers, message: 'configured', clipEnabled: false, type: 'test', cheerTiers: [] });
    return Object.assign(found, { lean: () => found });
} } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    get: async () => '0', set: async () => { effects.push('follow-count'); }
}) } });
mock.module('../utils/follow_defense_queue.js', { namedExports: {
    enqueueFollowDefenseFollow: async () => { effects.push('legacy-follow'); },
    setFollowDefenseRaidMarker: async () => { effects.push('legacy-raid'); },
    shouldSuppressFollowAlerts: async () => false
} });
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => { effects.push('chat'); return sendResult; } } });
mock.module('../commands/shoutout.command.js', { namedExports: { handleShoutoutCommand: async () => {
    effects.push('shoutout'); return { error: false };
} } });
mock.module('./special_parser.handler.js', { namedExports: { parseSpecialCommands: async () => ({ parsedText: 'raid message' }) } });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, error: async () => undefined } });
mock.module('../utils/eventsub.js', { namedExports: {
    CANONICAL_BITS_EVENT_TYPE: 'channel.bits.use', canonicalizeEventsubType: (type: string) => type,
    getEquivalentEventsubTypes: (type: string) => [type], isLegacyBitsEventType: () => false,
    migrateLegacyBitsEventsubs: async () => assert.fail('No migration')
} });
for (const [path, name] of [
    ['./message.handler.js', 'messageHandler'], ['./cheer.handler.js', 'cheerHandler'],
    ['./redemption.handler.js', 'redemptionHandler'], ['./stream_online.handler.js', 'streamOnlineHandler'],
    ['./stream_offline.handler.js', 'streamOfflineHandler'], ['./ad_break.handler.js', 'adBreakHandler'],
    ['./ban.handler.js', 'banHandler']
]) mock.module(path, { namedExports: { [name]: async () => { effects.push(name); } } });

const { eventsubHandler } = await import('./eventsub.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');
const { followHandler } = await import('./follow.handler.js');
const { raidHandler } = await import('./raid.handler.js');
const follow: IFollowEvent = {
    broadcaster_user_id: 'channel', broadcaster_user_login: 'channel', broadcaster_user_name: 'Channel',
    user_id: 'viewer', user_login: 'viewer', user_name: 'Viewer', followed_at: new Date().toISOString()
};
const raid = {
    to_broadcaster_user_id: 'channel', to_broadcaster_user_login: 'channel', to_broadcaster_user_name: 'Channel',
    from_broadcaster_user_id: 'raider', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider', viewers: 10
} as IRaidEventData;
const config = { enabled: true, minViewers: 0, message: 'configured', clipEnabled: false } as IEventsub;
beforeEach(() => { effects = []; lookups = 0; enabled = true; minViewers = 0; chat = 'true'; configMissing = false; sendResult = SENT; setActivityLogSinkForTests(async () => undefined); });
const rows = () => pendingActivityRowsForTests().map(row => [row.kind, row.name, row.outcome, row.reason, row.ref, row.text]);

test('stream keyword cache lifecycle runs even when announcements are disabled or durably handled', async () => {
    enabled = false;
    await eventsubHandler({ type: 'stream.online' } as ITwitchSubscriptionData,
        { broadcaster_user_id: 'channel' } as ITwitchEventData, { durableChatHandled: true });
    assert.deepEqual(effects, ['keyword-preload']);
    effects = [];
    await eventsubHandler({ type: 'stream.offline' } as ITwitchSubscriptionData,
        { broadcaster_user_id: 'channel' } as ITwitchEventData, { durableChatHandled: true });
    assert.deepEqual(effects, ['keyword-release']);
});

test('legacy follow enqueue is suppressed only by defense ownership, independently of chat', async () => {
    await followHandler(follow, config, false);
    assert.deepEqual(effects, ['legacy-follow']);
    effects = [];
    await followHandler(follow, config, true, { durableDefenseHandled: true });
    assert.deepEqual(effects, ['follow-count', 'chat']);
    effects = [];
    await eventsubHandler({ type: 'channel.follow' } as ITwitchSubscriptionData, follow, { durableChatHandled: true });
    assert.deepEqual(effects, ['legacy-follow']);
    effects = [];
    await eventsubHandler({ type: 'channel.follow' } as ITwitchSubscriptionData, follow,
        { durableChatHandled: true, durableDefenseHandled: true });
    assert.deepEqual(effects, []);
});

test('marked raids preserve immediate shoutout but not legacy marker; unmarked test/legacy retain both', async () => {
    await raidHandler(raid, config);
    assert.deepEqual(effects, ['legacy-raid', 'shoutout']);
    effects = [];
    await eventsubHandler({ type: 'channel.raid' } as ITwitchSubscriptionData, raid as ITwitchEventData,
        { durableChatHandled: true, durableDefenseHandled: true });
    assert.deepEqual(effects, ['shoutout']);
    effects = [];
    await eventsubHandler({ type: 'channel.raid' } as ITwitchSubscriptionData, raid as ITwitchEventData);
    assert.deepEqual(effects, ['legacy-raid', 'shoutout']);
});

test('legacy raid minimum-viewer and disabled EventSub gates remain intact', async () => {
    minViewers = 11;
    await eventsubHandler({ type: 'channel.raid' } as ITwitchSubscriptionData, raid as ITwitchEventData);
    assert.deepEqual(effects, []);
    minViewers = 0; enabled = false;
    await eventsubHandler({ type: 'channel.raid' } as ITwitchSubscriptionData, raid as ITwitchEventData);
    await eventsubHandler({ type: 'channel.follow' } as ITwitchSubscriptionData, follow);
    assert.deepEqual(effects, []);
});

for (const type of ['channel.chat.message', 'channel.chat.notification']) {
    test(`${type} ignores shared-chat copies in both directions before account lookup`, async () => {
        for (const [origin, receiver] of [['channel-a', 'channel-b'], ['channel-b', 'channel-a']]) {
            await eventsubHandler({ type } as ITwitchSubscriptionData, {
                broadcaster_user_id: receiver, source_broadcaster_user_id: origin,
                notice_type: 'watch_streak', is_source_only: true
            } as unknown as ITwitchEventData);
        }
        assert.equal(lookups, 0);
        assert.deepEqual(effects, []);
    });
}

test('local chat messages accept missing, null, empty and same-channel source metadata', async () => {
    for (const source of [undefined, null, '', 'channel']) {
        for (const is_source_only of [true, false]) {
            await eventsubHandler({ type: 'channel.chat.message' } as ITwitchSubscriptionData, {
                broadcaster_user_id: 'channel', source_broadcaster_user_id: source,
                is_source_only, source_message_id: 'unrelated-id', chatter_user_id: 'another-channel'
            } as unknown as ITwitchEventData);
        }
    }
    assert.deepEqual(effects, Array(8).fill('messageHandler'));
});

test('source metadata does not suppress receiver-targeted moderation events', async () => {
    await eventsubHandler({ type: 'channel.ban' } as ITwitchSubscriptionData, {
        broadcaster_user_id: 'channel', source_broadcaster_user_id: 'other-channel'
    } as unknown as ITwitchEventData);
    assert.deepEqual(effects, ['banHandler']);
});

test('immediate alerts record sent, disabled, chat-off, empty and late outcomes; consumer-owned alerts record nothing here', async () => {
    const update = { broadcaster_user_id: 'channel', title: 'New title' } as unknown as ITwitchEventData;
    await eventsubHandler({ type: 'channel.update' } as ITwitchSubscriptionData, update, { messageId: 'm-1' });
    enabled = false;
    await eventsubHandler({ type: 'channel.update' } as ITwitchSubscriptionData, update, { messageId: 'm-2' });
    await eventsubHandler({ type: 'channel.follow' } as ITwitchSubscriptionData, follow);
    await eventsubHandler({ type: 'channel.follow' } as ITwitchSubscriptionData, follow, { durableChatHandled: true, messageId: 'm-3' });
    enabled = true; chat = 'false';
    await eventsubHandler({ type: 'channel.shoutout.receive' } as ITwitchSubscriptionData, update, { messageId: 'm-4' });
    chat = 'true';
    await eventsubHandler({ type: 'channel.hype_train.begin' } as ITwitchSubscriptionData, update, { durableChatHandled: true, staleRetry: true, messageId: 'm-5' });
    await eventsubHandler({ type: 'channel.chat.message' } as ITwitchSubscriptionData, update, { messageId: 'm-6' });
    assert.deepEqual(rows(), [
        ['alert', 'channel.update', 'ok', '', 'm-1', ''],
        ['alert', 'channel.update', 'skipped', 'alert_disabled', 'm-2', ''],
        ['alert', 'channel.follow', 'skipped', 'alert_disabled', '', ''],
        ['alert', 'channel.shoutout.receive', 'skipped', 'chat_disabled', 'm-4', ''],
        ['alert', 'channel.hype_train.begin', 'skipped', 'stale', 'm-5', '']
    ]);
});

test('the immediate follow path records its own outcome only when no consumer owns it', async () => {
    await followHandler(follow, config, true, { messageId: 'm-1' });
    await followHandler(follow, { ...config, message: ' ' } as IEventsub, true);
    await followHandler(follow, config, false);
    await followHandler(follow, config, false, { durableChatHandled: true, durableDefenseHandled: true });
    assert.deepEqual(rows(), [
        ['alert', 'channel.follow', 'ok', '', 'm-1', ''],
        ['alert', 'channel.follow', 'skipped', 'empty_message', '', ''],
        ['alert', 'channel.follow', 'skipped', 'chat_disabled', '', '']
    ]);
    assert.equal(pendingActivityRowsForTests()[0]!.actorLogin, 'viewer');
});

test('a redemption on a disabled subscription is recorded as skipped and the message id reaches the handler', async () => {
    const redemption = { id: 'red-1', broadcaster_user_id: 'channel', user_id: 'viewer', user_login: 'viewer',
        reward: { id: 'rw', title: 'Hydrate', cost: 100 } } as unknown as ITwitchEventData;
    enabled = false;
    await eventsubHandler({ type: 'channel.channel_points_custom_reward_redemption.add' } as ITwitchSubscriptionData, redemption, { messageId: 'm-r' });
    assert.deepEqual(rows(), [['twitch_event', 'channel.channel_points_custom_reward_redemption.add', 'skipped', 'subscription_disabled', 'm-r', '']]);
    assert.deepEqual(effects, []);
});

test('an alert is ok only when Twitch got a message: rendered-empty, held and refused sends say so', async () => {
    const update = { broadcaster_user_id: 'channel', title: 'New title' } as unknown as ITwitchEventData;
    for (const [result, id] of [[RENDERED_EMPTY, 'm-1'], [HELD, 'm-2'], [REFUSED, 'm-3']] as const) {
        sendResult = result;
        await eventsubHandler({ type: 'channel.update' } as ITwitchSubscriptionData, update, { messageId: id });
        await followHandler(follow, config, true, { messageId: `f-${id}` });
    }
    assert.deepEqual(rows().map(row => row.slice(1, 5)), [
        ['channel.update', 'skipped', 'empty_message', 'm-1'], ['channel.follow', 'skipped', 'empty_message', 'f-m-1'],
        ['channel.update', 'blocked', 'held_for_moderation', 'm-2'], ['channel.follow', 'blocked', 'held_for_moderation', 'f-m-2'],
        ['channel.update', 'failed', 'send_failed', 'm-3'], ['channel.follow', 'failed', 'send_failed', 'f-m-3']
    ]);
    assert.equal(pendingActivityRowsForTests()[4]!.data.error, 'Failed to get Twitch app token');
});

test('outgoing raid alerts are recorded, about the raided channel; no config means no row', async () => {
    const outgoing = { type: 'channel.raid', condition: { from_broadcaster_user_id: 'channel' } } as unknown as ITwitchSubscriptionData;
    const raidOut = { from_broadcaster_user_id: 'channel', from_broadcaster_user_login: 'channel', from_broadcaster_user_name: 'Channel',
        to_broadcaster_user_id: 'target', to_broadcaster_user_login: 'target', to_broadcaster_user_name: 'Target', viewers: 3 } as unknown as ITwitchEventData;
    await eventsubHandler(outgoing, raidOut, { messageId: 'r-1' });
    sendResult = REFUSED;
    await eventsubHandler(outgoing, raidOut, { messageId: 'r-2' });
    chat = 'false';
    await eventsubHandler(outgoing, raidOut, { messageId: 'r-3' });
    chat = 'true'; enabled = false;
    await eventsubHandler(outgoing, raidOut, { messageId: 'r-4' });
    configMissing = true;
    await eventsubHandler(outgoing, raidOut, { messageId: 'r-5' });
    assert.deepEqual(rows().map(row => row.slice(1, 5)), [
        ['channel.raid', 'ok', '', 'r-1'], ['channel.raid', 'failed', 'send_failed', 'r-2'],
        ['channel.raid', 'skipped', 'chat_disabled', 'r-3'], ['channel.raid', 'skipped', 'alert_disabled', 'r-4']
    ]);
    assert.equal(pendingActivityRowsForTests()[0]!.actorLogin, 'target');
    assert.equal(pendingActivityRowsForTests()[0]!.data.direction, 'outgoing');
});

test('ban and ad-break alerts are disabled-gated here and late ad breaks are skipped as stale', async () => {
    const ban = { broadcaster_user_id: 'channel', user_id: 'troll', user_login: 'troll', is_permanent: true } as unknown as ITwitchEventData;
    const ad = { broadcaster_user_id: 'channel', duration_seconds: 30 } as unknown as ITwitchEventData;
    enabled = false;
    await eventsubHandler({ type: 'channel.ban' } as ITwitchSubscriptionData, ban, { messageId: 'b-1' });
    await eventsubHandler({ type: 'channel.ad_break.begin' } as ITwitchSubscriptionData, ad, { messageId: 'a-1' });
    enabled = true;
    await eventsubHandler({ type: 'channel.ad_break.begin' } as ITwitchSubscriptionData, ad, { durableChatHandled: true, staleRetry: true, messageId: 'a-2' });
    assert.deepEqual(rows().map(row => row.slice(1, 5)), [
        ['channel.ban', 'skipped', 'alert_disabled', 'b-1'], ['channel.ad_break.begin', 'skipped', 'alert_disabled', 'a-1'],
        ['channel.ad_break.begin', 'skipped', 'stale', 'a-2']
    ]);
    assert.deepEqual(effects, []);
});
