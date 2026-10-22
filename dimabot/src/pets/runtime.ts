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
import { petPeers, desktopCandidates, type PetPeer } from './peers.js';
import { finishRequest, invalidatePet, notifyPet, PET_WAKE, PetError, requestView, runtimeFor } from './state.js';
import { issueAudioTicket } from './tokens.js';

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
        playback: configuration.settings.playback,
        assets: peer.kind === 'browser' ? assetUrls(peer.capability!, configuration.settings.appearance) : { idleUrl: null, talkingUrl: null },
        active: requestView(request), lease: runtime.lease ? { ...runtime.lease, expiresAt: runtime.lease.expiresAt.getTime() } : null };
}
export function assetUrls(capability: string, appearance: { idleAssetId: string | null; talkingAssetId: string | null }) {
    const base = `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/public/${capability}/assets/`;
    return { idleUrl: appearance.idleAssetId ? base + appearance.idleAssetId : null,
        talkingUrl: appearance.talkingAssetId ? base + appearance.talkingAssetId : null };
}
export async function isSelectedPlayer(peer: PetPeer) {
    const { settings, runtime } = await getPetConfiguration(peer.ownerId, peer.channelId);
    return runtime.enabled && settings.enabled && settings.tts.enabled && peer.audioReady &&
        (settings.playback.target === 'browser' ? peer.kind === 'browser' && (settings.appearance.kind !== 'png' || peer.renderReady) :
            peer.kind === 'desktop' && settings.playback.desktopSessionId === peer.sessionId && peer.scopes.includes('pet:receive'));
}
async function broadcast(ownerId: string) {
    const runtime = await PetRuntime.findById(ownerId).lean();
    const task = tasks.get(ownerId);
    if (task && (runtime?.generation !== task.generation || runtime.activeRequestId !== task.requestId)) task.controller.abort();
    for (const peer of petPeers.values()) {
        if (peer.ownerId !== ownerId || !peer.socket.connected) continue;
        try {
            await peer.revalidate();
            const snapshot = await snapshotFor(peer);
            if (peer.generationSeen !== undefined && snapshot.generation !== peer.generationSeen) {
                const terminal = peer.activeSeen ? await PetRequest.findOne({ _id: peer.activeSeen, ownerId }).lean() : null;
                if (terminal) peer.socket.emit('pet:request', { v: 1, generation: terminal.generation, request: requestView(terminal) });
                peer.socket.emit('pet:stop', { v: 1, requestId: peer.activeSeen ?? '', generation: snapshot.generation, reason: 'state_changed' });
            } else if (peer.activeSeen && peer.activeSeen !== snapshot.active?.requestId) {
                const terminal = await PetRequest.findOne({ _id: peer.activeSeen, ownerId }).lean();
                if (terminal) peer.socket.emit('pet:request', { v: 1, generation: terminal.generation, request: requestView(terminal) });
                peer.socket.emit('pet:stop', { v: 1, requestId: peer.activeSeen, generation: snapshot.generation, reason: 'request_finished' });
            }
            peer.generationSeen = snapshot.generation; peer.activeSeen = snapshot.active?.requestId;
            peer.socket.emit('pet:snapshot', snapshot);
            if (snapshot.active) peer.socket.emit('pet:request', { v: 1, generation: snapshot.generation, request: snapshot.active });
        } catch { peer.socket.disconnect(true); }
    }
}
async function current(request: PetRequestRecord) {
    const runtime = await PetRuntime.findById(request.ownerId).lean();
    if (!runtime || runtime.generation !== request.generation || runtime.activeRequestId !== request._id ||
        !runtime.lease || runtime.lease.expiresAt.getTime() <= Date.now()) throw new PetError('stale_request', 409);
    const configuration = await getPetConfiguration(request.ownerId, request.channelId);
    if (!configuration.runtime.enabled || !configuration.settings.tts.enabled || configuration.revision !== request.settingsRevision) throw new PetError(configuration.runtime.issues[0] ?? 'settings_changed', 409);
    return { runtime, configuration };
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
            const persona = configuration.runtime.personality;
            const result = await generateStandaloneText(streamer, [{ role: 'system', content:
                `You are ${configuration.settings.name}, a virtual stream companion. Reply in ${configuration.settings.tts.language}. ` +
                `Return only spoken text, at most ${configuration.settings.behavior.maxReplyLength} characters. Never execute actions, commands, or tools. ` +
                `Persona and rules: ${JSON.stringify(persona)}` }, { role: 'user', content: text }], 'pet_ask', {
                    signal, singleAttempt: true, verifyCredits: true, usageRequestId: `${request._id}:llm`, usageSource: 'pet', maxTokens: 1024
                });
            if (result.error || !result.message.trim()) throw new PetError('generation_failed');
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
        peer.socket.emit('pet:play', { v: 1, requestId: request._id, generation: request.generation,
            leaseId: runtime.lease!.leaseId, startBefore: ready.startBefore!.getTime(),
            audio: { url: `${(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '')}/pets/playback/${request._id}/audio?ticket=${ticket}`, mimeType: result.mimeType, durationMs } });
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
async function wakeOnce(ownerId: string) {
        await broadcast(ownerId);
        const runtime = await PetRuntime.findById(ownerId).lean();
        if (!runtime?.activeRequestId) return;
        const request = await PetRequest.findById(runtime.activeRequestId).lean();
        if (!request) { await invalidatePet(ownerId, 'request_missing'); return; }
        if (PET_TERMINAL.includes(request.status)) {
            await PetRuntime.updateOne({ _id: ownerId, activeRequestId: request._id }, { $set: { activeRequestId: null } });
            await cleanAudio(request); return;
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
    const subscriber = (await getDragonflyClient('pet-runtime')).duplicate();
    subscriber.on('error', () => {});
    await subscriber.connect();
    await subscriber.subscribe(PET_WAKE, ownerId => { if (/^[a-f0-9]{24}$/i.test(ownerId)) void wake(ownerId).catch(() => {}); });
    let recovering = false;
    const recover = async () => {
        if (recovering) return;
        recovering = true;
        try {
            const expired = await PetRuntime.find({ 'lease.expiresAt': { $lte: new Date() } }).limit(64).lean();
            for (const runtime of expired) {
                const request = runtime.activeRequestId ? await PetRequest.findById(runtime.activeRequestId).lean() : null;
                if (request && ['generating', 'synthesizing'].includes(request.status) && !tasks.has(runtime._id)) await finishRequest(request._id, 'expired', 'provider_outcome_unknown');
                await invalidatePet(runtime._id, 'lease_expired');
            }
            const overdue = await PetRequest.find({ status: { $nin: PET_TERMINAL }, phaseDeadline: { $lte: new Date() } }).sort({ phaseDeadline: 1 }).limit(64).lean();
            for (const request of overdue) {
                // A persisted provider phase has an unknown outcome; never run it again.
                const runtime = await PetRuntime.findById(request.ownerId).lean();
                await finishRequest(request._id, 'expired', ['generating', 'synthesizing'].includes(request.status) ? 'provider_outcome_unknown' : 'request_expired');
                if (runtime?.activeRequestId === request._id) await invalidatePet(request.ownerId, 'request_expired');
            }
            const accepted = await PetRequest.find({ status: 'accepted' }).sort({ createdAt: 1 }).limit(64).lean();
            for (const request of accepted) await wake(request.ownerId);
            // Recover lost playing/terminal notifications for peers that observed work.
            // Idle owners with no active view do not cause database polling.
            const observed = [...new Set([...petPeers.values()].filter(peer => peer.activeSeen).map(peer => peer.ownerId))].slice(0, 64);
            for (const ownerId of observed) await wake(ownerId);
            const cleanup = await PetRequest.find({ status: { $in: PET_TERMINAL }, $or: [{ privateDir: { $exists: true } }, { 'audio.path': { $exists: true } }] }).limit(64).lean();
            for (const request of cleanup) await cleanAudio(request);
        } finally { recovering = false; }
    };
    const timer = setInterval(() => { void recover().catch(() => {}); }, 15_000); timer.unref();
    await recover();
    return async () => { clearInterval(timer); for (const task of tasks.values()) task.controller.abort(); await subscriber.quit(); };
}
