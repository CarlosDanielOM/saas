import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import UsersSchema, { type IUsers } from '../../../schemas/users.schema.js';
import { ClipRecommendationSchema } from '../../../schemas/clip_recommendation.schema.js';
import { ClipRecommendationConfigSchema } from '../../../schemas/clip_recommendation_config.schema.js';
import { getAiCredits } from '../../billing.js';
import { ingestPolarSHEvent } from '../../polarsh.js';
import { getTwitchAppHeader } from '../../header.js';
import { getTwitchHelixUrl } from '../../links.js';
import { BUCKET, getS3PublicObjectUrl, s3Client } from '../../s3.js';
import { error as logError, info as logInfo, warn as logWarn } from '../../logger.js';
import { sendEmail, DASHBOARD_URL } from '../../email/email.service.js';
import { VodClipAnalysisFinishedEmail, getVodClipAnalysisFinishedSubject } from '../../email/templates/vod-clip-analysis-finished.js';
import {
    analyzeVodAudioForClipMoments,
    type AudioCandidate,
    verifyCandidateVideosBatch
} from './openrouter_clip_recommendations.client.js';
import { CLIP_RECOMMENDATION_MODEL_ID } from './clip_recommendations_prompts.js';

const BASE_CREDITS = 2750;
const BASE_MINUTES = 60;
const EXTRA_CREDITS_PER_MINUTE = 50;
const AUDIO_BITRATE = '12k';
const AUDIO_SEGMENT_MINUTES = 60;
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_DOWNLOAD_TIMEOUT_MS || 3 * 60 * 60 * 1000));
const COMMAND_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLIP_RECOMMENDATION_FFMPEG_TIMEOUT_MS || 30 * 60 * 1000));

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
}

export interface RunVodClipRecommendationResult {
    error: boolean;
    status: 'completed' | 'failed';
    message: string;
    recommendationID?: string;
    approvedCount?: number;
    candidateCount?: number;
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
    return UsersSchema.findOne({ 'accounts.id': channelID, 'accounts.type': 'twitch' }).lean().exec();
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

async function chargeCredits(user: IUsers, channelID: string, credits: number, reason: string): Promise<void> {
    await ensureCreditsAvailable(user, channelID, credits);
    const ingestResult = await ingestPolarSHEvent({
        customerId: user.polar_sh_customer_id,
        channelID,
        cost: credits / 1000,
        reason,
        mode: 'immediate'
    });
    if (ingestResult.error) {
        throw new Error(ingestResult.message || 'Failed to charge AI credits');
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

async function notifyFinished(input: {
    user: IUsers;
    channelID: string;
    channel: string;
    approvedCount: number;
    recommendationID: string;
}): Promise<void> {
    const account = input.user.accounts.find((item) => item.type === 'twitch' && item.id === input.channelID);
    const email = account?.email || input.user.email;
    if (!email) return;
    const dashboardUrl = `${DASHBOARD_URL}/${encodeURIComponent(input.channel || input.channelID)}/modules/clip-recommendations`;
    await sendEmail({
        to: email,
        subject: getVodClipAnalysisFinishedSubject(input.user.language || 'en'),
        emailComponent: VodClipAnalysisFinishedEmail({
            streamerName: input.channel || account?.name || input.user.name || 'streamer',
            approvedCount: input.approvedCount,
            dashboardUrl,
            language: input.user.language || 'en'
        })
    });
}

async function fetchTwitchVideos(params: URLSearchParams): Promise<TwitchVideoApiItem[]> {
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

export async function runVodClipRecommendationWorkflow(input: RunVodClipRecommendationInput): Promise<RunVodClipRecommendationResult> {
    const channelID = normalizeValue(input.channelID);
    const vodUrl = normalizeValue(input.vodUrl);
    const modelID = normalizeValue(input.modelID) || CLIP_RECOMMENDATION_MODEL_ID;
    const queueJobID = normalizeValue(input.queueJobID);
    const recommendationID = randomUUID();
    const workDir = path.join(os.tmpdir(), `clip-recommendations-${recommendationID}`);
    let recommendationObjectID = '';

    if (!channelID || !vodUrl) {
        return { error: true, status: 'failed', message: 'channelID and vodUrl are required' };
    }

    try {
        await fs.mkdir(workDir, { recursive: true });
        if (queueJobID) {
            const existing = await ClipRecommendationSchema.findOne({ queueJobID }).lean().exec();
            if (existing) {
                const completed = existing.status === 'completed';
                return {
                    error: !completed,
                    status: completed ? 'completed' : 'failed',
                    message: completed
                        ? 'Clip recommendation job was already completed'
                        : `Clip recommendation job was already claimed with status ${existing.status}; refusing duplicate execution`,
                    recommendationID: String(existing._id),
                    candidateCount: existing.candidateCount,
                    approvedCount: existing.approvedCount
                };
            }
        }

        const durationMinutes = Math.max(1, Math.ceil(Number(input.vodDurationMinutes || 0)));
        const costCredits = calculateClipRecommendationCredits(durationMinutes);
        const recommendation = await ClipRecommendationSchema.create({
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
            candidates: []
        });
        recommendationObjectID = String(recommendation._id);

        const user = await findUserByChannelID(channelID);
        if (!user) {
            throw new Error('User not found for channel');
        }

        await ensureCreditsAvailable(user, channelID, costCredits);
        recommendation.status = 'processing';
        recommendation.startedAt = new Date();
        await recommendation.save();

        const vodPath = path.join(workDir, 'vod.mp4');
        await downloadVod(vodUrl, vodPath);

        // Extract audio in 1-hour segments at 12 kbps to stay under OpenRouter's 8 MB upload limit.
        // We make one OpenRouter request per segment (least amount of requests possible) and
        // merge candidates back with offset-adjusted timestamps.
        const totalSeconds = Math.max(60, Math.ceil(durationMinutes * 60));
        const segmentSeconds = AUDIO_SEGMENT_MINUTES * 60;
        const segmentCount = Math.max(1, Math.ceil(totalSeconds / segmentSeconds));
        const perSegmentCandidates: AudioCandidate[][] = [];

        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
            const segmentStartSeconds = segmentIndex * segmentSeconds;
            const segmentDurationSeconds = Math.min(segmentSeconds, totalSeconds - segmentStartSeconds);
            if (segmentDurationSeconds <= 0) break;
            const segmentAudioPath = path.join(workDir, `segment-${segmentIndex}.mp3`);

            await extractAudioSegment(vodPath, segmentAudioPath, segmentStartSeconds, segmentDurationSeconds);
            const segmentCandidates = await analyzeVodAudioForClipMoments({
                audioPath: segmentAudioPath,
                channelID,
                modelID,
                durationSeconds: segmentDurationSeconds
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
            await recommendation.save();
        }

        const audioCandidates = perSegmentCandidates.flat();
        const candidateDocs = audioCandidates.map(buildCandidateDocument);
        recommendation.candidates = candidateDocs as any;
        recommendation.candidateCount = candidateDocs.length;
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
                approvedCount: 0
            };
        }

        // Batched video verification: one request per segment, passing all clips from that segment together.
        let approvedCount = 0;
        let globalIndex = 0;

        for (let segmentIndex = 0; segmentIndex < perSegmentCandidates.length; segmentIndex += 1) {
            const segCands = perSegmentCandidates[segmentIndex];
            if (segCands.length === 0) continue;

            // Extract video clips for this segment's candidates.
            const videoInputs = await Promise.all(segCands.map(async (candidate, localIdx) => {
                const candidateID = String(recommendation.candidates[globalIndex + localIdx]._id || randomUUID());
                const segmentPath = path.join(workDir, `candidate-seg${segmentIndex}-c${localIdx}.mp4`);
                await cutVideoSegment(vodPath, segmentPath, candidate.startSeconds, candidate.endSeconds);
                return {
                    videoPath: segmentPath,
                    reason: candidate.reason,
                    startSeconds: candidate.startSeconds,
                    endSeconds: candidate.endSeconds
                };
            }));

            const verifications = await verifyCandidateVideosBatch({
                videos: videoInputs,
                channelID,
                modelID
            });

            for (let localIdx = 0; localIdx < segCands.length; localIdx += 1) {
                const candidateDoc = recommendation.candidates[globalIndex + localIdx];
                const verification = verifications[localIdx] || { approved: false, why: 'No result' };

                candidateDoc.videoApproved = verification.approved;
                candidateDoc.videoWhy = verification.why;
                candidateDoc.status = verification.approved ? 'approved' : 'rejected';

                if (verification.approved) {
                    const segmentPath = videoInputs[localIdx].videoPath;
                    const candidateID = String(candidateDoc._id || randomUUID());
                    const upload = await uploadPreviewClip(channelID, recommendationObjectID, candidateID, segmentPath);
                    candidateDoc.s3Key = upload.key;
                    candidateDoc.previewUrl = upload.url;
                    approvedCount += 1;
                }
            }

            globalIndex += segCands.length;
            recommendation.approvedCount = approvedCount;
            await recommendation.save();
        }

        await chargeCredits(user, channelID, costCredits, 'vod_clip_recommendation');
        recommendation.status = 'completed';
        recommendation.completedAt = new Date();
        recommendation.approvedCount = approvedCount;
        await recommendation.save();

        await ClipRecommendationConfigSchema.updateOne(
            { channelID },
            { $set: { lastAnalyzedAt: new Date() }, $setOnInsert: { autoAnalyzeEnabled: false } },
            { upsert: true }
        );

        await notifyFinished({
            user,
            channelID,
            channel: normalizeValue(input.channel),
            approvedCount,
            recommendationID: recommendationObjectID
        }).catch(async (error) => {
            await logWarn({
                worker: 'clip_recommendations',
                message: 'Failed to send clip recommendation completion email',
                channelID,
                error: error instanceof Error ? error.message : String(error)
            }, { channelId: channelID, destination: 'console' });
        });

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
        if (recommendationObjectID) {
            await ClipRecommendationSchema.findByIdAndUpdate(recommendationObjectID, {
                $set: {
                    status: 'failed',
                    errorMessage: message,
                    completedAt: new Date()
                }
            }).exec();
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

        await logError({
            worker: 'clip_recommendations',
            message: 'VOD clip recommendation workflow failed',
            channelID,
            error: message,
            stack: error instanceof Error ? error.stack : undefined
        }, { channelId: channelID, destination: 'both' });

        return { error: true, status: 'failed', message };
    } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
