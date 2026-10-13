export interface TimelineStream { id: string; startedAt: string; endedAt: string | null; status: 'live' | 'offline' | 'orphaned'; }
export interface TimelinePoint { offsetSeconds: number; viewers: number; messagesPerMinute: number | null; gap: boolean; title: string; game: string; }
export interface TimelineEvent { id: string; kind: 'game' | 'title' | 'raid' | 'redemption' | 'note'; offsetSeconds: number; label: string; value?: number; }
export interface StreamTimeline {
  session: TimelineStream & { durationSeconds: number };
  points: TimelinePoint[];
  chatters: { offsetSeconds: number; count: number | null }[];
  events: TimelineEvent[];
  canAnnotate: boolean;
  coverage: { retentionDays: number; chatterTrackingStartedAt: string | null; truncated: boolean };
  asOf: string;
}
export interface TimelineStreamList { streams: TimelineStream[]; page: number; hasMore: boolean; }
export interface TimelineResponse<T> { error: boolean; data?: T; }
