import fs from 'node:fs/promises';
import path from 'node:path';
import {
    AUDIO_DISCOVERY_SYSTEM_PROMPT,
    AUDIO_DISCOVERY_USER_PROMPT,
    buildVideoVerificationUserPrompt,
    CLIP_RECOMMENDATION_MODEL_ID,
    VIDEO_VERIFICATION_SYSTEM_PROMPT
} from './clip_recommendations_prompts.js';
import { info as logInfo, warn as logWarn } from '../../logger.js';
import { createFetchWithRetry } from '../fetch.utils.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MAX_AUDIO_CANDIDATES = Math.max(1, Number(process.env.CLIP_RECOMMENDATION_MAX_AUDIO_CANDIDATES) || 24);

// Audio payloads can be ~5 MB+ base64 — give each request a generous timeout.
// Retries use the shared default policy (1s/3s/5s backoff on 429/500/502/503/504),
// which absorbs transient OpenRouter gateway errors without redoing the entire
// VOD workflow (download + ffmpeg extract + credit charge).
const audioFetch = createFetchWithRetry({ timeout: 60_000, retries: 3 });

// Video verification batches multiple base64 video clips — request body is larger
// and the model takes longer, so use a higher timeout.
const videoFetch = createFetchWithRetry({ timeout: 120_000, retries: 3 });

/**
 * Build a useful diagnostic suffix when the response body is empty (e.g. a 502
 * from an upstream gateway that returns no content). Includes statusText and any
 * request-id style headers so we can correlate with OpenRouter/edge logs.
 */
function buildEmptyBodyDiagnostic(response: Response): string {
    const parts: string[] = [];
    if (response.statusText) parts.push(`statusText=${response.statusText}`);
    const interestingHeaderNames = ['x-request-id', 'x-request-id-2', 'cf-ray', 'x-vercel-id', 'tracestate'];
    for (const name of interestingHeaderNames) {
        const value = response.headers.get(name);
        if (value) parts.push(`${name}=${value}`);
    }
    return parts.length > 0 ? ` (${parts.join(', ')})` : ' (empty body)';
}

// Map of MIME type -> OpenRouter input_audio format hint.
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

/**
 * Try to extract a candidate array from a model response that may wrap its
 * results under various keys. The model has been observed to return
 * { clips: [...] }, { moments: [...] }, { candidates: [...] }, { results: [...] }
 * or a bare array — we accept all of them.
 */
function extractCandidateArray(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const keys = ['candidates', 'clips', 'moments', 'results'];
        for (const key of keys) {
            if (Array.isArray(obj[key])) return obj[key] as unknown[];
        }
    }
    return [];
}

function clampCandidate(candidate: Partial<AudioCandidate>, maxDurationSeconds: number): AudioCandidate | null {
    const rawStart = Number(candidate.startSeconds);
    const rawEnd = Math.floor(Number(candidate.endSeconds));
    const reason = String(candidate.reason || '').trim();
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || !reason) {
        return null;
    }

    const start = Math.max(0, Math.floor(rawStart));
    if (rawEnd <= start) return null;
    const upperBound = Number.isFinite(maxDurationSeconds)
        ? Math.max(1, Math.floor(maxDurationSeconds))
        : Number.POSITIVE_INFINITY;
    if (start >= upperBound) return null;

    const duration = Math.max(5, Math.min(60, rawEnd - start));
    const endSeconds = Math.min(upperBound, start + duration);
    if (endSeconds - start < 5) return null;

    const rawConfidence = Number(candidate.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
    return { startSeconds: start, endSeconds, reason: reason.slice(0, 500), confidence };
}

export function parseAudioCandidates(
    parsed: unknown,
    maxCandidates = DEFAULT_MAX_AUDIO_CANDIDATES,
    maxDurationSeconds = Number.POSITIVE_INFINITY
): AudioCandidate[] {
    const limit = Number.isFinite(maxCandidates) ? Math.max(0, Math.floor(maxCandidates)) : 0;
    const candidates = extractCandidateArray(parsed)
        .map((item) => clampCandidate(item as Partial<AudioCandidate>, maxDurationSeconds))
        .filter((item): item is AudioCandidate => Boolean(item))
        .sort((left, right) => left.startSeconds - right.startSeconds);

    const nonOverlapping: AudioCandidate[] = [];
    for (const candidate of candidates) {
        const previous = nonOverlapping[nonOverlapping.length - 1];
        if (previous && candidate.startSeconds < previous.endSeconds) continue;
        nonOverlapping.push(candidate);
        if (nonOverlapping.length >= limit) break;
    }
    return nonOverlapping;
}

export function parseVideoVerificationResults(parsed: unknown, expectedCount: number): VideoVerificationResult[] {
    const count = Math.max(0, Math.floor(expectedCount));
    const results = Array.from({ length: count }, () => ({
        approved: false,
        why: 'No valid verification result returned by model.'
    }));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).results)) {
        return results;
    }

    const seenIndexes = new Set<number>();
    for (const item of (parsed as { results: unknown[] }).results) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const index = Number(raw.index);
        if (!Number.isInteger(index) || index < 0 || index >= count || seenIndexes.has(index)) continue;
        seenIndexes.add(index);
        results[index] = {
            approved: raw.approved === true,
            why: String(raw.why || '').trim().slice(0, 1000) || 'No explanation provided.'
        };
    }
    return results;
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

async function fileToBase64(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
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
        const audioFormat = resolveAudioFormat(normalizedMime);
        mediaContent = {
            type: 'input_audio',
            input_audio: { data: base64Data, format: audioFormat }
        };
    } else if (normalizedMime.startsWith('video/')) {
        mediaContent = {
            type: 'video_url',
            video_url: { url: `data:${normalizedMime};base64,${base64Data}` }
        };
    } else if (normalizedMime.startsWith('image/')) {
        mediaContent = {
            type: 'image_url',
            image_url: { url: `data:${normalizedMime};base64,${base64Data}` }
        };
    } else {
        throw new Error(`OpenRouter clip recommendations accept only audio/video/image inputs (got ${options.mimeType}).`);
    }

    const body: Record<string, unknown> = {
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

    const response = await audioFetch(OPENROUTER_CHAT_URL, {
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
        const suffix = responseText ? `: ${responseText.slice(0, 500)}` : buildEmptyBodyDiagnostic(response);
        throw new Error(`OpenRouter returned non-JSON response (HTTP ${response.status})${suffix}`);
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
    durationSeconds?: number;
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

    const candidates = parseAudioCandidates(parsed, DEFAULT_MAX_AUDIO_CANDIDATES, Number(input.durationSeconds));

    if (candidates.length === 0) {
        await logWarn({
            worker: 'clip_recommendations',
            message: 'Audio discovery returned zero candidates',
            channelID: input.channelID
        }, { channelId: input.channelID, destination: 'console' });
    } else {
        await logInfo({
            worker: 'clip_recommendations',
            message: 'Audio discovery returned candidates',
            channelID: input.channelID,
            candidateCount: candidates.length
        }, { channelId: input.channelID, destination: 'console' });
    }

    return candidates;
}

export async function verifyCandidateVideo(input: {
    videoPath: string;
    channelID: string;
    reason: string;
    startSeconds: number;
    endSeconds: number;
    modelID?: string;
}): Promise<VideoVerificationResult> {
    const result = await verifyCandidateVideosBatch({
        videos: [{
            videoPath: input.videoPath,
            reason: input.reason,
            startSeconds: input.startSeconds,
            endSeconds: input.endSeconds
        }],
        channelID: input.channelID,
        modelID: input.modelID
    });
    return result[0] || { approved: false, why: 'No verification result' };
}

export async function verifyCandidateVideosBatch(input: {
    videos: Array<{
        videoPath: string;
        reason: string;
        startSeconds: number;
        endSeconds: number;
    }>;
    channelID: string;
    modelID?: string;
}): Promise<VideoVerificationResult[]> {
    if (input.videos.length === 0) return [];

    const promptCandidates = input.videos.map((v) => ({
        reason: v.reason,
        startSeconds: v.startSeconds,
        endSeconds: v.endSeconds,
        segmentIndex: 0
    }));

    const userText = buildVideoVerificationUserPrompt(promptCandidates);

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is required for clip recommendations');
    }

    const contentParts: any[] = [
        { type: 'text', text: userText }
    ];

    for (const v of input.videos) {
        const base64 = await fileToBase64(v.videoPath);
        contentParts.push({
            type: 'video_url',
            video_url: { url: `data:video/mp4;base64,${base64}` }
        });
    }

    const body: Record<string, unknown> = {
        model: input.modelID || CLIP_RECOMMENDATION_MODEL_ID,
        messages: [
            { role: 'system', content: VIDEO_VERIFICATION_SYSTEM_PROMPT },
            { role: 'user', content: contentParts }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        user: input.channelID
    };

    const response = await videoFetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://domdimabot.com',
            'X-Title': 'DomDimaBot'
        },
        body: JSON.stringify(body)
    });

    let payload: any;
    try {
        payload = await response.json();
    } catch {
        const text = await response.text().catch(() => '');
        const suffix = text ? `: ${text.slice(0, 500)}` : buildEmptyBodyDiagnostic(response);
        throw new Error(`OpenRouter returned non-JSON (HTTP ${response.status})${suffix}`);
    }

    if (!response.ok || payload.error) {
        const msg = typeof payload.error === 'object' ? payload.error.message : payload.message;
        throw new Error(msg || `OpenRouter HTTP ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenRouter response did not include message content');
    }

    const parsed = JSON.parse(normalizeJsonText(content));

    return parseVideoVerificationResults(parsed, input.videos.length);
}
