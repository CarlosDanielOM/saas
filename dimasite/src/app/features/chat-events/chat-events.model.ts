export type ReleaseStage = 'stable' | 'beta' | 'alpha' | 'coming_soon' | 'maintenance' | 'unavailable' | 'deprecated';

export type PlanTier = 'none' | 'premium' | 'premium_plus';

export type ChatEventPendingAction = 'none' | 'enabling' | 'disabling' | 'saving' | 'deleting';

export interface CheerTier {
  id: string;
  name: string;
  message: string;
  minAmount: number;
  maxAmount: number;
}

export interface ConfigControl {
  id: string;
  dbId?: string;
  label: { en: string; es: string };
  type: 'text' | 'number' | 'checkbox' | 'message-tiers' | 'select';
  value: string | number | boolean | CheerTier[];
  placeholder?: string;
  showIf?: { controlId: string; is: unknown };
  canDisable?: boolean;
}

export interface TierLimits {
  premium: number;
  pro: number;
}

export interface ChatEvent {
  name: string;
  type: string;
  version: string;
  condition?: { [key: string]: string | undefined };
  description: { en: string; es: string };
  icon: string;
  color: string;
  textColor: string;
  releaseStage: ReleaseStage;
  enabled: boolean;
  premium?: boolean;
  pro?: boolean;
  isConfiguring?: boolean;
  isSubscribed?: boolean;
  subscriptionId?: string;
  config?: ConfigControl[];
  tierLimits?: TierLimits;
}

export interface UserEventConfig {
  name: string;
  enabled: boolean;
  subscriptionId?: string;
  config?: Partial<ConfigControl>[];
}

export interface BackendSubscription {
  _id: string;
  id?: string;
  status: string;
  type: string;
  version: string;
  enabled: boolean;
  condition: {
    broadcaster_user_id?: string;
    [key: string]: string | undefined;
  };
  transport: {
    method: string;
    callback: string;
  };
  created_at: string;
  cost: number;
  [key: string]: unknown;
}

export type EventStatusTone = 'ok' | 'danger' | 'warn' | 'info' | 'muted' | 'alpha' | 'beta';

export interface EventDisplayStatus {
  text: string;
  glyph: string;
  tone: EventStatusTone;
}

export interface UserAccess {
  canAccess: boolean;
  reason?: 'needs_premium' | 'needs_pro';
}

export interface TierInfoMessage {
  message: string;
  level: 'upsell-pro' | 'upsell-premium' | 'limit-reached';
}
