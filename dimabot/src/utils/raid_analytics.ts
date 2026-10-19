import { createHash, randomUUID } from 'node:crypto';
import { RaidAnalyticsHistorySchema as History, RaidAnalyticsSummarySchema as Summary } from '../schemas/raid_analytics.schema.js';
import { DomainEventSchema as Events } from '../schemas/domain_event.schema.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';

const DAY = 86400000;
export const raidRangeStart = (days: number, now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY);
export async function queueRaidSummary(channelID: string) {
    const now = new Date();
    const update = { $set: { dirtyAt: now, nextRefreshAt: now }, $setOnInsert: { leaseUntil: new Date(0) } };
    try { await Summary.updateOne({ _id: channelID }, update, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; await Summary.updateOne({ _id: channelID }, update); }
}
export async function applyRaidAnalyticsEvent(event: DomainEventEnvelope) {
    if (event.source !== 'twitch-eventsub' || !event.channelID || !['channel.raid.received', 'channel.raid.sent'].includes(event.type)) return;
    if (event.expiresAt <= new Date()) return;
    const raw = event.payload.event as Record<string, unknown>, outgoing = event.type === 'channel.raid.sent';
    const peerID = String(outgoing ? raw.to_broadcaster_user_id || '' : raw.from_broadcaster_user_id || '');
    if (!peerID || !Number.isFinite(Number(raw.viewers))) throw new Error('Invalid raid history payload');
    const id = createHash('sha256').update(`${event.channelID}:${event.eventKey}`).digest('hex');
    try { await History.updateOne({ _id: id }, { $setOnInsert: {
        channelID: event.channelID, direction: outgoing ? 'outgoing' : 'incoming', peerID,
        peerLogin: String(outgoing ? raw.to_broadcaster_user_login || '' : raw.from_broadcaster_user_login || '').slice(0, 64),
        peerName: String(outgoing ? raw.to_broadcaster_user_name || '' : raw.from_broadcaster_user_name || '').slice(0, 64),
        viewers: Math.max(0, Number(raw.viewers)), occurredAt: event.occurredAt, expiresAt: event.expiresAt
    } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    await queueRaidSummary(event.channelID);
}

async function refreshFollowCounts(channelID: string, now: Date) {
    const rows = await History.find({ channelID, direction: 'incoming', occurredAt: { $gte: raidRangeStart(30, now), $lte: now },
        expiresAt: { $gt: now }, $or: [{ followsComputedAt: null }, { followsComputedAt: { $lt: new Date(+now - 15 * 60000) } }] })
        .sort({ followsComputedAt: 1, occurredAt: 1 }).limit(25).maxTimeMS(2000).lean();
    for (let offset = 0; offset < rows.length; offset += 5) await Promise.all(rows.slice(offset, offset + 5).map(async row => {
        const next = await History.findOne({ channelID, direction: 'incoming', expiresAt: { $gt: now },
            $or: [{ occurredAt: { $gt: row.occurredAt } }, { occurredAt: row.occurredAt, _id: { $gt: row._id } }] })
            .sort({ occurredAt: 1, _id: 1 }).select('occurredAt').maxTimeMS(1500).lean();
        const end = new Date(Math.min(+row.occurredAt + 300000, next ? +next.occurredAt : Infinity, +now));
        const count = await Events.countDocuments({ channelID, source: 'twitch-eventsub', type: 'channel.follow.received',
            occurredAt: { $gte: row.occurredAt, $lt: end }, expiresAt: { $gt: now } }).maxTimeMS(2000);
        // Counts are temporal associations, recomputed from retained source to repair late events.
        // Open windows are eligible again on the next worker pass.
        await History.updateOne({ _id: row._id }, { $set: { followsAfter: count, followWindowEnd: end,
            followsComputedAt: +end >= +row.occurredAt + 300000 || next && +end >= +next.occurredAt ? now : new Date(0) } });
    }));
}

async function buildPeriod(channelID: string, days: number, now: Date) {
    const top = (direction: string) => [{ $match: { direction } }, { $group: { _id: '$peerID', count: { $sum: 1 }, viewers: { $sum: '$viewers' },
        name: { $first: '$peerName' }, login: { $first: '$peerLogin' }, lastAt: { $first: '$occurredAt' } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 5 }];
    const recent = (direction: string) => [{ $match: { direction } }, { $limit: 5 }, { $project: { _id: 0, peerID: 1, peerName: 1, peerLogin: 1, viewers: 1, occurredAt: 1, followsAfter: 1, followWindowEnd: 1 } }];
    const [data] = await History.aggregate([
        { $match: { channelID, occurredAt: { $gte: raidRangeStart(days, now), $lte: now }, expiresAt: { $gt: now } } },
        { $sort: { occurredAt: -1, _id: 1 } },
        { $facet: {
            totals: [{ $group: { _id: '$direction', raids: { $sum: 1 }, viewers: { $sum: '$viewers' }, biggest: { $max: '$viewers' },
                followsAfter: { $sum: '$followsAfter' }, evaluatedRaids: { $sum: { $cond: [{ $ne: ['$followsAfter', null] }, 1, 0] } },
                firstAt: { $min: '$occurredAt' } } }],
            incoming: recent('incoming'), outgoing: recent('outgoing'), topIncoming: top('incoming'), topOutgoing: top('outgoing')
        } }
    ] as Parameters<typeof History.aggregate>[0]).option({ maxTimeMS: 3000 });
    const peers = [...new Set([...data.incoming.map((r: { peerID: string }) => r.peerID), ...data.topIncoming.map((r: { _id: string }) => r._id)])];
    const outgoing = await History.aggregate([{ $match: { channelID, direction: 'outgoing', peerID: { $in: peers }, expiresAt: { $gt: now }, occurredAt: { $lte: now } } },
        { $group: { _id: '$peerID', lastAt: { $max: '$occurredAt' } } }]).option({ maxTimeMS: 2000 });
    const lastSent = new Map(outgoing.map(row => [row._id, row.lastAt]));
    data.incoming = data.incoming.map((row: { peerID: string }) => ({ ...row, lastOutgoingAt: lastSent.get(row.peerID) || null }));
    data.topIncoming = data.topIncoming.map((row: { _id: string }) => ({ ...row, lastOutgoingAt: lastSent.get(row._id) || null }));
    return { days, from: raidRangeStart(days, now), to: now, ...data };
}

export async function projectRaidSummaryOnce() {
    const now = new Date(), owner = randomUUID();
    const state = await Summary.findOneAndUpdate({ nextRefreshAt: { $lte: now }, leaseUntil: { $lte: now } },
        { $set: { owner, leaseUntil: new Date(+now + 60000) } }, { new: true, sort: { nextRefreshAt: 1 } }).lean();
    if (!state) return false;
    try {
        await refreshFollowCounts(state._id!, now);
        const payload = { '7': await buildPeriod(state._id!, 7, now), '30': await buildPeriod(state._id!, 30, now) };
        await Summary.updateOne({ _id: state._id, owner }, { $set: { payload, updatedAt: now, error: false } });
        await Summary.updateOne({ _id: state._id, owner, dirtyAt: { $lte: now } }, { $set: { nextRefreshAt: new Date(+now + 60000) } });
    } catch (error) {
        await Summary.updateOne({ _id: state._id, owner }, { $set: { error: true, nextRefreshAt: new Date(Date.now() + 30000) } });
        throw error;
    } finally { await Summary.updateOne({ _id: state._id, owner }, { $set: { leaseUntil: new Date(0) } }); }
    return true;
}
