import { Schema, model } from 'mongoose';

const schema = new Schema({
    grant_id: { type: Schema.Types.ObjectId, ref: 'OAuthGrant', required: true, index: true },
    user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    client_id: { type: String, required: true },
    // Snapshot for the connections page. Missing on sessions created before MCP v1.
    client_name: { type: String },
    // Twitch account that approved; missing on legacy sessions, where it is channel_id.
    requester_id: { type: String },
    // Channel the connection acts on.
    channel_id: { type: String, required: true },
    // Audience URI (RFC 8707); missing on legacy sessions, where it is the desktop API.
    resource: { type: String },
    device_name: { type: String, required: true, maxlength: 80 },
    scopes: { type: [String], required: true },
    current_refresh_hash: { type: String, required: true, select: false },
    last_used_at: { type: Date, required: true },
    idle_expires_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
    revoked_at: { type: Date, default: null },
    revoke_reason: { type: String, default: null }
}, { timestamps: true });
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const OAuthSession = model('OAuthSession', schema, 'oauth_sessions');
