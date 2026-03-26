export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export type FollowLedgerViewerRole = 'owner' | 'admin' | 'none';
export type FollowLedgerStatus = 'active' | 'ended' | 'all';
export type FollowLedgerMutualFilter = 'all' | 'mutual' | 'non-mutual';
export type FollowLedgerSortOrder = 'asc' | 'desc';

export interface FollowLedgerRow {
  follower_id: string;
  follower_login: string;
  follower_name: string;
  mutual: boolean;
  status: Exclude<FollowLedgerStatus, 'all'>;
  followed_at: string;
  ended_at: string | null;
}

export interface FollowLedgerSummary {
  activeCount: number;
  mutualCount: number;
  nonMutualCount: number;
}

export interface FollowLedgerPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FollowLedgerFilters {
  status: FollowLedgerStatus;
  mutual: FollowLedgerMutualFilter;
  order: FollowLedgerSortOrder;
  search: string;
}

export interface FollowLedgerResponseData {
  role: FollowLedgerViewerRole;
  channelID: string;
  channelName: string;
  filters: FollowLedgerFilters;
  rows: FollowLedgerRow[];
  pagination: FollowLedgerPagination;
  summary: FollowLedgerSummary;
}

export interface FollowLedgerQuery {
  status?: FollowLedgerStatus;
  mutual?: FollowLedgerMutualFilter;
  order?: FollowLedgerSortOrder;
  search?: string;
  page?: number;
  limit?: number;
}

export type FollowLedgerResponse = ApiEnvelope<FollowLedgerResponseData>;
