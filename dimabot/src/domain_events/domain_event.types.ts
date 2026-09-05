import type { Types } from 'mongoose';

export type DomainEventTopic = 'channel' | 'activity' | 'telemetry' | 'domain';

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

// Transport verification stays in the adapter's webhook/socket/polling boundary.
export interface DomainEventProducer<Input> {
    provider: string;
    normalize(input: Input): JournalDomainEventInput | null;
    resolveOwner?: DomainEventOwnerResolver;
}
