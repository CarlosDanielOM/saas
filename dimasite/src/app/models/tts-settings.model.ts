import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'admin' | 'none';
export type TtsProvider = 'piper' | 'fish';

export const EXPRESSIVE_TTS_TAGS = [
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident',
  'surprised', 'scared', 'worried', 'disappointed', 'curious', 'sarcastic',
  'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast', 'emphasis',
  'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp', 'inhale', 'exhale',
  'pause', 'long-pause',
] as const;
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
