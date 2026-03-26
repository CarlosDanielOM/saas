import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'admin' | 'none';

export interface TtsSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  provider: 'piper';
  defaultLanguage: 'en' | 'es';
  voices: {
    en: string;
    es: string;
    aiDefault: string | null;
  };
  filters: {
    skipEmotes: boolean;
    stripLinks: boolean;
    normalizeWhitespace: boolean;
    maxLength: number;
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
