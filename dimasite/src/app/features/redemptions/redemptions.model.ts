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
  global_cooldown_setting?: {
    global_cooldown_seconds: number;
  };
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
