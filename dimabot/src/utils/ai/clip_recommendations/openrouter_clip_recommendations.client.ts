import fs from 'node:fs/promises';
import path from 'node:path';
import {
    AUDIO_DISCOVERY_SYSTEM_PROMPT,
    AUDIO_DISCOVERY_USER_PROMPT,
    buildVideoVerificationUserPrompt,
    CLIP_RECOMMENDATION_MODEL_ID,
    VIDEO_VERIFICATION_SYSTEM_PROMPT
} from './clip_recommendations_prompts.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MAX_AUDIO_CANDIDATES = Math.max(1, Number(process.env.CLIP_RECOMMENDATION_MAX_AUDIO_CANDIDATES || 24));

// Map of MIME type -> input_audio format hint supported by Xiaomi / mimo-v2.5.
const AUDIO_MIME_TO_FORMAT: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aiff': 'aiff',
    'audio/x-aiff': 'aiff',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/m4a': 'm4a',
    'audio/mp4': 'm4a'
};

export interface AudioCandidate {
    startSeconds: number;
    endSeconds: number;
    reason: string;
    confidence: number;
}

export interface VideoVerificationResult {
    approved: boolean;
    why: string;
}

interface OpenRouterMessageContentText {
    type: 'text';
    text: string;
}

interface OpenRouterAudioContent {
    type: 'input_audio';
    input_audio: { data: string; format: string };
}

interface OpenRouterVideoContent {
    type: 'video_url';
    video_url: { url: string };
}

interface OpenRouterImageContent {
    type: 'image_url';
    image_url: { url: string };
}

type OpenRouterUserContent = OpenRouterMessageContentText | OpenRouterAudioContent | OpenRouterVideoContent | OpenRouterImageContent;

interface OpenRouterResponse {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string } | boolean;
    message?: string;
}

function normalizeJsonText(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function clampCandidate(candidate: Partial<AudioCandidate>): AudioCandidate | null {
    const start = Math.max(0, Math.floor(Number(candidate.startSeconds)));
    const rawEnd = Math.floor(Number(candidate.endSeconds));
    const reason = String(candidate.reason || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || !reason) {
        return null;
    }

    const duration = Math.max(5, Math.min(60, rawEnd - start));
    const endSeconds = start + duration;
    const confidence = Math.max(0, Math.min(1, Number(candidate.confidence || 0)));
    return { startSeconds: start, endSeconds, reason: reason.slice(0, 500), confidence };
}

async function fileToBase64(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
}

function resolveAudioFormat(mimeType: string): string {
    const normalized = String(mimeType || '').toLowerCase().trim();
    if (AUDIO_MIME_TO_FORMAT[normalized]) return AUDIO_MIME_TO_FORMAT[normalized];
    if (normalized.startsWith('audio/')) {
        const sub = normalized.split('/')[1] || '';
        if (sub) return sub;
    }
    throw new Error(`Unsupported audio MIME type for OpenRouter input_audio: ${mimeType}`);
}

async function callOpenRouterJson(options: {
    modelID?: string;
    systemPrompt: string;
    userText: string;
    filePath: string;
    mimeType: string;
    maxTokens?: number;
    user?: string;
}): Promise<unknown> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is required for clip recommendations');
    }

    const normalizedMime = String(options.mimeType || '').toLowerCase().trim();
    const base64Data = await fileToBase64(options.filePath);

    let mediaContent: OpenRouterUserContent;
    if (normalizedMime.startsWith('audio/')) {
        // Xiaomi/mimo-v2.5 audio format: type=input_audio with { data, format }
        const audioFormat = resolveAudioFormat(normalizedMime);
        mediaContent = {
            type: 'input_audio',
            input_audio: { data: base64Data, format: audioFormat }
        };
    } else if (normalizedMime.startsWith('video/')) {
        // Xiaomi/mimo-v2.5 video format: type=video_url with a data URL
        mediaContent = {
            type: 'video_url',
            video_url: { url: `data:${normalizedMime};base64,${base64Data}` }
        };
    } else if (normalizedMime.startsWith('image/')) {
        // Xiaomi/mimo-v2.5 image format: type=image_url with a data URL
        mediaContent = {
            type: 'image_url',
            image_url: { url: `data:${normalizedMime};base64,${base64Data}` }
        };
    } else {
        throw new Error(`OpenRouter clip recommendations accept only audio/video/image inputs (got ${options.mimeType}).`);
    }

    const body = {
        model: options.modelID || CLIP_RECOMMENDATION_MODEL_ID,
        messages: [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: [
                { type: 'text', text: options.userText },
                mediaContent
            ] }
        ],
        response_format: { type: 'json_object' },
        max_tokens: options.maxTokens || 8000,
        user: options.user
    };

    const response = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://domdimabot.com',
            'X-Title': 'DomDimaBot'
        },
        body: JSON.stringify(body)
    });

    let payload: OpenRouterResponse;
    try {
        payload = await response.json() as OpenRouterResponse;
    } catch (parseError) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`OpenRouter returned non-JSON response (HTTP ${response.status}): ${responseText.slice(0, 500)}`);
    }

    if (!response.ok || payload.error) {
        let errorMessage: string;
        if (typeof payload.error === 'object' && payload.error) {
            errorMessage = payload.error.message ?? `OpenRouter HTTP ${response.status}`;
        } else {
            errorMessage = payload.message ?? `OpenRouter HTTP ${response.status}`;
        }
        throw new Error(errorMessage || `OpenRouter HTTP ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenRouter response did not include message content');
    }

    return JSON.parse(normalizeJsonText(content));
}

export async function analyzeVodAudioForClipMoments(input: {
    audioPath: string;
    channelID: string;
    modelID?: string;
}): Promise<AudioCandidate[]> {
    const parsed = await callOpenRouterJson({
        modelID: input.modelID,
        systemPrompt: AUDIO_DISCOVERY_SYSTEM_PROMPT,
        userText: AUDIO_DISCOVERY_USER_PROMPT,
        filePath: input.audioPath,
        mimeType: 'audio/mpeg',
        maxTokens: 12000,
        user: input.channelID
    });

    const rawItems = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { candidates?: unknown[] })?.candidates)
            ? (parsed as { candidates: unknown[] }).candidates
            : [];

    return rawItems
        .map((item) => clampCandidate(item as Partial<AudioCandidate>))
        .filter((item): item is AudioCandidate => Boolean(item))
        .slice(0, DEFAULT_MAX_AUDIO_CANDIDATES);
}

export async function verifyCandidateVideo(input: {
    videoPath: string;
    channelID: string;
    reason: string;
    startSeconds: number;
    endSeconds: number;
    modelID?: string;
}): Promise<VideoVerificationResult> {
    const parsed = await callOpenRouterJson({
        modelID: input.modelID,
        systemPrompt: VIDEO_VERIFICATION_SYSTEM_PROMPT,
        userText: buildVideoVerificationUserPrompt(input.reason, input.startSeconds, input.endSeconds),
        filePath: input.videoPath,
        mimeType: 'video/mp4',
        maxTokens: 2000,
        user: input.channelID
    }) as Partial<VideoVerificationResult>;

    return {
        approved: Boolean(parsed.approved),
        why: String(parsed.why || '').trim().slice(0, 1000) || 'No explanation provided by verifier.'
    };
}