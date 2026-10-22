import { PetRequest, PetRuntime, PET_TERMINAL, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';

export const PET_WAKE = 'pet:runtime:wake:v1';
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
    // Mongo is authoritative. A failed/lost publish is recovered by the bounded API scan.
    try { await (await getDragonflyClient('pet-wake')).publish(PET_WAKE, ownerId); }
    catch { /* Never report admission failure after durable admission. */ }
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
        await PetRuntime.updateOne({ _id: request.ownerId, activeRequestId: id }, { $set: { activeRequestId: null } });
        await notifyPet(request.ownerId);
    }
    return request;
}
/** Invalidate first, then notify. Old players keep their conservative expiry; new leases wait it out. */
export async function invalidatePet(ownerId: string, reason: string) {
    const previous = await PetRuntime.findOneAndUpdate({ _id: ownerId }, [{ $set: {
        generation: { $add: ['$generation', 1] }, lease: null, activeRequestId: null,
        notBefore: { $max: ['$notBefore', { $ifNull: ['$lease.expiresAt', new Date(0)] }] }
    } }]).lean();
    if (previous?.activeRequestId) await finishRequest(previous.activeRequestId, 'cancelled', reason);
    await notifyPet(ownerId);
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
        if (runtime?.activeRequestId === id) await invalidatePet(ownerId, 'cancelled');
        else await finishRequest(id, 'cancelled', 'cancelled');
    }
    return { requestId: id, status: (await PetRequest.findById(id).lean())!.status };
}
