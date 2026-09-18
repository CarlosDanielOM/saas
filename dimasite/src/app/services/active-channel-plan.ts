export type ActiveChannelPlanTier = 'free' | 'premium' | 'pro';

export interface ManagedChannelPlan {
  channelID: string;
  channelName: string;
}

export interface ActiveChannelPlanSession {
  ownerChannelID: string;
  ownerLogin: string;
  ownerPlanTier: ActiveChannelPlanTier;
  administrating: readonly ManagedChannelPlan[];
}

function normalizeIdentifier(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizePlanTier(value: string | null | undefined): ActiveChannelPlanTier {
  return value === 'premium' || value === 'pro' ? value : 'free';
}

export function resolveActiveChannelPlanTier(
  session: ActiveChannelPlanSession | null | undefined,
  streamer: string | null | undefined,
  knownChannelPlans: Readonly<Record<string, ActiveChannelPlanTier>> = {}
): ActiveChannelPlanTier {
  if (!session) {
    return 'free';
  }

  const normalizedStreamer = normalizeIdentifier(streamer);
  const ownerChannelID = normalizeIdentifier(session.ownerChannelID);
  const ownerLogin = normalizeIdentifier(session.ownerLogin);

  if (!normalizedStreamer || normalizedStreamer === ownerChannelID || normalizedStreamer === ownerLogin) {
    return normalizePlanTier(session.ownerPlanTier);
  }

  const directlyResolvedTier = knownChannelPlans[normalizedStreamer];
  if (directlyResolvedTier) {
    return normalizePlanTier(directlyResolvedTier);
  }

  const managedChannel = session.administrating.find((channel) => {
    const channelID = normalizeIdentifier(channel.channelID);
    const channelName = normalizeIdentifier(channel.channelName);
    return normalizedStreamer === channelID || normalizedStreamer === channelName;
  });

  if (!managedChannel) {
    return 'free';
  }

  const channelID = normalizeIdentifier(managedChannel.channelID);
  const channelName = normalizeIdentifier(managedChannel.channelName);
  return normalizePlanTier(knownChannelPlans[channelID] ?? knownChannelPlans[channelName]);
}
