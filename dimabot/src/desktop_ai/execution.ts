import { randomUUID } from 'node:crypto';
import { moodInstruction } from '../pets/moods.js';
import { safelyBuildMoodInstruction } from '../pets/mood_decoration.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopAiTurn, type DesktopTurn } from './schema.js';
import { assertRunning, claimSpeechPreparing, speechStillPreparing, hashTicket, newTicket, operation, ticketKey, tickets } from './service.js';
import { truncateReply } from './input.js';
import Users from '../schemas/users.schema.js';
import { OAuthSession } from '../schemas/oauth_session.schema.js';
import { getPetConfiguration } from '../server/services/pet_settings.service.js';
import { getChannelTtsSettings } from '../schemas/channel_tts_settings.schema.js';
import { chat, getChannelPersonality } from '../utils/ai/openrouter/ai.js';
import ChatHistory from '../classes/chat_history.js';
import { getThreadLimitsForTier } from '../utils/ai/threading/thread_limits.js';
import { createBroadcasterIdentity, serializeUserIdentity } from '../utils/permissions/index.js';
import { admitPetAction } from '../pets/admission.js';
import { filterPetTalkText } from '../pets/speech_text.js';
import { getTtsEmoteNames } from '../utils/tts/emote_names.util.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { getAiCredits, isAiCreditsExhausted, type AiCreditStatus } from '../utils/billing.js';
import { resolveTtsForCreditStatus } from '../utils/tts/tts_credit_fallback.util.js';
import { trackTtsUsage } from '../utils/tts_usage.js';
import { piperTtsService } from '../server/services/tts/piper_tts.service.js';
import { kokoroTtsService } from '../server/services/tts/kokoro_tts.service.js';
import { fishTtsService } from '../server/services/tts/fish_tts.service.js';
import { OAuthError } from '../server/oauth/catalog.js';
import { PetError } from '../pets/state.js';
import { prepareSpeechActivity, startSpeechActivity, finishSpeechActivity, finishMatchingSpeechActivity } from './activity.js';

type ActivityHandle = NonNullable<Awaited<ReturnType<typeof prepareSpeechActivity>>>;
const botActivities = new Map<string, ActivityHandle>();
const speechControllers = new Map<string, AbortController>();
export function cancelPendingSpeech(id: string) { speechControllers.get(id)?.abort(); }
export async function startBotSpeech(id: string) {
    const handle = botActivities.get(id);
    return !!handle && await startSpeechActivity(handle);
}
export async function finishBotSpeech(id: string, reason: string) {
    const handle = botActivities.get(id); botActivities.delete(id);
    if (handle) await finishSpeechActivity(handle, reason);
    else {
        const turn = await DesktopAiTurn.findById(id).lean();
        if (turn?.speech && !turn.speech.animatePet) await finishMatchingSpeechActivity(turn.channelId, turn.speech.playbackId, turn.speech.outputGeneration, reason);
    }
}
async function speechActive(turnId: string) {
    return !!await DesktopAiTurn.exists({ _id: turnId, 'speech.status': { $in: ['queued', 'preparing'] } });
}
async function liveSession(turn: DesktopTurn) {
    const session = await OAuthSession.findOne({ _id: turn.sessionId, user_id: turn.ownerId, channel_id: turn.channelId,
        client_id: turn.clientId, scopes: turn.target === 'bot' ? 'ai:interact' : 'pet:interact', revoked_at: null,
        expires_at: { $gt: new Date() }, idle_expires_at: { $gt: new Date() } }).lean();
    if (!session) throw new OAuthError('invalid_token', 401);
}
export async function executeDesktopTurn(turn: DesktopTurn, signal: AbortSignal) {
    await liveSession(turn);
    const owner = await Users.findOne({ _id: turn.ownerId, accounts: { $elemMatch: { type: 'twitch', id: turn.channelId } } })
        .select('name accounts.type accounts.id accounts.name plan_tier polar_sh_customer_id').lean();
    const account = owner?.accounts.find(account => account.type === 'twitch' && account.id === turn.channelId);
    if (!owner || !account) throw new OAuthError('invalid_token', 401);
    const streamer = { user_id: turn.channelId, name: account.name || owner.name, plan_tier: owner.plan_tier,
        polar_sh_customer_id: owner.polar_sh_customer_id };
    const persona = turn.target === 'pet' ? await getPetConfiguration(turn.ownerId, turn.channelId) : null;
    const personality = await getChannelPersonality(turn.channelId);
    const recent = await ChatHistory.getRecentMessages(turn.channelId, personality?.contextWindow ?? (owner.plan_tier === 'pro' ? 15 : 7));
    const history = recent.map((msg: any) => ({ timestamp: msg.timestamp, badges: msg.badges?.join(' '), username: msg.username, message: msg.message }));
    const tier = owner.plan_tier === 'pro' || owner.plan_tier === 'premium' ? owner.plan_tier : 'free';
    const prior = await DesktopAiTurn.find({ ownerId: turn.ownerId, channelId: turn.channelId, target: turn.target,
        conversationId: turn.conversationId, status: 'completed', replyText: { $type: 'string', $ne: '' },
        createdAt: { $gte: new Date(Date.now() - 86_400_000) }, _id: { $ne: turn._id } })
        .sort({ createdAt: -1, _id: -1 }).limit(Math.floor(getThreadLimitsForTier(tier).promptTurns / 2)).lean();
    const username = account.name || owner.name || 'Streamer';
    const threadHistory = prior.reverse().flatMap(row => [
        { role: 'user' as const, timestamp: row.createdAt.getTime(), username, message: row.text },
        { role: 'assistant' as const, timestamp: row.createdAt.getTime(), username: persona?.settings.name || 'DomDimaBot', message: row.replyText! }
    ]);
    const assertCurrent = async () => { signal.throwIfAborted(); await assertRunning(turn._id); await liveSession(turn); };
    await assertCurrent();
    const result = await chat({ channelID: turn.channelId, invocation: persona ? 'pet' : 'command', streamer, message: turn.text,
        history, threadHistory, tags: { badges: [], username, userID: turn.channelId, message: turn.text,
            userLevel: 10, identity: serializeUserIdentity(createBroadcasterIdentity()) },
        desktop: { signal, usageRequestId: `${turn._id}:llm`, assertCurrent,
            runOperation: (id, kind, task) => operation(turn._id, id, kind, task) },
        ...(persona ? { pet: { name: persona.settings.name, language: persona.settings.tts.language,
            maxReplyLength: Math.min(280, persona.settings.behavior.maxReplyLength), persona: persona.runtime.personality,
            signal, usageRequestId: `${turn._id}:llm`, allowActions: true, assertCurrent,
            ...(persona.moods?.enabled ? { moodInstruction: safelyBuildMoodInstruction(() => moodInstruction(persona.settings.moods), turn.channelId) } : {}) } } : {}) });
    if (result.error || typeof result.message !== 'string' || !result.message.trim()) throw new OAuthError('generation_failed', 503);
    let text = truncateReply(result.message, persona ? Math.min(280, persona.settings.behavior.maxReplyLength) : 280);
    if (!text) throw new OAuthError('generation_failed', 503);
    // pet.talk applies channel filters. Apply them before persisting the answer so
    // the returned text matches what the pet will speak.
    if (persona && !turn.silent && await speechActive(turn._id)) {
        const ttsSettings = await getChannelTtsSettings(turn.channelId);
        const emotes = ttsSettings.filters.skipEmotes ? await getTtsEmoteNames(turn.channelId) : [];
        const creditsCache = await getDragonflyClient('desktop-ai-pet-credits');
        let creditStatus: AiCreditStatus = 'unavailable';
        try { creditStatus = await isAiCreditsExhausted(turn.channelId, creditsCache) ? 'exhausted' :
            (await getAiCredits({ plan_tier: streamer.plan_tier ?? 'free', polar_sh_customer_id: streamer.polar_sh_customer_id ?? '' },
                turn.channelId, { requireVerified: true, signal })).status; } catch { /* Use the established Piper fallback. */ }
        const effective = resolveTtsForCreditStatus({ mode: 'speak' as const, text, ...persona.settings.tts }, creditStatus, streamer.plan_tier);
        const normalized = filterPetTalkText(effective.text, effective.provider, ttsSettings.filters, emotes);
        if (normalized.error) throw new OAuthError('no_speakable_text', 400);
        text = normalized.text;
    }
    await assertCurrent();
    const saved = await DesktopAiTurn.findOneAndUpdate({ _id: turn._id, status: 'running' },
        { $set: { replyText: text, ...(persona?.moods?.enabled ? { moodText: result.message } : {}) }, $inc: { revision: 1 } }, { new: true }).lean();
    if (!saved) return;
    if (saved.speech && saved.speech.status !== 'cancelled') {
        if (persona) await speakPet(saved, username);
        else await speakBot(saved, streamer, signal);
    }
    await DesktopAiTurn.updateOne({ _id: turn._id, status: 'running' }, { $set: { status: 'completed' }, $inc: { revision: 1 } });
}
export async function speakPet(turn: DesktopTurn, username: string) {
    if (!await speechActive(turn._id)) return;
    try {
        if (!await claimSpeechPreparing(turn._id)) return;
        const result = await operation(turn._id, 'pet_talk', 'speech', async () => {
            if (!await speechStillPreparing(turn._id)) return { prevented: true as const };
            return admitPetAction({ channelId: turn.channelId, operation: 'talk', text: turn.replyText!, moodText: turn.moodText,
            origin: { kind: 'oauth_desktop', id: turn._id, occurredAt: turn.createdAt.toISOString(), sessionId: turn.sessionId }, actionKey: 'desktop-turn',
            actor: { userId: turn.channelId, displayName: username } });
        });
        if ('prevented' in result) return;
        const linked = await DesktopAiTurn.findOneAndUpdate({ _id: turn._id, 'speech.status': 'preparing' },
            { $set: { petRequestId: result.requestId, 'speech.status': 'queued' }, $inc: { revision: 1 } }, { new: true }).lean();
        if (!linked) {
            const { cancelPetRequest } = await import('../pets/state.js');
            await cancelPetRequest(turn.ownerId, result.requestId, `turn:${turn._id}`);
        }
    } catch (error) {
        if (!(error instanceof PetError)) throw error;
        await DesktopAiTurn.updateOne({ _id: turn._id, 'operations.id': 'pet_talk' }, { $set: { 'operations.$.status': 'failed' } });
        await DesktopAiTurn.updateOne({ _id: turn._id, 'speech.status': { $ne: 'cancelled' } },
            { $set: { 'speech.status': 'failed', 'speech.errorCode': error.code }, $inc: { revision: 1 } });
    }
}
export async function speakBot(turn: DesktopTurn, streamer: { user_id: string; name: string; plan_tier?: 'free' | 'premium' | 'pro'; polar_sh_customer_id?: string }, turnSignal: AbortSignal) {
    const controller = new AbortController(); speechControllers.set(turn._id, controller);
    const signal = AbortSignal.any([turnSignal, controller.signal]);
    let directory: string | undefined;
    try {
        const settings = await getChannelTtsSettings(turn.channelId);
        if (!settings.enabled) throw new OAuthError('tts_disabled', 409);
        const cache = await getDragonflyClient('desktop-ai-credits');
        let creditStatus: AiCreditStatus = 'unavailable';
        try { creditStatus = await isAiCreditsExhausted(turn.channelId, cache) ? 'exhausted' : (await getAiCredits({ plan_tier: streamer.plan_tier ?? 'free', polar_sh_customer_id: streamer.polar_sh_customer_id ?? '' }, turn.channelId, { requireVerified: true, signal })).status; } catch { /* normal TTS fallback */ }
        const provider = settings.provider;
        const language = settings.defaultLanguage;
        const voice = provider === 'fish' ? settings.voices.cloneDefault || 'gojo' : provider === 'kokoro' ? settings.voices.kokoroDefault || settings.voices[language] : settings.voices[language];
        const request = resolveTtsForCreditStatus({ mode: 'speak' as const, text: turn.replyText!, provider, language, voice,
            piperFallbackVoice: settings.voices[language], kokoroFallbackVoice: settings.voices.kokoroDefault }, creditStatus, streamer.plan_tier);
        signal.throwIfAborted();
        if (!await speechActive(turn._id)) return;
        if (request.text !== turn.replyText) await DesktopAiTurn.updateOne({ _id: turn._id, status: 'running' }, { $set: { replyText: request.text }, $inc: { revision: 1 } });
        if (!await claimSpeechPreparing(turn._id)) return;
        signal.throwIfAborted();
        directory = await mkdtemp(path.join(tmpdir(), 'dima-desktop-ai-'));
        const audioPath = path.join(directory, request.provider === 'piper' ? 'speech.wav' : 'speech.mp3');
        const service = { piper: piperTtsService, kokoro: kokoroTtsService, fish: fishTtsService }[request.provider];
        const synthesis = await operation(turn._id, 'tts:synthesis', 'speech', async () => {
            if (!await speechStillPreparing(turn._id) || signal.aborted) return { prevented: true as const };
            const result = await service.synthesize({ ...request, channelID: turn.channelId,
                speechID: turn._id, outputPath: audioPath, privateOutput: true, singleAttempt: true, signal, maxAudioBytes: 8_000_000 });
            if (!result.error && result.outputPath === audioPath && result.mimeType) {
                // A known paid result is accounted before the provider receipt is
                // completed, even if cancellation or lease loss raced the result.
                await operation(turn._id, 'tts:billing', 'billing', () => trackTtsUsage({ channelID: turn.channelId, streamer, requireDurableUsage: true,
                    provider: request.provider, text: request.text, characters: request.text.length,
                    usage: { entryId: `${turn._id}:tts`, requestId: `${turn._id}:tts`, source: 'oauth_desktop', resourceType: 'speech', resourceId: turn._id } }));
            }
            return result;
        });
        if ('prevented' in synthesis) return;
        if (synthesis.error || synthesis.outputPath !== audioPath || !synthesis.mimeType) throw new OAuthError('synthesis_failed', 503);
        signal.throwIfAborted();
        if ((await stat(audioPath)).size > 8_000_000) throw new OAuthError('audio_too_large', 400);
        const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration', '-of', 'json', audioPath], { timeout: 5000, maxBuffer: 4096 });
        const durationMs = Math.ceil(Number(JSON.parse(stdout).format?.duration) * 1000);
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) throw new OAuthError('audio_duration', 400);
        if (!await speechActive(turn._id)) return;
        const handle = await prepareSpeechActivity({ channelId: turn.channelId, playbackId: turn.speech!.playbackId,
            outputGeneration: turn.speech!.outputGeneration, source: 'bot', expiresAt: Date.now() + 90_000, requiredSessionId: turn.sessionId, signal });
        if (!handle) throw new OAuthError('output_unavailable', 409);
        botActivities.set(turn._id, handle);
        signal.throwIfAborted();
        const ticket = newTicket(), deadline = new Date(Date.now() + 15_000);
        await (await tickets()).set(ticketKey(turn._id), ticket, { EX: 15 });
        const ready = await DesktopAiTurn.findOneAndUpdate({ _id: turn._id, 'speech.status': 'preparing' }, { $set: {
            'speech.status': 'ready', 'speech.ticketHash': hashTicket(ticket), 'speech.ticketExpiresAt': deadline, 'speech.startBefore': deadline,
            'speech.privateDir': directory, 'speech.path': audioPath, 'speech.mimeType': synthesis.mimeType, 'speech.durationMs': durationMs }, $inc: { revision: 1 } }, { new: true }).lean();
        if (!ready) { await finishBotSpeech(turn._id, 'cancelled'); return; }
        directory = undefined;
    } catch (error) {
        await finishBotSpeech(turn._id, 'failed');
        if (!controller.signal.aborted) {
            const code = error instanceof OAuthError ? error.code : 'synthesis_failed';
            const current = await DesktopAiTurn.findById(turn._id).lean();
            const unknown = current?.operations.some(item => item.status === 'pending');
            await DesktopAiTurn.updateOne({ _id: turn._id, 'speech.status': { $ne: 'cancelled' } },
                { $set: { 'speech.status': unknown ? 'indeterminate' : 'failed', 'speech.errorCode': unknown ? 'operation_outcome_unknown' : code }, $inc: { revision: 1 } });
        }
    } finally {
        speechControllers.delete(turn._id);
        if (directory) await rm(directory, { recursive: true, force: true });
    }
}
