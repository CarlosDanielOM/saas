import type {
    ClipRecommendationBillingStatus,
    ClipRecommendationNotificationStatus,
    ClipRecommendationStatus
} from '../../../schemas/clip_recommendation.schema.js';

export type ClipRecommendationRecoveryAction =
    | 'return-completed'
    | 'retry-billing'
    | 'retry-notification'
    | 'rerun-analysis'
    | 'refuse-charged';

export function decideClipRecommendationRecovery(state: {
    status: ClipRecommendationStatus;
    billingStatus?: ClipRecommendationBillingStatus;
    analysisCompletedAt?: Date | null;
    notificationStatus?: ClipRecommendationNotificationStatus;
}): ClipRecommendationRecoveryAction {
    if (
        state.analysisCompletedAt
        && state.billingStatus === 'charged'
        && (state.notificationStatus === 'pending' || state.notificationStatus === 'failed')
    ) {
        return 'retry-notification';
    }
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
