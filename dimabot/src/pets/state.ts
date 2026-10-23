import { PetRequest, PetRuntime, PET_TERMINAL, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { petWakeups } from './wakeups.js';
import { readTtsTerminal, invalidateReadTts } from './tts_bridge.js';
import { PetReadiness } from './readiness.schema.js';

export { PET_WAKE } from './wakeups.js';
export const LEASE_TTL_MS = 15_000;
export class PetError extends Error {
    constructor(readonly code: string, readonly status = 400, readonly retryAfterMs?: number) { super(code); }
}
export async function runtimeFor(ownerId: string, channelId: string) {
    await PetRuntime.init();
    await PetRuntime.updateOne({ _id: ownerId }, { $setOnInsert: { channelId, generation: 1, activeRequestId: null,
        lease: null, notBefore: new Date(0), lastAcceptedAt: null, tokenHash: null, overlayToken: null } }, { upsert: true });
    return (await PetRuntime.findById(ownerId).lean())!;
}
export async function notifyPet(ownerId: string): Promise<void> {
    // Scheduling only: Redis connection/publication can never delay the Mongo ACK.
    petWakeups.notify(ownerId);
}
export function requestView(request: PetRequestRecord | null) {
    if (!request) return null;
    return { requestId: request._id, operation: request.operation, status: request.status, version: request.version,
        ...(request.outputText ? { text: request.outputText } : {}), ...(request.errorCode ? { errorCode: request.errorCode } : {}) };
}
export async function finishRequest(id: string, status: 'completed' | 'cancelled' | 'failed' | 'expired', errorCode?: string) {
    const request = await PetRequest.findOneAndUpdate({ _id: id, status: { $nin: PET_TERMINAL } }, {
        $set: { status, ...(errorCode ? { errorCode } : {}) }, $inc: { version: 1 }
    }, { new: true }).lean();
    if (request) {
        await PetRuntime.updateOne({ _id: request.ownerId, activeRequestId: id }, { $set: { activeRequestId: null }, $unset: { admissionClaimId: 1 } });
        await readTtsTerminal(request);
        await notifyPet(request.ownerId);
    }
    return request;
}
/** Invalidate first, then notify. Old players keep their conservative expiry; new leases wait it out. */
export async function invalidatePet(ownerId: string, reason: string, expected?: { requestId: string | null; generation: number; leaseId?: string; leaseExpiresAt?: Date }, terminal?: { status: 'expired'; errorCode: string }) {
    const previous = await PetRuntime.findOneAndUpdate({ _id: ownerId, ...(expected ? { activeRequestId: expected.requestId, generation: expected.generation,
        ...(expected.leaseId ? { 'lease.leaseId': expected.leaseId } : {}), ...(expected.leaseExpiresAt ? { 'lease.expiresAt': expected.leaseExpiresAt } : {}) } : {}) }, [{ $set: {
        generation: { $add: ['$generation', 1] }, lease: null, activeRequestId: null, admissionClaimId: null,
        notBefore: { $max: ['$notBefore', { $ifNull: ['$lease.expiresAt', new Date(0)] }] }
    } }]).lean();
    if (!previous) return false;
    await invalidateReadTts(ownerId, reason);
    await PetReadiness.deleteOne({ _id: ownerId, generation: { $lte: previous.generation } });
    if (previous.activeRequestId) await finishRequest(previous.activeRequestId, terminal?.status ?? 'cancelled', terminal?.errorCode ?? reason);
    await notifyPet(ownerId);
    return true;
}
export function commandId(input: unknown) {
    if (typeof input !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(input)) throw new PetError('invalid_command');
    return input;
}
export async function cancelPetRequest(ownerId: string, id: string, command: unknown) {
    commandId(command);
    const request = await PetRequest.findOne({ _id: id, ownerId }).lean();
    if (!request) throw new PetError('request_not_found', 404);
    if (!PET_TERMINAL.includes(request.status)) {
        const runtime = await PetRuntime.findById(ownerId).lean();
        if (runtime?.activeRequestId === id) await invalidatePet(ownerId, 'cancelled', { requestId: id, generation: request.generation });
        // If A completed/replaced while the CAS waited, this only touches A.
        await finishRequest(id, 'cancelled', 'cancelled');
    }
    return { requestId: id, status: (await PetRequest.findById(id).lean())!.status };
}
