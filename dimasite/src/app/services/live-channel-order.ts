import type { LiveChannelBoardEntry } from './site-analytics.service';

export function compareLiveChannels(a: LiveChannelBoardEntry, b: LiveChannelBoardEntry): number {
  const activeDifference = Number(b.botPlatforms.length > 0) - Number(a.botPlatforms.length > 0);
  return activeDifference || b.viewers - a.viewers;
}
