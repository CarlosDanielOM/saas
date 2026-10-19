import { Schema, model } from 'mongoose';

// Metadata outbox: stable receipt identity, bounded event properties, no message text.
const activity = new Schema({
    _id: String, channelID: { type: String, required: true }, session_id: { type: Schema.Types.ObjectId, required: true },
    occurredAt: { type: Date, required: true }, offset: Number,
    kind: { type: String, enum: ['message', 'command', 'redemption', 'follow', 'sub', 'gift', 'bits', 'raid'], required: true },
    key: { type: String, default: '' }, label: { type: String, default: '' },
    actor: { type: String, default: '' }, actorLabel: { type: String, default: '' },
    value: { type: Number, default: 1 }, outcome: { type: String, default: '' },
    emotes: [{ _id: false, key: String, label: String, count: Number }],
    processed: { type: Boolean, default: false }, expiresAt: { type: Date, required: true }
}, { versionKey: false });
activity.index({ processed: 1, occurredAt: 1, _id: 1 });
activity.index({ channelID: 1, session_id: 1, processed: 1, expiresAt: 1 });
activity.index({ channelID: 1, session_id: 1, kind: 1, occurredAt: 1, _id: 1 });
activity.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamActivitySchema = model('stream_activity', activity);

// Scalar batch fences avoid an ever-growing array of event receipts in aggregates.
const aggregate = new Schema({
    _id: String, channelID: String, session_id: Schema.Types.ObjectId,
    scope: String, kind: String, key: { type: String, default: '' }, actor: { type: String, default: '' }, label: String,
    bucket: { type: Number, default: -1 }, count: { type: Number, default: 0 }, messages: { type: Number, default: 0 },
    commands: { type: Number, default: 0 }, emotes: { type: Number, default: 0 }, emoteMessages: { type: Number, default: 0 },
    chatters: { type: Number, default: 0 }, failures: { type: Number, default: 0 },
    redemptions: { type: Number, default: 0 }, follows: { type: Number, default: 0 }, subs: { type: Number, default: 0 },
    bits: { type: Number, default: 0 }, raids: { type: Number, default: 0 },
    firstSeq: Number, lastSeq: { type: Number, default: 0 },
    firstAt: Date, messageStartedAt: Date, updatedAt: Date, expiresAt: { type: Date, required: true }
}, { versionKey: false });
aggregate.index({ channelID: 1, session_id: 1, scope: 1, kind: 1, key: 1, count: -1, _id: 1 });
aggregate.index({ channelID: 1, session_id: 1, scope: 1, kind: 1, count: -1, _id: 1 });
aggregate.index({ channelID: 1, session_id: 1, scope: 1, bucket: 1 });
aggregate.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamActivityAggregateSchema = model('stream_activity_aggregate', aggregate);

const state = new Schema({
    _id: String, owner: String, leaseUntil: Date, seq: { type: Number, default: 0 },
    active: { seq: Number, ids: [String] }, updatedAt: Date
}, { versionKey: false });
export const StreamActivityStateSchema = model('stream_activity_state', state);
