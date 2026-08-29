import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'admin' | 'none';
export type TtsProvider = 'piper' | 'fish';

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
