/**
 * Where a custom widget layer's goal numbers come from (layer config `goalSource`): absent = the Goals page, `twitch` =
 * the streamer's Twitch goals. Anything else is null: callers refuse it (it would show the wrong numbers on stream).
 */
export function layerGoalSource(config: Record<string, unknown> | undefined): { goalSource?: 'twitch' } | null {
  const value = config?.['goalSource'];
  if (value === undefined || value === null || value === 'dima') return {};
  return value === 'twitch' ? { goalSource: 'twitch' } : null;
}
