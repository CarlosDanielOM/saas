import { Schema, model, Types } from 'mongoose';
import type { DomainEventEnvelope, DomainEventTopic } from '../domain_events/domain_event.types.js';

export interface IDomainEvent extends DomainEventEnvelope {
    _id: Types.ObjectId;
    topic: DomainEventTopic;
}

const domainEventSchema = new Schema<IDomainEvent>({
    eventKey: { type: String, required: true, immutable: true },
    source: { type: String, required: true, immutable: true },
    sourceEventId: { type: String, required: true, immutable: true },
    type: { type: String, required: true, immutable: true, index: true },
    topic: {
        type: String,
        enum: ['channel', 'activity', 'telemetry', 'domain'],
        required: true,
        immutable: true,
        index: true
    },
    schemaVersion: { type: Number, required: true, default: 1, immutable: true },
    channelID: { type: String, required: true, immutable: true, index: true },
    streamID: { type: String, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    journaledAt: { type: Date, required: true, immutable: true, default: Date.now },
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },
    metadata: { type: Schema.Types.Mixed, required: true, immutable: true, default: {} },
    expiresAt: { type: Date, required: true, immutable: true }
}, {
    versionKey: false
});

domainEventSchema.index({ eventKey: 1 }, { unique: true });
domainEventSchema.index({ source: 1, sourceEventId: 1, type: 1 }, { unique: true });
domainEventSchema.index({ topic: 1, _id: 1 });
domainEventSchema.index({ topic: 1, 'metadata.durableChatHandled': 1, _id: 1 }, {
    partialFilterExpression: { 'metadata.durableChatHandled': true }
});
domainEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DomainEventSchema = model<IDomainEvent>('domain_event', domainEventSchema);
