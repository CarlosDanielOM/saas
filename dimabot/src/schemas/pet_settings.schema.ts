import { Schema, model, Types } from 'mongoose';

export interface PetSettings {
    enabled: boolean;
    name: string;
    tts: { enabled: boolean; provider: 'piper' | 'kokoro' | 'fish'; language: 'en' | 'es'; voice: string };
    personality: { source: 'custom' | 'profile'; profileId: string; prompt: string };
    rules: string[];
    behavior: { respondToChat: boolean; respondToEvents: boolean; cooldownSeconds: number; maxReplyLength: number };
}

export interface PetSettingsRecord {
    userId: Types.ObjectId;
    settings: PetSettings;
    revision: number;
    updatedAt: Date;
}

const settingsSchema = new Schema<PetSettings>({
    enabled: { type: Boolean, required: true },
    name: { type: String, required: true, maxlength: 40 },
    tts: {
        enabled: { type: Boolean, required: true },
        provider: { type: String, enum: ['piper', 'kokoro', 'fish'], required: true },
        language: { type: String, enum: ['en', 'es'], required: true },
        voice: { type: String, required: true, maxlength: 100 }
    },
    personality: {
        source: { type: String, enum: ['custom', 'profile'], required: true },
        profileId: { type: String, default: '' },
        prompt: { type: String, default: '', maxlength: 4000 }
    },
    rules: { type: [String], default: [] },
    behavior: {
        respondToChat: { type: Boolean, required: true },
        respondToEvents: { type: Boolean, required: true },
        cooldownSeconds: { type: Number, min: 0, max: 3600, required: true },
        maxReplyLength: { type: Number, min: 30, max: 500, required: true }
    }
}, { _id: false });

export const PetSettingsSchema = model<PetSettingsRecord>('pet_settings', new Schema<PetSettingsRecord>({
    userId: { type: Schema.Types.ObjectId, required: true, unique: true, ref: 'users' },
    settings: { type: settingsSchema, required: true },
    revision: { type: Number, required: true, min: 1 },
    updatedAt: { type: Date, required: true }
}, { versionKey: false }));
