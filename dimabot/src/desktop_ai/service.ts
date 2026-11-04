import { updateTurn, changeTurn, notifyTurnUpdated, turnWireRevision } from './updates.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopAiConversation, DesktopAiTurn, type DesktopTurn } from './schema.js';
import { isTurnId, parseTurnInput, turnFingerprint } from './input.js';
import { OAuthError } from '../server/oauth/catalog.js';
import type { AccessIdentity } from '../server/oauth/service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { PetRequest } from '../schemas/pet_runtime.schema.js';
import { cancelPetRequest } from '../pets/state.js';
import { executeDesktopTurn, cancelPendingSpeech, finishBotSpeech, startBotSpeech } from './execution.js';

const RETENTION = 7 * 86_400_000;
const THREAD_TTL = 24 * 60 * 60_000;
const RUN_TIMEOUT = 5 * 60_000;
const ongoing = new Map<string, AbortController>();
const starting = new Set<string>();
const activeOwners = new Set<string>();
const MAX_CONCURRENT = 16;
const MAX_OUTSTANDING_PER_OWNER = 20;
const QUEUE_SLOT_TTL_MS = 2 * 60 * 60_000;
const ownerQueue = (ownerId: string) => `desktop-ai:queue:${ownerId}`;
const queueMember = (turn: Pick<DesktopTurn, 'clientId' | 'requestId'>) => `${turn.clientId}:${turn.requestId}`;
const ownerLease = (ownerId: string) => `desktop-ai:owner:${ownerId}`;
const reserveQueueScript = `
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]);
if redis.call('ZSCORE',KEYS[1],ARGV[2]) then return 2 end;
if redis.call('ZCARD',KEYS[1]) >= tonumber(ARGV[4]) then return 0 end;
redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]); redis.call('PEXPIRE',KEYS[1],ARGV[5]); return 1`;
const releaseLeaseScript = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
const renewLeaseScript = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0`;
async function releaseQueue(turn: Pick<DesktopTurn, 'ownerId' | 'clientId' | 'requestId'>) {
    await (await tickets()).zRem(ownerQueue(turn.ownerId), queueMember(turn));
}
function safeSpeechDirectory(dir: string | undefined): dir is string {
    if (!dir) return false;
    const base = path.resolve(tmpdir());
    return path.dirname(dir) === base && /^dima-desktop-ai-[A-Za-z0-9]+$/.test(path.basename(dir));
}
async function cleanSpeechDirectory(dir: string | undefined) {
    if (safeSpeechDirectory(dir)) await rm(dir, { recursive: true, force: true });
}
const speechExpiryTimers = new Map<string, NodeJS.Timeout>();
export function clearBotSpeechExpiry(id: string): void {
    clearTimeout(speechExpiryTimers.get(id)); speechExpiryTimers.delete(id);
}
/** The one-shot announces expiry at the delivery deadline; durable recovery
 * supplies the same transition after a restart. It can never expire playing. */
export function armBotSpeechExpiry(id: string, deadline: Date): void {
    clearBotSpeechExpiry(id);
    const timer = setTimeout(() => {
        speechExpiryTimers.delete(id);
        void (async () => {
            const expired = await changeTurn({ _id: id, 'speech.status': { $in: ['ready', 'delivering'] },
                'speech.startBefore': { $lte: new Date() } }, { $set: { 'speech.status': 'expired' }, $inc: { revision: 1 } });
            if (!expired) return;
            await (await tickets()).del(ticketKey(id));
            await finishBotSpeech(id, 'expired');
            await cleanSpeechDirectory(expired.speech?.privateDir);
        })().catch(() => {});
    }, Math.max(0, deadline.getTime() - Date.now() + 1));
    timer.unref(); speechExpiryTimers.set(id, timer);
}
export const tickets = () => getDragonflyClient('desktop-ai-tickets');
export const ticketKey = (turnId: string) => `desktop-ai:ticket:${turnId}`;
export const hashTicket = (value: string) => createHash('sha256').update(value).digest('base64url');
export const newTicket = () => randomBytes(32).toString('base64url');
function owner(identity: AccessIdentity) { return { ownerId: identity.user_id, clientId: identity.client_id, channelId: identity.channel_id }; }
function requireScope(identity: AccessIdentity, target: 'bot' | 'pet') {
    if (!identity.scopes.includes(target === 'bot' ? 'ai:interact' : 'pet:interact')) throw new OAuthError('insufficient_scope', 403);
}
async function found(identity: AccessIdentity, filter: { _id?: string; requestId?: string }) {
    const turn = await DesktopAiTurn.findOne({ ...owner(identity), ...filter }).lean();
    if (!turn) throw new OAuthError('not_found', 404);
    requireScope(identity, turn.target);
    return turn;
}
export async function submitTurn(identity: AccessIdentity, payload: unknown) {
    const input = parseTurnInput(payload);
    requireScope(identity, input.target);
    await Promise.all([DesktopAiTurn.init(), DesktopAiConversation.init()]);
    const fingerprint = turnFingerprint(input);
    const duplicate = async () => {
        const existing = await DesktopAiTurn.findOne({ ownerId: identity.user_id, clientId: identity.client_id, requestId: input.request_id }).lean();
        if (!existing) return null;
        if (existing.fingerprint !== fingerprint) throw new OAuthError('idempotency_conflict', 409);
        if (existing.channelId !== identity.channel_id) throw new OAuthError('not_found', 404);
        return existing;
    };
    const prior = await duplicate();
    if (prior) return snapshot(prior, identity);
    const now = new Date();
    let conversationId = input.conversation_id;
    if (conversationId) {
        const conversation = await DesktopAiConversation.findOne({ _id: conversationId, ownerId: identity.user_id,
            channelId: identity.channel_id, target: input.target, expiresAt: { $gt: now } }).lean();
        if (!conversation) throw new OAuthError('invalid_conversation', 400);
    } else {
        conversationId = randomUUID();
        await DesktopAiConversation.create({ _id: conversationId, ownerId: identity.user_id, channelId: identity.channel_id,
            target: input.target, createdAt: now, expiresAt: new Date(now.getTime() + THREAD_TTL) });
    }
    const member = `${identity.client_id}:${input.request_id}`;
    const reserved = Number(await (await tickets()).eval(reserveQueueScript, { keys: [ownerQueue(identity.user_id)],
        arguments: [String(Date.now()), member, String(Date.now() + QUEUE_SLOT_TTL_MS), String(MAX_OUTSTANDING_PER_OWNER), String(QUEUE_SLOT_TTL_MS)] }));
    if (!reserved) throw new OAuthError('queue_full', 429);
    const turn: DesktopTurn = { _id: randomUUID(), requestId: input.request_id, ...owner(identity), sessionId: identity.session_id,
        origin: 'oauth_desktop', target: input.target, source: input.source, silent: input.silent, text: input.text, fingerprint, conversationId,
        status: 'queued', revision: 1, createdAt: now, expiresAt: new Date(now.getTime() + RETENTION), operations: [],
        ...(input.silent ? {} : { speech: { playbackId: randomUUID(), outputGeneration: 1, status: 'queued', destination: 'desktop', animatePet: input.target === 'pet' } }) };
    try { await DesktopAiTurn.create(turn); notifyTurnUpdated(turn._id); }
    catch (error) {
        if ((error as { code?: number }).code !== 11000) { if (reserved === 1) await releaseQueue(turn).catch(() => {}); throw error; }
        const existing = await duplicate();
        if (!existing) { if (reserved === 1) await releaseQueue(turn).catch(() => {}); throw error; }
        return snapshot(existing, identity);
    }
    setImmediate(() => { void runTurn(turn._id).catch(() => {}); });
    return snapshot(turn, identity);
}
export async function getTurn(identity: AccessIdentity, id: string, byRequest = false) {
    if (!isTurnId(id)) throw new OAuthError('invalid_request');
    return snapshot(await found(identity, byRequest ? { requestId: id } : { _id: id }), identity);
}
export async function snapshot(turn: DesktopTurn, identity: AccessIdentity) {
    let petVersion = 0;
    let petStatus: string | undefined;
    let petError: string | undefined;
    if (turn.petRequestId) {
        const pet = await PetRequest.findOne({ _id: turn.petRequestId, ownerId: turn.ownerId }).select('status version errorCode').lean();
        if (pet) { petVersion = Math.min(pet.version || 0, 99999); petStatus = pet.status; petError = pet.errorCode; }
    }
    let speech: Record<string, unknown> | undefined;
    if (turn.speech) {
        const s = turn.speech;
        const status = petStatus ? ({ accepted: 'queued', generating: 'preparing', synthesizing: 'preparing',
            ready: 'ready', playing: 'playing', completed: 'completed', failed: 'failed', cancelled: 'cancelled', expired: 'expired', queued: 'queued' } as Record<string, string>)[petStatus] : s.status;
        speech = { playback_id: s.playbackId, output_generation: s.outputGeneration, status, destination: 'desktop',
            animate_pet: s.animatePet, transport: s.animatePet ? 'pet_socket' : 'http',
            ...((petError || s.errorCode) ? { error: { code: (petError || s.errorCode)!.slice(0, 80) } } : {}) };
        if (!s.animatePet && s.status === 'ready' && identity.session_id === turn.sessionId && s.ticketExpiresAt && s.ticketExpiresAt.getTime() > Date.now()) {
            const ticket = await (await tickets()).get(ticketKey(turn._id));
            if (ticket && hashTicket(ticket) === s.ticketHash) Object.assign(speech, { audio_url: `/v1/me/ai/turns/${turn._id}/speech/audio`, ticket,
                ticket_expires_at: s.ticketExpiresAt.getTime(), start_before: s.startBefore?.getTime(), mime_type: s.mimeType, duration_ms: s.durationMs });
        }
    }
    const actions = turn.operations.filter(item => item.kind.startsWith('tool:')).slice(0, 16).map(item => ({
        operation_id: item.id, tool: item.kind.slice(5, 45), status: item.status === 'pending' && turn.status === 'indeterminate' ? 'indeterminate' : item.status }));
    return { request_id: turn.requestId, turn_id: turn._id, target: turn.target, conversation_id: turn.conversationId,
        status: turn.status, revision: turnWireRevision(turn.revision, petVersion), poll_after_ms: 1000,
        ...(turn.replyText ? { reply_text: turn.replyText } : {}), ...(turn.errorCode ? { error: { code: turn.errorCode.slice(0, 80) } } : {}),
        ...(turn.petRequestId ? { pet_request_id: turn.petRequestId } : {}), ...(actions.length ? { actions } : {}), ...(speech ? { speech } : {}) };
}
/** Each external operation gets an immutable pending receipt before execution. */
export async function operation<T>(turnId: string, id: string, kind: string, task: () => Promise<T>): Promise<T> {
    const billing = kind === 'billing';
    if (!billing) await assertRunning(turnId);
    const inserted = await updateTurn({ _id: turnId, ...(!billing ? { status: 'running' } : {}), 'operations.id': { $ne: id } },
        { $push: { operations: { id, kind, status: 'pending' } }, $inc: { revision: 1 } });
    if (!inserted.modifiedCount) throw new OAuthError('operation_unavailable', 409);
    if (!billing) await assertRunning(turnId);
    // Billing is tied to an already-successful paid provider result and must
    // remain recordable if cancellation or lease loss occurs after that result.
    // If a task throws, the pending receipt intentionally remains uncertain.
    const result = await task();
    const resultRecord = result && typeof result === 'object' ? result as { success?: unknown; error?: unknown; outcomeUnknown?: unknown } : null;
    // Some adapters catch a transport exception and report it as a value; preserve
    // uncertainty rather than converting that into an ordinary failure/retry.
    if (resultRecord?.outcomeUnknown === true || (kind === 'speech' && resultRecord?.error === true) ||
        (kind === 'provider' && resultRecord?.error === true && Number((result as { status?: number }).status ?? 0) >= 500)) throw new OAuthError('operation_outcome_unknown', 503);
    await updateTurn({ _id: turnId, 'operations.id': id },
        { $set: { 'operations.$.status': resultRecord?.success === false ? 'failed' : 'completed' }, $inc: { revision: 1 } });
    return result;
}
export async function assertRunning(turnId: string) {
    const turn = await DesktopAiTurn.findOne({ _id: turnId, status: 'running' }).lean();
    if (!turn) throw new OAuthError('turn_cancelled', 409);
    if (!turn.executionFence || await (await tickets()).get(ownerLease(turn.ownerId)) !== turn.executionFence) throw new OAuthError('owner_lease_lost', 409);
}
async function runTurn(id: string) {
    if (starting.has(id) || starting.size + ongoing.size >= MAX_CONCURRENT) return;
    starting.add(id);
    let leaseKey: string | undefined, leaseToken: string | undefined, finished = false;
    try {
        const candidate = await DesktopAiTurn.findOne({ _id: id, status: 'queued' }).lean();
        if (!candidate || activeOwners.has(candidate.ownerId)) return;
        leaseKey = ownerLease(candidate.ownerId); leaseToken = randomUUID();
        const locked = await (await tickets()).set(leaseKey, leaseToken, { NX: true, PX: RUN_TIMEOUT + 30_000 });
        if (!locked) { leaseKey = undefined; return; }
        activeOwners.add(candidate.ownerId);
        const claimed = await changeTurn({ _id: id, status: 'queued' },
            { $set: { status: 'running', executionFence: leaseToken, runDeadline: new Date(Date.now() + RUN_TIMEOUT) }, $inc: { revision: 1 } }, { new: true });
        if (!claimed) return;
        const controller = new AbortController(); ongoing.set(id, controller); starting.delete(id);
        const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT); timeout.unref();
        let renewing = false;
        const heartbeat = setInterval(() => {
            if (renewing) return; renewing = true;
            void (async () => {
                const renewed = Number(await (await tickets()).eval(renewLeaseScript, { keys: [leaseKey!], arguments: [leaseToken!, String(RUN_TIMEOUT + 30_000)] }));
                if (!renewed) throw new Error('owner_lease_lost');
            })().catch(async () => {
                controller.abort();
                await updateTurn({ _id: id, status: 'running', executionFence: leaseToken },
                    { $set: { status: 'indeterminate', errorCode: 'owner_lease_lost' }, $inc: { revision: 1 } }).catch(() => {});
                await updateTurn({ _id: id, 'speech.status': { $in: ['queued', 'preparing'] } },
                    { $set: { 'speech.status': 'indeterminate', 'speech.errorCode': 'owner_lease_lost' }, $inc: { revision: 1 } }).catch(() => {});
            }).finally(() => { renewing = false; });
        }, 15_000); heartbeat.unref();
        try {
            await executeDesktopTurn(claimed, controller.signal);
        } catch (error) {
            const current = await DesktopAiTurn.findById(id).lean();
            if (current?.status === 'running') {
                const unknown = current.operations.some(item => item.status === 'pending');
                const code = error && typeof error === 'object' && 'code' in error && /^[a-z_]{1,80}$/.test(String(error.code)) ? String(error.code) : 'generation_failed';
                await updateTurn({ _id: id, status: 'running' }, { $set: { status: unknown ? 'indeterminate' : 'failed', errorCode: unknown ? 'operation_outcome_unknown' : code }, $inc: { revision: 1 } });
                await updateTurn({ _id: id, 'speech.status': { $in: ['queued', 'preparing'] } }, { $set: { 'speech.status': unknown ? 'indeterminate' : 'failed', 'speech.errorCode': unknown ? 'operation_outcome_unknown' : code }, $inc: { revision: 1 } });
            }
        } finally { finished = true; clearTimeout(timeout); clearInterval(heartbeat); ongoing.delete(id); await releaseQueue(claimed).catch(() => {}); }
    } finally {
        starting.delete(id);
        if (leaseKey && leaseToken) {
            await (await tickets()).eval(releaseLeaseScript, { keys: [leaseKey], arguments: [leaseToken] }).catch(() => {});
            activeOwners.delete(leaseKey.slice('desktop-ai:owner:'.length));
        }
        if (finished) setImmediate(() => { void drainQueue().catch(() => {}); });
    }
}
let draining = false;
async function drainQueue() {
    if (draining || starting.size + ongoing.size >= MAX_CONCURRENT) return;
    draining = true;
    try {
        const rows = await DesktopAiTurn.find({ status: 'queued' }).sort({ createdAt: 1 }).limit(400).select('_id ownerId').lean();
        const owners = new Set<string>();
        for (const turn of rows) {
            if (owners.has(turn.ownerId) || activeOwners.has(turn.ownerId)) continue;
            owners.add(turn.ownerId);
            if (starting.size + ongoing.size >= MAX_CONCURRENT) break;
            void runTurn(turn._id).catch(() => {});
        }
    } finally { draining = false; }
}
export async function cancelTurn(identity: AccessIdentity, id: string) {
    const turn = await found(identity, { _id: id });
    let accepted = turn.status === 'cancelled';
    if (turn.status === 'queued' || turn.status === 'running') {
        const updated = await changeTurn({ _id: id, status: { $in: ['queued', 'running'] }, 'operations.status': { $ne: 'pending' } },
            { $set: { status: 'cancelled', errorCode: 'cancelled' }, $inc: { revision: 1 } }, { new: true });
        accepted = !!updated;
        if (accepted) { ongoing.get(id)?.abort(); await releaseQueue(turn).catch(() => {}); }
    }
    // Always stop this turn's own speech when cancellation was requested, even
    // if an in-flight action makes the whole-turn cancellation too late.
    if (turn.speech) await cancelSpeech(identity, id, { playback_id: turn.speech.playbackId, output_generation: turn.speech.outputGeneration }, true);
    return { accepted, too_late: !accepted, snapshot: await getTurn(identity, id) };
}
export async function claimSpeechPreparing(id: string): Promise<boolean> {
    const result = await updateTurn({ _id: id, 'speech.status': 'queued' },
        { $set: { 'speech.status': 'preparing' }, $inc: { revision: 1 } });
    return result.modifiedCount === 1;
}
export async function speechStillPreparing(id: string): Promise<boolean> {
    return !!await DesktopAiTurn.exists({ _id: id, 'speech.status': 'preparing' });
}
export async function cancelSpeech(identity: AccessIdentity, id: string, input: unknown, allowOwner = false) {
    const turn = await found(identity, { _id: id });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['playback_id', 'output_generation'].includes(k))) throw new OAuthError('invalid_request');
    const { playback_id, output_generation } = input as Record<string, unknown>;
    if ((!allowOwner && identity.session_id !== turn.sessionId) || !turn.speech || playback_id !== turn.speech.playbackId || output_generation !== turn.speech.outputGeneration) throw new OAuthError('not_found', 404);
    if (turn.petRequestId) {
        const pet = await PetRequest.findOne({ _id: turn.petRequestId, ownerId: turn.ownerId }).select('status').lean();
        if (pet && ['completed', 'failed', 'expired'].includes(pet.status)) return { accepted: false, too_late: true, snapshot: await getTurn(identity, id) };
    }
    const updated = await changeTurn({ _id: id, 'speech.playbackId': playback_id, 'speech.outputGeneration': output_generation,
        'speech.status': { $in: ['queued', 'preparing', 'ready', 'delivering', 'playing', 'cancelled'] } },
        { $set: { 'speech.status': 'cancelled' }, $inc: { revision: 1 } }, { new: true });
    if (!updated) return { accepted: false, too_late: true, snapshot: await getTurn(identity, id) };
    // Abort locally before any further I/O; the persisted fence is authoritative.
    cancelPendingSpeech(id);
    if (updated.petRequestId) {
        const pet = await cancelPetRequest(updated.ownerId, updated.petRequestId, `turn:${id}`);
        if (pet.status !== 'cancelled') {
            // The pet finished while cancellation was crossing the queue. Preserve
            // the true terminal outcome and do not claim cancellation succeeded.
            await updateTurn({ _id: id, petRequestId: updated.petRequestId, 'speech.playbackId': playback_id,
                'speech.outputGeneration': output_generation, 'speech.status': 'cancelled' },
                { $set: { 'speech.status': ['completed', 'failed', 'expired'].includes(pet.status) ? pet.status : 'failed' }, $inc: { revision: 1 } });
            return { accepted: false, too_late: true, snapshot: await getTurn(identity, id) };
        }
    }
    await (await tickets()).del(ticketKey(id));
    const deadline = updated.speech?.playbackDeadline;
    // Once the player was authorized to start, cancellation is a request to
    // stop, not evidence that the audio has actually stopped. Keep all mics
    // and the shared output slot fenced until the initiating player reports a
    // terminal event, or the bounded playback deadline elapses.
    if (!deadline || deadline.getTime() <= Date.now()) {
        if (deadline) await updateTurn({ _id: id, 'speech.status': 'cancelled',
            'speech.playbackDeadline': { $lte: new Date() }, 'speech.stopConfirmed': { $ne: true } },
            { $set: { 'speech.stopConfirmed': true }, $inc: { revision: 1 } });
        await finishBotSpeech(id, 'cancelled');
        await cleanSpeechDirectory(updated.speech?.privateDir);
    }
    return { accepted: true, too_late: false, snapshot: await getTurn(identity, id) };
}

/** Release a cancelled Bot output only once its bounded playback time is over. */
export async function expireCancelledBotSpeech(id: string, now: Date): Promise<boolean> {
    const expired = await changeTurn({ _id: id, 'speech.animatePet': false, 'speech.status': 'cancelled',
        'speech.stopConfirmed': { $ne: true }, 'speech.playbackDeadline': { $lte: now } },
        { $set: { 'speech.stopConfirmed': true }, $inc: { revision: 1 } }, { new: true });
    if (!expired) return false;
    await finishBotSpeech(id, 'expired');
    await cleanSpeechDirectory(expired.speech?.privateDir);
    return true;
}

export async function startDesktopAiRuntime() {
    await Promise.all([DesktopAiTurn.init(), DesktopAiConversation.init()]);
    // Reconstruct outstanding reservations after Redis expiry/restart before
    // accepting requests. Mongo remains the source of truth for queued work.
    const cache = await tickets();
    for await (const turn of DesktopAiTurn.find({ status: { $in: ['queued', 'running'] } }).select('ownerId clientId requestId').cursor()) {
        await cache.zAdd(ownerQueue(turn.ownerId), { score: Date.now() + QUEUE_SLOT_TTL_MS, value: queueMember(turn) });
        await cache.pExpire(ownerQueue(turn.ownerId), QUEUE_SLOT_TTL_MS);
    }
    let busy = false;
    const recover = async () => {
        if (busy) return; busy = true;
        try {
            const now = new Date();
            const overdue = await DesktopAiTurn.find({ status: 'running', runDeadline: { $lte: now } }).limit(64).lean();
            for (const turn of overdue) {
                const changed = await updateTurn({ _id: turn._id, status: 'running', runDeadline: { $lte: now } },
                    { $set: { status: 'indeterminate', errorCode: 'operation_outcome_unknown' }, $inc: { revision: 1 } });
                if (changed.modifiedCount) await releaseQueue(turn).catch(() => {});
            }
            const uncertain = await DesktopAiTurn.find({ status: 'indeterminate', errorCode: 'operation_outcome_unknown',
                'speech.status': { $in: ['queued', 'preparing'] } }).limit(64).select('_id').lean();
            for (const turn of uncertain) await updateTurn({ _id: turn._id, 'speech.status': { $in: ['queued', 'preparing'] } },
                { $set: { 'speech.status': 'indeterminate', 'speech.errorCode': 'operation_outcome_unknown' }, $inc: { revision: 1 } });
            await drainQueue();
            const expired = await DesktopAiTurn.find({ 'speech.animatePet': false, $or: [
                { 'speech.status': { $in: ['ready', 'delivering'] }, 'speech.startBefore': { $lte: now } },
                { 'speech.status': 'playing', 'speech.playbackDeadline': { $lte: now } },
                { 'speech.status': 'cancelled', 'speech.stopConfirmed': { $ne: true }, 'speech.playbackDeadline': { $lte: now } } ] }).limit(32).lean();
            for (const turn of expired) {
                if (turn.speech?.status === 'cancelled') { await expireCancelledBotSpeech(turn._id, now); continue; }
                const changed = await updateTurn({ _id: turn._id, ...(turn.speech?.status === 'playing' ? {
                    'speech.status': 'playing', 'speech.playbackDeadline': { $lte: now }
                } : { 'speech.status': { $in: ['ready', 'delivering'] }, 'speech.startBefore': { $lte: now } }) },
                    { $set: { 'speech.status': 'expired' }, $inc: { revision: 1 } });
                if (changed.modifiedCount) {
                    await finishBotSpeech(turn._id, 'expired');
                    await cleanSpeechDirectory(turn.speech?.privateDir);
                }
            }
        } finally { busy = false; }
    };
    await recover();
    const timer = setInterval(() => { void recover().catch(() => {}); }, 5000); timer.unref();
    return () => { clearInterval(timer); for (const id of speechExpiryTimers.keys()) clearBotSpeechExpiry(id); for (const controller of ongoing.values()) controller.abort(); };
}

export async function claimAudio(identity: AccessIdentity, id: string, ticket: unknown) {
    const turn = await found(identity, { _id: id });
    if (identity.session_id !== turn.sessionId || !turn.speech || turn.speech.animatePet ||
        typeof ticket !== 'string' || !/^[\w-]{43}$/.test(ticket) || hashTicket(ticket) !== turn.speech.ticketHash ||
        !turn.speech.startBefore || turn.speech.startBefore.getTime() <= Date.now()) throw new OAuthError('invalid_ticket', 403);
    const claimed = await changeTurn({ _id: id, 'speech.status': 'ready', 'speech.ticketHash': hashTicket(ticket),
        'speech.startBefore': { $gt: new Date() } }, { $set: { 'speech.status': 'delivering' }, $inc: { revision: 1 } }, { new: true });
    if (!claimed?.speech?.path || !claimed.speech.mimeType || !safeSpeechDirectory(claimed.speech.privateDir) ||
        path.dirname(claimed.speech.path) !== claimed.speech.privateDir || !/^speech\.(wav|mp3)$/.test(path.basename(claimed.speech.path))) throw new OAuthError('audio_unavailable', 409);
    await (await tickets()).del(ticketKey(id));
    return { path: claimed.speech.path, mimeType: claimed.speech.mimeType };
}
export async function speechEvent(identity: AccessIdentity, id: string, value: unknown) {
    const turn = await found(identity, { _id: id });
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['playback_id', 'output_generation', 'event'].includes(k))) throw new OAuthError('invalid_request');
    const { playback_id, output_generation, event } = value as Record<string, unknown>;
    if (identity.session_id !== turn.sessionId || !turn.speech || turn.speech.animatePet || playback_id !== turn.speech.playbackId || output_generation !== turn.speech.outputGeneration) throw new OAuthError('not_found', 404);
    if (event !== 'started' && event !== 'ended' && event !== 'failed') throw new OAuthError('invalid_request');
    if (event === 'started') {
        if (turn.speech.status !== 'delivering' || !turn.speech.startBefore || turn.speech.startBefore.getTime() <= Date.now()) throw new OAuthError('audio_unavailable', 409);
        // Fence concurrent started requests before touching the shared output
        // slot. A losing duplicate must never release the winning playback.
        const startClaim = await changeTurn({ _id: id, 'speech.status': 'delivering', 'speech.playbackId': playback_id,
            'speech.outputGeneration': output_generation, 'speech.startBefore': { $gt: new Date() }, 'speech.startClaimed': { $ne: true } },
            { $set: { 'speech.startClaimed': true }, $inc: { revision: 1 } }, { new: true });
        if (!startClaim) throw new OAuthError('audio_unavailable', 409);
        if (!await startBotSpeech(id)) {
            await updateTurn({ _id: id, 'speech.status': 'delivering', 'speech.startClaimed': true },
                { $set: { 'speech.status': 'failed', 'speech.errorCode': 'output_unavailable' }, $inc: { revision: 1 } });
            await finishBotSpeech(id, 'output_unavailable'); throw new OAuthError('output_unavailable', 409);
        }
        const started = await changeTurn({ _id: id, 'speech.status': 'delivering', 'speech.playbackId': playback_id,
            'speech.outputGeneration': output_generation, 'speech.startBefore': { $gt: new Date() }, 'speech.startClaimed': true }, { $set: { 'speech.status': 'playing',
                'speech.playbackDeadline': new Date(Date.now() + (turn.speech.durationMs || 60_000) + 5000) }, $inc: { revision: 1 } }, { new: true });
        if (!started) { await finishBotSpeech(id, 'stale'); throw new OAuthError('audio_unavailable', 409); }
        clearBotSpeechExpiry(id);
    } else {
        const ended = await changeTurn({ _id: id, 'speech.status': { $in: ['delivering', 'playing'] },
            'speech.playbackId': playback_id, 'speech.outputGeneration': output_generation }, { $set: { 'speech.status': event === 'ended' ? 'completed' : 'failed' }, $inc: { revision: 1 } }, { new: true });
        if (!ended) {
            // A cancellation can win after this event's initial read. Accept a
            // fenced late player stop as proof without changing cancelled into
            // completed/failed, and make duplicate proof idempotent.
            const stopped = await changeTurn({ _id: id, 'speech.status': 'cancelled',
                'speech.playbackId': playback_id, 'speech.outputGeneration': output_generation,
                'speech.playbackDeadline': { $gt: new Date(0) }, 'speech.stopConfirmed': { $ne: true } },
                { $set: { 'speech.stopConfirmed': true }, $inc: { revision: 1 } }, { new: true });
            if (stopped) {
                await finishBotSpeech(id, event);
                await cleanSpeechDirectory(stopped.speech?.privateDir);
            } else {
                const current = await DesktopAiTurn.findById(id).lean();
                if (!current?.speech || current.speech.status !== 'cancelled' || !current.speech.playbackDeadline ||
                    !current.speech.stopConfirmed || current.speech.playbackId !== playback_id ||
                    current.speech.outputGeneration !== output_generation) throw new OAuthError('audio_unavailable', 409);
            }
        } else {
            await finishBotSpeech(id, event);
            await cleanSpeechDirectory(ended.speech?.privateDir);
        }
    }
    return { snapshot: await getTurn(identity, id) };
}
