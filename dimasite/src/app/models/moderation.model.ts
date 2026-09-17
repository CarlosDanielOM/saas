export type ModerationRuleType = 'caps' | 'links' | 'emote_spam' | 'blacklist';
export type ModerationAction = 'off' | 'warn' | 'delete' | 'timeout' | 'ban';
export type CapsThresholdMode = 'count' | 'percentage';
export type OffenseStepKey = 'firstOffense' | 'secondOffense' | 'thirdOffense';

export interface ModerationOffenseStep {
  action: ModerationAction;
  timeoutSeconds: number;
}

export interface ModerationRule {
  id: string;
  type: ModerationRuleType;
  enabled: boolean;
  firstOffense: ModerationOffenseStep;
  secondOffense: ModerationOffenseStep;
  thirdOffense: ModerationOffenseStep;
  reason: string;
  exemptUserLevel: number;
  capsThresholdMode: CapsThresholdMode;
  minCapsCount: number;
  maxCapsPercentage: number;
  minMessageLength: number;
  allowlistDomains: string[];
  maxEmoteCount: number;
  terms: string[];
}

export interface ModerationSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  offenseWindowSeconds: number;
  rules: ModerationRule[];
  settingsVersion: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModerationActionLogEntry {
  _id?: string;
  channelID: string;
  userID: string;
  username: string;
  ruleID: string;
  ruleType: ModerationRuleType;
  action: ModerationAction;
  offenseNumber: number;
  reason: string;
  messageID: string;
  messageExcerpt: string;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export type ModerationSettingsResponse = ApiEnvelope<ModerationSettings>;

export type ModerationLogsResponse = ApiEnvelope<{
  logs: ModerationActionLogEntry[];
  total: number;
  limit: number;
  skip: number;
}>;

export interface ModerationSettingsPayload {
  enabled: boolean;
  offenseWindowSeconds: number;
  rules: ModerationRule[];
}

export const MODERATION_ACTION_OPTIONS: readonly ModerationAction[] = [
  'off',
  'warn',
  'delete',
  'timeout',
  'ban'
];

export const MODERATION_RULE_TYPES: readonly ModerationRuleType[] = [
  'caps',
  'links',
  'emote_spam',
  'blacklist'
];

export const MODERATION_DEFAULTS = {
  offenseWindowSeconds: 3600,
  exemptUserLevel: 7,
  minCapsCount: 8,
  maxCapsPercentage: 70,
  minMessageLength: 10,
  maxEmoteCount: 10,
  maxRules: 20,
  minOffenseWindowSeconds: 60,
  maxOffenseWindowSeconds: 86400,
  maxTimeoutSeconds: 1209600
};

export function buildNewModerationRule(type: ModerationRuleType): ModerationRule {
  const reasonByType: Record<ModerationRuleType, string> = {
    caps: 'Please do not use so many caps',
    links: 'Please do not post links',
    emote_spam: 'Please do not spam emotes',
    blacklist: 'You used a blocked word or phrase'
  };

  return {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    firstOffense: { action: 'warn', timeoutSeconds: 60 },
    secondOffense: { action: 'delete', timeoutSeconds: 60 },
    thirdOffense: { action: 'timeout', timeoutSeconds: 60 },
    reason: reasonByType[type],
    exemptUserLevel: MODERATION_DEFAULTS.exemptUserLevel,
    capsThresholdMode: 'count',
    minCapsCount: MODERATION_DEFAULTS.minCapsCount,
    maxCapsPercentage: MODERATION_DEFAULTS.maxCapsPercentage,
    minMessageLength: MODERATION_DEFAULTS.minMessageLength,
    allowlistDomains: [],
    maxEmoteCount: MODERATION_DEFAULTS.maxEmoteCount,
    terms: []
  };
}
