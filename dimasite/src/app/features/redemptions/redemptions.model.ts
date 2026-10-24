/** Redemptions model definitions */

export type PlanTier = 'none' | 'premium' | 'premium_plus';
export type EditMode = 'none' | 'inline' | 'bulk';
export type PendingAction = 'none' | 'saving' | 'deleting' | 'refreshing';

export interface Redemption {
  id: string;
  eventsubID: string;
  channelID: string;
  channel: string;
  rewardID?: string;
  title: string;
  type: 'custom' | 'twitch';
  prompt: string;
  cost: number;
  originalCost?: number;
  costChange?: number;
  returnToOriginalCost?: boolean;
  isEnabled: boolean;
  message: string;
  duration: number;
  cooldown: number;
  userInput?: boolean;
  skipQueue?: boolean;
  background_color?: string;
  /** Twitch reward icon (custom image or Twitch's default), hydrated from Twitch. */
  imageUrl?: string;
  /** Paused on Twitch: visible to viewers but can't be redeemed. */
  isPaused?: boolean;
  /** Live from Twitch (never stored by us): 0 = no limit. */
  maxPerStream?: number;
  maxPerUserPerStream?: number;
  /** Redeems so far this stream; Twitch only reports it while live with a per-stream limit. */
  redeemedThisStream?: number | null;
  /** False once the per-stream limit is used up. */
  isInStock?: boolean;
  /** ISO time the shared cooldown ends, when it's cooling down. */
  cooldownEndsAt?: string | null;
}

export interface TwitchRewardImage {
  url_1x: string;
  url_2x: string;
  url_4x: string;
}

export interface TwitchRedemption {
  id: string;
  broadcaster_id: string;
  broadcaster_login: string;
  title: string;
  prompt: string;
  cost: number;
  is_enabled: boolean;
  background_color: string;
  is_paused?: boolean;
  is_user_input_required?: boolean;
  should_redemptions_skip_request_queue?: boolean;
  image?: TwitchRewardImage | null;
  default_image?: TwitchRewardImage | null;
  global_cooldown_setting?: {
    is_enabled?: boolean;
    global_cooldown_seconds: number;
  };
  max_per_stream_setting?: {
    is_enabled: boolean;
    max_per_stream: number;
  };
  max_per_user_per_stream_setting?: {
    is_enabled: boolean;
    max_per_user_per_stream: number;
  };
  is_in_stock?: boolean;
  redemptions_redeemed_current_stream?: number | null;
  cooldown_expires_at?: string | null;
}

export interface RedemptionCreateRequest {
  title: string;
  cost: number;
  prompt?: string;
  cooldown?: number;
  duration?: number;
  userInput?: boolean;
  skipQueue?: boolean;
  background_color?: string;
  message?: string;
  /** 0 = no limit. Stored on Twitch only. */
  maxPerStream?: number;
  maxPerUserPerStream?: number;
  type: 'custom';
  isEnabled: boolean;
  // Premium fields
  originalCost?: number;
  costChange?: number;
  returnToOriginalCost?: boolean;
}

export interface RedemptionUpdateRequest {
  title?: string;
  prompt?: string;
  cost?: number;
  cooldown?: number;
  duration?: number;
  userInput?: boolean;
  skipQueue?: boolean;
  background_color?: string;
  message?: string;
  isEnabled?: boolean;
  isPaused?: boolean;
  /** 0 = no limit. Stored on Twitch only. */
  maxPerStream?: number;
  maxPerUserPerStream?: number;
  // Premium fields
  originalCost?: number;
  costChange?: number;
  returnToOriginalCost?: boolean;
}

export interface EditingState {
  redemptionId: string;
  field: string;
  value: unknown;
  originalValue: unknown;
}

export interface ColorPickerState {
  redemptionId: string;
  isOpen: boolean;
  value: string;
}

export interface BulkEditState {
  redemptionId: string;
  originalValues: Partial<Redemption>;
}

export interface ApiResponse<T> {
  error: boolean;
  message: string;
  data?: T;
}

/** PATCH /rewards also returns Twitch's updated copy, the source of truth for limits and pause. */
export interface RewardUpdateResponse extends ApiResponse<Redemption> {
  twitch?: TwitchRedemption;
}

export interface RewardUpdateResult {
  reward: Redemption;
  twitch: TwitchRedemption | null;
}

/** Twitch's longest shared cooldown (7 days). */
export const MAX_COOLDOWN_SECONDS = 604_800;

export const PRESET_COLORS = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Green
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#6b7280', // Gray
  '#000000', // Black
  '#ffffff', // White
] as const;

export const REDEMPTIONS_CACHE_TTL_MS = 300_000; // 5 minutes
