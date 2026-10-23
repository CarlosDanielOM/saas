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
import { finishRequest, notifyPet, requestView, runtimeFor } from './state.js';
import { issueAudioTicket } from './tokens.js';
import { registerReadTtsBridge, type ReadTtsInput, type ReadTtsRoute } from './tts_bridge.js';
import { inspectTtsAudio, ttsEnvelope } from './tts_envelope.js';

interface Turn {
    input: ReadTtsInput; ownerId: string; token: string; generation: number; revision: number;
    detached?: boolean; reporting?: boolean; requestId?: string; delivered: boolean; envelope?: Awaited<ReturnType<typeof ttsEnvelope>>;
    followPeers: Set<string>; positionMs: number; serverTime: number; following: boolean;
}
const turns = new Map<string, Turn>();
async function configuration(channelId: string) {
    const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelId } } }).select('_id').lean();
    if (!owner) return null;
    try {
        const config = await getPetConfiguration(String(owner._id), channelId);
        return config.runtime.readTtsEnabled ? { ownerId: String(owner._id), config } : null;
    } catch { return null; } // No plan/account: retain the existing overlay path.
}
async function player(ownerId: string, channelId: string) {
    const { settings, runtime: readiness } = await getPetConfiguration(ownerId, channelId);
    if (!readiness.readTtsEnabled) return null;
    const runtime = await runtimeFor(ownerId, channelId);
    const peer = runtime.lease && runtime.lease.expiresAt.getTime() > Date.now() ? petPeers.get(runtime.lease.holderPeerId) : null;
    if (!peer?.socket.connected || !peer.audioReady) return null;
    await peer.revalidate();
    if (settings.appearance.kind === 'vts' && !await selectedVtsController(ownerId, settings.playback.vtsSessionId)) return null;
    if (settings.playback.target === 'browser' ? peer.kind !== 'browser' || settings.appearance.kind === 'png' && !peer.renderReady :
        peer.kind !== 'desktop' || peer.sessionId !== settings.playback.desktopSessionId) return null;
    return { runtime, peer };
}
async function endFollow(turn: Turn) {
    if (!turn.following) return;
    turn.following = false;
    for (const id of turn.followPeers) petPeers.get(id)?.socket.emit('pet:follow-end', { v: 1, followId: turn.input.speechId, generation: turn.generation });
    turn.followPeers.clear();
}
async function release(channel: string, speech: string) {
    const turn = turns.get(channel);
    if (!turn || turn.input.speechId !== speech) return;
    turns.delete(channel); // Claim before awaits/terminal callbacks; never release a newer turn.
    await endFollow(turn);
    if (turn.requestId) {
        const request = await PetRequest.findById(turn.requestId).lean();
        if (request && !['completed', 'cancelled', 'failed', 'expired'].includes(request.status)) {
            for (const peer of petPeers.values()) if (peer.ownerId === turn.ownerId) peer.socket.emit('pet:stop', { v: 1, requestId: turn.requestId, generation: turn.generation, reason: 'tts_ended' });
            await finishRequest(turn.requestId, 'cancelled', 'tts_ended');
        }
    }
    await PetRuntime.updateOne({ _id: turn.ownerId, 'ttsReservation.token': turn.token }, { $set: { ttsReservation: null } });
    await notifyPet(turn.ownerId);
}
async function prepare(input: ReadTtsInput): Promise<ReadTtsRoute | null> {
    const selected = await configuration(input.channelId);
    if (!selected) return null;
    const { ownerId, config } = selected;
    const runtime = await runtimeFor(ownerId, input.channelId), token = randomUUID();
    // Shared Mongo CAS fences API, bot and cron admissions, including a concurrent producer CAS.
    const claimed = await PetRuntime.findOneAndUpdate({ _id: ownerId, generation: runtime.generation,
        'ttsReservation.expiresAt': { $not: { $gt: new Date() } } }, { $set: {
        ttsReservation: { speechId: input.speechId, token, expiresAt: new Date(Date.now() + 240_000) }
    } }, { new: true }).lean();
    if (!claimed) throw new Error('tts_reservation_busy');
    const turn: Turn = { input, ownerId, token, generation: claimed.generation, revision: config.revision, delivered: false,
        followPeers: new Set(), following: false, positionMs: -1, serverTime: 0 };
    turns.set(input.channelId, turn);
    const cancelled = () => input.cancelled() || turns.get(input.channelId) !== turn;
    const cancelledRoute = { audio: 'cancelled' as const, durationMs: 0 };
    let directory: string | undefined;
    try {
        // A ready independent request owns its complete turn. A pending TTS reservation prevents starvation.
        const waitUntil = Date.now() + 120_000;
        while (!cancelled()) {
            const current = await PetRuntime.findById(ownerId).lean();
            if (!current || current.generation !== turn.generation || current.ttsReservation?.token !== token) return cancelledRoute;
            if (!current.activeRequestId) break;
            if (Date.now() >= waitUntil) return cancelledRoute;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (cancelled()) return cancelledRoute;
        let durationMs = 0;
        try { durationMs = await inspectTtsAudio(input.file); } catch { /* Oversized/invalid pet input uses the original overlay file. */ }
        if (cancelled()) return cancelledRoute;
        if (config.settings.ttsAudio === 'pet' && durationMs && ['audio/wav', 'audio/mpeg'].includes(input.mime)) {
            const elected = await player(ownerId, input.channelId);
            if (elected && elected.runtime.generation === turn.generation && !cancelled()) {
                directory = await mkdtemp(path.join(tmpdir(), 'dima-pet-'));
                const audioPath = path.join(directory, input.mime === 'audio/wav' ? 'speech.wav' : 'speech.mp3');
                await copyFile(input.file, audioPath);
                const id = randomUUID(), now = new Date();
                const request = await PetRequest.create({ _id: id, ownerId, channelId: input.channelId, operation: 'tts', text: input.text,
                    outputText: input.text, origin: { kind: 'tts-queue', id: input.speechId, occurredAt: now.toISOString() }, actionKey: 'tts', actor: { userId: '', displayName: '' }, payloadHash: input.speechId,
                    admitted: true, generation: turn.generation, settingsRevision: turn.revision, status: 'ready', version: 1,
                    startBefore: new Date(Date.now() + 5000), phaseDeadline: new Date(Date.now() + durationMs + 10_000),
                    privateDir: directory, audio: { path: audioPath, mimeType: input.mime, durationMs }, createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400_000) });
                turn.requestId = id;
                const linked = await PetRuntime.updateOne({ _id: ownerId, generation: turn.generation, activeRequestId: null,
                    'ttsReservation.token': token, 'lease.leaseId': elected.runtime.lease!.leaseId, 'lease.expiresAt': { $gt: new Date() } }, { $set: { activeRequestId: id } });
                if (!linked.modifiedCount || cancelled()) throw new Error('pre_delivery_rejected');
                const ticket = await issueAudioTicket(elected.peer, request.toObject(), elected.runtime.lease!);
                const latest = await player(ownerId, input.channelId);
                if (cancelled() || latest?.runtime.activeRequestId !== id || latest.runtime.lease?.leaseId !== elected.runtime.lease!.leaseId || latest.peer !== elected.peer) throw new Error('pre_delivery_rejected');
                // Durable uncertainty fence BEFORE the sole socket emission. Lost ACK/fetch/disconnect cannot replay.
                const attempted = await PetRequest.updateOne({ _id: id, status: 'ready', generation: turn.generation }, { $set: { deliveryAttempted: true } });
                if (!attempted.modifiedCount || cancelled()) throw new Error('pre_delivery_rejected');
                turn.delivered = true;
                const sent = emitPetReadyAndPlay(elected.peer, turn.generation, requestView(request.toObject())!, { v: 1, requestId: id, generation: turn.generation,
                    leaseId: elected.runtime.lease!.leaseId, startBefore: request.startBefore!.getTime(), audio: {
                        url: `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/playback/${id}/audio?ticket=${ticket}`, mimeType: input.mime, durationMs } });
                if (!sent) { turn.delivered = false; throw new Error('pre_delivery_rejected'); }
                directory = undefined;
                await notifyPet(ownerId);
                return { audio: 'pet', durationMs };
            }
        }
        if (cancelled()) return cancelledRoute;
        try { turn.envelope = await ttsEnvelope(input.file); } catch { /* Animation failure never blocks already-generated normal speech. */ }
        return cancelled() ? cancelledRoute : { audio: 'overlay', durationMs: durationMs || 60_000 };
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
    const renewed = await PetRuntime.updateOne({ _id: turn.ownerId, 'ttsReservation.token': turn.token },
        { $set: { 'ttsReservation.expiresAt': new Date(Date.now() + 240_000) } });
    if (!renewed.matchedCount || turns.get(channel) !== turn) return;
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
        invalidated: async owner => { for (const turn of [...turns.values()]) if (turn.ownerId === owner) {
            if (turn.delivered || turn.requestId) await turn.input.ended('pet:state_changed');
            else { turn.detached = true; await endFollow(turn); }
        } }
    });
    return async () => { for (const turn of [...turns.values()]) await release(turn.input.channelId, turn.input.speechId); registerReadTtsBridge(); };
}
