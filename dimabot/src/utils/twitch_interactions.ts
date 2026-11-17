/**
 * One shared view of the channel's latest Twitch poll and prediction, for the `poll.*` and
 * `prediction.*` AST functions.
 *
 * - Twitch's poll and prediction notifications (begin, progress, lock, end) replace the snapshot as
 *   they arrive, so it is current without asking Twitch.
 * - No usable snapshot: ask Twitch once and keep the answer.
 * - A snapshot lives up to an hour, or until the next poll or prediction starts.
 *
 * A snapshot is only trusted that long while the channel receives ALL of those notifications
 * ("fed"; the missing ones are turned on the first time a command reads a poll). Otherwise, and once a
 * running poll is past its end time without an end notification, it is good for 5 s, so the answer
 * is at most 5 s behind Twitch.
 *
 * Writes are atomic (one Lua script each) so an older view never replaces a newer one:
 * - a notification is stored unless the snapshot is already further along (a finished poll is not
 *   reopened by late progress, totals never go down, an older poll does not replace a newer one);
 * - a Twitch read is stored only if nothing was written or invalidated since the read started.
 *   Invalidating (a poll was started or ended from here) leaves a marker instead of deleting, so a
 *   read that is still in flight notices it.
 *
 * The cache is an optimisation only: when Dragonfly cannot be reached, Twitch is read directly.
 */
import { randomUUID } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { getPoll } from '../functions/polls/get.poll.js';
import { getPrediction } from '../functions/predictions/get.prediction.js';
import { INTERACTION_SUBSCRIPTIONS, parseInteraction } from '../overlays/interaction-model.js';

export type InteractionKind = 'poll' | 'prediction';
/**
 * `ended`: finished with a result (a poll that ran out, was ended early or archived; a resolved prediction).
 * `canceled`: no result (a poll stopped with `cancel.poll` or deleted on Twitch; a refunded prediction).
 * `none`: Twitch has no poll or prediction for this channel. `unavailable`: Twitch could not be read.
 */
export type InteractionStatus = 'active' | 'locked' | 'ended' | 'canceled' | 'none' | 'unavailable';
/** `value`: votes of a poll choice, Channel Points of a prediction outcome. `users`: predictors (0 for polls). */
export interface InteractionOption { id: string; title: string; value: number; users: number }
export interface InteractionSnapshot {
    kind: InteractionKind;
    id: string;
    title: string;
    status: InteractionStatus;
    options: InteractionOption[];
    /** The resolved prediction's winning outcome; always null for polls (see `leaders`). */
    winnerId: string | null;
    /** When it started (ms); 0 when unknown. Orders two different polls. */
    startedAt: number;
    /** When an active poll closes or an active prediction locks (ms); null when unknown or not active. */
    endsAt: number | null;
    /** When this view was taken: the notification's arrival, or the start of the Twitch read (ms). */
    at: number;
}

/** A snapshot Twitch's notifications keep current. */
export const SNAPSHOT_TTL_SECONDS = 3600;
/** A snapshot nothing keeps current, and failed reads. */
export const UNFED_TTL_SECONDS = 5;
/** How long after its end time a running poll may wait for its end notification before Twitch is asked. */
export const OVERDUE_GRACE_MS = 10_000;
/** Remembers which poll `cancel.poll` stopped: Twitch reports it as TERMINATED, like a poll ended early by hand. */
const CANCELED_TTL_SECONDS = 7 * 86_400;
/** How long an invalidation marker stays, to be seen by Twitch reads that were already in flight. */
const INVALIDATED_TTL_SECONDS = 300;
/** A Twitch read older than this is not waited for by later callers: they start their own. */
const READ_JOIN_MS = 10_000;
/** How long "this channel gets every notification" is believed before the subscriptions are looked up again. */
const FEED_TTL_SECONDS = 600;
/** At most one attempt per channel in this time to turn the notifications on. */
const ENSURE_TTL_SECONDS = 3600;

const snapshotKey = (channel: string, kind: InteractionKind) => `twitch:${channel}:${kind}:snapshot`;
const canceledKey = (channel: string, pollId: string) => `twitch:${channel}:poll:canceled:${pollId}`;
const feedKey = (channel: string, kind: InteractionKind) => `twitch:${channel}:${kind}:feed`;
const ensureKey = (channel: string, kind: InteractionKind) => `twitch:${channel}:${kind}:feed:ensure`;

/** What is stored: `generation` is a new token per write; `snapshot` is null after an invalidation. */
export interface StoredSnapshot { snapshot: InteractionSnapshot | null; generation: string }
export interface InteractionCache {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options: { EX: number; NX?: boolean }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    /** The stored snapshot JSON (null after an invalidation) and its generation, or null when nothing is stored. */
    read(key: string): Promise<{ json: string | null; generation: string } | null>;
    /** Drops the snapshot but keeps a marker with a new generation, so in-flight Twitch reads are refused. */
    invalidate(key: string, ttlSeconds: number): Promise<unknown>;
    /**
     * Atomic conditional write; true when stored.
     * `event`: refused when the stored snapshot is further along (see `supersedes`).
     * `seen`: refused when the stored generation is no longer this one ('' = nothing was stored, not even a marker).
     */
    store(key: string, snapshot: InteractionSnapshot, ttlSeconds: number, rule: { event: true } | { seen: string }): Promise<boolean>;
}
type TwitchRead = { error: boolean; type?: string; status?: number; data?: unknown };
export interface InteractionDeps {
    cache: () => Promise<InteractionCache>;
    fetchPoll: (channel: string) => Promise<TwitchRead>;
    fetchPrediction: (channel: string) => Promise<TwitchRead>;
    /** True when the channel has every poll (or prediction) notification subscribed. */
    subscribed: (channel: string, kind: InteractionKind) => Promise<boolean>;
    /** Subscribes what is missing; resolves true when the channel then has them all. */
    subscribe: (channel: string, kind: InteractionKind) => Promise<boolean>;
    now: () => number;
}

const running = (status: InteractionStatus) => status === 'active' || status === 'locked';
const finished = (status: InteractionStatus) => status === 'ended' || status === 'canceled';
const real = (snapshot: InteractionSnapshot) => snapshot.id !== '';
/** How far along a poll or prediction is; a later phase never goes back to an earlier one. */
const rank = (status: InteractionStatus) => finished(status) ? 2 : status === 'locked' ? 1 : status === 'active' ? 0 : -1;
/** An active poll or prediction whose end time passed a while ago: its end notification is missing. */
const overdue = (snapshot: InteractionSnapshot, now: number) =>
    snapshot.status === 'active' && snapshot.endsAt !== null && now > snapshot.endsAt + OVERDUE_GRACE_MS;

/** Votes (or Channel Points) in total. Within one poll or prediction this only ever goes up. */
const total = (snapshot: InteractionSnapshot) => snapshot.options.reduce((sum, option) => sum + option.value, 0);
/**
 * True when `current` must stay instead of the incoming notification: it is the same poll further
 * along (a later phase, or the same phase with more votes, or as many seen later), or a newer poll.
 * "No poll" never replaces a real snapshot.
 */
export function supersedes(current: InteractionSnapshot, incoming: InteractionSnapshot): boolean {
    if (!real(current)) return false;
    if (!real(incoming)) return true;
    if (current.id !== incoming.id) return incoming.startedAt < current.startedAt;
    if (rank(incoming.status) !== rank(current.status)) return rank(incoming.status) < rank(current.status);
    if (total(incoming) !== total(current)) return total(incoming) < total(current);
    return incoming.at < current.at;
}
/** The same rules as `supersedes` and the generation check, inside Dragonfly so the compare and the write are one step. */
const STORE_SCRIPT = `
local cur = redis.call('HMGET', KEYS[1], 'id', 'started', 'rank', 'total', 'at', 'generation')
if ARGV[1] == 'seen' then
  if (cur[6] or '') ~= ARGV[2] then return 0 end
elseif cur[1] and cur[1] ~= '' then
  if ARGV[3] == '' then return 0 end
  if cur[1] ~= ARGV[3] then
    if tonumber(ARGV[4]) < tonumber(cur[2]) then return 0 end
  else
    local rank, total, crank, ctotal = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(cur[3]), tonumber(cur[4])
    if rank < crank then return 0 end
    if rank == crank and (total < ctotal or (total == ctotal and tonumber(ARGV[7]) < tonumber(cur[5]))) then return 0 end
  end
end
redis.call('HSET', KEYS[1], 'id', ARGV[3], 'started', ARGV[4], 'rank', ARGV[5], 'total', ARGV[6], 'at', ARGV[7], 'generation', ARGV[8], 'json', ARGV[9])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[10]))
return 1`;
const INVALIDATE_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'generation', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1`;

const liveDeps: InteractionDeps = {
    cache: async () => {
        const client = await getDragonflyClient('twitch-interactions');
        // Every method is async, so a client problem is a rejection the callers already tolerate, never a throw.
        return {
            get: async key => client.get(key),
            set: async (key, value, options) => client.set(key, value, options),
            del: async key => client.del(key),
            read: async key => {
                const [json, generation] = await client.hmGet(key, ['json', 'generation']);
                return json || generation ? { json: json ?? null, generation: generation ?? '' } : null;
            },
            invalidate: async (key, ttlSeconds) => client.eval(INVALIDATE_SCRIPT, { keys: [key], arguments: [randomUUID(), String(ttlSeconds)] }),
            store: async (key, snapshot, ttlSeconds, rule) => Number(await client.eval(STORE_SCRIPT, {
                keys: [key],
                arguments: ['seen' in rule ? 'seen' : 'event', 'seen' in rule ? rule.seen : '', snapshot.id, String(snapshot.startedAt),
                    String(rank(snapshot.status)), String(total(snapshot)), String(snapshot.at), randomUUID(), JSON.stringify(snapshot), String(ttlSeconds)]
            })) === 1
        };
    },
    fetchPoll: channel => getPoll(channel),
    fetchPrediction: channel => getPrediction(channel),
    subscribed: async (channel, kind) => {
        const { default: Eventsub } = await import('../schemas/eventsub.schema.js');
        const types = await Eventsub.distinct('type', { channelID: channel, type: { $in: [...INTERACTION_SUBSCRIPTIONS[kind]] } });
        return INTERACTION_SUBSCRIPTIONS[kind].every(type => types.includes(type));
    },
    subscribe: async (channel, kind) => {
        const { activateInteraction } = await import('../overlays/interaction-subscriptions.js');
        const state = (await activateInteraction(channel, kind))[kind].state;
        return state === 'ready' || state === 'pending';
    },
    now: () => Date.now()
};

/** `fed`: Twitch's notifications keep this channel's snapshot current. */
export function interactionTtlSeconds(snapshot: InteractionSnapshot, fed: boolean, now: number): number {
    return real(snapshot) && fed && !overdue(snapshot, now) ? SNAPSHOT_TTL_SECONDS : UNFED_TTL_SECONDS;
}
/** Whether a stored snapshot can still be answered from, without asking Twitch. */
function usable(snapshot: InteractionSnapshot, fed: boolean, now: number): boolean {
    if (now - snapshot.at < UNFED_TTL_SECONDS * 1000) return true;
    return real(snapshot) && fed && !overdue(snapshot, now);
}

function count(value: unknown): number {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function time(value: unknown): number {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}
/** `start` plus `seconds`, in ms; null when either is missing. */
function deadline(start: number, seconds: unknown): number | null {
    const length = Number(seconds);
    return start > 0 && Number.isFinite(length) && length > 0 ? start + length * 1000 : null;
}
function empty(kind: InteractionKind, status: 'none' | 'unavailable', now: number): InteractionSnapshot {
    return { kind, id: '', title: '', status, options: [], winnerId: null, startedAt: 0, endsAt: null, at: now };
}

/** Helix poll statuses: ACTIVE, COMPLETED, TERMINATED (ended early), ARCHIVED (hidden), MODERATED (deleted), INVALID. */
export function pollStatus(raw: unknown): InteractionStatus {
    const status = String(raw ?? '').toUpperCase();
    if (status === 'ACTIVE') return 'active';
    return status === 'COMPLETED' || status === 'TERMINATED' || status === 'ARCHIVED' ? 'ended' : 'canceled';
}
/** Helix prediction statuses: ACTIVE, LOCKED, RESOLVED, CANCELED. */
export function predictionStatus(raw: unknown): InteractionStatus {
    const status = String(raw ?? '').toUpperCase();
    return status === 'ACTIVE' ? 'active' : status === 'LOCKED' ? 'locked' : status === 'RESOLVED' ? 'ended' : 'canceled';
}

/** From `getPoll().data`. */
export function pollSnapshot(data: unknown, now: number): InteractionSnapshot | null {
    const poll = data as { id?: unknown; title?: unknown; status?: unknown; choices?: unknown; startedAt?: unknown; duration?: unknown } | null | undefined;
    if (!poll || typeof poll.id !== 'string' || !poll.id || !Array.isArray(poll.choices)) return null;
    const status = pollStatus(poll.status), startedAt = time(poll.startedAt);
    return {
        kind: 'poll', id: poll.id, title: String(poll.title ?? ''), status, winnerId: null, at: now, startedAt,
        endsAt: status === 'active' ? deadline(startedAt, poll.duration) : null,
        options: (poll.choices as Array<Record<string, unknown>>).map(choice => ({
            id: String(choice?.id ?? ''), title: String(choice?.title ?? ''), value: count(choice?.votes), users: 0
        }))
    };
}
/** From `getPrediction().data`. */
export function predictionSnapshot(data: unknown, now: number): InteractionSnapshot | null {
    const prediction = data as { id?: unknown; title?: unknown; status?: unknown; predictionStatus?: unknown; outcomes?: unknown;
        winning_outcome_id?: unknown; createdAt?: unknown; predictionWindow?: unknown } | null | undefined;
    if (!prediction || typeof prediction.id !== 'string' || !prediction.id || !Array.isArray(prediction.outcomes)) return null;
    const status = predictionStatus(prediction.status ?? prediction.predictionStatus), startedAt = time(prediction.createdAt);
    const options = (prediction.outcomes as Array<Record<string, unknown>>).map(outcome => ({
        id: String(outcome?.id ?? ''), title: String(outcome?.title ?? ''), value: count(outcome?.channel_points), users: count(outcome?.users)
    }));
    const winnerId = status === 'ended' && typeof prediction.winning_outcome_id === 'string' && options.some(option => option.id === prediction.winning_outcome_id)
        ? prediction.winning_outcome_id : null;
    return {
        kind: 'prediction', id: prediction.id, title: String(prediction.title ?? ''), status, options, winnerId, at: now, startedAt,
        endsAt: status === 'active' ? deadline(startedAt, prediction.predictionWindow) : null
    };
}
/**
 * From a poll or prediction notification payload whose EventSub type is not known (a command
 * referenced from a chat event carries the payload only): end, lock, progress, then begin.
 */
export function payloadSnapshot(kind: InteractionKind, payload: unknown, now: number): InteractionSnapshot | null {
    const event = payload as Record<string, unknown> | null | undefined;
    if (!event || typeof event !== 'object' || !Array.isArray(event[kind === 'poll' ? 'choices' : 'outcomes'])) return null;
    const phases = [...(typeof event.status === 'string' ? ['end'] : []), ...(kind === 'prediction' && event.locked_at ? ['lock'] : []), 'progress', 'begin'];
    for (const phase of phases) {
        const snapshot = eventSnapshot(`channel.${kind}.${phase}`, event, now);
        if (snapshot) return snapshot;
    }
    return null;
}
/** From an EventSub `channel.poll.*` / `channel.prediction.*` payload; null when it is not one or is malformed. */
export function eventSnapshot(type: string, event: unknown, now: number): InteractionSnapshot | null {
    try {
        const state = parseInteraction(type, event as Record<string, unknown>, new Date(now).toISOString(), 'snapshot');
        const status: InteractionStatus = state.phase === 'active' ? 'active' : state.phase === 'locked' ? 'locked'
            : state.phase === 'canceled' ? 'canceled' : 'ended';
        return {
            kind: state.kind, id: state.id, title: state.title, status, winnerId: state.winnerId, at: now, startedAt: time(state.startedAt),
            endsAt: status === 'active' && state.deadline ? Date.parse(state.deadline) : null,
            options: state.choices.map(choice => ({
                id: choice.id, title: choice.title, value: state.kind === 'poll' ? choice.votes : choice.points, users: choice.users
            }))
        };
    } catch {
        return null;
    }
}

function parseStored(raw: { json: string | null; generation: string } | null, kind: InteractionKind): StoredSnapshot | null {
    if (!raw) return null;
    const invalidated: StoredSnapshot = { generation: raw.generation, snapshot: null };
    if (!raw.json) return invalidated;
    try {
        const value = JSON.parse(raw.json) as InteractionSnapshot;
        if (!value || value.kind !== kind || typeof value.status !== 'string' || !Array.isArray(value.options) || typeof value.at !== 'number') return invalidated;
        return { generation: raw.generation, snapshot: { ...value, startedAt: Number(value.startedAt) || 0, endsAt: typeof value.endsAt === 'number' ? value.endsAt : null } };
    } catch {
        return invalidated;
    }
}
const readStored = async (cache: InteractionCache | null, channel: string, kind: InteractionKind) =>
    parseStored(await cache?.read(snapshotKey(channel, kind)).catch(() => null) ?? null, kind);

async function withCanceled(cache: InteractionCache | null, channel: string, snapshot: InteractionSnapshot): Promise<InteractionSnapshot> {
    if (!cache || snapshot.kind !== 'poll' || snapshot.status !== 'ended' || !snapshot.id) return snapshot;
    return await cache.get(canceledKey(channel, snapshot.id)).catch(() => null) ? { ...snapshot, status: 'canceled' } : snapshot;
}
/** Whether the channel gets every notification of this kind; looked up at most every 10 minutes. */
async function isFed(cache: InteractionCache | null, channel: string, kind: InteractionKind, deps: InteractionDeps): Promise<boolean> {
    const known = await cache?.get(feedKey(channel, kind)).catch(() => null);
    if (known === '1' || known === '0') return known === '1';
    const fed = await deps.subscribed(channel, kind).catch(() => false);
    await cache?.set(feedKey(channel, kind), fed ? '1' : '0', { EX: FEED_TTL_SECONDS }).catch(() => undefined);
    return fed;
}
/** Turns the missing notifications on in the background, at most once an hour per channel. */
function ensureFed(cache: InteractionCache | null, channel: string, kind: InteractionKind, deps: InteractionDeps): void {
    if (!cache) return;
    void (async () => {
        if (await cache.set(ensureKey(channel, kind), '1', { NX: true, EX: ENSURE_TTL_SECONDS }) !== 'OK') return;
        if (await deps.subscribe(channel, kind)) await cache.set(feedKey(channel, kind), '1', { EX: FEED_TTL_SECONDS });
    })().catch(() => undefined);
}

/**
 * One Twitch read per channel and kind at a time in this process; callers arriving within 10 s share
 * it. An invalidation drops it, so nobody joins a read that started before the change.
 */
const flights = new WeakMap<InteractionDeps, Map<string, { read: Promise<InteractionSnapshot>; startedAt: number }>>();
function flightsOf(deps: InteractionDeps) {
    let map = flights.get(deps);
    if (!map) { map = new Map(); flights.set(deps, map); }
    return map;
}

async function refresh(channel: string, kind: InteractionKind, cache: InteractionCache | null, seen: StoredSnapshot | null, deps: InteractionDeps): Promise<InteractionSnapshot> {
    const startedAt = deps.now();
    let snapshot: InteractionSnapshot;
    try {
        const result = kind === 'poll' ? await deps.fetchPoll(channel) : await deps.fetchPrediction(channel);
        if (result.error) snapshot = empty(kind, result.type === 'not_found' || result.status === 404 ? 'none' : 'unavailable', startedAt);
        else snapshot = (kind === 'poll' ? pollSnapshot(result.data, startedAt) : predictionSnapshot(result.data, startedAt)) ?? empty(kind, 'unavailable', startedAt);
    } catch {
        snapshot = empty(kind, 'unavailable', startedAt);
    }
    snapshot = await withCanceled(cache, channel, snapshot);
    if (!cache) return snapshot;
    // Twitch answered, so the channel can use polls: make sure its notifications are on from now on.
    const fed = snapshot.status === 'unavailable' ? false : await isFed(cache, channel, kind, deps);
    if (!fed && snapshot.status !== 'unavailable') ensureFed(cache, channel, kind, deps);
    const stored = await cache.store(snapshotKey(channel, kind), snapshot, interactionTtlSeconds(snapshot, fed, deps.now()), { seen: seen?.generation ?? '' })
        .catch(() => true);
    if (stored) return snapshot;
    // A notification arrived (or the snapshot was invalidated) while Twitch was answering: prefer the newer view.
    return (await readStored(cache, channel, kind))?.snapshot ?? snapshot;
}

/** The latest poll or prediction of the channel: the shared snapshot, else one Twitch read. Never throws. */
export async function readInteraction(channel: string, kind: InteractionKind, deps: InteractionDeps = liveDeps): Promise<InteractionSnapshot> {
    const now = deps.now();
    if (!channel) return empty(kind, 'unavailable', now);
    const cache = await deps.cache().catch(() => null);
    const stored = await readStored(cache, channel, kind);
    if (stored?.snapshot) {
        const fed = real(stored.snapshot) ? await isFed(cache, channel, kind, deps) : false;
        // A channel that stopped getting notifications (or never got all of them) is repaired on use.
        if (real(stored.snapshot) && !fed) ensureFed(cache, channel, kind, deps);
        if (usable(stored.snapshot, fed, now)) return stored.snapshot;
    }
    const key = `${channel}:${kind}`, inFlight = flightsOf(deps), pending = inFlight.get(key);
    if (pending && now - pending.startedAt < READ_JOIN_MS) return pending.read;
    const read = refresh(channel, kind, cache, stored, deps);
    const flight = { read, startedAt: now };
    inFlight.set(key, flight);
    void read.finally(() => { if (inFlight.get(key) === flight) inFlight.delete(key); }).catch(() => undefined);
    return read;
}

/**
 * A poll or prediction EventSub notification replaces the snapshot unless the stored one is further
 * along. Returns the notification's own snapshot (null: not such an event), whether or not it was stored.
 */
export async function noteInteractionEvent(channel: string, type: string, event: unknown, deps: InteractionDeps = liveDeps): Promise<InteractionSnapshot | null> {
    if (!channel || !(type.startsWith('channel.poll.') || type.startsWith('channel.prediction.'))) return null;
    const now = deps.now();
    const parsed = eventSnapshot(type, event, now);
    if (!parsed) return null;
    const cache = await deps.cache().catch(() => null);
    const snapshot = await withCanceled(cache, channel, parsed);
    if (!cache) return snapshot;
    // A channel with only some of the notifications (an end but no begin) cannot be trusted for the hour.
    // The missing ones are only turned on when a command actually reads a poll (readInteraction), so a
    // channel that never uses these functions is not subscribed to anything it did not ask for.
    const fed = await isFed(cache, channel, snapshot.kind, deps);
    await cache.store(snapshotKey(channel, snapshot.kind), snapshot, interactionTtlSeconds(snapshot, fed, now), { event: true }).catch(() => false);
    return snapshot;
}

/**
 * A poll or prediction was started or changed from here: the next read asks Twitch, and a Twitch
 * read that is still in flight (it may hold the old state) is neither stored nor joined.
 */
export async function forgetInteraction(channel: string, kind: InteractionKind, deps: InteractionDeps = liveDeps): Promise<void> {
    // Callers do not wait for this (Twitch already committed their change): it must never reject.
    try {
        flightsOf(deps).delete(`${channel}:${kind}`);
        const cache = await deps.cache();
        await cache.invalidate(snapshotKey(channel, kind), INVALIDATED_TTL_SECONDS);
    } catch { /* cache unreachable: reads then go to Twitch directly */ }
}
/** Twitch revoked one of the channel's poll or prediction subscriptions: look the feed up again on next use. */
export async function forgetInteractionFeed(channel: string, type: string, deps: InteractionDeps = liveDeps): Promise<void> {
    const kind: InteractionKind | null = type.startsWith('channel.poll.') ? 'poll' : type.startsWith('channel.prediction.') ? 'prediction' : null;
    if (!channel || !kind) return;
    const cache = await deps.cache().catch(() => null);
    await cache?.del(feedKey(channel, kind)).catch(() => undefined);
}

/**
 * `cancel.poll` is about to stop this poll: it has no result, and "Poll ended" stays silent for it.
 * Recorded BEFORE Twitch is asked, because the end notification can arrive before Twitch's answer.
 */
export async function markPollCanceled(channel: string, pollId: string, deps: InteractionDeps = liveDeps): Promise<void> {
    if (!channel || !pollId) return;
    const cache = await deps.cache().catch(() => null);
    await cache?.set(canceledKey(channel, pollId), '1', { EX: CANCELED_TTL_SECONDS }).catch(() => undefined);
}
/**
 * Twitch refused the cancellation: the poll goes on (or ended by itself) and keeps its result. A
 * snapshot taken while it was marked may say "canceled", so the next read asks Twitch again.
 */
export async function unmarkPollCanceled(channel: string, pollId: string, deps: InteractionDeps = liveDeps): Promise<void> {
    if (!channel || !pollId) return;
    const cache = await deps.cache().catch(() => null);
    await cache?.del(canceledKey(channel, pollId)).catch(() => undefined);
    await forgetInteraction(channel, 'poll', deps);
}

/** The options sharing the highest value; one entry means a clear leader. Zero votes: every option. */
export function leaders(snapshot: InteractionSnapshot): InteractionOption[] {
    if (!snapshot.options.length) return [];
    const top = Math.max(...snapshot.options.map(option => option.value));
    return snapshot.options.filter(option => option.value === top);
}
/** By exact title first (case-insensitive), then by position starting at 1. */
export function findOption(snapshot: InteractionSnapshot, reference: string): InteractionOption | null {
    const wanted = reference.trim();
    if (!wanted) return null;
    const byTitle = snapshot.options.find(option => option.title === wanted)
        ?? snapshot.options.find(option => option.title.trim().toLowerCase() === wanted.toLowerCase());
    if (byTitle) return byTitle;
    return /^\d{1,2}$/.test(wanted) ? snapshot.options[Number(wanted) - 1] ?? null : null;
}
