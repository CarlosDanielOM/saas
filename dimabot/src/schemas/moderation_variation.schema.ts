import { Schema, model } from 'mongoose';
import type { GeneratedVariation } from '../utils/moderation/variations.js';
interface VariationCache { _id: string; channelID: string; entry: GeneratedVariation; model: string; expiresAt: Date }
const cache = new Schema<VariationCache>({ _id: String, channelID: String, entry: Schema.Types.Mixed, model: String, expiresAt: Date }, { versionKey: false });
cache.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ModerationVariationCache = model<VariationCache>('moderation_variation_cache', cache);
export interface VariationJob {
    _id: string; channelID: string; terms: string[]; state: 'reserved' | 'pending' | 'processing' | 'completed' | 'failed';
    entries: GeneratedVariation[]; error: string; attempts: number; createdAt: Date; deadline: Date; expiresAt: Date;
    model: string; version: string; providerUsage: Array<Record<string, unknown>>; creditsCharged: number;
}
const job = new Schema<VariationJob>({
    _id: String, channelID: String, terms: [String], state: String, entries: [Schema.Types.Mixed], error: { type: String, default: '' },
    attempts: { type: Number, default: 1 }, createdAt: Date, deadline: Date, expiresAt: Date,
    model: String, version: String, providerUsage: { type: Schema.Types.Mixed, default: () => [] }, creditsCharged: { type: Number, default: 0 }
}, { versionKey: false });
job.index({ state: 1, createdAt: 1 });
job.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ModerationVariationJob = model<VariationJob>('moderation_variation_job', job);
