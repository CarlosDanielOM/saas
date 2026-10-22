import { Schema, model } from 'mongoose';
export interface PetReadinessRecord {
    _id: string; generation: number; settingsRevision: number; sessionId: string; peerId: string;
    apiInstanceId: string; validatedAt: Date; authorizationExpiresAt: Date; expiresAt: Date;
}
const schema = new Schema<PetReadinessRecord>({
    _id: String, generation: Number, settingsRevision: Number, sessionId: String, peerId: String,
    apiInstanceId: String, validatedAt: Date, authorizationExpiresAt: Date, expiresAt: Date
}, { versionKey: false, collection: 'pet_readiness' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PetReadiness = model<PetReadinessRecord>('PetReadiness', schema);
