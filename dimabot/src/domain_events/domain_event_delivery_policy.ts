import type { DomainEventEnvelope } from './domain_event.types.js';

export interface DomainEventDeliveryPolicy {
    consumer: string;
    schemaVersions?: readonly number[];
    adminReplay?: boolean;
    maxEventAgeMs?: number;
}

export type DomainEventPolicyDecision =
    | { status: 'eligible' }
    | { status: 'dead' | 'skipped'; reason: string };

export function isDomainEventSchemaCompatible(
    policy: DomainEventDeliveryPolicy,
    event: Pick<DomainEventEnvelope, 'schemaVersion'>
): boolean {
    return !policy.schemaVersions || policy.schemaVersions.includes(event.schemaVersion);
}

export function evaluateDomainEventDeliveryPolicy(
    policy: DomainEventDeliveryPolicy,
    event: Pick<DomainEventEnvelope, 'schemaVersion' | 'occurredAt'> & Partial<Pick<DomainEventEnvelope, 'journaledAt'>>,
    now = Date.now()
): DomainEventPolicyDecision {
    if (!isDomainEventSchemaCompatible(policy, event)) {
        return { status: 'dead', reason: `Unsupported schema version ${event.schemaVersion} for ${policy.consumer}` };
    }
    if (policy.maxEventAgeMs !== undefined) {
        const occurredAt = new Date(event.occurredAt).getTime();
        // Provider clock skew must not keep ephemeral effects alive beyond journal age.
        const ageOrigin = event.journaledAt === undefined ? occurredAt
            : Math.min(occurredAt, new Date(event.journaledAt).getTime());
        if (!Number.isFinite(ageOrigin)) {
            return { status: 'dead', reason: `Invalid occurrence or journal time for age-limited consumer ${policy.consumer}` };
        }
        if (now - ageOrigin >= policy.maxEventAgeMs) {
            return { status: 'skipped', reason: `Event exceeds maxEventAgeMs ${policy.maxEventAgeMs} for ${policy.consumer}` };
        }
    }
    return { status: 'eligible' };
}

export function canAdminReplayDomainEvent(
    policy: DomainEventDeliveryPolicy | undefined,
    event: Pick<DomainEventEnvelope, 'schemaVersion' | 'occurredAt' | 'expiresAt'> & Partial<Pick<DomainEventEnvelope, 'journaledAt'>> | null,
    now = Date.now()
): boolean {
    return policy?.adminReplay === true && event !== null
        && new Date(event.expiresAt).getTime() > now
        && evaluateDomainEventDeliveryPolicy(policy, event, now).status === 'eligible';
}
