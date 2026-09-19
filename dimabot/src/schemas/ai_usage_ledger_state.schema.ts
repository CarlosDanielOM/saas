import { Schema, model } from 'mongoose';

export interface IAiUsageLedgerState {
    channelID: string;
    customerId: string;
    coverageStart: Date;
    backfilledAt: Date;
    created_at?: Date;
    updated_at?: Date;
}

const aiUsageLedgerStateSchema = new Schema<IAiUsageLedgerState>({
    channelID: { type: String, required: true },
    customerId: { type: String, required: true },
    coverageStart: { type: Date, required: true },
    backfilledAt: { type: Date, required: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

aiUsageLedgerStateSchema.index({ channelID: 1, customerId: 1 }, { unique: true });

const AiUsageLedgerStateSchema = model<IAiUsageLedgerState>('ai_usage_ledger_states', aiUsageLedgerStateSchema);

export default AiUsageLedgerStateSchema;
