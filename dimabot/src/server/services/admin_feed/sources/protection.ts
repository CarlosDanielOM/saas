import { ModerationDecision } from '../../../../schemas/moderation_decision.schema.js';
import { SPAM_RULE_ID } from '../../../../utils/moderation/spam.js';
import { actorOf, clipText, flatData, loginOnly, mongoPage, num, str, type FeedSource } from '../source.js';
import type { FeedFilters, FeedItem, FeedOutcome } from '../types.js';

/**
 * Chat protection decisions (`moderation_decisions`): AI reviews and plain rule hits, with what was done.
 *
 * Indexes: `{channelID, createdAt}` for one channel; `{createdAt}` and `{userID, createdAt}` for every
 * channel and one chatter. The collection is small (hundreds of rows a week), so filters on fields
 * without an index (status, login) stay inside a bounded time range.
 */

/** The review never finished: the message passed without a verdict. */
export const FAILED_STATUSES = ['timeout', 'unavailable', 'rate_limited', 'invalid_response', 'invalid_configuration', 'invalid_context'];
/** The review was deliberately not run (plan, credits, quota, the rule changed meanwhile). */
export const SKIPPED_STATUSES = ['plan_required', 'credits_unavailable', 'quota_exhausted', 'policy_changed'];
const ACTION_FAILED = { 'consequence.status': 'executed', 'consequence.success': false };

export interface DecisionRow {
    _id: string;
    channelID: string;
    userID?: string;
    userLogin?: string;
    username?: string;
    messageText?: string;
    ruleID?: string;
    rule?: { type?: string };
    mode?: string;
    reviewSource?: string;
    verdict?: string;
    status?: string;
    model?: string;
    scores?: Record<string, unknown> | null;
    cost?: number;
    latencyMs?: number;
    charge?: { credits?: number };
    consequence?: { status?: string; action?: string; success?: boolean; errorMessage?: string | null };
    createdAt: Date;
}

export const modelWithoutDate = (model: unknown): string | null => str(model)?.replace(/-\d{8}$/, '') ?? null;

/** The highest category score, ignoring `safe` and the derived `violation` unless it is the only score. */
export function topScore(scores: DecisionRow['scores']): { category: string; score: number } | null {
    if (!scores || typeof scores !== 'object') return null;
    let best: { category: string; score: number } | null = null;
    for (const [category, value] of Object.entries(scores)) {
        if (category === 'safe' || category === 'violation' || typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (!best || value > best.score) best = { category, score: value };
    }
    if (!best && typeof scores.violation === 'number' && Number.isFinite(scores.violation)) best = { category: 'violation', score: scores.violation };
    return best;
}

export function decisionOutcome(row: Pick<DecisionRow, 'status' | 'consequence'>): { outcome: FeedOutcome; reason: string | null } {
    const status = row.status || '';
    if (FAILED_STATUSES.includes(status)) return { outcome: 'failed', reason: status };
    if (row.consequence?.status === 'executed' && row.consequence.success === false) return { outcome: 'failed', reason: 'action_failed' };
    if (SKIPPED_STATUSES.includes(status)) return { outcome: 'skipped', reason: status };
    return { outcome: 'ok', reason: null };
}

export function decisionItem(row: DecisionRow): FeedItem {
    const ai = row.mode === 'semantic';
    const source = row.reviewSource || 'rule';
    const top = topScore(row.scores);
    const { outcome, reason } = decisionOutcome(row);
    const cost = num(row.cost);
    const latency = num(row.latencyMs);
    const action = str(row.consequence?.action);
    const ruleType = row.ruleID === SPAM_RULE_ID ? 'builtin' : str(row.rule?.type);
    return {
        id: `decision:${row._id}`,
        at: new Date(row.createdAt).toISOString(),
        kind: 'protection',
        name: source === 'rule' ? ruleType ?? 'rule' : source,
        outcome,
        reason,
        channelID: row.channelID || null,
        channel: null,
        actor: actorOf(row.userID, row.userLogin, row.username),
        text: clipText(row.messageText),
        credits: ai ? num(row.charge?.credits) ?? 0 : null,
        // Zero is what a fallback or a timeout records: it means "not reported", not "free".
        providerUSD: ai && cost !== null && cost > 0 ? cost : null,
        durationMs: latency !== null && latency > 0 ? latency : null,
        data: flatData({
            verdict: str(row.verdict),
            status: str(row.status),
            action: action && action !== 'off' ? action : null,
            actionSucceeded: typeof row.consequence?.success === 'boolean' ? row.consequence.success : null,
            actionError: clipText(row.consequence?.errorMessage, 200),
            topCategory: top?.category ?? null,
            topScore: top ? Math.round(top.score * 1000) / 1000 : null,
            model: ai ? modelWithoutDate(row.model) : null,
            included: source === 'first_message',
            ruleType,
            source
        }),
        ref: { type: 'decision', id: row._id }
    };
}

export function decisionFilter(filters: FeedFilters): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (filters.channelID) filter.channelID = filters.channelID;
    if (filters.actorID) filter.userID = filters.actorID;
    else if (filters.actorLogin) filter.userLogin = filters.actorLogin;
    // A skipped review (no credits, plan) is the channel's setting doing its job, never a problem: both filters are "failed".
    if (filters.outcome) filter.$or = [{ status: { $in: FAILED_STATUSES } }, ACTION_FAILED];
    return filter;
}

const PROJECTION = {
    channelID: 1, userID: 1, userLogin: 1, username: 1, messageText: 1, ruleID: 1, 'rule.type': 1, mode: 1, reviewSource: 1,
    verdict: 1, status: 1, model: 1, scores: 1, cost: 1, latencyMs: 1, 'charge.credits': 1, consequence: 1, createdAt: 1
};

export const protectionSource: FeedSource = {
    prefix: 'decision',
    plan: filters => !filters.kinds?.length || filters.kinds.includes('protection') ? ['protection'] : [],
    // Decisions stored before `userLogin` existed are only found by id: a login-only search may miss them.
    gaps: filters => loginOnly(filters) && (!filters.kinds?.length || filters.kinds.includes('protection')) ? ['protection'] : [],
    async list({ filters, bound, limit, maxTimeMS }) {
        const rows = await mongoPage(ModerationDecision.collection, decisionFilter(filters), {
            timeField: 'createdAt', idField: '_id', from: filters.from, to: filters.to, bound, limit, maxTimeMS, projection: PROJECTION
        });
        return rows.map(row => decisionItem(row as unknown as DecisionRow));
    },
    async count({ filters, maxTimeMS }) {
        const failed = { $or: [{ $in: ['$status', FAILED_STATUSES] }, { $and: [{ $eq: ['$consequence.status', 'executed'] }, { $eq: ['$consequence.success', false] }] }] };
        const [row] = await ModerationDecision.collection.aggregate([
            { $match: { ...decisionFilter({ ...filters, outcome: undefined }), createdAt: { $gte: filters.from, $lt: filters.to } } },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                failed: { $sum: { $cond: [failed, 1, 0] } }
            } }
        ], { maxTimeMS }).toArray();
        return [{ kind: 'protection', total: row?.total ?? 0, problems: row?.failed ?? 0, failed: row?.failed ?? 0 }];
    }
};
