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
  | 'moderation'
  | 'stream-summaries'
  | 'clip-recommendations'
  | 'library';

export type ModuleStatus = 'stable' | 'beta' | 'alpha' | 'coming_soon' | 'under_construction' | 'maintenance';

export interface ModuleTierRequirement {
  readonly id: ModuleId;
  readonly minTier: PlanTier;
  readonly alsoAllows?: PlanTier;
  readonly displayName: string;
  readonly defaultStatus: ModuleStatus;
  readonly category: 'engagement' | 'automation' | 'content';
  /** Lower numbers surface first on the modules hub. Gaps of 10 leave room to insert. */
  readonly priority: number;
}

export const MODULE_TIER_REQUIREMENTS: Readonly<Record<ModuleId, ModuleTierRequirement>> = {
  'chat-events': {
    id: 'chat-events',
    minTier: 'free',
    displayName: 'Chat Events',
    defaultStatus: 'stable',
    category: 'engagement',
    priority: 10
  },
  moderation: {
    id: 'moderation',
    minTier: 'free',
    displayName: 'Chat Moderation',
    defaultStatus: 'beta',
    category: 'automation',
    priority: 20
  },
  clips: {
    id: 'clips',
    minTier: 'free',
    displayName: 'Clips',
    defaultStatus: 'stable',
    category: 'content',
    priority: 30
  },
  dimafx: {
    id: 'dimafx',
    minTier: 'free',
    displayName: 'DimaFX',
    defaultStatus: 'beta',
    category: 'engagement',
    priority: 40
  },
  redemptions: {
    id: 'redemptions',
    minTier: 'free',
    displayName: 'Redemptions',
    defaultStatus: 'beta',
    category: 'engagement',
    priority: 50
  },
  triggers: {
    id: 'triggers',
    minTier: 'free',
    displayName: 'Triggers',
    defaultStatus: 'beta',
    category: 'automation',
    priority: 60
  },
  tts: {
    id: 'tts',
    minTier: 'free',
    displayName: 'Text to Speech',
    defaultStatus: 'stable',
    category: 'automation',
    priority: 70
  },
  referrals: {
    id: 'referrals',
    minTier: 'free',
    displayName: 'Referrals',
    defaultStatus: 'stable',
    category: 'engagement',
    priority: 80
  },
  'ai-personality': {
    id: 'ai-personality',
    minTier: 'free',
    displayName: 'AI Personality',
    defaultStatus: 'beta',
    category: 'automation',
    priority: 90
  },
  memories: {
    id: 'memories',
    minTier: 'free',
    displayName: 'Memories',
    defaultStatus: 'beta',
    category: 'automation',
    priority: 100
  },
  'follow-defense': {
    id: 'follow-defense',
    minTier: 'free',
    displayName: 'Follow Defense',
    defaultStatus: 'beta',
    category: 'automation',
    priority: 110
  },
  analytics: {
    id: 'analytics',
    minTier: 'premium',
    alsoAllows: 'pro',
    displayName: 'Analytics',
    defaultStatus: 'stable',
    category: 'engagement',
    priority: 120
  },
  'stream-summaries': {
    id: 'stream-summaries',
    minTier: 'free',
    displayName: 'Stream Summaries',
    defaultStatus: 'stable',
    category: 'content',
    priority: 130
  },
  library: {
    id: 'library',
    minTier: 'free',
    displayName: 'Media Library',
    defaultStatus: 'beta',
    category: 'content',
    priority: 140
  },
  'clip-recommendations': {
    id: 'clip-recommendations',
    minTier: 'free',
    displayName: 'Clip Recommendations',
    defaultStatus: 'alpha',
    category: 'content',
    priority: 150
  },
  'analytics.follows': {
    id: 'analytics.follows',
    minTier: 'premium',
    alsoAllows: 'pro',
    displayName: 'Follow Ledger',
    defaultStatus: 'stable',
    category: 'engagement',
    priority: 160
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
