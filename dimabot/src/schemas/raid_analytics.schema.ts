import { Schema, model } from 'mongoose';

const history = new Schema({
    _id: String, channelID: { type: String, required: true }, direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
    peerID: String, peerLogin: String, peerName: String, viewers: Number, occurredAt: { type: Date, required: true },
    followsAfter: { type: Number, default: null }, followsComputedAt: { type: Date, default: null }, followWindowEnd: Date,
    expiresAt: { type: Date, required: true }
}, { versionKey: false, writeConcern: { w: 1, j: true } });
history.index({ channelID: 1, occurredAt: -1, _id: 1 });
history.index({ channelID: 1, direction: 1, peerID: 1, occurredAt: -1 });
history.index({ channelID: 1, direction: 1, followsComputedAt: 1, occurredAt: 1 });
history.index({ channelID: 1, direction: 1, occurredAt: 1, _id: 1 });
history.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RaidAnalyticsHistorySchema = model('raid_analytics_history', history);

// At most two small dashboard payloads per channel; requests never aggregate source events.
const summary = new Schema({
    _id: String, dirtyAt: Date, nextRefreshAt: Date, leaseUntil: { type: Date, default: () => new Date(0) }, owner: String,
    updatedAt: Date, payload: Schema.Types.Mixed, error: { type: Boolean, default: false }
}, { versionKey: false });
summary.index({ nextRefreshAt: 1, leaseUntil: 1 });
export const RaidAnalyticsSummarySchema = model('raid_analytics_summary', summary);
