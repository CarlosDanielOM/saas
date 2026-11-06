import type { ChatEvent } from './chat-events.model';

const EVENT_NAME_KEYS: Record<string, string> = {
  'stream.offline': 'stream_offline', 'stream.online': 'stream_online',
  'channel.follow': 'channel_follow', 'channel.ad_break.begin': 'channel_ad_break_begin',
  'channel.bits.use': 'channel_bits_use', 'channel.raid': 'channel_raid',
  'channel.raid.outgoing': 'channel_raid_outgoing', 'channel.chat.notification': 'channel_chat_notification',
  'channel.shoutout.receive': 'channel_shoutout_receive', 'channel.subscribe': 'channel_subscribe',
  'channel.subscription.gift': 'channel_subscription_gift',
  'channel.subscription.message': 'channel_subscription_message', 'channel.subscription.end': 'channel_subscription_end'
};

export function chatEventName(event: ChatEvent, translate: (key: string) => string): string {
  if (event.notice) return translate(`chatEvents.${event.notice === 'watch_streak' ? 'watchStreak' : 'modiversary'}.name`);
  const key = EVENT_NAME_KEYS[event.type];
  return key ? translate(`chatEvents.eventNames.${key}`) : event.name;
}
