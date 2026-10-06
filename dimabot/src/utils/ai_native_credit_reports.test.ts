import assert from 'node:assert/strict';
import test from 'node:test';
import { meterCreditEventFromJSON } from '@polar-sh/sdk/models/components/metercreditevent.js';
import { normalizePolarCreditEvent, fetchAiUsageTransactions, resolveAiUsageWindow, buildAiUsageSummary } from './ai_usage_receipts.js';

const meterId = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const credit = (metadata: Record<string, unknown> = {}) => ({
    id: '6ea2dbab-2e34-4b59-bf76-b78a7c71737e', name: 'meter.credited', source: 'system',
    timestamp: '2026-10-06T21:48:10.251928Z', metadata: { meter_id: meterId, units: 40_000, rollover: true, ...metadata },
});

test('native credits are reporting adjustments with stable IDs and permanent/period labels', () => {
    const receipt = normalizePolarCreditEvent(credit())!;
    assert.equal(receipt.id, 'polar-credit:6ea2dbab-2e34-4b59-bf76-b78a7c71737e');
    assert.equal(receipt.credits, -40_000);
    assert.equal(receipt.entryKind, 'adjustment');
    assert.equal(receipt.category, 'credit_adjustment');
    assert.equal(receipt.operation, 'permanent_credit_grant');
    assert.equal(receipt.source, 'polar_meter_credit');
    assert.equal(receipt.adjustmentType, 'native_grant');
    assert.equal(receipt.provider, 'polar');
    assert.equal(normalizePolarCreditEvent(credit({ rollover: false }))?.operation, 'period_credit_grant');
    assert.equal(normalizePolarCreditEvent({ ...credit(), source: 'user' }), null);
    assert.equal(normalizePolarCreditEvent({ ...credit(), name: 'benefit.granted' }), null);
    assert.equal(normalizePolarCreditEvent({ ...credit(), id: undefined }), null);
    assert.equal(normalizePolarCreditEvent({ ...credit(), timestamp: 'invalid' }), null);
    for (const units of [0, -1, null, '', true, '40000', NaN, Infinity]) {
        assert.equal(normalizePolarCreditEvent(credit({ units })), null);
    }
    assert.equal(normalizePolarCreditEvent(credit({ meter_id: 'another-meter' })), null);
    assert.equal(normalizePolarCreditEvent(credit({ rollover: undefined })), null);
});

test('both event streams paginate, deduplicate, respect the date window, and isolate spend totals', async () => {
    const window = resolveAiUsageWindow({ from: '2026-10-06', to: '2026-10-06', timeZone: 'UTC', now: new Date('2026-10-07T00:00:00Z') });
    const requests: string[] = [];
    const records = await fetchAiUsageTransactions('customer', window, async request => {
        requests.push(`${request.name}:${request.source}:${request.page}`);
        const events = request.source === 'system'
            ? [credit(), credit(), { ...credit(), id: 'old', timestamp: '2026-10-05T23:59:59Z' }, credit({ meter_id: 'other' })]
            : [{ id: 'usage', name: 'ai_usage', source: 'user', timestamp: '2026-10-06T20:00:00Z', metadata: { credits: 110 } }];
        return { items: events, pagination: { maxPage: request.source === 'system' ? 2 : 1 } };
    });
    assert.deepEqual(requests, ['ai_usage:user:1', 'meter.credited:system:1', 'meter.credited:system:2']);
    assert.equal(records.length, 2);
    const summary = buildAiUsageSummary(records, window);
    assert.equal(summary.grantedCredits, 40_000);
    assert.equal(summary.totalSpentCredits, 110);
    assert.equal(summary.transactionCount, 1);
    assert.equal(summary.netConsumedCredits, -39_890);
    assert.equal(summary.daily[0].credits, 110);
});

test('SDK-parsed native event metadata is recognized alongside raw Polar JSON', () => {
    const parsed = meterCreditEventFromJSON(JSON.stringify({ ...credit(), organization_id: 'organization',
        customer_id: 'customer', customer: null, external_customer_id: null, child_count: 0, label: 'Meter credited' }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.metadata.meterId, meterId);
    assert.equal(normalizePolarCreditEvent(parsed.value)?.credits, -40000);
    assert.equal(normalizePolarCreditEvent({ ...parsed.value, metadata: { ...parsed.value.metadata, meterId: 'other-meter' } }), null);
});
