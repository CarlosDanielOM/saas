import { Schema, model } from 'mongoose';

// One durable marker per channel/chatter, independent of decision retention.
// No chat text or login is retained. The primary key makes first-seen claims atomic.
const schema = new Schema({
    _id: { type: String, required: true },
    firstSeenAt: { type: Date, required: true }
}, { versionKey: false });

export const ModerationChatter = model('moderation_chatter', schema);
