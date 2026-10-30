import { Schema, model } from 'mongoose';

const schema = new Schema({
    user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    client_id: { type: String, required: true },
    channel_id: { type: String, required: true },
    scopes: { type: [String], required: true },
    revoked_at: { type: Date, default: null }
}, { timestamps: true });
schema.index({ user_id: 1, client_id: 1, channel_id: 1 }, { unique: true });

export const OAuthGrant = model('OAuthGrant', schema, 'oauth_grants');
