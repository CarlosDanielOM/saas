import { Types } from 'mongoose';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema } from '../schemas/stream_viewer_snapshot.schema.js';
import { StreamParticipantSchema, StreamMarkerSchema } from '../schemas/stream_timeline.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import type { IRedemptionEvent } from '../interfaces/twitch/eventsub.interface.js';
import { captureStreamActivity, getStreamActivity, type ActivityKind } from './stream_activity.js';

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
            $setOnInsert: { kind: 'redemption', label: event.reward.title.slice(0, 120), occurredAt: at,
                rewardID: event.reward.id, cost: event.reward.cost, status: event.status,
                expiresAt: new Date(at.getTime() + TIMELINE_RETENTION_MS) }
        }, { upsert: true });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
    }
    await captureStreamActivity({ channelID: event.broadcaster_user_id, eventID: event.id, kind: 'redemption',
        occurredAt: at, key: event.reward.id, label: event.reward.title });
}

export async function recordTimelineMoment(input: { channelID: string; eventID: string; kind: ActivityKind; at: Date; label: string; value?: number }) {
    const session = await StreamSessionSchema.findOne({ channelID: input.channelID, started_at: { $lte: input.at },
        $or: [{ ended_at: { $gt: input.at } }, { ended_at: null }] }).sort({ started_at: -1 }).select('_id started_at').lean();
    if (!session) return;
    try {
        await StreamMarkerSchema.updateOne({ channelID: input.channelID, session_id: session._id, key: `event:${input.eventID}` }, {
            $setOnInsert: { kind: input.kind, label: input.label.slice(0, 120) || input.kind, value: input.value,
                occurredAt: input.at, expiresAt: new Date(input.at.getTime() + TIMELINE_RETENTION_MS) }
        }, { upsert: true });
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    await captureStreamActivity({ channelID: input.channelID, eventID: input.eventID, session, kind: input.kind,
        occurredAt: input.at, label: input.label, value: input.value });
}

export async function listTimelineStreams(channelID: string, page: number) {
    const query = { channelID, started_at: { $gte: new Date(Date.now() - TIMELINE_RETENTION_MS) } };
    const rows = await StreamSessionSchema.find(query).sort({ started_at: -1 }).skip((page - 1) * 20).limit(21)
        .select('_id started_at ended_at status peak_viewers messages').maxTimeMS(3000).lean();
    return { streams: rows.slice(0, 20).map(row => ({ id: String(row._id), startedAt: row.started_at, endedAt: row.ended_at, status: row.status })), page, hasMore: rows.length > 20 };
}

export async function getTimelineSession(channelID: string, sessionID: string) {
    return StreamSessionSchema.findOne({ _id: sessionID, channelID, started_at: { $gte: new Date(Date.now() - TIMELINE_RETENTION_MS) } }).maxTimeMS(1500).lean();
}

export async function getStreamTimeline(channelID: string, sessionID: string, tier = 'free') {
    const session = await getTimelineSession(channelID, sessionID);
    if (!session) return null;
    const now = new Date();
    const end = session.ended_at || now;
    const timeQuery = { $gte: session.started_at, $lte: end };
    const activity = await getStreamActivity(channelID, session._id, tier);
    const [snapshots, raids, markers, participants] = await Promise.all([
        StreamViewerSnapshotSchema.find({ channelID, session_id: session._id, captured_at: timeQuery })
            .sort({ captured_at: 1 }).limit(MAX_ROWS + 1).maxTimeMS(3000).lean(),
        DomainEventSchema.find({ channelID, source: 'twitch-eventsub', type: 'channel.raid.received', occurredAt: timeQuery, expiresAt: { $gt: now } })
            .sort({ occurredAt: 1 }).limit(101).select('occurredAt payload eventKey').maxTimeMS(1500).lean(),
        StreamMarkerSchema.find({ channelID, session_id: session._id, expiresAt: { $gt: now } })
            .sort({ occurredAt: 1, _id: 1 }).limit(101).maxTimeMS(1500).lean(),
        activity.chatterStartedAt ? [] : StreamParticipantSchema.find({ channelID, session_id: session._id,
            expiresAt: { $gt: now } }).select('bucket').limit(10_001).maxTimeMS(1500).lean()
    ]);
    const offset = (at: Date) => Math.max(0, (at.getTime() - session.started_at.getTime()) / 1000);
    const events: { id: string; kind: string; offsetSeconds: number; label: string; value?: number; rewardID?: string; cost?: number; status?: string }[] = [];
    const points = snapshots.slice(0, MAX_ROWS).map((row, index) => {
        const previous = snapshots[index - 1];
        const seconds = (row.captured_at.getTime() - (previous?.captured_at || session.started_at).getTime()) / 1000;
        const delta = row.messages - (previous?.messages || 0);
        const commandDelta = row.commands - (previous?.commands || 0);
        if (previous && row.game_name !== previous.game_name) events.push({ id: `game:${row._id}`, kind: 'game', offsetSeconds: offset(row.captured_at), label: row.game_name });
        if (previous && row.title !== previous.title) events.push({ id: `title:${row._id}`, kind: 'title', offsetSeconds: offset(row.captured_at), label: row.title });
        return { offsetSeconds: offset(row.captured_at), viewers: row.viewers,
            messagesPerMinute: seconds > 0 && delta >= 0 ? Math.round(delta / seconds * 600) / 10 : null,
            commandsPerMinute: tier !== 'free' && seconds > 0 && seconds <= 600 && commandDelta >= 0 ? Math.round(commandDelta / seconds * 600) / 10 : null,
            gap: Boolean(previous && seconds > 600), title: row.title, game: row.game_name };
    });
    for (const row of raids.slice(0, 100)) {
        const event = row.payload.event as Record<string, unknown> | undefined;
        events.push({ id: `event:${row.eventKey}`, kind: 'raid', offsetSeconds: offset(row.occurredAt),
            label: String(event?.from_broadcaster_user_name || event?.from_broadcaster_user_login || ''), value: Math.max(0, Number(event?.viewers) || 0) });
    }
    for (const row of markers.slice(0, 100)) events.push({ id: row.kind === 'raid' ? row.key : String(row._id), kind: row.kind, offsetSeconds: offset(row.occurredAt), label: row.label, value: row.value ?? undefined,
        ...(row.rewardID ? { rewardID: row.rewardID, cost: row.cost ?? undefined, status: row.status ?? undefined } : {}) });
    const legacyChattersTruncated = participants.length > 10_000;
    const counts = new Map<number, number>();
    if (!legacyChattersTruncated) for (const row of participants) counts.set(row.bucket, (counts.get(row.bucket) || 0) + 1);
    const durationSeconds = offset(end);
    const trackingStart = activity.chatterStartedAt ? offset(activity.chatterStartedAt) : session.chat_tracking_started_at ? offset(session.chat_tracking_started_at) : null;
    const projectedChatters = new Map(activity.series.map(row => [row.offsetSeconds / 300, row.chatters]));
    const chatters = Array.from({ length: Math.min(MAX_ROWS, Math.ceil(durationSeconds / 300)) }, (_, bucket) => ({
        offsetSeconds: bucket * 300,
        // The first bucket may be partial; keep it unknown rather than inflate confidence.
        count: !legacyChattersTruncated && trackingStart !== null && bucket * 300 >= trackingStart ? (activity.chatterStartedAt ? projectedChatters.get(bucket) || 0 : counts.get(bucket) || 0) : null
    }));
    return { session: { id: sessionID, startedAt: session.started_at, endedAt: session.ended_at, status: session.status, durationSeconds },
        points, chatters, events: [...new Map(events.map(event => [event.id, event])).values()].sort((a, b) => a.offsetSeconds - b.offsetSeconds), activity,
        markerPage: { hasMore: markers.length > 100, cursor: markers.length > 100 ? `${markers[99].occurredAt.toISOString()}|${markers[99]._id}` : null },
        coverage: { retentionDays: 90, chatterTrackingStartedAt: session.chat_tracking_started_at || null,
            truncated: snapshots.length > MAX_ROWS || legacyChattersTruncated || activity.truncated || durationSeconds > MAX_ROWS * 300,
            momentsPartial: raids.length > 100 || markers.length > 100 }, asOf: now };
}
