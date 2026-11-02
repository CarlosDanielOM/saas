import { Schema, model, Types } from 'mongoose';
import type { CronQueueJob } from '../utils/cron_jobs_queue.js';

export type CronJobIntentStatus = 'queued' | 'processing' | 'completed' | 'dead' | 'uncertain' | 'legacy_accepted';

export interface ICronJobIntent {
    _id: Types.ObjectId;
    jobID: string;
    queueKey: string;
    payload: CronQueueJob;
    status: CronJobIntentStatus;
    automaticKey?: string;
    activeKey?: string;
    dedupeUntil: Date;
    dueAt: Date;
    nextPublishAt: Date;
    owner?: string;
    token?: string;
    leaseUntil?: Date;
    reason?: string;
    createdAt: Date;
    updatedAt: Date;
}

const schema = new Schema<ICronJobIntent>({
    jobID: { type: String, required: true, immutable: true },
    queueKey: { type: String, required: true, immutable: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, enum: ['queued', 'processing', 'completed', 'dead', 'uncertain', 'legacy_accepted'] },
    automaticKey: { type: String },
    activeKey: { type: String },
    dedupeUntil: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    nextPublishAt: { type: Date, required: true },
    owner: { type: String },
    token: { type: String },
    leaseUntil: { type: Date },
    reason: { type: String }
}, { timestamps: true, versionKey: false });

schema.index({ jobID: 1 }, { unique: true });
schema.index({ automaticKey: 1 }, { unique: true, sparse: true });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ queueKey: 1, status: 1, nextPublishAt: 1, _id: 1 });
schema.index({ queueKey: 1, status: 1, leaseUntil: 1, _id: 1 });

// No TTL: accepted automatic jobs and ambiguous outcomes are permanent evidence.
export const CronJobIntentSchema = model<ICronJobIntent>('cron_job_intent', schema);
