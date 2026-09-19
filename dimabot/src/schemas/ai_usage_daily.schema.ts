import { Schema, model } from 'mongoose';
import type { AiUsageRetentionTier } from './ai_usage_receipt.schema.js';

export interface IAiUsageDaily {
    channelID: string;
    customerId: string;
    date: string;
    dayStart: Date;
    spentCredits: number;
    grantedCredits: number;
    netConsumedCredits: number;
    transactionCount: number;
    categories: Record<string, { credits: number; transactionCount: number }>;
    retentionTier: AiUsageRetentionTier;
    expiresAt: Date;
    created_at?: Date;
    updated_at?: Date;
}

const aiUsageDailySchema = new Schema<IAiUsageDaily>({
    channelID: { type: String, required: true },
    customerId: { type: String, required: true },
    date: { type: String, required: true },
    dayStart: { type: Date, required: true },
    spentCredits: { type: Number, required: true, default: 0 },
    grantedCredits: { type: Number, required: true, default: 0 },
    netConsumedCredits: { type: Number, required: true, default: 0 },
    transactionCount: { type: Number, required: true, default: 0 },
    categories: { type: Schema.Types.Mixed, required: true, default: {} },
    retentionTier: { type: String, enum: ['free', 'premium', 'pro'], required: true },
    expiresAt: { type: Date, required: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

aiUsageDailySchema.index({ channelID: 1, customerId: 1, date: 1 }, { unique: true });
aiUsageDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AiUsageDailySchema = model<IAiUsageDaily>('ai_usage_daily', aiUsageDailySchema);

export default AiUsageDailySchema;
