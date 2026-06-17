import { Schema, model } from 'mongoose';

export type FollowDefenseLanguage = 'en' | 'es';

export interface IFollowDefenseSettings {
    channelID: string;
    channel: string;
    enabled: boolean;
    silentModeEnabled: boolean;
    protectionModeEnabled: boolean;
    attackModeEnabled: boolean;
    silentThresholdX: number;
    silentWindowYSeconds: number;
    protectionThresholdB: number;
    attackThreshold: number;
    silentDurationSeconds: number;
    baselineFollowsPerHour: number | null;
    language: FollowDefenseLanguage;
    settingsVersion: number;
    createdAt: Date;
    updatedAt: Date;
}

const followDefenseSettingsSchema = new Schema<IFollowDefenseSettings>({
    channelID: { type: String, required: true, unique: true, index: true },
    channel: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    silentModeEnabled: { type: Boolean, default: true },
    protectionModeEnabled: { type: Boolean, default: true },
    attackModeEnabled: { type: Boolean, default: true },
    silentThresholdX: { type: Number, default: 10, min: 1 },
    silentWindowYSeconds: { type: Number, default: 5, min: 1 },
    protectionThresholdB: { type: Number, default: 100, min: 1 },
    attackThreshold: { type: Number, default: 500, min: 1 },
    silentDurationSeconds: { type: Number, default: 60, min: 1 },
    baselineFollowsPerHour: { type: Number, default: null },
    language: { type: String, enum: ['en', 'es'], default: 'en' },
    settingsVersion: { type: Number, default: 1 }
}, {
    timestamps: true
});

export const FollowDefenseSettingsSchema = model<IFollowDefenseSettings>('follow_defense_settings', followDefenseSettingsSchema);
