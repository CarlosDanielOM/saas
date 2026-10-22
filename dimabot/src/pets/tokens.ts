import { randomBytes } from 'node:crypto';
import { PetRuntime, PetRequest, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { manageOverlayToken, readOverlayToken, overlayTokenHash, storedOverlayToken } from '../utils/overlay-token.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { petPeers, type PetPeer } from './peers.js';
import { invalidatePet, PetError, runtimeFor } from './state.js';

function tokenStore(ownerId: string, channelId: string) {
    return {
        read: () => runtimeFor(ownerId, channelId),
        save: async (expectedHash: string | null, token: string, replace: boolean) => {
            const result = await PetRuntime.updateOne({ _id: ownerId, tokenHash: expectedHash }, { $set: storedOverlayToken(token) });
            if (result.matchedCount && replace) await invalidatePet(ownerId, 'overlay_rotated');
            return result.matchedCount === 1;
        }
    };
}
export async function petOverlayToken(ownerId: string, channelId: string, input?: unknown) {
    await getPetConfiguration(ownerId, channelId);
    const store = tokenStore(ownerId, channelId);
    return input === undefined ? readOverlayToken(store) : manageOverlayToken(store, input,
        (code, _message, status) => { throw new PetError(code, status); });
}
export async function authenticatePetCapability(capability: unknown) {
    if (typeof capability !== 'string' || !/^[\w-]{43}$/.test(capability)) throw new PetError('invalid_capability', 401);
    const runtime = await PetRuntime.findOne({ tokenHash: overlayTokenHash(capability) }).lean();
    if (!runtime) throw new PetError('invalid_capability', 401);
    const configuration = await getPetConfiguration(runtime._id, runtime.channelId);
    return { runtime, configuration };
}
export async function issueAudioTicket(peer: PetPeer, request: PetRequestRecord, lease: { leaseId: string; expiresAt: Date }) {
    const ticket = randomBytes(32).toString('base64url');
    const record = { ownerId: peer.ownerId, peerId: peer.id, requestId: request._id, generation: request.generation,
        leaseId: lease.leaseId, tokenHash: peer.tokenHash ?? null, sessionId: peer.sessionId ?? null,
        expiresAt: Math.min(lease.expiresAt.getTime(), Date.now() + 5000) };
    await (await getDragonflyClient('pet-audio')).set(`pet:audio:${overlayTokenHash(ticket)}`, JSON.stringify(record), { EX: 5 });
    return ticket;
}
export async function authorizePetAudio(requestId: string, ticket: unknown) {
    if (typeof ticket !== 'string' || !/^[\w-]{43}$/.test(ticket)) throw new PetError('invalid_ticket', 401);
    const raw = await (await getDragonflyClient('pet-audio')).get(`pet:audio:${overlayTokenHash(ticket)}`);
    if (!raw) throw new PetError('invalid_ticket', 401);
    const record = JSON.parse(raw) as { ownerId: string; peerId: string; requestId: string; generation: number; leaseId: string;
        tokenHash: string | null; sessionId: string | null; expiresAt: number };
    const peer = petPeers.get(record.peerId);
    if (!peer || !peer.socket.connected || peer.ownerId !== record.ownerId || (peer.sessionId ?? null) !== record.sessionId ||
        record.requestId !== requestId || record.expiresAt <= Date.now()) throw new PetError('stale_ticket', 403);
    await peer.revalidate();
    const runtime = await PetRuntime.findById(record.ownerId).lean();
    if (!runtime || runtime.generation !== record.generation || runtime.activeRequestId !== requestId ||
        runtime.lease?.leaseId !== record.leaseId || runtime.lease.holderPeerId !== peer.id || runtime.lease.expiresAt.getTime() <= Date.now() ||
        record.tokenHash && record.tokenHash !== runtime.tokenHash) throw new PetError('stale_ticket', 403);
    const request = await PetRequest.findById(requestId).lean();
    if (!request?.audio || !['ready', 'playing'].includes(request.status)) throw new PetError('audio_unavailable', 404);
    return request.audio;
}
