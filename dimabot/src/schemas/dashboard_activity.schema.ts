import { Schema, model } from 'mongoose';

// One scalar record per channel / UTC day / kind / key, without people or chat content.
const daily = new Schema({
    _id: String, channelID: { type: String, required: true }, day: { type: Date, required: true },
    kind: { type: String, enum: ['command', 'emote', 'coverage'], required: true }, key: String, label: String,
    count: { type: Number, default: 0 }, firstAt: Date, lastSeq: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
daily.index({ channelID: 1, day: 1, kind: 1 });
daily.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DashboardActivityDailySchema = model('dashboard_activity_daily', daily);

const summary = new Schema({
    _id: String, dirtyAt: Date, nextRefreshAt: Date, leaseUntil: { type: Date, default: () => new Date(0) }, owner: String,
    updatedAt: Date, payload: Schema.Types.Mixed, error: { type: Boolean, default: false }
}, { versionKey: false });
summary.index({ nextRefreshAt: 1, leaseUntil: 1 });
export const DashboardActivitySummarySchema = model('dashboard_activity_summary', summary);
