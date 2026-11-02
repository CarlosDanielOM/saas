import { petDiagnostic } from './diagnostics.js';
import { PetRequest, PetRuntime, PET_TERMINAL, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { petWakeups } from './wakeups.js';
import { readTtsTerminal, invalidateReadTts } from './tts_bridge.js';
import { petLaneTerminal } from './tts_lane.js';
import { PetReadiness } from './readiness.schema.js';
import { finishMatchingSpeechActivity, retireMatchingSpeechActivity } from '../desktop_ai/activity.js';

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
    // Released desktop/browser players only know the original statuses. A request is
    // briefly linked as active before its queued -> accepted update lands.
    return { requestId: request._id, operation: request.operation, status: request.status === 'queued' ? 'accepted' as const : request.status, version: request.version,
        ...(request.outputText ? { text: request.outputText } : {}), ...(request.errorCode ? { errorCode: request.errorCode } : {}) };
}
export async function finishRequest(id: string, status: 'completed' | 'cancelled' | 'failed' | 'expired', errorCode?: string, expected?: { ownerId: string; generation: number }, playbackStopped = false) {
    const request = await PetRequest.findOneAndUpdate({ _id: id, ...expected, status: { $nin: PET_TERMINAL } }, {
        $set: { status, ...(errorCode ? { errorCode } : {}) }, $inc: { version: 1 }
    }, { new: true }).lean();
    if (request) {
        petDiagnostic(request.channelId, 'terminal', { requestId: request._id, generation: request.generation, operation: request.operation, status, reason: errorCode ?? status, playbackStarted: request.playbackStarted === true, startRemainingMs: request.startBefore ? request.startBefore.getTime() - Date.now() : undefined });
        // A server-side terminal only requests player stop. Once audio has been
        // prepared it may already be audible, even if the player's started ACK
        // was lost. Retain the durable activity until its conservative deadline
        // unless the elected player reported that it actually stopped.
        if (playbackStopped || !request.audio) await finishMatchingSpeechActivity(request.channelId, request._id, request.generation, errorCode || status).catch(() => {});
        await PetRuntime.updateOne({ _id: request.ownerId, activeRequestId: id, ...(expected ? { generation: expected.generation } : {}) }, { $set: { activeRequestId: null }, $unset: { admissionClaimId: 1 } });
        await readTtsTerminal(request);
        petLaneTerminal(request);
        await notifyPet(request.ownerId);
    }
    return request;
}
/** Invalidate first, then notify. Old players keep their conservative expiry; new leases wait it out. */
export async function invalidatePet(ownerId: string, reason: string, expected?: { requestId: string | null; generation: number; leaseId?: string; leaseExpiresAt?: Date }, terminal?: { status: 'expired' | 'failed' | 'cancelled'; errorCode: string }) {
    const previous = await PetRuntime.findOneAndUpdate({ _id: ownerId, ...(expected ? { activeRequestId: expected.requestId, generation: expected.generation,
        ...(expected.leaseId ? { 'lease.leaseId': expected.leaseId } : {}), ...(expected.leaseExpiresAt ? { 'lease.expiresAt': expected.leaseExpiresAt } : {}) } : {}) }, [{ $set: {
        generation: { $add: ['$generation', 1] }, lease: null, activeRequestId: null, admissionClaimId: null,
        notBefore: { $max: ['$notBefore', { $ifNull: ['$lease.expiresAt', new Date(0)] }] }
    } }]).lean();
    if (!previous) return false;
    // The CAS above removes the lease, so its captured expiry is the latest
    // deadline that the old player can hold. Record the proof before sending
    // stop notifications, allowing an in-flight terminal report to release it.
    if (previous.activeRequestId && previous.lease) {
        const request = await PetRequest.findById(previous.activeRequestId).lean();
        if (request?.audio) {
            const origin = request.origin as { kind: string; id?: string };
            const playbackId = request.operation === 'tts' && origin.kind === 'tts-queue' ? origin.id : request._id;
            if (playbackId) await retireMatchingSpeechActivity(request.channelId, playbackId,
                request.operation === 'tts' ? undefined : request.generation, previous.lease.expiresAt.getTime(),
                { kind: 'pet', ownerId, peerId: previous.lease.holderPeerId, leaseId: previous.lease.leaseId,
                    requestId: request._id, generation: request.generation }).catch(() => {});
        }
    }
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
