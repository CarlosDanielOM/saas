import { Schema, model } from 'mongoose';
import type { DimafxQueueItem } from '../handlers/dimafx_queue.handler.js';
import { DIMAFX_LOG_RETENTION_SECONDS } from './dimafx_retention.js';

export interface IDimafxPlayback {
  /** Bits purchases use bits-<ledger ID>, including on request retries. */
  _id: string;
  channelID: string;
  payload: DimafxQueueItem;
  state: 'queued' | 'playing' | 'refunding' | 'completed' | 'refunded' | 'removed_by_broadcaster';
  leaseOwner: string;
  leaseUntil: Date;
  failure?: string;
  /** Set once when custom widgets were told about this purchase (survives restarts and recovery). */
  widgetSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IDimafxPlayback>({
  _id: { type: String, required: true },
  channelID: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  state: { type: String, enum: ['queued', 'playing', 'refunding', 'completed', 'refunded', 'removed_by_broadcaster'], default: 'queued' },
  leaseOwner: { type: String, default: '' },
  leaseUntil: { type: Date, default: () => new Date(0) },
  failure: String,
  widgetSentAt: Date,
}, { timestamps: true });
schema.index({ channelID: 1, state: 1, createdAt: 1 });
// Records survive disconnects and crashes as playback/idempotency receipts, and every record
// expires 365 days after creation (privacy retention), whatever its state.
schema.index({ createdAt: 1 }, { expireAfterSeconds: DIMAFX_LOG_RETENTION_SECONDS });
export const DimafxPlaybackSchema = model<IDimafxPlayback>('DimafxPlayback', schema);

/** Queue reservations include the intent itself: a crash before job insertion is recoverable. */
const gateSchema = new Schema({
  _id: { type: String, required: true },
  slots: { type: [Schema.Types.Mixed], default: [] },
}, { timestamps: true });
gateSchema.index({ updatedAt: 1 }, { expireAfterSeconds: DIMAFX_LOG_RETENTION_SECONDS });
export const DimafxQueueGateSchema = model('DimafxQueueGate', gateSchema);

const paceSchema = new Schema({
  _id: { type: String, required: true }, channelID: { type: String, required: true },
  nextAt: { type: Date, required: true }, updatedAt: { type: Date, default: Date.now },
});
paceSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
export const DimafxFreePaceSchema = model('DimafxFreePace', paceSchema);

const moderationCacheSchema = new Schema({
  _id: { type: String, required: true }, channelID: String, userID: String,
  owner: String, leaseUntil: Date, result: Schema.Types.Mixed, expiresAt: Date,
});
moderationCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DimafxModerationCacheSchema = model('DimafxModerationCache', moderationCacheSchema);
const requestLimitSchema = new Schema({ _id: { type: String, required: true }, channelID: String, count: Number, expiresAt: Date });
requestLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DimafxRequestLimitSchema = model('DimafxRequestLimit', requestLimitSchema);
