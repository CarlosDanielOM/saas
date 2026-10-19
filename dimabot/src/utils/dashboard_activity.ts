import { createHash, randomUUID } from 'node:crypto';
import { StreamActivitySchema as Activity, StreamActivityStateSchema as State } from '../schemas/stream_activity.schema.js';
import { DashboardActivityDailySchema as Daily, DashboardActivitySummarySchema as Summary } from '../schemas/dashboard_activity.schema.js';

import { getChannelEmoteCatalog, type ChannelEmoteCatalog } from './twitch_emotes.js';

const DAY = 86400000;
const hash = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const dashboardDayStart = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
export const dashboardRangeStart = (days: number, now = new Date()) => new Date(+dashboardDayStart(now) - (days - 1) * DAY);
export async function queueDashboardActivity(channelID: string) {
    const now = new Date(), update = { $set: { dirtyAt: now, nextRefreshAt: now }, $setOnInsert: { leaseUntil: new Date(0) } };
    try { await Summary.updateOne({ _id: channelID }, update, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; await Summary.updateOne({ _id: channelID }, update); }
}

// A separate fenced checkpoint can backfill retained metadata without replaying the
// timeline's aggregates or touching chat/bot execution. Old records lack the null marker.
export async function projectDashboardActivityBatch(limit = 500) {
    const owner = randomUUID(), now = new Date(), stateID = 'dashboard-daily-v1';
    await State.updateOne({ _id: stateID }, { $setOnInsert: { seq: 0, leaseUntil: new Date(0) } }, { upsert: true });
    const state = await State.findOneAndUpdate({ _id: stateID, leaseUntil: { $lte: now } },
        { $set: { owner, leaseUntil: new Date(+now + 60000) } }, { new: true }).lean();
    if (!state) return 0;
    let lost = false;
    const heartbeat = setInterval(() => { void State.updateOne({ _id: stateID, owner }, { $set: { leaseUntil: new Date(Date.now() + 60000) } })
        .then(row => { if (!row.matchedCount) lost = true; }).catch(() => { lost = true; }); }, 10000);
    heartbeat.unref();
    try {
        let active = state.active;
        if (!active?.ids?.length) {
            const pending = await Activity.find({ dashboardProcessed: null, kind: { $in: ['command', 'message'] },
                occurredAt: { $lte: now }, expiresAt: { $gt: now } }).sort({ occurredAt: 1, _id: 1 })
                .select('_id').limit(Math.max(1, Math.min(500, limit))).maxTimeMS(2000).lean();
            if (!pending.length) return 0;
            active = { seq: (state.seq || 0) + 1, ids: pending.map(row => row._id!) };
            const saved = await State.updateOne({ _id: stateID, owner }, { $set: { active, seq: active.seq } });
            if (!saved.matchedCount) throw new Error('Dashboard activity lease lost');
        }
        const rows = await Activity.find({ _id: { $in: active.ids }, expiresAt: { $gt: now } }).maxTimeMS(2000).lean();
        const seq = active.seq!;
        const changes = new Map<string, { channelID: string; day: Date; kind: 'command' | 'emote' | 'coverage'; key: string; label: string; count: number; firstAt: Date; expiresAt: Date }>();
        for (const row of rows) {
            const day = dashboardDayStart(row.occurredAt!);
            const add = (kind: 'command' | 'emote' | 'coverage', key: string, label: string, count: number) => {
                if (!Number.isSafeInteger(count) || count <= 0) return;
                const id = hash(row.channelID, day.toISOString(), kind, key);
                const value = changes.get(id) || { channelID: row.channelID!, day, kind, key, label, count: 0, firstAt: row.occurredAt!, expiresAt: row.expiresAt! };
                value.count += count;
                if (row.occurredAt! < value.firstAt) value.firstAt = row.occurredAt!;
                if (row.expiresAt! > value.expiresAt) value.expiresAt = row.expiresAt!;
                changes.set(id, value);
            };
            add('coverage', '', '', 1);
            if (row.kind === 'command') add('command', String(row.key || '').slice(0, 100), String(row.label || row.key || '').slice(0, 100), 1);
            else for (const emote of row.emotes || []) {
                if (/^twitch:[a-zA-Z0-9_-]{1,64}$/.test(emote.key || '')) add('emote', emote.key!, String(emote.label || '').slice(0, 64), emote.count || 0);
            }
        }
        if (lost) throw new Error('Dashboard activity lease lost');
        const operations = [...changes].map(([id, row]) => ({ updateOne: {
            filter: { _id: id, $or: [{ lastSeq: { $lt: seq } }, { lastSeq: { $exists: false } }] },
            update: { $setOnInsert: { channelID: row.channelID, day: row.day, kind: row.kind, key: row.key, label: row.label },
                $inc: { count: row.count }, $set: { lastSeq: seq }, $min: { firstAt: row.firstAt }, $max: { expiresAt: row.expiresAt } }, upsert: true
        } }));
        if (operations.length) try { await Daily.bulkWrite(operations, { ordered: false }); }
        catch (error) {
            const failures = (error as { writeErrors?: { code: number }[] }).writeErrors;
            if (!failures?.length || failures.some(row => row.code !== 11000)) throw error;
        }
        for (const channelID of new Set(rows.map(row => row.channelID!))) await queueDashboardActivity(channelID);
        await Activity.updateMany({ _id: { $in: active.ids } }, { $set: { dashboardProcessed: true } });
        const completed = await State.updateOne({ _id: stateID, owner }, { $unset: { active: '' }, $set: { updatedAt: new Date() } });
        if (!completed.matchedCount) throw new Error('Dashboard activity lease lost');
        return rows.length;
    } finally { clearInterval(heartbeat); await State.updateOne({ _id: stateID, owner }, { $set: { leaseUntil: new Date(0) } }); }
}

async function buildPeriod(channelID: string, days: number, now: Date, catalog: ChannelEmoteCatalog) {
    const from = dashboardRangeStart(days, now);
    const [rows, remaining] = await Promise.all([
        Daily.aggregate([{ $match: { channelID, day: { $gte: from, $lte: now }, expiresAt: { $gt: now } } },
            { $group: { _id: { kind: '$kind', key: '$key' }, label: { $first: '$label' }, count: { $sum: '$count' }, firstAt: { $min: '$firstAt' } } },
            { $sort: { count: -1, '_id.key': 1 } },
            { $facet: {
                commands: [{ $match: { '_id.kind': 'command' } }, { $limit: 5 }],
                emotes: [{ $match: { '_id.kind': 'emote' } }, { $limit: 5 }],
                streamerEmotes: [{ $match: { '_id.kind': 'emote', '_id.key': { $in: catalog.emotes.map(emote => `twitch:${emote.id}`) } } }, { $limit: 5 }],
                streamerTotal: [{ $match: { '_id.kind': 'emote', '_id.key': { $in: catalog.emotes.map(emote => `twitch:${emote.id}`) } } }, { $group: { _id: null, count: { $sum: '$count' } } }],
                totals: [{ $group: { _id: '$_id.kind', count: { $sum: '$count' }, distinct: { $sum: 1 }, firstAt: { $min: '$firstAt' } } }]
            } }]).option({ maxTimeMS: 3000 }),
        Activity.exists({ channelID, dashboardProcessed: null, kind: { $in: ['command', 'message'] },
            occurredAt: { $gte: from, $lte: now }, expiresAt: { $gt: now } }).maxTimeMS(1500)
    ]);
    const data = rows[0];
    const items = (kind: string) => data[kind].map((row: { _id: { key: string }; label: string; count: number }) => ({ key: row._id.key, label: row.label, count: row.count }));
    return { days, from, to: now, streamerEmotes: catalog.status === 'unavailable' ? null : items('streamerEmotes'),
        streamerEmoteUses: catalog.status === 'unavailable' ? null : data.streamerTotal[0]?.count || 0,
        emoteCatalog: { status: catalog.status, checkedAt: catalog.checkedAt }, commands: items('commands'), emotes: items('emotes'), pending: Boolean(remaining),
        commandRuns: data.totals.find((row: { _id: string }) => row._id === 'command')?.count || 0,
        emoteUses: data.totals.find((row: { _id: string }) => row._id === 'emote')?.count || 0,
        coverageStartedAt: data.totals.find((row: { _id: string }) => row._id === 'coverage')?.firstAt || null };
}

export async function refreshDashboardActivityOnce() {
    const now = new Date(), owner = randomUUID();
    const state = await Summary.findOneAndUpdate({ nextRefreshAt: { $lte: now }, leaseUntil: { $lte: now } },
        { $set: { owner, leaseUntil: new Date(+now + 60000) } }, { new: true, sort: { nextRefreshAt: 1 } }).lean();
    if (!state) return false;
    try {
        const catalog = await getChannelEmoteCatalog(state._id!);
        const payload = { '7': await buildPeriod(state._id!, 7, now, catalog), '30': await buildPeriod(state._id!, 30, now, catalog) };
        await Summary.updateOne({ _id: state._id, owner }, { $set: { payload, updatedAt: now, error: false } });
        await Summary.updateOne({ _id: state._id, owner, dirtyAt: { $lte: now } }, { $set: { nextRefreshAt: new Date(+now + 60000) } });
    } catch (error) {
        await Summary.updateOne({ _id: state._id, owner }, { $set: { error: true, nextRefreshAt: new Date(Date.now() + 30000) } });
        throw error;
    } finally { await Summary.updateOne({ _id: state._id, owner }, { $set: { leaseUntil: new Date(0) } }); }
    return true;
}
