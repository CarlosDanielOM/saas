import type { Types } from 'mongoose';

export type DomainEventTopic = 'channel' | 'activity' | 'telemetry' | 'domain';

export const DOMAIN_EVENT_RETENTION_SECONDS: Record<DomainEventTopic, number> = {
    channel: 90 * 24 * 60 * 60,
    activity: 3 * 24 * 60 * 60,
    telemetry: 7 * 24 * 60 * 60,
    domain: 90 * 24 * 60 * 60
};

export interface DomainEventSubject {
    provider: string;
    kind: 'streaming-account' | 'integration-account' | 'customer' | 'resource';
    id: string;
}

export interface DomainEventEnvelope {
    _id: Types.ObjectId;
    eventKey: string;
    source: string;
    sourceEventId: string;
    type: string;
    topic: DomainEventTopic;
    schemaVersion: number;
    ownerUserId?: string;
    subject?: DomainEventSubject;
    channelID?: string;
    streamID?: string;
    occurredAt: Date;
    journaledAt: Date;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
    expiresAt: Date;
}

export interface JournalDomainEventInput {
    source: string;
    sourceEventId: string;
    type: string;
    topic: DomainEventTopic;
    schemaVersion?: number;
    ownerUserId?: string;
    subject?: DomainEventSubject;
    channelID?: string;
    streamID?: string;
    occurredAt?: Date | string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    retentionSeconds?: number;
}

export interface JournalDomainEventResult {
    event: DomainEventEnvelope;
    inserted: boolean;
}

export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;
export type DomainEventOwnerResolver = (event: JournalDomainEventInput) => Promise<string | undefined>;

// Consumers report prerequisites; only the delivery engine owns retry timing/budgets.
export class DomainEventPrerequisiteMissingError extends Error {
    readonly outcome = 'prerequisite-missing';

    constructor(readonly prerequisite: string) {
        super(`Missing prerequisite: ${prerequisite}`);
        this.name = 'DomainEventPrerequisiteMissingError';
    }
}

// Transport verification stays in the adapter's webhook/socket/polling boundary.
export interface DomainEventProducer<Input> {
    provider: string;
    normalize(input: Input): JournalDomainEventInput | null;
    resolveOwner?: DomainEventOwnerResolver;
}
