import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import UsersSchema, { type IUsers } from '../../../schemas/users.schema.js';
import { ClipRecommendationSchema, type IClipRecommendation } from '../../../schemas/clip_recommendation.schema.js';
import { ClipRecommendationConfigSchema } from '../../../schemas/clip_recommendation_config.schema.js';
import { getAiCredits } from '../../billing.js';
import { ingestPolarSHEvent } from '../../polarsh.js';
import { getTwitchHelixUrl } from '../../links.js';
import { error as logError, info as logInfo, warn as logWarn } from '../../logger.js';
import { sendClipCompletionNotification } from './clip_recommendation_notifications.js';
import { deleteClipRecommendationPreviews } from './clip_recommendation_previews.js';
import {
    analyzeVodAudioForClipMoments,
    type AudioCandidate,
    verifyCandidateVideosBatch,
    type VideoVerificationResult
} from './openrouter_clip_recommendations.client.js';
import { CLIP_RECOMMENDATION_MODEL_ID, normalizeClipRecommendationLanguage, type ClipRecommendationLanguage } from './clip_recommendations_prompts.js';
import { decideClipRecommendationRecovery } from './clip_recommendation_recovery.js';
import type { HydratedDocument } from 'mongoose';

const BASE_CREDITS = 2750;
const BASE_MINUTES = 60;
const EXTRA_CREDITS_PER_MINUTE = 50;
const AUDIO_BITRATE = '12k';
const AUDIO_SEGMENT_MINUTES = 60;
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_DOWNLOAD_TIMEOUT_MS || 3 * 60 * 60 * 1000));
const COMMAND_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_FFMPEG_TIMEOUT_MS || 30 * 60 * 1000));
const BILLING_RETRY_DELAY_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_BILLING_RETRY_DELAY_MS) || 6 * 60 * 60 * 1000);
const NOTIFICATION_RETRY_DELAY_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_NOTIFICATION_RETRY_DELAY_MS) || 60 * 60 * 1000);

export interface TwitchVodInfo {
    id: string;
    url: string;
    duration: string;
    durationMinutes: number;
    createdAt?: string;
}

export interface TwitchVodSummary {
    id: string;
    title: string;
    url: string;
    duration: string;
    durationMinutes: number;
    createdAt: string;
    thumbnailUrl: string;
}

interface TwitchVideoApiItem {
    id: string;
    user_id?: string;
    title?: string;
    url: string;
    duration?: string;
    created_at?: string;
    thumbnail_url?: string;
}

export interface RunVodClipRecommendationInput {
    channelID: string;
    channel?: string;
    sessionID?: string;
    streamID?: string;
    vodID?: string;
    vodUrl: string;
    source: 'stream_offline' | 'manual';
    requestedBy?: string;
    queueJobID?: string;
    vodDurationMinutes?: number;
    modelID?: string;
    recoveryOnly?: boolean;
    cleanupOnly?: boolean;
    assertActive?: () => Promise<void>;
}

export interface RunVodClipRecommendationResult {
    error: boolean;
    status: 'completed' | 'failed';
    message: string;
    recommendationID?: string;
    approvedCount?: number;
    candidateCount?: number;
    retryable?: boolean;
    phase?: 'analysis' | 'billing' | 'notification';
}

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function calculateClipRecommendationCredits(durationMinutes: number): number {
    const minutes = Math.max(1, Math.ceil(Number(durationMinutes || 0)));
    return BASE_CREDITS + Math.max(0, minutes - BASE_MINUTES) * EXTRA_CREDITS_PER_MINUTE;
}

export function parseTwitchDurationMinutes(duration: string): number {
    const normalized = String(duration || '').trim();
    if (!normalized) return 0;
    const hours = Number(normalized.match(/(\d+)h/)?.[1] || 0);
    const minutes = Number(normalized.match(/(\d+)m/)?.[1] || 0);
    const seconds = Number(normalized.match(/(\d+)s/)?.[1] || 0);
    return Math.max(1, Math.ceil(hours * 60 + minutes + seconds / 60));
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let stdout = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with code ${code}. stderr=${stderr.slice(-4000)} stdout=${stdout.slice(-1000)}`));
            }
        });
    });
}

async function downloadVod(vodUrl: string, outputPath: string): Promise<void> {
    await runCommand('yt-dlp', ['--no-progress', '-S', 'res:720', '-o', outputPath, vodUrl], DOWNLOAD_TIMEOUT_MS);
}

async function extractAudioSegment(videoPath: string, audioPath: string, startSeconds: number, durationSeconds: number): Promise<void> {
    await runCommand('ffmpeg', [
        '-y',
        '-ss', String(Math.max(0, Math.floor(startSeconds))),
        '-i', videoPath,
        '-t', String(Math.max(1, Math.floor(durationSeconds))),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', AUDIO_BITRATE,
        audioPath
    ], COMMAND_TIMEOUT_MS);
}

async function cutVideoSegment(videoPath: string, outputPath: string, startSeconds: number, endSeconds: number): Promise<void> {
    const duration = Math.max(5, Math.min(60, endSeconds - startSeconds));
    await runCommand('ffmpeg', [
        '-y',
        '-ss', String(Math.max(0, startSeconds)),
        '-i', videoPath,
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath
    ], COMMAND_TIMEOUT_MS);
}

async function uploadPreviewClip(channelID: string, recommendationID: string, candidateID: string, filePath: string): Promise<{ key: string; url: string }> {
    const { BUCKET, getS3PublicObjectUrl, s3Client } = await import('../../s3.js');
    const key = `clip-recommendations/${channelID}/${recommendationID}/${candidateID}.mp4`;
    const body = await fs.readFile(filePath);
    await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: 'video/mp4',
        ACL: 'public-read',
        CacheControl: 'private, max-age=86400'
    }));
    return { key, url: getS3PublicObjectUrl(key) };
}

async function findUserByChannelID(channelID: string): Promise<IUsers | null> {
    return UsersSchema.findOne({ accounts: { $elemMatch: { id: channelID, type: 'twitch' } } }).lean().exec();
}

async function ensureCreditsAvailable(user: IUsers, channelID: string, credits: number): Promise<void> {
    const currentCredits = await getAiCredits(user, channelID);
    if (currentCredits.balance < credits) {
        throw new Error(`Not enough AI credits. Required ${credits}, available ${currentCredits.balance}.`);
    }

    if (!user.polar_sh_customer_id) {
        throw new Error('A billing customer is required to charge clip recommendation credits.');
    }
}

async function chargeCredits(
    user: IUsers,
    channelID: string,
    credits: number,
    reason: string,
    externalId: string,
    verifyBalance = true
): Promise<void> {
    if (verifyBalance) await ensureCreditsAvailable(user, channelID, credits);
    const ingestResult = await ingestPolarSHEvent({
        customerId: user.polar_sh_customer_id,
        channelID,
        externalId,
        cost: credits / 1000,
        reason,
        mode: 'immediate'
    });
    if (ingestResult.error) {
        throw new Error(ingestResult.message || 'Failed to charge AI credits');
    }
}

async function chargeCompletedRecommendation(
    recommendation: HydratedDocument<IClipRecommendation>,
    user: IUsers,
    channelID: string,
    verifyBalance = true
): Promise<string | null> {
    const attemptedAt = new Date();
    recommendation.billingAttemptCount = Math.max(0, Number(recommendation.billingAttemptCount) || 0) + 1;
    recommendation.billingLastAttemptAt = attemptedAt;
    try {
        await chargeCredits(
            user,
            channelID,
            recommendation.costCredits,
            'vod_clip_recommendation',
            `clip-recommendation-charge:${recommendation.queueJobID || recommendation._id}`,
            verifyBalance
        );
        recommendation.billingStatus = 'charged';
        recommendation.chargeError = '';
        recommendation.chargedAt = new Date();
        recommendation.billingNextRetryAt = null;
        await recommendation.save();
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recommendation.billingStatus = 'failed';
        recommendation.chargeError = message.slice(0, 2000);
        recommendation.billingNextRetryAt = new Date(attemptedAt.getTime() + BILLING_RETRY_DELAY_MS);
        await recommendation.save();
        return message;
    }
}

function buildCandidateDocument(candidate: AudioCandidate) {
    return {
        startSeconds: candidate.startSeconds,
        endSeconds: candidate.endSeconds,
        reason: candidate.reason,
        audioConfidence: candidate.confidence,
        videoApproved: false,
        videoWhy: '',
        s3Key: '',
        previewUrl: '',
        status: 'pending' as const,
        twitchClipID: '',
        created_at: new Date()
    };
}

function isPayloadTooLargeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b413\b|payload|too large|request entity/i.test(message);
}

interface VerifyVideoBatchInput {
    videos: Array<{ videoPath: string; reason: string; startSeconds: number; endSeconds: number }>;
    channelID: string;
    modelID: string;
    language: ClipRecommendationLanguage;
}

async function verifyVideoBatchResilient(input: VerifyVideoBatchInput): Promise<VideoVerificationResult[]> {
    try {
        return await verifyCandidateVideosBatch(input);
    } catch (error) {
        if (input.videos.length <= 1 || !isPayloadTooLargeError(error)) throw error;
        const midpoint = Math.ceil(input.videos.length / 2);
        await logWarn({
            worker: 'clip_recommendations',
            message: 'Video verification batch rejected for payload size; halving batch',
            channelID: input.channelID,
            batchSize: input.videos.length,
            error: error instanceof Error ? error.message : String(error)
        }, { channelId: input.channelID, destination: 'console' });
        const firstHalf = await verifyVideoBatchResilient({ ...input, videos: input.videos.slice(0, midpoint) });
        const secondHalf = await verifyVideoBatchResilient({ ...input, videos: input.videos.slice(midpoint) });
        return [...firstHalf, ...secondHalf];
    }
}

async function updateLastAnalyzedAt(channelID: string): Promise<void> {
    try {
        await ClipRecommendationConfigSchema.updateOne(
            { channelID },
            { $set: { lastAnalyzedAt: new Date() }, $setOnInsert: { autoAnalyzeEnabled: false } },
            { upsert: true }
        );
    } catch (error) {
        await logWarn({
            worker: 'clip_recommendations',
            message: 'Failed to update clip recommendation completion timestamp',
            channelID,
            error: error instanceof Error ? error.message : String(error)
        }, { channelId: channelID, destination: 'console' });
    }
}

async function fetchTwitchVideos(params: URLSearchParams): Promise<TwitchVideoApiItem[]> {
    const { getTwitchAppHeader } = await import('../../header.js');
    const header = await getTwitchAppHeader();
    const response = await fetch(getTwitchHelixUrl('videos', params.toString()), {
        headers: {
            'Client-Id': header['Client-Id'],
            'Authorization': header.Authorization,
            'Content-Type': header['Content-Type']
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch Twitch VODs: HTTP ${response.status}`);
    }
    const payload = await response.json() as { data?: TwitchVideoApiItem[] };
    return payload.data ?? [];
}

function toTwitchVodSummary(item: TwitchVideoApiItem): TwitchVodSummary {
    return {
        id: item.id,
        title: String(item.title || '').trim(),
        url: item.url,
        duration: item.duration || '',
        durationMinutes: parseTwitchDurationMinutes(item.duration || ''),
        createdAt: item.created_at || '',
        thumbnailUrl: item.thumbnail_url || ''
    };
}

export async function fetchLatestVodForChannel(channelID: string): Promise<TwitchVodInfo | null> {
    const params = new URLSearchParams({ user_id: channelID, type: 'archive', first: '1' });
    const items = await fetchTwitchVideos(params);
    const vod = items[0];
    if (!vod?.url) return null;
    return {
        id: vod.id,
        url: vod.url,
        duration: vod.duration || '',
        durationMinutes: parseTwitchDurationMinutes(vod.duration || ''),
        createdAt: vod.created_at
    };
}

export async function fetchVodById(vodID: string, expectedChannelID?: string): Promise<TwitchVodInfo | null> {
    if (!vodID) return null;
    const params = new URLSearchParams({ id: vodID });
    const items = await fetchTwitchVideos(params);
    const vod = items[0];
    if (!vod?.url) return null;
    if (expectedChannelID && vod.user_id !== expectedChannelID) return null;
    return {
        id: vod.id,
        url: vod.url,
        duration: vod.duration || '',
        durationMinutes: parseTwitchDurationMinutes(vod.duration || ''),
        createdAt: vod.created_at
    };
}

export async function fetchRecentVodsForChannel(channelID: string, days = 7): Promise<TwitchVodSummary[]> {
    const params = new URLSearchParams({ user_id: channelID, type: 'archive', first: '100' });
    const items = await fetchTwitchVideos(params);
    const summaries = items.map(toTwitchVodSummary);
    if (!summaries.length) return [];

    const cutoffSeconds = Math.max(0, Math.floor((Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000) / 1000));
    return summaries.filter((vod) => {
        if (!vod.createdAt) return true;
        const createdSeconds = Math.floor(Date.parse(vod.createdAt) / 1000);
        return Number.isFinite(createdSeconds) ? createdSeconds >= cutoffSeconds : true;
    });
}

export async function runVodClipRecommendationWorkflow(input: RunVodClipRecommendationInput, {
    charge = chargeCompletedRecommendation,
    notify = sendClipCompletionNotification,
    deletePreviews = deleteClipRecommendationPreviews,
    reportError = logError
}: {
    charge?: typeof chargeCompletedRecommendation;
    notify?: typeof sendClipCompletionNotification;
    deletePreviews?: typeof deleteClipRecommendationPreviews;
    reportError?: typeof logError;
} = {}): Promise<RunVodClipRecommendationResult> {
    const channelID = normalizeValue(input.channelID);
    const vodUrl = normalizeValue(input.vodUrl);
    const modelID = normalizeValue(input.modelID) || CLIP_RECOMMENDATION_MODEL_ID;
    const queueJobID = normalizeValue(input.queueJobID);
    const recommendationID = randomUUID();
    const workDir = path.join(os.tmpdir(), `clip-recommendations-${recommendationID}`);
    let recommendationObjectID = '';
    let recommendation: HydratedDocument<IClipRecommendation> | null = null;
    let analysisPersisted = false;
    let workDirCreated = false;

    if (!channelID || !vodUrl) {
        return { error: true, status: 'failed', message: 'channelID and vodUrl are required' };
    }

    try {
        await input.assertActive?.();
        if (queueJobID) {
            recommendation = await ClipRecommendationSchema.findOne({ queueJobID }).select('+notificationPayload').exec();
            if (recommendation && recommendation.channelID !== channelID) {
                return { error: true, status: 'failed', message: 'Recommendation belongs to another channel', retryable: false };
            }
            if (input.recoveryOnly && !recommendation) {
                return { error: true, status: 'failed', message: 'Recovery recommendation no longer exists', retryable: false };
            }
            if (recommendation) {
                analysisPersisted = Boolean(recommendation.analysisCompletedAt);
                const recoveryAction = decideClipRecommendationRecovery(recommendation);
                recommendationObjectID = String(recommendation._id);
                if (input.cleanupOnly) {
                    if (recommendation.status !== 'failed' || analysisPersisted || recommendation.billingStatus === 'charged') {
                        return { error: false, status: 'completed', message: 'Preview cleanup is no longer required' };
                    }
                    await input.assertActive?.();
                    await deletePreviews(recommendation);
                    recommendation.previewCleanupPending = false;
                    recommendation.previewCleanupError = '';
                    recommendation.previewCleanupNextRetryAt = null;
                    await recommendation.save();
                    return { error: false, status: 'failed', message: 'Failed analysis previews cleaned', recommendationID: recommendationObjectID };
                }
                if (input.recoveryOnly && !analysisPersisted) {
                    return { error: true, status: 'failed', message: 'Recovery cannot restart an incomplete analysis', retryable: false };
                }
                if (recoveryAction === 'return-completed') {
                    return {
                        error: false,
                        status: 'completed',
                        message: 'Clip recommendation job was already completed',
                        recommendationID: recommendationObjectID,
                        candidateCount: recommendation.candidateCount,
                        approvedCount: recommendation.approvedCount
                    };
                }
                if (recoveryAction === 'refuse-charged') {
                    return {
                        error: true,
                        status: 'failed',
                        message: 'Recommendation is charged without a completed analysis; refusing to repeat the charge',
                        recommendationID: recommendationObjectID,
                        candidateCount: recommendation.candidateCount,
                        approvedCount: recommendation.approvedCount,
                        retryable: false,
                        phase: 'billing'
                    };
                }
                if (recoveryAction === 'retry-notification') {
                    const user = await findUserByChannelID(channelID);
                    if (!user) throw new Error('User not found for channel');
                    await input.assertActive?.();
                    await notify(recommendation, user, channelID, normalizeValue(input.channel));
                    return {
                        error: false,
                        status: 'completed',
                        message: 'Clip recommendation completion notification reconciled',
                        recommendationID: recommendationObjectID,
                        candidateCount: recommendation.candidateCount,
                        approvedCount: recommendation.approvedCount
                    };
                }
                if (recoveryAction === 'retry-billing') {
                    const user = await findUserByChannelID(channelID);
                    if (!user) throw new Error('User not found for channel');
                    await input.assertActive?.();
                    const chargeError = await charge(recommendation, user, channelID, false);
                    if (chargeError) {
                        return {
                            error: true,
                            status: 'completed',
                            message: `Clip analysis completed but billing failed: ${chargeError}`,
                            recommendationID: recommendationObjectID,
                            candidateCount: recommendation.candidateCount,
                            approvedCount: recommendation.approvedCount,
                            retryable: true,
                            phase: 'billing'
                        };
                    }
                    await updateLastAnalyzedAt(channelID);
                    await input.assertActive?.();
                    await notify(recommendation, user, channelID, normalizeValue(input.channel));
                    return {
                        error: false,
                        status: 'completed',
                        message: 'Clip recommendation billing recovered',
                        recommendationID: recommendationObjectID,
                        candidateCount: recommendation.candidateCount,
                        approvedCount: recommendation.approvedCount
                    };
                }

                await input.assertActive?.();
                await deletePreviews(recommendation);
                recommendation.status = 'pending';
                recommendation.errorMessage = '';
                recommendation.billingStatus = 'pending';
                recommendation.chargeError = '';
                recommendation.chargedAt = null;
                recommendation.analysisCompletedAt = null;
                recommendation.billingAttemptCount = 0;
                recommendation.billingLastAttemptAt = null;
                recommendation.billingNextRetryAt = null;
                recommendation.completedAt = null;
                recommendation.startedAt = null;
                recommendation.candidates = [] as any;
                recommendation.candidateCount = 0;
                recommendation.approvedCount = 0;
                recommendation.notificationStatus = 'pending';
                recommendation.notificationError = '';
                recommendation.notificationLastAttemptAt = null;
                recommendation.notificationNextRetryAt = null;
                recommendation.notifiedAt = null;
                recommendation.notificationPayload = undefined;
                recommendation.previewCleanupPending = false;
                recommendation.previewCleanupError = '';
                recommendation.previewCleanupNextRetryAt = null;
            }
        }

        if (input.recoveryOnly) {
            return { error: true, status: 'failed', message: 'Recovery requires a completed keyed recommendation', retryable: false };
        }

        const durationMinutes = Math.max(1, Math.ceil(Number(input.vodDurationMinutes || 0)));
        const costCredits = calculateClipRecommendationCredits(durationMinutes);
        await input.assertActive?.();
        if (!recommendation) {
            recommendation = await ClipRecommendationSchema.create({
                channelID,
                channel: normalizeValue(input.channel),
                sessionID: normalizeValue(input.sessionID),
                streamID: normalizeValue(input.streamID),
                vodID: normalizeValue(input.vodID),
                vodUrl,
                source: input.source,
                status: 'pending',
                requestedBy: normalizeValue(input.requestedBy),
                queueJobID: queueJobID || undefined,
                modelID,
                vodDurationMinutes: durationMinutes,
                costCredits,
                billingStatus: 'pending',
                notificationStatus: 'pending',
                candidates: []
            });
            recommendationObjectID = String(recommendation._id);
        } else {
            recommendation.channel = normalizeValue(input.channel);
            recommendation.sessionID = normalizeValue(input.sessionID);
            recommendation.streamID = normalizeValue(input.streamID);
            recommendation.vodID = normalizeValue(input.vodID);
            recommendation.vodUrl = vodUrl;
            recommendation.source = input.source;
            recommendation.requestedBy = normalizeValue(input.requestedBy);
            recommendation.modelID = modelID;
            recommendation.vodDurationMinutes = durationMinutes;
            recommendation.costCredits = costCredits;
            await recommendation.save();
        }

        const user = await findUserByChannelID(channelID);
        if (!user) {
            throw new Error('User not found for channel');
        }

        const outputLanguage = normalizeClipRecommendationLanguage(user.language);

        await ensureCreditsAvailable(user, channelID, costCredits);
        await input.assertActive?.();
        recommendation.status = 'processing';
        recommendation.startedAt = new Date();
        await recommendation.save();

        const vodPath = path.join(workDir, 'vod.mp4');
        await fs.mkdir(workDir, { recursive: true });
        workDirCreated = true;
        await downloadVod(vodUrl, vodPath);

        // Extract audio in 1-hour segments at 12 kbps to stay under OpenRouter's 8 MB upload limit.
        // We make one OpenRouter request per segment (least amount of requests possible) and
        // merge candidates back with offset-adjusted timestamps.
        const totalSeconds = Math.max(60, Math.ceil(durationMinutes * 60));
        const segmentSeconds = AUDIO_SEGMENT_MINUTES * 60;
        const segmentCount = Math.max(1, Math.ceil(totalSeconds / segmentSeconds));
        const perSegmentCandidates: AudioCandidate[][] = [];

        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
            await input.assertActive?.();
            const segmentStartSeconds = segmentIndex * segmentSeconds;
            const segmentDurationSeconds = Math.min(segmentSeconds, totalSeconds - segmentStartSeconds);
            if (segmentDurationSeconds <= 0) break;
            const segmentAudioPath = path.join(workDir, `segment-${segmentIndex}.mp3`);

            await extractAudioSegment(vodPath, segmentAudioPath, segmentStartSeconds, segmentDurationSeconds);
            const segmentCandidates = await analyzeVodAudioForClipMoments({
                audioPath: segmentAudioPath,
                channelID,
                modelID,
                durationSeconds: segmentDurationSeconds,
                segmentStartSeconds,
                language: outputLanguage
            });

            // Adjust candidate timestamps by the segment offset so they reference the full VOD timeline.
            for (const candidate of segmentCandidates) {
                candidate.startSeconds += segmentStartSeconds;
                candidate.endSeconds += segmentStartSeconds;
            }
            perSegmentCandidates.push(segmentCandidates);

            // Free disk space between segments — the segment file isn't needed anymore.
            await fs.unlink(segmentAudioPath).catch(() => undefined);

            // Persist progress so far so partial work is visible in the DB during very long VODs.
            const flatSoFar = perSegmentCandidates.flat();
            const partialDocs = flatSoFar.map(buildCandidateDocument);
            recommendation.candidates = partialDocs as any;
            recommendation.candidateCount = partialDocs.length;
            await input.assertActive?.();
            await recommendation.save();
        }

        const audioCandidates = perSegmentCandidates.flat();
        const candidateDocs = audioCandidates.map(buildCandidateDocument);
        recommendation.candidates = candidateDocs as any;
        recommendation.candidateCount = candidateDocs.length;
        await input.assertActive?.();
        await recommendation.save();

        // Fail loudly if audio analysis produced zero candidates so provider or
        // prompt failures are visible and the user is not charged for no output.
        if (audioCandidates.length === 0) {
            const message = 'Audio analysis returned zero candidates. The model may not be processing the audio input correctly (provider routing or prompt issue). No credits were charged.';
            await ClipRecommendationSchema.findByIdAndUpdate(recommendationObjectID, {
                $set: {
                    status: 'failed',
                    errorMessage: message,
                    completedAt: new Date()
                }
            }).exec();
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Audio analysis returned zero candidates',
                channelID,
                recommendationID: recommendationObjectID,
                segmentCount: perSegmentCandidates.length
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                status: 'failed',
                message,
                recommendationID: recommendationObjectID,
                candidateCount: 0,
                approvedCount: 0,
                retryable: false,
                phase: 'analysis'
            };
        }

        // Batched video verification: candidates from all audio segments are pooled and
        // verified in fixed-size batches. Short clip payloads are far below the upload
        // limits that force 1h audio segmentation, so batches can be much larger than
        // the per-segment candidate count. Oversized batches are halved automatically.
        const videoBatchSize = Math.max(1, Number(process.env.CLIP_RECOMMENDATION_VIDEO_BATCH_SIZE) || 16);
        let approvedCount = 0;

        for (let batchStart = 0; batchStart < audioCandidates.length; batchStart += videoBatchSize) {
            await input.assertActive?.();
            const batch = audioCandidates.slice(batchStart, Math.min(audioCandidates.length, batchStart + videoBatchSize));

            const videoInputs = await Promise.all(batch.map(async (candidate, localIdx) => {
                const segmentPath = path.join(workDir, `candidate-c${batchStart + localIdx}.mp4`);
                await cutVideoSegment(vodPath, segmentPath, candidate.startSeconds, candidate.endSeconds);
                return {
                    videoPath: segmentPath,
                    reason: candidate.reason,
                    startSeconds: candidate.startSeconds,
                    endSeconds: candidate.endSeconds
                };
            }));

            const verifications = await verifyVideoBatchResilient({
                videos: videoInputs,
                channelID,
                modelID,
                language: outputLanguage
            });

            for (let localIdx = 0; localIdx < batch.length; localIdx += 1) {
                const candidateDoc = recommendation.candidates[batchStart + localIdx];
                const verification = verifications[localIdx] || { approved: false, why: 'No result' };

                candidateDoc.videoApproved = verification.approved;
                candidateDoc.videoWhy = verification.why;
                candidateDoc.status = verification.approved ? 'approved' : 'rejected';

                if (verification.approved) {
                    await input.assertActive?.();
                    const segmentPath = videoInputs[localIdx].videoPath;
                    const candidateID = String(candidateDoc._id || randomUUID());
                    const upload = await uploadPreviewClip(channelID, recommendationObjectID, candidateID, segmentPath);
                    candidateDoc.s3Key = upload.key;
                    candidateDoc.previewUrl = upload.url;
                    approvedCount += 1;
                }
            }

            recommendation.approvedCount = approvedCount;
            await input.assertActive?.();
            await recommendation.save();
        }

        recommendation.status = 'completed';
        recommendation.analysisCompletedAt = new Date();
        recommendation.completedAt = recommendation.analysisCompletedAt;
        recommendation.approvedCount = approvedCount;
        await input.assertActive?.();
        await recommendation.save();
        analysisPersisted = true;

        await input.assertActive?.();
        const chargeError = await charge(recommendation, user, channelID);
        if (chargeError) {
            await reportError({
                worker: 'clip_recommendations',
                message: 'VOD clip recommendation analysis completed but billing failed',
                channelID,
                recommendationID: recommendationObjectID,
                error: chargeError
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                status: 'completed',
                message: `Clip analysis completed but billing failed: ${chargeError}`,
                recommendationID: recommendationObjectID,
                candidateCount: audioCandidates.length,
                approvedCount,
                retryable: true,
                phase: 'billing'
            };
        }

        await updateLastAnalyzedAt(channelID);

        await input.assertActive?.();
        await notify(recommendation, user, channelID, normalizeValue(input.channel));

        await logInfo({
            worker: 'clip_recommendations',
            message: 'VOD clip recommendation workflow completed',
            channelID,
            recommendationID: recommendationObjectID,
            candidateCount: audioCandidates.length,
            approvedCount,
            costCredits
        }, { channelId: channelID, destination: 'console' });

        return {
            error: false,
            status: 'completed',
            message: 'Clip recommendation workflow completed',
            recommendationID: recommendationObjectID,
            candidateCount: audioCandidates.length,
            approvedCount
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A lost lease must not rewrite or delete another worker's current work.
        await input.assertActive?.();
        const analysisCompleted = analysisPersisted;
        const billingCompleted = recommendation?.billingStatus === 'charged';
        if (recommendationObjectID && analysisCompleted && billingCompleted) {
            await ClipRecommendationSchema.findOneAndUpdate({
                _id: recommendationObjectID,
                notificationStatus: { $nin: ['sent', 'not_required'] }
            }, {
                $set: {
                    notificationStatus: 'failed',
                    notificationError: message.slice(0, 2000),
                    notificationNextRetryAt: new Date(Date.now() + NOTIFICATION_RETRY_DELAY_MS)
                }
            }).exec().catch(() => null);
        } else if (recommendationObjectID && analysisCompleted) {
            await ClipRecommendationSchema.findByIdAndUpdate(recommendationObjectID, {
                $set: {
                    billingStatus: 'failed',
                    chargeError: message.slice(0, 2000),
                    billingNextRetryAt: new Date(Date.now() + BILLING_RETRY_DELAY_MS)
                }
            }).exec().catch(() => null);
        } else if (recommendationObjectID) {
            // A final save may have committed despite response loss. Never mark
            // that completed analysis failed or remove its previews.
            const failed = await ClipRecommendationSchema.findOneAndUpdate({
                _id: recommendationObjectID, analysisCompletedAt: null, billingStatus: { $ne: 'charged' }
            }, {
                $set: {
                    status: 'failed',
                    errorMessage: message,
                    completedAt: new Date(),
                    previewCleanupPending: true,
                    previewCleanupNextRetryAt: new Date(Date.now() + NOTIFICATION_RETRY_DELAY_MS)
                }
            }, { new: true }).exec();
            if (failed) {
                try {
                    await input.assertActive?.();
                    await deletePreviews(failed);
                    failed.previewCleanupPending = false;
                    failed.previewCleanupError = '';
                    failed.previewCleanupNextRetryAt = null;
                    await input.assertActive?.();
                    await failed.save();
                } catch (cleanupError) {
                    await input.assertActive?.();
                    failed.previewCleanupError = (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).slice(0, 2000);
                    await failed.save();
                }
            }
        } else {
            await ClipRecommendationSchema.create({
                channelID,
                channel: normalizeValue(input.channel),
                sessionID: normalizeValue(input.sessionID),
                streamID: normalizeValue(input.streamID),
                vodID: normalizeValue(input.vodID),
                vodUrl,
                source: input.source,
                status: 'failed',
                requestedBy: normalizeValue(input.requestedBy),
                queueJobID: queueJobID || undefined,
                modelID,
                vodDurationMinutes: Number(input.vodDurationMinutes || 0),
                errorMessage: message,
                completedAt: new Date()
            }).catch(() => null);
        }

        await reportError({
            worker: 'clip_recommendations',
            message: 'VOD clip recommendation workflow failed',
            channelID,
            error: message,
            stack: error instanceof Error ? error.stack : undefined
        }, { channelId: channelID, destination: 'both' });

        if (analysisCompleted) {
            return {
                error: true,
                status: 'completed',
                message: `Clip analysis completed but ${billingCompleted ? 'notification' : 'billing'} recovery failed: ${message}`,
                recommendationID: recommendationObjectID,
                candidateCount: recommendation?.candidateCount,
                approvedCount: recommendation?.approvedCount,
                retryable: true,
                phase: billingCompleted ? 'notification' : 'billing'
            };
        }
        return { error: true, status: 'failed', message, retryable: true, phase: 'analysis' };
    } finally {
        if (workDirCreated) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
