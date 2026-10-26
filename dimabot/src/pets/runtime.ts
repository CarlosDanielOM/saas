import { startReadTts, reconcileReadTtsStartup } from './read_tts.js';
import { observeReadTtsRuntime, readTtsOwners } from './tts_bridge.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PetRequest, PetRuntime, PET_TERMINAL, type PetRequestRecord } from '../schemas/pet_runtime.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import Users from '../schemas/users.schema.js';
import { getAiCredits, isAiCreditsExhausted, type AiCreditStatus } from '../utils/billing.js';
import { generateStandaloneText } from '../utils/ai/openrouter/ai.js';
import { resolveTtsForCreditStatus } from '../utils/tts/tts_credit_fallback.util.js';
import { trackTtsUsage } from '../utils/tts_usage.js';
import { piperTtsService } from '../server/services/tts/piper_tts.service.js';
import { kokoroTtsService } from '../server/services/tts/kokoro_tts.service.js';
import { fishTtsService } from '../server/services/tts/fish_tts.service.js';
import { petPeers, desktopCandidates, selectedVtsController, type PetPeer } from './peers.js';
import { finishRequest, invalidatePet, notifyPet, PetError, requestView, runtimeFor } from './state.js';
import { beginPetSnapshot, emitPetSnapshot, emitPetReadyAndPlay } from './delivery.js';
import { initializePetReadiness, refreshPetReadiness, stopPetReadiness } from './readiness.js';
import { subscribePetWakeups } from './wakeups.js';
import { issueAudioTicket } from './tokens.js';
import { claimQueued, nextIndependentQueued } from './queue.js';
import { registerPetLaneBridge, type PetLaneItem, type PetLaneStart } from './tts_lane.js';

const tasks = new Map<string, { controller: AbortController; requestId: string; generation: number }>();
const MAX_ACTIVE_PROVIDERS = 4;
export const MAX_PET_AUDIO_BYTES = 8_000_000;
export const MAX_PET_DURATION_MS = 60_000;
export async function getPetRuntime(ownerId: string, channelId: string) {
    await getPetConfiguration(ownerId, channelId);
    const runtime = await runtimeFor(ownerId, channelId);
    const request = runtime.activeRequestId ? await PetRequest.findById(runtime.activeRequestId).lean() : null;
    return { v: 1 as const, generation: runtime.generation, active: requestView(request), sessions: await desktopCandidates(ownerId) };
}
export async function snapshotFor(peer: PetPeer) {
    const configuration = await getPetConfiguration(peer.ownerId, peer.channelId);
    const runtime = await runtimeFor(peer.ownerId, peer.channelId);
    const request = runtime.activeRequestId ? await PetRequest.findById(runtime.activeRequestId).lean() : null;
    return { v: 1, serverTime: Date.now(), peerId: peer.id, generation: runtime.generation,
        settingsRevision: configuration.revision, appearance: configuration.settings.appearance,
        playback: configuration.settings.playback, sources: configuration.settings.sources, ttsAudio: configuration.settings.ttsAudio,
        assets: peer.kind === 'browser' ? assetUrls(peer.capability!, configuration.settings.appearance) : { idleUrl: null, talkingUrl: null },
        active: requestView(request), lease: runtime.lease ? { ...runtime.lease, expiresAt: runtime.lease.expiresAt.getTime() } : null };
}
export function assetUrls(capability: string, appearance: { idleAssetId: string | null; talkingAssetId: string | null }) {
    const base = `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/public/${capability}/assets/`;
    return { idleUrl: appearance.idleAssetId ? base + appearance.idleAssetId : null,
        talkingUrl: appearance.talkingAssetId ? base + appearance.talkingAssetId : null };
}
export async function isSelectedPlayer(peer: PetPeer) {
    await refreshPetReadiness(peer.ownerId);
    const { settings, runtime } = await getPetConfiguration(peer.ownerId, peer.channelId);
    if (settings.appearance.kind === 'vts' && !await selectedVtsController(peer.ownerId, settings.playback.vtsSessionId)) return false;
    return (runtime.enabled && settings.sources.independent && settings.tts.enabled || runtime.readTtsEnabled) && peer.audioReady &&
        (settings.playback.target === 'browser' ? peer.kind === 'browser' && (settings.appearance.kind !== 'png' || peer.renderReady) :
            peer.kind === 'desktop' && settings.playback.desktopSessionId === peer.sessionId && peer.scopes.includes('pet:receive'));
}
export async function sendPetSnapshot(peer: PetPeer) {
    const serial = beginPetSnapshot(peer);
    const previousId = peer.activeSeen;
    await peer.revalidate();
    const snapshot = await snapshotFor(peer);
    const terminal = previousId && previousId !== snapshot.active?.requestId ? await PetRequest.findOne({ _id: previousId, ownerId: peer.ownerId }).lean() : null;
    emitPetSnapshot(peer, serial, snapshot, terminal ? { generation: terminal.generation, request: requestView(terminal)! } : undefined);
}
async function broadcast(ownerId: string) {
    const runtime = await PetRuntime.findById(ownerId).lean();
    const task = tasks.get(ownerId);
    if (task && (runtime?.generation !== task.generation || runtime.activeRequestId !== task.requestId)) task.controller.abort();
    for (const peer of petPeers.values()) {
        if (peer.ownerId !== ownerId || !peer.socket.connected) continue;
        try { await sendPetSnapshot(peer); } catch { peer.socket.disconnect(true); }
    }
}
async function current(request: PetRequestRecord) {
    const runtime = await PetRuntime.findById(request.ownerId).lean();
    if (!runtime || runtime.generation !== request.generation || runtime.activeRequestId !== request._id ||
        !runtime.lease || runtime.lease.expiresAt.getTime() <= Date.now()) throw new PetError('stale_request', 409);
    await refreshPetReadiness(request.ownerId);
    const configuration = await getPetConfiguration(request.ownerId, request.channelId);
    if (!configuration.runtime.enabled || !configuration.settings.tts.enabled || configuration.revision !== request.settingsRevision) throw new PetError(configuration.runtime.issues[0] ?? 'settings_changed', 409);
    if (configuration.settings.appearance.kind === 'vts' && !await selectedVtsController(request.ownerId, configuration.settings.playback.vtsSessionId)) throw new PetError('vts_unavailable', 409);
    const live = await PetRuntime.findOne({ _id: request.ownerId, generation: request.generation, activeRequestId: request._id, 'lease.expiresAt': { $gt: new Date() } }).lean();
    if (!live) throw new PetError('stale_request', 409);
    return { runtime: live, configuration };
}
async function phase(request: PetRequestRecord, status: 'generating' | 'synthesizing', outputText?: string) {
    const updated = await PetRequest.findOneAndUpdate({ _id: request._id, status: request.status, version: request.version }, {
        $set: { status, phaseDeadline: new Date(Date.now() + 60_000), ...(outputText ? { outputText } : {}) }, $inc: { version: 1 }
    }, { new: true }).lean();
    if (!updated) throw new PetError('stale_request', 409);
    await notifyPet(request.ownerId);
    return updated;
}
async function generate(request: PetRequestRecord, signal: AbortSignal) {
    let directory: string | undefined;
    try {
        let { configuration } = await current(request);
        const owner = await Users.findById(request.ownerId).select('plan_tier polar_sh_customer_id').lean();
        if (!owner) throw new PetError('account_required');
        const streamer = { user_id: request.channelId, plan_tier: owner.plan_tier, polar_sh_customer_id: owner.polar_sh_customer_id };
        let text = request.text;
        if (request.operation === 'ask') {
            request = await phase(request, 'generating');
            await current(request);
            signal.throwIfAborted();
            const persona = configuration.runtime.personality;
            const result = await generateStandaloneText(streamer, [{ role: 'system', content:
                `You are ${configuration.settings.name}, a virtual stream companion. Reply in ${configuration.settings.tts.language}. ` +
                `Return only spoken text, at most ${configuration.settings.behavior.maxReplyLength} characters. Never execute actions, commands, or tools. ` +
                `Persona and rules: ${JSON.stringify(persona)}` }, { role: 'user', content: text }], 'pet_ask', {
                    signal, singleAttempt: true, verifyCredits: true, usageRequestId: `${request._id}:llm`, usageSource: 'pet', maxTokens: 1024
                });
            if (result.error || typeof result.message !== 'string' || !result.message.trim()) throw new PetError('generation_failed');
            text = result.message.trim().slice(0, configuration.settings.behavior.maxReplyLength);
        }
        signal.throwIfAborted();
        ({ configuration } = await current(request));
        request = await phase(request, 'synthesizing', text);
        const cache = await getDragonflyClient('pet-credits');
        let creditStatus: AiCreditStatus = 'unavailable';
        try { creditStatus = await isAiCreditsExhausted(request.channelId, cache) ? 'exhausted' : (await getAiCredits(streamer, request.channelId, { requireVerified: true, signal })).status; }
        catch { /* Existing unavailable-credit rule falls back to Piper. */ }
        const tts = resolveTtsForCreditStatus({ mode: 'speak' as const, text, ...configuration.settings.tts }, creditStatus, streamer.plan_tier);
        directory = await mkdtemp(path.join(tmpdir(), 'dima-pet-'));
        await PetRequest.updateOne({ _id: request._id, status: 'synthesizing' }, { $set: { privateDir: directory } });
        const audioPath = path.join(directory, tts.provider === 'piper' ? 'speech.wav' : 'speech.mp3');
        signal.throwIfAborted();
        await current(request);
        const provider = { piper: piperTtsService, kokoro: kokoroTtsService, fish: fishTtsService }[tts.provider];
        const result = await provider.synthesize({ ...tts, channelID: request.channelId, speechID: request._id,
            outputPath: audioPath, privateOutput: true, singleAttempt: true, signal, maxAudioBytes: MAX_PET_AUDIO_BYTES });
        if (result.error || result.outputPath !== audioPath || !result.mimeType) throw new PetError('synthesis_failed');
        // Usage is recorded even when cancellation arrives after a known successful provider result.
        await trackTtsUsage({ channelID: request.channelId, streamer, requireDurableUsage: true, provider: tts.provider, text: tts.text, characters: tts.text.length,
            usage: { entryId: `${request._id}:tts`, requestId: `${request._id}:tts`, source: 'pet', resourceType: 'speech', resourceId: request._id } });
        signal.throwIfAborted();
        if ((await stat(audioPath)).size > MAX_PET_AUDIO_BYTES) throw new PetError('audio_too_large');
        const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration', '-of', 'json', audioPath], { timeout: 5000, maxBuffer: 4096 });
        const durationMs = Math.ceil(Number(JSON.parse(stdout).format?.duration) * 1000);
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_PET_DURATION_MS) throw new PetError('audio_duration');
        const { runtime } = await current(request);
        const peer = petPeers.get(runtime.lease!.holderPeerId);
        if (!peer || !peer.socket.connected) throw new PetError('player_unavailable');
        await peer.revalidate();
        if (!await isSelectedPlayer(peer)) throw new PetError('player_unavailable');
        const ready = await PetRequest.findOneAndUpdate({ _id: request._id, status: 'synthesizing', version: request.version }, {
            $set: { status: 'ready', startBefore: new Date(Date.now() + 5000), phaseDeadline: new Date(Date.now() + durationMs + 10_000), audio: { path: audioPath, mimeType: result.mimeType, durationMs } }, $inc: { version: 1 }
        }, { new: true }).lean();
        if (!ready) throw new PetError('stale_request');
        await current(ready);
        await notifyPet(request.ownerId);
        const ticket = await issueAudioTicket(peer, ready, runtime.lease!);
        await current(ready);
        // This is the only play emission. Snapshot/reconnect/recovery never replay it.
        const sent = emitPetReadyAndPlay(peer, request.generation, requestView(ready)!, { v: 1, requestId: request._id, generation: request.generation,
            leaseId: runtime.lease!.leaseId, startBefore: ready.startBefore!.getTime(),
            audio: { url: `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/playback/${request._id}/audio?ticket=${ticket}`, mimeType: result.mimeType, durationMs } });
        if (!sent) throw new PetError('stale_request');
        directory = undefined; // Terminal/recovery cleanup owns the private file now.
    } catch (error) {
        await finishRequest(request._id, signal.aborted ? 'cancelled' : 'failed', error instanceof PetError ? error.code : 'provider_unavailable');
    } finally {
        if (directory) await rm(directory, { force: true, recursive: true });
    }
}
async function cleanAudio(request: PetRequestRecord) {
    if (!request.privateDir && !request.audio?.path) return;
    // Only paths created by this module are deletable; persisted state is untrusted.
    const directory = request.privateDir ?? path.dirname(request.audio!.path);
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith('dima-pet-')) await rm(directory, { recursive: true, force: true });
    await PetRequest.updateOne({ _id: request._id }, { $unset: { audio: 1, privateDir: 1 } });
}
const waking = new Set<string>();
const dirty = new Set<string>();
// TTS-lane turns waiting for the pet to be free, and their terminal callbacks (API process only).
const laneWaiters = new Map<string, Set<() => void>>();
const laneTurns = new Map<string, (reason: string) => void>();
const cooldownTimers = new Map<string, NodeJS.Timeout>();
const laneWaiting = new Map<string, number>();
function signalLane(ownerId: string) {
    const waiters = laneWaiters.get(ownerId);
    if (waiters) for (const resolve of [...waiters]) resolve();
}
function waitForOwner(ownerId: string, ms: number) {
    return new Promise<void>(resolve => {
        const waiters = laneWaiters.get(ownerId) ?? new Set<() => void>();
        laneWaiters.set(ownerId, waiters);
        const done = () => { clearTimeout(timer); waiters.delete(done); if (!waiters.size && laneWaiters.get(ownerId) === waiters) laneWaiters.delete(ownerId); resolve(); };
        const timer = setTimeout(done, ms);
        waiters.add(done);
    });
}
function scheduleRetry(ownerId: string, at: number) {
    if (cooldownTimers.has(ownerId)) return;
    const timer = setTimeout(() => { cooldownTimers.delete(ownerId); void wake(ownerId).catch(() => {}); }, Math.min(Math.max(at - Date.now(), 50), 60_000));
    timer.unref(); cooldownTimers.set(ownerId, timer);
}
/** The free pet first serves a waiting TTS-lane turn (it holds the TTS queue), then its own queue. */
async function promoteIndependent(ownerId: string) {
    if (laneWaiting.has(ownerId)) return;
    const head = await nextIndependentQueued(ownerId);
    if (!head) return;
    const claim = await claimQueued(head, { lane: 'independent' });
    if (claim.kind === 'wait') { if (claim.retryAt) scheduleRetry(ownerId, claim.retryAt); return; }
    dirty.add(ownerId); // Dispatch the promoted request, or try the next one after a drop.
}
async function resumeLane(ownerId: string, channelId: string) {
    if (!await PetRequest.exists({ ownerId, status: 'queued', lane: 'tts' })) return;
    const { ttsQueueHandler } = await import('../handlers/tts_queue.handler.js');
    await ttsQueueHandler.resumeIfIdle(channelId);
}
async function startLane(input: PetLaneStart) {
    const request = await PetRequest.findOne({ _id: input.item.requestId, ownerId: input.item.ownerId }).lean();
    if (!request || request.status !== 'queued' || request.lane !== 'tts' || request.channelId !== input.channelId || request.ttsSpeechId !== input.speechId) return null;
    const waitUntil = Math.min(Date.now() + 120_000, request.phaseDeadline.getTime());
    const ownerId = input.item.ownerId;
    laneWaiting.set(ownerId, (laneWaiting.get(ownerId) ?? 0) + 1);
    try { return await claimLane(input, request, waitUntil); }
    finally {
        const left = (laneWaiting.get(ownerId) ?? 1) - 1;
        if (left > 0) laneWaiting.set(ownerId, left); else laneWaiting.delete(ownerId);
        void wake(ownerId).catch(() => {}); // Let the pet's own queue continue if this turn did not start.
    }
}
async function claimLane(input: PetLaneStart, request: PetRequestRecord, waitUntil: number) {
    while (true) {
        if (input.cancelled()) { await finishRequest(request._id, 'cancelled', 'tts_queue_control'); return null; }
        const current = await PetRequest.findById(request._id).lean();
        if (!current || current.status !== 'queued') return null;
        const claim = await claimQueued(current, { lane: 'tts' });
        if (claim.kind === 'dropped') return null;
        if (claim.kind === 'promoted') {
            const done = new Promise<string>(resolve => laneTurns.set(request._id, resolve));
            // Ended during the claim (e.g. invalidated): the terminal hook ran before registration.
            const latest = await PetRequest.findById(request._id).lean();
            if (!latest || PET_TERMINAL.includes(latest.status)) { laneTurns.delete(request._id); return { done: Promise.resolve(`pet:${latest?.status ?? 'missing'}`) }; }
            return { done };
        }
        if (Date.now() >= waitUntil) { await finishRequest(request._id, 'expired', 'busy'); return null; }
        await waitForOwner(input.item.ownerId, Math.max(50, Math.min(1000, waitUntil - Date.now(), claim.retryAt ? claim.retryAt - Date.now() : 1000)));
    }
}
async function endLane(item: PetLaneItem, reason: string) {
    signalLane(item.ownerId);
    const request = await PetRequest.findOne({ _id: item.requestId, ownerId: item.ownerId }).lean();
    if (!request || PET_TERMINAL.includes(request.status)) return;
    // Skip/clear/timeout of the TTS queue item stops the pet exactly like a dashboard cancel.
    const runtime = await PetRuntime.findById(item.ownerId).lean();
    if (runtime?.activeRequestId === request._id) await invalidatePet(item.ownerId, 'cancelled', { requestId: request._id, generation: runtime.generation });
    await finishRequest(request._id, 'cancelled', `tts_${/^[a-z_-]{1,40}$/.test(reason) ? reason.replace(/-/g, '_') : 'ended'}`);
}
async function wakeOnce(ownerId: string) {
        await refreshPetReadiness(ownerId);
        await broadcast(ownerId);
        signalLane(ownerId);
        const runtime = await PetRuntime.findById(ownerId).lean();
        if (runtime) observeReadTtsRuntime(runtime);
        if (!runtime) return;
        if (!runtime.activeRequestId) { await resumeLane(ownerId, runtime.channelId); await promoteIndependent(ownerId); return; }
        const request = await PetRequest.findById(runtime.activeRequestId).lean();
        if (!request) { await invalidatePet(ownerId, 'request_missing'); return; }
        if (PET_TERMINAL.includes(request.status)) {
            await PetRuntime.updateOne({ _id: ownerId, activeRequestId: request._id }, { $set: { activeRequestId: null }, $unset: { admissionClaimId: 1 } });
            await cleanAudio(request); dirty.add(ownerId); return;
        }
        if (!request.admitted || request.status !== 'accepted' || tasks.has(ownerId) || tasks.size >= MAX_ACTIVE_PROVIDERS) return;
        if (!runtime.lease || !petPeers.get(runtime.lease.holderPeerId)?.socket.connected) { await invalidatePet(ownerId, 'player_unavailable'); return; }
        const controller = new AbortController();
        tasks.set(ownerId, { controller, requestId: request._id, generation: request.generation });
        void generate(request, controller.signal).catch(() => {}).finally(() => { tasks.delete(ownerId); void notifyPet(ownerId); });
}
async function wake(ownerId: string) {
    if (waking.has(ownerId)) { dirty.add(ownerId); return; }
    if (waking.size >= 64) return; // Durable accepted/expiry recovery remains bounded.
    waking.add(ownerId);
    try {
        do { dirty.delete(ownerId); await wakeOnce(ownerId); } while (dirty.has(ownerId));
    } finally { waking.delete(ownerId); dirty.delete(ownerId); }
}
/** API bootstrap only. Importing admission from bot/cron creates no timers, sockets, or providers. */
export async function startPetRuntime() {
    await Promise.all([PetRequest.init(), PetRuntime.init()]);
    await initializePetReadiness();
    await reconcileReadTtsStartup();
    const closeReadTts = startReadTts();
    registerPetLaneBridge({ start: startLane, end: endLane, terminal: request => {
        const resolve = laneTurns.get(request._id);
        if (!resolve) return;
        laneTurns.delete(request._id); resolve(`pet:${request.status}`); signalLane(request.ownerId);
    } });
    const stopWakeups = subscribePetWakeups(owners => { for (const ownerId of owners) void wake(ownerId).catch(() => {}); });
    let recovering = false;
    let recoveryCursor = 0;
    const recover = async () => {
        if (recovering) return;
        recovering = true;
        try {
            const expired = await PetRuntime.find({ 'lease.expiresAt': { $lte: new Date() } }).limit(64).lean();
            for (const runtime of expired) {
                const request = runtime.activeRequestId ? await PetRequest.findById(runtime.activeRequestId).lean() : null;
                const terminal = request && ['generating', 'synthesizing'].includes(request.status) && !tasks.has(runtime._id) ? { status: 'expired' as const, errorCode: 'provider_outcome_unknown' } : undefined;
                await invalidatePet(runtime._id, 'lease_expired', { requestId: runtime.activeRequestId, generation: runtime.generation, leaseId: runtime.lease!.leaseId, leaseExpiresAt: runtime.lease!.expiresAt }, terminal);
            }
            const overdue = await PetRequest.find({ status: { $nin: PET_TERMINAL }, phaseDeadline: { $lte: new Date() } }).sort({ phaseDeadline: 1 }).limit(64).lean();
            for (const request of overdue) {
                // A persisted provider phase has an unknown outcome; never run it again.
                const runtime = await PetRuntime.findById(request.ownerId).lean();
                const errorCode = ['generating', 'synthesizing'].includes(request.status) ? 'provider_outcome_unknown' : 'request_expired';
                if (runtime?.activeRequestId === request._id) await invalidatePet(request.ownerId, 'request_expired', { requestId: request._id, generation: request.generation }, { status: 'expired', errorCode });
                await finishRequest(request._id, 'expired', errorCode);
            }
            const accepted = await PetRequest.find({ status: 'accepted', admitted: true }).sort({ createdAt: 1 }).limit(64).lean();
            for (const request of accepted) await wake(request.ownerId);
            // Lost wake hints for queued work (either lane) are repaired here.
            const queuedOwners = await PetRequest.distinct('ownerId', { status: 'queued' });
            for (const ownerId of queuedOwners.slice(0, 64)) await wake(String(ownerId));
            // A single indexed, rotating header read repairs lost hints even for
            // idle selection changes; only changed/observed work triggers snapshots.
            const connected = [...new Set([...petPeers.values()].map(peer => peer.ownerId).concat(readTtsOwners()))];
            const batch = connected.length ? Array.from({ length: Math.min(64, connected.length) }, (_, index) => connected[(recoveryCursor + index) % connected.length]) : [];
            recoveryCursor = connected.length ? (recoveryCursor + batch.length) % connected.length : 0;
            const headers = batch.length ? await PetRuntime.find({ _id: { $in: batch } }).select('_id generation activeRequestId lease notBefore ttsReservation.token').lean() : [];
            for (const runtime of headers) {
                observeReadTtsRuntime(runtime);
                if ([...petPeers.values()].some(peer => peer.ownerId === runtime._id && (peer.activeSeen || peer.generationSeen !== runtime.generation || (peer.activeSeen ?? null) !== runtime.activeRequestId))) await wake(runtime._id);
            }
            const { ttsQueueHandler } = await import('../handlers/tts_queue.handler.js');
            await ttsQueueHandler.reconcileReadTtsSessions();
            await ttsQueueHandler.recoverQueuedTts();
            const cleanup = await PetRequest.find({ status: { $in: PET_TERMINAL }, $or: [{ privateDir: { $exists: true } }, { 'audio.path': { $exists: true } }] }).limit(64).lean();
            for (const request of cleanup) await cleanAudio(request);
        } finally { recovering = false; }
    };
    const timer = setInterval(() => { void recover().catch(() => {}); }, 15_000); timer.unref();
    await recover();
    return async () => { clearInterval(timer); registerPetLaneBridge(); for (const timer of cooldownTimers.values()) clearTimeout(timer); cooldownTimers.clear(); for (const task of tasks.values()) task.controller.abort(); stopWakeups(); stopPetReadiness(); await closeReadTts(); };
}
