import fs from 'fs/promises';
import path from 'path';

import { getDirname } from '../../../utils/pollyfills.js';
import type { OpenRouterTtsModel } from '../../../schemas/channel_tts_settings.schema.js';
import type { TtsProvider, TtsSynthesisRequest, TtsSynthesisResult } from './tts_provider.interface.js';

const __dirname = getDirname(import.meta.url);
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../../routes/public/speech');

const OPENROUTER_TTS_URL = 'https://openrouter.ai/api/v1/audio/speech';
const DEFAULT_OPENROUTER_MODEL: OpenRouterTtsModel = 'openai/gpt-4o-mini-tts-2025-12-15';
const OPENROUTER_PCM_SAMPLE_RATE = 24000;
const OPENROUTER_PCM_CHANNELS = 1;
const OPENROUTER_PCM_BITS_PER_SAMPLE = 16;

export const OPENROUTER_TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
export type OpenRouterTtsVoice = typeof OPENROUTER_TTS_VOICES[number];
export const OPENROUTER_TTS_MODELS = ['openai/gpt-4o-mini-tts-2025-12-15', 'hexgrad/kokoro-82m'] as const;

function getOpenRouterApiKey(): string | null {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key || key.trim() === '') {
        return null;
    }

    return key.trim();
}

function getOpenRouterReferer(): string {
    const configured = process.env.OPENROUTER_SITE_URL;
    if (configured && configured.trim() !== '') {
        return configured.trim();
    }

    return 'https://domdimabot.com';
}

function getOpenRouterTitle(): string {
    const configured = process.env.OPENROUTER_SITE_NAME;
    if (configured && configured.trim() !== '') {
        return configured.trim();
    }

    return 'DomDimaBot';
}

function getPublicApiUrl(): string {
    const configured = process.env.PUBLIC_API_URL;
    if (configured && configured.trim() !== '') {
        return configured.replace(/\/+$/, '');
    }

    return process.env.NODE_ENV === 'production'
        ? 'https://api.domdimabot.com'
        : 'http://localhost:3000';
}

function buildPublicPath(channelID: string, speechID: string): string {
    return `${getPublicApiUrl()}/speech/audio/${encodeURIComponent(channelID)}/${encodeURIComponent(speechID)}`;
}

async function ensureSpeechOutputDir(channelID: string): Promise<string> {
    const outputDir = path.join(DEFAULT_PUBLIC_DIR, channelID);
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
}

function getPcmSampleRate(contentType: string | null): number {
    const normalized = String(contentType || '').toLowerCase();
    const match = normalized.match(/rate=(\d+)/);
    if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return OPENROUTER_PCM_SAMPLE_RATE;
}

function wrapPcm16ToWav(pcmBuffer: Buffer, sampleRate: number): Buffer {
    const blockAlign = OPENROUTER_PCM_CHANNELS * (OPENROUTER_PCM_BITS_PER_SAMPLE / 8);
    const byteRate = sampleRate * blockAlign;
    const wavHeader = Buffer.alloc(44);

    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(OPENROUTER_PCM_CHANNELS, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(OPENROUTER_PCM_BITS_PER_SAMPLE, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([wavHeader, pcmBuffer]);
}

function getOutputFormat(contentType: string | null): { extension: 'mp3' | 'wav'; mimeType: 'audio/mpeg' | 'audio/wav'; isRawPcm: boolean } {
    const normalized = String(contentType || '').toLowerCase();
    if (normalized.includes('wav')) {
        return { extension: 'wav', mimeType: 'audio/wav', isRawPcm: false };
    }

    if (normalized.includes('audio/l16') || normalized.includes('audio/pcm')) {
        return { extension: 'wav', mimeType: 'audio/wav', isRawPcm: true };
    }

    return { extension: 'mp3', mimeType: 'audio/mpeg', isRawPcm: false };
}

async function synthesizeWithOpenRouter(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
        return {
            error: true,
            message: 'OpenRouter API key is not configured'
        };
    }

    const response = await fetch(OPENROUTER_TTS_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': getOpenRouterReferer(),
            'X-OpenRouter-Title': getOpenRouterTitle()
        },
        body: JSON.stringify({
            model: OPENROUTER_TTS_MODELS.includes((request.model || '') as typeof OPENROUTER_TTS_MODELS[number])
                ? request.model
                : DEFAULT_OPENROUTER_MODEL,
            input: request.text,
            voice: request.voice
        })
    });

    if (!response.ok) {
        const body = await response.text();
        return {
            error: true,
            message: body || `OpenRouter TTS synthesis failed with ${response.status}`
        };
    }

    const contentType = response.headers.get('content-type');
    const format = getOutputFormat(contentType);
    const finalOutputPath = request.outputPath.replace(/\.(mp3|wav)$/i, `.${format.extension}`);
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const outputBuffer = format.isRawPcm
        ? wrapPcm16ToWav(responseBuffer, getPcmSampleRate(contentType))
        : responseBuffer;

    await fs.writeFile(finalOutputPath, outputBuffer);

    return {
        error: false,
        message: 'Speech synthesized with OpenRouter TTS',
        outputPath: finalOutputPath,
        publicPath: buildPublicPath(request.channelID, request.speechID),
        mimeType: format.mimeType
    };
}

class OpenRouterTtsService implements TtsProvider {
    readonly name = 'openrouter';

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
        try {
            if (!OPENROUTER_TTS_VOICES.includes(request.voice as OpenRouterTtsVoice)) {
                return {
                    error: true,
                    message: `Invalid OpenRouter TTS voice: ${request.voice}. Available voices: ${OPENROUTER_TTS_VOICES.join(', ')}`
                };
            }

            if (request.model && !OPENROUTER_TTS_MODELS.includes(request.model as typeof OPENROUTER_TTS_MODELS[number])) {
                return {
                    error: true,
                    message: `Invalid OpenRouter TTS model: ${request.model}. Available models: ${OPENROUTER_TTS_MODELS.join(', ')}`
                };
            }

            const outputDir = await ensureSpeechOutputDir(request.channelID);
            const outputPath = path.join(outputDir, `${request.speechID}.mp3`);
            const normalizedRequest: TtsSynthesisRequest = {
                ...request,
                outputPath
            };

            return await synthesizeWithOpenRouter(normalizedRequest);
        } catch (error) {
            return {
                error: true,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

const openRouterTtsService = new OpenRouterTtsService();

export { openRouterTtsService };
