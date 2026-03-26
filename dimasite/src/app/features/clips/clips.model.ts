export type ClipDesignStatus = 'stable' | 'beta' | 'alpha' | 'coming_soon';
export type PlanTier = 'free' | 'premium' | 'pro';

export interface ClipDesign {
  id: string;
  name: string;
  description: string;
  previewUrl: string;
  thumbnailUrl: string;
  designNumber: number;
  premium: boolean;
  premiumPlus: boolean;
  status: ClipDesignStatus;
  features: string[];
  accentColor: string;
  isLocked?: boolean;
}

export interface ClipTestRequest {
  channelID: string;
  streamer: string;
  timeout?: number;
}

export interface ClipTestResponse {
  error: boolean;
  message: string;
  status: number;
  data?: {
    clip?: {
      message?: string;
    };
  };
}

export interface ClipWebSocketMessage {
  type: 'play-clip' | 'clip-ended' | 'ping';
  channelID?: string;
  clipID?: string;
  data?: Record<string, unknown>;
}

export interface ClipConfig {
  timeoutSeconds: number;
  selectedDesignId: string | null;
}

export interface UserClipSettings {
  channelID: string;
  login: string;
  planTier: PlanTier;
}
