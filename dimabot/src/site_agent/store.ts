/**
 * Dragonfly persistence for the site agent: sessions (meta, display items, model context, queued
 * inputs), turns (JSON + revision, compare-and-set), the per-turn event stream used for SSE replay,
 * and session leases. Everything about a session expires 72 h after its last write.
 *
 * Ordering rule: state is written before the matching event is appended, so a snapshot read in one
 * MULTI (cursor + items) never misses what an event at or before that cursor described.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { SITE_AGENT_KEYS as K, SITE_AGENT_LIMITS as L } from './config.js';
import type {
    AgentEvent, ChangeProposal, ContextItem, DisplayItem, InputMode, Lang, PageContext, PlanTier, SessionMeta,
    ToolCallState, TurnStatus,
} from './types.js';

const redis = () => getDragonflyClient('site-agent');
const EVENT_TTL_SECONDS = 2 * 3600;
const EVENT_MAXLEN = 4000;
const TURN_TTL_SECONDS = L.sessionTtlSeconds;

// ---------------------------------------------------------------------------
// Turn record
// ---------------------------------------------------------------------------

export interface CallRecord {
    id: string;
    name: string;
    args: string;
    state: ToolCallState;
    itemId: string | null;
    inputRevision: number;
    /** Result text sent to the model (clipped). Present once the call finished. */
    result?: string;
    summary?: string;
    proposal?: ChangeProposal;
    approval?: { state: 'pending' | 'approved' | 'applying' | 'applied' | 'skipped' | 'expired' | 'failed' | 'superseded'; decidedAt?: number; changeId?: string; error?: string };
    ui?: { state: 'open' | 'submitted' | 'closed'; values?: unknown };
    startedAt: number;
    endedAt?: number;
}

export interface TurnRecord {
    id: string;
    sessionId: string;
    channelId: string;
    userId: string;
    userLogin: string;
    userDisplayName: string;
    role: 'owner' | 'admin';
    plan: PlanTier;
    lang: Lang;
    page: PageContext | null;
    status: TurnStatus;
    revision: number;
    inputRevision: number;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    /** The user's message (plain) and its display item. */
    userMessage: string;
    userItemId: string;
    mode: InputMode;
    /** Counted toward the daily limit on this UTC day ('' = not counted, e.g. retry). */
    countedDay: string;
    retryOf?: string;
    /** The user message is in the model context (set once; retries reuse it). */
    userAdded: boolean;
    /** Real prompt size of the last model step (for the compaction trigger). */
    lastPromptTokens: number;
    /** Context length when lastPromptTokens was measured. */
    lastPromptItems: number;
    fence?: string;
    stopRequested: boolean;
    steps: number;
    toolCallCount: number;
    activeMs: number;
    inputs: { id: string; text: string; at: number; applied: boolean; itemId: string }[];
    calls: CallRecord[];
    waiting?: { kind: 'approval' | 'input'; callId: string; expiresAt: number };
    errorCode?: string;
    usage: { promptTokens: number; cachedTokens: number; completionTokens: number; reasoningTokens: number; costUsd: number; unknownSteps: number };
}

const CAS = `
if KEYS[2] and redis.call('GET', KEYS[2]) ~= ARGV[5] then return -1 end
if redis.call('HGET', KEYS[1], 'rev') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'rev', ARGV[2], 'json', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;

/** Thrown by fenced writes when this process no longer holds the session lease. */
export class LeaseLostError extends Error {}

export interface Fence { sessionId: string; token: string }

export async function createTurn(turn: TurnRecord): Promise<void> {
    const client = await redis();
    await client.multi()
        .hSet(K.turn(turn.id), { rev: String(turn.revision), json: JSON.stringify(turn) })
        .expire(K.turn(turn.id), TURN_TTL_SECONDS)
        .sAdd(K.activeTurns, turn.id)
        .exec();
}

export async function getTurn(id: string): Promise<TurnRecord | null> {
    const json = await (await redis()).hGet(K.turn(id), 'json');
    return json ? JSON.parse(json) as TurnRecord : null;
}

/**
 * Compare-and-set update. `mutate` gets a fresh copy; return false to skip writing.
 * Returns the stored turn (updated or not), or null if the turn is gone.
 */
export async function updateTurn(id: string, mutate: (turn: TurnRecord) => boolean | void, fence?: Fence): Promise<TurnRecord | null> {
    const client = await redis();
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = await getTurn(id);
        if (!current) return null;
        const next = structuredClone(current);
        if (mutate(next) === false) return current;
        next.revision = current.revision + 1;
        const ok = Number(await client.eval(CAS, {
            keys: fence ? [K.turn(id), K.lease(fence.sessionId)] : [K.turn(id)],
            arguments: [String(current.revision), String(next.revision), JSON.stringify(next), String(TURN_TTL_SECONDS), fence?.token ?? ''],
        }));
        if (ok === 1) return next;
        if (ok === -1) throw new LeaseLostError();
    }
    throw new Error('site_agent_turn_contention');
}

export async function finishActive(turnId: string): Promise<void> {
    await (await redis()).sRem(K.activeTurns, turnId);
}

export async function activeTurnIds(): Promise<string[]> {
    return (await redis()).sMembers(K.activeTurns);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionKeys(sessionId: string): string[] {
    return [K.session(sessionId), K.sessionItems(sessionId), `${K.sessionItems(sessionId)}:order`, K.sessionContext(sessionId), K.sessionQueue(sessionId)];
}

async function touch(sessionId: string, channelId: string, userId: string, at = Date.now()): Promise<void> {
    const client = await redis();
    const multi = client.multi();
    for (const key of sessionKeys(sessionId)) multi.expire(key, L.sessionTtlSeconds);
    multi.zAdd(K.userSessions(channelId, userId), { score: at, value: sessionId });
    multi.expire(K.userSessions(channelId, userId), L.sessionTtlSeconds);
    await multi.exec();
}

export async function createSession(channelId: string, userId: string, title: string, contextLimit: number): Promise<SessionMeta> {
    const now = Date.now();
    const meta: SessionMeta = { id: randomUUID(), channelId, userId, title, createdAt: now, updatedAt: now, activeTurnId: null, contextTokens: 0, contextLimit };
    const client = await redis();
    await client.multi()
        .set(K.session(meta.id), JSON.stringify(meta), { EX: L.sessionTtlSeconds })
        .set(K.sessionContext(meta.id), '[]', { EX: L.sessionTtlSeconds })
        .exec();
    await touch(meta.id, channelId, userId, now);
    // Keep at most N sessions per person per channel: the oldest go first (never one with an active turn).
    const ids = await client.zRange(K.userSessions(channelId, userId), 0, -1);
    if (ids.length > L.sessionsPerUserChannel) {
        for (const old of ids.slice(0, ids.length - L.sessionsPerUserChannel)) {
            const oldMeta = await getSession(old);
            if (oldMeta?.activeTurnId) continue;
            await deleteSession(old, channelId, userId);
        }
    }
    return meta;
}

export async function getSession(sessionId: string): Promise<SessionMeta | null> {
    const json = await (await redis()).get(K.session(sessionId));
    return json ? JSON.parse(json) as SessionMeta : null;
}

/** Session owned by this person on this channel, else null (never reveals other sessions). */
export async function getOwnSession(sessionId: string, channelId: string, userId: string): Promise<SessionMeta | null> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
    const meta = await getSession(sessionId);
    return meta && meta.channelId === channelId && meta.userId === userId ? meta : null;
}

// The connection is shared, so no WATCH: compare the whole stored JSON instead.
const SET_IF_SAME = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 end return 0`;

/** Compare-and-set update; `mutate` may return false to keep the session unchanged (returns it as stored). */
export async function updateSession(sessionId: string, mutate: (meta: SessionMeta) => boolean | void): Promise<SessionMeta | null> {
    const client = await redis();
    for (let attempt = 0; attempt < 8; attempt++) {
        const json = await client.get(K.session(sessionId));
        if (!json) return null;
        const meta = JSON.parse(json) as SessionMeta;
        if (mutate(meta) === false) return JSON.parse(json) as SessionMeta;
        meta.updatedAt = Math.max(meta.updatedAt, Date.now());
        const ok = Number(await client.eval(SET_IF_SAME, { keys: [K.session(sessionId)], arguments: [json, JSON.stringify(meta), String(L.sessionTtlSeconds)] }));
        if (ok === 1) { await touch(sessionId, meta.channelId, meta.userId, meta.updatedAt); return meta; }
    }
    throw new Error('site_agent_session_contention');
}

export async function listSessions(channelId: string, userId: string): Promise<SessionMeta[]> {
    const client = await redis();
    const ids = await client.zRange(K.userSessions(channelId, userId), 0, -1, { REV: true });
    if (!ids.length) return [];
    const metas = await client.mGet(ids.map((id) => K.session(id)));
    const sessions: SessionMeta[] = [];
    const gone: string[] = [];
    metas.forEach((json, index) => { if (json) sessions.push(JSON.parse(json)); else gone.push(ids[index]); });
    if (gone.length) await client.zRem(K.userSessions(channelId, userId), gone);
    return sessions;
}

export async function deleteSession(sessionId: string, channelId: string, userId: string): Promise<void> {
    const client = await redis();
    await client.multi().del(sessionKeys(sessionId)).zRem(K.userSessions(channelId, userId), sessionId).exec();
}

// ---------------------------------------------------------------------------
// Display items
// ---------------------------------------------------------------------------

export async function putItem(sessionId: string, item: DisplayItem, isNew: boolean): Promise<void> {
    const client = await redis();
    const multi = client.multi()
        .hSet(K.sessionItems(sessionId), item.id, JSON.stringify(item))
        .expire(K.sessionItems(sessionId), L.sessionTtlSeconds);
    if (isNew) multi.rPush(`${K.sessionItems(sessionId)}:order`, item.id).expire(`${K.sessionItems(sessionId)}:order`, L.sessionTtlSeconds);
    await multi.exec();
}

export async function getItem(sessionId: string, itemId: string): Promise<DisplayItem | null> {
    const json = await (await redis()).hGet(K.sessionItems(sessionId), itemId);
    return json ? JSON.parse(json) as DisplayItem : null;
}

/** Items in order plus the newest event cursor of the active turn, read atomically. */
export async function snapshot(sessionId: string, activeTurnId: string | null): Promise<{ items: DisplayItem[]; cursor: string }> {
    const client = await redis();
    const multi = client.multi()
        .lRange(`${K.sessionItems(sessionId)}:order`, 0, -1)
        .hGetAll(K.sessionItems(sessionId));
    if (activeTurnId) multi.xRevRange(K.turnEvents(activeTurnId), '+', '-', { COUNT: 1 });
    const [order, all, last] = await multi.exec() as unknown as [string[], Record<string, string>, { id: string }[] | undefined];
    const items = order.map((id) => all[id]).filter(Boolean).map((json) => JSON.parse(json) as DisplayItem);
    return { items, cursor: last?.[0]?.id ?? '0-0' };
}

// ---------------------------------------------------------------------------
// Model context
// ---------------------------------------------------------------------------

export async function getContext(sessionId: string): Promise<ContextItem[]> {
    const json = await (await redis()).get(K.sessionContext(sessionId));
    return json ? JSON.parse(json) as ContextItem[] : [];
}

const SET_IF_LEASE = `if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3]) return 1`;

/** Writes the model context; with a fence, only while this process holds the session lease. */
export async function setContext(sessionId: string, items: ContextItem[], fence?: Fence): Promise<void> {
    const client = await redis();
    if (!fence) { await client.set(K.sessionContext(sessionId), JSON.stringify(items), { EX: L.sessionTtlSeconds }); return; }
    const ok = Number(await client.eval(SET_IF_LEASE, { keys: [K.sessionContext(sessionId), K.lease(fence.sessionId)], arguments: [JSON.stringify(items), fence.token, String(L.sessionTtlSeconds)] }));
    if (ok !== 1) throw new LeaseLostError();
}

// ---------------------------------------------------------------------------
// Queued inputs ("Queue for after")
// ---------------------------------------------------------------------------

export interface QueuedInput {
    id: string;
    /** Display item already shown in the chat (mode 'queue'). */
    itemId: string;
    text: string;
    page: PageContext | null;
    lang: Lang;
    userId: string;
    userLogin: string;
    userDisplayName: string;
    countedDay: string;
    at: number;
}

export async function queueInput(sessionId: string, input: QueuedInput): Promise<number> {
    const client = await redis();
    const length = await client.rPush(K.sessionQueue(sessionId), JSON.stringify(input));
    await client.expire(K.sessionQueue(sessionId), L.sessionTtlSeconds);
    return length;
}

export async function queuedCount(sessionId: string): Promise<number> {
    return (await redis()).lLen(K.sessionQueue(sessionId));
}

export async function popQueuedInput(sessionId: string): Promise<QueuedInput | null> {
    const json = await (await redis()).lPop(K.sessionQueue(sessionId));
    return json ? JSON.parse(json) as QueuedInput : null;
}

export async function clearQueue(sessionId: string): Promise<QueuedInput[]> {
    const client = await redis();
    const [items] = await client.multi().lRange(K.sessionQueue(sessionId), 0, -1).del(K.sessionQueue(sessionId)).exec() as unknown as [string[]];
    return (items ?? []).map((json) => JSON.parse(json) as QueuedInput);
}

// ---------------------------------------------------------------------------
// Events: persisted (stream, for replay) then published in-process (live SSE).
// The API runs as one process; replay covers reconnects and restarts.
// ---------------------------------------------------------------------------

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export interface StoredEvent { id: string; event: AgentEvent }

export async function appendEvent(turnId: string, event: AgentEvent): Promise<string> {
    const client = await redis();
    const id = await client.xAdd(K.turnEvents(turnId), '*', { e: JSON.stringify(event) }, {
        TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: EVENT_MAXLEN },
    });
    await client.expire(K.turnEvents(turnId), EVENT_TTL_SECONDS);
    bus.emit(turnId, { id, event } satisfies StoredEvent);
    return id;
}

export function compareIds(a: string, b: string): number {
    const [am, as] = a.split('-').map(Number);
    const [bm, bs] = b.split('-').map(Number);
    return am !== bm ? am - bm : (as ?? 0) - (bs ?? 0);
}

/**
 * Events after `cursor`. `gap` = the cursor is older than what the stream still holds (or the
 * stream is gone), so the client must reload the snapshot.
 */
export async function eventsAfter(turnId: string, cursor: string): Promise<{ events: StoredEvent[]; gap: boolean }> {
    const client = await redis();
    const rows = await client.xRange(K.turnEvents(turnId), cursor === '0-0' ? '-' : cursor, '+');
    const events = rows.filter((row) => row.id !== cursor).map((row) => ({ id: row.id, event: JSON.parse(row.message.e) as AgentEvent }));
    let gap = false;
    if (cursor !== '0-0') {
        const first = await client.xRange(K.turnEvents(turnId), '-', '+', { COUNT: 1 });
        gap = !first.length || compareIds(first[0].id, cursor) > 0;
    }
    return { events, gap };
}

// ---------------------------------------------------------------------------
// Session lease (one running turn per session) with a fencing token
// ---------------------------------------------------------------------------

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
export const LEASE_MS = 60_000;

export async function acquireLease(sessionId: string): Promise<string | null> {
    const token = randomUUID();
    const ok = await (await redis()).set(K.lease(sessionId), token, { NX: true, PX: LEASE_MS });
    return ok ? token : null;
}

export async function renewLease(sessionId: string, token: string): Promise<boolean> {
    return Number(await (await redis()).eval(RENEW, { keys: [K.lease(sessionId)], arguments: [token, String(LEASE_MS)] })) === 1;
}

export async function releaseLease(sessionId: string, token: string): Promise<void> {
    await (await redis()).eval(RELEASE, { keys: [K.lease(sessionId)], arguments: [token] });
}

export async function leaseHolder(sessionId: string): Promise<string | null> {
    return (await redis()).get(K.lease(sessionId));
}

// ---------------------------------------------------------------------------
// Idempotent requests (clientRequestId, per user, 10 minutes)
// ---------------------------------------------------------------------------

const REQUEST_TTL_SECONDS = 600;
const requestKey = (userId: string, id: string) => `site_agent:req:${userId}:${id}`;

/** 'new' → caller must finish with `finishRequest`; otherwise the stored result or 'pending'. */
export async function beginRequest(userId: string, clientRequestId: string, fingerprint: string): Promise<{ state: 'new' } | { state: 'pending' } | { state: 'conflict' } | { state: 'done'; result: unknown }> {
    const client = await redis();
    const key = requestKey(userId, clientRequestId);
    const created = await client.set(key, JSON.stringify({ fingerprint, state: 'pending' }), { NX: true, EX: REQUEST_TTL_SECONDS });
    if (created) return { state: 'new' };
    const stored = JSON.parse(await client.get(key) ?? '{}') as { fingerprint?: string; state?: string; result?: unknown };
    if (stored.fingerprint !== fingerprint) return { state: 'conflict' };
    return stored.state === 'done' ? { state: 'done', result: stored.result } : { state: 'pending' };
}

export async function finishRequest(userId: string, clientRequestId: string, fingerprint: string, result: unknown | null): Promise<void> {
    const client = await redis();
    const key = requestKey(userId, clientRequestId);
    if (result === null) await client.del(key);
    else await client.set(key, JSON.stringify({ fingerprint, state: 'done', result }), { EX: REQUEST_TTL_SECONDS });
}
