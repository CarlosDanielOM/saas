import { Schema, model } from 'mongoose';

// One receipt per participant per five-minute stream-relative bucket. No message text.
const participant = new Schema({
    channelID: { type: String, required: true },
    session_id: { type: Schema.Types.ObjectId, required: true },
    bucket: { type: Number, required: true },
    user_id: { type: String, required: true },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });
participant.index({ channelID: 1, session_id: 1, bucket: 1, user_id: 1 }, { unique: true });
participant.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamParticipantSchema = model('stream_participant', participant);

const marker = new Schema({
    channelID: { type: String, required: true },
    session_id: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    kind: { type: String, enum: ['note', 'redemption'], required: true },
    label: { type: String, required: true, maxlength: 120 },
    occurredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });
marker.index({ channelID: 1, session_id: 1, key: 1 }, { unique: true });
marker.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamMarkerSchema = model('stream_marker', marker);
