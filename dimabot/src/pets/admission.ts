import { createHash, randomUUID } from 'node:crypto';
import Users from '../schemas/users.schema.js';
import { PetRequest, PetRuntime, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { PetError, finishRequest, notifyPet, runtimeFor } from './state.js';

/** Internal trusted effect only. Source identity must be derived by the command/event engine. */
export interface AdmitPetActionInput {
    channelId: string; operation: 'talk' | 'ask'; text: string;
    origin: { kind: 'chat-command' | 'twitch-event'; id: string; occurredAt: string };
    actionKey: string; actor: { userId: string; displayName: string };
}
export async function admitPetAction(input: AdmitPetActionInput): Promise<{ requestId: string; status: string }> {
    if (!input || !/^\d{1,30}$/.test(input.channelId) || !['talk', 'ask'].includes(input.operation) ||
        typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
        !['chat-command', 'twitch-event'].includes(input.origin?.kind) ||
        typeof input.origin.id !== 'string' || !input.origin.id.trim() || input.origin.id.length > 200 ||
        typeof input.origin.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.origin.occurredAt)) ||
        typeof input.actionKey !== 'string' || !input.actionKey.trim() || input.actionKey.length > 200 ||
        typeof input.actor?.userId !== 'string' || !input.actor.userId || input.actor.userId.length > 100 ||
        typeof input.actor.displayName !== 'string' || input.actor.displayName.length > 100) throw new PetError('invalid_origin');
    const user = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: input.channelId } } }).select('_id').lean();
    if (!user) throw new PetError('account_required', 403);
    const ownerId = String(user._id);
    const identity = { ownerId, 'origin.kind': input.origin.kind, 'origin.id': input.origin.id, actionKey: input.actionKey };
    const payloadHash = createHash('sha256').update(JSON.stringify({ operation: input.operation, text: input.text,
        actor: { userId: input.actor.userId, displayName: input.actor.displayName }, occurredAt: input.origin.occurredAt })).digest('hex');
    await PetRequest.init();
    const resolveAdmission = async (record: PetRequestRecord) => {
        if (record.admitted || record.status !== 'accepted') {
            if (record.errorCode === 'busy') throw new PetError('busy', 409);
            return { requestId: record._id, status: record.status };
        }
        const configuration = await getPetConfiguration(ownerId, input.channelId);
        const runtime = await runtimeFor(ownerId, input.channelId);
        const now = new Date();
        if (!configuration.runtime.enabled || !configuration.settings.tts.enabled || configuration.revision !== record.settingsRevision || runtime.generation !== record.generation || !runtime.lease || runtime.lease.expiresAt <= now) {
            await finishRequest(record._id, 'expired', 'admission_expired');
            throw new PetError('admission_expired', 409);
        }
        // Both creator and duplicate can resolve this claim. No duplicate reports accepted
        // until the durable request is linked to the sole runtime slot.
        const claimed = await PetRuntime.updateOne({ _id: ownerId, activeRequestId: null, generation: record.generation,
            'lease.leaseId': runtime.lease.leaseId, 'lease.expiresAt': { $gt: now },
            $or: [{ lastAcceptedAt: null }, { lastAcceptedAt: { $lte: new Date(now.getTime() - configuration.settings.behavior.cooldownSeconds * 1000) } }]
        }, { $set: { activeRequestId: record._id, lastAcceptedAt: now } });
        const linked = claimed.modifiedCount || (await PetRuntime.findOne({ _id: ownerId, activeRequestId: record._id, generation: record.generation }).lean());
        if (!linked) { await finishRequest(record._id, 'failed', 'busy'); throw new PetError('busy', 409); }
        const admitted = await PetRequest.findOneAndUpdate({ _id: record._id, status: 'accepted' }, { $set: { admitted: true } }, { new: true }).lean();
        if (!admitted) throw new PetError('admission_expired', 409);
        await notifyPet(ownerId);
        return { requestId: admitted._id, status: admitted.status };
    };
    const duplicate = async () => {
        const record = await PetRequest.findOne(identity).lean();
        if (!record) return null;
        if (record.payloadHash !== payloadHash) throw new PetError('idempotency_conflict', 409);
        if (record.errorCode === 'busy') throw new PetError('busy', 409);
        return resolveAdmission(record);
    };
    const prior = await duplicate();
    if (prior) return prior;
    const configuration = await getPetConfiguration(ownerId, input.channelId);
    const settings = configuration.settings;
    if (!configuration.runtime.enabled || !settings.tts.enabled) throw new PetError(configuration.runtime.issues[0] ?? 'pet_unavailable', 409);
    if (!(input.origin.kind === 'chat-command' ? settings.behavior.respondToChat : settings.behavior.respondToEvents)) throw new PetError('trigger_disabled', 403);
    if (input.operation === 'talk' && input.text.length > settings.behavior.maxReplyLength) throw new PetError('text_too_long');
    const runtime = await runtimeFor(ownerId, input.channelId);
    if (runtime.activeRequestId) throw new PetError('busy', 409);
    if (!runtime.lease || runtime.lease.expiresAt.getTime() <= Date.now()) throw new PetError('player_unavailable', 409);
    if (runtime.lastAcceptedAt && runtime.lastAcceptedAt.getTime() + settings.behavior.cooldownSeconds * 1000 > Date.now()) throw new PetError('cooldown', 429);
    const now = new Date(), requestId = randomUUID();
    try {
        await PetRequest.create({ _id: requestId, ...input, ownerId, payloadHash, status: 'accepted', version: 1,
            admitted: false, generation: runtime.generation, settingsRevision: configuration.revision,
            phaseDeadline: new Date(now.getTime() + 60_000), createdAt: now, expiresAt: new Date(now.getTime() + 7 * 86400_000) });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) return (await duplicate())!;
        throw error;
    }
    return resolveAdmission((await PetRequest.findById(requestId).lean())!);
}
