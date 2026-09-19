import type { AiUsageBillingPeriod } from './ai_usage_receipts.js';

export type FreeCreditResetStatus = 'initialized' | 'pending' | 'completed';

export interface FreeCreditResetRecordLike {
  periodStart: Date | string;
  periodEnd: Date | string;
  status: FreeCreditResetStatus;
  credits: number;
  externalId: string;
}

export type FreeCreditResetDecision =
  | { action: 'initialize'; externalId: string }
  | { action: 'skip' }
  | { action: 'complete_zero'; externalId: string }
  | { action: 'grant'; credits: number; externalId: string };

function timestamp(value: Date | string | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function buildFreeCreditResetExternalId(userId: string, periodStart: Date): string {
  return `free-credit-reset-${userId}-${periodStart.toISOString().slice(0, 10)}`;
}

export function decideFreeCreditReset(input: {
  userId: string;
  period: Pick<AiUsageBillingPeriod, 'source' | 'startsAt'>;
  previous?: FreeCreditResetRecordLike | null;
  usedCredits?: number;
  maximumResetCredits: number;
}): FreeCreditResetDecision {
  if (input.period.source !== 'free_monthly') return { action: 'skip' };
  const periodStart = new Date(input.period.startsAt);
  if (Number.isNaN(periodStart.getTime())) return { action: 'skip' };
  const externalId = buildFreeCreditResetExternalId(input.userId, periodStart);
  const previousPeriodStart = timestamp(input.previous?.periodStart);

  // Existing users are baselined into their current period on first rollout.
  // This prevents a one-time mid-cycle refill for every historical Free account.
  if (previousPeriodStart === null) return { action: 'initialize', externalId };

  if (previousPeriodStart > periodStart.getTime()) return { action: 'skip' };
  if (previousPeriodStart === periodStart.getTime()) {
    if (input.previous?.status !== 'pending') return { action: 'skip' };
    const pendingCredits = Math.max(0, Math.floor(Number(input.previous.credits) || 0));
    return pendingCredits > 0
      ? { action: 'grant', credits: pendingCredits, externalId: input.previous.externalId || externalId }
      : { action: 'complete_zero', externalId: input.previous.externalId || externalId };
  }

  const maximum = Math.max(0, Math.floor(Number(input.maximumResetCredits) || 0));
  const used = Math.max(0, Math.floor(Number(input.usedCredits) || 0));
  const credits = Math.min(used, maximum);
  return credits > 0
    ? { action: 'grant', credits, externalId }
    : { action: 'complete_zero', externalId };
}
