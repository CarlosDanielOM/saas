export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export interface DashboardKpis {
  activeViewers: number;
  averageViewers: number;
  monthlyAverageViewers: number;
  averageHoursPerStream: number;
  totalBits: number;
  totalStreams: number;
  totalDonations: number;
  activeFollows: number;
  activeSubs: number;
  monthlyGoalSubs: number;
  subsProgressPct: number;
}

export interface DashboardTrendPoint {
  date: string;
  viewers: number;
  hours: number;
}

export interface DashboardStreamHistoryPoint {
  date: string;
  viewers: number;
  hours: number;
  bits: number;
  donations: number;
  follows: number;
  subs: number;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  is_mature: boolean;
}

export interface DashboardChannel {
  id: string;
  name: string;
  chatEnabled: boolean;
}

export interface DashboardBootstrapData {
  role: 'owner' | 'admin' | 'viewer';
  channel: DashboardChannel;
  isLive: boolean;
  liveStream: TwitchStream | null;
  kpis: DashboardKpis;
  trend: DashboardTrendPoint[];
  streamHistory: DashboardStreamHistoryPoint[];
  totalFollowers: number;
  totalSubs: number;
  monthlyGoals: {
    followersGoal: number;
    followersCurrent: number;
    subsGoal: number;
    subsCurrent: number;
  };
}

export interface LiveSessionMetrics {
  isLive: boolean;
  startedAt: string | null;
  durationMinutes: number;
  averageViewers: number;
  peakViewers: number;
  currentViewers: number;
  follows: number;
  subs: number;
  bits: number;
  donations: number;
}

export interface DashboardLiveStatusData {
  isLive: boolean;
  checkedAt: string;
  stream: TwitchStream | null;
  liveSession: LiveSessionMetrics | null;
}

export interface DashboardAccessData {
  allowed: boolean;
  role?: 'owner' | 'admin' | 'viewer';
  channelID?: string;
  channelName?: string;
  planTier?: 'free' | 'premium' | 'pro';
}

export type DashboardBootstrapResponse = ApiEnvelope<DashboardBootstrapData>;
export type DashboardLiveStatusResponse = ApiEnvelope<DashboardLiveStatusData>;
export type DashboardAccessResponse = ApiEnvelope<DashboardAccessData>;
