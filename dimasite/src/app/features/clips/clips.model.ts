export type ClipDesignStatus = 'stable' | 'beta' | 'alpha' | 'coming_soon';
export type PlanTier = 'free' | 'premium' | 'pro';

export const CLIP_DESIGN_VARIANTS = ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash'] as const;
export type ClipDesignVariant = typeof CLIP_DESIGN_VARIANTS[number];
export interface ClipMetadata { streamer: string; game: string; description: string; profileImage?: string; streamerColor?: string }

export interface ClipDesign {
  id: string;
  name: string;
  description: string;
  previewUrl: string;
  thumbnailUrl: string;
  designNumber: number;
  variant: ClipDesignVariant;
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
