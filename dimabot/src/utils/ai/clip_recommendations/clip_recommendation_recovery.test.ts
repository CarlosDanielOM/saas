import assert from 'node:assert/strict';
import test from 'node:test';
import { decideClipRecommendationRecovery } from './clip_recommendation_recovery.js';

test('interrupted uncharged analysis is resumed on the existing record', () => {
    assert.equal(decideClipRecommendationRecovery({
        status: 'processing',
        billingStatus: 'pending',
        analysisCompletedAt: null
    }), 'rerun-analysis');
});

test('completed analysis with pending or failed billing retries only billing', () => {
    assert.equal(decideClipRecommendationRecovery({
        status: 'completed',
        billingStatus: 'pending',
        analysisCompletedAt: new Date()
    }), 'retry-billing');
    assert.equal(decideClipRecommendationRecovery({
        status: 'completed',
        billingStatus: 'failed',
        analysisCompletedAt: new Date()
    }), 'retry-billing');
});

test('charged and legacy completed records are not executed again', () => {
    assert.equal(decideClipRecommendationRecovery({
        status: 'completed',
        billingStatus: 'charged',
        analysisCompletedAt: new Date()
    }), 'return-completed');
    assert.equal(decideClipRecommendationRecovery({
        status: 'completed',
        analysisCompletedAt: null
    }), 'return-completed');
});

test('a charged record without completed analysis is refused', () => {
    assert.equal(decideClipRecommendationRecovery({
        status: 'processing',
        billingStatus: 'charged',
        analysisCompletedAt: null
    }), 'refuse-charged');
});
