import { Schema, model } from 'mongoose';

// A receipt records accepted effects, not an exactly-once guarantee for external calls.
const receiptSchema = new Schema({
    _id: { type: String, required: true },
    channelID: { type: String, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    steps: { type: Map, of: new Schema({
        status: { type: String, enum: ['completed', 'skipped', 'failed'], required: true },
        reason: String,
        at: { type: Date, required: true }
    }, { _id: false }), default: {} }
}, { versionKey: false });
receiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamOperationsReceipt = model('stream_operations_receipt', receiptSchema);

const reconciliationSchema = new Schema({
    _id: { type: String, required: true }, revision: { type: Number, required: true, default: 0 },
    pending: { type: Boolean, required: true, default: true }, nextAttemptAt: { type: Date, required: true },
    leaseToken: String, leaseUntil: Date, lastError: String
}, { versionKey: false });
reconciliationSchema.index({ pending: 1, nextAttemptAt: 1, leaseUntil: 1 });
export const StreamOperationsReconciliation = model('stream_operations_reconciliation', reconciliationSchema);
