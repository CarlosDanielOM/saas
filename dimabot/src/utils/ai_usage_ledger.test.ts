import assert from 'node:assert/strict';
import test from 'node:test';

import { createAiUsageContext } from './ai_usage_event.js';
import {
    buildQueuedAiUsageReceipt,
    getAiUsageRetentionDays,
    parseQueuedAiUsageReceipt,
} from './ai_usage_ledger.js';

test('retention is 30 days for Free, 60 for Premium, and 90 for Pro', () => {
    assert.equal(getAiUsageRetentionDays('free'), 30);
    assert.equal(getAiUsageRetentionDays('premium'), 60);
    assert.equal(getAiUsageRetentionDays('pro'), 90);
    assert.equal(getAiUsageRetentionDays('unknown'), 30);
});

test('queued receipts contain only itemized receipt fields', () => {
    const context = createAiUsageContext('tts_fish', {
        entryId: 'entry-1', requestId: 'request-1', channelID: 'channel-1',
        category: 'tts', operation: 'synthesize', source: 'chat-command', provider: 'fish',
        quantity: 100, unit: 'characters', resourceType: 'speech', resourceId: 'speech-1',
    });
    const receipt = buildQueuedAiUsageReceipt({
        channelID: 'channel-1', customerId: 'customer-1', context, credits: 150,
        occurredAt: new Date('2026-09-19T12:00:00.000Z'),
    });

    assert.deepEqual(receipt, {
        channelID: 'channel-1', customerId: 'customer-1', id: 'entry-1', requestId: 'request-1',
        occurredAt: '2026-09-19T12:00:00.000Z', entryKind: 'usage', category: 'tts',
        operation: 'synthesize', provider: 'fish', model: null, quantity: 100, unit: 'characters',
        credits: 150, resourceType: 'speech', resourceId: 'speech-1', itemized: true,
    });
    assert.equal('prompt' in receipt!, false);
    assert.equal('message' in receipt!, false);
    assert.equal('cost' in receipt!, false);
});

test('queued receipt parsing rejects malformed payloads and normalizes adjustments', () => {
    assert.equal(parseQueuedAiUsageReceipt('{'), null);
    assert.equal(parseQueuedAiUsageReceipt(JSON.stringify({ channelID: 'channel' })), null);
    const parsed = parseQueuedAiUsageReceipt(JSON.stringify({
        channelID: 'channel', customerId: 'customer', id: 'grant',
        occurredAt: '2026-09-19T12:00:00.000Z', credits: -5000,
        entryKind: 'usage', category: 'credit_adjustment', operation: 'grant', provider: 'polar', itemized: true,
    }));
    assert.equal(parsed?.entryKind, 'adjustment');
    assert.equal(parsed?.credits, -5000);
});
