export type CreditPackKind = 'credits' | 'recharge';
export type CreditPackSize = 'sample' | 'small' | 'starter' | 'medium';

export interface CreditPackDefinition {
    readonly id: string;
    readonly kind: CreditPackKind;
    readonly size: CreditPackSize;
    readonly order: number;
}

export const CREDIT_PACK_DEFINITIONS = [
    {
        id: '45c32959-3fa2-41a6-855c-bbeafcf9ce3c',
        kind: 'credits',
        size: 'sample',
        order: 0
    },
    {
        id: '2f446a84-69a9-42f6-96ed-6be2b31fdf0c',
        kind: 'credits',
        size: 'starter',
        order: 1
    },
    {
        id: '4315e89b-bf47-4ddd-a889-e6be6056853d',
        kind: 'credits',
        size: 'medium',
        order: 2
    },
    {
        id: '44d391d1-8952-408d-ad51-06200404d3ad',
        kind: 'recharge',
        size: 'small',
        order: 0
    },
    {
        id: '44a6baba-e057-4af7-82c4-ec8ddd528913',
        kind: 'recharge',
        size: 'starter',
        order: 1
    },
    {
        id: 'ac85860a-dee1-4399-9c32-932229d112c1',
        kind: 'recharge',
        size: 'medium',
        order: 2
    }
] as const satisfies readonly CreditPackDefinition[];

interface PolarPriceLike {
    type?: string;
    amount_type?: string;
    price_amount?: number;
    price_currency?: string;
    is_archived?: boolean;
}

interface PolarMeterCreditBenefitLike {
    type?: string;
    properties?: {
        units?: number;
        rollover?: boolean;
        meter_id?: string;
    };
}

export interface PolarCreditPackProductLike {
    id?: string;
    name?: string;
    visibility?: string;
    is_archived?: boolean;
    prices?: PolarPriceLike[];
    benefits?: PolarMeterCreditBenefitLike[];
}

export interface CreditPackOffer {
    id: string;
    name: string;
    kind: CreditPackKind;
    size: CreditPackSize;
    credits: number;
    rollover: boolean;
    priceAmount: number;
    priceCurrency: string;
    eligible: boolean;
    eligibilityReason: 'paid_plan_required' | null;
}

export class CreditPackConfigurationError extends Error {}

export function getCreditPackDefinition(productId: string): CreditPackDefinition | null {
    return CREDIT_PACK_DEFINITIONS.find((pack) => pack.id === productId) ?? null;
}

export function buildCreditPackOffers(
    products: readonly PolarCreditPackProductLike[],
    aiCreditsMeterId: string,
    hasActivePaidSubscription: boolean
): CreditPackOffer[] {
    const productsById = new Map(products.map((product) => [product.id, product]));

    return CREDIT_PACK_DEFINITIONS.map((definition) => {
        const product = productsById.get(definition.id);
        if (!product) {
            throw new CreditPackConfigurationError(`Polar credit pack ${definition.id} is missing`);
        }
        if (product.is_archived || product.visibility === 'draft') {
            throw new CreditPackConfigurationError(`Polar credit pack ${definition.id} is unavailable`);
        }

        const price = product.prices?.find((candidate) =>
            candidate.type === 'one_time'
            && candidate.amount_type === 'fixed'
            && candidate.is_archived !== true
            && Number.isFinite(candidate.price_amount)
        );
        if (!price || typeof price.price_amount !== 'number' || !price.price_currency) {
            throw new CreditPackConfigurationError(`Polar credit pack ${definition.id} has no active fixed price`);
        }

        const benefit = product.benefits?.find((candidate) =>
            candidate.type === 'meter_credit'
            && candidate.properties?.meter_id === aiCreditsMeterId
        );
        const units = benefit?.properties?.units;
        const rollover = benefit?.properties?.rollover;
        if (!Number.isFinite(units) || typeof units !== 'number' || units <= 0 || typeof rollover !== 'boolean') {
            throw new CreditPackConfigurationError(`Polar credit pack ${definition.id} has an invalid credit benefit`);
        }

        const expectedRollover = definition.kind === 'credits';
        if (rollover !== expectedRollover) {
            throw new CreditPackConfigurationError(
                `Polar credit pack ${definition.id} rollover does not match its configured type`
            );
        }

        const eligible = definition.kind === 'credits' || hasActivePaidSubscription;
        return {
            id: definition.id,
            name: product.name || definition.size,
            kind: definition.kind,
            size: definition.size,
            credits: Math.round(units),
            rollover,
            priceAmount: Math.round(price.price_amount),
            priceCurrency: price.price_currency.toLowerCase(),
            eligible,
            eligibilityReason: eligible ? null : 'paid_plan_required'
        };
    });
}
