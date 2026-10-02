import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveKokoroVoice } from '../../../utils/tts/kokoro_voices.util.js';
import { PIPER_PUBLIC_SPEECH_DIR, buildPublicPath } from './piper_tts.service.js';
import type { TtsProvider, TtsSynthesisRequest, TtsSynthesisResult } from './tts_provider.interface.js';

export const KOKORO_MODEL = 'hexgrad/kokoro-82m';
const ATTEMPT_TIMEOUT_MS = 20_000;

class KokoroTtsService implements TtsProvider {
    readonly name = 'kokoro';

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
        const apiKey = process.env.OPENROUTER_API_KEY?.trim();
        if (!apiKey) return { error: true, message: 'OpenRouter API key is not configured' };
        const voice = resolveKokoroVoice(request.voice);
        if (!voice) return { error: true, message: 'Invalid Kokoro preset voice' };
        if (!request.text.trim()) return { error: true, message: 'No text provided' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
        try {
            const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: KOKORO_MODEL, input: request.text, voice, response_format: 'mp3',
                    // An outage must never route to Together's more expensive endpoint.
                    provider: { only: ['deepinfra'], order: ['deepinfra'], allow_fallbacks: false }
                }),
                signal: controller.signal
            });
            if (!response.ok) {
                await response.body?.cancel();
                return { error: true, message: `Kokoro DeepInfra synthesis failed (HTTP ${response.status})` };
            }
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/mpeg')) {
                await response.body?.cancel();
                return { error: true, message: 'Kokoro returned an unexpected audio format' };
            }
            // The same deadline covers headers and the complete audio body.
            const audio = Buffer.from(await response.arrayBuffer());
            if (!audio.length) return { error: true, message: 'Kokoro returned empty audio' };
            const outputDir = path.join(PIPER_PUBLIC_SPEECH_DIR, request.channelID);
            await fs.mkdir(outputDir, { recursive: true });
            const outputPath = path.join(outputDir, `${request.speechID}.mp3`);
            await fs.writeFile(outputPath, audio);
            return { error: false, message: 'Speech synthesized with Kokoro (DeepInfra)',
                outputPath, publicPath: buildPublicPath(request.channelID, request.speechID), mimeType: 'audio/mpeg' };
        } catch (error) {
            return { error: true, message: error instanceof Error ? error.message : String(error) };
        } finally {
            clearTimeout(timer);
        }
    }
}
export const kokoroTtsService = new KokoroTtsService();
