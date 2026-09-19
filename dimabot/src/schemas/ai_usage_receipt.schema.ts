import { Schema, model } from 'mongoose';

export type AiUsageRetentionTier = 'free' | 'premium' | 'pro';

export interface IAiUsageReceipt {
    channelID: string;
    customerId: string;
    entryId: string;
    requestId: string | null;
    occurredAt: Date;
    entryKind: 'usage' | 'adjustment';
    category: string;
    operation: string;
    provider: string;
    model: string | null;
    quantity: number | null;
    unit: string | null;
    credits: number;
    resourceType: string | null;
    resourceId: string | null;
    itemized: boolean;
    retentionTier: AiUsageRetentionTier;
    expiresAt: Date;
    created_at?: Date;
    updated_at?: Date;
}

const aiUsageReceiptSchema = new Schema<IAiUsageReceipt>({
    channelID: { type: String, required: true },
    customerId: { type: String, required: true },
    entryId: { type: String, required: true },
    requestId: { type: String, default: null },
    occurredAt: { type: Date, required: true },
    entryKind: { type: String, enum: ['usage', 'adjustment'], required: true },
    category: { type: String, required: true },
    operation: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, default: null },
    quantity: { type: Number, default: null },
    unit: { type: String, default: null },
    credits: { type: Number, required: true },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    itemized: { type: Boolean, required: true },
    retentionTier: { type: String, enum: ['free', 'premium', 'pro'], required: true },
    expiresAt: { type: Date, required: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

aiUsageReceiptSchema.index({ channelID: 1, customerId: 1, entryId: 1 }, { unique: true });
aiUsageReceiptSchema.index({ channelID: 1, customerId: 1, occurredAt: -1, entryId: -1 });
aiUsageReceiptSchema.index({ channelID: 1, customerId: 1, category: 1, occurredAt: -1, entryId: -1 });
aiUsageReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AiUsageReceiptSchema = model<IAiUsageReceipt>('ai_usage_receipts', aiUsageReceiptSchema);

export default AiUsageReceiptSchema;
