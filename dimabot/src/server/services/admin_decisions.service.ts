import type { PipelineStage } from 'mongoose';
import { ModerationDecision, type IModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { SPAM_RULE_ID } from '../../utils/moderation/spam.js';
import { DEFAULT_SPAM_THRESHOLD } from '../../utils/moderation/spam_categories.js';
import { channelLogins } from '../routes/admin_site/shared.js';
import { MODERATION_REVIEW_LABELS, NEAR_MISS_MAX_SAFE, NEAR_MISS_MIN_SCORE, invalidateModerationReviewCounts, moderationReviewCountsCached, type ModerationReviewLabel } from './moderation_review.service.js';

/**
 * The owner's ledger of chat protection decisions across every channel: AI reviews and plain rule
 * hits, one row per decision, with the owner's verdict on any single one. Shapes follow
 * `admin/src/app/services/decisions-api.service.ts`. The rule snapshot's policy text, examples,
 * provider request ids, Polar ids and the reviewer's id never leave this file.
 */

export const DECISION_SHOWS = ['acted', 'bans', 'near_miss', 'allowed', 'not_reviewed', 'action_failed'] as const;
export const DECISION_SORTS = ['newest', 'cost', 'score', 'slowest'] as const;
export const DECISION_FEEDBACK = ['none', 'any', 'agree', 'disagree'] as const;
export const DECISION_KINDS = ['ai', 'rule'] as const;
export const DECISION_SOURCES = ['first_message', 'spam_continuous', 'rule'] as const;
export type DecisionShow = typeof DECISION_SHOWS[number];
export type DecisionSort = typeof DECISION_SORTS[number];
export type DecisionFeedbackFilter = typeof DECISION_FEEDBACK[number];
export type DecisionOutcome = 'allowed' | 'acted' | 'action_failed' | 'not_reviewed';
export const DECISION_NOTE_MAX = 500;
export const DECISION_HISTORY_MAX = 10;
const BYCHANNEL_MAX = 10;
const QUERY_MS = 5000;

/** Statuses where the review never answered (or was never allowed to run), so the message passed unchecked. */
export const NOT_REVIEWED_STATUSES = ['pending', 'timeout', 'unavailable', 'rate_limited', 'invalid_response', 'invalid_configuration',
    'invalid_context', 'policy_changed', 'plan_required', 'credits_unavailable', 'quota_exhausted'] as const;
const NOT_REVIEWED = new Set<string>(NOT_REVIEWED_STATUSES);
/** The model answered in time (sure or unsure). */
const ANSWERED_STATUSES = ['completed', 'uncertain'];
const ACTIONS = new Set(['warn', 'delete', 'timeout', 'ban']);
const DATE_SUFFIX = /-\d{8}$/;

export interface DecisionFeedback { label: ModerationReviewLabel; note: string | null; reviewedAt: string }
export interface DecisionRow {
    id: string; at: string; channelID: string; channel: string | null;
    chatter: { id: string; login: string | null; name: string };
    messageText: string; kind: 'ai' | 'rule'; ruleType: string; ruleReason: string | null;
    source: typeof DECISION_SOURCES[number]; messageOrdinal: number | null;
    verdict: IModerationDecision['verdict']; status: string; outcome: DecisionOutcome;
    action: string | null; actionError: string | null; model: string | null; provider: string | null;
    scores: Record<string, number> | null; thresholdPercent: number | null;
    inputTokens: number; providerUSD: number; credits: number; included: boolean; latencyMs: number;
    nearMiss: boolean;
    feedback: DecisionFeedback | null;
}
export interface DecisionDetail extends DecisionRow {
    context: Array<{ username: string; message: string; isBroadcaster: boolean; at: string | null }>;
    invited: boolean;
    categories: string[];
    history: Array<Pick<DecisionRow, 'id' | 'at' | 'messageText' | 'verdict' | 'outcome' | 'action'>>;
}

export interface DecisionFilters {
    /** Null: the owner asked for a channel login no streamer has, so nothing matches. */
    channelID?: string | null;
    chatterID?: string;
    chatterName?: string;
    show?: DecisionShow;
    kind?: typeof DECISION_KINDS[number];
    source?: typeof DECISION_SOURCES[number];
    model?: string;
    feedback?: DecisionFeedbackFilter;
    from: Date;
    to: Date;
}

// ---- Pure mapping ----

/** "openai/gpt-6-luna-decisions-20261006" → "openai/gpt-6-luna-decisions": success stores the provider's dated id, a fallback the plain one. */
export const normalizeModel = (model: unknown): string => String(model ?? '').replace(DATE_SUFFIX, '');

type Stored = Partial<IModerationDecision> & Record<string, any>;

export function decisionOutcome(decision: Pick<Stored, 'status' | 'consequence'>): DecisionOutcome {
    if (decision.consequence?.status === 'executed') return decision.consequence.success === true ? 'acted' : 'action_failed';
    return NOT_REVIEWED.has(String(decision.status)) ? 'not_reviewed' : 'allowed';
}

function decisionAction(decision: Pick<Stored, 'consequence'>): string | null {
    const status = decision.consequence?.status;
    const action = String(decision.consequence?.action);
    return (status === 'executed' || status === 'scheduled') && ACTIONS.has(action) ? action : null;
}

/** Agree = the owner's verdict matches what the bot concluded: a violation for a violation, "allow" for anything that was not one. */
export function feedbackAgrees(label: string, verdict: string): boolean {
    return label === 'violation' ? verdict === 'violation' : verdict !== 'violation';
}

const iso = (value: unknown): string | null => {
    const date = value instanceof Date ? value : value === undefined || value === null ? null : new Date(value as string);
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function mapFeedback(feedback: unknown): DecisionFeedback | null {
    const stored = feedback as { label?: unknown; note?: unknown; reviewedAt?: unknown } | null | undefined;
    if (!stored || !(MODERATION_REVIEW_LABELS as readonly unknown[]).includes(stored.label)) return null;
    return { label: stored.label as ModerationReviewLabel, note: typeof stored.note === 'string' && stored.note ? stored.note : null, reviewedAt: iso(stored.reviewedAt) || '' };
}

function mapScores(scores: unknown): Record<string, number> | null {
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;
    const numeric = Object.entries(scores as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value));
    return numeric.length ? Object.fromEntries(numeric) as Record<string, number> : null;
}

export function mapDecisionRow(decision: Stored, channels: Map<string, string>): DecisionRow {
    const ai = decision.mode === 'semantic';
    const builtin = decision.ruleID === SPAM_RULE_ID;
    const credits = number(decision.charge?.credits);
    const source = (DECISION_SOURCES as readonly string[]).includes(String(decision.reviewSource)) ? decision.reviewSource as DecisionRow['source'] : 'rule';
    const outcome = decisionOutcome(decision);
    const threshold = decision.rule?.semantic?.thresholdPercent;
    const scores = mapScores(decision.scores);
    return {
        id: String(decision._id), at: iso(decision.createdAt) || '', channelID: String(decision.channelID || ''),
        channel: channels.get(String(decision.channelID)) || null,
        chatter: { id: String(decision.userID || ''), login: decision.userLogin || null, name: String(decision.username || decision.userLogin || '') },
        messageText: String(decision.messageText ?? ''),
        kind: ai ? 'ai' : 'rule',
        ruleType: builtin ? 'builtin' : String(decision.rule?.type || ''),
        ruleReason: builtin ? null : decision.rule?.reason || null,
        source, messageOrdinal: source === 'first_message' && typeof decision.messageOrdinal === 'number' ? decision.messageOrdinal : null,
        verdict: decision.verdict || 'uncertain', status: String(decision.status || ''), outcome,
        action: decisionAction(decision),
        actionError: outcome === 'action_failed' ? decision.consequence?.errorMessage || null : null,
        model: ai && decision.model ? normalizeModel(decision.model) : null,
        provider: ai && decision.provider ? String(decision.provider) : null,
        scores,
        thresholdPercent: ai ? (typeof threshold === 'number' ? threshold : DEFAULT_SPAM_THRESHOLD) : null,
        inputTokens: number(decision.inputTokens), providerUSD: number(decision.cost), credits,
        included: source === 'first_message' && credits === 0,
        latencyMs: number(decision.latencyMs),
        // The same test as `show=near_miss`, so the page never has to copy the thresholds.
        nearMiss: ai && decision.verdict !== 'violation' && ANSWERED_STATUSES.includes(String(decision.status))
            && typeof scores?.violation === 'number' && scores.violation >= NEAR_MISS_MIN_SCORE
            && typeof scores?.safe === 'number' && scores.safe <= NEAR_MISS_MAX_SAFE,
        feedback: mapFeedback(decision.feedback)
    };
}

// ---- Filters ----

export function showFilter(show: DecisionShow): Record<string, unknown> {
    switch (show) {
        case 'acted': return { 'consequence.status': 'executed', 'consequence.success': true };
        case 'action_failed': return { 'consequence.status': 'executed', 'consequence.success': { $ne: true } };
        case 'bans': return { 'consequence.status': 'executed', 'consequence.action': 'ban' };
        case 'not_reviewed': return { 'consequence.status': { $ne: 'executed' }, status: { $in: [...NOT_REVIEWED_STATUSES] } };
        case 'allowed': return { 'consequence.status': { $ne: 'executed' }, status: { $nin: [...NOT_REVIEWED_STATUSES] } };
        // The Review queue's near miss, for any AI review (its contradictions included): no ban, answered in
        // time, a category scored at least half and the model was not sure the message was safe.
        case 'near_miss': return { mode: 'semantic', verdict: { $ne: 'violation' }, status: { $in: ANSWERED_STATUSES },
            'scores.violation': { $type: 'number', $gte: NEAR_MISS_MIN_SCORE }, 'scores.safe': { $type: 'number', $lte: NEAR_MISS_MAX_SAFE } };
    }
}

export function feedbackFilter(feedback: DecisionFeedbackFilter): Record<string, unknown> {
    // Same test as the Review queues: a cleared verdict is stored as `feedback: null`, so its label is missing.
    if (feedback === 'none') return { 'feedback.label': { $exists: false } };
    if (feedback === 'any') return { 'feedback.label': { $in: [...MODERATION_REVIEW_LABELS] } };
    const agree = [{ 'feedback.label': 'violation', verdict: 'violation' }, { 'feedback.label': 'allow', verdict: { $ne: 'violation' } }];
    const disagree = [{ 'feedback.label': 'violation', verdict: { $ne: 'violation' } }, { 'feedback.label': 'allow', verdict: 'violation' }];
    return { $or: feedback === 'agree' ? agree : disagree };
}

/** The stored id is the plain one or the plain one plus "-YYYYMMDD": an exact match or a bounded range, never a pattern. */
export function modelFilter(model: string): Record<string, unknown> {
    return { $or: [{ model }, { model: { $gte: `${model}-00000000`, $lte: `${model}-99999999` }, $expr: { $eq: [{ $strLenCP: '$model' }, model.length + 9] } }] };
}

export function chatterNameFilter(name: string): Record<string, unknown> {
    const lower = name.toLowerCase();
    // $literal: inside $expr a value starting with "$" would otherwise be read as a field path or a variable.
    return { $or: [{ userLogin: lower }, { username: name }, { $expr: { $eq: [{ $toLower: { $ifNull: ['$username', ''] } }, { $literal: lower }] } }] };
}

export function decisionFilter(filters: DecisionFilters): Record<string, unknown> {
    const and: Record<string, unknown>[] = [];
    if (filters.show) and.push(showFilter(filters.show));
    if (filters.kind) and.push({ mode: filters.kind === 'ai' ? 'semantic' : { $in: ['literal', 'regex'] } });
    // Decisions stored before review sources existed are rule decisions.
    if (filters.source) and.push({ reviewSource: filters.source === 'rule' ? { $in: ['rule', null] } : filters.source });
    if (filters.model) and.push(modelFilter(filters.model));
    if (filters.feedback) and.push(feedbackFilter(filters.feedback));
    if (filters.chatterName) and.push(chatterNameFilter(filters.chatterName));
    return {
        createdAt: { $gte: filters.from, $lte: filters.to },
        ...(filters.channelID !== undefined ? { channelID: filters.channelID ?? { $in: [] } } : {}),
        ...(filters.chatterID ? { userID: filters.chatterID } : {}),
        ...(and.length ? { $and: and } : {})
    };
}

// `_id` last keeps pages stable when many rows tie (same cost, same score).
export const DECISION_SORT_SPECS: Record<DecisionSort, Record<string, 1 | -1>> = {
    newest: { createdAt: -1, _id: -1 },
    cost: { cost: -1, createdAt: -1, _id: -1 },
    score: { 'scores.violation': -1, createdAt: -1, _id: -1 },
    slowest: { latencyMs: -1, createdAt: -1, _id: -1 }
};

const ROW_FIELDS = '_id createdAt channelID userID username userLogin messageText mode ruleID rule.type rule.reason rule.semantic.thresholdPercent '
    + 'reviewSource messageOrdinal verdict status consequence model provider scores inputTokens cost charge.credits latencyMs feedback.label feedback.note feedback.reviewedAt';
const DETAIL_FIELDS = `${ROW_FIELDS} context rule.semantic.broadcasterInvitation rule.semantic.categories`;

// ---- Reads ----

export async function listDecisions(filters: DecisionFilters, sort: DecisionSort, page: { skip: number; limit: number }) {
    const filter = decisionFilter(filters);
    const [docs, total] = await Promise.all([
        ModerationDecision.find(filter).sort(DECISION_SORT_SPECS[sort]).skip(page.skip).limit(page.limit).select(ROW_FIELDS).maxTimeMS(QUERY_MS).lean(),
        ModerationDecision.countDocuments(filter).maxTimeMS(QUERY_MS)
    ]);
    const channels = await channelLogins(docs.map(doc => doc.channelID));
    return { rows: docs.map(doc => mapDecisionRow(doc as Stored, channels)), total };
}

export async function getDecision(id: string): Promise<DecisionDetail | null> {
    const doc = await ModerationDecision.findById(id).select(DETAIL_FIELDS).maxTimeMS(QUERY_MS).lean() as Stored | null;
    if (!doc) return null;
    const [channels, others] = await Promise.all([
        channelLogins([doc.channelID]),
        ModerationDecision.find({ channelID: doc.channelID, userID: doc.userID, _id: { $ne: doc._id } }).sort({ createdAt: -1, _id: -1 }).limit(DECISION_HISTORY_MAX)
            .select('_id createdAt messageText verdict status consequence').maxTimeMS(QUERY_MS).lean()
    ]);
    const context = (Array.isArray(doc.context) ? doc.context : []).map((line: any) => ({
        username: String(line?.username || ''), message: String(line?.message || ''), isBroadcaster: line?.isBroadcaster === true,
        at: typeof line?.timestamp === 'number' && line.timestamp > 0 ? iso(line.timestamp) : null, sortKey: number(line?.timestamp)
    })).sort((a, b) => a.sortKey - b.sortKey).map(({ sortKey: _, ...line }) => line);
    return {
        ...mapDecisionRow(doc, channels),
        context,
        invited: doc.rule?.semantic?.broadcasterInvitation === true,
        categories: Array.isArray(doc.rule?.semantic?.categories) ? doc.rule!.semantic!.categories.map(String) : [],
        history: (others as Stored[]).map(other => ({
            id: String(other._id), at: iso(other.createdAt) || '', messageText: String(other.messageText ?? ''),
            verdict: other.verdict || 'uncertain', outcome: decisionOutcome(other), action: decisionAction(other)
        }))
    };
}

// ---- Summary ----

const isAI = { $eq: ['$mode', 'semantic'] };
const executed = { $eq: ['$consequence.status', 'executed'] };
const ban = { $and: [executed, { $eq: ['$consequence.action', 'ban'] }] };
const succeeded = { $eq: ['$consequence.success', true] };
const notReviewed = { $and: [{ $not: [executed] }, { $in: ['$status', [...NOT_REVIEWED_STATUSES]] }] };
const violation = { $and: [isAI, { $eq: ['$verdict', 'violation'] }] };
const label = { $ifNull: ['$feedback.label', null] };
const labelled = { $in: [label, [...MODERATION_REVIEW_LABELS]] };
const agrees = { $or: [
    { $and: [{ $eq: [label, 'violation'] }, { $eq: ['$verdict', 'violation'] }] },
    { $and: [{ $eq: [label, 'allow'] }, { $ne: ['$verdict', 'violation'] }] }
] };
const finished = { $and: [isAI, { $in: ['$status', ANSWERED_STATUSES] }, { $gt: ['$latencyMs', 0] }] };
const count = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
const usd = { $sum: { $ifNull: ['$cost', 0] } };
const plainModel = { $cond: [{ $regexMatch: { input: '$model', regex: DATE_SUFFIX } }, { $substrCP: ['$model', 0, { $subtract: [{ $strLenCP: '$model' }, 9] }] }, '$model'] };

const roundUSD = (value: unknown) => Math.round(number(value) * 1e9) / 1e9;
const ms = (value: unknown) => Math.round(number(value));
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export async function decisionSummary(filters: Pick<DecisionFilters, 'channelID' | 'chatterID' | 'from' | 'to'>) {
    const match = decisionFilter(filters);
    const [[facets], waiting] = await Promise.all([
        // Mongoose's stage types predate `$percentile` (MongoDB 7.0+; production runs 8.2).
        ModerationDecision.aggregate([
            { $match: match },
            { $facet: {
                totals: [{ $group: {
                    _id: null, total: { $sum: 1 }, aiReviews: count(isAI), ruleHits: count({ $not: [isAI] }), violations: count(violation),
                    bans: count({ $and: [ban, succeeded] }), bansFailed: count({ $and: [ban, { $not: [succeeded] }] }), notReviewed: count(notReviewed),
                    included: count({ $and: [{ $eq: ['$reviewSource', 'first_message'] }, { $eq: [{ $ifNull: ['$charge.credits', 0] }, 0] }] }),
                    providerUSD: usd, credits: { $sum: { $ifNull: ['$charge.credits', 0] } }, channels: { $addToSet: '$channelID' },
                    labelled: count(labelled), agree: count({ $and: [labelled, agrees] }), disagree: count({ $and: [labelled, { $not: [agrees] }] })
                } }, { $set: { channels: { $size: '$channels' } } }],
                latency: [{ $match: { $expr: finished } }, { $group: { _id: null, p: { $percentile: { input: '$latencyMs', p: [0.5, 0.95], method: 'approximate' } } } }],
                daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                    reviews: { $sum: 1 }, violations: count(violation), notReviewed: count(notReviewed), providerUSD: usd } }],
                byModel: [{ $match: { mode: 'semantic', model: { $type: 'string', $ne: '' } } }, { $group: { _id: plainModel,
                    reviews: { $sum: 1 }, violations: count(violation), bans: count({ $and: [ban, succeeded] }), notReviewed: count(notReviewed), providerUSD: usd,
                    latency: { $percentile: { input: { $cond: [finished, '$latencyMs', null] }, p: [0.5], method: 'approximate' } } } },
                { $sort: { reviews: -1, _id: 1 } }],
                byChannel: [{ $group: { _id: '$channelID', reviews: { $sum: 1 }, violations: count(violation), providerUSD: usd } },
                    { $sort: { reviews: -1, _id: 1 } }, { $limit: BYCHANNEL_MAX }]
            } }
        ] as unknown as PipelineStage[]).option({ maxTimeMS: QUERY_MS }),
        moderationReviewCountsCached()
    ]);
    const totals = facets?.totals?.[0] || {};
    const [p50, p95] = facets?.latency?.[0]?.p || [];
    const days = new Map<string, any>((facets?.daily || []).map((row: any) => [row._id, row]));
    const daily: Array<{ date: string; reviews: number; violations: number; notReviewed: number; providerUSD: number }> = [];
    for (let day = Date.UTC(filters.from.getUTCFullYear(), filters.from.getUTCMonth(), filters.from.getUTCDate()); day <= filters.to.getTime(); day += 86_400_000) {
        const date = utcDay(new Date(day));
        const row = days.get(date);
        daily.push({ date, reviews: number(row?.reviews), violations: number(row?.violations), notReviewed: number(row?.notReviewed), providerUSD: roundUSD(row?.providerUSD) });
    }
    const byChannelRows: any[] = facets?.byChannel || [];
    const channels = await channelLogins(byChannelRows.map(row => row._id));
    return {
        from: filters.from.toISOString(), to: filters.to.toISOString(),
        total: number(totals.total), aiReviews: number(totals.aiReviews), ruleHits: number(totals.ruleHits), violations: number(totals.violations),
        bans: number(totals.bans), bansFailed: number(totals.bansFailed), notReviewed: number(totals.notReviewed), included: number(totals.included),
        providerUSD: roundUSD(totals.providerUSD), credits: number(totals.credits),
        latencyP50Ms: ms(p50), latencyP95Ms: ms(p95), channels: number(totals.channels),
        labelled: number(totals.labelled), agree: number(totals.agree), disagree: number(totals.disagree),
        verdictsWaiting: Object.values(waiting).reduce((sum, value) => sum + value, 0),
        daily,
        byModel: (facets?.byModel || []).map((row: any) => ({ model: String(row._id), reviews: number(row.reviews), violations: number(row.violations), bans: number(row.bans),
            notReviewed: number(row.notReviewed), providerUSD: roundUSD(row.providerUSD), latencyP50Ms: ms(row.latency?.[0]) })),
        byChannel: byChannelRows.map(row => ({ channelID: String(row._id), channel: channels.get(String(row._id)) || null,
            reviews: number(row.reviews), violations: number(row.violations), providerUSD: roundUSD(row.providerUSD) }))
    };
}

// ---- The owner's verdict ----

/**
 * Saves (or clears, with `null`) the owner's verdict on exactly one decision, whatever queue it is
 * in or not. Same stored shape as the Review queues (`feedback: null` when cleared, so it waits
 * there again); retention and everything else about the decision stay as they are.
 * Undefined when no decision has that id.
 */
export async function setDecisionFeedback(id: string, label: ModerationReviewLabel | null, note: string | null, reviewerID: string): Promise<{ feedback: DecisionFeedback | null } | undefined> {
    // `$literal`: in a pipeline update a note starting with "$" would otherwise be read as a field path.
    const update = label ? [{ $set: { feedback: { label: { $literal: label }, note: { $literal: note }, reviewerID: { $literal: reviewerID }, reviewedAt: '$$NOW' } } }] : [{ $set: { feedback: null } }];
    const result = await ModerationDecision.collection.findOneAndUpdate({ _id: id } as Record<string, unknown>, update,
        { returnDocument: 'after', projection: { feedback: 1 }, maxTimeMS: QUERY_MS });
    // The "waiting for your verdict" number must follow the owner's own action at once.
    invalidateModerationReviewCounts();
    return result ? { feedback: mapFeedback(result.feedback) } : undefined;
}
