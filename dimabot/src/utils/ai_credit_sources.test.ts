import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPolarCreditSources, type CreditSourceReads } from './ai_credit_sources.js';

const meter = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const credit = (id = 'credit', rollover = true, timestamp: string | Date = '2026-10-08T00:00:00.000Z') =>
    ({ id, name: 'meter.credited', timestamp, metadata: { meter_id: meter, units: 40_000, rollover } });
const benefit = (id = 'benefit', timestamp: string | Date = '2026-10-08T00:00:00.100Z') =>
    ({ id, name: 'benefit.granted', timestamp, metadata: { benefit_type: 'meter_credit', benefit_id: 'b', benefit_grant_id: 'g' } });
const grant = (subscription = false) => ({ id: 'g', customer_id: 'customer', benefit_id: 'b',
    order_id: subscription ? null : 'order', subscription_id: subscription ? 'sub' : null,
    benefit: { id: 'b', type: 'meter_credit', properties: { meter_id: meter, units: 40_000, rollover: !subscription } } });
const order = () => ({ id: 'order', customer_id: 'customer', product_id: '45c32959-3fa2-41a6-855c-bbeafcf9ce3c',
    subscription_id: null, paid: true, total_amount: 100, metadata: {} as Record<string, unknown> });
const reads = (g = grant(), o = order()): CreditSourceReads => ({ grant: async () => g, order: async () => o });

test('separates subscription, permanent and period purchases, and gifted credit sources', async () => {
    assert.equal((await classifyPolarCreditSources('customer', [credit(), benefit()], reads())).get('credit'), 'purchased_pack');
    const periodGrant = grant(); periodGrant.benefit.properties.rollover = false;
    assert.equal((await classifyPolarCreditSources('customer', [credit('credit', false), benefit()], reads(periodGrant))).get('credit'), 'purchased_pack');
    const subGrant = grant(true); subGrant.benefit.properties.units = 800_000;
    assert.equal((await classifyPolarCreditSources('customer', [credit('credit', false), benefit()], reads(subGrant))).get('credit'), 'subscription_credits', 'historical subscription quantities may differ from the current benefit');
    const gift = order(); gift.product_id = 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a'; gift.total_amount = 0;
    gift.metadata = { source: 'dimabot_gift_fulfillment', gift_id: 'gift' };
    assert.equal((await classifyPolarCreditSources('customer', [credit(), benefit()], reads(grant(), gift))).get('credit'), 'gifted_credits');
});

test('ambiguous, missing, cross-customer, wrong-meter and mismatched grants stay unclassified', async () => {
    const cases = [
        { events: [credit()] },
        { events: [credit(), benefit(), benefit('another')] },
        { events: [credit(), credit('another'), benefit()] },
        { events: [credit(), benefit('late', '2026-10-08T00:00:05.001Z')] },
        { events: [credit(), benefit('before', '2026-10-07T23:59:59.999Z')] },
        { events: [credit(), benefit()], g: { ...grant(), customer_id: 'other' } },
        { events: [credit(), benefit()], g: { ...grant(), benefit_id: 'other' } },
        { events: [credit(), benefit()], g: { ...grant(), benefit: { ...grant().benefit, properties: { meter_id: 'other', units: 40_000, rollover: true } } } },
        { events: [credit(), benefit()], g: { ...grant(), benefit: { ...grant().benefit, properties: { meter_id: meter, units: 250_000, rollover: true } } } },
        { events: [credit(), benefit()], o: { ...order(), customer_id: 'other' } },
        { events: [credit(), benefit()], o: { ...order(), paid: false } },
        { events: [credit(), benefit()], o: { ...order(), product_id: 'unknown' } },
        { events: [credit(), benefit()], o: { ...order(), product_id: '6e0c530d-affc-44be-a51b-e11453ef1fa7', metadata: { source: 'dimabot_gift_purchase' } } },
    ];
    for (const c of cases) assert.equal((await classifyPolarCreditSources('customer', c.events, reads(c.g, c.o))).size, 0);
    assert.equal((await classifyPolarCreditSources('customer', [credit(), benefit()], { ...reads(), grant: async () => null })).size, 0,
        'a deleted or missing grant stays unclassified');
});

test('supports SDK dates/camel metadata, caches grant/order reads and propagates provider failures', async () => {
    const events = [credit('credit', true, new Date('2026-10-08T00:00:00.250Z')),
        { ...benefit('benefit', new Date('2026-10-08T00:00:00.350Z')), metadata: { benefitType: 'meter_credit', benefitId: 'b', benefitGrantId: 'g' } },
        credit('second', true, new Date('2026-10-08T01:00:00.250Z')), benefit('second-benefit', new Date('2026-10-08T01:00:00.350Z'))];
    let grants = 0, orders = 0;
    const result = await classifyPolarCreditSources('customer', events, {
        grant: async () => { grants++; return grant(); }, order: async () => { orders++; return order(); },
    });
    assert.equal(result.size, 2); assert.equal(grants, 1); assert.equal(orders, 1);
    await assert.rejects(() => classifyPolarCreditSources('customer', events, {
        ...reads(), grant: async () => { throw new Error('Provider unavailable'); },
    }), /Provider unavailable/);
});
