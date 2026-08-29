import { StreamSessionSchema } from '../schemas/stream_session.schema.js';

const EVENT_KEY_HISTORY_LIMIT = 10_000;

function toEventDate(value?: string | Date): Date {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function incrementSessionMetricAtEventTime(input: {
    channelID: string;
    occurredAt?: string | Date;
    eventKey?: string;
    field: 'bits' | 'subs' | 'follows';
    quantity: number;
}): Promise<boolean> {
    const occurredAt = toEventDate(input.occurredAt);
    const filter: Record<string, unknown> = {
        channelID: input.channelID,
        started_at: { $lte: occurredAt },
        $or: [
            { ended_at: null },
            { ended_at: { $gte: occurredAt } }
        ]
    };
    const update: Record<string, unknown> = { $inc: { [input.field]: input.quantity } };
    if (input.eventKey) {
        filter.applied_domain_event_keys = { $ne: input.eventKey };
        update.$push = {
            applied_domain_event_keys: {
                $each: [input.eventKey],
                $slice: -EVENT_KEY_HISTORY_LIMIT
            }
        };
    }

    const session = await StreamSessionSchema.findOneAndUpdate(filter, update, {
        sort: { started_at: -1 },
        new: true
    }).select('_id').lean();
    return Boolean(session);
}
