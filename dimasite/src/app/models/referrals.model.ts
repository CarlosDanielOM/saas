export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export type ReferralPlanType = 'FREE' | 'PREMIUM' | 'PRO';
export type ReferralViewerRole = 'owner' | 'admin' | 'none';

export interface ReferralCodeRecord {
  _id: string;
  code: string;
  owner: string;
  label: string;
  stats: {
    signups: number;
    conversions: number;
  };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralStatsData {
  planType: ReferralPlanType;
  codeLimit: number;
  codesUsed: number;
  codesRemaining: number;
  codes: ReferralCodeRecord[];
  totalSignups: number;
  totalConversions: number;
  totalEarned: number;
  currentBalance: number;
  channelID: string;
  role: ReferralViewerRole;
}

export type ReferralStatsResponse = ApiEnvelope<ReferralStatsData>;
export type ReferralCodeCreateResponse = ApiEnvelope<ReferralCodeRecord>;

export type ReferralLedgerView = 'people' | 'timeline';

export interface ReferralPerson {
  id: string;
  name: string;
  code: string;
  signedUpAt: string;
  tier: 'free' | 'premium' | 'pro';
  creditsEarned: number;
}

export interface ReferralTimelineEvent {
  id: string;
  kind: 'signup' | 'reward';
  userId: string;
  name: string;
  code: string;
  at: string;
  credits: number;
}

export interface ReferralLedgerPage<T> {
  view: ReferralLedgerView;
  items: T[];
  page: number;
  hasMore: boolean;
}

export type ReferralPeopleResponse = ApiEnvelope<ReferralLedgerPage<ReferralPerson>>;
export type ReferralTimelineResponse = ApiEnvelope<ReferralLedgerPage<ReferralTimelineEvent>>;
