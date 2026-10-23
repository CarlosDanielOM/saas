import type { PetSettings } from '../../models/pet-settings.model';

export interface PetRequestView {
  requestId: string;
  operation: 'talk' | 'ask' | 'tts';
  status: 'accepted' | 'generating' | 'synthesizing' | 'ready' | 'playing' | 'completed' | 'cancelled' | 'failed' | 'expired';
  version: number;
  text?: string;
  errorCode?: string;
}
export interface PetDesktopSession { sessionId: string; label: string; audioReady: boolean; vtsReady: boolean }
export interface PetOwnerRuntime { v: 1; generation: number; active: PetRequestView | null; sessions: PetDesktopSession[] }
export interface PetOverlayToken { token: string | null; exists: boolean; version: string | null }
export interface PetSnapshot {
  v: 1;
  serverTime: number;
  peerId: string;
  generation: number;
  settingsRevision: number;
  appearance: PetSettings['appearance'];
  playback: PetSettings['playback'];
  assets: { idleUrl: string | null; talkingUrl: string | null };
  active: PetRequestView | null;
  lease: { leaseId: string; holderPeerId: string; expiresAt: number } | null;
}
export interface PetPlay {
  v: 1;
  requestId: string;
  generation: number;
  leaseId: string;
  startBefore: number;
  audio: { url: string; mimeType: 'audio/wav' | 'audio/mpeg'; durationMs: number };
}
export type PetAck<T> = { ok: true; data: T } | { ok: false; error: { code: string; retryAfterMs?: number } };
export interface PetLease { leaseId: string; generation: number; serverTime: number; expiresAt: number; ttlMs: number }
