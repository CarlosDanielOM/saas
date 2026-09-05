import type { DomainEventProducer, JournalDomainEventInput } from './domain_event.types.js';
import { resolveDomainEventOwner } from './domain_event_identity.js';

/** Transport must verify the signature and supply the signed webhook-id header. */
export interface NormalizePolarWebhookInput {
    webhookId: string;
    event: { type: string; timestamp: Date; data: unknown };
}

export interface PolarBillingPayload extends Record<string, unknown> {
    customerId: string;
    orderId?: string;
    subscriptionId?: string;
    productId?: string;
    paid?: boolean;
    status?: string;
    cadence?: 'monthly' | 'yearly';
    periodEnd?: string | null;
    meters?: Array<{
        meter_id: string;
        consumed_units?: number;
        credited_units?: number;
        balance?: number;
    }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Polar webhook requires ${field}`);
    }
    return value;
}

function optionalString(value: unknown, field: string): string | undefined {
    return value == null ? undefined : requiredString(value, field);
}

function serializeDate(value: unknown, field: string): string | null | undefined {
    if (value === undefined || value === null) return value;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error(`Polar webhook requires a finite Date for ${field}`);
    }
    return value.toISOString();
}

function cadence(interval: unknown): 'monthly' | 'yearly' {
    if (interval === 'month') return 'monthly';
    if (interval === 'year') return 'yearly';
    throw new Error('Polar webhook requires a supported subscription recurringInterval');
}

export function normalizePolarDomainEvent(input: NormalizePolarWebhookInput): JournalDomainEventInput {
    const sourceEventId = requiredString(input?.webhookId, 'webhookId');
    const originalEventType = requiredString(input.event?.type, 'event.type');
    const timestamp = input.event.timestamp;
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new Error('Polar webhook requires a finite event.timestamp');
    }
    const data = input.event.data;
    if (!isRecord(data)) throw new Error('Polar webhook requires record event.data');
    const resourceId = requiredString(data.id, 'data.id');
    const customerEvent = originalEventType.startsWith('customer.');
    const customer = isRecord(data.customer) ? data.customer : undefined;
    let customerId = customerEvent ? resourceId : optionalString(data.customerId ?? customer?.id, 'customerId');
    const externalCustomerId = optionalString(customerEvent ? data.externalId : customer?.externalId, 'externalCustomerId');
    const customerMetadata = isRecord(customer?.metadata) ? customer.metadata : undefined;
    const eventMetadata = isRecord(data.metadata) ? data.metadata : undefined;
    const legacyTwitchChannelId = optionalString(customerMetadata?.twitch_user_id ?? eventMetadata?.twitch_user_id, 'legacyTwitchChannelId');
    const metadata: Record<string, unknown> = {
        originalEventType,
        ...(externalCustomerId === undefined ? {} : { externalCustomerId }),
        ...(legacyTwitchChannelId === undefined ? {} : { legacyTwitchChannelId })
    };
    let type: string;
    let payload: Record<string, unknown>;

    if (originalEventType === 'order.paid' || originalEventType === 'subscription.updated') {
        customerId = requiredString(data.customerId, 'customerId');
        const billing: PolarBillingPayload = {
            customerId,
            status: requiredString(data.status, 'status')
        };
        if (originalEventType === 'order.paid') {
            if (data.paid !== true) throw new Error('Polar order.paid requires paid=true');
            type = 'billing.order.paid';
            billing.orderId = resourceId;
            billing.paid = true;
            const productId = optionalString(data.productId, 'productId');
            const subscriptionId = optionalString(data.subscriptionId, 'subscriptionId');
            if (productId !== undefined) billing.productId = productId;
            if (subscriptionId !== undefined) billing.subscriptionId = subscriptionId;
            if (data.subscription != null) {
                if (!isRecord(data.subscription)) throw new Error('Polar webhook requires record subscription');
                billing.cadence = cadence(data.subscription.recurringInterval);
                const periodEnd = serializeDate(data.subscription.currentPeriodEnd, 'subscription.currentPeriodEnd');
                if (periodEnd !== undefined) billing.periodEnd = periodEnd;
            } else if (subscriptionId !== undefined) {
                throw new Error('Polar paid subscription order requires subscription recurringInterval');
            }
        } else {
            type = 'billing.subscription.updated';
            billing.subscriptionId = resourceId;
            billing.productId = requiredString(data.productId, 'productId');
            billing.cadence = cadence(data.recurringInterval);
            const periodEnd = serializeDate(
                data.status === 'canceled' ? data.endsAt ?? data.endedAt ?? data.currentPeriodEnd : data.currentPeriodEnd,
                'subscription periodEnd'
            );
            if (periodEnd !== undefined) billing.periodEnd = periodEnd;
        }
        payload = billing;
    } else if (originalEventType === 'customer.state_changed') {
        type = 'billing.customer.state.changed';
        if (!Array.isArray(data.activeMeters)) throw new Error('Polar webhook requires activeMeters');
        const billing: PolarBillingPayload = {
            customerId: resourceId,
            meters: data.activeMeters.map((meter: unknown) => {
                if (!isRecord(meter)) throw new Error('Polar webhook requires record activeMeters entry');
                const normalized: NonNullable<PolarBillingPayload['meters']>[number] = {
                    meter_id: requiredString(meter.meterId, 'meterId')
                };
                for (const [sdkField, field] of [
                    ['consumedUnits', 'consumed_units'],
                    ['creditedUnits', 'credited_units'],
                    ['balance', 'balance']
                ] as const) {
                    const value = meter[sdkField];
                    if (value === undefined) continue;
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        throw new Error(`Polar webhook requires finite ${sdkField}`);
                    }
                    normalized[field] = value;
                }
                return normalized;
            })
        };
        payload = billing;
    } else {
        type = `provider.polar.${originalEventType}`;
        metadata.unmapped = true;
        // Keep validated SDK data JSON-safe without promoting it to a billing mutation.
        payload = { providerData: JSON.parse(JSON.stringify(data)) };
    }

    return {
        source: 'polar-webhook',
        sourceEventId,
        type,
        topic: 'domain',
        schemaVersion: 1,
        subject: { provider: 'polar', kind: customerId ? 'customer' : 'resource', id: customerId ?? resourceId },
        occurredAt: timestamp,
        payload,
        metadata
    };
}

export const polarWebhookProducer: DomainEventProducer<NormalizePolarWebhookInput> = {
    provider: 'polar',
    normalize: normalizePolarDomainEvent,
    resolveOwner: (event) => event.subject?.kind === 'customer'
        ? resolveDomainEventOwner(event.subject, typeof event.metadata?.externalCustomerId === 'string'
            ? event.metadata.externalCustomerId : undefined,
        typeof event.metadata?.legacyTwitchChannelId === 'string' ? event.metadata.legacyTwitchChannelId : undefined)
        : Promise.resolve(undefined)
};
