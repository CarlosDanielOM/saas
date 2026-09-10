import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'admin' | 'none';
export type TtsProvider = 'piper' | 'fish';

export const EXPRESSIVE_TTS_TAG_GROUPS = {
  emotions: [
    'happy', 'sad', 'angry', 'excited', 'calm', 'nervous',
    'confident', 'surprised', 'scared', 'worried', 'disappointed', 'curious',
    'sarcastic', 'satisfied', 'delighted', 'upset', 'frustrated', 'depressed',
    'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed',
    'grateful', 'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent',
    'uncertain', 'doubtful', 'confused', 'regretful', 'guilty', 'ashamed',
    'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic',
    'lonely', 'bored', 'contemptuous', 'sympathetic', 'compassionate', 'determined',
    'resigned',
  ],
  delivery: [
    'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast',
    'emphasis', 'screaming',
  ],
  sounds: [
    'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp',
    'inhale', 'exhale', 'sobbing', 'groaning', 'panting', 'yawning',
    'snoring', 'clear throat',
  ],
  effects: [
    'pause', 'long-pause', 'audience laughing', 'background laughter',
  ],
} as const;

export const EXPRESSIVE_TTS_TAGS = Object.values(EXPRESSIVE_TTS_TAG_GROUPS).flat();
export type ExpressiveTtsTag = typeof EXPRESSIVE_TTS_TAGS[number];

export interface TtsSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  provider: TtsProvider;
  defaultLanguage: 'en' | 'es';
  voices: {
    en: string;
    es: string;
    cloneDefault?: string;
  };
  filters: {
    skipEmotes: boolean;
    stripLinks: boolean;
    normalizeWhitespace: boolean;
    maxLength: number;
    expressiveTags: Record<ExpressiveTtsTag, boolean>;
  };
  queue: {
    maxItems: number;
  };
}

export interface TtsSettingsResponseData {
  role: TtsRole;
  settings: TtsSettings;
}

export type TtsSettingsResponse = ApiEnvelope<TtsSettingsResponseData>;
