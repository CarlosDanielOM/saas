/**
 * Durable per-turn log of the Dima assistant (`site_agent_turn_logs`, 90 days): one row per finished turn, so the
 * operator can see use, cost and errors, and read the exchange to help and debug, after the 72-hour chat is gone.
 *
 * Chats are private between the person and DomDimaBot's operators (`SITE_AGENT.md`): the row keeps the message,
 * the steers, the answer and each tool's arguments and result as text, scrubbed of credentials and e-mail addresses
 * (`scrubSensitive`) and clipped. It never keeps proposal payloads, undo data, submitted form values or page titles.
 * `toTurnLog` is the only place a `TurnRecord` becomes a row, and it copies fields one by one so new turn fields
 * never leak in by accident.
 *
 * Writing never breaks or delays a turn: the runner calls `writeTurnLog` without waiting, and every function here
 * that writes catches and logs its own failures. The row is written once (insert only), after the turn ended, and
 * only while both the channel's and the requester's accounts exist. What arrives meanwhile is merged when it is
 * written: the person's rating (read from its Dragonfly key) and costs reconciled later (kept per step until they
 * are on the row; each step's key is recorded on the row, so a step is added once and never lost).
 */
import UsersSchema from '../schemas/users.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { warn } from '../utils/logger.js';
import { scrubMaybeJson, scrubSensitive } from '../utils/scrub_text.js';
import { levelConfig } from './config.js';
import * as store from './store.js';
import {
    SiteAgentTurnLog, TURN_LOG_ANSWER_MAX, TURN_LOG_MAX_TOOLS, TURN_LOG_MESSAGE_MAX, TURN_LOG_RETENTION_DAYS, TURN_LOG_STEER_MAX, TURN_LOG_STEERS_MAX,
    TURN_LOG_TEXT_DAYS, TURN_LOG_TOOL_TEXT_MAX, type ISiteAgentTurnLog,
} from './turn_log.schema.js';
import type { DisplayItem, LlmUsage, TurnStatus } from './types.js';

const QUERY_MS = 8_000;
/** What a submitted form's result is stored as: the values are the person's input to a page the model wrote. */
export const FORM_SUBMITTED = '[form submitted]';
/** Reconciled costs not yet on their row wait here (hash per turn: step key → step), at most this long. */
const LATE_TTL_SECONDS = 86_400;
const lateKey = (turnId: string) => `site_agent:turnlog:late:${turnId}`;
/** Turns with costs waiting, for the periodic retry: a sorted set scored by the next attempt's time (ms). */
const LATE_INDEX = 'site_agent:turnlog:late';
/** A visited turn goes to the back of the retry order for this long. */
const LATE_RETRY_MS = 30_000;
/** When the running retry pass started (0 = none), and how long it may run before another may start. */
let retryStartedAt = 0;
const RETRY_STUCK_MS = 300_000;
/** Removes a turn from the retry index only while it has no waiting step, in one step (no window for a new one). */
const UNINDEX_IF_EMPTY = `if redis.call('EXISTS', KEYS[1]) == 0 then return redis.call('ZREM', KEYS[2], ARGV[1]) end return 0`;
/** Tool text larger than this is cut before the structural scrub (turn records keep at most 20,000 characters). */
const TOOL_SCRUB_WINDOW = 65_536;
/** The person's rating (written by `usage.recordFeedback`). */
export const feedbackKey = (turnId: string) => `site_agent:feedback:${turnId}`;
/** Second deletion pass after an account is deleted, for rows whose write was already in flight. */
const PURGE_SWEEP_MS = 15_000;

export type ModelCost = ISiteAgentTurnLog['modelCosts'][number];

export interface TurnLogExtras {
    /** Models that answered steps, as the runner saw them; missing when another process ran the turn. */
    models?: readonly string[];
    /** What each model cost in this turn, as the runner saw it; missing when another process ran the turn. */
    modelCosts?: readonly ModelCost[];
    channelLogin?: string;
    /** What the assistant wrote back in this turn (its display items); '' when unknown. */
    answer?: string;
    /**
     * Tool names come from the model, which can invent one; only names of real tools are kept, others become
     * `unknown_tool`, so no model-written text reaches the log through a name.
     */
    knownTool: (name: string) => boolean;
}

async function logFailure(fn: string, message: string, err: unknown, channelId?: string): Promise<void> {
    try {
        await warn({ function: `siteAgent.turnLog.${fn}`, message, error: err instanceof Error ? err.message : String(err) },
            { destination: 'console', ...(channelId ? { channelId } : {}) });
    } catch {
        // Logging must never break the agent loop.
    }
}

/** First `max` code points of `text` (never splits a surrogate pair). */
export function clipText(text: unknown, max: number): string {
    if (typeof text !== 'string' || !text) return '';
    // Fewer UTF-16 units than the limit means fewer code points too.
    if (text.length <= max) return text;
    let end = 0;
    let points = 0;
    for (const point of text) {
        if (points === max) return text.slice(0, end);
        end += point.length;
        points++;
    }
    return text;
}

/** Scrubbed, then clipped: the scrub sees a wider window than is kept, so a secret across the cut is still masked. */
export function safeClip(text: unknown, max: number): string {
    return clipText(scrubSensitive(clipText(text, max * 2)), max);
}

/**
 * Tool arguments and results are often JSON: scrubbed by key name as well as by shape (`scrubMaybeJson`), on the
 * whole text so the JSON still parses, then clipped (the clipped text need not be valid JSON).
 */
export function safeToolText(text: unknown, max: number): string {
    return clipText(scrubMaybeJson(clipText(text, TOOL_SCRUB_WINDOW)), max);
}

const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
const usd = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value * 1e9) / 1e9) : 0);

/** True when our own failure ended the turn before any answer: the runner gave every message back. */
export function wasRefunded(turn: Pick<store.TurnRecord, 'status' | 'answeredSteps' | 'steps'>): boolean {
    return turn.status === 'failed' && (turn.answeredSteps ?? turn.steps) === 0;
}

/** Daily messages the turn used: its own price (move fee included), steers and the Expert fallback charge. */
export function turnUnits(turn: store.TurnRecord): number {
    if (wasRefunded(turn)) return 0;
    let units = turn.countedDay ? whole(turn.cost ?? 1) : 0;
    units += whole(turn.extraCharged);
    for (const input of turn.inputs) if (input.countedDay) units += whole(input.cost ?? 1);
    return units;
}

/**
 * Models in order of first use. Without the runner's own list (the turn was finished by another process), it is
 * rebuilt from the level: a turn that fell back ran Expert, then Standard; a turn with no step ran none.
 */
export function turnModels(turn: store.TurnRecord, seen?: readonly string[]): string[] {
    if (seen?.length) return [...new Set(seen)];
    const answered = turn.steps > 0 || turn.fellBack;
    if (!answered) return [];
    const first = levelConfig(turn.plan, turn.level).model;
    const models = [first];
    if (turn.fellBack) models.push(levelConfig(turn.plan, 'standard').model);
    return [...new Set(models)];
}

/**
 * Cost per model. Without the runner's own figures the split is only known for a single-model turn (all of it);
 * a turn that ran two models gets none, rather than a guess.
 */
export function turnModelCosts(turn: store.TurnRecord, models: readonly string[], seen?: readonly ModelCost[]): ModelCost[] {
    if (seen?.length) return seen.map((entry) => ({ model: entry.model, steps: whole(entry.steps), costUsd: usd(entry.costUsd) }));
    if (models.length !== 1) return [];
    return [{ model: models[0], steps: whole(turn.steps), costUsd: usd(turn.usage.costUsd) }];
}

function toolResult(call: store.CallRecord): string {
    // A form's result carries what the person typed into it: kept as a marker only.
    if (call.ui) return call.state === 'done' ? FORM_SUBMITTED : '';
    return safeToolText(call.result, TURN_LOG_TOOL_TEXT_MAX);
}

export function toTurnLog(turn: store.TurnRecord, extras: TurnLogExtras, now = Date.now()): ISiteAgentTurnLog {
    const endedAt = turn.endedAt ?? null;
    const end = endedAt ?? now;
    const models = turnModels(turn, extras.models);
    return {
        _id: turn.id,
        at: new Date(turn.createdAt),
        endedAt: endedAt === null ? null : new Date(endedAt),
        channelId: turn.channelId,
        channelLogin: extras.channelLogin ?? '',
        user: { id: turn.userId, login: turn.userLogin, name: turn.userDisplayName, role: turn.role },
        plan: turn.plan,
        level: turn.level ?? 'standard',
        fellBack: Boolean(turn.fellBack),
        models,
        modelCosts: turnModelCosts(turn, models, extras.modelCosts),
        status: turn.status,
        errorCode: turn.errorCode ?? '',
        lang: turn.lang,
        pageRoute: turn.page?.route ?? '',
        message: safeClip(turn.userMessage, TURN_LOG_MESSAGE_MAX),
        steers: turn.inputs.slice(-TURN_LOG_STEERS_MAX).map((input) => safeClip(input.text, TURN_LOG_STEER_MAX)),
        answer: safeClip(extras.answer, TURN_LOG_ANSWER_MAX),
        steps: whole(turn.steps),
        // Only the arguments and result text: never the proposal payload, undo data or form values.
        tools: turn.calls.slice(0, TURN_LOG_MAX_TOOLS).map((call) => ({
            name: extras.knownTool(call.name) ? call.name : 'unknown_tool',
            state: call.state,
            ms: call.endedAt !== undefined ? Math.max(0, call.endedAt - call.startedAt) : null,
            approval: call.approval?.state ?? null,
            args: safeToolText(call.args, TURN_LOG_TOOL_TEXT_MAX),
            result: toolResult(call),
        })),
        units: turnUnits(turn),
        promptTokens: whole(turn.usage.promptTokens),
        cachedTokens: whole(turn.usage.cachedTokens),
        completionTokens: whole(turn.usage.completionTokens),
        reasoningTokens: whole(turn.usage.reasoningTokens),
        costUsd: usd(turn.usage.costUsd),
        unknownCostSteps: whole(turn.usage.unknownSteps),
        durationMs: Math.max(0, end - turn.createdAt),
        activeMs: whole(turn.activeMs),
        feedback: null,
        reconciledSteps: [],
        textCleared: false,
        expiresAt: new Date(turn.createdAt + TURN_LOG_RETENTION_DAYS * 86_400_000),
    };
}

/** The assistant's text items of this turn, in order, joined with a blank line ('' when the chat is gone). */
export async function readTurnAnswer(turn: Pick<store.TurnRecord, 'id' | 'sessionId'>): Promise<string> {
    const { items } = await store.snapshot(turn.sessionId, null);
    return items.filter((item): item is Extract<DisplayItem, { kind: 'assistant' }> => item.kind === 'assistant' && item.turnId === turn.id && Boolean(item.text.trim()))
        .map((item) => item.text.trim()).join('\n\n');
}

async function savedRating(turnId: string): Promise<'helpful' | 'unhelpful' | null> {
    const rating = await (await getDragonflyClient('site-agent-turn-log')).hGet(feedbackKey(turnId), 'rating');
    return rating === 'helpful' || rating === 'unhelpful' ? rating : null;
}

const accountExists = async (twitchId: string) => Boolean(await UsersSchema.exists({ accounts: { $elemMatch: { type: 'twitch', id: twitchId } } }));

/**
 * A deleted account's turns must not come back through a write that was already under way: neither the channel's,
 * nor a manager's on a channel that still exists.
 */
async function accountsExist(turn: Pick<store.TurnRecord, 'channelId' | 'userId'>): Promise<boolean> {
    if (!await accountExists(turn.channelId)) return false;
    return turn.userId === turn.channelId || accountExists(turn.userId);
}

/**
 * Inserts the row of a finished turn, once (by turn id, so finishing twice writes one row and never overwrites
 * costs or a rating added since). Then merges what arrived while it was being written. Never throws.
 */
export async function writeTurnLog(turn: store.TurnRecord, extras: TurnLogExtras): Promise<void> {
    let answer = '';
    try {
        answer = await readTurnAnswer(turn);
    } catch (err) {
        await logFailure('answer', 'Could not read the answer for the turn log row; saved without it', err, turn.channelId);
    }
    try {
        const rating = await savedRating(turn.id).catch(() => null);
        if (!await accountsExist(turn)) return;
        const { _id, ...fields } = toTurnLog(turn, { ...extras, answer });
        await SiteAgentTurnLog.updateOne({ _id }, { $setOnInsert: { ...fields, feedback: rating } }, { upsert: true });
        await applyLateSteps(_id);
        // Rated between the read above and the insert: its own update found no row.
        if (!rating) {
            const later = await savedRating(_id);
            if (later) await SiteAgentTurnLog.updateOne({ _id, feedback: null }, { $set: { feedback: later } });
        }
    } catch (err) {
        await logFailure('write', 'Could not write the turn log row', err, turn.channelId);
    }
}

/** Puts a helpful/unhelpful rating on the turn's row (no row yet: the writer picks it up). Never throws. */
export async function setTurnLogFeedback(turnId: string, rating: 'helpful' | 'unhelpful'): Promise<void> {
    try {
        await SiteAgentTurnLog.updateOne({ _id: turnId }, { $set: { feedback: rating } });
    } catch (err) {
        await logFailure('feedback', 'Could not save the rating on the turn log row', err);
    }
}

interface LateStep { model: string; costUsd: number; promptTokens: number; cachedTokens: number; completionTokens: number; reasoningTokens: number }
/** 'applied' = this call added it; 'listed' = the row already has it; 'waiting' = not on a row yet (keep it). */
type StepOutcome = 'applied' | 'listed' | 'waiting';

/**
 * Adds one reconciled step to the row, on its model's cost when the row has that model, and records its key. The
 * filter requires the key to be absent, so a repeat of the same step is a no-op.
 */
async function updateRow(turnId: string, key: string, step: LateStep): Promise<boolean> {
    const result = await SiteAgentTurnLog.updateOne({ _id: turnId, unknownCostSteps: { $gt: 0 }, reconciledSteps: { $ne: key } }, {
        $inc: {
            costUsd: step.costUsd, promptTokens: step.promptTokens, cachedTokens: step.cachedTokens, completionTokens: step.completionTokens,
            reasoningTokens: step.reasoningTokens, unknownCostSteps: -1, 'modelCosts.$[m].costUsd': step.costUsd,
        },
        $push: { reconciledSteps: key },
    }, { arrayFilters: [{ 'm.model': step.model }], maxTimeMS: 5000 });
    return result.matchedCount > 0;
}

const rowListsKey = async (turnId: string, key: string) => Boolean(await SiteAgentTurnLog.exists({ _id: turnId, reconciledSteps: key }));

/**
 * A step is done only when its key is on the row: added now, or already there. A row that appeared after the first
 * miss gets one more try; otherwise the step keeps waiting.
 */
async function applyStep(turnId: string, key: string, step: LateStep): Promise<StepOutcome> {
    if (await updateRow(turnId, key, step)) return 'applied';
    if (await rowListsKey(turnId, key)) return 'listed';
    if (!await SiteAgentTurnLog.exists({ _id: turnId })) return 'waiting';
    if (await updateRow(turnId, key, step)) return 'applied';
    return await rowListsKey(turnId, key) ? 'listed' : 'waiting';
}

/**
 * Applies the steps waiting for this turn's row. An entry is removed only after its key is on the row; while the
 * row is missing, or when Mongo fails, it stays for the next try. The turn leaves the retry index only when nothing
 * waits (checked and removed atomically, so a step added meanwhile keeps it there).
 */
async function applyLateSteps(turnId: string): Promise<void> {
    const redis = await getDragonflyClient('site-agent-turn-log');
    const waiting = await redis.hGetAll(lateKey(turnId));
    for (const [key, json] of Object.entries(waiting ?? {})) {
        try {
            if (await applyStep(turnId, key, JSON.parse(json) as LateStep) !== 'waiting') await redis.hDel(lateKey(turnId), key);
        } catch (err) {
            await logFailure('late', 'Could not add a waiting reconciled step to the turn log; kept for a retry', err);
        }
    }
    await unindexIfEmpty(turnId);
}

async function unindexIfEmpty(turnId: string): Promise<void> {
    const redis = await getDragonflyClient('site-agent-turn-log');
    await redis.eval(UNINDEX_IF_EMPTY, { keys: [lateKey(turnId), LATE_INDEX], arguments: [turnId] });
}

/**
 * A step whose cost was unknown (aborted, or the stream failed after it started) got its real usage later. `key`
 * identifies the step (its Polar external id). It goes on the turn's row; while the row is not written yet (the turn
 * still runs, or its write is under way), or Mongo fails, it waits in a per-turn hash that the writer applies after
 * the insert and `retryLateSteps` applies later. Never throws.
 */
export async function addReconciledStep(turnId: string, key: string, usage: LlmUsage, costUsd: number | null, model: string): Promise<void> {
    if (costUsd === null) return;
    const step: LateStep = {
        model, costUsd: usd(costUsd), promptTokens: whole(usage.promptTokens), cachedTokens: whole(usage.cachedTokens),
        completionTokens: whole(usage.completionTokens), reasoningTokens: whole(usage.reasoningTokens),
    };
    try {
        if (await applyStep(turnId, key, step) !== 'waiting') return;
    } catch (err) {
        await logFailure('reconcile', 'Could not add a reconciled step to the turn log; kept for a retry', err);
    }
    try {
        const redis = await getDragonflyClient('site-agent-turn-log');
        // The step and its index entry are written together; an existing entry keeps its place in the retry order.
        await redis.multi()
            .hSet(lateKey(turnId), key, JSON.stringify(step)).expire(lateKey(turnId), LATE_TTL_SECONDS)
            .zAdd(LATE_INDEX, { score: Date.now(), value: turnId }, { condition: 'NX' }).expire(LATE_INDEX, LATE_TTL_SECONDS)
            .exec();
        // The row may have been inserted after the first look, and its writer may already have applied the hash.
        if (await SiteAgentTurnLog.exists({ _id: turnId })) await applyLateSteps(turnId);
    } catch (err) {
        await logFailure('reconcile', 'Could not keep a reconciled step for later', err);
    }
}

/**
 * Retries waiting steps (after a Mongo failure, or a row written late). Takes at most `limit` turns that are due,
 * oldest attempt first, and moves each to the back before working on it, so turns whose row never comes cannot
 * hold the others back. Called from the runner's maintenance timer. Never throws.
 */
export async function retryLateSteps(limit = 50, now = Date.now()): Promise<void> {
    // One pass at a time: when the database stalls, the timer must not pile passes on top of each other. A pass
    // that has not come back after five minutes no longer holds the next one.
    if (retryStartedAt && Date.now() - retryStartedAt < RETRY_STUCK_MS) return;
    const mine = retryStartedAt = Date.now();
    try {
        const redis = await getDragonflyClient('site-agent-turn-log');
        const turnIds = await redis.zRangeByScore(LATE_INDEX, '-inf', now, { LIMIT: { offset: 0, count: limit } });
        for (const turnId of turnIds) {
            await redis.zAdd(LATE_INDEX, { score: now + LATE_RETRY_MS, value: turnId }, { condition: 'XX' });
            if (!await redis.exists(lateKey(turnId))) await unindexIfEmpty(turnId);
            else if (await SiteAgentTurnLog.exists({ _id: turnId })) await applyLateSteps(turnId);
        }
    } catch (err) {
        await logFailure('retry', 'Could not retry waiting reconciled steps', err);
    } finally {
        if (retryStartedAt === mine) retryStartedAt = 0;
    }
}

/**
 * Clears the conversation text of rows older than `TURN_LOG_TEXT_DAYS` days: the dashboard tells people their
 * chat is kept for 3 days, so the operator's copy of what was said must not outlive that. The numbers stay.
 * Runs on the runner's maintenance timer; reads only rows whose text is still there (`text_pending_at`).
 * Never throws.
 */
export async function clearExpiredTurnText(now = Date.now()): Promise<number> {
    try {
        const result = await SiteAgentTurnLog.updateMany(
            { textCleared: false, at: { $lt: new Date(now - TURN_LOG_TEXT_DAYS * 86_400_000) } },
            { $set: { message: '', steers: [], answer: '', 'tools.$[].args': '', 'tools.$[].result': '', textCleared: true } },
            { maxTimeMS: 5000 }
        );
        return result.modifiedCount ?? 0;
    } catch (error) {
        console.warn('[site-agent] turn log text sweep failed', error instanceof Error ? error.message : 'unknown error');
        return 0;
    }
}

/**
 * Account deletion: the channel's rows, and this person's rows on channels they manage. A second pass a little
 * later removes rows whose write was already under way.
 */
export async function deleteTurnLogs(channelId: string): Promise<number> {
    const filter = { $or: [{ channelId }, { 'user.id': channelId }] };
    const result = await SiteAgentTurnLog.deleteMany(filter);
    const sweep = setTimeout(() => { SiteAgentTurnLog.deleteMany(filter).catch(() => undefined); }, PURGE_SWEEP_MS);
    sweep.unref?.();
    return result.deletedCount ?? 0;
}

// ---------------------------------------------------------------------------
// Readers (owner-only admin API)
// ---------------------------------------------------------------------------

export type TurnLogStatusFilter = 'completed' | 'cancelled' | 'problems';
export type TurnLogSort = 'newest' | 'cost' | 'slowest';
export type TurnLogRow = ISiteAgentTurnLog;
/** A list row: the question preview instead of the full text, tools without their text. */
export type TurnLogListRow = Omit<TurnLogRow, 'message' | 'steers' | 'answer' | 'tools' | 'expiresAt'> & {
    question: string;
    tools: Omit<TurnLogRow['tools'][number], 'args' | 'result'>[];
};
export const QUESTION_PREVIEW_MAX = 300;

export interface TurnLogQuery {
    from: Date;
    to: Date;
    channelId?: string;
    userId?: string;
    status?: TurnLogStatusFilter;
    level?: 'standard' | 'expert';
    sort: TurnLogSort;
    skip: number;
    limit: number;
}

const PROBLEMS: TurnStatus[] = ['failed', 'interrupted'];

function rangeFilter(from: Date, to: Date, channelId?: string): Record<string, unknown> {
    return { at: { $gte: from, $lte: to }, ...(channelId ? { channelId } : {}) };
}

/** Only what the list shows: the text stays in Mongo (rows can be ~50 KB each). */
const LIST_PROJECTION = {
    at: 1, endedAt: 1, channelId: 1, channelLogin: 1, user: 1, plan: 1, level: 1, fellBack: 1, models: 1, status: 1, errorCode: 1, lang: 1, pageRoute: 1,
    steps: 1, 'tools.name': 1, 'tools.state': 1, 'tools.ms': 1, 'tools.approval': 1, units: 1, promptTokens: 1, cachedTokens: 1, completionTokens: 1,
    reasoningTokens: 1, costUsd: 1, unknownCostSteps: 1, durationMs: 1, activeMs: 1, feedback: 1, textCleared: 1,
    // Code points, like the writer's clipping; a row from before text was kept has no message ('' here).
    question: { $substrCP: [{ $ifNull: ['$message', ''] }, 0, QUESTION_PREVIEW_MAX] },
} as const;

/** Uses `{channelId, at}`, `{user.id, at}` or `{at}`; cost/slowest sort the window in memory (bounded by the range). */
export async function listTurnLogs(query: TurnLogQuery): Promise<{ rows: TurnLogListRow[]; total: number }> {
    const filter: Record<string, unknown> = rangeFilter(query.from, query.to, query.channelId);
    if (query.userId) filter['user.id'] = query.userId;
    if (query.status === 'problems') filter.status = { $in: PROBLEMS };
    else if (query.status) filter.status = query.status;
    if (query.level) filter.level = query.level;
    const sort: Record<string, 1 | -1> = query.sort === 'cost' ? { costUsd: -1, at: -1, _id: -1 }
        : query.sort === 'slowest' ? { durationMs: -1, at: -1, _id: -1 } : { at: -1, _id: -1 };
    const [rows, total] = await Promise.all([
        SiteAgentTurnLog.find(filter, LIST_PROJECTION).sort(sort).skip(query.skip).limit(query.limit).maxTimeMS(QUERY_MS).lean<TurnLogListRow[]>(),
        SiteAgentTurnLog.countDocuments(filter).maxTimeMS(QUERY_MS),
    ]);
    return { rows, total };
}

export interface TurnLogBreakdowns {
    channels: number;
    people: number;
    byLevel: { level: 'standard' | 'expert'; turns: number; failed: number; costUsd: number; avgDurationMs: number }[];
    byModel: { model: string; turns: number; costUsd: number }[];
    byChannel: { channelId: string; channelLogin: string; plan: string; turns: number; failed: number; cancelled: number; units: number; costUsd: number; lastAt: Date }[];
    byTool: { name: string; calls: number; failed: number }[];
    errors: { code: string; count: number; lastAt: Date }[];
}

/** Channels listed in `byChannel` (most turns first). */
export const BY_CHANNEL_MAX = 100;

const failedExpr = { $cond: [{ $in: ['$status', PROBLEMS] }, 1, 0] };

/** One aggregation over the range (index `{at}` or `{channelId, at}`). */
export async function summarizeTurnLogs(from: Date, to: Date, channelId?: string): Promise<TurnLogBreakdowns> {
    const [facets] = await SiteAgentTurnLog.aggregate<{
        people: { n: number }[]; channels: { n: number }[];
        byLevel: { _id: 'standard' | 'expert'; turns: number; failed: number; costUsd: number; avgDurationMs: number }[];
        byModel: { _id: string; turns: number; costUsd: number }[];
        byChannel: { _id: string; channelLogin: string; plan: string; turns: number; failed: number; cancelled: number; units: number; costUsd: number; lastAt: Date }[];
        byTool: { _id: string; calls: number; failed: number }[];
        errors: { _id: string; count: number; lastAt: Date }[];
    }>([
        { $match: rangeFilter(from, to, channelId) },
        { $sort: { at: -1 } },
        { $facet: {
            people: [{ $group: { _id: '$user.id' } }, { $count: 'n' }],
            channels: [{ $group: { _id: '$channelId' } }, { $count: 'n' }],
            byLevel: [{ $group: { _id: '$level', turns: { $sum: 1 }, failed: { $sum: failedExpr }, costUsd: { $sum: '$costUsd' }, avgDurationMs: { $avg: '$durationMs' } } }],
            // Each model's own cost. Rows from before `modelCosts`: a single model takes the turn's cost; a turn
            // that ran two counts for both with no cost (the split was never recorded).
            byModel: [
                { $project: { parts: { $cond: [{ $gt: [{ $size: { $ifNull: ['$modelCosts', []] } }, 0] }, '$modelCosts', {
                    $map: { input: { $ifNull: ['$models', []] }, as: 'model', in: { model: '$$model', costUsd: { $cond: [{ $eq: [{ $size: '$models' }, 1] }, '$costUsd', 0] } } },
                }] } } },
                { $unwind: '$parts' },
                { $group: { _id: '$parts.model', turns: { $sum: 1 }, costUsd: { $sum: '$parts.costUsd' } } },
                { $sort: { turns: -1, _id: 1 } },
            ],
            byChannel: [
                // Sorted newest first above, so $first is the latest login and plan.
                { $group: { _id: '$channelId', channelLogin: { $first: '$channelLogin' }, plan: { $first: '$plan' }, turns: { $sum: 1 }, failed: { $sum: failedExpr },
                    cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } }, units: { $sum: '$units' }, costUsd: { $sum: '$costUsd' }, lastAt: { $max: '$at' } } },
                { $sort: { turns: -1, _id: 1 } }, { $limit: BY_CHANNEL_MAX },
            ],
            byTool: [{ $unwind: '$tools' }, { $group: { _id: '$tools.name', calls: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ['$tools.state', 'error'] }, 1, 0] } } } },
                { $sort: { calls: -1, _id: 1 } }],
            errors: [{ $match: { errorCode: { $ne: '' } } }, { $group: { _id: '$errorCode', count: { $sum: 1 }, lastAt: { $max: '$at' } } }, { $sort: { count: -1, _id: 1 } }],
        } },
    ]).option({ maxTimeMS: QUERY_MS });
    return {
        people: facets?.people[0]?.n ?? 0,
        channels: facets?.channels[0]?.n ?? 0,
        byLevel: (facets?.byLevel ?? []).map(({ _id, ...rest }) => ({ level: _id, ...rest })).sort((a, b) => a.level.localeCompare(b.level)),
        byModel: (facets?.byModel ?? []).map(({ _id, ...rest }) => ({ model: _id, ...rest })),
        byChannel: (facets?.byChannel ?? []).map(({ _id, ...rest }) => ({ channelId: _id, ...rest })),
        byTool: (facets?.byTool ?? []).map(({ _id, ...rest }) => ({ name: _id, ...rest })),
        errors: (facets?.errors ?? []).map(({ _id, ...rest }) => ({ code: _id, ...rest })),
    };
}

/** One whole row by turn id, or null. */
export async function getTurnLog(id: string): Promise<Omit<TurnLogRow, 'expiresAt'> | null> {
    return SiteAgentTurnLog.findById(id).select('-expiresAt').maxTimeMS(QUERY_MS).lean<Omit<TurnLogRow, 'expiresAt'> | null>();
}

/** When the first row still kept was written (index `{at}`), or null. */
export async function oldestTurnLogAt(): Promise<Date | null> {
    const row = await SiteAgentTurnLog.findOne({}).sort({ at: 1 }).select('at').maxTimeMS(QUERY_MS).lean<{ at: Date } | null>();
    return row?.at ?? null;
}
