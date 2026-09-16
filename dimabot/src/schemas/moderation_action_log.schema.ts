import { Schema, model } from 'mongoose';

export interface IModerationActionLog {
    channelID: string;
    userID: string;
    username: string;
    ruleID: string;
    ruleType: string;
    action: 'off' | 'warn' | 'delete' | 'timeout' | 'ban';
    offenseNumber: number;
    reason: string;
    messageID: string;
    messageExcerpt: string;
    success: boolean;
    errorMessage: string | null;
    createdAt: Date;
}

const moderationActionLogSchema = new Schema<IModerationActionLog>({
    channelID: { type: String, required: true, index: true },
    userID: { type: String, required: true },
    username: { type: String, default: '' },
    ruleID: { type: String, required: true },
    ruleType: { type: String, required: true },
    action: { type: String, enum: ['off', 'warn', 'delete', 'timeout', 'ban'], required: true },
    offenseNumber: { type: Number, default: 1 },
    reason: { type: String, default: '' },
    messageID: { type: String, default: '' },
    messageExcerpt: { type: String, default: '', maxlength: 200 },
    success: { type: Boolean, default: false },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});

moderationActionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const ModerationActionLogSchema = model<IModerationActionLog>('moderation_action_log', moderationActionLogSchema);
