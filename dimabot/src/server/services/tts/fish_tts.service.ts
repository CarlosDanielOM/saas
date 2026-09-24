import fs from 'fs/promises';
import path from 'path';

import { FishAudioClient, type Backends } from 'fish-audio';

import { reinforceFishTtsTags } from '../../../utils/tts/expressive_tts_tags.util.js';
import { readAudioStream } from '../../../utils/tts/tts_deadline.util.js';
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

const FISH_TTS_BACKENDS = ['s2.1-pro', 's2.1-pro-free'] as const;
const FISH_ATTEMPT_TIMEOUT_MS = 20_000;

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
    backend: string,
    signal: AbortSignal
) {
    return await fishAudio.textToSpeech.convert(
        {
            text: reinforceFishTtsTags(text),
            reference_id: referenceId,
            format: 'mp3'
        },
        backend as Backends,
        {
            abortSignal: signal,
            timeoutInSeconds: FISH_ATTEMPT_TIMEOUT_MS / 1000
        }
    );
}

async function readBackendAudio(
    fishAudio: FishAudioClient,
    text: string,
    referenceId: string,
    backend: string
): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FISH_ATTEMPT_TIMEOUT_MS);
    try {
        // The Fish client clears its own deadline once response headers arrive.
        // This abort still covers the audio body, which is the read that can hang.
        const audio = await convertWithBackend(fishAudio, text, referenceId, backend, controller.signal);
        const buffer = await readAudioStream(audio, controller.signal);
        if (buffer.length === 0) {
            throw new Error(`Fish Audio TTS returned empty audio from '${backend}'`);
        }
        return buffer;
    } finally {
        clearTimeout(timer);
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

            let audio: Buffer | undefined;
            let usedBackend: string | undefined;
            const failures: string[] = [];
            for (const backend of FISH_TTS_BACKENDS) {
                try {
                    audio = await readBackendAudio(fishAudio, request.text, referenceId, backend);
                    usedBackend = backend;
                    break;
                } catch (backendError) {
                    const message = backendError instanceof Error ? backendError.message : String(backendError);
                    failures.push(`${backend}: ${message}`);
                }
            }

            if (!audio || !usedBackend) {
                return {
                    error: true,
                    message: `Fish Audio TTS failed on both backends: ${failures.join('; ')}`
                };
            }

            await fs.writeFile(outputPath, audio);

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
