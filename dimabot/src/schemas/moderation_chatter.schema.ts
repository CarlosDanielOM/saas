import { Schema, model } from 'mongoose';

// One durable marker per channel/chatter, independent of decision retention.
// No chat text or login is retained. The primary key makes claims atomic.
// `seen` counts the chatter's observed messages up to one past the most any plan reviews;
// a marker written before counting existed has no `seen` and is treated as past all of them.
const schema = new Schema({
    _id: { type: String, required: true },
    firstSeenAt: { type: Date, required: true },
    seen: Number
}, { versionKey: false });

export const ModerationChatter = model('moderation_chatter', schema);
