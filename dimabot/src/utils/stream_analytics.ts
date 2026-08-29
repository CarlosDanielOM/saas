import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema } from '../schemas/stream_viewer_snapshot.schema.js';
import { StreamSubscriptionLedgerSchema } from '../schemas/stream_subscription_ledger.schema.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { getTwitchAppHeader } from './header.js';
import { getTwitchHelixUrl } from './links.js';
import { error as logError, info as logInfo, warn as logWarn } from './logger.js';
import { getLiveChannelsBoard } from './siteanalytics.js';
import { enqueueStreamMemorySummaryJob } from './ai/memory/stream_memory_queue.js';
import { ClipRecommendationConfigSchema } from '../schemas/clip_recommendation_config.schema.js';
import UsersSchema from '../schemas/users.schema.js';
import { enqueueClipRecommendationJob } from './ai/clip_recommendations/clip_recommendations_queue.js';

const DEFAULT_DASHBOARD_DAYS = 30;
const OFFLINE_CHECK_THRESHOLD = 2;
const SNAPSHOT_RETENTION_DAYS = 90;
const SESSION_EVENT_KEY_HISTORY_LIMIT = 10_000;
const LEDGER_EVENT_KEY_HISTORY_LIMIT = 10_000;
const RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CACHED_LIVE_BOARD_MAX_AGE_MS = Math.max(30_000, Number(process.env.STREAM_ANALYTICS_CACHED_LIVE_BOARD_MAX_AGE_MS || 60_000));

let lastRetentionCleanupAt = 0;

interface TwitchLiveStream {
    id: string;
    user_id: string;
    user_login?: string;
    user_name?: string;
    title?: string;
    game_name?: string;
    viewer_count?: number;
    started_at?: string;
}

export interface DashboardStreamHistoryPoint {
    date: string;
    viewers: number;
    hours: number;
    bits: number;
    donations: number;
    follows: number;
    subs: number;
}

export interface DashboardTrendPoint {
    date: string;
    viewers: number;
    hours: number;
}

export interface DashboardKpis {
    activeViewers: number;
    averageViewers: number;
    monthlyAverageViewers: number;
    averageHoursPerStream: number;
    totalBits: number;
    totalStreams: number;
    totalDonations: number;
    activeFollows: number;
    activeSubs: number;
    monthlyGoalSubs: number;
    subsProgressPct: number;
}

export interface LiveSessionMetrics {
    isLive: boolean;
    startedAt: string | null;
    durationMinutes: number;
    averageViewers: number;
    peakViewers: number;
    currentViewers: number;
    follows: number;
    subs: number;
    bits: number;
    donations: number;
    messages: number;
    commands: number;
}

export interface DashboardAnalyticsResult {
    kpis: DashboardKpis;
    trend: DashboardTrendPoint[];
    streamHistory: DashboardStreamHistoryPoint[];
}

interface RecordStreamOnlineInput {
    channelID: string;
    channel: string;
    streamID?: string;
    startedAt?: string | Date;
    eventKey?: string;
    reopenClosed?: boolean;
}

interface RecordStreamOfflineInput {
    channelID: string;
    endedAt?: string | Date;
    eventKey?: string;
    requireSession?: boolean;
}

function toDate(value?: string | Date): Date {
    if (!value) {
        return new Date();
    }

    if (value instanceof Date) {
        return value;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return new Date();
    }

    return parsed;
}

function roundToOneDecimal(value: number): number {
    return Number(value.toFixed(1));
}

function getDurationMinutes(startedAt: Date, endedAt: Date): number {
    const milliseconds = Math.max(0, endedAt.getTime() - startedAt.getTime());
    return roundToOneDecimal(milliseconds / 60000);
}

function toUtcDayKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function toUtcDayISO(dayKey: string): string {
    return `${dayKey}T00:00:00.000Z`;
}

function logAnalyticsError(functionName: string, payload: Record<string, unknown>): void {
    console.error(`Error in ${functionName}:`, payload);
    void logError({
        function: functionName,
        ...payload
    }, {
        destination: 'both',
        channelId: typeof payload.channelID === 'string' ? payload.channelID : undefined
    }).catch(() => undefined);
}

function toPositiveInteger(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, Math.round(parsed));
}

async function incrementSessionMetricAtEventTime(input: {
    channelID: string;
    occurredAt?: string | Date;
    eventKey?: string;
    field: 'bits' | 'subs' | 'follows';
    quantity: number;
}): Promise<void> {
    const occurredAt = toDate(input.occurredAt);
    const filter: Record<string, unknown> = {
        channelID: input.channelID,
        started_at: { $lte: occurredAt },
        $or: [
            { ended_at: null },
            { ended_at: { $gte: occurredAt } }
        ]
    };
    const update: Record<string, unknown> = { $inc: { [input.field]: input.quantity } };
    if (input.eventKey) {
        filter.applied_domain_event_keys = { $ne: input.eventKey };
        update.$push = {
            applied_domain_event_keys: {
                $each: [input.eventKey],
                $slice: -SESSION_EVENT_KEY_HISTORY_LIMIT
            }
        };
    }

    const session = await StreamSessionSchema.findOneAndUpdate(filter, update, {
        sort: { started_at: -1 },
        new: true
    }).select('_id').lean();
    if (session) {
        return;
    }
    if (input.eventKey) {
        const alreadyApplied = await StreamSessionSchema.exists({
            channelID: input.channelID,
            applied_domain_event_keys: input.eventKey
        });
        if (alreadyApplied) {
            return;
        }
        throw new Error(`No stream session contains event ${input.eventKey} at ${occurredAt.toISOString()}`);
    }
}

function normalizeSubTier(tier: unknown): 'tier1' | 'tier2' | 'tier3' | 'unknown' {
    const normalized = String(tier || '').trim().toLowerCase();
    if (normalized === 'prime' || normalized === '1000' || normalized === 'tier1') {
        return 'tier1';
    }
    if (normalized === '2000' || normalized === 'tier2') {
        return 'tier2';
    }
    if (normalized === '3000' || normalized === 'tier3') {
        return 'tier3';
    }
    return 'unknown';
}

async function enqueuePostStreamSummaryJob(input: {
    channelID: string;
    sessionID: string;
    streamID?: string;
    reason: string;
    requestedBy: string;
}): Promise<void> {
    try {
        await enqueueStreamMemorySummaryJob({
            channelID: input.channelID,
            sessionID: input.sessionID,
            streamID: input.streamID,
            reason: input.reason,
            source: 'stream_offline',
            requestedBy: input.requestedBy,
            notBeforeUnix: Math.floor(Date.now() / 1000) + 120
        });
    } catch (error) {
        logAnalyticsError('enqueuePostStreamSummaryJob', {
            channelID: input.channelID,
            sessionID: input.sessionID,
            streamID: input.streamID || '',
            reason: input.reason,
            requestedBy: input.requestedBy,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}

async function enqueueAutomaticClipRecommendationJob(input: {
    channelID: string;
    channel?: string;
    sessionID: string;
    streamID?: string;
    durationMinutes?: number;
}): Promise<void> {
    try {
        const [config, user] = await Promise.all([
            ClipRecommendationConfigSchema.findOne({ channelID: input.channelID }).lean().exec(),
            UsersSchema.findOne({ 'accounts.id': input.channelID, 'accounts.type': 'twitch' }).lean().exec()
        ]);

        if (!config?.autoAnalyzeEnabled || user?.plan_tier !== 'pro') {
            return;
        }

        const result = await enqueueClipRecommendationJob({
            channelID: input.channelID,
            channel: input.channel,
            sessionID: input.sessionID,
            streamID: input.streamID,
            vodUrl: `twitch-latest:${input.channelID}`,
            source: 'stream_offline',
            requestedBy: 'recordStreamOfflineEvent',
            vodDurationMinutes: input.durationMinutes || 60,
            notBeforeUnix: Math.floor(Date.now() / 1000) + 300
        });

        await logInfo({
            function: 'enqueueAutomaticClipRecommendationJob',
            message: result.message,
            channelID: input.channelID,
            sessionID: input.sessionID,
            streamID: input.streamID || '',
            enqueued: result.enqueued
        }, { channelId: input.channelID, destination: 'both' });
    } catch (error) {
        logAnalyticsError('enqueueAutomaticClipRecommendationJob', {
            channelID: input.channelID,
            sessionID: input.sessionID,
            streamID: input.streamID || '',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}

function chunkArray<T>(items: T[], size: number): T[][] {
    if (size <= 0) {
        return [items];
    }

    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

async function reconcileLiveSessionsFromCachedBoard(reason: string): Promise<{ recovered: number; boardLiveCount: number }> {
    try {
        const liveChannels = await getLiveChannelsBoard({
            requireFresh: true,
            maxAgeMs: CACHED_LIVE_BOARD_MAX_AGE_MS
        });

        if (!liveChannels.length) {
            return { recovered: 0, boardLiveCount: 0 };
        }

        const existingLiveSessions = await StreamSessionSchema.find({
            status: 'live',
            ended_at: null,
            channelID: { $in: liveChannels.map((channel) => channel.channelID) }
        }).select('channelID stream_id').lean();

        const existingByChannelID = new Map(
            existingLiveSessions.map((session) => [String(session.channelID), String(session.stream_id || '')])
        );

        let recovered = 0;

        for (const liveChannel of liveChannels) {
            const activeStreamID = existingByChannelID.get(liveChannel.channelID) || '';
            if (activeStreamID === String(liveChannel.streamId || '')) {
                continue;
            }

            await recordStreamOnlineEvent({
                channelID: liveChannel.channelID,
                channel: liveChannel.channel,
                streamID: liveChannel.streamId || undefined,
                startedAt: liveChannel.startedAt || undefined
            });
            recovered += 1;
        }

        if (recovered > 0) {
            await logInfo({
                worker: 'stream_analytics',
                message: 'Recovered live stream sessions from cached live board',
                reason,
                recovered,
                boardLiveCount: liveChannels.length,
                maxAgeMs: CACHED_LIVE_BOARD_MAX_AGE_MS
            }, { destination: 'console' });
        }

        return {
            recovered,
            boardLiveCount: liveChannels.length
        };
    } catch (error) {
        await logError({
            worker: 'stream_analytics',
            function: 'reconcileLiveSessionsFromCachedBoard',
            message: 'Failed reconciling live sessions from cached live board',
            reason,
            maxAgeMs: CACHED_LIVE_BOARD_MAX_AGE_MS,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        }, { destination: 'console' });

        return { recovered: 0, boardLiveCount: 0 };
    }
}

async function fetchLiveStreamsByChannelIds(channelIDs: string[]): Promise<Map<string, TwitchLiveStream>> {
    const liveByChannelID = new Map<string, TwitchLiveStream>();
    const uniqueChannelIDs = Array.from(new Set(channelIDs.filter((id) => Boolean(id))));

    if (!uniqueChannelIDs.length) {
        return liveByChannelID;
    }

    try {
        const appHeader = await getTwitchAppHeader();

        const batches = chunkArray(uniqueChannelIDs, 100);
        for (const batch of batches) {
            const params = new URLSearchParams({ type: 'live' });
            for (const channelID of batch) {
                params.append('user_id', channelID);
            }

            const response = await fetch(getTwitchHelixUrl('streams', params.toString()), {
                headers: {
                    'Client-Id': appHeader['Client-Id'],
                    'Authorization': appHeader.Authorization,
                    'Content-Type': appHeader['Content-Type']
                }
            });

            if (!response.ok) {
                await logWarn({
                    worker: 'stream_analytics',
                    function: 'fetchLiveStreamsByChannelIds',
                    message: 'Helix streams request returned non-OK response',
                    batchSize: batch.length,
                    status: response.status,
                    statusText: response.statusText
                }, { destination: 'console' });
                continue;
            }

            const data = await response.json();
            const streams = Array.isArray(data?.data) ? data.data as TwitchLiveStream[] : [];
            for (const stream of streams) {
                if (!stream.user_id) {
                    continue;
                }
                liveByChannelID.set(stream.user_id, stream);
            }
        }
    } catch (error) {
        await logError({
            worker: 'stream_analytics',
            function: 'fetchLiveStreamsByChannelIds',
            message: 'Failed fetching live streams from Helix',
            channelIDsCount: uniqueChannelIDs.length,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { destination: 'console' });
    }

    return liveByChannelID;
}

const MAX_SESSION_CREATE_RETRIES = 2;

async function executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    channelID: string,
    streamID?: string,
    retries: number = MAX_SESSION_CREATE_RETRIES
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;
            console.error(`recordStreamOnlineEvent: ${operationName} failed (attempt ${attempt}/${retries + 1})`, {
                channelID,
                streamID,
                error: lastError.message,
                attempt
            });

            if (attempt <= retries) {
                await new Promise(resolve => setTimeout(resolve, 100 * attempt));
            }
        }
    }

    throw lastError || new Error(`${operationName} failed after ${retries + 1} attempts`);
}

export async function recordStreamOnlineEvent(input: RecordStreamOnlineInput): Promise<void> {
    const { channelID, channel } = input;

    if (!channelID) {
        console.warn('recordStreamOnlineEvent: channelID is empty, returning early');
        return;
    }

    const startedAt = toDate(input.startedAt);
    const streamID = input.streamID || `stream-${channelID}-${startedAt.getTime()}`;

    console.log('recordStreamOnlineEvent: Starting', { channelID, streamID, startedAt: startedAt.toISOString() });

    try {
        // Check for existing live session with retry
        const existingLive = await executeWithRetry(
            () => StreamSessionSchema.findOne({
                channelID,
                status: 'live',
                ended_at: null
            }).sort({ started_at: -1 }).lean(),
            'findExistingLiveSession',
            channelID,
            streamID
        );

        if (existingLive && existingLive.stream_id === streamID) {
            console.log('recordStreamOnlineEvent: Updating existing live session', { channelID, streamID });
            await executeWithRetry(
                () => StreamSessionSchema.updateOne(
                    { _id: existingLive._id },
                    {
                        $set: {
                            channel,
                            last_seen_live_at: new Date(),
                            consecutive_offline_checks: 0,
                            status: 'live',
                            ended_at: null
                        },
                        ...(input.eventKey ? { $addToSet: { applied_domain_event_keys: input.eventKey } } : {})
                    }
                ),
                'updateExistingSession',
                channelID,
                streamID
            );
            console.log('recordStreamOnlineEvent: Session updated successfully', { channelID, streamID });
            return;
        }

        if (existingLive && existingLive.stream_id !== streamID) {
            const existingStartedAt = new Date(existingLive.started_at);
            if (startedAt <= existingStartedAt) {
                const historicalUpdate: Record<string, unknown> = {
                    $setOnInsert: {
                        channelID,
                        stream_id: streamID,
                        started_at: startedAt,
                        ended_at: existingStartedAt,
                        status: 'orphaned',
                        channel,
                        peak_viewers: 0,
                        average_viewers: 0,
                        sample_count: 0,
                        sample_total_viewers: 0,
                        duration_minutes: getDurationMinutes(startedAt, existingStartedAt),
                        follows: 0,
                        subs: 0,
                        bits: 0,
                        donations: 0,
                        messages: 0,
                        commands: 0
                    }
                };
                if (input.eventKey) {
                    historicalUpdate.$addToSet = { applied_domain_event_keys: input.eventKey };
                }
                await StreamSessionSchema.updateOne(
                    { channelID, stream_id: streamID },
                    historicalUpdate,
                    { upsert: true }
                );
                return;
            }
            console.log('recordStreamOnlineEvent: New stream detected, orphaning old session', {
                channelID,
                oldStreamID: existingLive.stream_id,
                newStreamID: streamID
            });
            const orphanResult = await executeWithRetry(
                () => StreamSessionSchema.updateOne(
                    { _id: existingLive._id, status: 'live', ended_at: null },
                    {
                        $set: {
                            ended_at: startedAt,
                            status: 'orphaned',
                            duration_minutes: getDurationMinutes(existingLive.started_at, startedAt)
                        }
                    }
                ),
                'orphanOldSession',
                channelID,
                streamID
            );
            if (orphanResult.modifiedCount === 0) {
                throw new Error(`Live session changed while applying stream.online for ${channelID}`);
            }

            await enqueuePostStreamSummaryJob({
                channelID,
                sessionID: String(existingLive._id),
                streamID: String(existingLive.stream_id || ''),
                reason: 'superseded_live_session',
                requestedBy: 'recordStreamOnlineEvent'
            });
        }

        const existingStream = await StreamSessionSchema.findOne({
            channelID,
            stream_id: streamID
        }).select('status ended_at').lean();
        if (existingStream && existingStream.status !== 'live' && input.reopenClosed === false) {
            return;
        }

        console.log('recordStreamOnlineEvent: Creating new session', { channelID, streamID });
        const sessionUpdate: Record<string, unknown> = {
            $setOnInsert: {
                channelID,
                stream_id: streamID,
                started_at: startedAt,
                peak_viewers: 0,
                average_viewers: 0,
                sample_count: 0,
                sample_total_viewers: 0,
                duration_minutes: 0,
                follows: 0,
                subs: 0,
                bits: 0,
                donations: 0,
                messages: 0,
                commands: 0
            },
            $set: {
                channel,
                status: 'live',
                ended_at: null,
                last_seen_live_at: new Date(),
                consecutive_offline_checks: 0
            }
        };
        if (input.eventKey) {
            sessionUpdate.$addToSet = { applied_domain_event_keys: input.eventKey };
        }
        await executeWithRetry(
            () => StreamSessionSchema.findOneAndUpdate(
                { channelID, stream_id: streamID },
                sessionUpdate,
                { upsert: true, new: true }
            ),
            'createSession',
            channelID,
            streamID
        );

        console.log('recordStreamOnlineEvent: Session created successfully', { channelID, streamID });
    } catch (error) {
        console.error('recordStreamOnlineEvent: All retries exhausted, session creation failed', {
            channelID,
            streamID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

async function executeOfflineWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    channelID: string,
    retries: number = MAX_SESSION_CREATE_RETRIES
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;
            console.error(`recordStreamOfflineEvent: ${operationName} failed (attempt ${attempt}/${retries + 1})`, {
                channelID,
                error: lastError.message,
                attempt
            });

            if (attempt <= retries) {
                await new Promise(resolve => setTimeout(resolve, 100 * attempt));
            }
        }
    }

    throw lastError || new Error(`${operationName} failed after ${retries + 1} attempts`);
}

export async function recordStreamOfflineEvent(input: RecordStreamOfflineInput): Promise<void> {
    const { channelID } = input;
    if (!channelID) {
        console.warn('recordStreamOfflineEvent: channelID is empty, returning early');
        return;
    }

    const endedAt = toDate(input.endedAt);
    console.log('recordStreamOfflineEvent: Starting', { channelID, endedAt: endedAt.toISOString() });

    try {
        const activeSession = await executeOfflineWithRetry(
            () => StreamSessionSchema.findOne({
                channelID,
                started_at: { $lte: endedAt },
                $or: [
                    { ended_at: null },
                    { ended_at: { $gte: endedAt } }
                ]
            }).sort({ started_at: -1 }).lean(),
            'findActiveSession',
            channelID
        );

        if (!activeSession) {
            if (input.eventKey) {
                const alreadyApplied = await StreamSessionSchema.exists({
                    channelID,
                    applied_domain_event_keys: input.eventKey
                });
                if (alreadyApplied) {
                    return;
                }
            }
            if (input.requireSession) {
                throw new Error(`No stream session contains the offline event time for channel ${channelID}`);
            }
            console.warn('recordStreamOfflineEvent: No active session found for channel', { channelID });
            return;
        }

        console.log('recordStreamOfflineEvent: Marking session as offline', {
            channelID,
            sessionID: String(activeSession._id),
            streamID: String(activeSession.stream_id)
        });

        const offlineUpdate: Record<string, unknown> = {
            $set: {
                ended_at: endedAt,
                status: 'offline',
                duration_minutes: getDurationMinutes(activeSession.started_at, endedAt),
                consecutive_offline_checks: 0
            }
        };
        if (input.eventKey) {
            offlineUpdate.$addToSet = { applied_domain_event_keys: input.eventKey };
        }
        const offlineResult = await executeOfflineWithRetry(
            () => StreamSessionSchema.updateOne(
                {
                    _id: activeSession._id,
                    ...(input.eventKey ? { applied_domain_event_keys: { $ne: input.eventKey } } : {})
                },
                offlineUpdate
            ),
            'markSessionOffline',
            channelID
        );
        if (input.eventKey && offlineResult.modifiedCount === 0) {
            return;
        }

        console.log('recordStreamOfflineEvent: Session marked offline, enqueuing summary job', {
            channelID,
            sessionID: String(activeSession._id),
            streamID: String(activeSession.stream_id)
        });

        await enqueuePostStreamSummaryJob({
            channelID,
            sessionID: String(activeSession._id),
            streamID: String(activeSession.stream_id || ''),
            reason: 'stream_offline',
            requestedBy: 'recordStreamOfflineEvent'
        });

        await enqueueAutomaticClipRecommendationJob({
            channelID,
            channel: String(activeSession.channel || ''),
            sessionID: String(activeSession._id),
            streamID: String(activeSession.stream_id || ''),
            durationMinutes: getDurationMinutes(activeSession.started_at, endedAt)
        });

        console.log('recordStreamOfflineEvent: Post-stream jobs enqueued successfully', { channelID });
    } catch (error) {
        console.error('recordStreamOfflineEvent: All retries exhausted', {
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function recordStreamBitsEvent(input: { channelID: string; bits: number; occurredAt?: string | Date; eventKey?: string }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    const bits = toPositiveInteger(input.bits, 0);
    if (bits <= 0) {
        return;
    }

    try {
        await incrementSessionMetricAtEventTime({
            channelID,
            occurredAt: input.occurredAt,
            eventKey: input.eventKey,
            field: 'bits',
            quantity: bits
        });
    } catch (error) {
        logAnalyticsError('recordStreamBitsEvent', {
            channelID,
            bits,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function recordStreamSubEvent(input: { channelID: string; quantity?: number; tier?: string; occurredAt?: string | Date; eventKey?: string }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    const quantity = Math.max(1, toPositiveInteger(input.quantity, 1));
    const normalizedTier = normalizeSubTier(input.tier);

    try {
        await incrementSessionMetricAtEventTime({
            channelID,
            occurredAt: input.occurredAt,
            eventKey: input.eventKey,
            field: 'subs',
            quantity
        });

        if (normalizedTier === 'unknown' && input.tier) {
            await logWarn({
                worker: 'stream_analytics',
                function: 'recordStreamSubEvent',
                message: 'Unknown subscription tier while recording stream analytics',
                channelID,
                tier: input.tier,
                timestamp: new Date().toISOString()
            }, { channelId: channelID, destination: 'console' });
        }
    } catch (error) {
        logAnalyticsError('recordStreamSubEvent', {
            channelID,
            tier: input.tier || '',
            quantity,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function recordStreamFollowEvent(input: { channelID: string; occurredAt?: string | Date; eventKey?: string }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    try {
        await incrementSessionMetricAtEventTime({
            channelID,
            occurredAt: input.occurredAt,
            eventKey: input.eventKey,
            field: 'follows',
            quantity: 1
        });
    } catch (error) {
        logAnalyticsError('recordStreamFollowEvent', {
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function recordStreamDonationEvent(input: { channelID: string; amount: number }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    const amount = Math.max(0, Number(input.amount || 0));
    if (!Number.isFinite(amount) || amount <= 0) {
        return;
    }

    try {
        await StreamSessionSchema.updateOne({
            channelID,
            status: 'live',
            ended_at: null
        }, {
            $inc: { donations: amount }
        });
    } catch (error) {
        logAnalyticsError('recordStreamDonationEvent', {
            channelID,
            amount,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}

export async function recordStreamMessageEvent(input: { channelID: string; quantity?: number }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    const quantity = Math.max(1, toPositiveInteger(input.quantity, 1));

    try {
        await StreamSessionSchema.updateOne({
            channelID,
            status: 'live',
            ended_at: null
        }, {
            $inc: { messages: quantity }
        });
    } catch (error) {
        logAnalyticsError('recordStreamMessageEvent', {
            channelID,
            quantity,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}

export async function recordStreamCommandEvent(input: { channelID: string; quantity?: number }): Promise<void> {
    const channelID = String(input.channelID || '').trim();
    if (!channelID) {
        return;
    }

    const quantity = Math.max(1, toPositiveInteger(input.quantity, 1));

    try {
        await StreamSessionSchema.updateOne({
            channelID,
            status: 'live',
            ended_at: null
        }, {
            $inc: { commands: quantity }
        });
    } catch (error) {
        logAnalyticsError('recordStreamCommandEvent', {
            channelID,
            quantity,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}

export async function recordSubscriptionLedgerStart(input: {
    platform?: 'twitch';
    streamer_id: string;
    streamer_login?: string;
    streamer_name?: string;
    user_id: string;
    user_login?: string;
    user_name?: string;
    tier?: string;
    is_gift?: boolean;
    subbed_at?: string | Date;
    eventKey?: string;
}): Promise<void> {
    const streamerID = String(input.streamer_id || '').trim();
    const userID = String(input.user_id || '').trim();
    if (!streamerID || !userID) {
        return;
    }

    const platform = input.platform || 'twitch';
    const tierRaw = String(input.tier || '').trim().toLowerCase();
    const eventAt = toDate(input.subbed_at);

    try {
        if (input.eventKey) {
            const alreadyApplied = await StreamSubscriptionLedgerSchema.exists({ applied_event_keys: input.eventKey });
            if (alreadyApplied) {
                return;
            }
        }
        const latest = await StreamSubscriptionLedgerSchema.findOne({
            platform,
            streamer_id: streamerID,
            user_id: userID
        }).sort({ last_event_at: -1 }).select('_id status last_event_at').lean();
        if (latest && new Date(latest.last_event_at).getTime() > eventAt.getTime()) {
            return;
        }
        if (latest?.status === 'ended' && new Date(latest.last_event_at).getTime() >= eventAt.getTime()) {
            return;
        }
        const active = await StreamSubscriptionLedgerSchema.findOne({
            platform,
            streamer_id: streamerID,
            user_id: userID,
            status: 'active'
        }).select('_id').lean();

        if (active) {
            await StreamSubscriptionLedgerSchema.updateOne({
                _id: active._id,
                last_event_at: { $lte: eventAt },
                ...(input.eventKey ? { applied_event_keys: { $ne: input.eventKey } } : {})
            }, {
                $set: {
                    streamer_login: String(input.streamer_login || '').trim(),
                    streamer_name: String(input.streamer_name || '').trim(),
                    user_login: String(input.user_login || '').trim(),
                    user_name: String(input.user_name || '').trim(),
                    sub_tier_raw: tierRaw,
                    sub_tier_normalized: normalizeSubTier(tierRaw),
                    is_gift: Boolean(input.is_gift),
                    last_event_at: eventAt,
                    ended_at: null,
                    status: 'active',
                    event_key: input.eventKey || undefined
                },
                ...(input.eventKey ? {
                    $push: {
                        applied_event_keys: {
                            $each: [input.eventKey],
                            $slice: -LEDGER_EVENT_KEY_HISTORY_LIMIT
                        }
                    }
                } : {})
            });
            return;
        }

        await new StreamSubscriptionLedgerSchema({
            platform,
            streamer_id: streamerID,
            streamer_login: String(input.streamer_login || '').trim(),
            streamer_name: String(input.streamer_name || '').trim(),
            user_id: userID,
            user_login: String(input.user_login || '').trim(),
            user_name: String(input.user_name || '').trim(),
            sub_tier_raw: tierRaw,
            sub_tier_normalized: normalizeSubTier(tierRaw),
            is_gift: Boolean(input.is_gift),
            status: 'active',
            subbed_at: eventAt,
            ended_at: null,
            last_event_at: eventAt,
            event_key: input.eventKey || undefined,
            applied_event_keys: input.eventKey ? [input.eventKey] : []
        }).save();
    } catch (error) {
        if (input.eventKey && Number((error as { code?: unknown })?.code) === 11000) {
            const alreadyApplied = await StreamSubscriptionLedgerSchema.exists({ applied_event_keys: input.eventKey });
            if (alreadyApplied) return;
        }
        logAnalyticsError('recordSubscriptionLedgerStart', {
            channelID: streamerID,
            streamerID,
            userID,
            tierRaw,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function recordSubscriptionLedgerEnd(input: {
    platform?: 'twitch';
    streamer_id: string;
    user_id: string;
    ended_at?: string | Date;
    eventKey?: string;
}): Promise<void> {
    const streamerID = String(input.streamer_id || '').trim();
    const userID = String(input.user_id || '').trim();
    if (!streamerID || !userID) {
        return;
    }

    const platform = input.platform || 'twitch';
    const endedAt = toDate(input.ended_at);

    try {
        if (input.eventKey) {
            const alreadyApplied = await StreamSubscriptionLedgerSchema.exists({ applied_event_keys: input.eventKey });
            if (alreadyApplied) {
                return;
            }
        }

        const latest = await StreamSubscriptionLedgerSchema.findOne({
            platform,
            streamer_id: streamerID,
            user_id: userID
        }).sort({ last_event_at: -1 }).lean();

        if (latest?.status === 'active') {
            if (new Date(latest.last_event_at).getTime() > endedAt.getTime()) {
                return;
            }
            await StreamSubscriptionLedgerSchema.updateOne({
                _id: latest._id,
                last_event_at: { $lte: endedAt },
                ...(input.eventKey ? { applied_event_keys: { $ne: input.eventKey } } : {})
            }, {
                $set: {
                    status: 'ended',
                    ended_at: endedAt,
                    last_event_at: endedAt,
                    event_key: input.eventKey || undefined
                },
                ...(input.eventKey ? {
                    $push: {
                        applied_event_keys: {
                            $each: [input.eventKey],
                            $slice: -LEDGER_EVENT_KEY_HISTORY_LIMIT
                        }
                    }
                } : {})
            });
            return;
        }

        if (latest?.status === 'ended') {
            if (new Date(latest.last_event_at).getTime() >= endedAt.getTime()) {
                return;
            }
            await StreamSubscriptionLedgerSchema.updateOne({
                _id: latest._id,
                last_event_at: { $lte: endedAt },
                ...(input.eventKey ? { applied_event_keys: { $ne: input.eventKey } } : {})
            }, {
                $set: {
                    ended_at: endedAt,
                    last_event_at: endedAt,
                    event_key: input.eventKey || undefined
                },
                ...(input.eventKey ? {
                    $push: {
                        applied_event_keys: {
                            $each: [input.eventKey],
                            $slice: -LEDGER_EVENT_KEY_HISTORY_LIMIT
                        }
                    }
                } : {})
            });
            return;
        }

        await new StreamSubscriptionLedgerSchema({
            platform,
            streamer_id: streamerID,
            streamer_login: '',
            streamer_name: '',
            user_id: userID,
            user_login: '',
            user_name: '',
            sub_tier_raw: '',
            sub_tier_normalized: 'unknown',
            is_gift: false,
            status: 'ended',
            subbed_at: endedAt,
            ended_at: endedAt,
            last_event_at: endedAt,
            event_key: input.eventKey || undefined,
            applied_event_keys: input.eventKey ? [input.eventKey] : []
        }).save();
    } catch (error) {
        if (input.eventKey && Number((error as { code?: unknown })?.code) === 11000) {
            const alreadyApplied = await StreamSubscriptionLedgerSchema.exists({ applied_event_keys: input.eventKey });
            if (alreadyApplied) return;
        }
        logAnalyticsError('recordSubscriptionLedgerEnd', {
            channelID: streamerID,
            streamerID,
            userID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

export async function getLiveSessionMetrics(
    channelID: string,
    options?: { currentViewers?: number | null }
): Promise<LiveSessionMetrics | null> {
    try {
        const liveSession = await StreamSessionSchema.findOne({
            channelID,
            status: 'live',
            ended_at: null
        }).lean();

        if (!liveSession) {
            return null;
        }

        const latestSnapshot = await StreamViewerSnapshotSchema.findOne({
            channelID,
            session_id: liveSession._id
        }).sort({ captured_at: -1 }).select('viewers').lean();

        const now = new Date();
        const startedAt = new Date(liveSession.started_at);
        const durationMinutes = Math.round((now.getTime() - startedAt.getTime()) / 60000);
        const currentViewers = options?.currentViewers ?? Number(latestSnapshot?.viewers || 0);

        return {
            isLive: true,
            startedAt: liveSession.started_at.toISOString(),
            durationMinutes,
            averageViewers: Number(liveSession.average_viewers || 0),
            peakViewers: Number(liveSession.peak_viewers || 0),
            currentViewers: Math.max(0, Number(currentViewers || 0)),
            follows: Number(liveSession.follows || 0),
            subs: Number(liveSession.subs || 0),
            bits: Number(liveSession.bits || 0),
            donations: Number(liveSession.donations || 0),
            messages: Number(liveSession.messages || 0),
            commands: Number(liveSession.commands || 0)
        };
    } catch (error) {
        logAnalyticsError('getLiveSessionMetrics', {
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return null;
    }
}

export async function collectLiveViewerSnapshots(): Promise<void> {
    try {
        await reconcileLiveSessionsFromCachedBoard('snapshot_tick');

        const now = Date.now();
        if (now - lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS) {
            const retentionCutoff = new Date(now - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            await StreamViewerSnapshotSchema.deleteMany({ captured_at: { $lt: retentionCutoff } });
            lastRetentionCleanupAt = now;
        }

        const activeSessions = await StreamSessionSchema.find({
            status: 'live',
            ended_at: null
        }).select('_id channelID stream_id started_at sample_count sample_total_viewers peak_viewers messages commands').lean();

        if (!activeSessions.length) {
            return;
        }

        const liveByChannelID = await fetchLiveStreamsByChannelIds(activeSessions.map((session) => session.channelID));

        for (const session of activeSessions) {
            const liveStream = liveByChannelID.get(session.channelID) || null;

            if (liveStream) {
                const capturedAt = new Date();
                const viewers = Math.max(0, Number(liveStream.viewer_count ?? 0));

                await new StreamViewerSnapshotSchema({
                    channelID: session.channelID,
                    session_id: session._id,
                    stream_id: liveStream.id || session.stream_id,
                    captured_at: capturedAt,
                    viewers,
                    title: liveStream.title || '',
                    game_name: liveStream.game_name || '',
                    messages: Math.max(0, Number(session.messages || 0)),
                    commands: Math.max(0, Number(session.commands || 0))
                }).save();

                const nextSampleCount = Number(session.sample_count || 0) + 1;
                const nextSampleTotal = Number(session.sample_total_viewers || 0) + viewers;
                const peakViewers = Math.max(Number(session.peak_viewers || 0), viewers);

                await StreamSessionSchema.updateOne(
                    { _id: session._id },
                    {
                        $set: {
                            stream_id: liveStream.id || session.stream_id,
                            sample_count: nextSampleCount,
                            sample_total_viewers: nextSampleTotal,
                            average_viewers: Math.round(nextSampleTotal / nextSampleCount),
                            peak_viewers: peakViewers,
                            last_seen_live_at: capturedAt,
                            consecutive_offline_checks: 0
                        }
                    }
                );

                continue;
            }

            const updatedSession = await StreamSessionSchema.findOneAndUpdate(
                { _id: session._id },
                { $inc: { consecutive_offline_checks: 1 } },
                { new: true }
            );

            if (updatedSession && updatedSession.consecutive_offline_checks >= OFFLINE_CHECK_THRESHOLD) {
                const now = new Date();
                await StreamSessionSchema.updateOne(
                    { _id: updatedSession._id },
                    {
                        $set: {
                            ended_at: now,
                            status: 'orphaned',
                            duration_minutes: getDurationMinutes(updatedSession.started_at, now)
                        }
                    }
                );

                await enqueuePostStreamSummaryJob({
                    channelID: session.channelID,
                    sessionID: String(updatedSession._id),
                    streamID: String(updatedSession.stream_id || ''),
                    reason: 'orphaned_session_reconciliation',
                    requestedBy: 'collectLiveViewerSnapshots'
                });
            }
        }
    } catch (error) {
        await logError({
            worker: 'stream_analytics',
            function: 'collectLiveViewerSnapshots',
            message: 'Failed collecting live viewer snapshots',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { destination: 'console' });
    }
}

export async function reconcileLiveSessionsOnStartup(): Promise<void> {
    try {
        await reconcileLiveSessionsFromCachedBoard('startup');

        const streamerIDs = await TwitchStreamers.getTwitchStreamers();
        if (!streamerIDs.length) {
            return;
        }

        const liveByChannelID = await fetchLiveStreamsByChannelIds(streamerIDs);
        if (!liveByChannelID.size) {
            return;
        }

        for (const [channelID, stream] of liveByChannelID) {
            await recordStreamOnlineEvent({
                channelID,
                channel: stream.user_login || stream.user_name || '',
                streamID: stream.id,
                startedAt: stream.started_at
            });
        }

        await collectLiveViewerSnapshots();
    } catch (error) {
        await logError({
            worker: 'stream_analytics',
            function: 'reconcileLiveSessionsOnStartup',
            message: 'Failed reconciling live sessions on startup',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { destination: 'console' });
    }
}

export function startStreamAnalyticsWorker(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
    const run = async () => {
        await collectLiveViewerSnapshots();
    };

    run().catch((error) => {
        console.error('Error in startStreamAnalyticsWorker initial run:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    });

    return setInterval(() => {
        run().catch((error) => {
            console.error('Error in stream analytics worker tick:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });
        });
    }, intervalMs);
}

export async function getDashboardAnalytics(channelID: string, days = DEFAULT_DASHBOARD_DAYS): Promise<DashboardAnalyticsResult> {
    const now = new Date();
    const since = new Date(now);
    since.setUTCDate(now.getUTCDate() - (Math.max(days, 1) - 1));
    since.setUTCHours(0, 0, 0, 0);

    // Get completed sessions
    const sessions = await StreamSessionSchema.find({
        channelID,
        started_at: { $gte: since },
        status: { $in: ['offline', 'orphaned'] }
    }).sort({ started_at: 1 }).lean();

    const streamHistory: DashboardStreamHistoryPoint[] = sessions.map((session) => {
        const endedAt = session.ended_at ? new Date(session.ended_at) : now;
        const durationMinutes = session.duration_minutes > 0
            ? session.duration_minutes
            : getDurationMinutes(new Date(session.started_at), endedAt);

        return {
            date: new Date(session.started_at).toISOString(),
            viewers: Math.round(session.average_viewers || 0),
            hours: roundToOneDecimal(durationMinutes / 60),
            bits: Math.round(session.bits || 0),
            donations: Number((session.donations || 0).toFixed(2)),
            follows: Math.round(session.follows || 0),
            subs: Math.round(session.subs || 0)
        };
    });

    // Check for live session and add today's data if streaming
    const liveSession = await StreamSessionSchema.findOne({
        channelID,
        status: 'live',
        ended_at: null
    }).lean();

    if (liveSession) {
        const durationMinutes = getDurationMinutes(new Date(liveSession.started_at), now);
        const todayData: DashboardStreamHistoryPoint = {
            date: now.toISOString(),
            viewers: Math.round(liveSession.average_viewers || 0),
            hours: roundToOneDecimal(durationMinutes / 60),
            bits: Math.round(liveSession.bits || 0),
            donations: Number((liveSession.donations || 0).toFixed(2)),
            follows: Math.round(liveSession.follows || 0),
            subs: Math.round(liveSession.subs || 0)
        };
        streamHistory.push(todayData);
    }

    const trendByDay = new Map<string, { viewersTotal: number; viewersCount: number; hoursTotal: number }>();
    for (const point of streamHistory) {
        const dayKey = toUtcDayKey(new Date(point.date));
        const existing = trendByDay.get(dayKey) || { viewersTotal: 0, viewersCount: 0, hoursTotal: 0 };
        existing.viewersTotal += point.viewers;
        existing.viewersCount += 1;
        existing.hoursTotal += point.hours;
        trendByDay.set(dayKey, existing);
    }

    const trend = Array.from(trendByDay.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([dayKey, totals]) => ({
            date: toUtcDayISO(dayKey),
            viewers: totals.viewersCount > 0 ? Math.round(totals.viewersTotal / totals.viewersCount) : 0,
            hours: roundToOneDecimal(totals.hoursTotal)
        }));

    const totals = streamHistory.reduce((acc, point) => {
        acc.viewers += point.viewers;
        acc.hours += point.hours;
        acc.bits += point.bits;
        acc.donations += point.donations;
        acc.follows += point.follows;
        acc.subs += point.subs;
        return acc;
    }, {
        viewers: 0,
        hours: 0,
        bits: 0,
        donations: 0,
        follows: 0,
        subs: 0
    });

    const latestSnapshot = liveSession
        ? await StreamViewerSnapshotSchema.findOne({
            channelID,
            session_id: liveSession._id
        }).sort({ captured_at: -1 }).select('viewers').lean()
        : null;

    const totalStreams = streamHistory.length;
    const averageViewers = totalStreams > 0 ? Math.round(totals.viewers / totalStreams) : 0;
    const averageHoursPerStream = totalStreams > 0 ? roundToOneDecimal(totals.hours / totalStreams) : 0;
    const monthlyGoalSubs = 1000;

    return {
        kpis: {
            activeViewers: Math.round(Number(latestSnapshot?.viewers || 0)),
            averageViewers,
            monthlyAverageViewers: averageViewers,
            averageHoursPerStream,
            totalBits: Math.round(totals.bits),
            totalStreams,
            totalDonations: Number(totals.donations.toFixed(2)),
            activeFollows: Math.round(totals.follows),
            activeSubs: Math.round(totals.subs),
            monthlyGoalSubs,
            subsProgressPct: Math.min(100, Math.round((totals.subs / Math.max(monthlyGoalSubs, 1)) * 100))
        },
        trend,
        streamHistory
    };
}
