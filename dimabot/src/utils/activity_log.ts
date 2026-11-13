import { createHash, randomUUID } from 'node:crypto';
import {
    ACTIVITY_KINDS, ACTIVITY_OUTCOMES, ACTIVITY_RETENTION_DAYS, ACTIVITY_TEXT_MAX, ActivityLog,
    type ActivityData, type ActivityKind, type ActivityOutcome, type ActivityService, type IActivityLog
} from '../schemas/activity_log.schema.js';
import { observe } from './observability/telemetry.js';
import { scrubSensitive } from './scrub_text.js';
import UsersSchema from '../schemas/users.schema.js';

/**
 * Writer for the owner's debug trail (see `schemas/activity_log.schema.ts`).
 *
 * `recordActivity` is called from the chat path, so it is built to be harmless there: it is
 * synchronous, it never throws, it never waits for the database, and when the database is slow or
 * down it drops rows instead of holding memory. Rows are written in batches about once a second.
 * A row is a debugging aid, never the record of truth: nothing may depend on it having been written.
 */
export interface ActivityInput {
    kind: ActivityKind;
    /** What it is within the kind: '!so', 'channel.follow', 'fish'. */
    name: string;
    channelID?: string | null;
    outcome?: ActivityOutcome;
    /** Machine code for anything that is not plain ok: 'cooldown', 'permission_denied', 'alert_disabled'. */
    reason?: string | null;
    actor?: { id?: string | null; login?: string | null; name?: string | null } | null;
    /** Short preview; clipped to 300 characters. */
    text?: string | null;
    /** Id of the full record elsewhere (domain event key, speech id, Twitch message id). */
    ref?: string | null;
    durationMs?: number | null;
    /** A few flat facts for the detail view. At most 12 keys; strings are clipped to 200 characters. */
    data?: Record<string, unknown> | null;
    at?: Date;
    /**
     * Give the same key for the same real-world thing (for example a Twitch message id) and a retry
     * or a second process writes it once. Without it every call is its own row.
     */
    dedupeKey?: string | null;
}

const MAX_BUFFER = 2000;
const BATCH = 200;
const FLUSH_MS = 1000;
const MAX_DATA_KEYS = 12;
const MAX_DATA_STRING = 200;
const RETENTION_MS = ACTIVITY_RETENTION_DAYS * 86_400_000;
const WARN_EVERY_MS = 60_000;

const service: ActivityService = (process.argv[1] || '').includes('/workers/') ? 'cron'
    : (process.argv[1] || '').includes('/bot/') ? 'bot' : 'api';
const enabled = () => process.env.ACTIVITY_LOG_ENABLED !== 'false';

type Sink = (rows: IActivityLog[]) => Promise<void>;

/** The channel ids among `ids` that still have an account. */
export type AccountLookup = (ids: string[]) => Promise<Set<string>>;
const accountsInMongo: AccountLookup = async (ids) => {
    const owners = await UsersSchema.find({ accounts: { $elemMatch: { type: 'twitch', id: { $in: ids } } } })
        .select('accounts.type accounts.id').maxTimeMS(3000).lean();
    const known = new Set<string>();
    for (const owner of owners) for (const account of owner.accounts || []) if (account.type === 'twitch') known.add(String(account.id));
    return known;
};

/**
 * A streamer who deleted their account must not get new rows: a timer or a late Twitch notification can
 * still fire for the channel minutes afterwards. So right before each write, rows whose channel no longer
 * has an account are dropped (rows that belong to no channel pass). One small lookup per batch, off the
 * chat path. Exported for tests.
 */
export async function dropRowsWithoutAccount(rows: IActivityLog[], lookup: AccountLookup = accountsInMongo): Promise<IActivityLog[]> {
    const ids = [...new Set(rows.map(row => row.channelID).filter(Boolean))];
    if (!ids.length) return rows;
    const known = await lookup(ids);
    return rows.filter(row => !row.channelID || known.has(row.channelID));
}

const mongoSink: Sink = async (batch) => {
    const rows = await dropRowsWithoutAccount(batch);
    if (!rows.length) return;
    try {
        // Unordered: one duplicate (a retried event) must not stop the rest of the batch.
        await ActivityLog.collection.insertMany(rows as never[], { ordered: false, writeConcern: { w: 1 } });
    } catch (error) {
        const writeErrors = (error as { writeErrors?: { code?: number }[] }).writeErrors;
        const onlyDuplicates = (error as { code?: number }).code === 11000
            && (!Array.isArray(writeErrors) || writeErrors.every(item => item?.code === 11000));
        if (!onlyDuplicates) throw error;
    }
};

let sink: Sink = mongoSink;
let buffer: IActivityLog[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let lastWarnAt = 0;

const clip = (value: unknown, max: number): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : String(value);
    if (text.length <= max) return text;
    // Array.from keeps surrogate pairs whole, so a clipped emoji never becomes a lone surrogate.
    // Cut by code units first so a huge input is never expanded into an array.
    return Array.from(text.slice(0, max * 2)).slice(0, max).join('');
};

/**
 * Clipped, with credentials and e-mail addresses masked (see `scrub_text.ts`), so they never reach the
 * buffer or the database. Exported for tests.
 */
export function safeText(value: unknown, max: number): string {
    // Scrub a wider window than is kept, so a secret that straddles the cut is still masked.
    return clip(scrubSensitive(clip(value, max * 2)), max);
}

function cleanData(input: Record<string, unknown> | null | undefined): ActivityData {
    const out: ActivityData = {};
    if (!input || typeof input !== 'object') return out;
    let kept = 0;
    for (const [key, value] of Object.entries(input)) {
        if (kept >= MAX_DATA_KEYS) break;
        // Mongo field names: no dots, no leading dollar sign.
        const name = clip(key, 40).replace(/[.$]/g, '_');
        if (!name || value === undefined) continue;
        if (value === null || typeof value === 'boolean') out[name] = value;
        else if (typeof value === 'number') { if (!Number.isFinite(value)) continue; out[name] = value; }
        else if (typeof value === 'string') out[name] = safeText(value, MAX_DATA_STRING);
        else continue;
        kept++;
    }
    return out;
}

/** The stored row for an input, or null when the input is not usable. Exported for tests. */
export function buildActivityRow(input: ActivityInput, now = Date.now()): IActivityLog | null {
    if (!input || !ACTIVITY_KINDS.includes(input.kind)) return null;
    const name = clip(input.name, 100).trim();
    if (!name) return null;
    const outcome: ActivityOutcome = ACTIVITY_OUTCOMES.includes(input.outcome as ActivityOutcome) ? input.outcome as ActivityOutcome : 'ok';
    let at = input.at instanceof Date && Number.isFinite(input.at.getTime()) ? input.at.getTime() : now;
    // A clock that is far off would make the row unfindable (or immortal): use the write time instead.
    if (at > now + 60_000 || at < now - RETENTION_MS) at = now;
    const channelID = clip(input.channelID, 32);
    const dedupeKey = clip(input.dedupeKey, 300);
    const duration = Number(input.durationMs);
    return {
        _id: dedupeKey
            ? createHash('sha256').update(JSON.stringify([channelID, input.kind, dedupeKey])).digest('hex').slice(0, 40)
            : randomUUID(),
        at: new Date(at),
        channelID,
        kind: input.kind,
        name,
        outcome,
        reason: outcome === 'ok' ? '' : clip(input.reason, 64),
        actorID: clip(input.actor?.id, 32),
        actorLogin: clip(input.actor?.login, 64).toLowerCase(),
        actorName: clip(input.actor?.name, 64),
        text: safeText(input.text, ACTIVITY_TEXT_MAX),
        ref: clip(input.ref, 300),
        durationMs: input.durationMs === null || input.durationMs === undefined || !Number.isFinite(duration) ? null : Math.max(0, Math.round(duration)),
        data: cleanData(input.data),
        service,
        expiresAt: new Date(at + RETENTION_MS)
    };
}

function warn(message: string, error?: unknown): void {
    const now = Date.now();
    if (now - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = now;
    // Console only: the logger writes to the same stores this file must not depend on.
    console.warn(`[activity-log] ${message}`, error instanceof Error ? error.message : error ?? '');
}

function schedule(): void {
    if (timer || flushing) return;
    timer = setTimeout(() => { timer = null; void flushActivityLog(); }, FLUSH_MS);
    // A pending flush must never keep a process (or a test run) alive.
    timer.unref?.();
}

/** Queue one row. Safe anywhere: synchronous, never throws, never waits. */
export function recordActivity(input: ActivityInput): void {
    try {
        if (!enabled()) return;
        const row = buildActivityRow(input);
        if (!row) return;
        if (buffer.length >= MAX_BUFFER) {
            observe('activity_log', 'dropped', 1, 'error', row.channelID || undefined);
            warn('buffer full, dropping rows');
            return;
        }
        buffer.push(row);
        schedule();
    } catch (error) {
        try { warn('could not queue a row', error); } catch { /* nothing left to do */ }
    }
}

/** Write what is queued. Resolves when the queue is empty or the store refused a batch. Never rejects. */
export function flushActivityLog(): Promise<void> {
    if (flushing) return flushing;
    // Nothing to do must not start a flush: an async body that never awaits would clear `flushing`
    // before the assignment below sets it, leaving it set forever and no later flush scheduled.
    if (!buffer.length) return Promise.resolve();
    const run = (async () => {
        while (buffer.length) {
            const rows = buffer.splice(0, BATCH);
            try {
                await sink(rows);
                observe('activity_log', 'written', rows.length);
            } catch (error) {
                // Do not retry: a store that is down would otherwise fill the buffer with stale rows.
                observe('activity_log', 'dropped', rows.length, 'error');
                warn(`dropped ${rows.length} rows, the store refused them`, error);
                break;
            }
        }
    })().catch(() => undefined).finally(() => {
        if (flushing === run) flushing = null;
        if (buffer.length) schedule();
    });
    flushing = run;
    return run;
}

const PURGE_SWEEP_MS = 10_000;

/**
 * Remove every row of a channel (account deletion). The bot and the cron workers may still hold rows
 * for it in their own buffers, or have a write in flight, for about a second, so a second pass runs a
 * few seconds later. After that nothing new arrives: every writer drops rows for a channel without an
 * account (`dropRowsWithoutAccount`). A row that slips past all of it still expires with the 30-day TTL.
 */
export async function purgeChannelActivity(channelID: string): Promise<number> {
    if (!channelID) return 0;
    buffer = buffer.filter(row => row.channelID !== channelID);
    const result = await ActivityLog.deleteMany({ channelID });
    const sweep = setTimeout(() => { ActivityLog.deleteMany({ channelID }).catch(() => undefined); }, PURGE_SWEEP_MS);
    sweep.unref?.();
    return result.deletedCount ?? 0;
}

/** Tests only: replace the store (null restores Mongo) and start from an empty queue. */
export function setActivityLogSinkForTests(next: Sink | null): void {
    sink = next || mongoSink;
    buffer = [];
    if (timer) { clearTimeout(timer); timer = null; }
    lastWarnAt = 0;
}

/** Tests only: rows waiting to be written. */
export function pendingActivityRowsForTests(): readonly IActivityLog[] {
    return buffer;
}
