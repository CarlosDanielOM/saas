import { randomUUID } from 'node:crypto';
import { DashboardInsightsSchema as Summary } from '../schemas/dashboard_insights.schema.js';
import { StreamSessionSchema as Sessions } from '../schemas/stream_session.schema.js';
import { StreamViewerSnapshotSchema as Snapshots } from '../schemas/stream_viewer_snapshot.schema.js';
import { DomainEventSchema as Events } from '../schemas/domain_event.schema.js';
import { dashboardRangeStart } from './dashboard_activity.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const LIMITS = { sessions: 500, snapshots: 20000, raids: 10000, follows: 100000 };
export interface InsightSession { _id: unknown; started_at: Date; ended_at: Date | null; status: string; follows: number; }
export interface InsightSnapshot { session_id: unknown; captured_at: Date; viewers: number; game_name: string; }
interface Interval { from: number; to: number; session: string; game: string; viewers: number; follows: number; priorEnd?: number; }
const rounded = (value: number) => Math.round(value * 100) / 100;
const scalar = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

// Same ten-minute gap boundary as the existing timeline. Never fill missing starts,
// long gaps or offline time. Observed game changes are approximate, not exact switches.
export function insightIntervals(sessions: InsightSession[], snapshots: InsightSnapshot[]): Interval[] {
    const bySession = new Map(sessions.map(row => [String(row._id), row]));
    const grouped = new Map<string, InsightSnapshot[]>();
    for (const row of snapshots) {
        const id = String(row.session_id), session = bySession.get(id);
        if (!session?.ended_at || row.captured_at < session.started_at || row.captured_at >= session.ended_at) continue;
        const rows = grouped.get(id) || []; rows.push(row); grouped.set(id, rows);
    }
    const result: Interval[] = [];
    for (const [id, rows] of grouped) {
        rows.sort((a, b) => +a.captured_at - +b.captured_at);
        for (let i = 0; i < rows.length; i++) {
            const from = +rows[i].captured_at, to = +(rows[i + 1]?.captured_at || bySession.get(id)!.ended_at!);
            if (to <= from || to - from > 600000) continue;
            result.push({ from, to, session: id, game: String(rows[i].game_name || '').trim().slice(0, 128), viewers: scalar(rows[i].viewers), follows: 0 });
        }
    }
    result.sort((a, b) => a.from - b.from || a.to - b.to);
    let priorEnd = 0;
    for (const row of result) { row.priorEnd = priorEnd; priorEnd = Math.max(priorEnd, row.to); }
    return result;
}

export function assignInsightFollow(intervals: Interval[], occurredAt: Date): void {
    const at = +occurredAt;
    let low = 0, high = intervals.length;
    while (low < high) { const mid = (low + high) >>> 1; if (intervals[mid].from <= at) low = mid + 1; else high = mid; }
    const row = intervals[low - 1];
    // Overlapping session coverage is ambiguous; never credit two games.
    if (row && at < row.to && !(row.priorEnd && row.priorEnd > at)) row.follows++;
}

export function calculateInsights(sessions: InsightSession[], intervals: Interval[], raids: Date[], days: number, excludeRaids: boolean, now: Date, truncated = false) {
    const from = dashboardRangeStart(days, now);
    const completed = sessions.filter(row => row.status === 'offline' && row.ended_at && row.started_at >= from && row.ended_at <= now && row.ended_at > row.started_at);
    const excluded = new Set(completed.filter(row => raids.some(at => at >= row.started_at && at < row.ended_at!)).map(row => String(row._id)));
    const selected = completed.filter(row => !excludeRaids || !excluded.has(String(row._id)));
    const ids = new Set(selected.map(row => String(row._id)));
    const weekdays = Array.from({ length: 7 }, (_, index) => ({ weekday: (index + 1) % 7, streams: 0, hours: 0, follows: 0, sampledHours: 0, viewerHours: 0 }));
    for (const row of selected) {
        const day = weekdays.find(day => day.weekday === row.started_at.getUTCDay())!;
        day.streams++; day.hours += (+row.ended_at! - +row.started_at) / HOUR; day.follows += scalar(row.follows);
    }
    const games = new Map<string, { game: string; sessions: Set<string>; sampledHours: number; viewerHours: number; follows: number }>();
    for (const row of intervals) {
        if (!ids.has(row.session)) continue;
        const hours = (row.to - row.from) / HOUR;
        const session = selected.find(session => String(session._id) === row.session)!;
        const day = weekdays.find(day => day.weekday === session.started_at.getUTCDay())!;
        day.sampledHours += hours; day.viewerHours += row.viewers * hours;
        if (!row.game) continue;
        const game = games.get(row.game) || { game: row.game, sessions: new Set<string>(), sampledHours: 0, viewerHours: 0, follows: 0 };
        game.sessions.add(row.session); game.sampledHours += hours; game.viewerHours += row.viewers * hours; game.follows += row.follows;
        games.set(row.game, game);
    }
    const dayRows = weekdays.map(row => ({ weekday: row.weekday, streams: row.streams, hours: rounded(row.hours), follows: row.follows,
        followsPerStream: row.streams ? rounded(row.follows / row.streams) : null,
        followsPerHour: row.hours ? rounded(row.follows / row.hours) : null,
        averageViewers: row.sampledHours ? rounded(row.viewerHours / row.sampledHours) : null,
        coverage: row.hours ? rounded(Math.min(1, row.sampledHours / row.hours)) : null,
        eligible: !truncated && row.streams >= 3 && row.hours >= 2 && row.sampledHours / row.hours >= .8 }));
    const gameRows = [...games.values()].map(row => ({ game: row.game, streams: row.sessions.size, hours: rounded(row.sampledHours),
        viewerHours: rounded(row.viewerHours), averageViewers: rounded(row.viewerHours / row.sampledHours),
        follows: truncated ? null : row.follows, followsPerHour: truncated ? null : rounded(row.follows / row.sampledHours),
        eligible: !truncated && row.sessions.size >= 3 && row.sampledHours >= 2 }));
    const eligibleDays = dayRows.filter(row => row.eligible);
    const eligibleGames = gameRows.filter(row => row.eligible);
    const bestDay = (eligibleDays.length >= 2 ? eligibleDays : []).filter(row => row.follows > 0).sort((a, b) => b.followsPerStream! - a.followsPerStream! || a.weekday - b.weekday)[0]?.weekday ?? null;
    const bestGrowthGame = (eligibleGames.length >= 2 ? eligibleGames : []).filter(row => row.follows! > 0).sort((a, b) => b.followsPerHour! - a.followsPerHour! || a.game.localeCompare(b.game))[0]?.game ?? null;
    gameRows.sort((a, b) => b.viewerHours - a.viewerHours || a.game.localeCompare(b.game));
    return { days, from, to: now, timeZone: 'UTC', excludeRaids, streams: selected.length, excludedStreams: excludeRaids ? excluded.size : 0,
        weekdays: dayRows, games: gameRows.slice(0, 5), gameCount: gameRows.length, bestDay, bestGrowthGame,
        limited: truncated, sampledHours: rounded(weekdays.reduce((sum, row) => sum + row.sampledHours, 0)),
        hours: rounded(weekdays.reduce((sum, row) => sum + row.hours, 0)), minimumStreams: 3, minimumHours: 2 };
}

export async function queueDashboardInsights(channelID: string) {
    const now = new Date();
    // Frequent readers do not trigger repeated aggregation or writes.
    await Summary.updateOne({ _id: channelID }, { $setOnInsert: { nextRefreshAt: now, leaseUntil: new Date(0), expiresAt: new Date(+now + DAY) } }, { upsert: true })
        .catch(error => { if (error.code !== 11000) throw error; });
    await Summary.updateOne({ _id: channelID, expiresAt: { $lt: new Date(+now + DAY - 300000) } }, { $set: { expiresAt: new Date(+now + DAY) } });
}

export async function refreshDashboardInsightsOnce() {
    const now = new Date(), owner = randomUUID();
    const state = await Summary.findOneAndUpdate({ nextRefreshAt: { $lte: now }, leaseUntil: { $lte: now }, expiresAt: { $gt: now } },
        { $set: { owner, leaseUntil: new Date(+now + 60000) } }, { new: true, sort: { nextRefreshAt: 1 } }).lean();
    if (!state) return false;
    try {
        const channelID = state._id!, from = dashboardRangeStart(30, now);
        const sessions = await Sessions.find({ channelID, started_at: { $gte: from, $lte: now }, status: 'offline', ended_at: { $lte: now, $ne: null } })
            .sort({ started_at: -1 }).limit(LIMITS.sessions + 1).select('_id started_at ended_at status follows').maxTimeMS(3000).lean();
        const selected = sessions.slice(0, LIMITS.sessions);
        const [snapshots, raids] = await Promise.all([
            Snapshots.find({ channelID, session_id: { $in: selected.map(row => row._id) }, captured_at: { $gte: from, $lte: now } })
                .sort({ captured_at: 1 }).limit(LIMITS.snapshots + 1).select('session_id captured_at viewers game_name').maxTimeMS(3000).lean(),
            Events.find({ channelID, source: 'twitch-eventsub', type: 'channel.raid.received', occurredAt: { $gte: from, $lte: now }, expiresAt: { $gt: now } })
                .sort({ occurredAt: 1 }).limit(LIMITS.raids + 1).select('occurredAt').maxTimeMS(3000).lean()
        ]);
        const intervals = insightIntervals(selected, snapshots.slice(0, LIMITS.snapshots));
        let follows = 0;
        // Stream only timestamps in bounded batches, never chat text, payloads or identities.
        if (intervals.length) {
            const cursor = Events.find({ channelID, source: 'twitch-eventsub', type: 'channel.follow.received',
                occurredAt: { $gte: from, $lte: now }, expiresAt: { $gt: now } }).sort({ occurredAt: 1 }).limit(LIMITS.follows + 1)
                .select('occurredAt -_id').maxTimeMS(10000).lean().cursor({ batchSize: 500 });
            try { for await (const row of cursor) { if (++follows > LIMITS.follows) break; assignInsightFollow(intervals, row.occurredAt); } }
            finally { await cursor.close(); }
        }
        const truncated = sessions.length > LIMITS.sessions || snapshots.length > LIMITS.snapshots || raids.length > LIMITS.raids || follows > LIMITS.follows;
        const payload: Record<string, unknown> = {};
        for (const days of [7, 30]) for (const exclude of [false, true]) payload[`${days}:${exclude ? 'exclude' : 'include'}`] = calculateInsights(selected, intervals, raids.slice(0, LIMITS.raids).map(row => row.occurredAt), days, exclude, now, truncated);
        await Summary.updateOne({ _id: channelID, owner }, { $set: { payload, updatedAt: now, error: false, nextRefreshAt: new Date(Date.now() + 300000) } });
    } catch (error) {
        await Summary.updateOne({ _id: state._id, owner }, { $set: { error: true, nextRefreshAt: new Date(Date.now() + 30000) } });
        throw error;
    } finally { await Summary.updateOne({ _id: state._id, owner }, { $set: { leaseUntil: new Date(0) } }); }
    return true;
}
