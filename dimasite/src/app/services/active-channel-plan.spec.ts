import { describe, expect, it } from 'vitest';

import { resolveActiveChannelPlanTier } from './active-channel-plan';

describe('resolveActiveChannelPlanTier', () => {
  const session = {
    ownerChannelID: '100',
    ownerLogin: 'pro_owner',
    ownerPlanTier: 'pro' as const,
    administrating: [
      {
        channelID: '200',
        channelName: 'free_channel'
      },
      {
        channelID: '300',
        channelName: 'premium_channel'
      }
    ]
  };

  it('uses the owner tier on the owner dashboard', () => {
    expect(resolveActiveChannelPlanTier(session, 'pro_owner')).toBe('pro');
    expect(resolveActiveChannelPlanTier(session, '100')).toBe('pro');
  });

  it('uses the managed channel tier by login or channel ID', () => {
    const knownPlans = {
      '200': 'free' as const,
      free_channel: 'free' as const,
      '300': 'premium' as const,
      premium_channel: 'premium' as const
    };
    expect(resolveActiveChannelPlanTier(session, 'free_channel', knownPlans)).toBe('free');
    expect(resolveActiveChannelPlanTier(session, '200', knownPlans)).toBe('free');
    expect(resolveActiveChannelPlanTier(session, 'premium_channel', knownPlans)).toBe('premium');
  });

  it('fails closed until the managed channel tier has been resolved', () => {
    expect(
      resolveActiveChannelPlanTier(
        {
          ...session,
          administrating: [{ channelID: '400', channelName: 'unresolved_channel' }]
        },
        'unresolved_channel'
      )
    ).toBe('free');
  });

  it('fails closed when the route does not identify an accessible channel', () => {
    expect(resolveActiveChannelPlanTier(session, 'unknown_channel')).toBe('free');
  });
});
