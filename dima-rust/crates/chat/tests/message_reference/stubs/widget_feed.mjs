export * from 'real:widget_feed/publisher.ts';
import { record, track } from './rec.mjs';
export const publishWidgetChatEvent = (channelID, kind, event) => {
  record('feed', { channelID, type: kind, messageID: event?.message_id ?? null });
  return track(Promise.resolve());
};
