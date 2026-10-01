export type OverlayPlatform = 'twitch' | 'kick' | 'other';
export type OverlayScope = OverlayPlatform | 'all';
export type OverlayAction = 'skip' | 'pause' | 'resume' | 'clear';
export interface QueueState { revision: number; all: boolean; platforms: Partial<Record<OverlayPlatform, boolean>> }
export interface QueueCommand { id: string; action: 'skip' | 'clear'; platform: OverlayScope; eventIds: string[] }
export interface QueueStatus {
  state: QueueState; connected: number; needsRefresh: number;
  events: { id: string; kind: string; platform: OverlayPlatform; status: 'playing' | 'queued' }[];
}
