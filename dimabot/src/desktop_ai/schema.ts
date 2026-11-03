import { Schema, model } from 'mongoose';

export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'indeterminate';
export interface DesktopTurn {
    _id: string; requestId: string; ownerId: string; clientId: string; channelId: string; sessionId: string;
    origin: 'oauth_desktop'; target: 'bot' | 'pet'; source: 'asr' | 'typed'; silent: boolean; text: string; fingerprint: string;
    conversationId: string; status: TurnStatus; revision: number; createdAt: Date; expiresAt: Date;
    executionFence?: string; runDeadline?: Date; replyText?: string; moodText?: string; errorCode?: string; petRequestId?: string;
    speech?: { playbackId: string; outputGeneration: number; status: string; destination: string; animatePet: boolean;
        ticketHash?: string; ticketExpiresAt?: Date; startBefore?: Date; startClaimed?: boolean; playbackDeadline?: Date; stopConfirmed?: boolean; errorCode?: string; privateDir?: string; path?: string; mimeType?: string; durationMs?: number };
    operations: { id: string; kind: string; status: 'pending' | 'completed' | 'failed'; outcome?: string }[];
}
const operationSchema = new Schema({ id: String, kind: String, status: String, outcome: String }, { _id: false });
const speechSchema = new Schema({ playbackId: String, outputGeneration: Number, status: String, destination: String, animatePet: Boolean,
    ticketHash: String, ticketExpiresAt: Date, startBefore: Date, startClaimed: Boolean, playbackDeadline: Date, stopConfirmed: Boolean, errorCode: String, privateDir: String, path: String, mimeType: String, durationMs: Number }, { _id: false });
const turn = new Schema<DesktopTurn>({
    _id: String, requestId: { type: String, required: true }, ownerId: { type: String, required: true },
    clientId: { type: String, required: true }, channelId: { type: String, required: true }, sessionId: { type: String, required: true },
    origin: { type: String, required: true }, target: { type: String, enum: ['bot', 'pet'], required: true }, source: { type: String, enum: ['asr', 'typed'], required: true },
    silent: { type: Boolean, required: true }, text: { type: String, required: true }, fingerprint: { type: String, required: true },
    conversationId: { type: String, required: true }, status: { type: String, required: true }, revision: { type: Number, required: true },
    createdAt: { type: Date, required: true }, expiresAt: { type: Date, required: true }, executionFence: String, runDeadline: Date,
    replyText: String, moodText: String, errorCode: String, petRequestId: String, speech: { type: speechSchema, default: undefined },
    operations: { type: [operationSchema], default: [] }
}, { versionKey: false, collection: 'desktop_ai_turns' });
turn.index({ ownerId: 1, clientId: 1, requestId: 1 }, { unique: true });
turn.index({ status: 1, createdAt: 1 });
turn.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
turn.index({ ownerId: 1, channelId: 1, target: 1, conversationId: 1, createdAt: 1 });
export const DesktopAiTurn = model<DesktopTurn>('DesktopAiTurn', turn);

export interface DesktopConversation { _id: string; ownerId: string; channelId: string; target: 'bot' | 'pet'; createdAt: Date; expiresAt: Date }
const conversation = new Schema<DesktopConversation>({ _id: String, ownerId: String, channelId: String, target: String, createdAt: Date, expiresAt: Date },
    { versionKey: false, collection: 'desktop_ai_conversations' });
conversation.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DesktopAiConversation = model<DesktopConversation>('DesktopAiConversation', conversation);
