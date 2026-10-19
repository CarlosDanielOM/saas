import { Schema, model } from 'mongoose';

// Small derived report cache only; existing sessions/snapshots/journal remain authoritative.
const summary = new Schema({
    _id: String, nextRefreshAt: Date, leaseUntil: { type: Date, default: () => new Date(0) }, owner: String,
    updatedAt: Date, payload: Schema.Types.Mixed, error: { type: Boolean, default: false }, expiresAt: Date
}, { versionKey: false });
summary.index({ nextRefreshAt: 1, leaseUntil: 1 });
summary.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DashboardInsightsSchema = model('dashboard_insights', summary);
