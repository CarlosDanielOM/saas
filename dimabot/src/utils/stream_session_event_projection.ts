import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { DomainEventPrerequisiteMissingError } from '../domain_events/domain_event.types.js';

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
}): Promise<'applied' | 'already-applied' | boolean> {
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
        // Check outside the time window too: later lifecycle corrections can move its bounds.
        if (await StreamSessionSchema.exists({ channelID: input.channelID, applied_domain_event_keys: input.eventKey })) {
            return 'already-applied';
        }
        // Pin the newest session before applying the receipt guard. Otherwise a racing
        // duplicate could fall through to an older session at a shared boundary.
        const target = await StreamSessionSchema.findOne(filter).sort({ started_at: -1 }).select('_id').lean();
        filter._id = target?._id;
        filter.applied_domain_event_keys = { $ne: input.eventKey };
        update.$addToSet = { applied_domain_event_keys: input.eventKey };
    }

    const session = !input.eventKey || filter._id ? await StreamSessionSchema.findOneAndUpdate(filter, update, {
        sort: { started_at: -1 },
        new: true,
        ...(input.eventKey ? { writeConcern: { w: 1, j: true } } : {})
    }).select('_id').lean() : null;
    // Historical/unkeyed callers intentionally ignore metrics in offline windows.
    if (!input.eventKey) return Boolean(session);
    if (session) return 'applied';
    if (await StreamSessionSchema.exists({ channelID: input.channelID, applied_domain_event_keys: input.eventKey })) {
        return 'already-applied';
    }
    // Absence alone (even with an older closed session) cannot prove an offline window.
    throw new DomainEventPrerequisiteMissingError(`metric-session:${input.channelID}:${occurredAt.toISOString()}`);
}
