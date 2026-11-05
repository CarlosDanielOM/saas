import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';
import { getBadgeLookup, type BadgeLookup } from './badges.js';
import { normalizeChatMessage, normalizeChatDelete, normalizeChatClear } from './chat-normalize.js';
import { WIDGET_FEED_CHANNEL, widgetFeedDemandKey, type WidgetFeedMessage } from './types.js';

interface PublisherDependencies {
  readDemand: (key: string) => Promise<boolean>;
  badges: (channel: string) => Promise<BadgeLookup>;
  publish: (topic: string, message: WidgetFeedMessage) => Promise<void>;
  now: () => number;
  normalize?: typeof normalizeChatMessage;
}

export function createWidgetChatPublisher(deps: PublisherDependencies) {
  const demand = new Map<string, { present: boolean; expiresAt: number }>();
  const inFlight = new Map<string, Promise<boolean>>();
  const deliveries = new Map<string, Promise<void>>();
  async function hasDemand(channel: string): Promise<boolean> {
    const cached = demand.get(channel);
    if (cached && cached.expiresAt > deps.now()) return cached.present;
    const pending = inFlight.get(channel);
    if (pending) return pending;
    const request = (async () => {
      let present = false;
      try { present = await deps.readDemand(widgetFeedDemandKey(channel)); } catch { /* Fail closed during cache outages. */ }
      demand.delete(channel);
      demand.set(channel, { present, expiresAt: deps.now() + 5000 });
      if (demand.size > 2000) demand.delete(demand.keys().next().value!);
      return present;
    })();
    inFlight.set(channel, request);
    void request.finally(() => inFlight.delete(channel)).catch(() => {});
    return request;
  }
  return async (channel: string, type: WidgetFeedMessage['type'], rawEvent: unknown): Promise<void> => {
    try {
      if (!channel) return;
      if (!await hasDemand(channel)) return;
      // A cold badge fetch must not let later deletes/clears overtake chat messages.
      // Errors settle the tail so a failed delivery cannot poison this channel.
      const delivery = (deliveries.get(channel) ?? Promise.resolve()).then(async () => {
        let data: WidgetFeedMessage['data'];
        if (type === 'chat') {
          const badges = await deps.badges(channel);
          data = (deps.normalize ?? normalizeChatMessage)(rawEvent as IChatMessage, badges, deps.now());
        } else if (type === 'chat.delete') data = normalizeChatDelete(rawEvent);
        else data = normalizeChatClear(rawEvent && typeof rawEvent === 'object' && 'target_user_id' in rawEvent
          ? 'channel.chat.clear_user_messages' : 'channel.chat.clear', rawEvent);
        await deps.publish(WIDGET_FEED_CHANNEL, { channel, type, data });
      }).catch(() => {});
      deliveries.set(channel, delivery);
      await delivery;
      if (deliveries.get(channel) === delivery) deliveries.delete(channel);
    } catch { /* Widget delivery must never reject or interfere with normal chat processing. */ }
  };
}

export const publishWidgetChatEvent = createWidgetChatPublisher({
  now: Date.now, badges: getBadgeLookup,
  readDemand: async key => {
    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    return (await (await getDragonflyClient('WidgetFeed:Demand')).exists(key)) > 0;
  },
  publish: async (topic, message) => {
    const { pubSubManager } = await import('../classes/pubsub_manager.class.js');
    await pubSubManager.publish(topic, message);
  }
});
