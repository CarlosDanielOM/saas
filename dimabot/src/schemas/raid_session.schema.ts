import { Schema, model, type InferSchemaType } from 'mongoose';

const session = new Schema({
    _id: { type: String, required: true }, channelID: { type: String, required: true },
    eventID: { type: String, required: true }, raiderID: { type: String, required: true },
    raiderLogin: { type: String, default: '' }, raiderName: { type: String, default: '' },
    viewers: { type: Number, default: 0 }, startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null }, captureUntil: { type: Date, required: true },
    retentionHours: { type: Number, required: true }, expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true }, backfillUntil: { type: Date, required: true }, backfillCursor: { type: String, default: '' }, backfillDone: { type: Boolean, default: false }, manualRequestID: { type: String, default: '' }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
session.index({ channelID: 1, startedAt: -1 });
session.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export type RaidSession = InferSchemaType<typeof session>;
export const RaidSessionSchema = model('raid_session', session);

const follower = new Schema({
    _id: { type: String, required: true }, channelID: { type: String, required: true },
    sessionID: { type: String, required: true }, eventID: { type: String, required: true },
    userID: { type: String, required: true }, login: { type: String, default: '' }, name: { type: String, default: '' },
    followedAt: { type: Date, required: true }, recordedAt: { type: Date, default: Date.now }, queuedRequestIDs: { type: [String], default: [] }, eligibleRequestIDs: { type: [String], default: [] },
    purgeAt: { type: Date, required: true }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
follower.index({ sessionID: 1, followedAt: 1, _id: 1 });
follower.index({ channelID: 1, followedAt: 1 });
follower.index({ sessionID: 1, userID: 1 });
follower.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export const RaidFollowerSchema = model('raid_follower', follower);

const request = new Schema({
    _id: { type: String, required: true }, channelID: { type: String, required: true }, sessionID: { type: String, required: true },
    actorID: { type: String, required: true }, userID: { type: String, default: '' },
    origin: { type: String, enum: ['history', 'live'], default: 'history' },
    includeFuture: { type: Boolean, default: false }, requestedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, purgeAt: { type: Date, required: true },
    status: { type: String, enum: ['authorizing', 'pending', 'active', 'completed', 'cancelled', 'expired'], default: 'pending' },
    lockedUntil: { type: Date, default: () => new Date(0) }, leaseToken: { type: String, default: '' },
    nextAttemptAt: { type: Date, default: () => new Date(0) }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
request.index({ status: 1, nextAttemptAt: 1 });
request.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export const RaidModerationRequestSchema = model('raid_moderation_request', request);
