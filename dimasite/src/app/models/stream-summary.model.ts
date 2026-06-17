import { ApiEnvelope } from './admin.model';

export type StreamSummaryStatus = 'pending' | 'applied' | 'noop' | 'failed';
export type StreamSummarySource = 'stream_offline' | 'weekly_maintenance' | 'monthly_maintenance' | 'manual';

export interface MemoryProposal {
  action: 'create' | 'edit' | 'archive' | 'delete' | 'noop';
  type?: string;
  targetMemoryId?: string;
  summary?: string;
  content?: string;
  confidence?: number;
  risk?: 'low' | 'medium' | 'high';
  reason?: string;
  evidence?: string[];
}

export interface MemoryActionResult {
  action: 'create' | 'edit' | 'archive' | 'delete' | 'noop';
  targetMemoryId?: string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  error?: string;
}

export interface MemoryActionTotals {
  proposed: number;
  applied: number;
  skipped: number;
  failed: number;
}

export interface StreamSummary {
  _id: string;
  channelID: string;
  channel: string;
  stream_session_id: string;
  stream_id: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  average_viewers: number;
  peak_viewers: number;
  follows: number;
  subs: number;
  bits: number;
  donations: number;
  headline: string;
  recap: string;
  highlights: string[];
  chat_messages_sampled: number;
  snapshot_count: number;
  proposed_actions: MemoryProposal[];
  applied_actions: MemoryActionResult[];
  totals: MemoryActionTotals;
  status: StreamSummaryStatus;
  error_message: string;
  source: StreamSummarySource;
  created_at: string;
  updated_at: string;
}

export interface StreamSummariesListResponseData {
  items: StreamSummary[];
  total: number;
}

export type StreamSummariesListResponse = ApiEnvelope<StreamSummariesListResponseData>;
export type StreamSummaryDetailResponse = ApiEnvelope<StreamSummary>;
