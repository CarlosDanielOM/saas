import { DomainEventSchema } from '../../../schemas/domain_event.schema.js';
import { DomainEventDeliverySchema, type IDomainEventDelivery } from '../../../schemas/domain_event_delivery.schema.js';
import { StreamOperationsReceipt } from '../../../schemas/stream_operations_receipt.schema.js';
import { safeErrorText, scrubPayload } from './scrub.js';
import { isEventKey, str } from './source.js';
import { eventActor, registeredConsumers, TEST_EVENT_SOURCE, TWITCH_EVENT_SOURCES, twitchTypeOf } from './sources/events.js';
import type { EventDetail } from './types.js';

export const isValidEventKey = isEventKey;
const MAX_TIME_MS = 3000;
const STREAM_TYPES = ['stream.started', 'stream.ended'];
const iso = (value: unknown): string | null => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;

export function deliveryReason(row: Pick<IDomainEventDelivery, 'status' | 'skipReason' | 'lastErrorCode' | 'lastError' | 'lastDeadLetterError'>): string | null {
    if (row.status === 'succeeded') return null;
    if (row.status === 'skipped') return safeErrorText(row.skipReason) ?? 'skipped';
    const message = safeErrorText(row.lastError || row.lastDeadLetterError);
    const code = str(row.lastErrorCode);
    if (code && message) return safeErrorText(`${code}: ${message}`);
    return code ?? message;
}

type StepValue = { status?: unknown; reason?: unknown; at?: unknown };

export function receiptSteps(steps: unknown): EventDetail['steps'] {
    const entries: Array<[string, StepValue]> = steps instanceof Map ? [...steps.entries()] : Object.entries(steps && typeof steps === 'object' ? steps : {});
    return entries
        .filter(([, value]) => value && typeof value === 'object' && ['completed', 'skipped', 'failed'].includes(String(value.status)))
        .map(([step, value]) => ({
            step,
            status: value.status as 'completed' | 'skipped' | 'failed',
            reason: safeErrorText(value.reason),
            at: iso(value.at instanceof Date ? value.at : typeof value.at === 'string' ? new Date(value.at) : null)
        }))
        .sort((a, b) => (a.at || '').localeCompare(b.at || '') || a.step.localeCompare(b.step));
}

/** Undefined when no Twitch event has that key. */
export async function getEventDetail(
    eventKey: string,
    channelLogins: (ids: string[]) => Promise<Map<string, string>>
): Promise<EventDetail | undefined> {
    if (!isValidEventKey(eventKey)) return undefined;
    const event = await DomainEventSchema.collection.findOne(
        { eventKey, source: { $in: [...TWITCH_EVENT_SOURCES] } },
        { projection: { eventKey: 1, type: 1, source: 1, channelID: 1, occurredAt: 1, journaledAt: 1, 'payload.event': 1, 'metadata.originalEventType': 1, 'metadata.observability.traceId': 1 }, maxTimeMS: MAX_TIME_MS }
    );
    if (!event) return undefined;
    const consumers = await registeredConsumers();
    const order = new Map(consumers.map((consumer, index) => [consumer, index]));
    const [deliveries, receipt, logins] = await Promise.all([
        DomainEventDeliverySchema.collection.find(
            { consumer: { $in: consumers }, eventKey },
            { projection: { consumer: 1, status: 1, attempts: 1, skipReason: 1, lastErrorCode: 1, lastError: 1, lastDeadLetterError: 1, completedAt: 1, lastAttemptDurationMs: 1 }, maxTimeMS: MAX_TIME_MS }
        ).toArray(),
        STREAM_TYPES.includes(event.type)
            ? StreamOperationsReceipt.collection.findOne({ _id: eventKey as never }, { projection: { steps: 1 }, maxTimeMS: MAX_TIME_MS })
            : Promise.resolve(null),
        event.channelID ? channelLogins([event.channelID]).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>())
    ]);

    const twitchEvent = event.payload?.event && typeof event.payload.event === 'object' ? event.payload.event as Record<string, unknown> : {};
    return {
        eventKey: event.eventKey,
        type: event.type,
        twitchType: twitchTypeOf(event.type, event.metadata),
        source: event.source,
        channelID: event.channelID || null,
        channel: event.channelID ? logins.get(event.channelID) || null : null,
        occurredAt: iso(event.occurredAt) ?? '',
        journaledAt: iso(event.journaledAt) ?? '',
        test: event.source === TEST_EVENT_SOURCE,
        actor: eventActor(event.type, twitchEvent),
        payload: scrubPayload(twitchEvent),
        deliveries: deliveries
            .sort((a, b) => (order.get(a.consumer) ?? 99) - (order.get(b.consumer) ?? 99))
            .map(row => ({
                consumer: row.consumer,
                status: row.status,
                attempts: typeof row.attempts === 'number' ? row.attempts : 0,
                reason: deliveryReason(row as unknown as IDomainEventDelivery),
                completedAt: iso(row.completedAt),
                durationMs: typeof row.lastAttemptDurationMs === 'number' ? row.lastAttemptDurationMs : null
            })),
        steps: receipt ? receiptSteps(receipt.steps) : [],
        traceId: str(event.metadata?.observability?.traceId)
    };
}
