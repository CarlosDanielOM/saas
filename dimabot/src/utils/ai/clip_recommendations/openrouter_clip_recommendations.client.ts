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

interface OpenRouterMessageContentFile {
    type: 'file';
    file: {
        filename: string;
        mime_type: string;
        data: string;
    };
}

type OpenRouterMessageContent = string | Array<OpenRouterMessageContentText | OpenRouterMessageContentFile>;

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

async function fileToDataUrl(filePath: string, mimeType: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
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

    const dataUrl = await fileToDataUrl(options.filePath, options.mimeType);
    const body = {
        model: options.modelID || CLIP_RECOMMENDATION_MODEL_ID,
        messages: [
            { role: 'system', content: options.systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: options.userText },
                    {
                        type: 'file',
                        file: {
                            filename: path.basename(options.filePath),
                            mime_type: options.mimeType,
                            data: dataUrl
                        }
                    }
                ] satisfies OpenRouterMessageContent
            }
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

    const payload = await response.json() as OpenRouterResponse;
    if (!response.ok || payload.error) {
        const errorMessage = typeof payload.error === 'object' ? payload.error.message : payload.message;
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
