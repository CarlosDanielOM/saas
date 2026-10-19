import { Schema, model } from 'mongoose';

// A deletion is a durable opt-out, not permission for subscription repair to recreate it.
const preference = new Schema({
    _id: String, channelID: { type: String, required: true },
    direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
    deleted: { type: Boolean, default: false }, operation: String, updatedAt: Date
}, { versionKey: false, writeConcern: { w: 1, j: true } });
preference.index({ channelID: 1, direction: 1 }, { unique: true });
export const RaidSubscriptionPreferenceSchema = model('raid_subscription_preference', preference);
