import { Schema, model } from 'mongoose';

const schema = new Schema({
    token_hash: { type: String, required: true, unique: true },
    session_id: { type: Schema.Types.ObjectId, ref: 'OAuthSession', required: true, index: true },
    used_at: { type: Date, default: null },
    // Keep consumed hashes until the entire session expires, to detect replay.
    expires_at: { type: Date, required: true }
}, { timestamps: true });
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const OAuthRefreshToken = model('OAuthRefreshToken', schema, 'oauth_refresh_tokens');
