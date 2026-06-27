import fs from 'fs/promises';
import path from 'path';

import { FishAudioClient, type Backends } from 'fish-audio';

import { error as logError, warn as logWarn } from '../../../utils/logger.js';
import { PIPER_PUBLIC_SPEECH_DIR, buildPublicPath } from './piper_tts.service.js';
import type { TtsProvider, TtsSynthesisRequest, TtsSynthesisResult } from './tts_provider.interface.js';

export const FISH_VOICES: Record<string, string> = {
    gojo: '7b5626abdaa044babfc3829ec15acf31',
    rias_gremory: 'a5711996953b4cfda57cb516e26fe1e0',
    toji_fushiguro: '51504afe0e93445c9c507451d6ace486',
    carlos_bodoque: '0a6d2732710f466aafa67cdb8db3bf0e',
} as const;

export const FISH_VOICE_NAMES = Object.keys(FISH_VOICES) as string[];

export const DEFAULT_FISH_TTS_REFERENCE_ID = FISH_VOICES['gojo'];

const PRIMARY_FISH_TTS_BACKEND = 's2.1-pro-free';
const FALLBACK_FISH_TTS_BACKEND = 's2-pro';

function getFishApiKey(): string | null {
    const key = process.env.FISH_AUDIO_API_KEY;
    if (!key || key.trim() === '') {
        return null;
    }

    return key.trim();
}

async function ensureSpeechOutputDir(channelID: string): Promise<string> {
    const outputDir = path.join(PIPER_PUBLIC_SPEECH_DIR, channelID);
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
}

async function convertWithBackend(
    fishAudio: FishAudioClient,
    text: string,
    referenceId: string,
    backend: string
) {
    return await fishAudio.textToSpeech.convert(
        {
            text,
            reference_id: referenceId,
            format: 'mp3'
        },
        backend as Backends
    );
}

async function synthesizeWithFallback(
    fishAudio: FishAudioClient,
    text: string,
    referenceId: string,
    channelID: string
): Promise<{ audio: ReadableStream<Uint8Array>; usedBackend: string }> {
    try {
        const audio = await convertWithBackend(fishAudio, text, referenceId, PRIMARY_FISH_TTS_BACKEND);
        return { audio, usedBackend: PRIMARY_FISH_TTS_BACKEND };
    } catch (primaryError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        await logWarn({
            event: 'fish_tts_fallback',
            from: PRIMARY_FISH_TTS_BACKEND,
            to: FALLBACK_FISH_TTS_BACKEND,
            primaryError: primaryMessage
        }, { channelId: channelID });

        try {
            const audio = await convertWithBackend(fishAudio, text, referenceId, FALLBACK_FISH_TTS_BACKEND);
            return { audio, usedBackend: FALLBACK_FISH_TTS_BACKEND };
        } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            await logError({
                event: 'fish_tts_total_failure',
                primary: PRIMARY_FISH_TTS_BACKEND,
                fallback: FALLBACK_FISH_TTS_BACKEND,
                primaryError: primaryMessage,
                fallbackError: fallbackMessage
            }, { channelId: channelID });

            throw new Error(
                `Fish Audio TTS failed on primary '${PRIMARY_FISH_TTS_BACKEND}' and fallback '${FALLBACK_FISH_TTS_BACKEND}': ${fallbackMessage}`
            );
        }
    }
}

class FishTtsService implements TtsProvider {
    readonly name = 'fish';

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
        try {
            const apiKey = getFishApiKey();
            if (!apiKey) {
                return {
                    error: true,
                    message: 'Fish Audio API key is not configured'
                };
            }

            const outputDir = await ensureSpeechOutputDir(request.channelID);
            const outputPath = path.join(outputDir, `${request.speechID}.mp3`);
            const fishAudio = new FishAudioClient({ apiKey });
            const referenceId = String(request.voice).trim();

            const { audio, usedBackend } = await synthesizeWithFallback(
                fishAudio,
                request.text,
                referenceId,
                request.channelID
            );

            const buffer = Buffer.from(await new Response(audio).arrayBuffer());
            await fs.writeFile(outputPath, buffer);

            return {
                error: false,
                message: `Speech synthesized with Fish Audio (${usedBackend})`,
                outputPath,
                publicPath: buildPublicPath(request.channelID, request.speechID),
                mimeType: 'audio/mpeg'
            };
        } catch (error) {
            return {
                error: true,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

const fishTtsService = new FishTtsService();

export { fishTtsService };
