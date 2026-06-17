import fs from 'fs/promises';
import path from 'path';

import { FishAudioClient, type Backends } from 'fish-audio';

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

            const audio = await fishAudio.textToSpeech.convert(
                {
                    text: request.text,
                    reference_id: referenceId,
                    format: 'mp3'
                },
                's2-pro' as Backends
            );

            const buffer = Buffer.from(await new Response(audio).arrayBuffer());
            await fs.writeFile(outputPath, buffer);

            return {
                error: false,
                message: 'Speech synthesized with Fish Audio',
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
