import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseAudioCandidates,
    parseVideoVerificationResults
} from './openrouter_clip_recommendations.client.js';

test('audio candidates are bounded to the supplied segment and invalid values are rejected', () => {
    const candidates = parseAudioCandidates({
        clips: [
            { startSeconds: 10.9, endSeconds: 30.2, reason: 'Strong reaction', confidence: 1.5 },
            { startSeconds: 50, endSeconds: 90, reason: 'Late payoff', confidence: Number.NaN },
            { startSeconds: 58, endSeconds: 90, reason: 'Too close to the end', confidence: 0.8 },
            { startSeconds: 70, endSeconds: 80, reason: 'Outside the segment', confidence: 0.8 },
            { startSeconds: 35, endSeconds: 30, reason: 'Reversed timestamps', confidence: 0.8 },
            { startSeconds: 20, endSeconds: 40, reason: 'Overlaps the first clip', confidence: 0.8 },
            { startSeconds: 'invalid', endSeconds: 20, reason: 'Invalid timestamp', confidence: 0.8 }
        ]
    }, 24, 60);

    assert.deepEqual(candidates, [
        { startSeconds: 10, endSeconds: 30, reason: 'Strong reaction', confidence: 1 },
        { startSeconds: 50, endSeconds: 60, reason: 'Late payoff', confidence: 0 }
    ]);
});

test('video verification maps by index and fails closed on malformed approvals', () => {
    const results = parseVideoVerificationResults({
        results: [
            { index: 1, approved: 'false', why: 'String boolean must not approve' },
            { index: 0, approved: true, why: 'Visible payoff' },
            { index: 0, approved: false, why: 'Duplicate must be ignored' },
            { index: 9, approved: true, why: 'Out of range' }
        ]
    }, 3);

    assert.deepEqual(results, [
        { approved: true, why: 'Visible payoff' },
        { approved: false, why: 'String boolean must not approve' },
        { approved: false, why: 'No valid verification result returned by model.' }
    ]);
});
