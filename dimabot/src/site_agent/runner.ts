/**
 * The site agent loop (SAM-style): one turn per user message. Steps: apply steering → compact if
 * needed → stream the model → save the step → run tool calls one by one (approvals and forms
 * pause the turn) → repeat until the model answers without tools. See SITE_AGENT.md.
 *
 * Every state change goes through `store.updateTurn` (compare-and-set) and is fenced by the session
 * lease token, so a turn that lost its lease (another process took over after a crash) stops
 * writing. State is saved before the matching event is sent.
 */
import { randomUUID } from 'node:crypto';
import { error as logError, warn } from '../utils/logger.js';
import { permissionChecker, resolveAccess, type ChannelAccess } from './access.js';
import { recordChange } from './changes.js';
import { effectiveLevel, LEVEL_SWITCH, levelAvailable, levelConfig, messageCost, modelTraits, SITE_AGENT_LIMITS as L, type AgentLevel, type ChatState, type MessageCost } from './config.js';
import { channelFacts, compact, dropOldest, estimateItemTokens, estimateTokens, promptHash, repairContext, toMessages } from './context.js';
import { getDocsPromptIndex } from './docs/index.js';
import { chargeMore, recordLimitHit, refundMessage, readLimits, takeMessage, utcDay } from './limits.js';
import { effectiveCostUsd, estimateUsageCost } from './llm/cost.js';
import { LlmError, streamChat } from './llm/openrouter.js';
import { buildSystemPrompt, FINAL_STEP_NOTE, STEER_PREFIX, turnNote } from './prompt.js';
import { loadPersona, personaAvailable, readPrefs } from './prefs.js';
import { recordRefusal, type RefusalInput } from './refusals.js';
import * as store from './store.js';
import { warmKnowledge } from './tools/knowledge.js';
import { getTool, toLlmTools, toolResultText, toolsFor } from './tools/registry.js';
import { clearExpiredTurnText, retryLateSteps, writeTurnLog, type ModelCost } from './turn_log.js';
import {
    ToolConflictError, ToolInputError,
    type AgentEvent, type AgentTool, type ChangeProposal, type ContextItem, type DisplayItem, type InputMode, type Lang, type LimitsView,
    type LlmStepResult, type PageContext, type PlanTier, type Requester, type SessionMeta, type ToolContext, type ToolOutcome, type TurnStatus,
} from './types.js';
import { drainPolarRetries, drainReconcile, queueReconcile, recordFeedback as storeFeedback, recordStep, recordTurn } from './usage.js';

export class AgentRequestError extends Error {
    constructor(readonly code: string, readonly status: number, message?: string, readonly extra: Record<string, unknown> = {}) {
        super(message ?? code);
    }
}

type WaitResult = { kind: 'apply' | 'skip' | 'submit' | 'expired' | 'superseded' | 'stopped'; values?: unknown };

interface RunState {
    turnId: string;
    userId: string;
    abort: AbortController;
    step: AbortController | null;
    waiter: { callId: string; resolve: (result: WaitResult) => void } | null;
}

const running = new Map<string, RunState>();
const scheduled = new Set<string>();
/** What this process saw of a running turn that the turn record does not keep, for its turn log row. */
const traces = new Map<string, { models: string[]; costs: ModelCost[]; channelLogin?: string }>();

function trace(turnId: string) {
    let entry = traces.get(turnId);
    if (!entry) traces.set(turnId, entry = { models: [], costs: [] });
    return entry;
}
const noteModel = (turnId: string, model: string) => { const entry = trace(turnId); if (!entry.models.includes(model)) entry.models.push(model); };
/** Per-model steps and cost. A model is listed as soon as it may cost something, so a later reconciled cost finds it. */
function noteCost(turnId: string, model: string, steps: number, costUsd: number): void {
    const { costs } = trace(turnId);
    let entry = costs.find((item) => item.model === model);
    if (!entry) costs.push(entry = { model, steps: 0, costUsd: 0 });
    entry.steps += steps;
    entry.costUsd += costUsd;
}
const ACTIVE_STATUSES: TurnStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_input'];
const TOOL_TIMEOUT_MS = 90_000;
/** Docs/read lookups per message before results start nudging the model to act. */
const LOOKUP_NUDGE_AFTER = 8;
const TEXT_FLUSH_MS = 120;

const isActive = (status: TurnStatus) => ACTIVE_STATUSES.includes(status);
const titleFrom = (text: string) => { const clean = text.replace(/\s+/g, ' ').trim(); return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean || 'Chat'; };

const LeaseLost = store.LeaseLostError;
type LeaseLost = store.LeaseLostError;

// ---------------------------------------------------------------------------
// Events + items
// ---------------------------------------------------------------------------

async function emit(turnId: string, event: AgentEvent): Promise<void> {
    await store.appendEvent(turnId, event);
}

async function addItem(sessionId: string, turnId: string, item: DisplayItem): Promise<DisplayItem> {
    await store.putItem(sessionId, item, true);
    await emit(turnId, { type: 'item', item });
    return item;
}

async function updateItem(sessionId: string, turnId: string, item: DisplayItem): Promise<DisplayItem> {
    await store.putItem(sessionId, item, false);
    await emit(turnId, { type: 'update', item });
    return item;
}

function cleanText(text: unknown, max: number): string {
    if (typeof text !== 'string') throw new AgentRequestError('invalid_request', 400, 'text is required');
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (!clean) throw new AgentRequestError('invalid_request', 400, 'text is empty');
    if (clean.length > max) throw new AgentRequestError('invalid_request', 400, `text is too long (max ${max})`);
    return clean;
}

// ---------------------------------------------------------------------------
// Public API used by the route
// ---------------------------------------------------------------------------

export interface SubmitInput {
    access: ChannelAccess;
    requester: Requester;
    sessionId: string | null;
    text: unknown;
    mode: InputMode;
    page: PageContext | null;
    lang: Lang;
    /** Standard or Expert for this message; null = the person's saved pick. Steer inputs pay the running turn's. */
    level?: AgentLevel | null;
}

function newTurn(input: { id?: string; sessionId: string; access: ChannelAccess; requester: Requester; lang: Lang; page: PageContext | null; text: string; userItemId: string; mode: InputMode; countedDay: string; level?: AgentLevel; cost?: number; levelCost?: number; retryOf?: string; userAdded?: boolean }): store.TurnRecord {
    return {
        id: input.id ?? randomUUID(), sessionId: input.sessionId, channelId: input.access.channelId,
        userId: input.requester.id, userLogin: input.requester.login, userDisplayName: input.requester.displayName,
        role: input.requester.id === input.access.channelId ? 'owner' : input.access.role, plan: input.access.plan, lang: input.lang, page: input.page,
        status: 'queued', revision: 1, inputRevision: 0, createdAt: Date.now(), userMessage: input.text, userItemId: input.userItemId, mode: input.mode,
        countedDay: input.countedDay, level: input.level ?? 'standard', cost: input.cost ?? 1, levelCost: input.levelCost ?? input.cost ?? 1, retryOf: input.retryOf, userAdded: input.userAdded ?? false, lastPromptTokens: 0, lastPromptItems: 0,
        stopRequested: false, steps: 0, toolCallCount: 0, activeMs: 0, inputs: [], calls: [],
        usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, unknownSteps: 0 },
    };
}

export async function submitMessage(input: SubmitInput): Promise<{ sessionId: string; turnId: string; limits: LimitsView; queued?: boolean }> {
    const text = cleanText(input.text, L.userMessageChars);
    const { access, requester } = input;
    if (input.level === 'expert' && !levelAvailable(access.plan, 'expert')) throw new AgentRequestError('plan_required', 403, 'Expert needs Premium or Pro');
    const picked = input.level ?? (await readPrefs(access.channelId, requester.id).catch(() => null))?.level;
    const level = effectiveLevel(access.plan, picked);
    const levelCfg = levelConfig(access.plan, level);
    let price: MessageCost = { total: levelCfg.cost, level: levelCfg.cost, move: 0 };

    let session = input.sessionId ? await store.getOwnSession(input.sessionId, access.channelId, requester.id) : null;
    if (input.sessionId && !session) throw new AgentRequestError('session_not_found', 404, 'Chat not found (chats are kept for 3 days)');
    const active = session?.activeTurnId ? await store.getTurn(session.activeTurnId) : null;
    const activeTurn = active && isActive(active.status) ? active : null;

    if (input.mode === 'send' && activeTurn) throw new AgentRequestError('turn_active', 409, 'The assistant is still working on this chat', { turnId: activeTurn.id });
    if (input.mode !== 'send' && !activeTurn) throw new AgentRequestError('turn_not_active', 409, 'Nothing is running in this chat; send it as a new message');
    if (input.mode === 'steer' && activeTurn && activeTurn.inputs.length >= L.steerInputsPerTurn) throw new AgentRequestError('too_many_inputs', 429, 'Too many messages for this answer; wait for it to finish');
    if (input.mode === 'queue' && session && await store.queuedCount(session.id) >= L.queuedInputsPerSession) throw new AgentRequestError('queue_full', 429, 'Too many queued messages');

    // A steer joins the running turn and pays its level's price. A new message pays its level plus the fee for moving
    // the chat when it last ran on the other level; a queued one compares with the answer it waits for.
    if (input.mode === 'steer' && activeTurn) {
        const steer = activeTurn.levelCost ?? activeTurn.cost ?? 1;
        price = { total: steer, level: steer, move: 0 };
    } else if (session) {
        const chat = input.mode === 'queue' && activeTurn ? await chatAfterQueue(access.plan, session, activeTurn) : session;
        price = messageCost(access.plan, level, chat);
    }
    const cost = price.total;
    const taken = await takeMessage(access.channelId, access.plan, cost);
    if (!taken.allowed) {
        void recordLimitHit(access.channelId);
        // Some left, just not enough for an Expert message: the panel offers Standard.
        if (taken.limits.used < taken.limits.limit) throw new AgentRequestError('not_enough_messages', 429, `This message needs ${cost} messages; fewer are left today`, { limits: taken.limits, cost });
        throw new AgentRequestError('daily_limit', 429, 'Daily message limit reached', { limits: taken.limits });
    }
    const day = utcDay();

    try {
        if (!session) session = await store.createSession(access.channelId, requester.id, titleFrom(text), levelCfg.contextLimit);
        const sessionId = session.id;
        const itemId = randomUUID();

        if (input.mode === 'steer' && activeTurn) {
            const item: DisplayItem = { kind: 'user', id: itemId, turnId: activeTurn.id, text, mode: 'steer', at: Date.now() };
            const updated = await store.updateTurn(activeTurn.id, (turn) => {
                if (!isActive(turn.status) || turn.stopRequested) return false;
                turn.inputs.push({ id: randomUUID(), text, at: Date.now(), applied: false, itemId, cost, countedDay: day });
                turn.inputRevision++;
            });
            if (!updated || !isActive(updated.status) || updated.inputs.every((entry) => entry.itemId !== itemId)) {
                throw new AgentRequestError('turn_not_active', 409, 'That answer already finished; send it as a new message');
            }
            await addItem(sessionId, activeTurn.id, item);
            await emit(activeTurn.id, { type: 'turn', levelCost: updated.levelCost ?? updated.cost ?? 1, turnId: activeTurn.id, sessionId, status: updated.status, inputRevision: updated.inputRevision });
            await emit(activeTurn.id, { type: 'limits', limits: taken.limits });
            wakeForSteer(activeTurn.id);
            return { sessionId, turnId: activeTurn.id, limits: taken.limits };
        }

        if (input.mode === 'queue' && activeTurn) {
            const item: DisplayItem = { kind: 'user', id: itemId, turnId: '', text, mode: 'queue', at: Date.now() };
            await store.queueInput(sessionId, { id: randomUUID(), itemId, text, page: input.page, lang: input.lang, userId: requester.id,
                userLogin: requester.login, userDisplayName: requester.displayName, countedDay: day, level, cost, levelCost: price.level, at: Date.now() });
            await addItem(sessionId, activeTurn.id, item);
            await emit(activeTurn.id, { type: 'limits', limits: taken.limits });
            // The answer may have finished while we queued: then nobody would pick this up, so start it here.
            const now = await store.getSession(sessionId);
            const current = now?.activeTurnId ? await store.getTurn(now.activeTurnId) : null;
            if (!current || !isActive(current.status)) await startNextQueued(sessionId, now?.activeTurnId ?? undefined);
            return { sessionId, turnId: activeTurn.id, limits: taken.limits, queued: true };
        }

        // Claim the session for this turn only if nobody else did since we looked (two quick sends).
        const turn = newTurn({ sessionId, access, requester, lang: input.lang, page: input.page, text, userItemId: itemId, mode: 'send', countedDay: day, level, cost, levelCost: price.level });
        // The turn exists before the session points at it, so nobody can mistake the new id for a stale one.
        const seen = session.activeTurnId;
        await store.createTurn(turn);
        const claimed = await store.updateSession(sessionId, (meta) => {
            if (meta.activeTurnId !== seen) return false;
            meta.activeTurnId = turn.id;
        });
        if (claimed?.activeTurnId !== turn.id) {
            await store.updateTurn(turn.id, (current) => { current.status = 'cancelled'; current.endedAt = Date.now(); }).catch(() => null);
            await store.finishActive(turn.id).catch(() => {});
            throw new AgentRequestError('turn_active', 409, 'The assistant is still working on this chat', { turnId: claimed?.activeTurnId ?? null });
        }
        await addItem(sessionId, turn.id, { kind: 'user', id: itemId, turnId: turn.id, text, mode: 'send', at: Date.now() });
        await emit(turn.id, { type: 'turn', levelCost: turn.levelCost ?? turn.cost ?? 1, turnId: turn.id, sessionId, status: 'queued', inputRevision: 0 });
        await emit(turn.id, { type: 'limits', limits: taken.limits });
        schedule(turn.id);
        return { sessionId, turnId: turn.id, limits: taken.limits };
    } catch (err) {
        await refundMessage(access.channelId, day, cost).catch(() => {});
        throw err;
    }
}

/**
 * The chat as a newly queued message will find it: after the running answer and everything queued before it. The
 * size stays what was last measured, with the model it was measured on. Prices are checked again when it starts.
 */
export async function chatAfterQueue(plan: PlanTier, session: SessionMeta, activeTurn: store.TurnRecord): Promise<ChatState> {
    const last = await store.lastQueuedInput(session.id).catch(() => null);
    const lastLevel: AgentLevel = last ? effectiveLevel(plan, last.level) : activeTurn.fellBack ? 'standard' : effectiveLevel(plan, activeTurn.level);
    return { lastLevel, contextTokens: session.contextTokens, contextModel: session.contextModel };
}

export async function stopTurn(turnId: string, requesterId: string): Promise<TurnStatus> {
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== requesterId) throw new AgentRequestError('turn_not_found', 404);
    if (!isActive(turn.status)) return turn.status;
    const updated = await store.updateTurn(turnId, (current) => {
        if (!isActive(current.status) || current.stopRequested) return false;
        current.stopRequested = true;
    });
    const state = running.get(turnId);
    if (state) {
        state.waiter?.resolve({ kind: 'stopped' });
        state.abort.abort();
    } else if (updated?.status === 'queued') {
        await finishTurn(updated, 'cancelled');
    }
    return updated?.status ?? turn.status;
}

export async function retryTurn(turnId: string, requester: Requester, access: ChannelAccess): Promise<{ turnId: string }> {
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== requester.id || turn.channelId !== access.channelId) throw new AgentRequestError('turn_not_found', 404);
    if (!['failed', 'cancelled', 'interrupted'].includes(turn.status)) throw new AgentRequestError('not_retryable', 409, 'Only a failed, stopped or interrupted answer can be retried');
    const session = await store.getOwnSession(turn.sessionId, access.channelId, requester.id);
    if (!session) throw new AgentRequestError('session_not_found', 404);
    if (session.activeTurnId) throw new AgentRequestError('turn_active', 409, 'The assistant is already working on this chat');
    // Same level as the attempt it repeats (not counted again).
    const retry = newTurn({ sessionId: session.id, access, requester, lang: turn.lang, page: turn.page, text: turn.userMessage, userItemId: turn.userItemId,
        mode: 'send', countedDay: '', level: effectiveLevel(access.plan, turn.level), cost: levelConfig(access.plan, turn.level).cost,
        levelCost: levelConfig(access.plan, turn.level).cost, retryOf: turn.id, userAdded: turn.userAdded });
    await store.createTurn(retry);
    const claimed = await store.updateSession(session.id, (meta) => { if (!meta.activeTurnId) meta.activeTurnId = retry.id; });
    if (claimed?.activeTurnId !== retry.id) {
        await store.updateTurn(retry.id, (current) => { current.status = 'cancelled'; current.endedAt = Date.now(); });
        await store.finishActive(retry.id);
        throw new AgentRequestError('turn_active', 409);
    }
    await emit(retry.id, { type: 'turn', levelCost: retry.levelCost ?? retry.cost ?? 1, turnId: retry.id, sessionId: session.id, status: 'queued', inputRevision: 0 });
    schedule(retry.id);
    return { turnId: retry.id };
}

export async function decideApproval(turnId: string, callId: string, decision: 'apply' | 'skip', requesterId: string): Promise<string> {
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== requesterId) throw new AgentRequestError('turn_not_found', 404);
    const call = turn.calls.find((entry) => entry.id === callId);
    if (!call?.approval) throw new AgentRequestError('approval_not_found', 404);
    if (call.approval.state !== 'pending') return call.approval.state;
    const updated = await store.updateTurn(turnId, (current) => {
        const target = current.calls.find((entry) => entry.id === callId);
        if (!target?.approval || target.approval.state !== 'pending') return false;
        if (current.stopRequested || current.waiting?.callId !== callId || current.waiting.kind !== 'approval') return false;
        if (target.inputRevision !== current.inputRevision) return false;
        if (current.waiting.expiresAt < Date.now()) return false;
        target.approval = { state: decision === 'apply' ? 'approved' : 'skipped', decidedAt: Date.now() };
    });
    const state = updated?.calls.find((entry) => entry.id === callId)?.approval?.state ?? 'expired';
    if (state === 'approved' || state === 'skipped') running.get(turnId)?.waiter?.callId === callId && running.get(turnId)!.waiter!.resolve({ kind: decision === 'apply' ? 'apply' : 'skip' });
    return state;
}

export async function submitUi(turnId: string, callId: string, values: unknown, requesterId: string): Promise<string> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AgentRequestError('invalid_request', 400, 'values must be an object');
    const json = JSON.stringify(values);
    if (Buffer.byteLength(json, 'utf8') > L.uiSubmitBytes) throw new AgentRequestError('invalid_request', 400, 'values are too large');
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== requesterId) throw new AgentRequestError('turn_not_found', 404);
    const updated = await store.updateTurn(turnId, (current) => {
        const target = current.calls.find((entry) => entry.id === callId);
        if (!target?.ui || target.ui.state !== 'open') return false;
        if (current.stopRequested || current.waiting?.callId !== callId || current.waiting.kind !== 'input' || current.waiting.expiresAt < Date.now()) return false;
        if (target.inputRevision !== current.inputRevision) return false;
        target.ui = { state: 'submitted', values: JSON.parse(json) };
    });
    const state = updated?.calls.find((entry) => entry.id === callId)?.ui?.state ?? 'closed';
    if (state === 'submitted') {
        const run = running.get(turnId);
        if (run?.waiter?.callId === callId) run.waiter.resolve({ kind: 'submit', values: JSON.parse(json) });
    }
    return state;
}

export async function feedback(turnId: string, requesterId: string, helpful: unknown): Promise<boolean> {
    if (typeof helpful !== 'boolean') throw new AgentRequestError('invalid_request', 400, 'helpful must be true or false');
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== requesterId) throw new AgentRequestError('turn_not_found', 404);
    return storeFeedback(turnId, helpful);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function schedule(turnId: string, delayMs = 0): void {
    if (scheduled.has(turnId) || running.has(turnId)) return;
    scheduled.add(turnId);
    const timer = setTimeout(() => {
        scheduled.delete(turnId);
        void runTurn(turnId).catch(async (err) => {
            await logError({ function: 'siteAgent.runTurn', turnId, error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
        });
    }, delayMs);
    timer.unref();
}

function wakeForSteer(turnId: string): void {
    const state = running.get(turnId);
    if (!state) return;
    state.waiter?.resolve({ kind: 'superseded' });
    state.step?.abort();
}

function runningFor(userId: string): number {
    let count = 0;
    for (const state of running.values()) if (state.userId === userId) count++;
    return count;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

async function runTurn(turnId: string): Promise<void> {
    const queued = await store.getTurn(turnId);
    if (!queued || queued.status !== 'queued') return;
    if (queued.stopRequested) { await finishTurn(queued, 'cancelled'); return; }
    if (running.size >= L.concurrentTotal || runningFor(queued.userId) >= L.concurrentPerUser) { schedule(turnId, 2000); return; }

    const token = await store.acquireLease(queued.sessionId);
    if (!token) { schedule(turnId, 3000); return; }
    const state: RunState = { turnId, userId: queued.userId, abort: new AbortController(), step: null, waiter: null };
    running.set(turnId, state);
    let leaseLost = false;
    let renewedAt = Date.now();
    const loseLease = () => { if (!leaseLost) { leaseLost = true; state.abort.abort(); } };
    const heartbeat = setInterval(() => {
        void store.renewLease(queued.sessionId, token).then((ok) => {
            if (ok) renewedAt = Date.now(); else loseLease();
        }).catch(() => {
            // Can't reach Dragonfly: once the lease may have expired, stop before another runner can start.
            if (Date.now() - renewedAt > store.LEASE_MS - 15_000) loseLease();
        });
    }, 15_000);
    heartbeat.unref();

    try {
        const claimed = await store.updateTurn(turnId, (turn) => {
            if (turn.status !== 'queued') return false;
            turn.status = 'running';
            turn.fence = token;
            turn.startedAt = Date.now();
        });
        if (!claimed || claimed.fence !== token || claimed.status !== 'running') return;
        await emit(turnId, { type: 'turn', levelCost: claimed.levelCost ?? claimed.cost ?? 1, turnId, sessionId: claimed.sessionId, status: 'running', inputRevision: claimed.inputRevision });
        await loop(claimed, state, token);
    } catch (err) {
        const turn = await store.getTurn(turnId);
        if (turn && isActive(turn.status) && turn.fence === token && !leaseLost) {
            const code = err instanceof LlmError ? `model_${err.kind}` : err instanceof LeaseLost ? 'lease_lost' : 'internal_error';
            if (!(err instanceof LlmError)) await logError({ function: 'siteAgent.loop', turnId, error: err instanceof Error ? err.stack ?? err.message : String(err) }, { destination: 'both' });
            await finishTurn(turn, turn.stopRequested ? 'cancelled' : 'failed', code, { token });
        }
    } finally {
        clearInterval(heartbeat);
        running.delete(turnId);
        traces.delete(turnId);
        await store.releaseLease(queued.sessionId, token).catch(() => {});
        await startNextQueued(queued.sessionId).catch(() => {});
    }
}

/** Updates the turn only while this process still holds it. */
async function fenced(turnId: string, token: string, mutate: (turn: store.TurnRecord) => boolean | void, sessionId?: string): Promise<store.TurnRecord> {
    let lost = false;
    const updated = await store.updateTurn(turnId, (turn) => {
        lost = false;
        if (turn.fence !== token || !isActive(turn.status)) { lost = true; return false; }
        return mutate(turn);
    }, { sessionId, token });
    if (!updated || lost) throw new LeaseLost();
    return updated;
}

interface LoopContext {
    turn: store.TurnRecord;
    token: string;
    fence: store.Fence;
    /** Time spent waiting for approvals/forms (not active time). */
    waitedMs: number;
    state: RunState;
    access: ChannelAccess;
    can: (permissions: readonly string[], fresh?: boolean) => Promise<boolean>;
    tools: AgentTool[];
    items: ContextItem[];
}

async function loop(initial: store.TurnRecord, state: RunState, token: string): Promise<void> {
    let turn = initial;
    const access = await resolveAccess(turn.userId, turn.channelId);
    if (!access) { await finishTurn(turn, 'failed', 'access_revoked', { token }); return; }
    // Standard or Expert; after a refusal the rest of the turn runs on Standard.
    let cfg = levelConfig(turn.plan, turn.fellBack ? 'standard' : turn.level);
    // The level's limit is in the model's real tokens; our estimates are converted (Claude counts ~1.4× more).
    let traits = modelTraits(cfg.model);
    let limitEstimate = Math.floor(cfg.contextLimit / traits.tokenFactor);
    const standard = levelConfig(turn.plan, 'standard');
    /** The level answering now (saved on the chat after each step: moving it later costs a fee). */
    let runningLevel: AgentLevel = turn.fellBack ? 'standard' : effectiveLevel(turn.plan, turn.level);
    const can = permissionChecker(turn.userId, turn.channelId);
    const tools = await toolsFor((permissions) => can(permissions), turn.plan, turn.role);
    const llmTools = toLlmTools(tools);
    // Premium/Pro, when the person turned it on: answer in the channel's chat-bot personality (tone only).
    const usePersona = personaAvailable(turn.plan) && (await readPrefs(turn.channelId, turn.userId).catch(() => ({ persona: false }))).persona;
    const persona = usePersona ? await loadPersona(turn.channelId).catch(() => null) : null;
    const system = buildSystemPrompt(await getDocsPromptIndex(turn.lang), persona);
    const systemTokens = estimateTokens(system) + estimateTokens(JSON.stringify(llmTools));

    const fence: store.Fence = { sessionId: turn.sessionId, token };
    let items = repairContext(await store.getContext(turn.sessionId)).items;
    if (!turn.userAdded) {
        const facts = await channelFacts(turn.channelId);
        const note = turnNote({ now: new Date(), channelLogin: access.channelLogin, plan: turn.plan, requesterLogin: turn.userLogin, role: turn.role, lang: turn.lang, page: turn.page, ...facts });
        items.push({ role: 'user', content: `${note}\n\n${turn.userMessage}`, at: Date.now() });
        await store.setContext(turn.sessionId, items, fence);
        turn = await fenced(turn.id, token, (current) => { current.userAdded = true; });
    } else {
        if (turn.retryOf) items.push({ role: 'user', content: '[The user pressed Retry: the previous attempt stopped or failed. Check what already happened above, then continue the request.]', at: Date.now() });
        await store.setContext(turn.sessionId, items, fence);
    }
    // The current user message: the last plain user item (steer inputs come after it).
    const currentUserIndex = () => {
        for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index];
            if (item.role === 'user' && !item.content.startsWith(STEER_PREFIX)) return index;
        }
        return -1;
    };
    trace(turn.id).channelLogin = access.channelLogin;
    const ctx: LoopContext = { turn, token, fence, waitedMs: 0, state, access, can, tools, items };
    const loopStart = Date.now();
    const activeNow = () => Date.now() - loopStart - ctx.waitedMs;
    let lastError: LlmError | null = null;

    /** Expert declined by a safety filter: record what was asked, then redo the step on Standard. */
    const canFallBack = () => traits.anthropic && !turn.fellBack && standard.model !== cfg.model;
    const fallBack = async (how: Pick<RefusalInput, 'source' | 'finishReason' | 'nativeFinishReason' | 'refusal' | 'detail' | 'partial'>, partialItem: DisplayItem | null) => {
        await recordRefusal({ channelId: turn.channelId, channelLogin: access.channelLogin, userId: turn.userId, userLogin: turn.userLogin, sessionId: turn.sessionId, turnId: turn.id,
            step: turn.steps, plan: turn.plan, level: turn.level ?? 'expert', model: cfg.model, fallbackModel: standard.model, ...how,
            message: turn.userMessage, steers: turn.inputs.map((input) => input.text), items });
        noteModel(turn.id, cfg.model);
        // Owner decision: a declined Expert message also pays the switch and Standard's answer (never past the limit;
        // retries are free, so nothing extra there either).
        const planNow = (await resolveAccess(turn.userId, turn.channelId).catch(() => null))?.plan ?? turn.plan;
        const extra = turn.countedDay ? await chargeMore(turn.channelId, planNow, LEVEL_SWITCH.fallback).catch(() => null) : null;
        if (extra) await emit(turn.id, { type: 'limits', limits: extra.limits });
        // Its prompt size was measured in Claude's tokens: estimate again on Standard.
        turn = ctx.turn = await fenced(turn.id, token, (current) => {
            current.fellBack = true;
            current.lastPromptTokens = 0;
            current.lastPromptItems = 0;
            if (extra?.charged) { current.extraCharged = (current.extraCharged ?? 0) + extra.charged; current.extraDay = extra.day; }
        });
        cfg = standard;
        runningLevel = 'standard';
        traits = modelTraits(cfg.model);
        limitEstimate = Math.floor(cfg.contextLimit / traits.tokenFactor);
        // Text already shown stays as it was; Standard answers after a short note.
        if (partialItem && partialItem.kind === 'assistant' && partialItem.text) await updateItem(turn.sessionId, turn.id, { ...partialItem, final: true });
        await addItem(turn.sessionId, turn.id, { kind: 'notice', id: randomUUID(), turnId: turn.id, code: 'expert_fallback', at: Date.now() });
    };

    for (;;) {
        turn = ctx.turn = (await store.getTurn(turn.id))!;
        if (turn.fence !== token || !isActive(turn.status)) throw new LeaseLost();
        if (turn.stopRequested || state.abort.signal.aborted) { await finishTurn(turn, 'cancelled', undefined, ctx.fence); return; }

        // 1. Steering inputs.
        const pending = turn.inputs.filter((input) => !input.applied);
        if (pending.length) {
            for (const input of pending) items.push({ role: 'user', content: `${STEER_PREFIX}\n${input.text}`, at: input.at });
            await store.setContext(turn.sessionId, items, fence);
            turn = ctx.turn = await fenced(turn.id, token, (current) => { for (const input of current.inputs) if (pending.some((entry) => entry.id === input.id)) input.applied = true; });
        }

        // 2. Compaction when the prompt reaches the level's limit.
        const sinceMeasured = items.slice(turn.lastPromptItems).reduce((sum, item) => sum + estimateItemTokens(item), 0);
        const estimate = turn.lastPromptTokens ? turn.lastPromptTokens / traits.tokenFactor + sinceMeasured : systemTokens + items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
        if (estimate >= limitEstimate * cfg.compactAt) {
            await emit(turn.id, { type: 'status', phase: 'compacting', label: turn.lang === 'es' ? 'Resumiendo la conversación…' : 'Summarizing the conversation…' });
            try {
                const result = await compact({ items, currentUserIndex: currentUserIndex(), limitTokens: limitEstimate - systemTokens, model: cfg.model, effort: cfg.effort, sessionKey: turn.sessionId, signal: state.abort.signal });
                if (result.step) await recordUsage(turn, result.step, 'compaction', cfg.model);
                // Expert declined the summary: keep the history, switch to Standard and check its (larger) limit again.
                if (result.step?.refused && canFallBack()) {
                    await fallBack({ source: 'reply', finishReason: result.step.finishReason, nativeFinishReason: result.step.nativeFinishReason,
                        refusal: result.step.refusal, detail: null, partial: null }, null);
                    continue;
                }
                items = result.compacted ? result.items : dropOldest(items, currentUserIndex(), Math.floor((limitEstimate - systemTokens) * 0.6));
            } catch (err) {
                if (state.abort.signal.aborted) continue;
                if (err instanceof LlmError && err.kind === 'refused' && canFallBack()) {
                    await fallBack({ source: 'error', finishReason: null, nativeFinishReason: null, refusal: err.message, detail: err.detail ?? null, partial: null }, null);
                    continue;
                }
                await warn({ function: 'siteAgent.compact', turnId: turn.id, error: err instanceof Error ? err.message : String(err) }, { destination: 'console' });
                items = dropOldest(items, currentUserIndex(), Math.floor((limitEstimate - systemTokens) * 0.6));
            }
            ctx.items = items;
            await store.setContext(turn.sessionId, items, fence);
            turn = ctx.turn = await fenced(turn.id, token, (current) => { current.lastPromptTokens = 0; current.lastPromptItems = 0; });
            // Claude bills a prompt over 100k tokens at 5×: if compaction could not bring it under the limit, stop
            // instead of sending it. Counts only the thinking that will really be sent (toMessages drops the rest).
            if (traits.anthropic) {
                const outgoing = toMessages(system, items, cfg.model, llmTools);
                const size = items.reduce((sum, item, index) => sum + estimateItemTokens(item.role === 'assistant' && item.reasoning
                    && !(outgoing[index + 1] as { reasoning_details?: unknown[] }).reasoning_details ? { ...item, reasoning: undefined } : item), systemTokens);
                if (size > limitEstimate) throw new LlmError('context_too_long', 'This chat is too long to continue. Start a new chat.');
            }
        }

        // 3. One model step.
        const activeMs = activeNow();
        const final = turn.steps >= L.maxModelSteps - 1 || turn.toolCallCount >= L.maxToolCalls || activeMs >= L.activeMs;
        const messages = toMessages(system, items, cfg.model, llmTools);
        if (final) messages.push({ role: 'user', content: FINAL_STEP_NOTE });
        // What this step's reasoning is bound to (Claude): see toMessages.
        const prefixHash = traits.anthropic ? promptHash(llmTools, messages) : undefined;
        const inputRevision = turn.inputRevision;
        await emit(turn.id, { type: 'status', phase: 'thinking' });

        const stepAbort = new AbortController();
        const onRunAbort = () => stepAbort.abort();
        state.abort.signal.addEventListener('abort', onRunAbort, { once: true });
        state.step = stepAbort;
        const text = textStream(turn.sessionId, turn.id);
        let result: LlmStepResult;
        try {
            result = await streamChat({ model: cfg.model, effort: cfg.effort, messages, tools: llmTools, toolChoice: final ? 'none' : 'auto', sessionKey: turn.sessionId, signal: stepAbort.signal },
                { onText: (delta) => text.push(delta) });
        } catch (err) {
            const partialItem = await text.close();
            state.abort.signal.removeEventListener('abort', onRunAbort);
            state.step = null;
            if (err instanceof LlmError && err.kind === 'aborted') {
                if (state.abort.signal.aborted) { await finishTurn((await store.getTurn(turn.id))!, 'cancelled', undefined, ctx.fence); return; }
                continue; // steered before the stream started
            }
            // A started generation is billed even when the stream failed: unknown on the turn until it is reconciled.
            if (err instanceof LlmError && err.generationId) {
                await queueReconcile({ generationId: err.generationId, channelId: turn.channelId, plan: turn.plan, sessionId: turn.sessionId, turnId: turn.id,
                    step: `${turn.steps}-e${Date.now().toString(36)}`, model: cfg.model, requesterId: turn.userId, kind: 'step' }).catch(() => {});
                await store.updateTurn(turn.id, (current) => { current.usage.unknownSteps++; }).catch(() => null);
                noteCost(turn.id, cfg.model, 0, 0);
            }
            if (err instanceof LlmError && err.kind === 'refused' && canFallBack()) {
                await fallBack({ source: 'error', finishReason: null, nativeFinishReason: null, refusal: err.message, detail: err.detail ?? null,
                    partial: partialItem?.kind === 'assistant' ? partialItem.text : null }, partialItem);
                continue;
            }
            // One quiet retry for passing provider trouble, then fail.
            if (err instanceof LlmError && ['overloaded', 'rate_limited', 'timeout', 'incomplete', 'upstream'].includes(err.kind) && lastError === null) {
                lastError = err;
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            throw err;
        }
        state.abort.signal.removeEventListener('abort', onRunAbort);
        state.step = null;
        lastError = null;
        const textItem = await text.close();
        await recordUsage(turn, result, 'step', cfg.model);
        turn = ctx.turn = await fenced(turn.id, token, (current) => {
            current.steps++;
            current.activeMs = activeNow();
            if (result.usage) { current.lastPromptTokens = result.usage.promptTokens; current.lastPromptItems = items.length; }
        });
        if (result.usage) await store.updateSession(turn.sessionId, (meta) => {
            meta.contextTokens = result.usage!.promptTokens;
            meta.contextLimit = cfg.contextLimit;
            meta.contextModel = cfg.model;
        });

        if (result.aborted) {
            if (state.abort.signal.aborted || turn.stopRequested) {
                // Stopped: keep what was said so far, as said.
                if (textItem && textItem.kind === 'assistant' && textItem.text) {
                    items.push({ role: 'assistant', content: `${textItem.text} [stopped by the user]`, at: Date.now() });
                    await store.setContext(turn.sessionId, items, fence);
                    await updateItem(turn.sessionId, turn.id, { ...textItem, final: true });
                }
                await finishTurn(turn, 'cancelled', undefined, ctx.fence);
                return;
            }
            continue; // steered: drop this response (its tool calls never run) and take the new message into account
        }

        // Declined by the safety filter: nothing of this step goes into the context. Expert → Standard redoes it;
        // with no fallback left the turn ends as declined (never as a normal or "empty" answer).
        if (result.refused) {
            if (canFallBack()) {
                await fallBack({ source: 'reply', finishReason: result.finishReason, nativeFinishReason: result.nativeFinishReason, refusal: result.refusal,
                    detail: null, partial: result.content || null }, textItem);
                continue;
            }
            if (textItem && textItem.kind === 'assistant' && textItem.text) await updateItem(turn.sessionId, turn.id, { ...textItem, final: true });
            throw new LlmError('refused', 'The model declined to answer');
        }

        // 4. Save the assistant step. On the forced last step, tool calls are ignored.
        const calls = final ? [] : result.toolCalls;
        items.push({ role: 'assistant', content: result.content || null, ...(calls.length ? { toolCalls: calls } : {}),
            // Claude thinking is kept only with its token count (its replayed size); without usage it is not replayed.
            ...(result.reasoning.length && (!traits.anthropic || result.usage) ? { reasoning: { provider: 'openrouter' as const, model: cfg.model, details: result.reasoning,
                ...(prefixHash ? { prefixHash } : {}), ...(traits.anthropic ? { tokens: result.usage!.reasoningTokens } : {}) } } : {}), at: Date.now() });
        await store.setContext(turn.sessionId, items, fence);
        // An accepted answer: the chat is now on this level (moving it later costs a fee), and the turn answered.
        await store.updateSession(turn.sessionId, (meta) => { if (meta.lastLevel === runningLevel) return false; meta.lastLevel = runningLevel; });
        turn = ctx.turn = await fenced(turn.id, token, (current) => { current.answeredSteps = (current.answeredSteps ?? 0) + 1; });

        if (!calls.length) {
            if (textItem && textItem.kind === 'assistant') await updateItem(turn.sessionId, turn.id, { ...textItem, final: true });
            else await addItem(turn.sessionId, turn.id, { kind: 'notice', id: randomUUID(), turnId: turn.id, code: final ? 'step_limit' : 'empty_answer', at: Date.now() });
            // A steer that landed after the stream ended is answered too (finishTurn refuses while inputs are pending).
            if (await finishTurn(turn, 'completed', undefined, ctx.fence)) return;
            continue;
        }

        // 5. Tool calls, one by one.
        for (let index = 0; index < calls.length; index++) {
            const call = calls[index];
            turn = ctx.turn = (await store.getTurn(turn.id))!;
            if (turn.fence !== token) throw new LeaseLost();
            let resultText: string;
            if (turn.stopRequested || state.abort.signal.aborted) {
                resultText = JSON.stringify({ error: 'stopped', message: 'The user stopped the assistant before this ran.' });
            } else if (turn.inputRevision !== inputRevision) {
                resultText = JSON.stringify({ error: 'superseded_by_input', message: 'Not run: the user sent a new message first. Read it and decide again.' });
                await recordCall(ctx, call.id, call.name, call.arguments, inputRevision, 'superseded', resultText);
            } else if (activeNow() >= L.activeMs) {
                resultText = JSON.stringify({ error: 'time_budget', message: 'Not run: this message has used its working time. Answer with what you have.' });
                await recordCall(ctx, call.id, call.name, call.arguments, inputRevision, 'error', resultText);
            } else if (turn.toolCallCount >= L.maxToolCalls) {
                resultText = JSON.stringify({ error: 'tool_budget', message: `Not run: the limit of ${L.maxToolCalls} tool calls for one message was reached. Answer with what you have.` });
                await recordCall(ctx, call.id, call.name, call.arguments, inputRevision, 'error', resultText);
            } else {
                resultText = await runCall(ctx, call.id, call.name, call.arguments, inputRevision);
            }
            items.push({ role: 'tool', toolCallId: call.id, name: call.name, content: resultText, at: Date.now() });
            await store.setContext(turn.sessionId, items, fence);
            turn = ctx.turn = await fenced(turn.id, token, (current) => { current.toolCallCount++; }, turn.sessionId);
        }
    }
}

/** Buffers streamed text into one assistant item (created on the first delta), flushed every ~120 ms. */
function textStream(sessionId: string, turnId: string) {
    let item: Extract<DisplayItem, { kind: 'assistant' }> | null = null;
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    let chain: Promise<void> = Promise.resolve();
    const flush = () => {
        timer = null;
        const delta = pending;
        pending = '';
        if (!delta) return;
        chain = chain.then(async () => {
            if (!item) {
                item = { kind: 'assistant', id: randomUUID(), turnId, text: delta, at: Date.now(), final: false };
                await addItem(sessionId, turnId, item);
                return;
            }
            const offset = item.text.length;
            item = { ...item, text: item.text + delta };
            await store.putItem(sessionId, item, false);
            await emit(turnId, { type: 'text', itemId: item.id, delta, offset });
        }).catch(() => {});
    };
    return {
        push(delta: string) {
            pending += delta;
            if (!timer) timer = setTimeout(flush, TEXT_FLUSH_MS);
        },
        async close(): Promise<DisplayItem | null> {
            if (timer) clearTimeout(timer);
            flush();
            await chain;
            return item;
        },
    };
}

async function recordUsage(turn: store.TurnRecord, step: LlmStepResult, kind: 'step' | 'compaction', model: string): Promise<void> {
    if (kind === 'step') noteModel(turn.id, model);
    let usage = step.usage;
    if (usage && usage.upstreamCostUsd === null) usage = estimateUsageCost(model, usage);
    // The same cost the day stats count (provider + OpenRouter fee), so a turn's cost and the day totals agree.
    const costUsd = effectiveCostUsd(usage);
    noteCost(turn.id, model, kind === 'step' ? 1 : 0, costUsd ?? 0);
    const stepIndex = kind === 'compaction' ? `c${turn.steps}-${Date.now()}` : String(turn.steps);
    if (!usage && step.generationId) {
        await queueReconcile({ generationId: step.generationId, channelId: turn.channelId, plan: turn.plan, sessionId: turn.sessionId, turnId: turn.id, step: stepIndex, model, requesterId: turn.userId, kind }).catch(() => {});
    } else {
        await recordStep({ channelId: turn.channelId, plan: turn.plan, sessionId: turn.sessionId, turnId: turn.id, step: stepIndex, model, usage, requesterId: turn.userId, kind }).catch(() => {});
    }
    await store.updateTurn(turn.id, (current) => {
        if (!usage) { current.usage.unknownSteps++; return; }
        current.usage.promptTokens += usage.promptTokens;
        current.usage.cachedTokens += usage.cachedTokens;
        current.usage.completionTokens += usage.completionTokens;
        current.usage.reasoningTokens += usage.reasoningTokens;
        if (costUsd === null) current.usage.unknownSteps++;
        else current.usage.costUsd += costUsd;
    }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

async function recordCall(ctx: LoopContext, callId: string, name: string, args: string, inputRevision: number, callState: store.CallRecord['state'], result?: string): Promise<void> {
    await fenced(ctx.turn.id, ctx.token, (turn) => {
        const existing = turn.calls.find((entry) => entry.id === callId);
        if (existing) { existing.state = callState; if (result !== undefined) existing.result = result; existing.endedAt = Date.now(); return; }
        turn.calls.push({ id: callId, name, args: args.slice(0, 20_000), state: callState, itemId: null, inputRevision, startedAt: Date.now(), ...(result !== undefined ? { result, endedAt: Date.now() } : {}) });
    });
}

function toolContext(ctx: LoopContext, callId: string, signal: AbortSignal): ToolContext {
    const { turn, access } = ctx;
    return {
        channelId: turn.channelId, channelLogin: access.channelLogin,
        requester: { id: turn.userId, login: turn.userLogin, displayName: turn.userDisplayName },
        role: turn.role, plan: turn.plan, lang: turn.lang, sessionId: turn.sessionId, turnId: turn.id, callId,
        userMessage: turn.userMessage, page: turn.page, signal,
        can: (permissions) => ctx.can(permissions),
    };
}

async function canUse(ctx: LoopContext, tool: AgentTool, fresh = false): Promise<boolean> {
    if (tool.permissions.includes('owner') && ctx.turn.role !== 'owner') return false;
    return ctx.can(tool.permissions.filter((permission) => permission !== 'owner'), fresh);
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tool_timeout')), ms);
        const onAbort = () => { clearTimeout(timer); reject(new Error('tool_aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
            (err) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(err); });
    });
}

const errorText = (code: string, message: string) => JSON.stringify({ error: code, message });

async function runCall(ctx: LoopContext, callId: string, name: string, rawArgs: string, inputRevision: number): Promise<string> {
    const { turn } = ctx;
    const tool = getTool(name);
    if (!tool || !ctx.tools.includes(tool)) {
        const text = errorText('unknown_tool', `There is no tool named "${name}" available to this user.`);
        await recordCall(ctx, callId, name, rawArgs, inputRevision, 'error', text);
        return text;
    }
    let input: Record<string, unknown>;
    try {
        input = tool.validate(rawArgs.trim() ? JSON.parse(rawArgs) : {}) as Record<string, unknown>;
    } catch (err) {
        const text = errorText('invalid_arguments', err instanceof ToolInputError ? err.message : 'Arguments were not valid JSON.');
        await recordCall(ctx, callId, name, rawArgs, inputRevision, 'error', text);
        return text;
    }
    if (!(await canUse(ctx, tool))) {
        const text = errorText('permission_denied', 'This user no longer has permission for this.');
        await recordCall(ctx, callId, name, rawArgs, inputRevision, 'denied', text);
        return text;
    }

    await recordCall(ctx, callId, name, rawArgs, inputRevision, 'running');
    const showsRow = tool.kind === 'knowledge' || tool.kind === 'read';
    const label = tool.label(input, turn.lang);
    let row: DisplayItem | null = null;
    if (showsRow) {
        row = await addItem(turn.sessionId, turn.id, { kind: 'tool', id: randomUUID(), turnId: turn.id, callId, name, label, state: 'running', at: Date.now() });
        await fenced(turn.id, ctx.token, (current) => { const entry = current.calls.find((item) => item.id === callId); if (entry) entry.itemId = row!.id; });
    }
    await emit(turn.id, { type: 'status', phase: 'tool', label });

    const callAbort = new AbortController();
    const onAbort = () => callAbort.abort();
    ctx.state.abort.signal.addEventListener('abort', onAbort, { once: true });
    let outcome: ToolOutcome;
    try {
        outcome = await withTimeout(tool.run(input, toolContext(ctx, callId, callAbort.signal)), TOOL_TIMEOUT_MS, callAbort.signal);
    } catch (err) {
        const message = err instanceof ToolInputError || err instanceof ToolConflictError ? err.message
            : err instanceof Error && err.message === 'tool_timeout' ? 'The tool took too long.' : err instanceof Error && err.message === 'tool_aborted' ? 'Stopped.' : 'The tool failed.';
        if (!(err instanceof ToolInputError || err instanceof ToolConflictError) && !(err instanceof Error && /^tool_(timeout|aborted)$/.test(err.message))) {
            await logError({ function: 'siteAgent.tool', tool: name, turnId: turn.id, error: err instanceof Error ? err.stack ?? err.message : String(err) }, { destination: 'both' });
        }
        const text = errorText('tool_failed', message);
        await recordCall(ctx, callId, name, rawArgs, inputRevision, 'error', text);
        if (row) await updateItem(turn.sessionId, turn.id, { ...(row as Extract<DisplayItem, { kind: 'tool' }>), state: 'error' });
        return text;
    } finally {
        ctx.state.abort.signal.removeEventListener('abort', onAbort);
    }

    switch (outcome.type) {
        case 'result': {
            let text = toolResultText(outcome.result, tool.resultBytes);
            // Lookups past the budget still answer, with a nudge to act on what was already found.
            if (tool.kind === 'knowledge' || tool.kind === 'read') {
                const lookups = ctx.turn.calls.filter((call) => { const used = getTool(call.name); return used && (used.kind === 'knowledge' || used.kind === 'read'); }).length;
                if (lookups > LOOKUP_NUDGE_AFTER) {
                    text += `\n[Note: this is lookup ${lookups} for this message. You very likely know enough: act now (propose the changes, show a form, or answer) instead of searching more, unless one essential fact is still missing.]`;
                }
            }
            await fenced(turn.id, ctx.token, (current) => {
                const entry = current.calls.find((item) => item.id === callId);
                if (entry) { entry.state = 'done'; entry.result = text; entry.summary = outcome.summary; entry.endedAt = Date.now(); }
            });
            if (row) await updateItem(turn.sessionId, turn.id, { ...(row as Extract<DisplayItem, { kind: 'tool' }>), state: 'done', ...(outcome.summary ? { summary: outcome.summary } : {}) });
            return text;
        }
        case 'navigate': {
            await addItem(turn.sessionId, turn.id, { kind: 'navigate', id: randomUUID(), turnId: turn.id, callId, action: outcome.action, at: Date.now() });
            const text = JSON.stringify(outcome.action.mode === 'go'
                ? { opened: true, page: outcome.action.route, pointing_at: outcome.action.anchor ?? null }
                : { offered: true, page: outcome.action.route });
            await recordCall(ctx, callId, name, rawArgs, inputRevision, 'done', text);
            return text;
        }
        case 'ui':
            return runUi(ctx, callId, name, rawArgs, inputRevision, outcome.block);
        case 'approval':
            return runApproval(ctx, tool, callId, name, rawArgs, inputRevision, outcome.proposal);
    }
}

/** Pause the turn until the person answers (or it expires / they steer / they stop). */
async function waitFor(ctx: LoopContext, callId: string, kind: 'approval' | 'input'): Promise<WaitResult> {
    const expiresAt = Date.now() + L.waitMs;
    const status: TurnStatus = kind === 'approval' ? 'awaiting_approval' : 'awaiting_input';
    const turn = await fenced(ctx.turn.id, ctx.token, (current) => { current.status = status; current.waiting = { kind, callId, expiresAt }; });
    await emit(turn.id, { type: 'turn', levelCost: turn.levelCost ?? turn.cost ?? 1, turnId: turn.id, sessionId: turn.sessionId, status, inputRevision: turn.inputRevision });
    await emit(turn.id, { type: 'status', phase: 'waiting' });
    const waitStart = Date.now();
    const result = await new Promise<WaitResult>((resolve) => {
        const timer = setTimeout(() => done({ kind: 'expired' }), L.waitMs);
        const done = (value: WaitResult) => { clearTimeout(timer); ctx.state.waiter = null; resolve(value); };
        ctx.state.waiter = { callId, resolve: done };
        // A decision or steer may have landed between saving and listening: check once.
        void store.getTurn(turn.id).then((current) => {
            if (!current) return done({ kind: 'stopped' });
            if (current.stopRequested) return done({ kind: 'stopped' });
            if (current.inputRevision !== turn.inputRevision) return done({ kind: 'superseded' });
            const call = current.calls.find((entry) => entry.id === callId);
            if (call?.approval?.state === 'approved') return done({ kind: 'apply' });
            if (call?.approval?.state === 'skipped') return done({ kind: 'skip' });
            if (call?.ui?.state === 'submitted') return done({ kind: 'submit', values: call.ui.values });
        }).catch(() => {});
    });
    ctx.waitedMs += Date.now() - waitStart;
    const after = await fenced(turn.id, ctx.token, (current) => { current.status = 'running'; current.waiting = undefined; }, ctx.fence.sessionId);
    await emit(after.id, { type: 'turn', levelCost: after.levelCost ?? after.cost ?? 1, turnId: after.id, sessionId: after.sessionId, status: 'running', inputRevision: after.inputRevision });
    return result;
}

async function runUi(ctx: LoopContext, callId: string, name: string, rawArgs: string, inputRevision: number, block: { title: string; html: string; css?: string; js?: string; waitForInput: boolean; height?: number }): Promise<string> {
    const { turn } = ctx;
    let item = await addItem(turn.sessionId, turn.id, { kind: 'ui', id: randomUUID(), turnId: turn.id, callId, block, state: block.waitForInput ? 'open' : 'closed', at: Date.now() }) as Extract<DisplayItem, { kind: 'ui' }>;
    if (!block.waitForInput) {
        const text = JSON.stringify({ shown: true });
        await recordCall(ctx, callId, name, rawArgs, inputRevision, 'done', text);
        return text;
    }
    await fenced(turn.id, ctx.token, (current) => {
        const entry = current.calls.find((call) => call.id === callId);
        if (entry) { entry.state = 'awaiting_input'; entry.itemId = item.id; entry.ui = { state: 'open' }; }
    });
    const answer = await waitFor(ctx, callId, 'input');
    const submitted = answer.kind === 'submit';
    item = await updateItem(turn.sessionId, turn.id, { ...item, state: submitted ? 'submitted' : 'closed' }) as Extract<DisplayItem, { kind: 'ui' }>;
    const text = submitted
        ? toolResultText({ submitted: true, values: answer.values })
        : errorText('not_submitted', answer.kind === 'superseded' ? 'The user sent a message instead of filling the form.' : answer.kind === 'stopped' ? 'The user stopped the assistant.' : 'The form was not answered in time.');
    await fenced(turn.id, ctx.token, (current) => {
        const entry = current.calls.find((call) => call.id === callId);
        if (entry) { entry.state = submitted ? 'done' : answer.kind === 'superseded' ? 'superseded' : 'expired'; entry.result = text; entry.endedAt = Date.now(); if (!submitted) entry.ui = { state: 'closed' }; }
    }).catch(() => undefined);
    return text;
}

async function runApproval(ctx: LoopContext, tool: AgentTool, callId: string, name: string, rawArgs: string, inputRevision: number, proposal: ChangeProposal): Promise<string> {
    const { turn } = ctx;
    const expiresAt = Date.now() + L.waitMs;
    const { payload: _payload, permissions: _permissions, ...view } = proposal;
    let item = await addItem(turn.sessionId, turn.id, { kind: 'approval', id: randomUUID(), turnId: turn.id, callId, proposal: view, state: 'pending', expiresAt, at: Date.now() }) as Extract<DisplayItem, { kind: 'approval' }>;
    await fenced(turn.id, ctx.token, (current) => {
        const entry = current.calls.find((call) => call.id === callId);
        if (entry) { entry.state = 'awaiting_approval'; entry.itemId = item.id; entry.proposal = proposal; entry.approval = { state: 'pending' }; }
    });
    const answer = await waitFor(ctx, callId, 'approval');

    type ShownState = Extract<DisplayItem, { kind: 'approval' }>['state'];
    const settle = async (approvalState: ShownState, callState: store.CallRecord['state'], text: string, extra: { changeId?: string; error?: string } = {}) => {
        item = await updateItem(turn.sessionId, turn.id, { ...item, state: approvalState, ...extra }) as Extract<DisplayItem, { kind: 'approval' }>;
        await fenced(turn.id, ctx.token, (current) => {
            const entry = current.calls.find((call) => call.id === callId);
            if (entry) { entry.state = callState; entry.result = text; entry.endedAt = Date.now(); entry.approval = { ...(entry.approval ?? { state: 'pending' }), state: approvalState, ...extra }; }
        }).catch(() => undefined);
        return text;
    };

    if (answer.kind !== 'apply') {
        const reason = answer.kind === 'skip' ? 'The user skipped this change. Do not propose it again unless they ask.'
            : answer.kind === 'superseded' ? 'Not applied: the user sent a new message first.'
                : answer.kind === 'stopped' ? 'Not applied: the user stopped the assistant.' : 'Not applied: the user did not answer in time.';
        const approvalState = answer.kind === 'skip' ? 'skipped' : answer.kind === 'superseded' ? 'superseded' : 'expired';
        return settle(approvalState, answer.kind === 'skip' ? 'declined' : answer.kind === 'superseded' ? 'superseded' : 'expired', errorText('not_applied', reason));
    }

    // Apply: fresh permission check, then compare-and-set inside the tool.
    if (!tool.apply || !(await canUse(ctx, tool, true)) || !(await ctx.can(proposal.permissions.filter((permission) => permission !== 'owner'), true))) {
        return settle('failed', 'denied', errorText('permission_denied', 'Not applied: this user no longer has permission for this change.'), { error: 'permission_denied' });
    }
    // Claim the approval atomically: a steer or Stop that landed meanwhile wins, and nothing is applied.
    const latest = await store.updateTurn(turn.id, (current) => {
        const entry = current.calls.find((call) => call.id === callId);
        if (current.fence !== ctx.token || !isActive(current.status) || current.stopRequested || current.inputRevision !== inputRevision || entry?.approval?.state !== 'approved') return false;
        entry.approval = { ...entry.approval, state: 'applying' };
    }, ctx.fence).catch(() => null);
    // Claimed only if the stored turn now says so (the update callback may run several times).
    const claimed = latest?.calls.find((call) => call.id === callId)?.approval?.state === 'applying'
        && !latest.stopRequested && latest.inputRevision === inputRevision && latest.fence === ctx.token;
    if (!claimed) {
        const stopped = Boolean(latest?.stopRequested);
        return settle(stopped ? 'expired' : 'superseded', stopped ? 'interrupted' : 'superseded',
            errorText('not_applied', stopped ? 'Not applied: the user stopped the assistant.' : 'Not applied: the user sent a new message first.'));
    }

    const record = async (change: NonNullable<Awaited<ReturnType<NonNullable<AgentTool['apply']>>>['change']>): Promise<string | undefined> => {
        try {
            return await recordChange({
                channelId: turn.channelId,
                actor: { id: turn.userId, login: turn.userLogin, displayName: turn.userDisplayName, role: turn.role },
                sessionId: turn.sessionId, turnId: turn.id, callId, request: turn.userMessage.slice(0, 2000),
                tool: tool.name, title: proposal.title, effects: proposal.effects, change,
            });
        } catch (err) {
            // The change happened; only the log entry is missing. Never report it as "not applied".
            await logError({ function: 'siteAgent.recordChange', tool: name, turnId: turn.id, error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return undefined;
        }
    };
    const applying = tool.apply(proposal, toolContext(ctx, callId, new AbortController().signal));
    try {
        const applied = await withTimeout(applying, 120_000, new AbortController().signal);
        const changeId = applied.change ? await record(applied.change) : undefined;
        return settle('applied', 'done', toolResultText({ applied: true, result: applied.result, ...(changeId ? { changeId } : {}) }), changeId ? { changeId } : {});
    } catch (err) {
        if (err instanceof ToolConflictError) return settle('failed', 'error', errorText('conflict', `Not applied: ${err.message}`), { error: err.message });
        if (err instanceof Error && err.message === 'tool_timeout') {
            // Still running: if it finishes later, the change log gets its entry then.
            void applying.then((late) => (late.change ? record(late.change) : undefined)).catch(() => {});
            return settle('failed', 'error', errorText('outcome_unknown', 'This change took too long: it may or may not have been applied. Check the current state before trying again.'), { error: 'outcome_unknown' });
        }
        // The write may have happened before the error (e.g. a cache refresh after saving failed).
        await logError({ function: 'siteAgent.apply', tool: name, turnId: turn.id, error: err instanceof Error ? err.stack ?? err.message : String(err) }, { destination: 'both' });
        return settle('failed', 'error', errorText('outcome_unknown', 'Something went wrong while saving: this change may or may not have been applied. Check the current state before trying again.'), { error: 'outcome_unknown' });
    }
}

// ---------------------------------------------------------------------------
// Finishing, queue, recovery
// ---------------------------------------------------------------------------

async function finishTurn(turn: store.TurnRecord, status: TurnStatus, errorCode?: string, fence?: store.Fence): Promise<boolean> {
    // From the loop: only while this process still holds the lease. Recovery/Stop of a queued turn: unfenced.
    const ended = await store.updateTurn(turn.id, (current) => {
        if (!isActive(current.status)) return false;
        if (status === 'completed' && current.inputs.some((input) => !input.applied)) return false;
        current.status = status;
        current.endedAt = Date.now();
        current.waiting = undefined;
        if (errorCode) current.errorCode = errorCode;
        for (const call of current.calls) {
            if (['running', 'awaiting_approval', 'awaiting_input', 'pending'].includes(call.state)) call.state = status === 'cancelled' ? 'interrupted' : call.state === 'running' ? 'interrupted' : 'expired';
        }
    }, fence).catch((err) => { if (err instanceof store.LeaseLostError) return null; throw err; });
    if (!ended || ended.status !== status) return false;
    // Cards still waiting (approval/form) close.
    for (const call of ended.calls) {
        if (!call.itemId) continue;
        const item = await store.getItem(ended.sessionId, call.itemId);
        if (item?.kind === 'approval' && item.state === 'pending') {
            // 'applying' = the write had started when the turn ended: its result is unknown.
            const unknown = call.approval?.state === 'applying';
            await updateItem(ended.sessionId, ended.id, unknown ? { ...item, state: 'failed', error: 'outcome_unknown' } : { ...item, state: 'expired' });
        }
        if (item?.kind === 'ui' && item.state === 'open') await updateItem(ended.sessionId, ended.id, { ...item, state: 'closed' });
        if (item?.kind === 'tool' && item.state === 'running') await updateItem(ended.sessionId, ended.id, { ...item, state: 'interrupted' });
    }
    if (status !== 'completed') {
        await addItem(ended.sessionId, ended.id, { kind: 'notice', id: randomUUID(), turnId: ended.id, code: status === 'cancelled' ? 'stopped' : errorCode ?? status, at: Date.now() });
    }
    // Our own failure before the model produced anything: give the message back.
    // Our failure before any answer: the message and the steers sent into it are given back (each on its own day).
    if (status === 'failed' && (ended.answeredSteps ?? ended.steps) === 0) {
        if (ended.countedDay) await refundMessage(ended.channelId, ended.countedDay, ended.cost ?? 1).catch(() => {});
        if (ended.extraCharged && ended.extraDay) await refundMessage(ended.channelId, ended.extraDay, ended.extraCharged).catch(() => {});
        for (const input of ended.inputs) if (input.countedDay) await refundMessage(ended.channelId, input.countedDay, input.cost ?? 1).catch(() => {});
    }
    await store.updateSession(ended.sessionId, (meta) => { if (meta.activeTurnId === ended.id) meta.activeTurnId = null; }).catch(() => null);
    await recordTurn({ channelId: ended.channelId, plan: ended.plan, status, steps: ended.steps, toolCalls: ended.toolCallCount,
        durationMs: (ended.endedAt ?? Date.now()) - (ended.startedAt ?? ended.createdAt), counted: Boolean(ended.countedDay) }).catch(() => {});
    // Not awaited: the owner's log must never hold up the person's answer.
    const seen = traces.get(ended.id);
    traces.delete(ended.id);
    void writeTurnLog(ended, { models: seen?.models, modelCosts: seen?.costs, channelLogin: seen?.channelLogin, knownTool: (name) => getTool(name) !== undefined });
    await emit(ended.id, { type: 'turn', levelCost: ended.levelCost ?? ended.cost ?? 1, turnId: ended.id, sessionId: ended.sessionId, status, inputRevision: ended.inputRevision });
    await emit(ended.id, { type: 'limits', limits: await readLimits(ended.channelId, ended.plan) });
    // A queued message starts right away: announce its turn on this stream before `done`.
    const next = await startNextQueued(ended.sessionId, ended.id).catch(() => null);
    if (next) await emit(ended.id, { type: 'turn', turnId: next, sessionId: ended.sessionId, status: 'queued', inputRevision: 0 });
    await emit(ended.id, { type: 'done', turnId: ended.id, status, ...(errorCode ? { errorCode } : {}) });
    await store.finishActive(ended.id);
    return true;
}

/** Starts the next queued message of a session, if the session is idle. Returns the new turn id. */
async function startNextQueued(sessionId: string, previousTurnId?: string): Promise<string | null> {
    const session = await store.getSession(sessionId);
    if (!session || (session.activeTurnId && session.activeTurnId !== previousTurnId)) return null;
    const queued = await store.popQueuedInput(sessionId);
    if (!queued) return null;
    const access = await resolveAccess(queued.userId, session.channelId);
    if (!access) return null;
    const requester: Requester = { id: queued.userId, login: queued.userLogin, displayName: queued.userDisplayName };
    // Priced again now that the answers ahead of it are done (a fallback, a plan change, the queue order): what the
    // chat really looks like now decides; the difference is given back or charged (never past the daily limit).
    const level = effectiveLevel(access.plan, queued.level);
    const price = messageCost(access.plan, level, session);
    const paid = queued.cost ?? 1;
    const levelCost = price.level;
    let cost = paid;
    if (queued.countedDay && price.total < paid) {
        await refundMessage(session.channelId, queued.countedDay, paid - price.total).catch(() => {});
        cost = price.total;
    } else if (queued.countedDay && price.total > paid) {
        const more = await chargeMore(session.channelId, access.plan, price.total - paid).catch(() => null);
        if (more?.charged) cost = paid + more.charged;
    }
    const turn = newTurn({ sessionId, access, requester, lang: queued.lang, page: queued.page, text: queued.text, userItemId: queued.itemId, mode: 'queue',
        countedDay: queued.countedDay, level, cost, levelCost });
    await store.createTurn(turn);
    const claimed = await store.updateSession(sessionId, (meta) => { if (!meta.activeTurnId || meta.activeTurnId === previousTurnId) meta.activeTurnId = turn.id; });
    if (claimed?.activeTurnId !== turn.id) {
        await store.updateTurn(turn.id, (current) => { current.status = 'cancelled'; current.endedAt = Date.now(); });
        await store.finishActive(turn.id);
        await store.queueInput(sessionId, queued);
        return null;
    }
    const item = await store.getItem(sessionId, queued.itemId);
    if (item?.kind === 'user') await updateItem(sessionId, turn.id, { ...item, turnId: turn.id });
    await emit(turn.id, { type: 'turn', levelCost: turn.levelCost ?? turn.cost ?? 1, turnId: turn.id, sessionId, status: 'queued', inputRevision: 0 });
    schedule(turn.id);
    return turn.id;
}

/** Turns whose process died: lease expired while still active → interrupted (tools never re-run). */
async function recover(): Promise<void> {
    for (const id of await store.activeTurnIds()) {
        if (running.has(id) || scheduled.has(id)) continue;
        const turn = await store.getTurn(id);
        if (!turn) { await store.finishActive(id); continue; }
        if (!isActive(turn.status)) { await store.finishActive(id); continue; }
        if (turn.status === 'queued') { schedule(id); continue; }
        if (await store.leaseHolder(turn.sessionId)) continue; // still owned (maybe another process)
        await store.updateTurn(id, (current) => { current.fence = undefined; }).catch(() => null);
        const fresh = await store.getTurn(id);
        if (fresh && isActive(fresh.status)) await finishTurn(fresh, 'interrupted', 'interrupted');
    }
}

let started = false;

export function startSiteAgentRuntime(): void {
    if (started) return;
    started = true;
    warmKnowledge();
    const recovery = setInterval(() => { void recover().catch(() => {}); }, 10_000);
    recovery.unref();
    const maintenance = setInterval(() => {
        void drainReconcile(20).catch(() => {});
        void drainPolarRetries(50).catch(() => {});
        void retryLateSteps(50);
        void clearExpiredTurnText();
    }, 30_000);
    maintenance.unref();
    void recover().catch(() => {});
}

/** For the snapshot endpoint. */
export function isTurnActive(status: TurnStatus): boolean {
    return isActive(status);
}
