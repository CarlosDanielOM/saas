import { Schema, model } from 'mongoose';
// Derived data only. Billing balances are always read from the billing service.
const schema = new Schema({
    key: { type: String, required: true, unique: true },
    channelID: { type: String, required: true },
    customerId: { type: String, required: true },
    planTier: { type: String, required: true },
    request: { type: Schema.Types.Mixed, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    dirty: { type: Boolean, default: false },
    refreshedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }
});
schema.index({ channelID: 1, customerId: 1 });
schema.index({ dirty: 1, refreshedAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default model('ai_usage_dashboards', schema);
