import { AdminRequestError, decodeCursor, encodeCursor } from '../../routes/admin_site/shared.js';
import { compareFeedItems, localBound, type FeedSource } from './source.js';
import { FEED_KINDS, type FeedFilters, type FeedItem, type FeedKind, type FeedKindCount, type FeedPage, type FeedSummary } from './types.js';

export interface FeedEngineOptions {
    /** Channel id → login, once per page. */
    channelLogins: (ids: string[]) => Promise<Map<string, string>>;
    /** Per source: the database gets `maxTimeMS`, the source as a whole gets `timeoutMs` before it is left out. */
    maxTimeMS?: number;
    timeoutMs?: number;
    now?: () => Date;
}

export const MAX_FEED_LIMIT = 100;
const CURSOR_ID = /^[a-z_]{1,20}:./;

/** Runs `task` but gives up after `ms`; the database stops its own query through `maxTimeMS`. */
function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        Promise.resolve().then(task),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('source timed out')), ms); timer.unref?.(); })
    ]).finally(() => clearTimeout(timer));
}

export function parseFeedCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
    const parsed = decodeCursor(cursor);
    if (parsed && !CURSOR_ID.test(parsed.id)) throw new AdminRequestError('Invalid cursor');
    return parsed;
}

const orderedKinds = (kinds: Iterable<FeedKind>): FeedKind[] => {
    const set = new Set(kinds);
    return FEED_KINDS.filter(kind => set.has(kind));
};

export function createFeed(sources: readonly FeedSource[], options: FeedEngineOptions) {
    const maxTimeMS = options.maxTimeMS ?? 3000;
    const timeoutMs = options.timeoutMs ?? 4000;
    const now = options.now ?? (() => new Date());

    async function list(filters: FeedFilters, cursor: string | undefined, limit: number): Promise<FeedPage> {
        const position = parseFeedCursor(cursor);
        const size = Math.min(MAX_FEED_LIMIT, Math.max(1, Math.floor(limit) || 1));
        if (filters.from.getTime() >= filters.to.getTime()) return { items: [], nextCursor: null, partial: [] };
        const at = now();
        const planned = sources.map(source => ({ source, kinds: source.plan(filters) })).filter(entry => entry.kinds.length);

        // Each source gives its newest size + 1 rows after the cursor: the page's `size` rows are among them,
        // and one more row anywhere means there is a next page.
        const results = await Promise.allSettled(planned.map(({ source, kinds }) => withTimeout(() => source.list({
            filters, kinds, bound: localBound(source.prefix, position), limit: size + 1, now: at, maxTimeMS
        }), timeoutMs)));

        const partial = new Set<FeedKind>(sources.flatMap(source => source.gaps?.(filters) ?? []));
        const merged: FeedItem[] = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') merged.push(...result.value);
            else for (const kind of planned[index].kinds) partial.add(kind);
        });
        merged.sort(compareFeedItems);
        const page = merged.slice(0, size);
        const last = page.at(-1);
        const nextCursor = merged.length > size && last ? encodeCursor({ at: new Date(last.at), id: last.id }) : null;

        const channelIDs = [...new Set(page.map(item => item.channelID).filter((id): id is string => !!id))];
        const logins = channelIDs.length
            ? await withTimeout(() => options.channelLogins(channelIDs), timeoutMs).catch(() => new Map<string, string>())
            : new Map<string, string>();
        const items = page.map(item => ({ ...item, channel: (item.channelID && logins.get(item.channelID)) || item.channel }));
        return { items, nextCursor, partial: orderedKinds(partial) };
    }

    async function summarize(input: FeedFilters): Promise<FeedSummary> {
        const filters: FeedFilters = { ...input, kinds: undefined, outcome: undefined };
        const counts = new Map<FeedKind, FeedKindCount>(FEED_KINDS.map(kind => [kind, { kind, total: 0, problems: 0, failed: 0 }]));
        const partial = new Set<FeedKind>(sources.flatMap(source => source.gaps?.(filters) ?? []));
        if (filters.from.getTime() < filters.to.getTime()) {
            const at = now();
            const planned = sources.map(source => ({ source, kinds: source.plan(filters) })).filter(entry => entry.kinds.length);
            const results = await Promise.allSettled(planned.map(({ source, kinds }) =>
                withTimeout(() => source.count({ filters, kinds, now: at, maxTimeMS }), timeoutMs)));
            results.forEach((result, index) => {
                if (result.status === 'rejected') { for (const kind of planned[index].kinds) partial.add(kind); return; }
                for (const row of result.value) {
                    const total = counts.get(row.kind);
                    if (!total) continue;
                    total.total += row.total;
                    total.problems += row.problems;
                    total.failed += row.failed;
                }
            });
        }
        return { from: filters.from.toISOString(), to: filters.to.toISOString(), kinds: [...counts.values()], partial: orderedKinds(partial) };
    }

    return { list, summarize };
}
