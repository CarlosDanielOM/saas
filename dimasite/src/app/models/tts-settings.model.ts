import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'manager' | 'admin' | 'none';
export type TtsProvider = 'piper' | 'fish' | 'kokoro';

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
    kokoroDefault?: string;
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
  playback: {
    /** Every open speech URL plays every message (off: one copy that can play it). */
    allOutputs: boolean;
  };
}

/** Open copies of the speech URL (OBS browser sources, browser tabs) and what is wrong with them. */
export interface TtsOutputsSummary {
  total: number;
  playable: number;
  hidden: number;
  blocked: number;
  failing: number;
  /** Copies from before the API could report problems (they need a refresh). */
  unknown: number;
  mode: 'one' | 'all';
}

export interface TtsStatus {
  connected: boolean;
  playing: boolean;
  preparing: boolean;
  queueLength: number;
  outputs?: TtsOutputsSummary;
}

export interface TtsSettingsResponseData {
  role: TtsRole;
  settings: TtsSettings;
  kokoroVoices?: string[];
}

export type TtsSettingsResponse = ApiEnvelope<TtsSettingsResponseData>;

export interface FishVoice {
  id: string;
  name: string;
  languages: string[];
  gender: 'female' | 'male' | null;
  licensed: boolean | null;
  description?: string;
  tags?: string[];
  coverUrl?: string | null;
  /** Fish's own sample clip: free to play, no credits. */
  sample?: { url: string; text: string } | null;
  uses?: number | null;
}
export interface FishVoiceFavorite { id: string; name: string; alias: string; }
export interface FishVoiceResults { items: FishVoice[]; page: number; hasMore: boolean; }
export interface FishVoiceFilters {
  name: string;
  gender: string;
  language: string;
  license: string;
  page: number;
}
export interface VoicePreview {
  provider?: TtsProvider;
  voiceId: string;
  text: string;
  credits: number;
  mimeType: string;
  audio: string;
}

export type FishPreview = VoicePreview;
