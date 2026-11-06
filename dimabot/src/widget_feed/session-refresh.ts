import { WIDGET_FEED_CHANNEL } from './types.js';

/**
 * Sends a message to the API's custom widget feed (Dragonfly `widget-feed`) from any process. Fire and forget: never
 * awaited by callers and capped at 2 s, so a slow Dragonfly can't stall a consumer or a chat event.
 */
export function publishToWidgets(channel: string, type: string, data: Record<string, unknown>): void {
  const publish = import('../classes/pubsub_manager.class.js')
    .then(({ pubSubManager }) => pubSubManager.publish(WIDGET_FEED_CHANNEL, { channel, type, data }));
  const sent = Promise.race([publish, new Promise(resolve => setTimeout(resolve, 2000).unref())]).catch(() => {});
  pending.add(sent); void sent.finally(() => pending.delete(sent));
}
const pending = new Set<Promise<unknown>>();
/** Waits (2 s at most) for widget messages still being sent, so a worker that is about to exit doesn't drop them. */
export async function flushWidgetPublishes(): Promise<void> { await Promise.all([...pending]); }

/**
 * Asks the API to send fresh session data (and goal state) to the channel's OBS custom widgets, e.g. when goal
 * progress or the subscriber ledger changed (cron consumers) or the streamer edited goals. The next alert refreshes anyway.
 */
export function requestWidgetSessionRefresh(channel: string): void { publishToWidgets(channel, 'session.refresh', {}); }
