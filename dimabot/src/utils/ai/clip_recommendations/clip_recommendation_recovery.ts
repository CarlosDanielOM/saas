import type { ClipRecommendationStatus, ClipRecommendationBillingStatus } from '../../../schemas/clip_recommendation.schema.js';

export type ClipRecommendationRecoveryAction =
    | 'return-completed'
    | 'retry-billing'
    | 'rerun-analysis'
    | 'refuse-charged';

export function decideClipRecommendationRecovery(state: {
    status: ClipRecommendationStatus;
    billingStatus?: ClipRecommendationBillingStatus;
    analysisCompletedAt?: Date | null;
}): ClipRecommendationRecoveryAction {
    if (state.status === 'completed' && (!state.analysisCompletedAt || state.billingStatus === 'charged')) {
        return 'return-completed';
    }
    if (state.analysisCompletedAt && state.billingStatus !== 'charged') {
        return 'retry-billing';
    }
    if (state.billingStatus === 'charged') {
        return 'refuse-charged';
    }
    return 'rerun-analysis';
}
