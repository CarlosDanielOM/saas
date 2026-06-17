import { ApiEnvelope } from './admin.model';

export type PersonaMode = 'original' | 'inspired' | 'strict_roleplay';
export type TonePreset = 'family_friendly' | 'balanced' | 'dark_humor';

export interface AiVoiceProfile {
  tone: string;
  cadence: string;
  style: string;
  catchphrases: string[];
}

export interface AiPersonalityProfile {
  profileID: string;
  name: string;
  personality: string;
  personaMode: PersonaMode;
  personaReference: string;
  tonePreset: TonePreset;
  voiceProfile: AiVoiceProfile;
  createdAt?: string;
  updatedAt?: string;
}

export interface AiKnownUser {
  username: string;
  description: string;
  relationship: string;
  lastInteraction?: string;
}

export interface AiLearningConfig {
  enabled: boolean;
  autoConfirmEnabled: boolean;
  autoConfirmThreshold: number;
  minMessageLength: number;
  maxPendingMemories: number;
  maxConfirmedMemories: number;
  postStreamSummaryEnabled: boolean;
  weeklyMaintenanceEnabled: boolean;
  monthlyMaintenanceEnabled: boolean;
  autoApplyCreates: boolean;
  autoApplyEdits: boolean;
  autoApplyArchives: boolean;
  autoApplyPermanentDeletes: boolean;
  summaryMinDurationMinutes: number;
  summaryMinChatMessages: number;
  createMinConfidence: number;
  editMinConfidence: number;
  archiveMinConfidence: number;
  deleteMinConfidence: number;
  maxActionsPerRun: number;
  maxDeletesPerRun: number;
  minMemoryAgeDaysForDelete: number;
  minUnusedDaysForDelete: number;
}

export interface AiMemoryPolicy {
  prioritizeRecentChat: boolean;
  allowSensitiveMemories: boolean;
  allowUserPreferenceMemories: boolean;
  allowRunningJokes: boolean;
}

export interface AiPersonalityTierInfo {
  isPremiumPlus: boolean;
  isPremium: boolean;
  limits: {
    profiles: number;
    rules: number | string;
    knownUsers: number | string;
    contextWindow: number;
  };
}

export interface AiPersonalitySettings {
  _id?: string;
  channelID: string;
  channel: string;
  enabled: boolean;
  streamSummariesEnabled: boolean;
  recommendationsEnabled: boolean;
  profiles: AiPersonalityProfile[];
  activeProfileId: string;
  personality: string;
  personaMode: PersonaMode;
  personaReference: string;
  tonePreset: TonePreset;
  voiceProfile: AiVoiceProfile;
  learningConfig: AiLearningConfig;
  memoryPolicy: AiMemoryPolicy;
  rules: string[];
  knownUsers: AiKnownUser[];
  contextWindow: number;
  createdAt?: string;
  updatedAt?: string;
  tier: AiPersonalityTierInfo;
}

export interface UpdateAiPersonalityRequest {
  enabled: boolean;
  streamSummariesEnabled: boolean;
  recommendationsEnabled: boolean;
  profiles: AiPersonalityProfile[];
  activeProfileId: string;
  personality: string;
  personaMode: PersonaMode;
  personaReference: string;
  tonePreset: TonePreset;
  voiceProfile: AiVoiceProfile;
  learningConfig: AiLearningConfig;
  memoryPolicy: AiMemoryPolicy;
  rules: string[];
  knownUsers: AiKnownUser[];
}

export type AiPersonalityResponse = ApiEnvelope<AiPersonalitySettings>;
