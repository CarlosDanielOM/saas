import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { IEventsub } from '../schemas/eventsub.schema.js';
import type { IFollowEvent, IRaidEventData, ITwitchEventData, ITwitchSubscriptionData } from '../interfaces/twitch/eventsub.interface.js';

let effects: string[];
let lookups = 0;
let enabled = true;
let minViewers = 0;
mock.module('../classes/chat_history.js', { defaultExport: {} });
mock.module('../utils/keyword_cache.js', { namedExports: { keywordIndexCache: {
    get: async () => { effects.push('keyword-preload'); },
    invalidate: () => { effects.push('keyword-release'); }
} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async (id: string) => { lookups++; return { id, chat_enabled: 'true' }; }
} });
mock.module('../schemas/eventsub.schema.js', { defaultExport: { findOne: async () => ({
    enabled, minViewers, message: 'configured', clipEnabled: false, type: 'test', cheerTiers: []
}) } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    get: async () => '0', set: async () => { effects.push('follow-count'); }
}) } });
mock.module('../utils/follow_defense_queue.js', { namedExports: {
    enqueueFollowDefenseFollow: async () => { effects.push('legacy-follow'); },
    setFollowDefenseRaidMarker: async () => { effects.push('legacy-raid'); },
    shouldSuppressFollowAlerts: async () => false
} });
mock.module('../functions/chats/send_message.chat.js', { namedExports: { sendTwitchChatMessage: async () => { effects.push('chat'); } } });
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
beforeEach(() => { effects = []; lookups = 0; enabled = true; minViewers = 0; });

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
