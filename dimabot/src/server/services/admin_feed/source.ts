import type { Collection } from 'mongoose';
import type { FeedActor, FeedFilters, FeedItem, FeedKind, FeedKindCount } from './types.js';

/**
 * What every feed source (one store each) implements, plus the paging rules they share.
 *
 * The feed is ordered newest first by `(at, id)`, where `id` is the item's full `<prefix>:<localId>`.
 * A source keeps its rows in an index sorted by `(time, localId)`, so within one source that order is
 * the feed order. The cursor is the `(at, id)` of the last item shown; `localBound` turns it into
 * "where to resume" for each source, so rows that share a millisecond across sources appear exactly once.
 */
export interface LocalBound {
    at: Date;
    /**
     * before: only rows older than `at` (this source's rows at `at` sort above the cursor, already shown).
     * through: rows at `at` too (they all sort below the cursor).
     * tie: rows at `at` only when their local id sorts below `localId` (the cursor is one of this source's rows).
     */
    mode: 'before' | 'through' | 'tie';
    localId?: string;
}

export function localBound(prefix: string, cursor: { at: Date; id: string } | undefined): LocalBound | undefined {
    if (!cursor) return undefined;
    const head = `${prefix}:`;
    if (cursor.id.startsWith(head)) return { at: cursor.at, mode: 'tie', localId: cursor.id.slice(head.length) };
    // `head + x` and the cursor id differ within the first head.length characters, so every row of this
    // source at the cursor's millisecond sorts on the same side of it.
    return { at: cursor.at, mode: head < cursor.id.slice(0, head.length) ? 'through' : 'before' };
}

/** True when a row at (`at`, `localId`) comes after the bound in feed order (newest first). */
export function afterBound(bound: LocalBound | undefined, at: number, localId: string): boolean {
    if (!bound) return true;
    const edge = bound.at.getTime();
    if (at !== edge) return at < edge;
    if (bound.mode === 'through') return true;
    if (bound.mode === 'before') return false;
    return localId < (bound.localId as string);
}

/** Newest first, ties by id: the one total order of the feed. */
export const compareFeedItems = (a: Pick<FeedItem, 'at' | 'id'>, b: Pick<FeedItem, 'at' | 'id'>): number => {
    const time = Date.parse(b.at) - Date.parse(a.at);
    if (time) return time;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

export interface SourceListQuery {
    filters: FeedFilters;
    /** The kinds this source must return: what `plan` gave for these filters. */
    kinds: FeedKind[];
    bound?: LocalBound;
    limit: number;
    now: Date;
    maxTimeMS: number;
}

export interface SourceCountQuery {
    filters: FeedFilters;
    kinds: FeedKind[];
    now: Date;
    maxTimeMS: number;
}

export interface FeedSource {
    /** Id prefix of its items: `<prefix>:<localId>`. */
    prefix: string;
    /**
     * The kinds this source serves for these filters; empty = do not run it. A source that holds only
     * successes returns nothing for an outcome filter; one that cannot find a chatter cheaply returns
     * nothing for an actor filter.
     */
    plan(filters: FeedFilters): FeedKind[];
    /**
     * Requested kinds whose rows this source may hold but cannot search for these filters (a chatter by
     * login where the login has no index or was not always stored). They are reported in `partial`, so
     * a gap is never silent.
     */
    gaps?(filters: FeedFilters): FeedKind[];
    /** Its newest `limit` rows after the bound, in feed order. */
    list(query: SourceListQuery): Promise<FeedItem[]>;
    /** One count per kind in `kinds` (zeros included). */
    count(query: SourceCountQuery): Promise<FeedKindCount[]>;
}

/** Login only: the route could not turn the login into a Twitch id. */
export const loginOnly = (filters: FeedFilters): boolean => !filters.actorID && !!filters.actorLogin;

/** The kinds a source serves: the requested ones it can produce (all of them without a kind filter). */
export const servedKinds = (filters: FeedFilters, own: readonly FeedKind[]): FeedKind[] =>
    own.filter(kind => !filters.kinds?.length || filters.kinds.includes(kind));

export const emptyCounts = (kinds: readonly FeedKind[]): Map<FeedKind, FeedKindCount> =>
    new Map(kinds.map(kind => [kind, { kind, total: 0, problems: 0, failed: 0 }]));

/**
 * One page of a Mongo collection in feed order: `timeField` desc, `idField` desc, inside the window and
 * after the bound. A tie bound runs as two plain index ranges (the cursor's millisecond, then older)
 * rather than one `$or`, so each half keeps the index order and no blocking sort is needed.
 */
type Document = Record<string, any>;

export async function mongoPage(
    collection: Collection,
    filter: Document,
    options: {
        timeField: string; idField: string; from: Date; to: Date; bound?: LocalBound; limit: number;
        maxTimeMS: number; projection?: Document; toDbId?: (localId: string) => unknown;
    }
): Promise<Document[]> {
    const { timeField, idField, from, to, bound, limit, maxTimeMS, projection } = options;
    const sort = { [timeField]: -1, [idField]: -1 } as const;
    const run = (query: Document, count: number) => collection.find(query, { sort, limit: count, maxTimeMS, ...(projection ? { projection } : {}) }).toArray();
    const range = (upper: Document) => ({ ...filter, [timeField]: { $gte: from, ...upper } });

    if (!bound) return run(range({ $lt: to }), limit);
    const edge = bound.at;
    if (bound.mode === 'through') return run(range(edge < to ? { $lte: edge } : { $lt: to }), limit);
    const older = range({ $lt: edge < to ? edge : to });
    if (bound.mode === 'before' || edge < from || edge >= to) return run(older, limit);

    const toDbId = options.toDbId || ((id: string) => id);
    const ties = await run({ ...filter, [timeField]: edge, [idField]: { $lt: toDbId(bound.localId as string) } }, limit);
    if (ties.length >= limit) return ties;
    return [...ties, ...await run(older, limit - ties.length)];
}

// ---- Small shaping helpers shared by the sources. ----

/** Clip to `max` characters without splitting an emoji; null for empty. */
export function clipText(value: unknown, max = 300): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    if (text.length <= max) return text;
    return Array.from(text.slice(0, max * 2)).slice(0, max).join('');
}

export const str = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;
export const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function actorOf(id: unknown, login: unknown, name: unknown): FeedActor | null {
    const actor = { id: str(id), login: str(login)?.toLowerCase() ?? null, name: str(name) };
    return actor.id || actor.login || actor.name ? actor : null;
}

/** Keeps only flat values; drops nulls and empty strings so the detail view shows facts, not blanks. */
export function flatData(input: Record<string, unknown>): FeedItem['data'] {
    const out: FeedItem['data'] = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') { if (value !== '') out[key] = value.length > 200 ? clipText(value, 200) : value; }
        else if (typeof value === 'number') { if (Number.isFinite(value)) out[key] = value; }
        else if (typeof value === 'boolean') out[key] = value;
    }
    return out;
}

/** A domain event key: three `encodeURIComponent` parts joined by ':'. */
export const EVENT_KEY_PATTERN = /^[A-Za-z0-9\-_.!~*'()%]+:[A-Za-z0-9\-_.!~*'()%]+:[A-Za-z0-9\-_.!~*'()%]+$/;
export const isEventKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 400 && EVENT_KEY_PATTERN.test(value);
