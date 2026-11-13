import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BSON, type Document } from 'mongodb';
import { RaidAnalyticsHistorySchema as History, RaidAnalyticsSummarySchema as Summary } from '../schemas/raid_analytics.schema.js';
import { DomainEventSchema as Events } from '../schemas/domain_event.schema.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';

const DAY = 86400000;
const WINDOW = 300000, LEASE = 60000, REPAIR = 15 * 60000, MAX_METRIC = 1e15;

export interface RaidRefreshState {
    version: number;
    fingerprint: string;
    nextSourceAt: Date | null;
    nextRepairAt: Date | null;
    nextOpenAt: Date | null;
    dirtyAt: Date | null;
    hasFollowWindows: boolean;
}
export interface RaidProjectionPhases {
    claimMs?: number;
    followQueriesMs?: number;
    followWriteMs?: number;
    period7Ms?: number;
    period30Ms?: number;
    reciprocityMs?: number;
    publishMs?: number;
    releaseMs?: number;
}
export interface RaidProjectionResult {
    channels: number;
    published: number;
    phases: RaidProjectionPhases;
}
// The worker can report attempted phases on failure without importing telemetry here.
export class RaidProjectionError extends Error {
    constructor(cause: unknown, readonly phases: RaidProjectionPhases, readonly channels: number) {
        super('Raid analytics projection failed', { cause });
        this.name = 'RaidProjectionError';
    }
}

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

async function buildPeriodData(channelID: string, days: number, now: Date) {
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
    return data;
}

async function attachReciprocity(channelID: string, data: Document, now: Date) {
    const peers = [...new Set([...data.incoming.map((r: { peerID: string }) => r.peerID), ...data.topIncoming.map((r: { _id: string }) => r._id)])];
    const outgoing = await History.aggregate([{ $match: { channelID, direction: 'outgoing', peerID: { $in: peers }, expiresAt: { $gt: now }, occurredAt: { $lte: now } } },
        { $group: { _id: '$peerID', lastAt: { $max: '$occurredAt' } } }]).option({ maxTimeMS: 2000 });
    const lastSent = new Map(outgoing.map(row => [row._id, row.lastAt]));
    data.incoming = data.incoming.map((row: { peerID: string }) => ({ ...row, lastOutgoingAt: lastSent.get(row.peerID) || null }));
    data.topIncoming = data.topIncoming.map((row: { _id: string }) => ({ ...row, lastOutgoingAt: lastSent.get(row._id) || null }));
    return data;
}

function earliest(...dates: Array<Date | null | undefined>): Date | null {
    const times = dates.filter((date): date is Date => date != null).map(Number);
    return times.length ? new Date(Math.min(...times)) : null;
}
const sameDate = (a: Date | null | undefined, b: Date | null | undefined) => (a == null ? null : +a) === (b == null ? null : +b);
const elapsed = (started: number) => Math.min(performance.now() - started, MAX_METRIC);
async function timed<T>(phases: RaidProjectionPhases, key: keyof RaidProjectionPhases, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await work(); }
    finally { phases[key] = Math.min((phases[key] || 0) + elapsed(started), MAX_METRIC); }
}

export function raidFollowWindow(raid: Date, next: Date | null, now: Date) {
    const end = new Date(Math.min(+raid + WINDOW, next ? +next : Infinity, +now));
    const computed = +end >= +raid + WINDOW || next && +end >= +next ? now : new Date(0);
    return { end, computed };
}
export function raidFollowValues(row: Document, count: number, end: Date, computed: Date) {
    const countChanged = typeof row.followsAfter !== 'number' || row.followsAfter !== count;
    const endChanged = (countChanged || +computed !== 0) && !sameDate(row.followWindowEnd, end);
    const values: Document = {};
    if (countChanged) values.followsAfter = count;
    if (endChanged) values.followWindowEnd = end;
    if (!sameDate(row.followsComputedAt, computed)) values.followsComputedAt = computed;
    return { values, changed: countChanged || endChanged };
}
export function raidNextRefreshAt(refresh: RaidRefreshState, pending: boolean, now: Date) {
    return pending ? now : earliest(refresh.nextSourceAt, refresh.nextRepairAt, refresh.nextOpenAt);
}
export function sameRaidPayload(old: Document, candidate: Document) {
    const stable = (payload: Document) => Object.fromEntries(Object.entries(payload).map(([key, value]) => {
        if (!['7', '30'].includes(key) || value == null || typeof value !== 'object') return [key, value];
        const { to: _to, ...period } = value;
        if (Array.isArray(period.totals)) period.totals = [...period.totals].sort((a, b) => {
            const left = typeof a?._id === 'string' ? a._id : '', right = typeof b?._id === 'string' ? b._id : '';
            return left < right ? -1 : left > right ? 1 : 0;
        });
        return [key, period];
    }));
    return isDeepStrictEqual(stable(old), stable(candidate));
}

// Preserve original BSON numeric types and field order to adopt Rust fingerprints exactly.
export function createRaidSourceFingerprint(now: Date) {
    const digest = createHash('sha256');
    let nextSourceAt: Date | null = null, hasFollowWindows = false, hasPeriodRows = false;
    return {
        add(row: Document) {
            const occurred = row.occurredAt, expires = row.expiresAt;
            if (!(occurred instanceof Date) || !(expires instanceof Date)) throw new Error('Invalid raid analytics projection data');
            if (expires <= now) return;
            if (occurred > now) { nextSourceAt = earliest(nextSourceAt, occurred, expires); return; }
            if (typeof row.direction !== 'string') throw new Error('Invalid raid analytics projection data');
            const inPeriod = occurred >= raidRangeStart(30, now), outgoing = row.direction === 'outgoing';
            if (!inPeriod && !outgoing) return;
            nextSourceAt = earliest(nextSourceAt, expires);
            if (inPeriod) { hasPeriodRows = true; hasFollowWindows ||= !outgoing; }
            const fields = inPeriod ? ['_id', 'direction', 'peerID', 'peerLogin', 'peerName', 'viewers', 'occurredAt', 'followsAfter', 'followWindowEnd']
                : ['_id', 'direction', 'peerID', 'occurredAt'];
            const source = Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]));
            const bytes = BSON.serialize(source), length = Buffer.alloc(8);
            length.writeBigUInt64LE(BigInt(bytes.length));
            digest.update(length); digest.update(bytes);
        },
        finish() {
            if (hasPeriodRows) {
                for (const days of [7, 30]) {
                    const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(+raidRangeStart(days, now))); digest.update(bytes);
                }
                nextSourceAt = earliest(nextSourceAt, new Date((Math.floor(+now / DAY) + 1) * DAY));
            }
            return { fingerprint: digest.digest('hex'), nextSourceAt, hasFollowWindows };
        }
    };
}
async function sourceState(channelID: string, now: Date) {
    const fingerprint = createRaidSourceFingerprint(now);
    const rows = History.collection.find({ channelID, expiresAt: { $gt: now } }, {
        sort: { occurredAt: -1, _id: 1 }, batchSize: 100, maxTimeMS: 3000, promoteValues: false,
        projection: { _id: 1, direction: 1, peerID: 1, peerLogin: 1, peerName: 1, viewers: 1,
            occurredAt: 1, expiresAt: 1, followsAfter: 1, followWindowEnd: 1 }
    });
    try { for await (const row of rows) fingerprint.add(row); }
    finally { await rows.close(); }
    return fingerprint.finish();
}
function followDueFilter(channelID: string, now: Date) {
    return { channelID, direction: 'incoming', occurredAt: { $gte: raidRangeStart(30, now), $lte: now },
        expiresAt: { $gt: now }, $or: [{ followsComputedAt: null }, { followsComputedAt: { $lte: new Date(+now - REPAIR) } }] };
}
const ownerFilter = (_id: string, owner: string) => ({ _id, owner, leaseUntil: { $gt: new Date() } });
const leaseError = () => new Error('Raid analytics lease lost');
function startHeartbeat(id: string, owner: string) {
    let lost = false, stopped = false, timer: ReturnType<typeof setTimeout>, pending: Promise<void> | undefined;
    const schedule = () => { timer = setTimeout(() => {
        pending = (async () => {
            try {
                const renewed = await Summary.updateOne(ownerFilter(id, owner), { $set: { leaseUntil: new Date(Date.now() + LEASE) } });
                if (!renewed.matchedCount) lost = true;
            } catch { lost = true; }
            if (!stopped && !lost) schedule();
        })();
    }, 10000); };
    schedule();
    return {
        async assertOwner() {
            if (lost) throw leaseError();
            const state = await Summary.findOne(ownerFilter(id, owner)).select('_id').lean();
            if (!state || lost) throw leaseError();
        },
        async stop() { stopped = true; clearTimeout(timer); await pending; }
    };
}
async function refreshFollowCounts(channelID: string, owner: string, now: Date,
    heartbeat: ReturnType<typeof startHeartbeat>, phases: RaidProjectionPhases) {
    let changed = false, nextOpenAt: Date | null = null;
    const { operations, ids } = await timed(phases, 'followQueriesMs', async () => {
        const rows = await History.find(followDueFilter(channelID, now))
            .sort({ followsComputedAt: 1, occurredAt: 1 }).limit(25).maxTimeMS(2000).lean();
        const operations = [];
        for (let offset = 0; offset < rows.length; offset += 5) {
            await heartbeat.assertOwner();
            // Settle siblings before releasing the lease if one bounded query fails.
            const updates = await Promise.allSettled(rows.slice(offset, offset + 5).map(async row => {
                if (!row._id) throw new Error('Invalid raid analytics projection data');
                const next = await History.findOne({ channelID, direction: 'incoming', expiresAt: { $gt: now },
                    $or: [{ occurredAt: { $gt: row.occurredAt } }, { occurredAt: row.occurredAt, _id: { $gt: row._id } }] })
                    .sort({ occurredAt: 1, _id: 1 }).select('occurredAt').maxTimeMS(1500).lean();
                const { end, computed } = raidFollowWindow(row.occurredAt, next?.occurredAt || null, now);
                const count = await Events.countDocuments({ channelID, source: 'twitch-eventsub', type: 'channel.follow.received',
                    occurredAt: { $gte: row.occurredAt, $lt: end }, expiresAt: { $gt: now } }).maxTimeMS(2000);
                const update = raidFollowValues(row, count, end, computed);
                return { ...update, id: row._id, nextOpenAt: +computed === 0
                    ? new Date(Math.min(+now + 60000, +row.occurredAt + WINDOW, next ? +next.occurredAt : Infinity)) : null };
            }));
            for (const result of updates) {
                if (result.status === 'rejected') throw result.reason;
                const update = result.value;
                changed ||= update.changed;
                nextOpenAt = earliest(nextOpenAt, update.nextOpenAt);
                if (Object.keys(update.values).length) operations.push({ updateOne: { filter: { _id: update.id }, update: { $set: update.values } } });
            }
        }
        return { operations, ids: rows.map(row => row._id!) };
    });
    if (operations.length) await timed(phases, 'followWriteMs', async () => {
        await heartbeat.assertOwner();
        if (changed) {
            const marked = await Summary.updateOne(ownerFilter(channelID, owner), { $set: { rustPending: true } });
            if (!marked.matchedCount) throw leaseError();
        }
        await History.bulkWrite(operations, { ordered: false, writeConcern: { w: 1, j: true } });
    });
    const pending = await timed(phases, 'followQueriesMs', () => History.findOne({ ...followDueFilter(channelID, now), _id: { $nin: ids } })
        .select('_id').maxTimeMS(2000).lean().exec());
    return { changed, pending: Boolean(pending), nextOpenAt };
}

/** One pass; failures throw RaidProjectionError with all attempted phases and the claim count. Business time is injectable; leases always use wall time. */
export async function projectRaidSummaryOnceObserved(now = new Date()): Promise<RaidProjectionResult> {
    const phases: RaidProjectionPhases = {}, owner = randomUUID();
    let channels = 0;
    try {
        const state = await timed(phases, 'claimMs', () => Summary.findOneAndUpdate({ nextRefreshAt: { $lte: now }, leaseUntil: { $lte: new Date() } },
            { $set: { owner, leaseUntil: new Date(Date.now() + LEASE) } }, { new: true, sort: { nextRefreshAt: 1 } }).lean().exec());
        if (!state) return { channels, published: 0, phases };
        channels = 1;
        const id = state._id!, heartbeat = startHeartbeat(id, owner);
        let published = 0, failure: unknown, failed = false;
        try {
            if (!id) throw new Error('Invalid raid analytics projection data');
            const follows = await refreshFollowCounts(id, owner, now, heartbeat, phases);
            const previous: RaidRefreshState | null = state.rustRefresh?.version === 1 && state.payload ? state.rustRefresh : null;
            const needsSource = state.rustPending || state.error || follows.changed || !previous
                || !sameDate(previous.dirtyAt, state.dirtyAt) || previous.nextSourceAt && previous.nextSourceAt <= now
                || state.dirtyAt && sameDate(state.nextRefreshAt, state.dirtyAt);
            const source = needsSource ? await sourceState(id, now) : previous!;
            let payload: Document | undefined;
            if (!previous || previous.fingerprint !== source.fingerprint) {
                const period7 = await timed(phases, 'period7Ms', () => buildPeriodData(id, 7, now));
                await timed(phases, 'reciprocityMs', () => attachReciprocity(id, period7, now));
                const period30 = await timed(phases, 'period30Ms', () => buildPeriodData(id, 30, now));
                await timed(phases, 'reciprocityMs', () => attachReciprocity(id, period30, now));
                const candidate = { '7': { days: 7, from: raidRangeStart(7, now), to: now, ...period7 },
                    '30': { days: 30, from: raidRangeStart(30, now), to: now, ...period30 } };
                if (!state.payload || !sameRaidPayload(state.payload, candidate)) payload = candidate;
            }
            const previousRepair = previous?.nextRepairAt;
            const refresh: RaidRefreshState = {
                version: 1, fingerprint: source.fingerprint, nextSourceAt: source.nextSourceAt,
                nextRepairAt: source.hasFollowWindows
                    ? previousRepair && (previousRepair > now || follows.pending) ? previousRepair : new Date(+now + REPAIR) : null,
                nextOpenAt: follows.nextOpenAt, dirtyAt: state.dirtyAt || null, hasFollowWindows: source.hasFollowWindows
            };
            const next = raidNextRefreshAt(refresh, follows.pending, now);
            await timed(phases, 'publishMs', async () => {
                await heartbeat.assertOwner();
                const values: Document = { rustRefresh: refresh, error: false, rustPending: false };
                if (payload) { values.payload = payload; values.updatedAt = now; }
                if (next) values.nextRefreshAt = next;
                const update = { $set: values, ...(!next ? { $unset: { nextRefreshAt: '' } } : {}) };
                const saved = await Summary.updateOne({ ...ownerFilter(id, owner), dirtyAt: state.dirtyAt || null }, update);
                if (!saved.matchedCount) await heartbeat.assertOwner();
                else published = Number(Boolean(payload));
            });
        } catch (error) {
            failed = true; failure = error;
            try { await Summary.updateOne({ ...ownerFilter(id, owner), dirtyAt: state.dirtyAt || null },
                { $set: { error: true, nextRefreshAt: new Date(Date.now() + 30000) } }); } catch {}
        }
        try {
            await timed(phases, 'releaseMs', async () => {
                await heartbeat.stop();
                await Summary.updateOne({ _id: id, owner }, { $set: { leaseUntil: new Date(0) } });
            });
        } catch (error) { if (!failed) { failed = true; failure = error; } }
        if (failed) throw failure;
        return { channels, published, phases };
    } catch (error) { throw new RaidProjectionError(error, phases, channels); }
}

// Preserve the legacy boolean contract: true means a channel was claimed, even without a payload publication.
export async function projectRaidSummaryOnce(now = new Date()) {
    return (await projectRaidSummaryOnceObserved(now)).channels > 0;
}
export async function raidAnalyticsBacklogHealth(now = new Date()): Promise<{ dueChannels: number; oldestDueAgeMs: number | null }> {
    const due = { nextRefreshAt: { $lte: now } }, index = { nextRefreshAt: 1, leaseUntil: 1 } as const;
    const count = await Summary.countDocuments(due).hint(index).maxTimeMS(750);
    const oldest = count ? await Summary.findOne(due).sort({ nextRefreshAt: 1 }).select('-_id nextRefreshAt').hint(index).maxTimeMS(750).lean() : null;
    if (oldest && !(oldest.nextRefreshAt instanceof Date)) throw new Error('Invalid raid analytics projection data');
    return { dueChannels: Math.min(count, MAX_METRIC), oldestDueAgeMs: oldest?.nextRefreshAt
        ? Math.min(Math.max(0, +now - +oldest.nextRefreshAt), MAX_METRIC) : null };
}
