export type ClipRecommendationStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ClipRecommendationCandidateStatus = 'pending' | 'approved' | 'rejected' | 'confirmed' | 'denied';

export interface TwitchVodInfo {
  id: string;
  title: string;
  url: string;
  duration: string;
  durationMinutes: number;
  createdAt: string;
  thumbnailUrl: string;
}

export interface ClipRecommendationCandidate {
  _id: string;
  startSeconds: number;
  endSeconds: number;
  reason: string;
  audioConfidence: number;
  videoApproved: boolean;
  videoWhy: string;
  s3Key: string;
  previewUrl: string;
  status: ClipRecommendationCandidateStatus;
  twitchClipID: string;
  created_at: string;
}

export interface ClipRecommendation {
  _id: string;
  channelID: string;
  channel: string;
  sessionID: string;
  streamID: string;
  vodID: string;
  vodUrl: string;
  source: 'stream_offline' | 'manual';
  status: ClipRecommendationStatus;
  requestedBy: string;
  modelID: string;
  vodDurationMinutes: number;
  costCredits: number;
  candidateCount: number;
  approvedCount: number;
  errorMessage: string;
  candidates: ClipRecommendationCandidate[];
  startedAt: string | null;
  completedAt: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClipRecommendationConfig {
  autoAnalyzeEnabled: boolean;
  canAutoAnalyze: boolean;
  planTier: 'free' | 'premium' | 'pro';
  lastAnalyzedAt: string | null;
  pricing: {
    baseCredits: number;
    baseMinutes: number;
    extraCreditsPerMinute: number;
  };
}

export interface ApiEnvelope<T> {
  error: boolean;
  message: string;
  status: number;
  data?: T;
}
