import { getDragonflyClient } from './databases/dragonfly.database.js';

const DAY = 86400_000;
const DUE = 'follow:defense:baseline:due';
const key = (channelID: string) => `follow:defense:baseline:${channelID}`;
export interface DefenseBaseline {
    calculatedAt: number;
    averageDaily: number;
    averageStream: number;
    sampleDays: number;
    streamCount: number;
    excludedDays: number;
    attackThreshold: number | null;
}
export function calculateDefenseBaseline(days: { day: string; follows: number }[], streams: { day: string; follows: number; count: number }[], excluded: string[], now = Date.now()): DefenseBaseline {
    const blocked = new Set(excluded);
    const cleanDays = days.filter(d => !blocked.has(d.day));
    const cleanStreams = streams.filter(d => !blocked.has(d.day));
    const sampleDays = new Set([...cleanDays, ...cleanStreams].map(d => d.day)).size;
    const streamCount = cleanStreams.reduce((n, s) => n + s.count, 0);
    const streamFollows = cleanStreams.reduce((n, s) => n + s.follows, 0);
    const averageDaily = Math.max(cleanDays.reduce((n, d) => n + d.follows, 0), streamFollows) / Math.max(1, 30 - blocked.size);
    const averageStream = streamCount ? streamFollows / streamCount : 0;
    return { calculatedAt: now, averageDaily, averageStream, sampleDays, streamCount, excludedDays: blocked.size,
        attackThreshold: sampleDays >= 7 && streamCount >= 3 ? Math.ceil(Math.max(500, 2 * averageDaily, 2 * averageStream)) : null };
}
export async function getDefenseBaseline(channelID: string): Promise<DefenseBaseline | null> {
    const cache = await getDragonflyClient('defenseBaseline');
    const raw = await cache.get(key(channelID));
    let value: DefenseBaseline | null = null;
    try { value = raw ? JSON.parse(raw) : null; } catch { /* Rebuild malformed cache. */ }
    if (!value || !Number.isFinite(value.calculatedAt) || Date.now() - value.calculatedAt > DAY) {
        if (await cache.set(`${key(channelID)}:requested`, '1', { NX: true, EX: 60 })) {
            await cache.zAdd(DUE, [{ score: Date.now(), value: channelID }], { LT: true });
        }
    }
    // Cache loss/staleness must never lower a large channel back to a fixed ban threshold.
    if (!value || !Number.isFinite(value.calculatedAt) || Date.now() - value.calculatedAt > 2 * DAY) return null;
    return value;
}
export async function refreshDefenseBaseline(channelID: string, now = Date.now()): Promise<DefenseBaseline> {
    const [{ FollowRelationshipLedgerSchema: Ledger }, { StreamSessionSchema: Streams }, { FollowAttackLogSchema: Attacks }] = await Promise.all([
        import('../schemas/follow_relationship_ledger.schema.js'), import('../schemas/stream_session.schema.js'), import('../schemas/follow_attack_log.schema.js')
    ]);
    const end = new Date(Math.floor(now / DAY) * DAY), start = new Date(end.getTime() - 30 * DAY);
    const date = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'UTC' } });
    const [days, streams, attacks] = await Promise.all([
        Ledger.aggregate([{ $match: { followed_id: channelID, followed_at: { $gte: start, $lt: end } } }, { $group: { _id: date('$followed_at'), follows: { $sum: 1 } } }]).option({ maxTimeMS: 10000 }),
        Streams.aggregate([{ $match: { channelID, status: 'offline', started_at: { $gte: start, $lt: end }, ended_at: { $lte: end, $ne: null }, duration_minutes: { $gt: 0 } } }, { $group: { _id: date('$started_at'), follows: { $sum: '$follows' }, count: { $sum: 1 } } }]).option({ maxTimeMS: 10000 }),
        Attacks.aggregate([{ $match: { targetChannelID: channelID, modeTriggered: 'attack', createdAt: { $gte: start, $lt: new Date(now) } } }, { $group: { _id: date('$createdAt') } }]).option({ maxTimeMS: 10000 })
    ]);
    const baseline = calculateDefenseBaseline(days.map(d => ({ day: d._id, follows: d.follows })), streams.map(d => ({ day: d._id, follows: d.follows, count: d.count })), attacks.map(d => d._id).filter(d => d < end.toISOString().slice(0, 10)), now);
    const cache = await getDragonflyClient('defenseBaseline.refresh');
    await cache.set(key(channelID), JSON.stringify(baseline), { EX: 7 * 86400 });
    return baseline;
}
export async function processDefenseBaseline(): Promise<void> {
    const cache = await getDragonflyClient('defenseBaseline.worker');
    const [next] = await cache.zRangeWithScores(DUE, 0, 0);
    if (!next || next.score > Date.now()) return;
    // One supervised worker; keep a retry receipt if it crashes during the query.
    await cache.zAdd(DUE, [{ value: next.value, score: Date.now() + 60000 }]);
    await refreshDefenseBaseline(next.value);
    await cache.zAdd(DUE, [{ value: next.value, score: Date.now() + 3600_000 }]);
}
