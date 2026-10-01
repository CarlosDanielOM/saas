/** Event origin is independent of the platform where an OBS source is shown. */
export const OVERLAY_PLATFORMS = ['twitch', 'kick', 'other'] as const;
export type OverlayPlatform = typeof OVERLAY_PLATFORMS[number];
export type OverlayScope = OverlayPlatform | 'all';
export const OVERLAY_ACTIONS = ['skip', 'pause', 'resume', 'clear'] as const;
export type OverlayAction = typeof OVERLAY_ACTIONS[number];
export interface QueueState { revision: number; all: boolean; platforms: Partial<Record<OverlayPlatform, boolean>> }
export interface QueueCommand { id: string; action: 'skip' | 'clear'; platform: OverlayScope; eventIds: string[] }
export const initialQueueState = (): QueueState => ({ revision: 0, all: false, platforms: {} });
export const platformMatches = (scope: OverlayScope, platform: OverlayPlatform) => scope === 'all' || scope === platform;
