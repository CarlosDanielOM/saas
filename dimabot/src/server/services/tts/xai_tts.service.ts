import fs from 'fs/promises';
import path from 'path';

import { getDirname } from '../../../utils/pollyfills.js';
import type { TtsProvider, TtsSynthesisRequest, TtsSynthesisResult } from './tts_provider.interface.js';

const __dirname = getDirname(import.meta.url);
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../../routes/public/speech');

const XAI_API_URL = 'https://api.x.ai/v1/tts';
const XAI_MP3_BIT_RATE = 128000;
const XAI_MP3_SAMPLE_RATE = 24000;

export const XAI_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'] as const;
export type XaiVoice = typeof XAI_VOICES[number];

function normalizeXaiVoice(value: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const normalizedName = trimmed.toLowerCase();
    if (XAI_VOICES.includes(normalizedName as XaiVoice)) {
        return normalizedName;
    }

    return trimmed;
}

function toXaiLanguage(language: TtsSynthesisRequest['language']): string {
    if (language === 'en') {
        return 'en';
    }

    return 'es-MX';
}

function getXaiApiKey(): string | null {
    const key = process.env.XAI_API_KEY;
    if (!key || key.trim() === '') {
        return null;
    }
    return key.trim();
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

async function synthesizeWithXai(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const apiKey = getXaiApiKey();
    if (!apiKey) {
        return {
            error: true,
            message: 'xAI API key is not configured'
        };
    }

    const response = await fetch(XAI_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text: request.text,
            voice_id: request.voice,
            language: toXaiLanguage(request.language),
            output_format: {
                codec: 'mp3',
                sample_rate: XAI_MP3_SAMPLE_RATE,
                bit_rate: XAI_MP3_BIT_RATE
            }
        })
    });

    if (!response.ok) {
        const body = await response.text();
        return {
            error: true,
            message: body || `xAI TTS synthesis failed with ${response.status}`
        };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(request.outputPath, buffer);

    return {
        error: false,
        message: 'Speech synthesized with xAI TTS',
        outputPath: request.outputPath,
        publicPath: buildPublicPath(request.channelID, request.speechID),
        mimeType: 'audio/mpeg'
    };
}

class XaiTtsService implements TtsProvider {
    readonly name = 'xai';

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
        try {
            const voice = normalizeXaiVoice(request.voice);
            if (!voice) {
                return {
                    error: true,
                    message: `Invalid xAI voice. Provide one of ${XAI_VOICES.join(', ')} or a valid xAI voice ID.`
                };
            }

            const outputDir = await ensureSpeechOutputDir(request.channelID);
            const outputPath = path.join(outputDir, `${request.speechID}.mp3`);
            const normalizedRequest: TtsSynthesisRequest = {
                ...request,
                voice,
                outputPath
            };

            return await synthesizeWithXai(normalizedRequest);
        } catch (error) {
            return {
                error: true,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

const xaiTtsService = new XaiTtsService();

export { xaiTtsService };
