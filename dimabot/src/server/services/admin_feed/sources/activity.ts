import { ACTIVITY_KINDS, ActivityLog, type IActivityLog } from '../../../../schemas/activity_log.schema.js';
import { actorOf, emptyCounts, flatData, isEventKey, mongoPage, PROBLEM_OUTCOMES, servedKinds, type FeedSource } from '../source.js';
import type { FeedFilters, FeedItem, FeedKind, FeedKindCount } from '../types.js';

/**
 * The bot's own debug trail (`activity_logs`): commands, bot messages, Twitch notifications that are not
 * journaled, chat alerts, voice failures, system work. Rows map almost one to one.
 *
 * Indexes: `{at, _id}` (everything), `{channelID, at, _id}`, `{kind, at, _id}`, the partial `problems_at`
 * for outcome filters and the partial actor indexes.
 */
const OWN_KINDS: readonly FeedKind[] = ACTIVITY_KINDS;

export function activityFilter(filters: FeedFilters, kinds: FeedKind[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (kinds.length < OWN_KINDS.length) filter.kind = kinds.length === 1 ? kinds[0] : { $in: kinds };
    if (filters.channelID) filter.channelID = filters.channelID;
    if (filters.actorID) filter.actorID = filters.actorID;
    else if (filters.actorLogin) filter.actorLogin = filters.actorLogin;
    // The exact `$in` of the partial index's filter, so "only failed" still uses it.
    if (filters.outcome === 'problems') filter.outcome = { $in: [...PROBLEM_OUTCOMES] };
    else if (filters.outcome === 'failed') filter.outcome = { $in: [...PROBLEM_OUTCOMES], $eq: 'failed' };
    return filter;
}

export function activityItem(row: IActivityLog): FeedItem {
    return {
        id: `activity:${row._id}`,
        at: new Date(row.at).toISOString(),
        kind: row.kind,
        name: row.name,
        outcome: row.outcome,
        reason: row.outcome === 'ok' ? null : row.reason || null,
        channelID: row.channelID || null,
        channel: null,
        actor: actorOf(row.actorID, row.actorLogin, row.actorName),
        text: row.text || null,
        credits: null,
        providerUSD: null,
        durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
        data: flatData(row.data && typeof row.data === 'object' ? row.data : {}),
        ref: row.kind === 'alert' && isEventKey(row.ref) ? { type: 'event', id: row.ref } : { type: 'activity', id: row._id }
    };
}

export const activitySource: FeedSource = {
    prefix: 'activity',
    plan: filters => servedKinds(filters, OWN_KINDS),
    async list({ filters, kinds, bound, limit, maxTimeMS }) {
        const rows = await mongoPage(ActivityLog.collection, activityFilter(filters, kinds), {
            timeField: 'at', idField: '_id', from: filters.from, to: filters.to, bound, limit, maxTimeMS
        });
        return rows.map(row => activityItem(row as unknown as IActivityLog));
    },
    async count({ filters, kinds, maxTimeMS }) {
        const counts = emptyCounts(kinds);
        const window = { at: { $gte: filters.from, $lt: filters.to } };
        const collection = ActivityLog.collection;
        if (!filters.channelID && !filters.actorID && !filters.actorLogin) {
            // Everything: per-kind counts are covered by `{kind, at, _id}`, and problems come from the
            // partial index, which holds only the rows that are not ok.
            const [totals, problems] = await Promise.all([
                Promise.all(kinds.map(kind => collection.countDocuments({ kind, ...window }, { maxTimeMS }))),
                collection.aggregate([
                    { $match: { ...window, outcome: { $in: [...PROBLEM_OUTCOMES] } } },
                    { $group: { _id: { kind: '$kind', outcome: '$outcome' }, n: { $sum: 1 } } }
                ], { maxTimeMS }).toArray()
            ]);
            kinds.forEach((kind, index) => { counts.get(kind)!.total = totals[index]; });
            for (const row of problems) addOutcome(counts, row._id.kind, row._id.outcome, row.n, false);
        } else {
            const rows = await collection.aggregate([
                { $match: { ...activityFilter({ ...filters, outcome: undefined }, kinds), ...window } },
                { $group: { _id: { kind: '$kind', outcome: '$outcome' }, n: { $sum: 1 } } }
            ], { maxTimeMS }).toArray();
            for (const row of rows) addOutcome(counts, row._id.kind, row._id.outcome, row.n, true);
        }
        return [...counts.values()];
    }
};

function addOutcome(counts: Map<FeedKind, FeedKindCount>, kind: FeedKind, outcome: string, n: number, addTotal: boolean): void {
    const row = counts.get(kind);
    if (!row) return;
    if (addTotal) row.total += n;
    if (outcome !== 'ok') row.problems += n;
    if (outcome === 'failed') row.failed += n;
}
