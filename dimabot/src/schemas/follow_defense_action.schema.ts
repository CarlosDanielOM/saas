import { Schema, model, type InferSchemaType } from 'mongoose';

const actionSchema = new Schema({
    _id: { type: String, required: true },
    channelID: { type: String, required: true },
    eventID: { type: String, required: true },
    kind: { type: String, enum: ['ban', 'announcement'], required: true },
    followerID: { type: String, default: '' },
    reason: { type: String, default: '' },
    message: { type: String, default: '' },
    mode: { type: String, enum: ['protection', 'attack'], required: true },
    authorizedAt: { type: Date, required: true },
    followedAt: { type: Date },
    status: { type: String, enum: ['pending', 'processing', 'succeeded', 'failed', 'cancelled', 'expired'], default: 'pending', required: true },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date, default: () => new Date(0) },
    leaseToken: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    lastStatus: { type: Number, default: 0 },
    lastMessage: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },
    auditPending: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false, writeConcern: { w: 1, j: true } });
actionSchema.index({ channelID: 1, status: 1, nextAttemptAt: 1, createdAt: 1 });
actionSchema.index({ status: 1, expiresAt: 1 });
actionSchema.index({ auditPending: 1 });
actionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export type FollowDefenseAction = InferSchemaType<typeof actionSchema>;
export const FollowDefenseActionSchema = model('follow_defense_action', actionSchema);

// Cancellation and pacing survive cache loss and executor restarts. Never TTL these controls:
// a late enqueue must still observe the most recent cancellation boundary.
const controlSchema = new Schema({
    _id: { type: String, required: true },
    cancelledThrough: { type: Date, default: () => new Date(0) },
    pendingUntil: { type: Date, default: () => new Date(0) },
    nextAllowedAt: { type: Date, default: () => new Date(0) },
    lastServedAt: { type: Date, default: () => new Date(0) },
    lockedUntil: { type: Date, default: () => new Date(0) },
    leaseToken: { type: String, default: '' }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
controlSchema.index({ nextAllowedAt: 1, lastServedAt: 1 });
export const FollowDefenseControlSchema = model('follow_defense_control', controlSchema);
