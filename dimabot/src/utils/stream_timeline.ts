import { Types } from 'mongoose';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema } from '../schemas/stream_viewer_snapshot.schema.js';
import { StreamParticipantSchema, StreamMarkerSchema } from '../schemas/stream_timeline.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import type { IRedemptionEvent } from '../interfaces/twitch/eventsub.interface.js';

const DAY = 86400000;
export const TIMELINE_RETENTION_MS = 90 * DAY;
export const TIMELINE_BUCKET_MS = 5 * 60000;
const MAX_ROWS = 2000;

export async function recordTimelineParticipant(channelID: string, sessionID: Types.ObjectId, startedAt: Date, userID: string, at: Date): Promise<void> {
    if (!userID || userID === '698614112' || at < startedAt) return;
    const bucket = Math.floor((at.getTime() - startedAt.getTime()) / TIMELINE_BUCKET_MS);
    try {
        await StreamParticipantSchema.updateOne({ channelID, session_id: sessionID, bucket, user_id: userID }, {
            $setOnInsert: { expiresAt: new Date(at.getTime() + TIMELINE_RETENTION_MS) }
        }, { upsert: true });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
    }
    // Publish coverage only after the participant receipt succeeds.
    await StreamSessionSchema.updateOne({ _id: sessionID, channelID }, { $min: { chat_tracking_started_at: at } });
}

export async function recordTimelineRedemption(event: IRedemptionEvent): Promise<void> {
    const at = new Date(event.redeemed_at);
    if (!Number.isFinite(at.getTime()) || !event.id) return;
    const session = await StreamSessionSchema.findOne({ channelID: event.broadcaster_user_id, started_at: { $lte: at },
        $or: [{ ended_at: { $gt: at } }, { ended_at: null }] }).select('_id').lean();
    if (!session) return;
    try {
        await StreamMarkerSchema.updateOne({ channelID: event.broadcaster_user_id, session_id: session._id, key: `redemption:${event.id}` }, {
            $setOnInsert: { kind: 'redemption', label: event.reward.title.slice(0, 120), occurredAt: at, expiresAt: new Date(at.getTime() + TIMELINE_RETENTION_MS) }
        }, { upsert: true });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
    }
}

export async function listTimelineStreams(channelID: string, page: number) {
    const query = { channelID, started_at: { $gte: new Date(Date.now() - TIMELINE_RETENTION_MS) } };
    const rows = await StreamSessionSchema.find(query).sort({ started_at: -1 }).skip((page - 1) * 20).limit(21)
        .select('_id started_at ended_at status peak_viewers messages').maxTimeMS(3000).lean();
    return { streams: rows.slice(0, 20).map(row => ({ id: String(row._id), startedAt: row.started_at, endedAt: row.ended_at, status: row.status })), page, hasMore: rows.length > 20 };
}

export async function getTimelineSession(channelID: string, sessionID: string) {
    return StreamSessionSchema.findOne({ _id: sessionID, channelID, started_at: { $gte: new Date(Date.now() - TIMELINE_RETENTION_MS) } }).lean();
}

export async function getStreamTimeline(channelID: string, sessionID: string) {
    const session = await getTimelineSession(channelID, sessionID);
    if (!session) return null;
    const now = new Date();
    const end = session.ended_at || now;
    const timeQuery = { $gte: session.started_at, $lte: end };
    const [snapshots, raids, markers, participants] = await Promise.all([
        StreamViewerSnapshotSchema.find({ channelID, session_id: session._id, captured_at: timeQuery })
            .sort({ captured_at: 1 }).limit(MAX_ROWS + 1).maxTimeMS(3000).lean(),
        DomainEventSchema.find({ channelID, source: 'twitch-eventsub', type: 'channel.raid.received', occurredAt: timeQuery, expiresAt: { $gt: now } })
            .sort({ occurredAt: 1 }).limit(MAX_ROWS + 1).select('occurredAt payload').maxTimeMS(3000).lean(),
        StreamMarkerSchema.find({ channelID, session_id: session._id, expiresAt: { $gt: now } })
            .sort({ occurredAt: 1 }).limit(MAX_ROWS + 1).maxTimeMS(3000).lean(),
        StreamParticipantSchema.aggregate<{ _id: number; count: number }>([
            { $match: { channelID, session_id: session._id, expiresAt: { $gt: now } } },
            { $group: { _id: '$bucket', count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: MAX_ROWS + 1 }
        ]).option({ maxTimeMS: 3000 })
    ]);
    const offset = (at: Date) => Math.max(0, (at.getTime() - session.started_at.getTime()) / 1000);
    const events: { id: string; kind: string; offsetSeconds: number; label: string; value?: number }[] = [];
    const points = snapshots.slice(0, MAX_ROWS).map((row, index) => {
        const previous = snapshots[index - 1];
        const seconds = (row.captured_at.getTime() - (previous?.captured_at || session.started_at).getTime()) / 1000;
        const delta = row.messages - (previous?.messages || 0);
        if (previous && row.game_name !== previous.game_name) events.push({ id: `game:${row._id}`, kind: 'game', offsetSeconds: offset(row.captured_at), label: row.game_name });
        if (previous && row.title !== previous.title) events.push({ id: `title:${row._id}`, kind: 'title', offsetSeconds: offset(row.captured_at), label: row.title });
        return { offsetSeconds: offset(row.captured_at), viewers: row.viewers,
            messagesPerMinute: seconds > 0 && delta >= 0 ? Math.round(delta / seconds * 600) / 10 : null,
            gap: Boolean(previous && seconds > 600), title: row.title, game: row.game_name };
    });
    for (const row of raids.slice(0, MAX_ROWS)) {
        const event = row.payload.event as Record<string, unknown> | undefined;
        events.push({ id: `raid:${row._id}`, kind: 'raid', offsetSeconds: offset(row.occurredAt),
            label: String(event?.from_broadcaster_user_name || event?.from_broadcaster_user_login || ''), value: Math.max(0, Number(event?.viewers) || 0) });
    }
    for (const row of markers.slice(0, MAX_ROWS)) events.push({ id: String(row._id), kind: row.kind, offsetSeconds: offset(row.occurredAt), label: row.label });
    const counts = new Map(participants.map(row => [row._id, row.count]));
    const durationSeconds = offset(end);
    const trackingStart = session.chat_tracking_started_at ? offset(session.chat_tracking_started_at) : null;
    const chatters = Array.from({ length: Math.min(MAX_ROWS, Math.ceil(durationSeconds / 300)) }, (_, bucket) => ({
        offsetSeconds: bucket * 300,
        // The first bucket may be partial; keep it unknown rather than inflate confidence.
        count: trackingStart !== null && bucket * 300 >= trackingStart ? counts.get(bucket) || 0 : null
    }));
    return { session: { id: sessionID, startedAt: session.started_at, endedAt: session.ended_at, status: session.status, durationSeconds },
        points, chatters, events: events.sort((a, b) => a.offsetSeconds - b.offsetSeconds),
        coverage: { retentionDays: 90, chatterTrackingStartedAt: session.chat_tracking_started_at || null,
            truncated: [snapshots, raids, markers, participants].some(rows => rows.length > MAX_ROWS) || durationSeconds > MAX_ROWS * 300 }, asOf: now };
}
