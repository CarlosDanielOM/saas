import { Schema, model, Types } from 'mongoose';

export interface IClipRecommendationConfig {
    _id: Types.ObjectId;
    channelID: string;
    autoAnalyzeEnabled: boolean;
    lastAnalyzedAt: Date | null;
    created_at: Date;
    updated_at: Date;
}

const clipRecommendationConfigSchema = new Schema<IClipRecommendationConfig>({
    channelID: { type: String, required: true, unique: true, index: true },
    autoAnalyzeEnabled: { type: Boolean, default: false, index: true },
    lastAnalyzedAt: { type: Date, default: null }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

export const ClipRecommendationConfigSchema = model<IClipRecommendationConfig>(
    'ClipRecommendationConfig',
    clipRecommendationConfigSchema
);
