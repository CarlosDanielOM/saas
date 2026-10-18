export type PetProvider = 'piper' | 'kokoro' | 'fish';

export interface PetSettings {
  enabled: boolean;
  name: string;
  tts: { enabled: boolean; provider: PetProvider; language: 'en' | 'es'; voice: string };
  personality: { source: 'custom' | 'profile'; profileId: string; prompt: string };
  rules: string[];
  behavior: { respondToChat: boolean; respondToEvents: boolean; cooldownSeconds: number; maxReplyLength: number };
}

export interface PetConfiguration {
  schemaVersion: 1;
  revision: number;
  updatedAt: string | null;
  settings: PetSettings;
  profiles: Array<{ id: string; name: string }>;
  voices: Array<{ provider: PetProvider; id: string; name: string; language: string }>;
  runtime: { enabled: boolean; issues: string[]; playbackAvailable: false };
}
