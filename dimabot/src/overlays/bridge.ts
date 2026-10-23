import type { OverlayPlatform } from './controls.js';
import type { EventKind } from './model.js';
import type { LiveMedia } from './live.js';
// Queue producers stay independent of the HTTP/AST/store initialization graph.
export type ReadTtsPublication = 'emitted' | 'unavailable' | 'cancelled';
export interface ReadTtsDelivery { beforeEmit?: () => boolean; cancelled?: () => boolean; speechID: string; durationMs: number; text: string; legacy: boolean; file?: string; mime?: string }
interface Bridge {
  readTts?(channel: string, input: ReadTtsDelivery): Promise<ReadTtsPublication | void>;
  endReadTts?(channel: string, speechID: string): Promise<void>;
  hasLiveSource?(channel: string, kind: EventKind): boolean;
  hasSource(channel: string, kind: EventKind): boolean;
  media(channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform?: OverlayPlatform, speechID?: string): Promise<void>;
  ttsStatus?(channel: string, currentSpeechID?: string): Promise<{ connected: boolean; playing: boolean; queueLength: number }>;
  controlTts?(channel: string, action: 'skip' | 'clear' | 'refresh'): Promise<void>;
  trigger(channel: string, body: Record<string, unknown>, platform?: OverlayPlatform): Promise<void>;
}
let bridge: Bridge | undefined;
export function registerStudioBridge(value: Bridge) { bridge = value; }
export const publishStudioReadTts = (channel: string, input: ReadTtsDelivery) => bridge?.readTts?.(channel, input) ?? Promise.resolve('unavailable' as const);
export const endStudioReadTts = (channel: string, speechID: string) => bridge?.endReadTts?.(channel, speechID) ?? Promise.resolve();
export const studioHasLiveSource = (channel: string, kind: EventKind) => bridge?.hasLiveSource?.(channel, kind) ?? bridge?.hasSource(channel, kind) ?? false;
export const studioHasSource = (channel: string, kind: EventKind) => bridge?.hasSource(channel, kind) ?? false;
export const publishStudioMedia = (channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform?: OverlayPlatform, speechID?: string) => bridge?.media(channel, kind, media, file, mime, text, platform, speechID) ?? Promise.resolve();
export const publishStudioTrigger = (channel: string, body: Record<string, unknown>, platform?: OverlayPlatform) => bridge?.trigger(channel, body, platform);

export const controlStudioTts = (channel: string, action: 'skip' | 'clear' | 'refresh') => bridge?.controlTts?.(channel, action) ?? Promise.resolve();

export const studioTtsStatus = (channel: string, currentSpeechID?: string) => bridge?.ttsStatus?.(channel, currentSpeechID) ?? Promise.resolve({ connected: false, playing: false, queueLength: 0 });
