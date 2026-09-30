import { Schema, model } from 'mongoose';
import type { DimafxQueueItem } from '../handlers/dimafx_queue.handler.js';

export interface IDimafxPlayback {
  /** Bits purchases use bits-<ledger ID>, including on request retries. */
  _id: string;
  channelID: string;
  payload: DimafxQueueItem;
  state: 'queued' | 'playing' | 'refunding' | 'completed' | 'refunded';
  leaseOwner: string;
  leaseUntil: Date;
  failure?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IDimafxPlayback>({
  _id: { type: String, required: true },
  channelID: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  state: { type: String, enum: ['queued', 'playing', 'refunding', 'completed', 'refunded'], default: 'queued' },
  leaseOwner: { type: String, default: '' },
  leaseUntil: { type: Date, default: () => new Date(0) },
  failure: String,
}, { timestamps: true });
schema.index({ channelID: 1, state: 1, createdAt: 1 });
// No TTL: unresolved paid work and completed idempotency receipts must survive
// disconnects and a crash between enqueueing and finalizing the purchase ledger.
export const DimafxPlaybackSchema = model<IDimafxPlayback>('DimafxPlayback', schema);
