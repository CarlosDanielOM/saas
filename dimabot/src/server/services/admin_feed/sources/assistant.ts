import { SiteAgentTurnLog, type ISiteAgentTurnLog } from '../../../../site_agent/turn_log.schema.js';
import { actorOf, clipText, flatData, loginOnly, mongoPage, num, str, type FeedSource } from '../source.js';
import type { FeedFilters, FeedItem, FeedOutcome } from '../types.js';

/**
 * Dima assistant turns (`site_agent_turn_logs`). An item shows what the person asked (clipped); the answer,
 * steers and tool arguments/results stay on the turn's own page and are not even read for a feed page.
 *
 * Indexes: `{at, _id}`, `{channelId, at, _id}`, `{user.id, at, _id}`.
 */
const FAILED = ['failed', 'interrupted'];
const SKIPPED = ['cancelled'];

export function turnOutcome(row: Pick<ISiteAgentTurnLog, 'status' | 'errorCode'>): { outcome: FeedOutcome; reason: string | null } {
    if (FAILED.includes(row.status)) return { outcome: 'failed', reason: str(row.errorCode) ?? row.status };
    if (SKIPPED.includes(row.status)) return { outcome: 'skipped', reason: row.status };
    return { outcome: 'ok', reason: null };
}

export function turnItem(row: ISiteAgentTurnLog): FeedItem {
    const { outcome, reason } = turnOutcome(row);
    const cost = num(row.costUsd);
    const tools = [...new Set((row.tools || []).map(tool => tool?.name).filter((name): name is string => typeof name === 'string' && !!name))];
    return {
        id: `assistant:${row._id}`,
        at: new Date(row.at).toISOString(),
        kind: 'assistant',
        name: row.level || 'standard',
        outcome,
        reason,
        channelID: row.channelId || null,
        channel: str(row.channelLogin),
        actor: actorOf(row.user?.id, row.user?.login, row.user?.name),
        text: clipText(row.message),
        // Free to streamers: the assistant uses its own daily message allowance, not AI credits.
        credits: null,
        // Nothing reported for any step means the cost is unknown, not zero.
        providerUSD: cost !== null && !(cost === 0 && (row.unknownCostSteps || 0) > 0) ? cost : null,
        durationMs: num(row.durationMs),
        data: flatData({
            level: row.level,
            status: row.status,
            steps: num(row.steps),
            tools: tools.join(', '),
            model: (row.models || []).filter(model => typeof model === 'string').join(', '),
            errorCode: row.errorCode,
            units: num(row.units)
        }),
        ref: { type: 'assistant_turn', id: row._id }
    };
}

export function turnFilter(filters: FeedFilters): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (filters.channelID) filter.channelId = filters.channelID;
    if (filters.actorID) filter['user.id'] = filters.actorID;
    else if (filters.actorLogin) filter['user.login'] = filters.actorLogin;
    // Someone stopping the assistant is not a problem: both filters are "failed".
    if (filters.outcome) filter.status = { $in: FAILED };
    return filter;
}

const PROJECTION = {
    at: 1, channelId: 1, channelLogin: 1, user: 1, level: 1, models: 1, status: 1, errorCode: 1, steps: 1, message: 1,
    'tools.name': 1, units: 1, costUsd: 1, unknownCostSteps: 1, durationMs: 1
};

export const assistantSource: FeedSource = {
    prefix: 'assistant',
    plan(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('assistant')) return [];
        // `user.login` has no index: by login only inside one channel.
        if (loginOnly(filters) && !filters.channelID) return [];
        return ['assistant'];
    },
    gaps(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('assistant')) return [];
        return loginOnly(filters) && !filters.channelID ? ['assistant'] : [];
    },
    async list({ filters, bound, limit, maxTimeMS }) {
        const rows = await mongoPage(SiteAgentTurnLog.collection, turnFilter(filters), {
            timeField: 'at', idField: '_id', from: filters.from, to: filters.to, bound, limit, maxTimeMS, projection: PROJECTION
        });
        return rows.map(row => turnItem(row as unknown as ISiteAgentTurnLog));
    },
    async count({ filters, maxTimeMS }) {
        const [row] = await SiteAgentTurnLog.collection.aggregate([
            { $match: { ...turnFilter({ ...filters, outcome: undefined }), at: { $gte: filters.from, $lt: filters.to } } },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $in: ['$status', FAILED] }, 1, 0] } }
            } }
        ], { maxTimeMS }).toArray();
        return [{ kind: 'assistant', total: row?.total ?? 0, problems: row?.failed ?? 0, failed: row?.failed ?? 0 }];
    }
};
