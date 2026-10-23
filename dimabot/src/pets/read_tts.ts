/** API-only normal-TTS adapter. Providers and billing remain entirely in the normal queue. */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Users from '../schemas/users.schema.js';
import { PetRequest, PetRuntime, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { petPeers, selectedVtsController } from './peers.js';
import { emitPetReadyAndPlay } from './delivery.js';
import { finishRequest, invalidatePet, notifyPet, requestView, runtimeFor } from './state.js';
import { issueAudioTicket } from './tokens.js';
import { registerReadTtsBridge, type ReadTtsInput, type ReadTtsRoute, type ReadTtsTurnInput } from './tts_bridge.js';
import { inspectTtsAudio, ttsEnvelope } from './tts_envelope.js';

interface Turn {
    config: Awaited<ReturnType<typeof getPetConfiguration>>; input: ReadTtsInput; ownerId: string; token: string; generation: number; revision: number;
    protectedUntil: number; holdMs: number; ownershipLost?: boolean; detached?: boolean; reporting?: boolean; requestId?: string; delivered: boolean; envelope?: Awaited<ReturnType<typeof ttsEnvelope>>;
    followPeers: Set<string>; positionMs: number; serverTime: number; following: boolean;
}
const turns = new Map<string, Turn>();
// One tracked normal-queue head per channel; parking releases Turn, not this identity.
const heads = new Map<string, { owner: string; speech: string; config: Turn['config'] }>();
const observations = new Map<string, string>();
const changes = new Map<string, number>();
const waits = new Map<string, { done: () => void; timer: NodeJS.Timeout; deadline: number; promise: Promise<void> }>();
function signal(owner: string) {
    const wait = waits.get(owner);
    if (!wait && ![...heads.values()].some(head => head.owner === owner) && ![...turns.values()].some(turn => turn.ownerId === owner)) return;
    changes.set(owner, (changes.get(owner) ?? 0) + 1);
    if (wait) { waits.delete(owner); clearTimeout(wait.timer); wait.done(); }
}
function forgetOwner(owner: string) {
    if ([...heads.values()].some(head => head.owner === owner) || [...turns.values()].some(turn => turn.ownerId === owner)) return;
    signal(owner); observations.delete(owner); changes.delete(owner);
}
function waitForChange(owner: string, deadline: number, serial: number, cancellation?: AbortSignal) {
    if (cancellation?.aborted || (changes.get(owner) ?? 0) !== serial) return Promise.resolve();
    const cancellable = (pending: Promise<void>) => !cancellation ? pending : new Promise<void>(resolve => {
        const done = () => { cancellation.removeEventListener('abort', done); resolve(); };
        cancellation.addEventListener('abort', done, { once: true }); pending.then(done, done);
        if (cancellation.aborted) done();
    });
    const prior = waits.get(owner);
    if (prior) {
        if (deadline < prior.deadline) { clearTimeout(prior.timer); prior.deadline = deadline; prior.timer = setTimeout(() => { waits.delete(owner); prior.done(); }, Math.max(1, deadline - Date.now())); }
        return cancellable(prior.promise);
    }
    let done!: () => void;
    const promise = new Promise<void>(resolve => { done = resolve; });
    const timer = setTimeout(() => { waits.delete(owner); done(); }, Math.max(1, deadline - Date.now()));
    waits.set(owner, { done, timer, deadline, promise }); return cancellable(promise);
}
function wakeOwner(owner: string) {
    signal(owner);
    for (const [channel, head] of heads) if (head.owner === owner)
        void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.resumeIfIdle(channel)).catch(() => {});
}
function observe(runtime: { _id: string; generation: number; activeRequestId: string | null; notBefore: Date; lease?: { leaseId: string } | null }) {
    if (![...heads.values()].some(head => head.owner === runtime._id)) return;
    // Renewing the same lease is not a readiness transition.
    const value = JSON.stringify([runtime.generation, runtime.activeRequestId, runtime.notBefore, runtime.lease?.leaseId]);
    const prior = observations.get(runtime._id); observations.set(runtime._id, value);
    if (prior !== undefined && prior !== value) wakeOwner(runtime._id);
}
async function readConfiguration(channelId: string) {
    const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelId } } }).select('_id').lean();
    if (!owner) return null;
    try {
        const config = await getPetConfiguration(String(owner._id), channelId);
        return config.settings.enabled && config.settings.sources.readTts ? { ownerId: String(owner._id), config } : null;
    } catch { return null; } // No plan/account: retain the existing overlay path.
}
// Coalesce the repeated queue guards/reservation check. Default-off channels add
// one bounded configuration observation, never another provider/credit operation.
const configurations = new Map<string, { expiresAt: number; promise: ReturnType<typeof readConfiguration> }>();
function configuration(channel: string) {
    for (const [key, entry] of configurations) if (entry.expiresAt <= Date.now()) configurations.delete(key);
    const prior = configurations.get(channel);
    if (prior && prior.expiresAt > Date.now()) return prior.promise;
    if (configurations.size >= 1024) configurations.delete(configurations.keys().next().value!);
    const promise = readConfiguration(channel);
    configurations.set(channel, { expiresAt: Date.now() + 5000, promise });
    return promise;
}
async function player(ownerId: string, channelId: string) {
    const { settings, runtime: readiness, revision } = await getPetConfiguration(ownerId, channelId);
    if (!readiness.readTtsEnabled) return null;
    const runtime = await runtimeFor(ownerId, channelId);
    const peer = runtime.lease && runtime.lease.expiresAt.getTime() > Date.now() ? petPeers.get(runtime.lease.holderPeerId) : null;
    if (!peer?.socket.connected || !peer.audioReady) return null;
    await peer.revalidate();
    if (settings.appearance.kind === 'vts' && !await selectedVtsController(ownerId, settings.playback.vtsSessionId)) return null;
    if (settings.playback.target === 'browser' ? peer.kind !== 'browser' || settings.appearance.kind === 'png' && !peer.renderReady :
        peer.kind !== 'desktop' || peer.sessionId !== settings.playback.desktopSessionId) return null;
    return { runtime, peer, revision };
}
async function endFollow(turn: Turn) {
    if (!turn.following) return;
    turn.following = false;
    for (const id of turn.followPeers) petPeers.get(id)?.socket.emit('pet:follow-end', { v: 1, followId: turn.input.speechId, generation: turn.generation });
    turn.followPeers.clear();
}
async function release(channel: string, speech: string, parked = false) {
    const identity = heads.get(channel);
    if (!parked && identity?.speech === speech) { heads.delete(channel); if (![...heads.values()].some(head => head.owner === identity.owner)) observations.delete(identity.owner); }
    if (identity) signal(identity.owner);
    const turn = turns.get(channel);
    if (!turn || turn.input.speechId !== speech) { if (identity) forgetOwner(identity.owner); return; }
    turns.delete(channel); // Claim before awaits/terminal callbacks; never release a newer turn.
    await endFollow(turn);
    if (turn.requestId) {
        const request = await PetRequest.findById(turn.requestId).lean();
        if (request && !['completed', 'cancelled', 'failed', 'expired'].includes(request.status)) {
            for (const peer of petPeers.values()) if (peer.ownerId === turn.ownerId) peer.socket.emit('pet:stop', { v: 1, requestId: turn.requestId, generation: turn.generation, reason: 'tts_ended' });
            await finishRequest(turn.requestId, 'cancelled', 'tts_ended');
            if (request.privateDir && path.dirname(request.privateDir) === tmpdir() && path.basename(request.privateDir).startsWith('dima-pet-')) await rm(request.privateDir, { recursive: true, force: true });
        }
    }
    await PetRuntime.updateOne({ _id: turn.ownerId, 'ttsReservation.token': turn.token }, { $set: { ttsReservation: null } });
    await notifyPet(turn.ownerId);
    forgetOwner(turn.ownerId);
}
/** Startup completes before any API socket/queue producer is made available. */
export async function reconcileReadTtsStartup() {
    while (true) {
        const stale = await PetRuntime.find({ 'ttsReservation.token': { $type: 'string' } }).limit(64).lean();
        if (!stale.length) return;
        for (const runtime of stale) {
            // Single API ownership: fence the exact old generation/request/lease.
            // invalidatePet carries the old lease expiry into notBefore; never shorten it.
            const invalidated = await invalidatePet(runtime._id, 'api_restarted', {
                requestId: runtime.activeRequestId, generation: runtime.generation,
                ...(runtime.lease ? { leaseId: runtime.lease.leaseId, leaseExpiresAt: runtime.lease.expiresAt } : {})
            });
            if (invalidated) await PetRuntime.updateOne({ _id: runtime._id, generation: runtime.generation + 1,
                'ttsReservation.token': runtime.ttsReservation!.token }, { $set: { ttsReservation: null } });
        }
    }
}
async function reserve(input: ReadTtsTurnInput): Promise<boolean> {
    if (input.cancelled()) return false;
    const existing = turns.get(input.channelId);
    if (existing?.input.speechId === input.speechId) return true;
    const selected = await configuration(input.channelId);
    if (input.cancelled()) return false;
    const retained = heads.get(input.channelId);
    if (!selected && retained?.speech !== input.speechId) return true; // Default-off adds no turn.
    // A paid normal head outlives read-TTS settings. Keep arbitration until its
    // one overlay fallback ends, with pet animation/delivery detached.
    const { ownerId, config } = selected ?? { ownerId: retained!.owner, config: retained!.config };
    const token = randomUUID();
    heads.set(input.channelId, { owner: ownerId, speech: input.speechId, config });
    const waitUntil = Date.now() + 120_000;
    // Contention waits BEFORE synthesis/usage. Never discard a generated item on busy.
    while (!input.cancelled()) {
        const serial = changes.get(ownerId) ?? 0;
        const runtime = await runtimeFor(ownerId, input.channelId);
        observe(runtime);
        if (input.cancelled()) return false;
        const claimed = await PetRuntime.findOneAndUpdate({ _id: ownerId, generation: runtime.generation,
            notBefore: { $lte: new Date() }, 'ttsReservation.expiresAt': { $not: { $gt: new Date() } }
        }, { $set: { ttsReservation: { speechId: input.speechId, token, expiresAt: new Date(Date.now() + 240_000) } } }, { new: true }).lean();
        if (claimed) {
            // A skip/new turn can overtake the Mongo response. Clean only our token,
            // including acquisition which completed after release found no local turn.
            if (input.cancelled() || turns.has(input.channelId)) {
                await PetRuntime.updateOne({ _id: ownerId, 'ttsReservation.token': token }, { $set: { ttsReservation: null } });
                signal(ownerId);
                return false;
            }
            turns.set(input.channelId, { input: { ...input, file: '', mime: '', text: '' }, config, ownerId, token,
                generation: claimed.generation, revision: config.revision, detached: !selected, delivered: false, protectedUntil: claimed.ttsReservation!.expiresAt.getTime(), holdMs: 240_000,
                followPeers: new Set(), following: false, positionMs: -1, serverTime: 0 });
            return true;
        }
        if (Date.now() >= waitUntil) return false;
        // A single deadline, or an observed owner transition, wakes the pending claim.
        const expires = runtime.ttsReservation?.expiresAt?.getTime() ?? 0;
        await waitForChange(ownerId, Math.min(waitUntil, runtime.notBefore.getTime() > Date.now() ? runtime.notBefore.getTime() : expires > Date.now() ? expires : waitUntil), serial, input.signal);
    }
    return false;
}
async function protect(channel: string, speech: string, holdMs: number) {
    const turn = turns.get(channel);
    if (!turn || turn.input.speechId !== speech || turn.ownershipLost) return false;
    turn.holdMs = Math.max(turn.holdMs, holdMs);
    const until = Date.now() + turn.holdMs;
    const renewed = await PetRuntime.updateOne({ _id: turn.ownerId, 'ttsReservation.token': turn.token,
        'ttsReservation.expiresAt': { $gt: new Date() } }, { $max: { 'ttsReservation.expiresAt': new Date(until) } });
    if (!renewed.matchedCount || turns.get(channel) !== turn) { turn.ownershipLost = true; await endFollow(turn); return false; }
    turn.protectedUntil = Math.max(turn.protectedUntil, until);
    return true;
}
async function prepare(input: ReadTtsInput): Promise<ReadTtsRoute | null> {
    const cancelledRoute = { audio: 'cancelled' as const, durationMs: 0 };
    if (!await reserve(input)) return input.cancelled() ? cancelledRoute : { audio: 'waiting', durationMs: 0 };
    const turn = turns.get(input.channelId);
    if (!turn || turn.input.speechId !== input.speechId) return null;
    turn.input = input;
    const { ownerId, token, config } = turn;
    const cancelled = () => input.cancelled() || turns.get(input.channelId) !== turn;
    let directory: string | undefined;
    try {
        if (!await protect(input.channelId, input.speechId, input.holdMs ?? 240_000) || cancelled()) return cancelledRoute;
        // A ready independent request owns its complete turn. A pending TTS reservation prevents starvation.
        const waitUntil = Date.now() + 120_000;
        while (!cancelled()) {
            const serial = changes.get(ownerId) ?? 0;
            const current = await PetRuntime.findById(ownerId).lean();
            if (!current || current.ttsReservation?.token !== token) return cancelledRoute;
            if (current.generation !== turn.generation) { turn.detached = true; turn.generation = current.generation; }
            if (!current.activeRequestId && current.notBefore.getTime() <= Date.now()) break;
            if (Date.now() >= waitUntil) return { audio: 'waiting', durationMs: 0 };
            const active = current.activeRequestId ? await PetRequest.findById(current.activeRequestId).lean() : null;
            const deadline = Math.min(waitUntil, current.notBefore.getTime() > Date.now() ? current.notBefore.getTime() : active?.phaseDeadline?.getTime() ?? waitUntil);
            if (deadline <= Date.now()) return { audio: 'waiting', durationMs: 0 };
            await waitForChange(ownerId, deadline, serial, input.signal);
        }
        if (cancelled()) return cancelledRoute;
        const analysis = input.analysis ??= {};
        if (!analysis.inspected) {
            try { analysis.durationMs = await inspectTtsAudio(input.file); } catch { analysis.durationMs = 0; }
            analysis.inspected = true;
        }
        const durationMs = analysis.durationMs || 0;
        const overlay = async (): Promise<ReadTtsRoute> => {
            if (!analysis.enveloped) { try { analysis.envelope = await ttsEnvelope(input.file); } catch {} analysis.enveloped = true; }
            turn.envelope = analysis.envelope;
            return cancelled() ? cancelledRoute : { audio: 'overlay', durationMs: durationMs || 60_000 };
        };
        if (cancelled()) return cancelledRoute;
        if (!turn.detached && config.settings.ttsAudio === 'pet' && durationMs && ['audio/wav', 'audio/mpeg'].includes(input.mime)) {
            const elected = await player(ownerId, input.channelId);
            if (elected && elected.revision === turn.revision && elected.runtime.generation === turn.generation && !cancelled()) {
                directory = await mkdtemp(path.join(tmpdir(), 'dima-pet-'));
                const audioPath = path.join(directory, input.mime === 'audio/wav' ? 'speech.wav' : 'speech.mp3');
                await copyFile(input.file, audioPath);
                const id = randomUUID(), now = new Date();
                const request = await PetRequest.create({ _id: id, ownerId, channelId: input.channelId, operation: 'tts', text: input.text,
                    outputText: input.text, origin: { kind: 'tts-queue', id: input.speechId, occurredAt: now.toISOString() }, actionKey: `tts:${input.attemptId ?? token}`, actor: { userId: '', displayName: '' }, payloadHash: input.speechId,
                    admitted: true, generation: turn.generation, settingsRevision: turn.revision, status: 'ready', version: 1,
                    startBefore: new Date(Date.now() + 5000), phaseDeadline: new Date(Date.now() + durationMs + 10_000),
                    privateDir: directory, audio: { path: audioPath, mimeType: input.mime, durationMs }, createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400_000) });
                turn.requestId = id;
                const linked = await PetRuntime.updateOne({ _id: ownerId, generation: turn.generation, activeRequestId: null,
                    'ttsReservation.token': token, 'lease.leaseId': elected.runtime.lease!.leaseId, 'lease.expiresAt': { $gt: new Date() } }, { $set: { activeRequestId: id } });
                if (!linked.modifiedCount || cancelled()) throw new Error('pre_delivery_rejected');
                const privateDir = directory;
                directory = undefined; // The prepared attempt/release owns this private copy now.
                return { audio: 'pet', durationMs, fallback: overlay, emit: async beforeEmit => {
                    try {
                        const ticket = await issueAudioTicket(elected.peer, request.toObject(), elected.runtime.lease!);
                        const latest = await player(ownerId, input.channelId);
                        if (cancelled() || turn.detached || latest?.revision !== turn.revision || latest.runtime.generation !== turn.generation || latest.runtime.activeRequestId !== id || latest.runtime.lease?.leaseId !== elected.runtime.lease!.leaseId || latest.peer !== elected.peer) throw new Error('pre_delivery_rejected');
                        const attempted = await PetRequest.updateOne({ _id: id, status: 'ready', generation: turn.generation }, { $set: { deliveryAttempted: true } });
                        if (!attempted.modifiedCount || turn.detached || cancelled() || turn.protectedUntil <= Date.now() || request.startBefore!.getTime() <= Date.now()) throw new Error('pre_delivery_rejected');
                        const sent = emitPetReadyAndPlay(elected.peer, turn.generation, requestView(request.toObject())!, { v: 1, requestId: id, generation: turn.generation,
                            leaseId: elected.runtime.lease!.leaseId, startBefore: request.startBefore!.getTime(), audio: {
                                url: `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/playback/${id}/audio?ticket=${ticket}`, mimeType: input.mime, durationMs } }, () => {
                                    if (cancelled() || !beforeEmit()) return false;
                                    turn.delivered = true; return true;
                                });
                        if (!sent) throw new Error('pre_delivery_rejected');
                        await notifyPet(ownerId); return true;
                    } catch (error) {
                        if (turn.delivered) { await input.ended('pet:outcome_unknown'); throw error; }
                        await finishRequest(id, 'failed', 'pre_delivery_rejected');
                        if (turn.requestId === id) turn.requestId = undefined;
                        await rm(privateDir!, { recursive: true, force: true });
                        return false;
                    }
                } };

            }
        }
        return await overlay();
    } catch (error) {
        if (turn.delivered) { await input.ended('pet:outcome_unknown'); return cancelledRoute; }
        if (turn.requestId) await finishRequest(turn.requestId, 'failed', 'pre_delivery_rejected');
        turn.requestId = undefined;
        if (cancelled()) return cancelledRoute;
        try { turn.envelope = await ttsEnvelope(input.file); } catch {}
        return { audio: 'overlay', durationMs: 60_000 }; // Same file; never synthesize or debit here.
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
async function report(channel: string, speech: string, phase: string, position: number) {
    const turn = turns.get(channel);
    if (!turn || turn.input.speechId !== speech || turn.delivered || !['playing', 'progress', 'recovering'].includes(phase) || !Number.isFinite(position) || position < 0 || position > 3600) return;
    const positionMs = Math.floor(position * 1000);
    if (positionMs <= turn.positionMs) return; // An unchanged report never refreshes a stalled client's anchor.
    // The queue's 60s advancing-progress watchdog always expires before this proof.
    // Renewal also applies to detached/oversized envelopes: silent animation is optional.
    if (!await protect(channel, speech, turn.holdMs)) { await turn.input.ended('tts_turn_lost'); return; }
    if (positionMs > 60_000) { turn.detached = true; await endFollow(turn); }
    if (turn.detached || !turn.envelope) { turn.positionMs = positionMs; return; }
    const current = await PetRuntime.findById(turn.ownerId).lean();
    const config = await getPetConfiguration(turn.ownerId, channel);
    if (turns.get(channel) !== turn || !current || current.generation !== turn.generation || current.activeRequestId || current.ttsReservation?.token !== turn.token || config.revision !== turn.revision || !config.runtime.readTtsEnabled) {
        await endFollow(turn); return;
    }
    const controller = config.settings.appearance.kind === 'vts' ? await selectedVtsController(turn.ownerId, config.settings.playback.vtsSessionId) : null;
    const selected = [...petPeers.values()].filter(peer => peer.ownerId === turn.ownerId && peer.socket.connected &&
        (peer === controller || config.settings.appearance.kind === 'png' && peer.kind === 'browser' && peer.renderReady));
    if (turns.get(channel) !== turn || positionMs <= turn.positionMs) return;
    turn.positionMs = positionMs; turn.serverTime = Math.max(Date.now(), turn.serverTime + 1);
    for (const peer of selected) {
        try { await peer.revalidate(); } catch { continue; }
        if (turns.get(channel) !== turn) return;
        const initial = !turn.followPeers.has(peer.id);
        peer.socket.emit('pet:follow', { v: 1, followId: speech, generation: turn.generation,
            ...(initial ? { envelope: turn.envelope } : {}), positionMs, serverTime: turn.serverTime });
        turn.followPeers.add(peer.id); turn.following = true;
    }
}
export function startReadTts() {
    registerReadTtsBridge({
        available: async channel => { const selected = await configuration(channel); return !!selected && selected.config.settings.ttsAudio === 'pet' && !!await player(selected.ownerId, channel); },
        configured: async channel => !!await configuration(channel),
        owns: (channel, speech) => { const turn = turns.get(channel); return !!turn && (!speech || turn.input.speechId === speech); },
        current: (channel, speech, minimumHoldMs = 0) => { const turn = turns.get(channel); return !!turn && turn.input.speechId === speech && !turn.ownershipLost && turn.protectedUntil > Date.now() + minimumHoldMs; },
        protect, reserve, park: (channel, speech) => release(channel, speech, true), owners: () => [...new Set([...heads.values()].map(head => head.owner))], observe, resume: async channel => {
            const { ttsQueueHandler } = await import('../handlers/tts_queue.handler.js');
            await ttsQueueHandler.resumeIfIdle(channel);
        },
        prepare, release, report: async (channel, speech, phase, position) => {
            const turn = turns.get(channel);
            if (!turn || turn.reporting) return;
            turn.reporting = true;
            try { await report(channel, speech, phase, position); } finally { turn.reporting = false; }
        },
        terminal: async (request: PetRequestRecord) => {
            const turn = turns.get(request.channelId);
            if (turn?.requestId === request._id && turn.delivered) await turn.input.ended(`pet:${request.status}`);
        },
        invalidated: async (owner, reason) => { configurations.clear(); wakeOwner(owner); for (const turn of [...turns.values()]) if (turn.ownerId === owner) {
            if (turn.delivered || reason === 'cancelled') await turn.input.ended('pet:state_changed');
            else { turn.detached = true; await endFollow(turn); }
        } }
    });
    return async () => { for (const turn of [...turns.values()]) await release(turn.input.channelId, turn.input.speechId); registerReadTtsBridge(); configurations.clear(); heads.clear(); observations.clear(); for (const owner of [...waits.keys()]) signal(owner); changes.clear(); };
}
