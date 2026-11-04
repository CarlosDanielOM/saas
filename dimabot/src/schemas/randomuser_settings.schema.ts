import { Schema, model } from 'mongoose';

export interface RandomUserSettings {
    channelID: string;
    blacklist: string[];
}

const schema = new Schema<RandomUserSettings>({
    channelID: { type: String, required: true, unique: true },
    blacklist: { type: [String], default: [] }
}, { timestamps: true });

export const RandomUserSettingsSchema = model<RandomUserSettings>('random_user_settings', schema);
