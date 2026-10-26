import { randomUUID } from 'node:crypto';
import { PetRequest, PetRuntime, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { finishRequest, notifyPet, runtimeFor } from './state.js';

export type PetClaim = { kind: 'promoted'; request: PetRequestRecord } | { kind: 'dropped'; errorCode: string } | { kind: 'wait'; retryAt?: number };
type Configuration = Awaited<ReturnType<typeof getPetConfiguration>>;

/** Oldest waiting request in the pet's own (independent) queue. */
export function nextIndependentQueued(ownerId: string) {
    return PetRequest.findOne({ ownerId, status: 'queued', lane: { $ne: 'tts' } }).sort({ createdAt: 1, _id: 1 }).lean();
}

/** Settings that turned a queued request off end it; temporary readiness problems only wait. */
function disabledReason(request: PetRequestRecord, configuration: Configuration) {
    const { settings } = configuration;
    if (settings.sources?.independent === false) return 'pet_source_disabled';
    if (!settings.enabled || !settings.tts.enabled) return 'pet_unavailable';
    if (!(request.origin.kind === 'chat-command' ? settings.behavior.respondToChat : settings.behavior.respondToEvents)) return 'trigger_disabled';
    if (request.operation === 'talk' && request.text.length > settings.behavior.maxReplyLength) return 'text_too_long';
    return null;
}

/**
 * Move one queued request into the single active slot with the same runtime
 * compare-and-set fences as direct admission (no active request, no pending TTS
 * turn, same lease). Independent requests also wait for the cooldown; TTS-lane
 * requests already wait their turn in the TTS queue, so they skip it and do not
 * wait on readiness problems that would stall that queue.
 */
export async function claimQueued(request: PetRequestRecord, options: { lane: 'independent' | 'tts' }): Promise<PetClaim> {
    let configuration: Configuration;
    try { configuration = await getPetConfiguration(request.ownerId, request.channelId); }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'pet_unavailable';
        return drop(request, /^[a-z_]{1,80}$/.test(code) ? code : 'pet_unavailable');
    }
    const disabled = disabledReason(request, configuration);
    if (disabled) return drop(request, disabled);
    const strict = options.lane === 'tts';
    if (!configuration.runtime.enabled) return strict ? drop(request, configuration.runtime.issues[0] ?? 'pet_unavailable') : { kind: 'wait' };
    const runtime = await runtimeFor(request.ownerId, request.channelId);
    const now = new Date();
    if (!runtime.lease || runtime.lease.expiresAt <= now) return strict ? drop(request, 'player_unavailable') : { kind: 'wait' };
    if (runtime.activeRequestId) return { kind: 'wait' };
    if (runtime.ttsReservation && runtime.ttsReservation.expiresAt > now) return { kind: 'wait', retryAt: runtime.ttsReservation.expiresAt.getTime() };
    const cooldownMs = strict ? 0 : configuration.settings.behavior.cooldownSeconds * 1000;
    if (cooldownMs && runtime.lastAcceptedAt && runtime.lastAcceptedAt.getTime() + cooldownMs > now.getTime()) {
        return { kind: 'wait', retryAt: runtime.lastAcceptedAt.getTime() + cooldownMs };
    }
    const claimId = randomUUID();
    const claimed = await PetRuntime.findOneAndUpdate({ _id: request.ownerId, activeRequestId: null, generation: runtime.generation,
        'ttsReservation.expiresAt': { $not: { $gt: now } }, 'lease.leaseId': runtime.lease.leaseId, 'lease.expiresAt': { $gt: now },
        ...(cooldownMs ? { $or: [{ lastAcceptedAt: null }, { lastAcceptedAt: { $lte: new Date(now.getTime() - cooldownMs) } }] } : {})
    }, { $set: { activeRequestId: request._id, lastAcceptedAt: now, admissionClaimId: claimId } }).lean();
    if (!claimed) return { kind: 'wait' };
    const claimFilter = { _id: request.ownerId, activeRequestId: request._id, generation: runtime.generation, admissionClaimId: claimId, 'lease.leaseId': runtime.lease.leaseId };
    const promoted = await PetRequest.findOneAndUpdate({ _id: request._id, status: 'queued' }, {
        $set: { status: 'accepted', admitted: true, generation: runtime.generation, settingsRevision: configuration.revision, phaseDeadline: new Date(now.getTime() + 60_000) },
        $inc: { version: 1 }
    }, { new: true }).lean();
    if (!promoted) {
        // Cancelled or expired while queued: give back only this claim and its cooldown stamp.
        await PetRuntime.updateOne({ ...claimFilter, lastAcceptedAt: now }, { $set: { activeRequestId: null, lastAcceptedAt: claimed.lastAcceptedAt ?? null }, $unset: { admissionClaimId: 1 } });
        await notifyPet(request.ownerId);
        return { kind: 'dropped', errorCode: 'request_not_queued' };
    }
    await PetRuntime.updateOne(claimFilter, { $unset: { admissionClaimId: 1 } });
    await notifyPet(request.ownerId);
    return { kind: 'promoted', request: promoted };
}
async function drop(request: PetRequestRecord, errorCode: string): Promise<PetClaim> {
    await finishRequest(request._id, 'failed', errorCode);
    return { kind: 'dropped', errorCode };
}
