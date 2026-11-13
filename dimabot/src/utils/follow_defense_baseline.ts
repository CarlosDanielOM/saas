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
export type BaselinePhases = Partial<Record<'queueMs' | 'claimMs' | 'ledgerMs' | 'streamsMs' | 'attacksMs' | 'publishMs' | 'rescheduleMs', number>>;
// A phase that fails still records how long it took; one that never started stays absent.
async function timed<T>(phases: BaselinePhases, name: keyof BaselinePhases, work: () => PromiseLike<T>): Promise<T> {
    const started = performance.now();
    try { return await work(); } finally { phases[name] = performance.now() - started; }
}
export async function refreshDefenseBaseline(channelID: string, now = Date.now(), phases: BaselinePhases = {}): Promise<DefenseBaseline> {
    const [{ FollowRelationshipLedgerSchema: Ledger }, { StreamSessionSchema: Streams }, { FollowAttackLogSchema: Attacks }] = await Promise.all([
        import('../schemas/follow_relationship_ledger.schema.js'), import('../schemas/stream_session.schema.js'), import('../schemas/follow_attack_log.schema.js')
    ]);
    const end = new Date(Math.floor(now / DAY) * DAY), start = new Date(end.getTime() - 30 * DAY);
    const date = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'UTC' } });
    const [days, streams, attacks] = await Promise.all([
        timed(phases, 'ledgerMs', () => Ledger.aggregate([{ $match: { followed_id: channelID, followed_at: { $gte: start, $lt: end } } }, { $group: { _id: date('$followed_at'), follows: { $sum: 1 } } }]).option({ maxTimeMS: 10000 })),
        timed(phases, 'streamsMs', () => Streams.aggregate([{ $match: { channelID, status: 'offline', started_at: { $gte: start, $lt: end }, ended_at: { $lte: end, $ne: null }, duration_minutes: { $gt: 0 } } }, { $group: { _id: date('$started_at'), follows: { $sum: '$follows' }, count: { $sum: 1 } } }]).option({ maxTimeMS: 10000 })),
        timed(phases, 'attacksMs', () => Attacks.aggregate([{ $match: { targetChannelID: channelID, modeTriggered: 'attack', createdAt: { $gte: start, $lt: new Date(now) } } }, { $group: { _id: date('$createdAt') } }]).option({ maxTimeMS: 10000 }))
    ]);
    const baseline = calculateDefenseBaseline(days.map(d => ({ day: d._id, follows: d.follows })), streams.map(d => ({ day: d._id, follows: d.follows, count: d.count })), attacks.map(d => d._id).filter(d => d < end.toISOString().slice(0, 10)), now);
    await timed(phases, 'publishMs', async () => {
        const cache = await getDragonflyClient('defenseBaseline.refresh');
        await cache.set(key(channelID), JSON.stringify(baseline), { EX: 7 * 86400 });
    });
    return baseline;
}
/** Refreshes at most one due channel and returns how many it refreshed (0 or 1). */
export async function processDefenseBaseline(phases: BaselinePhases = {}): Promise<number> {
    const next = await timed(phases, 'queueMs', async () => {
        const cache = await getDragonflyClient('defenseBaseline.worker');
        return (await cache.zRangeWithScores(DUE, 0, 0))[0];
    });
    if (!next || next.score > Date.now()) return 0;
    const cache = await getDragonflyClient('defenseBaseline.worker');
    // One supervised worker; keep a retry receipt if it crashes during the query.
    await timed(phases, 'claimMs', () => cache.zAdd(DUE, [{ value: next.value, score: Date.now() + 60000 }]));
    await refreshDefenseBaseline(next.value, Date.now(), phases);
    await timed(phases, 'rescheduleMs', () => cache.zAdd(DUE, [{ value: next.value, score: Date.now() + 3600_000 }]));
    return 1;
}
// One Redis snapshot for both numbers; channel IDs never leave the cache.
const BACKLOG_SCRIPT = `
local count = redis.call('ZCOUNT', KEYS[1], '-inf', ARGV[1])
if count == 0 then return {0, ''} end
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {count, first[2]}
`;
/** Due channels and the age of the oldest one, for the admin health card. */
export async function defenseBaselineBacklog(now = Date.now()) {
    const cache = await getDragonflyClient('defenseBaseline.health');
    const [count, oldest] = await cache.eval(BACKLOG_SCRIPT, { keys: [DUE], arguments: [String(now)] }) as [number, string];
    const score = Number(oldest);
    if (count > 0 && (oldest === '' || !Number.isFinite(score) || score > now)) throw new Error('Invalid baseline health score');
    return { backlog_channels: Number(count), oldest_due_age_ms: count > 0 ? now - score : null };
}
