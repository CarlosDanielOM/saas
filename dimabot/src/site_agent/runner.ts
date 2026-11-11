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
import { PLAN_MODELS, SITE_AGENT_LIMITS as L } from './config.js';
import { channelFacts, compact, dropOldest, estimateItemTokens, estimateTokens, repairContext, toMessages } from './context.js';
import { getDocsPromptIndex } from './docs/index.js';
import { refundMessage, readLimits, takeMessage, utcDay } from './limits.js';
import { estimateUsageCost } from './llm/cost.js';
import { LlmError, streamChat } from './llm/openrouter.js';
import { buildSystemPrompt, FINAL_STEP_NOTE, STEER_PREFIX, turnNote } from './prompt.js';
import { loadPersona, personaAvailable, readPrefs } from './prefs.js';
import * as store from './store.js';
import { warmKnowledge } from './tools/knowledge.js';
import { getTool, toLlmTools, toolResultText, toolsFor } from './tools/registry.js';
import {
    ToolConflictError, ToolInputError,
    type AgentEvent, type AgentTool, type ChangeProposal, type ContextItem, type DisplayItem, type InputMode, type Lang, type LimitsView,
    type LlmStepResult, type PageContext, type Requester, type ToolContext, type ToolOutcome, type TurnStatus,
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
}

function newTurn(input: { id?: string; sessionId: string; access: ChannelAccess; requester: Requester; lang: Lang; page: PageContext | null; text: string; userItemId: string; mode: InputMode; countedDay: string; retryOf?: string; userAdded?: boolean }): store.TurnRecord {
    return {
        id: input.id ?? randomUUID(), sessionId: input.sessionId, channelId: input.access.channelId,
        userId: input.requester.id, userLogin: input.requester.login, userDisplayName: input.requester.displayName,
        role: input.requester.id === input.access.channelId ? 'owner' : input.access.role, plan: input.access.plan, lang: input.lang, page: input.page,
        status: 'queued', revision: 1, inputRevision: 0, createdAt: Date.now(), userMessage: input.text, userItemId: input.userItemId, mode: input.mode,
        countedDay: input.countedDay, retryOf: input.retryOf, userAdded: input.userAdded ?? false, lastPromptTokens: 0, lastPromptItems: 0,
        stopRequested: false, steps: 0, toolCallCount: 0, activeMs: 0, inputs: [], calls: [],
        usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, unknownSteps: 0 },
    };
}

export async function submitMessage(input: SubmitInput): Promise<{ sessionId: string; turnId: string; limits: LimitsView; queued?: boolean }> {
    const text = cleanText(input.text, L.userMessageChars);
    const { access, requester } = input;
    const contextLimit = PLAN_MODELS[access.plan].contextLimit;

    let session = input.sessionId ? await store.getOwnSession(input.sessionId, access.channelId, requester.id) : null;
    if (input.sessionId && !session) throw new AgentRequestError('session_not_found', 404, 'Chat not found (chats are kept for 3 days)');
    const active = session?.activeTurnId ? await store.getTurn(session.activeTurnId) : null;
    const activeTurn = active && isActive(active.status) ? active : null;

    if (input.mode === 'send' && activeTurn) throw new AgentRequestError('turn_active', 409, 'The assistant is still working on this chat', { turnId: activeTurn.id });
    if (input.mode !== 'send' && !activeTurn) throw new AgentRequestError('turn_not_active', 409, 'Nothing is running in this chat; send it as a new message');
    if (input.mode === 'steer' && activeTurn && activeTurn.inputs.length >= L.steerInputsPerTurn) throw new AgentRequestError('too_many_inputs', 429, 'Too many messages for this answer; wait for it to finish');
    if (input.mode === 'queue' && session && await store.queuedCount(session.id) >= L.queuedInputsPerSession) throw new AgentRequestError('queue_full', 429, 'Too many queued messages');

    const taken = await takeMessage(access.channelId, access.plan);
    if (!taken.allowed) throw new AgentRequestError('daily_limit', 429, 'Daily message limit reached', { limits: taken.limits });
    const day = utcDay();

    try {
        if (!session) session = await store.createSession(access.channelId, requester.id, titleFrom(text), contextLimit);
        const sessionId = session.id;
        const itemId = randomUUID();

        if (input.mode === 'steer' && activeTurn) {
            const item: DisplayItem = { kind: 'user', id: itemId, turnId: activeTurn.id, text, mode: 'steer', at: Date.now() };
            const updated = await store.updateTurn(activeTurn.id, (turn) => {
                if (!isActive(turn.status) || turn.stopRequested) return false;
                turn.inputs.push({ id: randomUUID(), text, at: Date.now(), applied: false, itemId });
                turn.inputRevision++;
            });
            if (!updated || !isActive(updated.status) || updated.inputs.every((entry) => entry.itemId !== itemId)) {
                throw new AgentRequestError('turn_not_active', 409, 'That answer already finished; send it as a new message');
            }
            await addItem(sessionId, activeTurn.id, item);
            await emit(activeTurn.id, { type: 'turn', turnId: activeTurn.id, sessionId, status: updated.status, inputRevision: updated.inputRevision });
            await emit(activeTurn.id, { type: 'limits', limits: taken.limits });
            wakeForSteer(activeTurn.id);
            return { sessionId, turnId: activeTurn.id, limits: taken.limits };
        }

        if (input.mode === 'queue' && activeTurn) {
            const item: DisplayItem = { kind: 'user', id: itemId, turnId: '', text, mode: 'queue', at: Date.now() };
            await store.queueInput(sessionId, { id: randomUUID(), itemId, text, page: input.page, lang: input.lang, userId: requester.id,
                userLogin: requester.login, userDisplayName: requester.displayName, countedDay: day, at: Date.now() });
            await addItem(sessionId, activeTurn.id, item);
            await emit(activeTurn.id, { type: 'limits', limits: taken.limits });
            // The answer may have finished while we queued: then nobody would pick this up, so start it here.
            const now = await store.getSession(sessionId);
            const current = now?.activeTurnId ? await store.getTurn(now.activeTurnId) : null;
            if (!current || !isActive(current.status)) await startNextQueued(sessionId, now?.activeTurnId ?? undefined);
            return { sessionId, turnId: activeTurn.id, limits: taken.limits, queued: true };
        }

        // Claim the session for this turn only if nobody else did since we looked (two quick sends).
        const turn = newTurn({ sessionId, access, requester, lang: input.lang, page: input.page, text, userItemId: itemId, mode: 'send', countedDay: day });
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
        await emit(turn.id, { type: 'turn', turnId: turn.id, sessionId, status: 'queued', inputRevision: 0 });
        await emit(turn.id, { type: 'limits', limits: taken.limits });
        schedule(turn.id);
        return { sessionId, turnId: turn.id, limits: taken.limits };
    } catch (err) {
        await refundMessage(access.channelId, day).catch(() => {});
        throw err;
    }
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
    const retry = newTurn({ sessionId: session.id, access, requester, lang: turn.lang, page: turn.page, text: turn.userMessage, userItemId: turn.userItemId,
        mode: 'send', countedDay: '', retryOf: turn.id, userAdded: turn.userAdded });
    await store.createTurn(retry);
    const claimed = await store.updateSession(session.id, (meta) => { if (!meta.activeTurnId) meta.activeTurnId = retry.id; });
    if (claimed?.activeTurnId !== retry.id) {
        await store.updateTurn(retry.id, (current) => { current.status = 'cancelled'; current.endedAt = Date.now(); });
        await store.finishActive(retry.id);
        throw new AgentRequestError('turn_active', 409);
    }
    await emit(retry.id, { type: 'turn', turnId: retry.id, sessionId: session.id, status: 'queued', inputRevision: 0 });
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
        await emit(turnId, { type: 'turn', turnId, sessionId: claimed.sessionId, status: 'running', inputRevision: claimed.inputRevision });
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
    const cfg = PLAN_MODELS[turn.plan];
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
    const ctx: LoopContext = { turn, token, fence, waitedMs: 0, state, access, can, tools, items };
    const loopStart = Date.now();
    const activeNow = () => Date.now() - loopStart - ctx.waitedMs;
    let lastError: LlmError | null = null;

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

        // 2. Compaction at 90% of the plan's limit.
        const sinceMeasured = items.slice(turn.lastPromptItems).reduce((sum, item) => sum + estimateItemTokens(item), 0);
        const estimate = turn.lastPromptTokens ? turn.lastPromptTokens + sinceMeasured : systemTokens + items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
        if (estimate >= cfg.contextLimit * cfg.compactAt) {
            await emit(turn.id, { type: 'status', phase: 'compacting', label: turn.lang === 'es' ? 'Resumiendo la conversación…' : 'Summarizing the conversation…' });
            try {
                const result = await compact({ items, currentUserIndex: currentUserIndex(), limitTokens: cfg.contextLimit - systemTokens, model: cfg.model, effort: cfg.effort, sessionKey: turn.sessionId, signal: state.abort.signal });
                if (result.step) await recordUsage(turn, result.step, 'compaction', cfg.model);
                items = result.compacted ? result.items : dropOldest(items, currentUserIndex(), Math.floor((cfg.contextLimit - systemTokens) * 0.6));
            } catch (err) {
                if (state.abort.signal.aborted) continue;
                await warn({ function: 'siteAgent.compact', turnId: turn.id, error: err instanceof Error ? err.message : String(err) }, { destination: 'console' });
                items = dropOldest(items, currentUserIndex(), Math.floor((cfg.contextLimit - systemTokens) * 0.6));
            }
            ctx.items = items;
            await store.setContext(turn.sessionId, items, fence);
            turn = ctx.turn = await fenced(turn.id, token, (current) => { current.lastPromptTokens = 0; current.lastPromptItems = 0; });
        }

        // 3. One model step.
        const activeMs = activeNow();
        const final = turn.steps >= L.maxModelSteps - 1 || turn.toolCallCount >= L.maxToolCalls || activeMs >= L.activeMs;
        const messages = toMessages(system, items, cfg.model);
        if (final) messages.push({ role: 'user', content: FINAL_STEP_NOTE });
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
            await text.close();
            state.abort.signal.removeEventListener('abort', onRunAbort);
            state.step = null;
            if (err instanceof LlmError && err.kind === 'aborted') {
                if (state.abort.signal.aborted) { await finishTurn((await store.getTurn(turn.id))!, 'cancelled', undefined, ctx.fence); return; }
                continue; // steered before the stream started
            }
            // A started generation is billed even when the stream failed.
            if (err instanceof LlmError && err.generationId) {
                await queueReconcile({ generationId: err.generationId, channelId: turn.channelId, plan: turn.plan, sessionId: turn.sessionId, turnId: turn.id,
                    step: `${turn.steps}-e${Date.now().toString(36)}`, model: cfg.model, requesterId: turn.userId, kind: 'step' }).catch(() => {});
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
        if (result.usage) await store.updateSession(turn.sessionId, (meta) => { meta.contextTokens = result.usage!.promptTokens; meta.contextLimit = cfg.contextLimit; });

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

        // 4. Save the assistant step. On the forced last step, tool calls are ignored.
        const calls = final ? [] : result.toolCalls;
        items.push({ role: 'assistant', content: result.content || null, ...(calls.length ? { toolCalls: calls } : {}),
            ...(result.reasoning.length ? { reasoning: { provider: 'openrouter' as const, model: cfg.model, details: result.reasoning } } : {}), at: Date.now() });
        await store.setContext(turn.sessionId, items, fence);

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
    let usage = step.usage;
    if (usage && usage.upstreamCostUsd === null) usage = estimateUsageCost(model, usage);
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
        current.usage.costUsd += usage.upstreamCostUsd ?? 0;
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
    await emit(turn.id, { type: 'turn', turnId: turn.id, sessionId: turn.sessionId, status, inputRevision: turn.inputRevision });
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
    await emit(after.id, { type: 'turn', turnId: after.id, sessionId: after.sessionId, status: 'running', inputRevision: after.inputRevision });
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
    if (status === 'failed' && ended.steps === 0 && ended.countedDay) await refundMessage(ended.channelId, ended.countedDay).catch(() => {});
    await store.updateSession(ended.sessionId, (meta) => { if (meta.activeTurnId === ended.id) meta.activeTurnId = null; }).catch(() => null);
    await recordTurn({ channelId: ended.channelId, plan: ended.plan, status, steps: ended.steps, toolCalls: ended.toolCallCount,
        durationMs: (ended.endedAt ?? Date.now()) - (ended.startedAt ?? ended.createdAt), counted: Boolean(ended.countedDay) }).catch(() => {});
    await emit(ended.id, { type: 'turn', turnId: ended.id, sessionId: ended.sessionId, status, inputRevision: ended.inputRevision });
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
    const turn = newTurn({ sessionId, access, requester, lang: queued.lang, page: queued.page, text: queued.text, userItemId: queued.itemId, mode: 'queue', countedDay: queued.countedDay });
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
    await emit(turn.id, { type: 'turn', turnId: turn.id, sessionId, status: 'queued', inputRevision: 0 });
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
    }, 30_000);
    maintenance.unref();
    void recover().catch(() => {});
}

/** For the snapshot endpoint. */
export function isTurnActive(status: TurnStatus): boolean {
    return isActive(status);
}
