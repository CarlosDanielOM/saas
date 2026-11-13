import { Schema, model, Types } from 'mongoose';
import type { DomainEventEnvelope, DomainEventTopic } from '../domain_events/domain_event.types.js';

export interface IDomainEvent extends DomainEventEnvelope {
    _id: Types.ObjectId;
    topic: DomainEventTopic;
    dispatchPending?: boolean;
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
    ownerUserId: { type: String, immutable: true, index: true },
    subject: {
        type: new Schema({
            provider: { type: String, required: true },
            kind: { type: String, enum: ['streaming-account', 'integration-account', 'customer', 'resource'], required: true },
            id: { type: String, required: true }
        }, { _id: false }),
        immutable: true
    },
    channelID: { type: String, required: function (this: IDomainEvent): boolean { return this.topic === 'channel'; }, immutable: true, index: true },
    streamID: { type: String, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    journaledAt: { type: Date, required: true, immutable: true, default: Date.now },
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },
    metadata: { type: Schema.Types.Mixed, required: true, immutable: true, default: {} },
    expiresAt: { type: Date, required: true, immutable: true },
    dispatchPending: { type: Boolean }
}, {
    versionKey: false
});

domainEventSchema.index({ eventKey: 1 }, { unique: true });
domainEventSchema.index({ source: 1, sourceEventId: 1, type: 1 }, { unique: true });
domainEventSchema.index({ topic: 1, _id: 1 });
domainEventSchema.index({ topic: 1, source: 1, _id: 1 });
domainEventSchema.index({ channelID: 1, source: 1, type: 1, occurredAt: 1, _id: 1 });
// The admin activity feed across every channel: newest first by when it happened (`{topic, _id}` follows journal order).
domainEventSchema.index({ topic: 1, occurredAt: -1, _id: -1 });
/**
 * Where a Twitch event names the viewer who caused it: follows, subs, gifts and bits (`user_id`), chat
 * notifications (`chatter_user_id`), raids (`from_broadcaster_user_id`), ad breaks (`requester_user_id`).
 * One small partial index each, so the admin feed finds one viewer's events across every channel.
 */
export const DOMAIN_EVENT_VIEWER_FIELDS = ['user_id', 'chatter_user_id', 'from_broadcaster_user_id', 'requester_user_id'] as const;
for (const field of DOMAIN_EVENT_VIEWER_FIELDS) {
    domainEventSchema.index({ [`payload.event.${field}`]: 1, occurredAt: -1, _id: -1 }, {
        partialFilterExpression: { topic: 'channel', [`payload.event.${field}`]: { $type: 'string' } }
    });
}
domainEventSchema.index({ dispatchPending: 1, _id: 1 }, { partialFilterExpression: { dispatchPending: true } });
domainEventSchema.index({ topic: 1, 'metadata.durableChatHandled': 1, _id: 1 }, {
    partialFilterExpression: { 'metadata.durableChatHandled': true }
});
domainEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DomainEventSchema = model<IDomainEvent>('domain_event', domainEventSchema);
