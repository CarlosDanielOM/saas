import { Schema, model } from 'mongoose';

export const PET_STATUSES = ['accepted', 'generating', 'synthesizing', 'ready', 'playing', 'completed', 'cancelled', 'failed', 'expired'] as const;
export type PetStatus = typeof PET_STATUSES[number];
export const PET_TERMINAL: PetStatus[] = ['completed', 'cancelled', 'failed', 'expired'];
export interface PetRequestRecord {
    _id: string; ownerId: string; channelId: string; operation: 'talk' | 'ask' | 'tts'; text: string;
    origin: { kind: 'chat-command' | 'twitch-event' | 'tts-queue'; id: string; occurredAt: string };
    actionKey: string; actor: { userId: string; displayName: string }; payloadHash: string;
    admitted: boolean; startBefore?: Date; generation: number; settingsRevision: number; status: PetStatus; version: number;
    outputText?: string; errorCode?: string; phaseDeadline: Date;
    deliveryAttempted?: boolean; audioFetched?: boolean;
    privateDir?: string; audio?: { path: string; mimeType: 'audio/wav' | 'audio/mpeg'; durationMs: number };
    createdAt: Date; expiresAt: Date;
}
const request = new Schema<PetRequestRecord>({
    _id: String, ownerId: { type: String, required: true }, channelId: String, operation: String, text: String,
    origin: { kind: String, id: String, occurredAt: String }, actionKey: String,
    actor: { userId: String, displayName: String }, payloadHash: String,
    admitted: { type: Boolean, default: false }, startBefore: Date, generation: Number, settingsRevision: Number, status: { type: String, enum: PET_STATUSES }, version: Number,
    deliveryAttempted: Boolean, audioFetched: Boolean, privateDir: String, outputText: String, errorCode: String, phaseDeadline: Date,
    audio: { type: new Schema({ path: String, mimeType: String, durationMs: Number }, { _id: false }), default: null },
    createdAt: Date, expiresAt: Date
}, { versionKey: false, collection: 'pet_requests' });
request.index({ ownerId: 1, 'origin.kind': 1, 'origin.id': 1, actionKey: 1 }, { unique: true });
request.index({ status: 1, phaseDeadline: 1 });
// Retain request identity/outcomes for seven days; active phase deadlines are at most 60 seconds.
request.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PetRequest = model<PetRequestRecord>('PetRequest', request);

export interface PetRuntimeRecord {
    _id: string; channelId: string; generation: number; activeRequestId: string | null;
    lease: { leaseId: string; holderPeerId: string; expiresAt: Date } | null;
    notBefore: Date; lastAcceptedAt: Date | null; admissionClaimId?: string | null;
    ttsReservation?: { speechId: string; token: string; expiresAt: Date } | null;
    tokenHash: string | null; overlayToken: { iv: string; content: string } | null;
}
const runtimeSchema = new Schema<PetRuntimeRecord>({
    _id: String, channelId: String, generation: { type: Number, default: 1 }, activeRequestId: { type: String, default: null },
    lease: { type: new Schema({ leaseId: String, holderPeerId: String, expiresAt: Date }, { _id: false }), default: null },
    notBefore: { type: Date, default: () => new Date(0) }, lastAcceptedAt: { type: Date, default: null },
    admissionClaimId: { type: String, default: null },
    ttsReservation: { type: new Schema({ speechId: String, token: String, expiresAt: Date }, { _id: false }), default: null },
    tokenHash: { type: String, default: null }, overlayToken: { iv: String, content: String }
}, { versionKey: false, collection: 'pet_runtimes' });
runtimeSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });

runtimeSchema.index({ 'lease.expiresAt': 1 });
export const PetRuntime = model<PetRuntimeRecord>('PetRuntime', runtimeSchema);
