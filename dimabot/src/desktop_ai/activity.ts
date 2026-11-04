import { TURN_STATUS_FEATURE, subscribeTurnUpdates, refreshPetTurnUpdates, type TurnUpdate } from './updates.js';
import { subscribePetWakeups } from '../pets/wakeups.js';
import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { authenticateAccess, type AccessIdentity } from '../server/oauth/service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';

/** A shared output slot. A preparing slot is already reserved, but has not played. */
export interface SpeechActivityHandle {
    channelId: string;
    playbackId: string;
    outputGeneration: number;
    source: 'bot' | 'pet' | 'tts';
    expiresAt: number;
    fence: string;
}
type ActivityInput = Omit<SpeechActivityHandle, 'fence'> & { signal?: AbortSignal; requiredSessionId?: string };
type RetiredProof = { kind: 'pet'; ownerId: string; peerId: string; leaseId: string; requestId: string; generation: number }
    | { kind: 'tts'; source: string };
type Stored = SpeechActivityHandle & { phase: 'preparing' | 'playing'; retiredProof?: RetiredProof };
interface Peer { socket: Socket; identity: AccessIdentity; token: string; ready: Promise<void>; snapshotSent?: boolean; turnStatus?: boolean; turnRevisions?: Map<string, number> }
const peers = new Map<string, Peer>();
const timers = new Map<string, NodeJS.Timeout>();
const slotKey = (channel: string) => `desktop:speech:slot:${channel}`;
const revisionKey = (channel: string) => `desktop:speech:revision:${channel}`;
const wakeKey = (channel: string) => `desktop:speech:wake:${channel}`;
const wakeups = new Map<string, Set<() => void>>();
const SLOT_GRACE_MS = 30_000;
const keyFor = (h: SpeechActivityHandle) => `${h.channelId}:${h.playbackId}:${h.outputGeneration}:${h.fence}`;
const publicActivity = (value: Stored) => ({ playback_id: value.playbackId, output_generation: value.outputGeneration,
    source: value.source, phase: value.phase, expires_at: value.expiresAt });
const boundedReason = (reason: string) => /^[a-z0-9_-]{1,64}$/i.test(reason) ? reason : 'ended';
function signal(channel: string) { for (const wake of wakeups.get(wakeKey(channel)) ?? []) wake(); }

// The single Redis slot is durable across API restarts and atomically serializes
// every producer, including preparation. A fence keeps late terminals harmless.
const reserveScript = `
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
local r=redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 86400); return r`;
const startScript = `
local raw=redis.call('GET', KEYS[1]); if not raw then return 0 end
local item=cjson.decode(raw); if item.fence ~= ARGV[1] then return 0 end
if tonumber(item.expiresAt) <= tonumber(ARGV[2]) then return 0 end
if item.phase == 'playing' then return -1 end
item.phase='playing'; local ttl=redis.call('PTTL',KEYS[1]); if ttl <= 0 then return 0 end
redis.call('SET',KEYS[1],cjson.encode(item),'PX',ttl)
local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return r`;
const finishScript = `
local raw=redis.call('GET', KEYS[1]); if not raw then return {0,''} end
local item=cjson.decode(raw); if item.fence ~= ARGV[1] then return {0,''} end
redis.call('DEL',KEYS[1]); local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return {r,raw}`;
const extendScript = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local item=cjson.decode(raw); if item.fence ~= ARGV[1] or item.phase ~= 'playing' then return 0 end
if tonumber(item.expiresAt) >= tonumber(ARGV[2]) then return -1 end
item.expiresAt=tonumber(ARGV[2]); redis.call('SET',KEYS[1],cjson.encode(item),'PX',ARGV[3])
local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return r`;
const retireScript = `
local raw=redis.call('GET',KEYS[1]); if not raw then return {0,''} end
local item=cjson.decode(raw); if item.fence ~= ARGV[1] then return {0,''} end
local proof=cjson.decode(ARGV[2]); if not item.retiredProof or item.retiredProof.kind ~= 'pet' or proof.kind == 'pet' then item.retiredProof=proof end
item.expiresAt=math.min(tonumber(item.expiresAt),tonumber(ARGV[3]))
local ttl=math.max(1,tonumber(item.expiresAt)-tonumber(ARGV[4]))+tonumber(ARGV[5])
raw=cjson.encode(item); redis.call('SET',KEYS[1],raw,'PX',ttl)
local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return {r,raw}`;
const expireScript = `
local raw=redis.call('GET', KEYS[1]); if not raw then return {0,''} end
local item=cjson.decode(raw); if tonumber(item.expiresAt) > tonumber(ARGV[1]) then return {0,''} end
redis.call('DEL',KEYS[1]); local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return {r,raw}`;
const expireExpectedScript = `
local raw=redis.call('GET',KEYS[1]);
if raw then local item=cjson.decode(raw); if item.fence == ARGV[1] then
  if tonumber(item.expiresAt) > tonumber(ARGV[2]) then return {0,''} end
  redis.call('DEL',KEYS[1]);
else raw=ARGV[3] end else raw=ARGV[3] end
local r=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],86400); return {r,raw}`;
const redis = () => getDragonflyClient('desktop-speech-activity');
function emit(channel: string, event: string, payload: unknown) {
    for (const peer of peers.values()) if (peer.identity.channel_id === channel && peer.socket.connected)
        void peer.ready.then(() => { if (peer.socket.connected) peer.socket.emit(event, payload); }).catch(() => {});
}
async function reconcileExpired(channel: string): Promise<void> {
    const [revision, raw] = await (await redis()).eval(expireScript, { keys: [slotKey(channel), revisionKey(channel)], arguments: [String(Date.now())] }) as [number, string];
    if (!revision || !raw) return;
    const ended = JSON.parse(raw) as Stored;
    emit(channel, 'speech:ended', { v: 1, revision: Number(revision), server_time: Date.now(), ...publicActivity(ended), reason: 'expired' });
    signal(channel);
}
async function expireExpected(handle: SpeechActivityHandle): Promise<void> {
    const [revision, raw] = await (await redis()).eval(expireExpectedScript, { keys: [slotKey(handle.channelId), revisionKey(handle.channelId)],
        arguments: [handle.fence, String(Date.now()), JSON.stringify({ ...handle, phase: 'playing' })] }) as [number, string];
    if (!revision || !raw) return;
    emit(handle.channelId, 'speech:ended', { v: 1, revision: Number(revision), server_time: Date.now(), ...publicActivity(JSON.parse(raw) as Stored), reason: 'expired' });
    signal(handle.channelId);
}
async function snapshot(channel: string) {
    await reconcileExpired(channel);
    const cache = await redis();
    const [raw, revision] = await cache.eval("return {redis.call('GET',KEYS[1]) or '', redis.call('GET',KEYS[2]) or '0'}", {
        keys: [slotKey(channel), revisionKey(channel)], arguments: [] }) as [string, string];
    let active: Stored[] = [];
    if (raw) {
        try { const item = JSON.parse(raw) as Stored; if (item.expiresAt > Date.now()) { active = [item]; armExpiry(item); } }
        catch { /* Corrupt values expire with their Redis slot. */ }
    }
    return { v: 1, revision: Number(revision ?? 0), server_time: Date.now(), active: active.map(publicActivity) };
}
function armExpiry(handle: SpeechActivityHandle) {
    const key = keyFor(handle); clearTimeout(timers.get(key));
    // The client also holds until expires_at; this timer sends a prompt terminal.
    const timer = setTimeout(() => { timers.delete(key); void expireExpected(handle).catch(() => {}); }, Math.max(0, handle.expiresAt - Date.now() + 5));
    timer.unref(); timers.set(key, timer);
}
async function waitForSlot(channel: string, signal?: AbortSignal) {
    await new Promise<void>(resolve => {
        const key = wakeKey(channel), waiters = wakeups.get(key) ?? new Set<() => void>();
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); waiters.delete(done); if (!waiters.size) wakeups.delete(key); resolve(); };
        const timer = setTimeout(done, 250); timer.unref(); waiters.add(done); wakeups.set(key, waiters);
        signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
    });
}
async function valid(peer: Peer): Promise<boolean> {
    try {
        const current = await authenticateAccess(peer.token);
        return current.session_id === peer.identity.session_id && current.user_id === peer.identity.user_id &&
            current.channel_id === peer.identity.channel_id && current.client_id === peer.identity.client_id && current.scopes.includes('desktop:connect');
    } catch { return false; }
}

/** Optional capabilities are exact, bounded and never enabled implicitly. */
export function turnStatusFeature(auth: Record<string, unknown>): boolean {
    if (!Object.hasOwn(auth, 'features')) return false;
    if (!Array.isArray(auth.features) || auth.features.length !== 1 || auth.features[0] !== TURN_STATUS_FEATURE) throw new Error('invalid_auth');
    return true;
}
function matchesTurnPeer(peer: Peer, turn: TurnUpdate['turn']): boolean {
    return peer.turnStatus === true && peer.socket.connected && peer.identity.session_id === turn.sessionId &&
        peer.identity.user_id === turn.ownerId && peer.identity.client_id === turn.clientId &&
        peer.identity.channel_id === turn.channelId && peer.identity.scopes.includes(turn.target === 'bot' ? 'ai:interact' : 'pet:interact');
}
function emitTurnUpdate(update: TurnUpdate): void {
    for (const peer of peers.values()) if (matchesTurnPeer(peer, update.turn) &&
        (peer.turnRevisions?.get(update.turn._id) ?? 0) < update.revision) {
        void (async () => {
            await peer.ready;
            // Revalidate at delivery, including the target-specific scope. A
            // refresh/reconnect supplies a new token; an expired socket is fenced.
            const current = await authenticateAccess(peer.token);
            if (!matchesTurnPeer({ ...peer, identity: current }, update.turn) || !current.scopes.includes('desktop:connect')) return;
            if (!peer.socket.connected || (peer.turnRevisions?.get(update.turn._id) ?? 0) >= update.revision) return;
            const revisions = peer.turnRevisions ??= new Map();
            revisions.delete(update.turn._id); revisions.set(update.turn._id, update.revision);
            if (revisions.size > 128) revisions.delete(revisions.keys().next().value!);
            peer.socket.emit('ai:turn-updated', { v: 1, request_id: update.turn.requestId,
                turn_id: update.turn._id, revision: update.revision });
        })().catch(() => { peer.socket.disconnect(true); });
    }
}

/** Only an upgraded same-session desktop can promise stop-before-feedback. */
export async function hasSafeDesktopPetStop(channelId: string, sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false;
    for (const peer of peers.values()) if (peer.socket.connected && peer.snapshotSent && peer.identity.channel_id === channelId &&
        peer.identity.session_id === sessionId && peer.identity.scopes.includes('pet:interact') && await valid(peer)) return true;
    return false;
}

/** Reserve and pause subscribers before any output is exposed to a player. */
export async function prepareSpeechActivity(input: ActivityInput): Promise<SpeechActivityHandle | null> {
    const { signal: cancellation, requiredSessionId, ...request } = input;
    if (!request.channelId || !request.playbackId || !Number.isSafeInteger(request.outputGeneration) ||
        !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) return null;
    // The requested duration starts when the slot becomes available, not while
    // waiting behind an already playing item. Waiting itself is bounded.
    const duration = Math.min(15 * 60_000, Math.max(5_000, request.expiresAt - Date.now()));
    const waitUntil = Date.now() + 15 * 60_000;
    const cache = await redis();
    let handle: SpeechActivityHandle | undefined;
    let revision = 0;
    while (!cancellation?.aborted && Date.now() < waitUntil) {
        await reconcileExpired(request.channelId);
        const candidate: SpeechActivityHandle = { ...request, expiresAt: Date.now() + duration, fence: randomUUID() };
        const stored: Stored = { ...candidate, phase: 'preparing' };
        revision = Number(await cache.eval(reserveScript, { keys: [slotKey(candidate.channelId), revisionKey(candidate.channelId)],
            arguments: [JSON.stringify(stored), String(duration + SLOT_GRACE_MS)] }));
        if (revision > 0) { handle = candidate; break; }
        await waitForSlot(request.channelId, cancellation);
    }
    if (!handle) return null;
    armExpiry(handle);
    const stored: Stored = { ...handle, phase: 'preparing' };
    const payload = { v: 1, revision, server_time: Date.now(), ...publicActivity(stored) };
    // Capture the set only after the slot is durable. A later subscriber gets a
    // snapshot containing the reservation and must stay gated until it ends.
    const subscribers = [...peers.values()].filter(peer => peer.identity.channel_id === handle!.channelId && peer.socket.connected);
    if (requiredSessionId && !subscribers.some(peer => peer.identity.session_id === requiredSessionId)) {
        await finishSpeechActivity(handle, 'output_unavailable'); return null;
    }
    const results = await Promise.all(subscribers.map(async peer => {
        if (!await valid(peer) || !peer.socket.connected) { peer.socket.disconnect(true); return false; }
        try {
            await peer.ready;
            const ack = await peer.socket.timeout(2000).emitWithAck('speech:prepare', payload) as Record<string, unknown>;
            const accepted = ack?.v === 1 && ack.playback_id === handle!.playbackId &&
                ack.output_generation === handle!.outputGeneration && ack.paused === true;
            if (!accepted) peer.socket.disconnect(true);
            return accepted;
        } catch { peer.socket.disconnect(true); return false; }
    }));
    if (cancellation?.aborted || results.some(result => !result)) { await finishSpeechActivity(handle, 'suppression_unavailable'); return null; }
    // The reservation may have expired or been cancelled while waiting for ACKs.
    const raw = await cache.get(slotKey(handle.channelId));
    if (!raw || (JSON.parse(raw) as Stored).fence !== handle.fence) return null;
    return handle;
}

export async function startSpeechActivity(handle: SpeechActivityHandle): Promise<boolean> {
    const cache = await redis();
    const revision = Number(await cache.eval(startScript, { keys: [slotKey(handle.channelId), revisionKey(handle.channelId)], arguments: [handle.fence, String(Date.now())] }));
    if (revision === -1) return true;
    if (!revision) return false;
    emit(handle.channelId, 'speech:started', { v: 1, revision, server_time: Date.now(), ...publicActivity({ ...handle, phase: 'playing' }) });
    return true;
}

/** Extend active playback on genuine advancing progress, never on stale heartbeats. */
export async function extendSpeechActivity(handle: SpeechActivityHandle, expiresAt: number): Promise<boolean> {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    const ttl = Math.min(15 * 60_000, expiresAt - Date.now());
    const next = Date.now() + ttl, cache = await redis();
    const revision = Number(await cache.eval(extendScript, { keys: [slotKey(handle.channelId), revisionKey(handle.channelId)],
        arguments: [handle.fence, String(next), String(ttl + SLOT_GRACE_MS)] }));
    if (revision === -1) return true;
    if (!revision) return false;
    handle.expiresAt = next; armExpiry(handle);
    emit(handle.channelId, 'speech:started', { v: 1, revision, server_time: Date.now(), ...publicActivity({ ...handle, phase: 'playing' }) });
    return true;
}

export async function finishSpeechActivity(handle: SpeechActivityHandle, reason: string): Promise<void> {
    clearTimeout(timers.get(keyFor(handle))); timers.delete(keyFor(handle));
    const cache = await redis();
    const [revision, raw] = await cache.eval(finishScript, { keys: [slotKey(handle.channelId), revisionKey(handle.channelId)], arguments: [handle.fence] }) as [number, string];
    if (!revision || !raw) return;
    const ended = JSON.parse(raw) as Stored;
    emit(handle.channelId, 'speech:ended', { v: 1, revision: Number(revision), server_time: Date.now(), ...publicActivity(ended), reason: boundedReason(reason) });
    signal(handle.channelId);
}

/** Terminal hooks may run after an API restart, so resolve the persisted fence. */
export async function finishMatchingSpeechActivity(channelId: string, playbackId: string, outputGeneration: number, reason: string): Promise<void> {
    const raw = await (await redis()).get(slotKey(channelId));
    if (!raw) return;
    const handle = JSON.parse(raw) as Stored;
    if (handle.channelId === channelId && handle.playbackId === playbackId && handle.outputGeneration === outputGeneration)
        await finishSpeechActivity(handle, reason);
}

/** Retain an unconfirmed stop until its bounded deadline, with a durable proof
 * that only the original elected player may subsequently release this slot. */
export async function retireMatchingSpeechActivity(channelId: string, playbackId: string, outputGeneration: number | undefined,
    expiresAt: number, proof: RetiredProof): Promise<boolean> {
    const cache = await redis(), raw = await cache.get(slotKey(channelId));
    if (!raw) return false;
    const current = JSON.parse(raw) as Stored;
    if (current.channelId !== channelId || current.playbackId !== playbackId ||
        outputGeneration !== undefined && current.outputGeneration !== outputGeneration) return false;
    const [revision, updated] = await cache.eval(retireScript, { keys: [slotKey(channelId), revisionKey(channelId)],
        arguments: [current.fence, JSON.stringify(proof), String(expiresAt), String(Date.now()), String(SLOT_GRACE_MS)] }) as [number, string];
    if (!revision || !updated) return false;
    const retired = JSON.parse(updated) as Stored;
    armExpiry(retired);
    if (retired.phase === 'playing') emit(channelId, 'speech:started', { v: 1, revision: Number(revision), server_time: Date.now(), ...publicActivity(retired) });
    return true;
}

/** A late stop ACK must match the exact retired player and playback fence. */
export async function confirmRetiredSpeechActivity(channelId: string, proof: RetiredProof, playbackId?: string): Promise<boolean> {
    const raw = await (await redis()).get(slotKey(channelId));
    if (!raw) return false;
    const current = JSON.parse(raw) as Stored, saved = current.retiredProof;
    if (!saved || current.channelId !== channelId || playbackId !== undefined && current.playbackId !== playbackId || saved.kind !== proof.kind) return false;
    if (saved.kind === 'tts' && proof.kind === 'tts' ? saved.source !== proof.source :
        saved.kind === 'pet' && proof.kind === 'pet' ? saved.ownerId !== proof.ownerId || saved.peerId !== proof.peerId ||
            saved.leaseId !== proof.leaseId || saved.requestId !== proof.requestId || saved.generation !== proof.generation : true) return false;
    await finishSpeechActivity(current, 'stopped'); return true;
}

/** The namespace is separate so old desktop clients never receive new events. */
export function registerDesktopSpeechActivity(io: Server): () => void {
    const namespace = io.of('/desktop-ai');
    namespace.use((socket, next) => {
        void (async () => {
            const auth = socket.handshake.auth;
            if (socket.recovered || !auth || auth.v !== 1 || typeof auth.accessToken !== 'string' ||
                Object.keys(auth).some(key => key !== 'v' && key !== 'accessToken' && key !== 'features') ||
                ['token', 'accessToken', 'capability', 'authorization'].some(key => key in socket.handshake.query)) throw new Error('invalid_auth');
            const turnStatus = turnStatusFeature(auth);
            const identity = await authenticateAccess(auth.accessToken);
            if (!identity.scopes.includes('desktop:connect')) throw new Error('insufficient_scope');
            if ([...peers.values()].filter(peer => peer.identity.session_id === identity.session_id).length >= 2 || peers.size >= 1024) throw new Error('too_many_connections');
            socket.data.speechPeer = { socket, identity, token: auth.accessToken, turnStatus };
        })().then(() => next(), () => { const error = new Error('unauthorized') as Error & { data: unknown }; error.data = { code: 'unauthorized' }; next(error); });
    });
    namespace.on('connection', socket => {
        const peer = socket.data.speechPeer as Peer;
        if ([...peers.values()].filter(item => item.identity.session_id === peer.identity.session_id).length >= 2) return void socket.disconnect(true);
        let ready!: () => void;
        peer.ready = new Promise<void>(resolve => { ready = resolve; });
        peers.set(socket.id, peer);
        // Peers gate capture until this authoritative initial snapshot arrives.
        void snapshot(peer.identity.channel_id).then(value => { if (socket.connected) { socket.emit('speech:snapshot', value); peer.snapshotSent = true; } ready(); }).catch(() => { socket.disconnect(true); ready(); });
        socket.once('disconnect', () => { peers.delete(socket.id); });
    });
    const stopTurnUpdates = subscribeTurnUpdates(emitTurnUpdate, () => [...peers.values()].some(peer => peer.turnStatus && peer.socket.connected));
    // Reuse Pet's existing committed owner wakeups. Queries are shared by owner,
    // event-driven, coalesced and bounded; a missed hint uses ordinary HTTP polls.
    // The recent64 cap may omit older history after a large burst. It cannot
    // authorize work/playback; HTTP polling remains required for every pending turn.
    const petRefreshes = new Set<string>();
    const stopPetWakeups = subscribePetWakeups(owners => {
        for (const owner of owners) {
            const eligible = [...peers.values()].filter(peer => peer.turnStatus && peer.socket.connected &&
                peer.identity.user_id === owner && peer.identity.scopes.includes('pet:interact'));
            if (!eligible.length || petRefreshes.has(owner)) continue;
            petRefreshes.add(owner);
            void refreshPetTurnUpdates(owner, eligible.map(peer => peer.identity.session_id))
                .catch(() => {}).finally(() => { petRefreshes.delete(owner); });
        }
    });
    let checking = false;
    const timer = setInterval(() => {
        if (checking) return; checking = true;
        void Promise.all([...peers.values()].map(async peer => { if (!await valid(peer)) peer.socket.disconnect(true); })).finally(() => { checking = false; });
    }, 15_000); timer.unref();
    return () => { stopTurnUpdates(); stopPetWakeups(); clearInterval(timer); for (const peer of peers.values()) peer.socket.disconnect(true); peers.clear(); for (const item of timers.values()) clearTimeout(item); timers.clear(); };
}
