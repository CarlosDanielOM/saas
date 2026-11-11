/**
 * Site agent usage: daily totals in Dragonfly and one Polar `ai_assistant` event per model step.
 *
 * The assistant is free: events are named `ai_assistant` (the AI-credits meter only counts
 * `ai_usage`), carry no `credits`, and never touch the local credit balance or usage receipts.
 * Nothing here throws into the agent loop: failures are logged, Polar events are kept in a
 * bounded retry list (`drainPolarRetries`).
 *
 * Aborted steps have no usage in the stream. The runner queues them (`queueReconcile`) and
 * `drainReconcile` records them once OpenRouter's /generation knows the cost (or as unknown).
 */
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { error, warn } from '../utils/logger.js';
import { ingestPolarNamedEvents, type PolarNamedEvent } from '../utils/polarsh.js';
import { SITE_AGENT_KEYS } from './config.js';
import { effectiveCostUsd, estimateUsageCost } from './llm/cost.js';
import { RECONCILE_SCHEDULE_MS, reconcileGeneration } from './llm/openrouter.js';
import type { LlmUsage, PlanTier, TurnStatus } from './types.js';

export const POLAR_EVENT_NAME = 'ai_assistant';

const STATS_TTL_SECONDS = 120 * 86_400;
const FEEDBACK_TTL_SECONDS = 30 * 86_400;
const POLAR_TIMEOUT_MS = 5_000;
const POLAR_RETRY_KEY = 'site_agent:polar:retry';
const POLAR_RETRY_TTL_SECONDS = 7 * 86_400;
const POLAR_RETRY_MAX = 5_000;
const RECONCILE_TTL_SECONDS = 86_400;
const RECONCILE_MAX = 5_000;

const day = (at = new Date()) => at.toISOString().slice(0, 10);
const statsKey = () => SITE_AGENT_KEYS.stats(day());
const feedbackKey = (turnId: string) => `site_agent:feedback:${turnId}`;

export type StepKind = 'step' | 'compaction';
export type CostSource = LlmUsage['source'];

export interface StepUsageRecord {
    channelId: string;
    plan: PlanTier;
    sessionId: string;
    turnId: string;
    /**
     * Step within the turn. A number gets `c` in front for compactions; a string is used as given
     * (the caller keeps it unique per turn). Part of the Polar external id, so keep it stable on retries.
     */
    step: number | string;
    model: string;
    /** null = the provider never told us (counted as cost_unknown). */
    usage: LlmUsage | null;
    requesterId: string;
    kind: StepKind;
}

export interface TurnUsageRecord {
    channelId: string;
    plan: PlanTier;
    status: TurnStatus;
    steps: number;
    toolCalls: number;
    durationMs: number;
    /** True when the turn used one of the channel's daily messages. */
    counted: boolean;
}

export interface ReconcileJob extends Omit<StepUsageRecord, 'usage'> {
    generationId: string;
}

interface QueuedReconcile extends ReconcileJob {
    queuedAt: number;
    attempt: number;
}

interface QueuedPolarEvent {
    event: PolarNamedEvent;
    attempts: number;
}

export interface StepRecordResult {
    costUsd: number | null;
    costSource: CostSource;
    polar: 'sent' | 'queued' | 'skipped';
}

async function logFailure(fn: string, message: string, err: unknown, channelId?: string): Promise<void> {
    try {
        await warn({ function: `siteAgent.usage.${fn}`, message, error: err instanceof Error ? err.message : String(err) },
            { destination: 'console', ...(channelId ? { channelId } : {}) });
    } catch {
        // Logging must never break the agent loop.
    }
}

const micro = (usd: number) => Math.round(usd * 1_000_000);
const roundUsd = (usd: number) => Math.round(usd * 1e9) / 1e9;

/** External id Polar dedupes on; compactions get their own so they never collide with a step. */
export function polarExternalId(turnId: string, step: number | string, kind: StepKind): string {
    return `site_agent:${turnId}:${typeof step === 'number' && kind === 'compaction' ? `c${step}` : step}`;
}

export function buildPolarEvent(record: StepUsageRecord, customerId: string, usage: LlmUsage | null, costUsd: number | null, costSource: CostSource): PolarNamedEvent {
    const metadata: PolarNamedEvent['metadata'] = {
        model: record.model,
        prompt_tokens: usage?.promptTokens ?? 0,
        cached_tokens: usage?.cachedTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        reasoning_tokens: usage?.reasoningTokens ?? 0,
        cost_source: costSource,
        plan: record.plan,
        session_id: record.sessionId,
        turn_id: record.turnId,
        step: record.step,
        requester_id: record.requesterId,
        kind: record.kind,
    };
    // Polar metadata has no null: an unknown cost is left out (cost_source says 'unknown').
    if (costUsd !== null) metadata.cost_usd = roundUsd(costUsd);
    return { name: POLAR_EVENT_NAME, customerId, externalId: polarExternalId(record.turnId, record.step, record.kind), metadata };
}

async function customerIdFor(channelId: string): Promise<string | null> {
    const account = await TwitchStreamers.getTwitchAccountById(channelId);
    const id = account?.polar_sh_customer_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function queuePolarRetry(events: QueuedPolarEvent[]): Promise<void> {
    if (!events.length) return;
    const redis = await getDragonflyClient('site-agent-usage');
    await redis.multi()
        .rPush(POLAR_RETRY_KEY, events.map((item) => JSON.stringify(item)))
        .lTrim(POLAR_RETRY_KEY, -POLAR_RETRY_MAX, -1)
        .expire(POLAR_RETRY_KEY, POLAR_RETRY_TTL_SECONDS)
        .exec();
}

/** Records one model call (step or compaction): daily totals, then the Polar event. Never throws. */
export async function recordStep(record: StepUsageRecord): Promise<StepRecordResult> {
    const usage = record.usage ? estimateUsageCost(record.model, record.usage) : null;
    const costUsd = effectiveCostUsd(usage);
    const costSource: CostSource = usage && costUsd !== null ? usage.source : 'unknown';

    try {
        const redis = await getDragonflyClient('site-agent-usage');
        const key = statsKey();
        const tx = redis.multi()
            .hIncrBy(key, record.kind === 'compaction' ? 'compactions' : 'steps', 1)
            .hIncrBy(key, `plan_${record.plan}_steps`, 1)
            .hIncrBy(key, 'prompt_tokens', usage?.promptTokens ?? 0)
            .hIncrBy(key, 'cached_tokens', usage?.cachedTokens ?? 0)
            .hIncrBy(key, 'completion_tokens', usage?.completionTokens ?? 0)
            .hIncrBy(key, 'reasoning_tokens', usage?.reasoningTokens ?? 0)
            .hIncrBy(key, 'cost_micro_usd', costUsd === null ? 0 : micro(costUsd));
        if (costSource === 'estimated') tx.hIncrBy(key, 'cost_estimated_steps', 1);
        if (costUsd === null) tx.hIncrBy(key, 'cost_unknown_steps', 1);
        await tx.expire(key, STATS_TTL_SECONDS).exec();
    } catch (err) {
        await logFailure('recordStep', 'Could not record step stats', err, record.channelId);
    }

    let event: PolarNamedEvent | null = null;
    try {
        const customerId = await customerIdFor(record.channelId);
        if (!customerId) return { costUsd, costSource, polar: 'skipped' };
        event = buildPolarEvent(record, customerId, usage, costUsd, costSource);
        await withTimeout(ingestPolarNamedEvents([event]), POLAR_TIMEOUT_MS);
        return { costUsd, costSource, polar: 'sent' };
    } catch (err) {
        await logFailure('recordStep', 'Polar ai_assistant event failed; kept for retry', err, record.channelId);
        if (!event) return { costUsd, costSource, polar: 'skipped' };
        try {
            await queuePolarRetry([{ event, attempts: 1 }]);
            return { costUsd, costSource, polar: 'queued' };
        } catch (queueErr) {
            await error({ function: 'siteAgent.usage.recordStep', message: 'Lost a Polar ai_assistant event',
                externalId: event.externalId, error: queueErr instanceof Error ? queueErr.message : String(queueErr) },
            { destination: 'console', channelId: record.channelId }).catch(() => {});
            return { costUsd, costSource, polar: 'skipped' };
        }
    }
}

/**
 * Re-sends Polar events that failed earlier (external ids make repeats harmless). Returns how many
 * were sent; on failure they go back to the list.
 */
export async function drainPolarRetries(limit = 100): Promise<{ sent: number; failed: number }> {
    const redis = await getDragonflyClient('site-agent-usage');
    const raw = await redis.lPopCount(POLAR_RETRY_KEY, Math.max(1, Math.min(limit, 500)));
    if (!raw?.length) return { sent: 0, failed: 0 };
    const items: QueuedPolarEvent[] = [];
    for (const entry of raw) {
        try {
            const item = JSON.parse(entry) as QueuedPolarEvent;
            if (item?.event?.name === POLAR_EVENT_NAME) items.push(item);
        } catch {
            // Malformed entries are dropped.
        }
    }
    if (!items.length) return { sent: 0, failed: 0 };
    try {
        await withTimeout(ingestPolarNamedEvents(items.map((item) => item.event)), POLAR_TIMEOUT_MS * 2);
        return { sent: items.length, failed: 0 };
    } catch (err) {
        await logFailure('drainPolarRetries', `Polar retry failed for ${items.length} events`, err);
        await queuePolarRetry(items.map((item) => ({ event: item.event, attempts: item.attempts + 1 })));
        return { sent: 0, failed: items.length };
    }
}

/** Records the end of a turn. Never throws. */
export async function recordTurn(record: TurnUsageRecord): Promise<void> {
    try {
        const redis = await getDragonflyClient('site-agent-usage');
        const key = statsKey();
        const tx = redis.multi()
            .hIncrBy(key, 'turns', 1)
            .hIncrBy(key, `turns_${record.status}`, 1)
            .hIncrBy(key, 'tool_calls', Math.max(0, Math.round(record.toolCalls)))
            .hIncrBy(key, 'duration_ms_total', Math.max(0, Math.round(record.durationMs)));
        if (record.counted) tx.hIncrBy(key, 'messages', 1).hIncrBy(key, `plan_${record.plan}_messages`, 1);
        await tx.expire(key, STATS_TTL_SECONDS).exec();
    } catch (err) {
        await logFailure('recordTurn', 'Could not record turn stats', err, record.channelId);
    }
}

/**
 * Saves a helpful/unhelpful rating for a turn. The first rating wins; returns false for repeats.
 * The route checks that the turn belongs to the requester before calling this.
 */
export async function recordFeedback(turnId: string, helpful: boolean): Promise<boolean> {
    if (typeof turnId !== 'string' || !turnId || typeof helpful !== 'boolean') return false;
    const redis = await getDragonflyClient('site-agent-usage');
    const key = feedbackKey(turnId);
    const first = await redis.hSetNX(key, 'rating', helpful ? 'helpful' : 'unhelpful');
    if (!first) return false;
    const stats = statsKey();
    await redis.multi()
        .hSet(key, 'at', new Date().toISOString())
        .expire(key, FEEDBACK_TTL_SECONDS)
        .hIncrBy(stats, helpful ? 'helpful' : 'unhelpful', 1)
        .expire(stats, STATS_TTL_SECONDS)
        .exec();
    return true;
}

/** Queues an aborted step (no usage in the stream) for a later /generation lookup. Never throws. */
export async function queueReconcile(job: ReconcileJob): Promise<void> {
    try {
        const redis = await getDragonflyClient('site-agent-usage');
        const item: QueuedReconcile = { ...job, queuedAt: Date.now(), attempt: 0 };
        await redis.multi()
            .rPush(SITE_AGENT_KEYS.reconcileQueue, JSON.stringify(item))
            .lTrim(SITE_AGENT_KEYS.reconcileQueue, -RECONCILE_MAX, -1)
            .expire(SITE_AGENT_KEYS.reconcileQueue, RECONCILE_TTL_SECONDS)
            .exec();
    } catch (err) {
        await logFailure('queueReconcile', 'Could not queue a usage lookup; recording the step as unknown', err, job.channelId);
        const { generationId: _generationId, ...record } = job;
        await recordStep({ ...record, usage: null });
    }
}

export interface DrainReconcileResult {
    reconciled: number;
    unknown: number;
    /** Put back because they are not due yet or OpenRouter does not know them yet. */
    pending: number;
}

/**
 * Looks up queued generations that are due (about 5 s, 15 s, 45 s and 90 s after queueing), one
 * lookup each. Found → `recordStep` with the real usage; still missing after the last try →
 * `recordStep` with null usage (cost_unknown). Safe to run from several processes.
 */
export async function drainReconcile(limit = 20): Promise<DrainReconcileResult> {
    const out: DrainReconcileResult = { reconciled: 0, unknown: 0, pending: 0 };
    const redis = await getDragonflyClient('site-agent-usage');
    const raw = await redis.lPopCount(SITE_AGENT_KEYS.reconcileQueue, Math.max(1, Math.min(limit, 200)));
    if (!raw?.length) return out;
    const later: QueuedReconcile[] = [];
    for (const entry of raw) {
        let item: QueuedReconcile;
        try {
            item = JSON.parse(entry) as QueuedReconcile;
            if (!item?.generationId || !item.turnId) continue;
        } catch {
            continue;
        }
        const dueAt = item.queuedAt + (RECONCILE_SCHEDULE_MS[item.attempt] ?? 0);
        if (Date.now() < dueAt) {
            later.push(item);
            continue;
        }
        let usage: LlmUsage | null = null;
        try {
            usage = await reconcileGeneration(item.generationId, { scheduleMs: [] });
        } catch (err) {
            await logFailure('drainReconcile', 'Generation lookup failed', err, item.channelId);
        }
        const { generationId: _generationId, queuedAt: _queuedAt, attempt, ...record } = item;
        if (usage) {
            await recordStep({ ...record, usage });
            out.reconciled++;
        } else if (attempt + 1 < RECONCILE_SCHEDULE_MS.length) {
            later.push({ ...item, attempt: attempt + 1 });
        } else {
            await recordStep({ ...record, usage: null });
            out.unknown++;
        }
    }
    if (later.length) {
        out.pending = later.length;
        try {
            await redis.multi()
                .rPush(SITE_AGENT_KEYS.reconcileQueue, later.map((item) => JSON.stringify(item)))
                .lTrim(SITE_AGENT_KEYS.reconcileQueue, -RECONCILE_MAX, -1)
                .expire(SITE_AGENT_KEYS.reconcileQueue, RECONCILE_TTL_SECONDS)
                .exec();
        } catch (err) {
            await logFailure('drainReconcile', `Could not put back ${later.length} usage lookups`, err);
        }
    }
    return out;
}
