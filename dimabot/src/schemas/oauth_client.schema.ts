import { Schema, model } from 'mongoose';

const schema = new Schema({
    client_id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['public'], required: true },
    redirect_uris: { type: [String], required: true },
    allowed_scopes: { type: [String], required: true },
    enabled: { type: Boolean, default: true }
}, { timestamps: true });

export const OAuthClient = model('OAuthClient', schema, 'oauth_clients');
