export type PetProvider = 'piper' | 'kokoro' | 'fish';

export interface PetSettings {
  enabled: boolean;
  name: string;
  appearance: { kind: 'png' | 'vts'; idleAssetId: string | null; talkingAssetId: string | null };
  playback: { target: 'browser' | 'desktop'; desktopSessionId: string | null; vtsSessionId: string | null };
  tts: { enabled: boolean; provider: PetProvider; language: 'en' | 'es'; voice: string };
  personality: { source: 'custom' | 'profile'; profileId: string; prompt: string };
  rules: string[];
  behavior: { respondToChat: boolean; respondToEvents: boolean; cooldownSeconds: number; maxReplyLength: number };
}

export interface PetConfiguration {
  schemaVersion: 2;
  revision: number;
  updatedAt: string | null;
  settings: PetSettings;
  profiles: Array<{ id: string; name: string }>;
  voices: Array<{ provider: PetProvider; id: string; name: string; language: string }>;
  runtime: { enabled: boolean; issues: string[]; playbackAvailable: boolean };
}
