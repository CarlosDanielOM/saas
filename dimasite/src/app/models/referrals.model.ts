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
  totalConversions: number;
  totalEarned: number;
  currentBalance: number;
  channelID: string;
  role: ReferralViewerRole;
}

export type ReferralStatsResponse = ApiEnvelope<ReferralStatsData>;
export type ReferralCodeCreateResponse = ApiEnvelope<ReferralCodeRecord>;
