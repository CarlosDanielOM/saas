export type MemorySubjectScope = 'channel' | 'user';
export type MemorySource = 'chat' | 'mod' | 'streamer' | 'system';
export type MemoryType = 'preference' | 'running_joke' | 'known_user_fact' | 'channel_lore' | 'boundary';
export type MemoryStatus = 'candidate' | 'pending_review' | 'confirmed' | 'rejected' | 'archived';
export type MemoryRisk = 'low' | 'medium' | 'high';

export interface MemorySubject {
  scope: MemorySubjectScope;
  username: string;
  userID: string;
}

export interface MemoryEvidence {
  source: MemorySource;
  username: string;
  userID: string;
  message: string;
  messageId: string;
  timestamp: number;
}

export interface MemoryActor {
  source: MemorySource;
  username: string;
  userID: string;
}

export interface Memory {
  _id: string;
  channelID: string;
  channel: string;
  type: MemoryType;
  status: MemoryStatus;
  risk: MemoryRisk;
  confidence: number;
  subject: MemorySubject;
  content: string;
  summary: string;
  fingerprint: string;
  sourceEvidence: MemoryEvidence[];
  createdBy: MemoryActor;
  reviewedBy?: MemoryActor;
  reviewReason: string;
  reviewedAt?: string;
  useCount: number;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListMemoriesParams {
  statuses?: MemoryStatus[];
  types?: MemoryType[];
  risks?: MemoryRisk[];
  limit?: number;
  skip?: number;
}

export interface ListMemoriesResponse {
  items: Memory[];
  total: number;
}

export interface UpdateMemoryRequest {
  content?: string;
  summary?: string;
  type?: MemoryType;
  risk?: MemoryRisk;
}

export interface UpdateMemoryStatusRequest {
  status: MemoryStatus;
  reason?: string;
}

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  candidate: 'Candidate',
  pending_review: 'Needs Review',
  confirmed: 'Active',
  rejected: 'Denied',
  archived: 'Archived'
};

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  preference: 'Preference',
  running_joke: 'Running Joke',
  known_user_fact: 'Known User Fact',
  channel_lore: 'Channel Lore',
  boundary: 'Boundary'
};

export const MEMORY_RISK_LABELS: Record<MemoryRisk, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk'
};
