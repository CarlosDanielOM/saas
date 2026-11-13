import { ActivityLog, type ActivityOutcome } from '../../schemas/activity_log.schema.js';
import { DomainEventDeliverySchema } from '../../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../../schemas/domain_event.schema.js';
import { TWITCH_DOMAIN_EVENT_TYPES } from '../../domain_events/domain_event_contracts.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { isSensitiveKey, scrubSensitive } from '../../utils/scrub_text.js';

/**
 * Per-channel debugging for the admin channel page. Mirrors `admin/src/app/services/channel-debug-api.service.ts`
 * (the contract): the bot's own log lines, how each chat command fared, and what Twitch sent and what
 * came of it.
 */

const DAY_MS = 86_400_000;
const QUERY_MS = 5000;
/** One channel's rows: with little data the planner may prefer `{kind, at}`, which scans every channel. */
const CHANNEL_ACTIVITY_INDEX = { channelID: 1, at: -1, _id: -1 };

// ---- Bot log lines (Dragonfly logger) ----

export const BOT_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type BotLogLevel = typeof BOT_LOG_LEVELS[number];
export type BotLogFilter = 'problems' | BotLogLevel;
export const PROBLEM_LEVELS: readonly BotLogLevel[] = ['warn', 'error', 'fatal'];

export interface BotLogEntry {
    id: string;
    at: string;
    level: BotLogLevel;
    function: string | null;
    message: string | null;
    data: Record<string, string | number | boolean | null>;
}
export interface BotLogPage { entries: BotLogEntry[]; truncated: boolean; counts: Record<BotLogLevel, number> }

export interface LogKey { key: string; platform: string; channelId: string; level: string; ms: number; logId: string }

/** `logger:<platform>:<channelId>:<level>:<ms>-<rand>` (see `utils/logger.ts`); null for anything else. */
export function parseLogKey(key: string): LogKey | null {
    const parts = key.split(':');
    if (parts.length !== 5 || parts[0] !== 'logger') return null;
    const [, platform, channelId, level, logId] = parts;
    const match = /^(\d{1,15})-[a-z0-9]*$/.exec(logId);
    if (!platform || !channelId || !level || !match) return null;
    const ms = Number(match[1]);
    return Number.isSafeInteger(ms) ? { key, platform, channelId, level, ms, logId } : null;
}

/** Newest first; the key breaks ties so the order is stable. */
export const sortLogKeys = (keys: LogKey[]): LogKey[] =>
    [...keys].sort((a, b) => b.ms - a.ms || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

export const LOG_TEXT_MAX = 300;
const MAX_FIELDS = 40;
const MAX_DEPTH = 4;
/** Only the first 300 characters are shown; scrubbing more than this would be work for nothing. */
const SCRUB_MAX = 4000;

const clip = (text: string, max = LOG_TEXT_MAX): string => text.length <= max ? text : Array.from(text.slice(0, max * 2)).slice(0, max).join('');

/**
 * Field names dropped on top of `isSensitiveKey` (which matches whole names only). Log lines are written
 * by hand all over the bot, so names arrive compounded: `twitchAccessToken`, `userEmail`, `x-signature`,
 * `streamKey`. Dropped when the name contains token (but not a token count such as `promptTokens`),
 * secret, password, credential, signature, e-mail, cookie, authorization or phone, or ends in a key that
 * is a credential (`apiKey`, `streamKey`, `secretKey`…). Names that merely end in "key" (`eventKey`,
 * `cacheKey`, `rewardKey`) stay: they are ids, and their values are scrubbed like any other string.
 */
const CONTAINS_SECRET = /secret|passw(?:or)?d|credential|signature|e-?mail|cookie|authori[sz]ation|phone/i;
const TOKEN_COUNT = /tokens$|tokens[_-]|token[_-]?count/i;
const CREDENTIAL_KEY = /(?:api|secret|private|access|signing|encryption|client|auth|session|license|stream|webhook)[_-]?key$/i;

export function isDroppedLogField(key: string): boolean {
    return isSensitiveKey(key) || CONTAINS_SECRET.test(key) || CREDENTIAL_KEY.test(key) || (/token/i.test(key) && !TOKEN_COUNT.test(key));
}

/**
 * Copy of `value` without any field whose name says it is a credential or contact detail, at any depth
 * (inside arrays too). Every string is passed through `scrubSensitive`, which masks credentials and
 * e-mail addresses written inside the text (connection strings, `api_key=…`, JWTs, header values).
 */
export function scrubSecrets(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return scrubSensitive(value.length > SCRUB_MAX ? value.slice(0, SCRUB_MAX) : value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_DEPTH) return null;
    if (Array.isArray(value)) return value.slice(0, 20).map(item => scrubSecrets(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (isDroppedLogField(key)) continue;
        out[key] = scrubSecrets(item, depth + 1);
    }
    return out;
}

type Plain = string | number | boolean | null;

/** Nested objects become dotted keys; arrays become clipped JSON. Already scrubbed input only. */
export function flattenPlain(value: Record<string, unknown>, prefix = '', out: Record<string, Plain> = {}): Record<string, Plain> {
    for (const [key, item] of Object.entries(value)) {
        if (Object.keys(out).length >= MAX_FIELDS) break;
        const name = prefix ? `${prefix}.${key}` : key;
        if (item === null || item === undefined) out[name] = null;
        else if (typeof item === 'string') out[name] = clip(item);
        else if (typeof item === 'number') out[name] = Number.isFinite(item) ? item : null;
        else if (typeof item === 'boolean') out[name] = item;
        else if (Array.isArray(item)) out[name] = clip(JSON.stringify(item));
        else if (typeof item === 'object') flattenPlain(item as Record<string, unknown>, name, out);
    }
    return out;
}

const textOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value || null;
    if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') return (value as { message: string }).message || null;
    return null;
};

/** The admin's view of one stored log line. */
export function shapeLogEntry(key: LogKey, raw: string | null): BotLogEntry | null {
    if (!raw || !(BOT_LOG_LEVELS as readonly string[]).includes(key.level)) return null;
    let stored: unknown;
    try { stored = JSON.parse(raw); } catch { return null; }
    const data = scrubSecrets((stored as { data?: unknown } | null)?.data);
    let fn: string | null = null;
    let message: string | null = null;
    let rest: Record<string, Plain> = {};
    if (typeof data === 'string') {
        message = data || null;
    } else if (data && typeof data === 'object' && !Array.isArray(data)) {
        const { function: where, message: text, error, ...others } = data as Record<string, unknown>;
        fn = typeof where === 'string' && where ? clip(where, 100) : null;
        message = textOf(text) ?? textOf(error);
        // An error next to a message is a fact of its own.
        if (textOf(text) && error !== undefined) others.error = textOf(error) ?? error;
        rest = flattenPlain(others);
    }
    return {
        id: `${key.platform}:${key.level}:${key.logId}`,
        at: new Date(key.ms).toISOString(),
        level: key.level as BotLogLevel,
        function: fn,
        message: message === null ? null : clip(message),
        data: rest
    };
}

export interface LogScanOptions { scanMs: number; maxKeys: number; scanCount: number }
const LOG_SCAN: LogScanOptions = { scanMs: 1500, maxKeys: 20_000, scanCount: 5000 };
const MGET_BATCH = 100;

interface LogStore {
    scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }>;
    mGet(keys: string[]): Promise<Array<string | null>>;
}

async function dragonflyLogStore(): Promise<LogStore> {
    const redis = await getDragonflyClient('admin-channel-debug');
    return {
        scan: async (cursor, match, count) => {
            const reply = await redis.scan(cursor, { MATCH: match, COUNT: count });
            return { cursor: String(reply.cursor), keys: reply.keys };
        },
        mGet: keys => redis.mGet(keys)
    };
}

/**
 * The logger keeps no index, so the channel's keys are found with SCAN over the keyspace: bounded by a
 * time budget and a key cap, after which the page says it is truncated. Only the newest `limit` values
 * are read.
 */
export async function channelLogs(channelID: string, filter: BotLogFilter, limit: number, store?: LogStore, options: LogScanOptions = LOG_SCAN): Promise<BotLogPage> {
    const source = store || await dragonflyLogStore();
    const match = `logger:*:${channelID}:*`;
    const started = Date.now();
    const keys: LogKey[] = [];
    let cursor = '0';
    let complete = false;
    do {
        const reply = await source.scan(cursor, match, options.scanCount);
        cursor = reply.cursor;
        for (const key of reply.keys) {
            const parsed = parseLogKey(key);
            if (parsed && parsed.channelId === channelID) keys.push(parsed);
        }
        if (cursor === '0') complete = true;
    } while (!complete && keys.length < options.maxKeys && Date.now() - started < options.scanMs);

    const counts = Object.fromEntries(BOT_LOG_LEVELS.map(level => [level, 0])) as Record<BotLogLevel, number>;
    for (const key of keys) if (key.level in counts) counts[key.level as BotLogLevel]++;
    const wanted: readonly string[] = filter === 'problems' ? PROBLEM_LEVELS : [filter];
    const matching = sortLogKeys(keys.filter(key => wanted.includes(key.level)));
    const newest = matching.slice(0, limit);
    const entries: BotLogEntry[] = [];
    for (let start = 0; start < newest.length; start += MGET_BATCH) {
        const batch = newest.slice(start, start + MGET_BATCH);
        const values = await source.mGet(batch.map(key => key.key));
        batch.forEach((key, index) => {
            const entry = shapeLogEntry(key, values[index] ?? null);
            if (entry) entries.push(entry);
        });
    }
    return { entries, truncated: !complete || matching.length > newest.length, counts };
}

// ---- Command stats (activity log) ----

export interface CommandStat {
    name: string;
    runs: number;
    ok: number;
    skipped: number;
    blocked: number;
    failed: number;
    lastAt: string;
    lastOutcome: ActivityOutcome;
    lastReason: string | null;
    reasons: Array<{ reason: string; count: number }>;
}
export interface CommandStats { from: string; to: string; commands: CommandStat[]; recordsSince: string | null }

export interface CommandGroupRow { _id: { name: string; outcome: ActivityOutcome; reason: string }; n: number; lastAt: Date }
export const MAX_COMMANDS = 200;
const OUTCOMES: readonly ActivityOutcome[] = ['ok', 'skipped', 'blocked', 'failed'];

/** Per-command totals from rows grouped by (name, outcome, reason). */
export function shapeCommandStats(rows: CommandGroupRow[]): CommandStat[] {
    const commands = new Map<string, CommandStat & { lastTime: number; reasonCounts: Map<string, number> }>();
    for (const row of rows) {
        const { name, outcome, reason } = row._id;
        if (!name || !OUTCOMES.includes(outcome)) continue;
        const time = new Date(row.lastAt).getTime();
        const stat = commands.get(name) || {
            name, runs: 0, ok: 0, skipped: 0, blocked: 0, failed: 0, lastAt: '', lastOutcome: 'ok' as ActivityOutcome,
            lastReason: null, reasons: [], lastTime: -Infinity, reasonCounts: new Map<string, number>()
        };
        stat.runs += row.n;
        stat[outcome] += row.n;
        if (outcome !== 'ok' && reason) stat.reasonCounts.set(reason, (stat.reasonCounts.get(reason) || 0) + row.n);
        if (time > stat.lastTime) {
            stat.lastTime = time;
            stat.lastAt = new Date(time).toISOString();
            stat.lastOutcome = outcome;
            stat.lastReason = outcome === 'ok' ? null : reason || null;
        }
        commands.set(name, stat);
    }
    return [...commands.values()]
        .sort((a, b) => b.runs - a.runs || b.lastTime - a.lastTime || a.name.localeCompare(b.name))
        .slice(0, MAX_COMMANDS)
        .map(({ lastTime: _lastTime, reasonCounts, ...stat }) => ({
            ...stat,
            reasons: [...reasonCounts.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 3)
                .map(([reason, count]) => ({ reason, count }))
        }));
}

/** One aggregation on the activity log's `{channelID, at}` index. */
export async function commandStats(channelID: string, days: number, now = new Date()): Promise<CommandStats> {
    const from = new Date(now.getTime() - days * DAY_MS);
    const [rows, oldest] = await Promise.all([
        ActivityLog.aggregate<CommandGroupRow>([
            { $match: { channelID, at: { $gte: from, $lte: now }, kind: 'command' } },
            { $group: { _id: { name: '$name', outcome: '$outcome', reason: '$reason' }, n: { $sum: 1 }, lastAt: { $max: '$at' } } }
        ]).hint(CHANNEL_ACTIVITY_INDEX).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.findOne({ channelID, kind: 'command' }).sort({ at: 1 }).hint(CHANNEL_ACTIVITY_INDEX).select('at').maxTimeMS(QUERY_MS).lean()
    ]);
    return {
        from: from.toISOString(),
        to: now.toISOString(),
        commands: shapeCommandStats(rows),
        recordsSince: oldest?.at ? new Date(oldest.at).toISOString() : null
    };
}

// ---- EventSub activity ----

export type FeedOutcome = ActivityOutcome;
export interface EventTypeActivity {
    type: string;
    lastReceivedAt: string | null;
    received7d: number;
    lastAlert: { at: string; outcome: FeedOutcome; reason: string | null } | null;
    failedDeliveries: number;
}
export interface EventsubActivity { types: EventTypeActivity[]; revoked: Array<{ at: string; type: string; reason: string | null }> }

/** Journal type → the Twitch type it came from, for journal rows without `metadata.originalEventType`. */
const JOURNAL_TO_TWITCH: Record<string, string> = { 'channel.raid.sent': 'channel.raid' };
for (const [twitch, journal] of Object.entries(TWITCH_DOMAIN_EVENT_TYPES)) JOURNAL_TO_TWITCH[journal] ||= twitch;

export function twitchTypeOf(journalType: string, originalEventType: unknown): string {
    return typeof originalEventType === 'string' && originalEventType ? originalEventType : JOURNAL_TO_TWITCH[journalType] || journalType;
}

export interface ReceivedRow { type: string; lastAt: Date | null; received7d: number }
export interface AlertRow { type: string; at: Date; outcome: FeedOutcome; reason: string }

/** One row per Twitch type with anything to say, most recently received first. */
export function mergeEventsubActivity(received: ReceivedRow[], alerts: AlertRow[], failed: Map<string, number>): EventTypeActivity[] {
    const types = new Map<string, EventTypeActivity & { lastTime: number }>();
    const row = (type: string) => {
        let item = types.get(type);
        if (!item) {
            item = { type, lastReceivedAt: null, received7d: 0, lastAlert: null, failedDeliveries: 0, lastTime: -Infinity };
            types.set(type, item);
        }
        return item;
    };
    for (const item of received) {
        const target = row(item.type);
        target.received7d += item.received7d;
        const time = item.lastAt ? new Date(item.lastAt).getTime() : NaN;
        if (Number.isFinite(time) && time > target.lastTime) {
            target.lastTime = time;
            target.lastReceivedAt = new Date(time).toISOString();
        }
    }
    for (const alert of alerts) {
        const target = row(alert.type);
        const time = new Date(alert.at).getTime();
        if (!target.lastAlert || time > new Date(target.lastAlert.at).getTime()) {
            target.lastAlert = { at: new Date(time).toISOString(), outcome: alert.outcome, reason: alert.outcome === 'ok' ? null : alert.reason || null };
        }
    }
    for (const [type, count] of failed) row(type).failedDeliveries += count;
    return [...types.values()]
        .sort((a, b) => b.lastTime - a.lastTime || a.type.localeCompare(b.type))
        .map(({ lastTime: _lastTime, ...item }) => item);
}

const EVENTSUB_DAYS = 30;
const DEAD_DELIVERIES_READ = 5000;
const REVOKED_READ = 50;

/**
 * Deliveries carry no channel, so the dead ones of the window (few, on the `status` index) are read first
 * and matched to this channel's journal rows by event key (unique index).
 */
async function deadDeliveriesByType(channelID: string, since: Date): Promise<Map<string, number>> {
    const dead = await DomainEventDeliverySchema.find({ status: 'dead', deadLetteredAt: { $gte: since } })
        .select('eventKey -_id').limit(DEAD_DELIVERIES_READ).maxTimeMS(QUERY_MS).lean();
    const perKey = new Map<string, number>();
    for (const delivery of dead) perKey.set(delivery.eventKey, (perKey.get(delivery.eventKey) || 0) + 1);
    const out = new Map<string, number>();
    if (!perKey.size) return out;
    // By key, not by channel: a busy channel has far more events than the window has dead deliveries.
    const events = await DomainEventSchema.find({ eventKey: { $in: [...perKey.keys()] }, channelID })
        .hint({ eventKey: 1 }).select('eventKey type metadata.originalEventType -_id').maxTimeMS(QUERY_MS).lean();
    for (const event of events) {
        const type = twitchTypeOf(event.type, (event.metadata as Record<string, unknown> | undefined)?.originalEventType);
        out.set(type, (out.get(type) || 0) + (perKey.get(event.eventKey) || 0));
    }
    return out;
}

export async function eventsubActivity(channelID: string, now = new Date()): Promise<EventsubActivity> {
    const since = new Date(now.getTime() - EVENTSUB_DAYS * DAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const inWeek = { $sum: { $cond: [{ $gte: ['$at', weekAgo] }, 1, 0] } };
    const [journal, activity, revoked, failed] = await Promise.all([
        // Real Twitch notifications only: test events sent from the dashboard are not something Twitch did.
        DomainEventSchema.aggregate<{ _id: { type: string; original: unknown }; lastAt: Date; received7d: number }>([
            { $match: { channelID, source: 'twitch-eventsub', occurredAt: { $gte: since, $lte: now } } },
            {
                $group: {
                    _id: { type: '$type', original: '$metadata.originalEventType' },
                    lastAt: { $max: '$occurredAt' },
                    received7d: { $sum: { $cond: [{ $gte: ['$occurredAt', weekAgo] }, 1, 0] } }
                }
            }
        ]).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.aggregate<{ _id: { kind: 'twitch_event' | 'alert'; name: string }; lastAt: Date; outcome: FeedOutcome; reason: string; received7d: number }>([
            // A handler crash is written as a twitch_event row too; it is not a second notification.
            { $match: { channelID, at: { $gte: since, $lte: now }, kind: { $in: ['twitch_event', 'alert'] }, $nor: [{ kind: 'twitch_event', reason: 'handler_error' }] } },
            { $sort: { at: -1 } },
            { $group: { _id: { kind: '$kind', name: '$name' }, lastAt: { $first: '$at' }, outcome: { $first: '$outcome' }, reason: { $first: '$reason' }, received7d: inWeek } }
        ]).hint(CHANNEL_ACTIVITY_INDEX).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.find({ channelID, kind: 'system', name: 'eventsub.revoked', at: { $gte: since, $lte: now } })
            .sort({ at: -1 }).hint(CHANNEL_ACTIVITY_INDEX).limit(REVOKED_READ).select('at reason data').maxTimeMS(QUERY_MS).lean(),
        deadDeliveriesByType(channelID, since)
    ]);
    const received: ReceivedRow[] = [
        ...journal.map(row => ({ type: twitchTypeOf(row._id.type, row._id.original), lastAt: row.lastAt, received7d: row.received7d })),
        ...activity.filter(row => row._id.kind === 'twitch_event').map(row => ({ type: row._id.name, lastAt: row.lastAt, received7d: row.received7d }))
    ];
    const alerts: AlertRow[] = activity.filter(row => row._id.kind === 'alert')
        .map(row => ({ type: row._id.name, at: row.lastAt, outcome: row.outcome, reason: row.reason }));
    return {
        types: mergeEventsubActivity(received, alerts, failed),
        revoked: revoked.map(row => ({
            at: new Date(row.at).toISOString(),
            type: typeof row.data?.type === 'string' && row.data.type ? row.data.type : 'unknown',
            reason: row.reason || null
        }))
    };
}
