import { Types, type HydratedDocument } from 'mongoose';
import type {
    DomainEventEnvelope,
    DomainEventTopic,
    JournalDomainEventInput,
    JournalDomainEventResult
} from '../domain_events/domain_event.types.js';
import { DomainEventSchema, type IDomainEvent } from '../schemas/domain_event.schema.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { warn as logWarn } from './logger.js';

export const DOMAIN_EVENTS_WAKEUP_STREAM = 'domain-events:wakeup:v1';

const DEFAULT_RETENTION_SECONDS: Record<DomainEventTopic, number> = {
    channel: 90 * 24 * 60 * 60,
    activity: 3 * 24 * 60 * 60,
    telemetry: 7 * 24 * 60 * 60,
    domain: 90 * 24 * 60 * 60
};

const WAKEUP_STREAM_MAX_LENGTH = Math.max(
    1000,
    Number(process.env.DOMAIN_EVENTS_WAKEUP_STREAM_MAX_LENGTH || 10_000)
);

function normalizeRequired(value: unknown, field: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`Domain event ${field} is required`);
    }
    return normalized;
}

function normalizeDate(value: Date | string | undefined): Date {
    if (!value) {
        return new Date();
    }
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('Domain event occurredAt must be a valid date');
    }
    return parsed;
}

function isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && Number((error as { code?: number }).code) === 11000);
}

export function buildDomainEventKey(source: string, sourceEventId: string, type: string): string {
    return [source, sourceEventId, type]
        .map((value) => encodeURIComponent(normalizeRequired(value, 'key component')))
        .join(':');
}

function toEnvelope(event: IDomainEvent): DomainEventEnvelope {
    return {
        _id: event._id,
        eventKey: event.eventKey,
        source: event.source,
        sourceEventId: event.sourceEventId,
        type: event.type,
        topic: event.topic,
        schemaVersion: event.schemaVersion,
        channelID: event.channelID,
        streamID: event.streamID,
        occurredAt: event.occurredAt,
        journaledAt: event.journaledAt,
        payload: event.payload,
        metadata: event.metadata,
        expiresAt: event.expiresAt
    };
}

async function publishWakeup(event: DomainEventEnvelope): Promise<boolean> {
    try {
        const client = await getDragonflyClient('DomainEventsWakeupPublisher');
        await client.xAdd(DOMAIN_EVENTS_WAKEUP_STREAM, '*', {
            eventKey: event.eventKey,
            topic: event.topic,
            journaledAt: event.journaledAt.toISOString()
        }, {
            TRIM: {
                strategy: 'MAXLEN',
                strategyModifier: '~',
                threshold: WAKEUP_STREAM_MAX_LENGTH
            }
        });
        return true;
    } catch (error) {
        await logWarn({
            function: 'publishDomainEventWakeup',
            eventKey: event.eventKey,
            error: error instanceof Error ? error.message : String(error)
        }, { channelId: event.channelID, destination: 'both' });
        return false;
    }
}

export async function journalDomainEvent(input: JournalDomainEventInput): Promise<JournalDomainEventResult> {
    const source = normalizeRequired(input.source, 'source');
    const sourceEventId = normalizeRequired(input.sourceEventId, 'sourceEventId');
    const type = normalizeRequired(input.type, 'type');
    const channelID = normalizeRequired(input.channelID, 'channelID');
    const eventKey = buildDomainEventKey(source, sourceEventId, type);
    const occurredAt = normalizeDate(input.occurredAt);
    const journaledAt = new Date();
    const requestedRetentionSeconds = Number(input.retentionSeconds ?? DEFAULT_RETENTION_SECONDS[input.topic]);
    const requestedSchemaVersion = Number(input.schemaVersion ?? 1);
    if (!Number.isFinite(requestedRetentionSeconds) || !Number.isFinite(requestedSchemaVersion)) {
        throw new Error('Domain event retentionSeconds and schemaVersion must be finite numbers');
    }
    const retentionSeconds = Math.max(
        60,
        requestedRetentionSeconds
    );
    const expiresAt = new Date(journaledAt.getTime() + retentionSeconds * 1000);

    let eventDocument: HydratedDocument<IDomainEvent> | null = null;
    let inserted = false;

    try {
        eventDocument = new DomainEventSchema({
            _id: new Types.ObjectId(),
            eventKey,
            source,
            sourceEventId,
            type,
            topic: input.topic,
            schemaVersion: Math.max(1, Math.floor(requestedSchemaVersion)),
            channelID,
            streamID: String(input.streamID || '').trim() || undefined,
            occurredAt,
            journaledAt,
            payload: input.payload,
            metadata: input.metadata || {},
            expiresAt
        });
        await Promise.all([eventDocument.validate(), DomainEventSchema.init()]);
        await DomainEventSchema.collection.insertOne(eventDocument.toObject(), {
            writeConcern: {
                w: 1,
                j: true
            }
        });
        inserted = true;
    } catch (error) {
        if (!isDuplicateKeyError(error)) {
            throw error;
        }
        eventDocument = await DomainEventSchema.findOne({ eventKey });
        if (!eventDocument) {
            throw error;
        }
    }

    const event = toEnvelope(eventDocument);
    const wakeupPublished = await publishWakeup(event);
    return {
        event,
        inserted,
        wakeupPublished
    };
}
