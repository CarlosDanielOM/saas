export type FollowDefenseMode = 'normal' | 'silent' | 'protection' | 'attack';
export type FollowDefenseLanguage = 'en' | 'es';

export interface FollowDefenseSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  silentModeEnabled: boolean;
  protectionModeEnabled: boolean;
  attackModeEnabled: boolean;
  resetAttackOnNewRaid: boolean;
  silentThresholdX: number;
  silentWindowYSeconds: number;
  protectionThresholdB: number;
  attackThreshold: number;
  silentDurationSeconds: number;
  baselineFollowsPerHour: number | null;
  language: FollowDefenseLanguage;
  settingsVersion: number;
}

export interface FollowDefenseStatus {
  mode: FollowDefenseMode;
  channelID: string;
  channelLogin: string;
  channelName: string;
  modeStartedAt: number;
  burstStartedAt: number;
  expiresAt: number;
  triggeredBy: 'threshold' | 'manual';
  lastTransitionReason: string;
  lastUpdatedAt: number;
  trackedCount?: number;
  raid?: FollowDefenseRaidMarker | null;
}

export interface FollowDefenseRaidMarker {
  raiderChannelID: string;
  raiderChannelLogin: string;
  raiderChannelName: string;
  raidViewers: number;
  createdAt: number;
  expiresAt: number;
}

export interface FollowDefenseAttackLogEntry {
  id: string;
  channelID: string;
  channelLogin: string;
  channelName: string;
  triggeredMode: FollowDefenseMode;
  triggeredBy: 'threshold' | 'manual';
  totalFollows: number;
  velocity: number;
  isRaid: boolean;
  raiderChannelID?: string;
  raiderChannelLogin?: string;
  raiderChannelName?: string;
  bannedCount: number;
  createdAt: number;
  followedAt?: number;
  banError?: string;
}

export interface FollowDefenseHateRaidSource {
  id: string;
  raiderChannelID: string;
  raiderChannelLogin: string;
  raiderChannelName: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  lastRaidViewers?: number;
}

export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export interface FollowDefenseSettingsResponse extends ApiEnvelope<FollowDefenseSettings> {
  role?: 'owner' | 'admin' | 'viewer';
}

export interface FollowDefenseStatusResponse extends ApiEnvelope<FollowDefenseStatus> {}

export interface FollowDefenseAttackLogsResponse extends ApiEnvelope<{
  entries: FollowDefenseAttackLogEntry[];
  total: number;
  page: number;
  limit: number;
}> {}

export interface FollowDefenseHateRaidSourcesResponse extends ApiEnvelope<{
  sources: FollowDefenseHateRaidSource[];
  total: number;
  page: number;
  limit: number;
}> {}

export interface FollowDefenseActivateResponse extends ApiEnvelope<{
  success: boolean;
  historicalOnly?: boolean;
  mode: FollowDefenseMode;
}> {}

export interface FollowDefenseResetResponse extends ApiEnvelope<{
  success: boolean;
  mode: FollowDefenseMode;
}> {}

export interface RaidSession {
  id: string;
  raiderLogin: string;
  raiderName: string;
  viewers: number;
  startedAt: string;
  expiresAt: string;
  retentionHours: number;
  totalFollows: number;
  collecting: boolean;
  banning: boolean;
  canIncludeFuture: boolean;
  outcomes: Partial<Record<RaidBanStatus, number>>;
}
export type RaidBanStatus = 'unrequested' | 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface RaidFollower {
  id: string;
  userID: string;
  login: string;
  name: string;
  followedAt: string;
  banStatus: RaidBanStatus;
}
export interface RaidSessionsPage { sessions: RaidSession[]; total: number; page: number; limit: number; canBan: boolean }
export interface RaidFollowersPage { followers: RaidFollower[]; total: number; page: number; limit: number }
