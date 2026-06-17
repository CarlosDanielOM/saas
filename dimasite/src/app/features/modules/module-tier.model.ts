export type PlanTier = 'free' | 'premium' | 'pro';

export type ModuleId =
  | 'clips'
  | 'chat-events'
  | 'triggers'
  | 'dimafx'
  | 'tts'
  | 'referrals'
  | 'redemptions'
  | 'ai-personality'
  | 'memories'
  | 'analytics'
  | 'analytics.follows'
  | 'follow-defense'
  | 'stream-summaries';

export type ModuleStatus = 'stable' | 'beta' | 'alpha' | 'coming_soon' | 'under_construction' | 'maintenance';

export interface ModuleTierRequirement {
  readonly id: ModuleId;
  readonly minTier: PlanTier;
  readonly alsoAllows?: PlanTier;
  readonly displayName: string;
  readonly defaultStatus: ModuleStatus;
  readonly category: 'engagement' | 'automation' | 'content';
}

export const MODULE_TIER_REQUIREMENTS: Readonly<Record<ModuleId, ModuleTierRequirement>> = {
  clips: {
    id: 'clips',
    minTier: 'free',
    displayName: 'Clips',
    defaultStatus: 'stable',
    category: 'content'
  },
  'chat-events': {
    id: 'chat-events',
    minTier: 'free',
    displayName: 'Chat Events',
    defaultStatus: 'stable',
    category: 'engagement'
  },
  triggers: {
    id: 'triggers',
    minTier: 'free',
    displayName: 'Triggers',
    defaultStatus: 'beta',
    category: 'automation'
  },
  dimafx: {
    id: 'dimafx',
    minTier: 'free',
    displayName: 'DimaFX',
    defaultStatus: 'beta',
    category: 'engagement'
  },
  tts: {
    id: 'tts',
    minTier: 'free',
    displayName: 'Text to Speech',
    defaultStatus: 'stable',
    category: 'automation'
  },
  referrals: {
    id: 'referrals',
    minTier: 'free',
    displayName: 'Referrals',
    defaultStatus: 'stable',
    category: 'engagement'
  },
  redemptions: {
    id: 'redemptions',
    minTier: 'free',
    displayName: 'Redemptions',
    defaultStatus: 'beta',
    category: 'engagement'
  },
  'ai-personality': {
    id: 'ai-personality',
    minTier: 'free',
    displayName: 'AI Personality',
    defaultStatus: 'beta',
    category: 'automation'
  },
  memories: {
    id: 'memories',
    minTier: 'free',
    displayName: 'Memories',
    defaultStatus: 'beta',
    category: 'automation'
  },
  analytics: {
    id: 'analytics',
    minTier: 'premium',
    alsoAllows: 'pro',
    displayName: 'Analytics',
    defaultStatus: 'stable',
    category: 'engagement'
  },
  'analytics.follows': {
    id: 'analytics.follows',
    minTier: 'premium',
    alsoAllows: 'pro',
    displayName: 'Follow Ledger',
    defaultStatus: 'stable',
    category: 'engagement'
  },
  'follow-defense': {
    id: 'follow-defense',
    minTier: 'free',
    displayName: 'Follow Defense',
    defaultStatus: 'beta',
    category: 'automation'
  },
  'stream-summaries': {
    id: 'stream-summaries',
    minTier: 'free',
    displayName: 'Stream Summaries',
    defaultStatus: 'stable',
    category: 'content'
  }
};

export function tierRank(tier: PlanTier): number {
  if (tier === 'pro') {
    return 2;
  }
  if (tier === 'premium') {
    return 1;
  }
  return 0;
}

export function isModuleAccessible(req: ModuleTierRequirement, currentTier: PlanTier): boolean {
  return tierRank(currentTier) >= tierRank(req.minTier);
}

export function getAvailableUpgradeTiers(
  req: ModuleTierRequirement,
  currentTier: PlanTier
): ('premium' | 'pro')[] {
  if (isModuleAccessible(req, currentTier)) {
    return [];
  }

  if (req.minTier === 'premium' && currentTier === 'free') {
    return ['premium', 'pro'];
  }

  return ['pro'];
}

export function getRequiredTierForModule(
  req: ModuleTierRequirement,
  currentTier: PlanTier
): PlanTier {
  if (req.minTier === 'premium' && currentTier === 'free') {
    return 'premium';
  }
  return 'pro';
}
