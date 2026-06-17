import type {
  ITwitchEventData,
  ITwitchSubscriptionData,
} from "../interfaces/twitch/eventsub.interface.js";

export interface TestEventPayload {
  subscription: ITwitchSubscriptionData;
  event: ITwitchEventData;
}

interface TestEventOptions {
  broadcaster_user_id: string;
  broadcaster_user_login?: string;
  broadcaster_user_name?: string;
  [key: string]: unknown;
}

/**
 * Generates a test payload for any supported EventSub event type.
 * All data is fake/randomized for testing purposes.
 */
export function generateTestPayload(
  eventType: string,
  channelID: string,
  overrides?: Partial<TestEventPayload>,
): TestEventPayload {
  const baseSubscription: ITwitchSubscriptionData = {
    id: `test_sub_${Date.now()}`,
    type: eventType,
    version: getVersionForType(eventType),
    status: "enabled",
    cost: 0,
    condition: buildCondition(eventType, channelID),
    transport: {
      method: "webhook",
      callback: `https://subscriptions.domdimabot.com/eventsub`,
    },
    created_at: new Date().toISOString(),
  };

  const eventData = buildEventData(eventType, channelID);

  return {
    subscription: { ...baseSubscription, ...overrides?.subscription },
    event: eventData as unknown as ITwitchEventData,
  };
}

function getVersionForType(type: string): string {
  const versions: Record<string, string> = {
    "channel.chat.message": "1",
    "channel.follow": "2",
    "stream.online": "1",
    "stream.offline": "1",
    "channel.raid": "1",
    "channel.poll.progress": "1",
    "channel.prediction.progress": "1",
    "channel.hype_train.begin": "2",
    "channel.hype_train.progress": "2",
    "channel.hype_train.end": "2",
    "channel.shoutout.receive": "1",
    "channel.ad_break.begin": "1",
    "channel.subscribe": "1",
    "channel.subscription.gift": "1",
    "channel.subscription.message": "1",
    "channel.subscription.end": "1",
    "channel.update": "1",
    "user.update": "1",
    "channel.bits.use": "1",
    "automod.message.hold": "1",
    "channel.channel_points_custom_reward_redemption.add": "1",
    "channel.ban": "1",
  };
  return versions[type] || "1";
}

function buildCondition(
  type: string,
  channelID: string,
): Record<string, string> {
  const MOD_ID = "698614112";

  switch (type) {
    case "channel.chat.message":
      return {
        broadcaster_user_id: channelID,
        user_id: MOD_ID,
      };
    case "channel.follow":
      return {
        broadcaster_user_id: channelID,
        moderator_user_id: MOD_ID,
      };
    case "stream.online":
    case "stream.offline":
    case "channel.poll.progress":
    case "channel.prediction.progress":
    case "channel.hype_train.begin":
    case "channel.hype_train.progress":
    case "channel.hype_train.end":
    case "channel.ad_break.begin":
    case "channel.subscribe":
    case "channel.subscription.gift":
    case "channel.subscription.message":
    case "channel.subscription.end":
    case "channel.update":
    case "channel.bits.use":
    case "automod.message.hold":
    case "channel.channel_points_custom_reward_redemption.add":
    case "channel.ban":
      return {
        broadcaster_user_id: channelID,
      };
    case "channel.raid":
      return {
        to_broadcaster_user_id: channelID,
      };
    case "channel.shoutout.receive":
      return {
        broadcaster_user_id: channelID,
        moderator_user_id: MOD_ID,
      };
    case "user.update":
      return {
        user_id: channelID,
      };
    default:
      return {
        broadcaster_user_id: channelID,
      };
  }
}

function buildEventData(
  type: string,
  channelID: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const randomUserId = String(
    Math.floor(Math.random() * 900000000) + 100000000,
  );
  const randomViewers = Math.floor(Math.random() * 500) + 10;

  const base: Record<string, unknown> = {
    ...overrides,
  };

  // Set defaults based on event type, allowing overrides to take precedence
  switch (type) {
    case "channel.chat.message":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        chatter_user_id: randomUserId,
        chatter_user_name: "TestUser",
        chatter_user_login: "testuser",
        message_id: `test_msg_${Date.now()}`,
        message: {
          text: "This is a test message!",
          fragments: [
            {
              text: "This is a test message!",
              type: "text",
            },
          ],
        },
        message_type: "text",
        badges: [],
        cheer: { bits: 0 },
        color: "#FF0000",
        ...base,
      };

    case "channel.follow":
      return {
        user_id: randomUserId,
        user_name: "TestFollower",
        user_login: "testfollower",
        broadcaster_user_id: channelID,
        broadcaster_user_name: "TestStreamer",
        broadcaster_user_login: "teststreamer",
        followed_at: now,
        ...base,
      };

    case "stream.online":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_name: "TestStreamer",
        broadcaster_user_login: "teststreamer",
        started_at: now,
        type: "live",
        id: `stream_online_${Date.now()}`,
        ...base,
      };

    case "stream.offline":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_name: "TestStreamer",
        broadcaster_user_login: "teststreamer",
        ...base,
      };

    case "channel.raid":
      return {
        to_broadcaster_user_id: channelID,
        to_broadcaster_user_login: "teststreamer",
        to_broadcaster_user_name: "TestStreamer",
        from_broadcaster_user_id: String(
          Math.floor(Math.random() * 900000000) + 100000000,
        ),
        from_broadcaster_user_login: "raidstreamer",
        from_broadcaster_user_name: "RaidStreamer",
        viewers: randomViewers,
        ...base,
      };

    case "channel.channel_points_custom_reward_redemption.add":
      return {
        id: `redemption_${Date.now()}`,
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        reward: {
          id: "test_reward_id",
          title: "Test Reward",
          prompt: "This is a test reward",
          cost: 100,
          should_redemptions_skip_request_queue: false,
        },
        user_input: "test input",
        status: "unfulfilled",
        redeemed_at: now,
        ...base,
      };

    case "channel.ad_break.begin":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_name: "TestStreamer",
        broadcaster_user_login: "teststreamer",
        requester_user_id: randomUserId,
        requester_user_name: "TestUser",
        requester_user_login: "testuser",
        duration_seconds: 60,
        started_at: now,
        is_automatic: false,
        ...base,
      };

    case "channel.ban":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_name: "TestStreamer",
        broadcaster_user_login: "teststreamer",
        user_id: randomUserId,
        user_name: "BannedUser",
        user_login: "banneduser",
        moderator_user_id: "698614112",
        moderator_user_name: "TestModBot",
        moderator_user_login: "testmodbot",
        reason: "Test ban reason",
        ends_at: null,
        is_permanent: true,
        ...base,
      };

    case "channel.subscribe":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        tier: "1000",
        sub_tier: "1000",
        subscription_tier: "1000",
        is_gift: false,
        subscribed_at: now,
        ...base,
      };

    case "channel.subscription.gift":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        tier: "1000",
        sub_tier: "1000",
        subscription_tier: "1000",
        is_gift: true,
        total: 5,
        ...base,
      };

    case "channel.subscription.message":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        tier: "1000",
        sub_tier: "1000",
        subscription_tier: "1000",
        is_gift: false,
        subscribed_at: now,
        ...base,
      };

    case "channel.subscription.end":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        tier: "1000",
        sub_tier: "1000",
        subscription_tier: "1000",
        is_gift: false,
        subscribed_at: now,
        ended_at: now,
        ...base,
      };

    case "channel.bits.use":
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        user_id: randomUserId,
        user_login: "testuser",
        user_name: "TestUser",
        bits: 100,
        type: "cheer",
        is_anonymous: false,
        ...base,
      };

    case "channel.poll.progress":
    case "channel.prediction.progress":
    case "channel.update":
    case "channel.hype_train.begin":
    case "channel.hype_train.progress":
    case "channel.hype_train.end":
    case "channel.shoutout.receive":
    case "user.update":
    case "automod.message.hold":
      // These events have more complex structures but follow a similar pattern
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        ...base,
      };

    default:
      return {
        broadcaster_user_id: channelID,
        broadcaster_user_login: "teststreamer",
        broadcaster_user_name: "TestStreamer",
        ...base,
      };
  }
}

/**
 * Returns the list of all supported testable event types
 */
export function getTestableEventTypes(): string[] {
  return [
    "channel.chat.message",
    "channel.follow",
    "stream.online",
    "stream.offline",
    "channel.raid",
    "channel.channel_points_custom_reward_redemption.add",
    "channel.ad_break.begin",
    "channel.ban",
    "channel.subscribe",
    "channel.subscription.gift",
    "channel.subscription.message",
    "channel.subscription.end",
    "channel.bits.use",
    "channel.poll.progress",
    "channel.prediction.progress",
    "channel.hype_train.begin",
    "channel.hype_train.progress",
    "channel.hype_train.end",
    "channel.shoutout.receive",
    "channel.update",
    "user.update",
    "automod.message.hold",
  ];
}
