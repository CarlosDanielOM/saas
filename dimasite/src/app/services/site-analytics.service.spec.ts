import { describe, expect, it } from 'vitest';

import { compareLiveChannels } from './live-channel-order';
import type { LiveChannelBoardEntry } from './site-analytics.service';

function channel(channel: string, viewers: number, botPlatforms: LiveChannelBoardEntry['botPlatforms']): LiveChannelBoardEntry {
  return { channelID: channel, channel, viewers, profileImageUrl: '', botPlatforms };
}

describe('landing live channel order', () => {
  it('features active bot channels before inactive channels, then sorts each group by viewers', () => {
    const channels = [
      channel('inactive-large', 500, []),
      channel('active-small', 10, ['twitch']),
      channel('inactive-medium', 300, []),
      channel('active-large', 100, ['kick']),
      channel('inactive-small', 20, [])
    ];

    expect(channels.sort(compareLiveChannels).map((entry) => entry.channel)).toEqual([
      'active-large',
      'active-small',
      'inactive-large',
      'inactive-medium',
      'inactive-small'
    ]);
  });
});
