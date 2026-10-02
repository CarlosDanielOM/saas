import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Server } from 'socket.io';
import { getDragonflyClient } from '../../../utils/databases/dragonfly.database.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { getAiCredits } from '../../../utils/billing.js';
import { calculateTtsUsage, trackTtsUsage } from '../../../utils/tts_usage.js';
import { getChannelTtsSettings, DEFAULT_TTS_SETTINGS, type TtsProvider } from '../../../schemas/channel_tts_settings.schema.js';
import { resolveKokoroVoice } from '../../../utils/tts/kokoro_voices.util.js';
import { kokoroTtsService } from './kokoro_tts.service.js';
import { piperTtsService } from './piper_tts.service.js';
import { fishTtsService } from './fish_tts.service.js';
import { getFishVoice, VoiceRequestError } from './fish_voice_catalog.service.js';

export const PREVIEW_MAX_CREDITS = 150;
export const PREVIEW_PHRASES = {
    en: [
        'Welcome to the stream! Make yourself comfortable and enjoy the show.',
        'Hello, chat! What adventure should we try together today?',
        'That was amazing! Thank you for sharing this moment with us.',
        'A new adventure begins. Ready, everyone? Let us get started!',
        'Thanks for stopping by. Your next favorite moment is just around the corner.'
    ],
    es: [
        '¡Bienvenidos al directo! Pónganse cómodos y disfruten del espectáculo.',
        '¡Hola, chat! ¿Qué aventura deberíamos intentar juntos hoy?',
        '¡Eso fue increíble! Gracias por compartir este momento con nosotros.',
        'Una nueva aventura comienza. ¿Están listos? ¡Vamos a empezar!',
        'Gracias por venir. Tu próximo momento favorito está a punto de llegar.'
    ]
} as const;
export function choosePreviewPhrase(language: 'en' | 'es', provider: TtsProvider = 'fish') {
    const text = PREVIEW_PHRASES[language][randomInt(5)];
    const usage = calculateTtsUsage(provider, provider === 'fish' ? text.length : Array.from(text).length);
    const credits = usage.creditsConsumed;
    if (credits > PREVIEW_MAX_CREDITS) throw new VoiceRequestError(503, 'preview_unavailable', 'Preview exceeds credit limit');
    return { text, credits };
}
export async function createPreviewTicket(channelID: string) {
    const ticket = randomBytes(32).toString('hex');
    const cache = await getDragonflyClient('VoicePreview');
    await cache.set(`tts:preview:ticket:${ticket}`, channelID, { EX: 30 });
    return ticket;
}
export function registerVoicePreview(io: Server) {
    const namespace = io.of(/^\/speech-preview\/\d+$/);
    namespace.use(async (socket, next) => {
        try {
            const ticket = socket.handshake.auth?.ticket;
            if (typeof ticket !== 'string' || !/^[a-f\d]{64}$/.test(ticket)) return next(new Error('Unauthorized preview'));
            const cache = await getDragonflyClient('VoicePreview');
            const channelID = await cache.getDel(`tts:preview:ticket:${ticket}`);
            if (channelID !== socket.nsp.name.split('/')[2]) return next(new Error('Unauthorized preview'));
            next();
        } catch { next(new Error('Preview connection unavailable')); }
    });
    namespace.on('connection', socket => {
        const channelID = socket.nsp.name.split('/')[2];
        const expiry = setTimeout(() => socket.disconnect(true), 5 * 60 * 1000);
        expiry.unref();
        socket.on('disconnect', () => clearTimeout(expiry));
        let busy = false;
        socket.on('preview', async (body: unknown, ack: unknown) => {
            if (typeof ack !== 'function') return;
            if (busy) return ack({ error: true, code: 'preview_busy' });
            busy = true;
            const lockId = randomUUID();
            const lockKey = `tts:preview:lock:${channelID}`;
            let locked = false;
            let outputPath: string | undefined;
            let renewal: NodeJS.Timeout | undefined;
            let cache: Awaited<ReturnType<typeof getDragonflyClient>> | undefined;
            try {
                if (!body || typeof body !== 'object') throw new VoiceRequestError(400, 'invalid_voice', 'Invalid preview');
                const { voiceId, language, provider = 'fish' } = body as Record<string, unknown>;
                if (typeof voiceId !== 'string' || !voiceId || (language !== 'en' && language !== 'es') ||
                    (provider !== 'piper' && provider !== 'kokoro' && provider !== 'fish')) {
                    throw new VoiceRequestError(400, 'invalid_voice', 'Invalid voice or language');
                }
                if (provider === 'kokoro' && !resolveKokoroVoice(voiceId)) {
                    throw new VoiceRequestError(400, 'invalid_voice', 'Invalid Kokoro preset');
                }
                if (provider === 'fish' && !/^[a-f\d]{32}$/i.test(voiceId)) {
                    throw new VoiceRequestError(400, 'invalid_voice', 'Invalid Fish voice');
                }
                if (provider === 'piper') {
                    const settings = await getChannelTtsSettings(channelID);
                    if (voiceId !== DEFAULT_TTS_SETTINGS.voices[language] && voiceId !== settings.voices[language]) {
                        throw new VoiceRequestError(400, 'invalid_voice', 'Invalid Piper voice');
                    }
                }
                cache = await getDragonflyClient('VoicePreview');
                locked = await cache.set(lockKey, lockId, { NX: true, EX: 120 }) === 'OK';
                if (!locked) throw new VoiceRequestError(429, 'preview_busy', 'A preview is already running');
                renewal = setInterval(() => {
                    void cache!.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0",
                        { keys: [lockKey], arguments: [lockId] }).catch(() => socket.disconnect(true));
                }, 30000);
                renewal.unref();
                const cooldown = await cache.set(`tts:preview:cooldown:${channelID}`, '1', { NX: true, EX: 8 });
                if (!cooldown) throw new VoiceRequestError(429, 'preview_busy', 'Please wait before another preview');
                if (provider === 'fish') await getFishVoice(voiceId);
                const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
                if (!streamer) throw new VoiceRequestError(404, 'preview_unavailable', 'Account not found');
                const { text, credits } = choosePreviewPhrase(language, provider);
                // Piper can continue consuming credits past zero, just like regular Piper speech.
                if (provider !== 'piper') {
                    const balance = await getAiCredits(streamer, channelID, { requireVerified: true });
                    if (!balance.available || balance.status !== 'available' || balance.balance < credits) {
                        throw new VoiceRequestError(402, 'insufficient_credits', 'Not enough available credits for this preview');
                    }
                }
                if (!socket.connected) return;
                const speechID = `preview-${randomUUID()}`;
                const usageRequestID = randomUUID();
                const service = provider === 'kokoro' ? kokoroTtsService : provider === 'piper' ? piperTtsService : fishTtsService;
                const result = await service.synthesize({
                    channelID, speechID, provider, mode: provider === 'fish' ? 'clone' : 'speak',
                    language, text, voice: voiceId, outputPath: ''
                });
                outputPath = result.outputPath;
                if (result.error || !outputPath) throw new VoiceRequestError(502, 'synthesis_failed', 'This voice could not be previewed');
                const audio = await fs.readFile(outputPath);
                if (!audio.length) throw new VoiceRequestError(502, 'synthesis_failed', 'Empty preview audio');
                // Same billing path as normal TTS, once per successful generation. Replaying the audio is free.
                await trackTtsUsage({
                    channelID,
                    streamer,
                    provider,
                    characters: provider === 'fish' ? text.length : Array.from(text).length,
                    text,
                    usage: {
                        entryId: randomUUID(),
                        requestId: usageRequestID,
                        source: 'voice_preview',
                        resourceType: 'voice_preview',
                        resourceId: speechID
                    }
                });
                ack({ error: false, data: { provider, voiceId, text, credits, mimeType: result.mimeType ?? (provider === 'piper' ? 'audio/wav' : 'audio/mpeg'), audio: audio.toString('base64') } });
            } catch (error) {
                ack({ error: true, code: error instanceof VoiceRequestError ? error.code : 'preview_unavailable' });
            } finally {
                if (renewal) clearInterval(renewal);
                if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
                if (locked && cache) await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
                    { keys: [lockKey], arguments: [lockId] }).catch(() => {});
                busy = false;
            }
        });
    });
}
