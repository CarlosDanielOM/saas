export type PetProvider = 'piper' | 'kokoro' | 'fish';
/** Where $(pet.ask) waits: the shared TTS queue, or the pet's own queue. $(pet.talk) always uses the TTS queue. */
export type PetAskLane = 'independent' | 'tts';

export interface PetSettings {
  enabled: boolean;
  sources: { independent: boolean; readTts: boolean };
  ttsAudio: 'pet' | 'overlay';
  name: string;
  appearance: { kind: 'png' | 'vts'; idleAssetId: string | null; talkingAssetId: string | null };
  playback: { target: 'browser' | 'desktop'; desktopSessionId: string | null; vtsSessionId: string | null };
  tts: { enabled: boolean; provider: PetProvider; language: 'en' | 'es'; voice: string };
  personality: { source: 'custom' | 'profile'; profileId: string; prompt: string };
  rules: string[];
  behavior: { respondToChat: boolean; respondToEvents: boolean; cooldownSeconds: number; maxReplyLength: number; queueSize: number; askLane: PetAskLane };
}

export interface PetConfiguration {
  schemaVersion: 3;
  revision: number;
  updatedAt: string | null;
  settings: PetSettings;
  profiles: Array<{ id: string; name: string }>;
  voices: Array<{ provider: PetProvider; id: string; name: string; language: string }>;
  runtime: { enabled: boolean; issues: string[]; playbackAvailable: boolean };
}
