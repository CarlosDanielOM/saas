import { McpCallLog, type IMcpCallLog } from '../../../../site_agent/mcp_call_log.js';
import { actorOf, clipText, flatData, loginOnly, mongoPage, num, str, type FeedSource } from '../source.js';
import type { FeedFilters, FeedItem } from '../types.js';

/**
 * AI app tool calls over MCP (`mcp_call_logs`, see site_agent/mcp_call_log.ts). An item is one tool call: the app,
 * the tool, who it acted for, how it ended and what it was charged. `text` is the refusal or error message the
 * app got; arguments and results are never stored.
 *
 * Indexes: `{at, _id}`, `{channelId, at, _id}`, `{user.id, at, _id}`, partial `problems_at` (`problem: true`).
 */
export function mcpItem(row: IMcpCallLog): FeedItem {
    return {
        id: `mcp:${row._id}`,
        at: new Date(row.at).toISOString(),
        kind: 'mcp',
        name: row.tool || 'unknown',
        outcome: row.outcome === 'failed' ? 'failed' : row.outcome === 'blocked' ? 'blocked' : 'ok',
        reason: str(row.code),
        channelID: row.channelId || null,
        channel: str(row.channelLogin),
        actor: actorOf(row.user?.id, row.user?.login, null),
        text: clipText(row.reason),
        credits: num(row.charged) || null,
        providerUSD: null,
        durationMs: num(row.ms),
        data: flatData({
            app: row.client?.name,
            appId: row.client?.id,
            toolKind: row.kind,
            role: row.user?.role,
            changeId: row.changeId,
            late: row.late,
        }),
        ref: null,
    };
}

export function mcpFilter(filters: FeedFilters): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (filters.channelID) filter.channelId = filters.channelID;
    if (filters.actorID) filter['user.id'] = filters.actorID;
    else if (filters.actorLogin) filter['user.login'] = filters.actorLogin;
    if (filters.outcome === 'problems') filter.problem = true;
    else if (filters.outcome === 'failed') filter.outcome = 'failed';
    return filter;
}

const PROJECTION = { at: 1, ms: 1, channelId: 1, channelLogin: 1, user: 1, client: 1, tool: 1, kind: 1, outcome: 1, code: 1, reason: 1, charged: 1, changeId: 1, late: 1 };

export const mcpSource: FeedSource = {
    prefix: 'mcp',
    plan(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('mcp')) return [];
        // `user.login` has no index: by login only inside one channel.
        if (loginOnly(filters) && !filters.channelID) return [];
        return ['mcp'];
    },
    gaps(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('mcp')) return [];
        return loginOnly(filters) && !filters.channelID ? ['mcp'] : [];
    },
    async list({ filters, bound, limit, maxTimeMS }) {
        const rows = await mongoPage(McpCallLog.collection, mcpFilter(filters), {
            timeField: 'at', idField: '_id', from: filters.from, to: filters.to, bound, limit, maxTimeMS, projection: PROJECTION
        });
        return rows.map(row => mcpItem(row as unknown as IMcpCallLog));
    },
    async count({ filters, maxTimeMS }) {
        const [row] = await McpCallLog.collection.aggregate([
            { $match: { ...mcpFilter({ ...filters, outcome: undefined }), at: { $gte: filters.from, $lt: filters.to } } },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                problems: { $sum: { $cond: ['$problem', 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } }
            } }
        ], { maxTimeMS }).toArray();
        return [{ kind: 'mcp', total: row?.total ?? 0, problems: row?.problems ?? 0, failed: row?.failed ?? 0 }];
    }
};
