import { randomUUID } from 'node:crypto';
import type { Server as SocketServer, Socket } from 'socket.io';
import { authenticateAccess, hash, type AccessIdentity } from '../server/oauth/service.js';
import { OAuthError } from '../server/oauth/catalog.js';
import { PetSettingsError } from '../server/services/pet_settings.service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { refreshPetReadiness } from './readiness.js';
import { OAuthSession } from '../schemas/oauth_session.schema.js';
import { PetRuntime, PetRequest } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration, requirePetPlan } from '../server/services/pet_settings.service.js';
import { authenticatePetCapability } from './tokens.js';
import { petPeers, selectedVtsController, type PetPeer } from './peers.js';
import { LEASE_TTL_MS, PetError, finishRequest, invalidatePet, notifyPet, runtimeFor } from './state.js';
import { isSelectedPlayer, sendPetSnapshot, startPetRuntime } from './runtime.js';

function known(error: unknown): error is PetError | OAuthError | PetSettingsError {
    return error instanceof PetError || error instanceof OAuthError || error instanceof PetSettingsError;
}
function input(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 4096 ||
        Object.keys(value).some(key => !keys.includes(key)) || (value as { v?: unknown }).v !== 1) throw new PetError('invalid_message');
    return value as Record<string, unknown>;
}
async function activeIdentity(peer: PetPeer, value: Record<string, unknown>, mouth = false) {
    const runtime = await PetRuntime.findById(peer.ownerId).lean();
    if (!runtime || runtime.activeRequestId !== value.requestId || runtime.generation !== value.generation ||
        runtime.lease?.leaseId !== value.leaseId || runtime.lease.holderPeerId !== peer.id || runtime.lease.expiresAt.getTime() <= Date.now()) throw new PetError('stale_playback', 409);
    if (peer.sequenceRequestId !== value.requestId) { peer.sequenceRequestId = String(value.requestId); peer.seq = -1; peer.mouthSeq = -1; }
    if (!Number.isSafeInteger(value.seq) || Number(value.seq) <= (mouth ? peer.mouthSeq : peer.seq) ||
        !Number.isFinite(value.positionMs) || Number(value.positionMs) < 0 || Number(value.positionMs) > 60_000) throw new PetError('invalid_playback');
    const request = await PetRequest.findById(String(value.requestId)).lean();
    if (!request?.audio || !['ready', 'playing'].includes(request.status) || Number(value.positionMs) > request.audio.durationMs + 1000) throw new PetError('stale_playback', 409);
    return request;
}
export async function registerPetSockets(io: SocketServer) {
    const closeRuntime = await startPetRuntime();
    for (const kind of ['desktop', 'browser'] as const) {
        const namespace = io.of(kind === 'desktop' ? '/desktop' : '/pet');
        // Other site namespaces retain their existing recovery policy. Pet peers
        // must always authenticate afresh and never restore/replay a session.
        namespace.adapter.persistSession = () => {};
        namespace.adapter.restoreSession = async () => { throw new PetError('fresh_auth_required', 401); };
        namespace.use((socket, next) => {
            void (async () => {
                const auth = input(socket.handshake.auth, kind === 'desktop' ? ['v', 'accessToken'] : ['v', 'capability']);
                if (['token', 'accessToken', 'capability', 'authorization'].some(key => key in socket.handshake.query)) throw new PetError('invalid_auth');
                if (socket.recovered) throw new PetError('fresh_auth_required', 401);
                let identity: AccessIdentity | undefined;
                let ownerId: string, channelId: string, label = 'Browser source', tokenHash: string | undefined;
                if (kind === 'desktop') {
                    identity = await authenticateAccess(auth.accessToken);
                    if (!['desktop:connect', 'pet:read', 'pet:receive'].every(scope => identity!.scopes.includes(scope))) throw new PetError('insufficient_scope', 403);
                    if ([...petPeers.values()].filter(peer => peer.sessionId === identity!.session_id).length >= 2) throw new PetError('too_many_connections', 429);
                    ownerId = identity.user_id; channelId = identity.channel_id;
                    const session = await OAuthSession.findById(identity.session_id).select('device_name').lean();
                    label = session?.device_name || 'Desktop';
                } else {
                    const authorized = await authenticatePetCapability(auth.capability);
                    ownerId = authorized.runtime._id; channelId = authorized.runtime.channelId;
                    tokenHash = authorized.runtime.tokenHash!;
                }
                if ([...petPeers.values()].filter(peer => peer.ownerId === ownerId).length >= 16 || petPeers.size >= 1024) throw new PetError('too_many_connections', 429);
                await getPetConfiguration(ownerId, channelId);
                const peer: PetPeer = { validatedAt: 0, authorizationExpiresAt: 0, id: randomUUID(), socket, ownerId, channelId, kind,
                    sessionId: identity?.session_id, label, tokenHash,
                    capability: kind === 'browser' ? String(auth.capability) : undefined,
                    scopes: identity?.scopes ?? [], audioReady: false, renderReady: false, vtsReady: false,
                    seq: -1, mouthSeq: -1, lastMouthAt: 0, lastProgressAt: 0, busy: false,
                    revalidate: async () => {
                        if (kind === 'desktop') {
                            const current = await authenticateAccess(auth.accessToken);
                            if (current.session_id !== identity!.session_id || current.user_id !== ownerId ||
                                !['desktop:connect', 'pet:read', 'pet:receive'].every(scope => current.scopes.includes(scope))) throw new PetError('invalid_token', 401);
                            peer.scopes = current.scopes;
                            await requirePetPlan(ownerId, channelId);
                            const validatedAt = Date.now();
                            const ttl = await (await getDragonflyClient('pet-auth')).pTTL(`oauth:access:${hash(String(auth.accessToken))}`);
                            const session = await OAuthSession.findById(current.session_id).select('expires_at idle_expires_at').lean();
                            if (ttl <= 0 || !session) throw new PetError('invalid_token', 401);
                            peer.validatedAt = validatedAt;
                            peer.authorizationExpiresAt = Math.min(validatedAt + ttl, session.expires_at.getTime(), session.idle_expires_at.getTime());
                        } else {
                            const current = await authenticatePetCapability(auth.capability);
                            if (current.runtime._id !== ownerId || current.runtime.tokenHash !== tokenHash) throw new PetError('invalid_capability', 401);
                        }
                    }
                };
                socket.data.petPeer = peer;
            })().then(() => next(), error => {
                const failure = new Error(known(error) ? error.code : 'unauthorized') as Error & { data: unknown };
                failure.data = { code: failure.message }; next(failure);
            });
        });
        namespace.on('connection', socket => {
            const peer = socket.data.petPeer as PetPeer;
            // Recheck after asynchronous handshake to bound simultaneous connects.
            if ([...petPeers.values()].filter(item => item.sessionId && item.sessionId === peer.sessionId).length >= 2) return void socket.disconnect(true);
            petPeers.set(peer.id, peer);
            if (kind === 'desktop') socket.emit('desktop:hello', { v: 1, sessionId: peer.sessionId, channelId: peer.channelId, scopes: peer.scopes });
            void sendPetSnapshot(peer).catch(() => socket.disconnect(true));
            let windowStart = Date.now(), messageCount = 0;
            const pending: Array<() => Promise<void>> = [];
            const drain = async () => {
                if (peer.busy) return;
                peer.busy = true;
                try { while (pending.length && socket.connected) await pending.shift()!(); }
                finally { peer.busy = false; }
            };
            const on = (event: string, handler: (data: Record<string, unknown>) => Promise<unknown>, keys: string[]) => {
                socket.on(event, (raw: unknown, acknowledge: unknown) => {
                    const ack = typeof acknowledge === 'function' ? acknowledge as (response: unknown) => void : () => {};
                    let data: Record<string, unknown>;
                    try { data = input(raw, keys); } catch { return ack({ ok: false, error: { code: 'invalid_message' } }); }
                    const telemetry = event === 'pet:mouth' || event === 'pet:playback' && data.phase === 'progress';
                    // Samples/progress are lossy; never queue a stream of obsolete samples.
                    if (telemetry && (peer.busy || pending.length)) return ack({ ok: true, data: { dropped: true } });
                    const now = Date.now();
                    if (now - windowStart >= 1000) { windowStart = now; messageCount = 0; }
                    const terminal = event === 'pet:playback' && ['ended', 'stopped', 'error'].includes(String(data.phase));
                    if ((!telemetry && !terminal && ++messageCount > 30) || pending.length >= (terminal ? 16 : 15)) return ack({ ok: false, error: { code: 'rate_limited', retryAfterMs: 1000 } });
                    pending.push(async () => {
                        try { await peer.revalidate(); ack({ ok: true, data: await handler(data) }); }
                        catch (error) {
                            ack({ ok: false, error: { code: known(error) ? error.code : 'temporarily_unavailable' } });
                            if (!known(error) || error.status === 401 || error.status === 403) socket.disconnect(true);
                        }
                    });
                    void drain();
                });
            };
            on('pet:ready', async value => {
                if (['audioReady', 'renderReady', 'vtsReady'].some(key => typeof value[key] !== 'boolean')) throw new PetError('invalid_message');
                if (peer.audioReady === value.audioReady && peer.renderReady === value.renderReady && peer.vtsReady === value.vtsReady) return {};
                peer.audioReady = value.audioReady as boolean; peer.renderReady = value.renderReady as boolean; peer.vtsReady = value.vtsReady as boolean;
                const runtime = await runtimeFor(peer.ownerId, peer.channelId);
                await refreshPetReadiness(peer.ownerId);
                const configuration = await getPetConfiguration(peer.ownerId, peer.channelId);
                if (runtime.lease?.holderPeerId === peer.id && (!peer.audioReady || configuration.settings.appearance.kind === 'png' && peer.kind === 'browser' && !peer.renderReady)) await invalidatePet(peer.ownerId, 'player_unready');
                else if (configuration.runtime.issues.includes('vts_unavailable') && runtime.lease) await invalidatePet(peer.ownerId, 'vts_unavailable');
                await notifyPet(peer.ownerId);
                return {};
            }, ['v', 'audioReady', 'renderReady', 'vtsReady']);
            on('pet:lease', async value => {
                if (!await isSelectedPlayer(peer)) throw new PetError('player_not_selected', 409);
                let runtime = await runtimeFor(peer.ownerId, peer.channelId);
                if (value.action === 'acquire') {
                    if (value.leaseId !== undefined || value.generation !== undefined) throw new PetError('invalid_message');
                    if (runtime.lease && runtime.lease.expiresAt.getTime() <= Date.now()) { await invalidatePet(peer.ownerId, 'lease_expired'); runtime = await runtimeFor(peer.ownerId, peer.channelId); }
                    if (runtime.lease && runtime.lease.holderPeerId !== peer.id || runtime.notBefore.getTime() > Date.now()) throw new PetError('lease_unavailable', 409);
                    if (!runtime.lease) {
                        const next = await PetRuntime.findOneAndUpdate({ _id: peer.ownerId, generation: runtime.generation, lease: null, notBefore: { $lte: new Date() } }, {
                            $set: { lease: { leaseId: randomUUID(), holderPeerId: peer.id, expiresAt: new Date(Date.now() + LEASE_TTL_MS) } }
                        }, { new: true }).lean();
                        if (!next) throw new PetError('lease_unavailable', 409);
                        runtime = next; peer.seq = -1; peer.mouthSeq = -1;
                    }
                } else if (value.action === 'renew') {
                    if (typeof value.leaseId !== 'string' || value.leaseId.length > 64 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) throw new PetError('invalid_message');
                    const next = await PetRuntime.findOneAndUpdate({ _id: peer.ownerId, generation: value.generation,
                        'lease.leaseId': value.leaseId, 'lease.holderPeerId': peer.id, 'lease.expiresAt': { $gt: new Date() } },
                        { $set: { 'lease.expiresAt': new Date(Date.now() + LEASE_TTL_MS) } }, { new: true }).lean();
                    if (!next) throw new PetError('stale_lease', 409);
                    runtime = next;
                } else throw new PetError('invalid_message');
                await notifyPet(peer.ownerId);
                return { leaseId: runtime.lease!.leaseId, generation: runtime.generation, serverTime: Date.now(), expiresAt: runtime.lease!.expiresAt.getTime(), ttlMs: LEASE_TTL_MS };
            }, ['v', 'action', 'leaseId', 'generation']);
            on('pet:playback', async value => {
                if (!['started', 'progress', 'ended', 'stopped', 'error'].includes(String(value.phase)) ||
                    value.errorCode !== undefined && (typeof value.errorCode !== 'string' || value.errorCode.length > 64)) throw new PetError('invalid_playback');
                if (value.phase === 'progress' && Date.now() - peer.lastProgressAt < 200) return { dropped: true };
                const request = await activeIdentity(peer, value);
                peer.seq = Number(value.seq);
                if (value.phase === 'started') {
                    if (request.status !== 'ready' || !request.startBefore || request.startBefore.getTime() < Date.now()) throw new PetError('stale_playback', 409);
                    await PetRequest.updateOne({ _id: request._id, status: 'ready' }, { $set: { status: 'playing' }, $inc: { version: 1 } });
                } else if (value.phase === 'progress') {
                    if (request.status !== 'playing') throw new PetError('invalid_playback');
                    peer.lastProgressAt = Date.now();
                    return {}; // Progress never changes renderer/request state.
                }
                else if (['ended', 'stopped', 'error'].includes(String(value.phase))) {
                    await finishRequest(request._id, value.phase === 'ended' ? 'completed' : value.phase === 'stopped' ? 'cancelled' : 'failed',
                        value.phase === 'error' ? 'playback_error' : undefined);
                }
                await notifyPet(peer.ownerId);
                return {};
            }, ['v', 'requestId', 'leaseId', 'generation', 'seq', 'phase', 'positionMs', 'errorCode']);
            on('pet:mouth', async value => {
                if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 || value.value > 1) throw new PetError('invalid_mouth');
                if (Date.now() - peer.lastMouthAt < 40) return { dropped: true };
                const request = await activeIdentity(peer, value, true);
                if (request.status !== 'playing') throw new PetError('stale_playback', 409);
                peer.lastMouthAt = Date.now(); peer.mouthSeq = Number(value.seq);
                const { settings } = await getPetConfiguration(peer.ownerId, peer.channelId);
                const controller = settings.appearance.kind === 'vts' ? await selectedVtsController(peer.ownerId, settings.playback.vtsSessionId) : null;
                if (controller) { await controller.revalidate(); controller.socket.emit('pet:mouth', value); }
                return {};
            }, ['v', 'requestId', 'leaseId', 'generation', 'seq', 'positionMs', 'value']);
            socket.once('disconnect', () => {
                petPeers.delete(peer.id);
                void (async () => {
                    await refreshPetReadiness(peer.ownerId);
                    const runtime = await PetRuntime.findById(peer.ownerId).lean();
                    if (runtime?.lease?.holderPeerId === peer.id) await invalidatePet(peer.ownerId, 'player_disconnected');
                    else {
                        const configuration = await getPetConfiguration(peer.ownerId, peer.channelId);
                        if (runtime?.lease && configuration.runtime.issues.includes('vts_unavailable')) await invalidatePet(peer.ownerId, 'vts_unavailable');
                        else await notifyPet(peer.ownerId);
                    }
                })().catch(() => {});
            });
        });
    }
    let checking = false;
    const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => { for (const peer of petPeers.values()) {
            try { await peer.revalidate(); } catch { peer.socket.disconnect(true); }
        }
        for (const ownerId of new Set([...petPeers.values()].map(peer => peer.ownerId))) await refreshPetReadiness(ownerId);
        })().catch(() => {}).finally(() => { checking = false; });
    }, 15_000); timer.unref();
    return async () => { clearInterval(timer); for (const peer of petPeers.values()) peer.socket.disconnect(true); await closeRuntime(); };
}
