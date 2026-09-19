import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CREDIT_PACK_DEFINITIONS,
    CreditPackConfigurationError,
    buildCreditPackOffers,
    getCreditPackDefinition,
    type PolarCreditPackProductLike
} from './credit_packs.js';

const METER_ID = 'meter-ai';

function product(
    definition: (typeof CREDIT_PACK_DEFINITIONS)[number],
    units: number
): PolarCreditPackProductLike {
    return {
        id: definition.id,
        name: `${definition.size} ${definition.kind}`,
        visibility: 'private',
        is_archived: false,
        prices: [{
            type: 'one_time',
            amount_type: 'fixed',
            price_amount: 500,
            price_currency: 'usd',
            is_archived: false
        }],
        benefits: [{
            type: 'meter_credit',
            properties: {
                units,
                rollover: definition.kind === 'credits',
                meter_id: METER_ID
            }
        }]
    };
}

const configuredProducts = CREDIT_PACK_DEFINITIONS.map((definition, index) =>
    product(definition, (index + 1) * 10_000)
);

test('credit packs are available to every authenticated user and retain rollover', () => {
    const offers = buildCreditPackOffers(configuredProducts, METER_ID, false);
    const creditOffers = offers.filter((offer) => offer.kind === 'credits');

    assert.equal(creditOffers.length, 3);
    assert.ok(creditOffers.every((offer) => offer.eligible));
    assert.ok(creditOffers.every((offer) => offer.rollover));
});

test('recharge packs require an active paid subscription and remain non-rollover', () => {
    const locked = buildCreditPackOffers(configuredProducts, METER_ID, false)
        .filter((offer) => offer.kind === 'recharge');
    assert.ok(locked.every((offer) => !offer.eligible));
    assert.ok(locked.every((offer) => offer.eligibilityReason === 'paid_plan_required'));
    assert.ok(locked.every((offer) => !offer.rollover));

    const unlocked = buildCreditPackOffers(configuredProducts, METER_ID, true)
        .filter((offer) => offer.kind === 'recharge');
    assert.ok(unlocked.every((offer) => offer.eligible));
});

test('catalog validation fails closed when Polar rollover configuration drifts', () => {
    const drifted = structuredClone(configuredProducts);
    drifted[0].benefits![0].properties!.rollover = false;

    assert.throws(
        () => buildCreditPackOffers(drifted, METER_ID, true),
        CreditPackConfigurationError
    );
});

test('only the six allowlisted Polar products resolve as credit packs', () => {
    assert.ok(getCreditPackDefinition(CREDIT_PACK_DEFINITIONS[0].id));
    assert.equal(getCreditPackDefinition('00000000-0000-4000-8000-000000000000'), null);
});
