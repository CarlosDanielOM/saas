import { ApiEnvelope } from './admin.model';

export type TtsRole = 'owner' | 'admin' | 'none';
export type TtsProvider = 'piper' | 'xai' | 'openrouter' | 'fish';
export type AiTtsProvider = 'xai' | 'openrouter';
export type OpenRouterTtsModel = 'openai/gpt-4o-mini-tts-2025-12-15' | 'hexgrad/kokoro-82m';

export interface AiVoiceMap {
  en: string;
  es: string;
}

export interface XaiInlineSpeechTagSettings {
  pause: boolean;
  longPause: boolean;
  humTune: boolean;
  laugh: boolean;
  chuckle: boolean;
  giggle: boolean;
  cry: boolean;
  tsk: boolean;
  tongueClick: boolean;
  lipSmack: boolean;
  breath: boolean;
  inhale: boolean;
  exhale: boolean;
  sigh: boolean;
}

export interface XaiWrappingSpeechTagSettings {
  soft: boolean;
  whisper: boolean;
  loud: boolean;
  buildIntensity: boolean;
  decreaseIntensity: boolean;
  higherPitch: boolean;
  lowerPitch: boolean;
  slow: boolean;
  fast: boolean;
  singSong: boolean;
  singing: boolean;
  laughSpeak: boolean;
  emphasis: boolean;
}

export interface XaiExpressiveTagSettings {
  inline: XaiInlineSpeechTagSettings;
  wrapping: XaiWrappingSpeechTagSettings;
}

export interface TtsSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  provider: TtsProvider;
  aiProvider: AiTtsProvider;
  defaultLanguage: 'en' | 'es';
  voices: {
    en: string;
    es: string;
    aiDefault: string | null;
    aiVoices?: AiVoiceMap;
    aiVoicesByProvider?: {
      xai: AiVoiceMap;
      openrouter: AiVoiceMap;
    };
    cloneDefault?: string;
  };
  filters: {
    skipEmotes: boolean;
    stripLinks: boolean;
    normalizeWhitespace: boolean;
    maxLength: number;
    expressiveTags: XaiExpressiveTagSettings;
  };
  queue: {
    maxItems: number;
  };
  providerSettings: {
    openrouter: {
      model: OpenRouterTtsModel;
    };
  };
}

export interface TtsSettingsResponseData {
  role: TtsRole;
  settings: TtsSettings;
}

export type TtsSettingsResponse = ApiEnvelope<TtsSettingsResponseData>;
