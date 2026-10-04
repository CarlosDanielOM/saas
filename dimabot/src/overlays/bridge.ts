import type { OverlayPlatform } from './controls.js';
import type { EventKind } from './model.js';
import type { LiveMedia } from './live.js';
// Queue producers stay independent of the HTTP/AST/store initialization graph.
interface Bridge {
  hasSource(channel: string, kind: EventKind): boolean;
  media(channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform?: OverlayPlatform): Promise<void>;
  trigger(channel: string, body: Record<string, unknown>, platform?: OverlayPlatform): Promise<void>;
}
let bridge: Bridge | undefined;
export function registerStudioBridge(value: Bridge) { bridge = value; }
export const studioHasSource = (channel: string, kind: EventKind) => bridge?.hasSource(channel, kind) ?? false;
export const publishStudioMedia = (channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform?: OverlayPlatform) => bridge?.media(channel, kind, media, file, mime, text, platform) ?? Promise.resolve();
export const publishStudioTrigger = (channel: string, body: Record<string, unknown>, platform?: OverlayPlatform) => bridge?.trigger(channel, body, platform);
