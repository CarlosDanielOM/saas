import type { Types } from 'mongoose';

export type DomainEventTopic = 'channel' | 'activity' | 'telemetry' | 'domain';

export interface DomainEventEnvelope {
    _id: Types.ObjectId;
    eventKey: string;
    source: string;
    sourceEventId: string;
    type: string;
    topic: DomainEventTopic;
    schemaVersion: number;
    channelID: string;
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
    channelID: string;
    streamID?: string;
    occurredAt?: Date | string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    retentionSeconds?: number;
}

export interface JournalDomainEventResult {
    event: DomainEventEnvelope;
    inserted: boolean;
    wakeupPublished: boolean;
}

export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;
