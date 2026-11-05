import { WIDGET_FEED_CHANNEL } from './types.js';

/**
 * Asks the API to send fresh session data to the channel's OBS custom widgets, e.g. when goal progress or the
 * subscriber ledger changed (cron consumers) or the streamer edited goals: StreamElements `*-goal` / `*-total` values
 * follow them. Fire and forget: never awaited by callers and capped at 2 s, so a slow Dragonfly can't stall a consumer;
 * the next alert refreshes anyway.
 */
export function requestWidgetSessionRefresh(channel: string): void {
  const publish = import('../classes/pubsub_manager.class.js')
    .then(({ pubSubManager }) => pubSubManager.publish(WIDGET_FEED_CHANNEL, { channel, type: 'session.refresh', data: {} }));
  void Promise.race([publish, new Promise(resolve => setTimeout(resolve, 2000).unref())]).catch(() => {});
}
