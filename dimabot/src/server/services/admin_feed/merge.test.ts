import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdminRequestError, encodeCursor } from '../../routes/admin_site/shared.js';
import { createFeed } from './merge.js';
import { afterBound, compareFeedItems, localBound, type FeedSource } from './source.js';
import type { FeedFilters, FeedItem, FeedKind } from './types.js';

const from = new Date('2026-11-01T00:00:00.000Z');
const to = new Date('2026-11-08T00:00:00.000Z');
const filters: FeedFilters = { from, to };

const item = (prefix: string, localId: string, at: number, kind: FeedKind = 'command', channelID: string | null = '1'): FeedItem => ({
    id: `${prefix}:${localId}`, at: new Date(at).toISOString(), kind, name: 'x', outcome: 'ok', reason: null, channelID, channel: null,
    actor: null, text: null, credits: null, providerUSD: null, durationMs: null, data: {}, ref: null
});

/** A store in memory that pages exactly like the Mongo sources: window, bound, local order, limit. */
function fakeSource(prefix: string, kinds: FeedKind[], rows: FeedItem[], behaviour: { fail?: boolean; hang?: boolean } = {}): FeedSource & { calls: number } {
    const source = {
        prefix,
        calls: 0,
        plan: (f: FeedFilters) => kinds.filter(kind => !f.kinds?.length || f.kinds.includes(kind)),
        async list({ bound, limit }: { bound?: ReturnType<typeof localBound>; limit: number }) {
            source.calls++;
            if (behaviour.fail) throw new Error('store down');
            if (behaviour.hang) return new Promise<FeedItem[]>(() => undefined);
            return rows
                .filter(row => Date.parse(row.at) >= from.getTime() && Date.parse(row.at) < to.getTime())
                .filter(row => afterBound(bound, Date.parse(row.at), row.id.slice(prefix.length + 1)))
                .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1))
                .slice(0, limit);
        },
        async count() {
            if (behaviour.fail) throw new Error('store down');
            return kinds.map(kind => ({ kind, total: rows.filter(row => row.kind === kind).length, problems: 0, failed: 0 }));
        }
    };
    return source as FeedSource & { calls: number };
}

const noLogins = async () => new Map<string, string>();

async function pageThrough(feed: ReturnType<typeof createFeed>, limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
        const page = await feed.list(filters, cursor, limit);
        ids.push(...page.items.map(entry => entry.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
        assert.ok(pages < 1000, 'paging must end');
    } while (cursor);
    return { ids, pages };
}

describe('localBound', () => {
    const at = new Date('2026-11-02T00:00:00.000Z');
    it('resumes inside the source that owns the cursor', () => {
        assert.deepEqual(localBound('event', { at, id: 'event:abc' }), { at, mode: 'tie', localId: 'abc' });
    });
    it('keeps or skips a whole millisecond of the other sources by prefix order', () => {
        // 'activity:' < 'event:…' so activity rows at that millisecond sort below the cursor: keep them.
        assert.equal(localBound('activity', { at, id: 'event:abc' })?.mode, 'through');
        assert.equal(localBound('usage', { at, id: 'event:abc' })?.mode, 'before');
        // A prefix that is itself a prefix of another source's name.
        assert.equal(localBound('doc', { at, id: 'docs:1' })?.mode, 'through');
        assert.equal(localBound('docs', { at, id: 'doc:1' })?.mode, 'before');
    });
});

describe('feed merge', () => {
    it('pages through every row once, in order, with ties across sources and a tiny page size', async () => {
        const base = from.getTime() + 3_600_000;
        let seed = 7;
        const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const make = (prefix: string, count: number) => Array.from({ length: count }, (_, index) =>
            // Twelve distinct milliseconds for 110 rows: most rows tie with rows of other sources.
            item(prefix, `${String(Math.floor(random() * 1e6)).padStart(6, '0')}-${index}`, base + Math.floor(random() * 12)));
        const rows = { activity: make('activity', 40), event: make('event', 30), decision: make('decision', 25), usage: make('usage', 15) };
        // Rows outside the window must never appear.
        rows.activity.push(item('activity', 'old', from.getTime() - 1), item('activity', 'late', to.getTime()));
        const sources = Object.entries(rows).map(([prefix, list]) => fakeSource(prefix, ['command'], list));
        const expected = Object.values(rows).flat()
            .filter(row => Date.parse(row.at) >= from.getTime() && Date.parse(row.at) < to.getTime())
            .sort(compareFeedItems).map(row => row.id);

        for (const limit of [1, 2, 3, 7, 40, 100]) {
            const { ids, pages } = await pageThrough(createFeed(sources, { channelLogins: noLogins }), limit);
            assert.deepEqual(ids, expected, `limit ${limit}`);
            assert.equal(new Set(ids).size, ids.length, 'no duplicates');
            assert.equal(pages, Math.max(1, Math.ceil(expected.length / limit)), `pages for limit ${limit}`);
        }
    });

    it('ends with a null cursor when the sources run out exactly at a page boundary', async () => {
        const feed = createFeed([fakeSource('a', ['command'], [item('a', '1', from.getTime() + 2), item('a', '2', from.getTime() + 1)])], { channelLogins: noLogins });
        const page = await feed.list(filters, undefined, 2);
        assert.equal(page.items.length, 2);
        assert.equal(page.nextCursor, null);
        assert.notEqual((await feed.list(filters, undefined, 1)).nextCursor, null);
    });

    it('leaves a failing or hanging store out and names its kinds in partial', async () => {
        const good = fakeSource('activity', ['command', 'alert'], [item('activity', '1', from.getTime() + 5)]);
        const broken = fakeSource('decision', ['protection'], [], { fail: true });
        const slow = fakeSource('usage', ['voice', 'ai'], [], { hang: true });
        const feed = createFeed([good, broken, slow], { channelLogins: noLogins, timeoutMs: 50 });
        const page = await feed.list(filters, undefined, 10);
        assert.deepEqual(page.items.map(entry => entry.id), ['activity:1']);
        assert.deepEqual(page.partial, ['protection', 'voice', 'ai']);

        const summary = await feed.summarize(filters);
        assert.deepEqual(summary.partial, ['protection']);
        assert.equal(summary.kinds.find(row => row.kind === 'command')?.total, 1);
        assert.equal(summary.kinds.length, 12);
    });

    it('lists the kinds a store cannot search in partial, for pages and summaries', async () => {
        const searchable = fakeSource('activity', ['command'], [item('activity', '1', from.getTime() + 5)]);
        const blind = { ...fakeSource('usage', ['voice', 'ai'], []), plan: () => [], gaps: (f: FeedFilters) => f.actorLogin ? ['voice', 'ai'] as FeedKind[] : [] };
        const feed = createFeed([searchable, blind], { channelLogins: noLogins });
        assert.deepEqual((await feed.list({ ...filters, actorLogin: 'v' }, undefined, 10)).partial, ['voice', 'ai']);
        assert.deepEqual((await feed.summarize({ ...filters, actorLogin: 'v' })).partial, ['voice', 'ai']);
        assert.deepEqual((await feed.list(filters, undefined, 10)).partial, []);
    });

    it('runs only the sources that serve the requested kinds', async () => {
        const commands = fakeSource('activity', ['command'], [item('activity', '1', from.getTime() + 5)]);
        const decisions = fakeSource('decision', ['protection'], [item('decision', '1', from.getTime() + 6, 'protection')]);
        const feed = createFeed([commands, decisions], { channelLogins: noLogins });
        const page = await feed.list({ ...filters, kinds: ['protection'] }, undefined, 10);
        assert.deepEqual(page.items.map(entry => entry.id), ['decision:1']);
        assert.equal(commands.calls, 0);
    });

    it('names channels once per page and survives a failed lookup', async () => {
        let lookups = 0;
        const rows = [item('a', '1', from.getTime() + 2, 'command', '10'), item('a', '2', from.getTime() + 1, 'command', '10'), item('a', '3', from.getTime(), 'command', null)];
        const feed = createFeed([fakeSource('a', ['command'], rows)], {
            channelLogins: async ids => { lookups++; assert.deepEqual(ids, ['10']); return new Map([['10', 'streamer']]); }
        });
        const page = await feed.list(filters, undefined, 10);
        assert.equal(lookups, 1);
        assert.deepEqual(page.items.map(entry => entry.channel), ['streamer', 'streamer', null]);

        const failing = createFeed([fakeSource('a', ['command'], rows)], { channelLogins: async () => { throw new Error('down'); } });
        assert.deepEqual((await failing.list(filters, undefined, 10)).items.map(entry => entry.channel), [null, null, null]);
    });

    it('refuses a cursor it did not make', async () => {
        const feed = createFeed([], { channelLogins: noLogins });
        const bad = (cursor: string) => assert.rejects(feed.list(filters, cursor, 10), (error: unknown) => error instanceof AdminRequestError && error.status === 400);
        await bad('not-a-cursor');
        await bad(Buffer.from('[1,2]').toString('base64url'));
        await bad(encodeCursor({ at: new Date(), id: 'no-prefix' }));
        await bad(encodeCursor({ at: new Date(), id: 'Event:1' }));
    });

    it('returns nothing for an empty window', async () => {
        const feed = createFeed([fakeSource('a', ['command'], [item('a', '1', from.getTime())])], { channelLogins: noLogins });
        assert.deepEqual(await feed.list({ from: to, to: from }, undefined, 10), { items: [], nextCursor: null, partial: [] });
    });
});
