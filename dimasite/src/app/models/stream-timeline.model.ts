export interface TimelineStream { id: string; startedAt: string; endedAt: string | null; status: 'live' | 'offline' | 'orphaned'; }
export interface TimelinePoint { offsetSeconds: number; viewers: number; messagesPerMinute: number | null; commandsPerMinute?: number | null; gap: boolean; title: string; game: string; }
export interface TimelineEvent { id: string; kind: 'game' | 'title' | 'raid' | 'redemption' | 'note' | 'follow' | 'sub' | 'gift' | 'bits'; offsetSeconds: number; label: string; value?: number; rewardID?: string; cost?: number; status?: string; }
export interface TimelineRank { key: string; label: string; count: number; errors?: number; messages?: number; }
export interface TimelineActivity {
  totals: { messages: number; commands: number; emotes: number; emoteMessages: number; redemptions: number; follows: number; subs: number; bits: number; raids: number } | null;
  commands: TimelineRank[]; emotes: TimelineRank[];
  series: { offsetSeconds: number; commands?: number; emotes?: number; messages: number; chatters: number }[];
  coverageStartedAt: string | null; chatterStartedAt: string | null; updatedAt: string | null; pending: boolean; truncated: boolean;
  planTier: 'free' | 'premium' | 'pro'; capabilities: { trends: boolean; comparison: boolean; users: boolean };
}
export interface TimelinePeople { items: { id: string; label: string; count: number; errors: number }[]; cursor: string | null; }
export interface TimelineCredits { items: { id: string; offsetSeconds: number; category: string; operation: string; provider: string; model: string | null; credits: number; entryKind: string }[]; truncated: boolean; }
export interface StreamTimeline {
  session: TimelineStream & { durationSeconds: number };
  points: TimelinePoint[];
  chatters: { offsetSeconds: number; count: number | null }[];
  events: TimelineEvent[];
  canAnnotate: boolean;
  canSeeCredits?: boolean;
  activity?: TimelineActivity;
  markerPage?: { hasMore: boolean; cursor: string | null };
  coverage: { retentionDays: number; chatterTrackingStartedAt: string | null; truncated: boolean };
  asOf: string;
}
export interface TimelineStreamList { streams: TimelineStream[]; page: number; hasMore: boolean; }
export interface TimelineResponse<T> { error: boolean; data?: T; }
