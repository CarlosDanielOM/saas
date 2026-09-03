import { Schema, model, Types } from 'mongoose';

export type ClipRecommendationStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ClipRecommendationSource = 'stream_offline' | 'manual';
export type ClipRecommendationCandidateStatus = 'pending' | 'approved' | 'rejected' | 'confirmed' | 'denied';

export interface IClipRecommendationCandidate {
    _id: Types.ObjectId;
    startSeconds: number;
    endSeconds: number;
    reason: string;
    audioConfidence: number;
    videoApproved: boolean;
    videoWhy: string;
    s3Key: string;
    previewUrl: string;
    status: ClipRecommendationCandidateStatus;
    twitchClipID: string;
    created_at: Date;
}

export interface IClipRecommendation {
    _id: Types.ObjectId;
    channelID: string;
    channel: string;
    sessionID: string;
    streamID: string;
    vodID: string;
    vodUrl: string;
    source: ClipRecommendationSource;
    status: ClipRecommendationStatus;
    requestedBy: string;
    queueJobID?: string;
    modelID: string;
    vodDurationMinutes: number;
    costCredits: number;
    candidateCount: number;
    approvedCount: number;
    errorMessage: string;
    candidates: IClipRecommendationCandidate[];
    startedAt: Date | null;
    completedAt: Date | null;
    created_at: Date;
    updated_at: Date;
}

const clipRecommendationCandidateSchema = new Schema<IClipRecommendationCandidate>({
    startSeconds: { type: Number, required: true, min: 0 },
    endSeconds: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, default: '' },
    audioConfidence: { type: Number, default: 0, min: 0, max: 1 },
    videoApproved: { type: Boolean, default: false },
    videoWhy: { type: String, default: '' },
    s3Key: { type: String, default: '' },
    previewUrl: { type: String, default: '' },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'confirmed', 'denied'],
        default: 'pending',
        index: true
    },
    twitchClipID: { type: String, default: '' },
    created_at: { type: Date, default: Date.now }
});

const clipRecommendationSchema = new Schema<IClipRecommendation>({
    channelID: { type: String, required: true, index: true },
    channel: { type: String, default: '' },
    sessionID: { type: String, default: '', index: true },
    streamID: { type: String, default: '', index: true },
    vodID: { type: String, default: '' },
    vodUrl: { type: String, required: true, default: '' },
    source: { type: String, enum: ['stream_offline', 'manual'], required: true, default: 'manual', index: true },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending', index: true },
    requestedBy: { type: String, default: '' },
    queueJobID: { type: String },
    modelID: { type: String, default: 'meta/muse-spark-1.2-contributor' },
    vodDurationMinutes: { type: Number, default: 0 },
    costCredits: { type: Number, default: 0 },
    candidateCount: { type: Number, default: 0 },
    approvedCount: { type: Number, default: 0 },
    errorMessage: { type: String, default: '' },
    candidates: { type: [clipRecommendationCandidateSchema], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

clipRecommendationSchema.index({ channelID: 1, created_at: -1 });
clipRecommendationSchema.index({ channelID: 1, sessionID: 1, source: 1 });
clipRecommendationSchema.index({ status: 1, created_at: 1 });
clipRecommendationSchema.index({ queueJobID: 1 }, { unique: true, sparse: true });

export const ClipRecommendationSchema = model<IClipRecommendation>('ClipRecommendation', clipRecommendationSchema);
