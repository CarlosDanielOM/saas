import fs from 'fs/promises';
import path from 'path';

import { FishAudioClient, type Backends } from 'fish-audio';

import { OPENROUTER_APP_HEADERS } from '../../../utils/ai/openrouter/app_attribution.util.js';
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

export const FISH_OPENROUTER_MODEL = 'fish-audio/drama-3';
const FISH_TTS_BACKENDS = [
    FISH_OPENROUTER_MODEL,
    's2.1-pro',
] as const;
const FISH_ATTEMPT_TIMEOUT_MS = 20_000;

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
            text: backend.startsWith('s2.1-') ? reinforceFishTtsTags(text) : text,
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
    text: string,
    referenceId: string,
    backend: string,
    channelID: string
): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FISH_ATTEMPT_TIMEOUT_MS);
    try {
        let audio: ReadableStream<Uint8Array>;
        if (backend === FISH_OPENROUTER_MODEL) {
            const apiKey = process.env.OPENROUTER_API_KEY?.trim();
            if (!apiKey) throw new Error('OpenRouter API key is not configured');
            const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_APP_HEADERS },
                // OpenRouter maps the Fish voice ID to the upstream reference_id.
                body: JSON.stringify({ model: FISH_OPENROUTER_MODEL, input: text, voice: referenceId, response_format: 'mp3', user: channelID }),
                signal: controller.signal
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`OpenRouter Fish synthesis failed (HTTP ${response.status})`);
            }
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/mpeg') || !response.body) {
                await response.body?.cancel();
                throw new Error('OpenRouter Fish returned an unexpected audio format');
            }
            audio = response.body;
        } else {
            const apiKey = process.env.FISH_AUDIO_API_KEY?.trim();
            if (!apiKey) throw new Error('Fish Audio API key is not configured');
            audio = await convertWithBackend(new FishAudioClient({ apiKey }), text, referenceId, backend, controller.signal);
        }
        // One deadline covers headers and the full audio body for either route.
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
            const outputDir = await ensureSpeechOutputDir(request.channelID);
            const outputPath = path.join(outputDir, `${request.speechID}.mp3`);
            const referenceId = String(request.voice).trim();

            let audio: Buffer | undefined;
            let usedBackend: string | undefined;
            const failures: string[] = [];
            for (const backend of FISH_TTS_BACKENDS) {
                try {
                    audio = await readBackendAudio(request.text, referenceId, backend, request.channelID);
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
                    message: `Fish Audio TTS failed on all enabled backends: ${failures.join('; ')}`
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
