import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdminRequestError, encodeCursor } from '../routes/admin_site/shared.js';
import {
    decodeSkipCursor, encodeSkipCursor, grantMatch, parseUsageFilters, parseUsageTransactionQuery, roundUSD, safeCategory,
    shapeSummary, shapeTransaction, summaryPipeline, transactionMatch, usageMatch, utcDays, type SummaryFacets
} from './admin_usage.service.js';

const now = new Date('2026-11-13T12:00:00.000Z');
const rejects = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof AdminRequestError && error.status === 400);

describe('admin usage filters', () => {
    it('defaults to the last 7 days and no filters', () => {
        const filters = parseUsageFilters({}, now);
        assert.equal(filters.range.to.toISOString(), now.toISOString());
        assert.equal(filters.range.from.toISOString(), '2026-11-06T12:00:00.000Z');
        assert.deepEqual([filters.channel, filters.actor, filters.category, filters.provider, filters.model, filters.source], Array(6).fill(undefined));
    });

    it('accepts exact values and refuses anything else', () => {
        const filters = parseUsageFilters({ channel: '123', actor: '456', category: 'tts', provider: 'fish', model: 'deepseek/deepseek-v4.1-flash', source: 'ast' }, now);
        assert.deepEqual({ ...filters, range: undefined }, { range: undefined, channel: '123', actor: '456', category: 'tts', provider: 'fish', model: 'deepseek/deepseek-v4.1-flash', source: 'ast' });
        rejects(() => parseUsageFilters({ category: { $ne: 'tts' } }, now));
        rejects(() => parseUsageFilters({ category: ['tts', 'memory'] }, now));
        rejects(() => parseUsageFilters({ category: 'credit_adjustment' }, now));
        rejects(() => parseUsageFilters({ channel: 'abc' }, now));
        rejects(() => parseUsageFilters({ actor: '12a' }, now));
        rejects(() => parseUsageFilters({ model: '.*' }, now));
        rejects(() => parseUsageFilters({ provider: 'a'.repeat(101) }, now));
    });

    it('caps the window at 90 days', () => {
        const filters = parseUsageFilters({ from: '2026-08-15T12:00:00Z', to: '2026-11-13T12:00:00Z' }, now);
        assert.equal(filters.range.from.toISOString(), '2026-08-15T12:00:00.000Z');
        rejects(() => parseUsageFilters({ from: '2026-08-01T00:00:00Z', to: '2026-11-13T00:00:00Z' }, now));
        rejects(() => parseUsageFilters({ from: '2026-11-13T00:00:00Z', to: '2026-11-12T00:00:00Z' }, now));
    });

    it('builds an exact-match filter that hides expired rows', () => {
        const filters = parseUsageFilters({ channel: '1', actor: '2', category: 'memory', provider: 'openrouter', model: 'm', source: 'chat' }, now);
        assert.deepEqual(usageMatch(filters, now), {
            occurredAt: { $gte: filters.range.from, $lt: filters.range.to }, expiresAt: { $gt: now },
            channelID: '1', actorId: { $eq: '2', $type: 'string' }, category: 'memory', provider: 'openrouter', model: 'm', source: 'chat'
        });
        assert.deepEqual(usageMatch(parseUsageFilters({ source: 'unknown' }, now), now).source, { $in: [null, 'unknown'] });
    });

    it('narrows grants by channel and window only', () => {
        const filters = parseUsageFilters({ channel: '1', category: 'tts', actor: '2' }, now);
        assert.deepEqual(grantMatch(filters, now), {
            occurredAt: { $gte: filters.range.from, $lt: filters.range.to }, expiresAt: { $gt: now }, channelID: '1', credits: { $lt: 0 }
        });
    });

    it('counts usage rows only in the summary', () => {
        const [match] = summaryPipeline(parseUsageFilters({}, now), now) as Array<{ $match: Record<string, unknown> }>;
        assert.equal(match.$match.entryKind, 'usage');
    });
});

describe('admin usage transaction query', () => {
    it('defaults to usage, newest first, 40 rows', () => {
        const input = parseUsageTransactionQuery({}, now);
        assert.deepEqual([input.entryKind, input.sort, input.limit, input.position], ['usage', 'newest', 40, undefined]);
        assert.equal(transactionMatch(input, now).entryKind, 'usage');
        assert.equal('entryKind' in transactionMatch(parseUsageTransactionQuery({ entryKind: 'all' }, now), now), false);
        assert.equal(transactionMatch(parseUsageTransactionQuery({ entryKind: 'adjustment' }, now), now).entryKind, 'adjustment');
    });

    it('bounds limit and enums', () => {
        assert.equal(parseUsageTransactionQuery({ limit: '100' }, now).limit, 100);
        for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { sort: 'oldest' }, { entryKind: 'other' }, { entryKind: { $ne: 'usage' } }]) {
            rejects(() => parseUsageTransactionQuery(query, now));
        }
    });

    it('continues after the time cursor', () => {
        const at = new Date('2026-11-12T00:00:00.000Z');
        const input = parseUsageTransactionQuery({ cursor: encodeCursor({ at, id: 'e9' }) }, now);
        assert.deepEqual(input.position, { kind: 'time', at, id: 'e9' });
        assert.deepEqual(transactionMatch(input, now).$or, [{ occurredAt: { $lt: at } }, { occurredAt: at, entryId: { $lt: 'e9' } }]);
    });

    it('pages the credits sort by offset, at most 500 rows deep', () => {
        assert.equal(decodeSkipCursor(encodeSkipCursor(40)), 40);
        assert.deepEqual(parseUsageTransactionQuery({ sort: 'credits', cursor: encodeSkipCursor(80) }, now).position, { kind: 'skip', skip: 80 });
        assert.equal('$or' in transactionMatch(parseUsageTransactionQuery({ sort: 'credits', cursor: encodeSkipCursor(80) }, now), now), false);
        rejects(() => decodeSkipCursor(encodeSkipCursor(500)));
        rejects(() => decodeSkipCursor(encodeSkipCursor(0)));
        rejects(() => decodeSkipCursor('not-a-cursor'));
        // A cursor from one sort is refused by the other.
        rejects(() => parseUsageTransactionQuery({ sort: 'credits', cursor: encodeCursor({ at: now, id: 'e1' }) }, now));
        rejects(() => parseUsageTransactionQuery({ cursor: encodeSkipCursor(40) }, now));
        rejects(() => parseUsageTransactionQuery({ cursor: ['a', 'b'] }, now));
    });
});

describe('admin usage shaping', () => {
    it('lists every UTC day the range touches', () => {
        assert.deepEqual(utcDays({ from: new Date('2026-11-10T22:00:00Z'), to: new Date('2026-11-12T01:00:00Z') }), ['2026-11-10', '2026-11-11', '2026-11-12']);
        assert.deepEqual(utcDays({ from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-12T00:00:00Z') }), ['2026-11-10', '2026-11-11']);
        assert.equal(utcDays({ from: new Date('2026-08-15T12:00:00Z'), to: new Date('2026-11-13T12:00:00Z') }).length, 91);
    });

    it('rounds float noise out of provider costs', () => {
        assert.equal(roundUSD(0.1 + 0.2), 0.3);
        assert.equal(roundUSD(0.00004 + 0.00002), 0.00006);
        assert.equal(safeCategory('weird'), 'uncategorized');
        assert.equal(safeCategory('credit_adjustment'), 'uncategorized');
    });

    it('shapes the summary with zero days, names and tiers', () => {
        const facets: SummaryFacets = {
            totals: [{ count: 3, credits: 300, providerUSD: 0.1 + 0.2, providerKnown: 2 }],
            channels: [{ n: 2 }], chatters: [], withActor: [],
            byCategory: [{ _id: 'tts', count: 2, credits: 200 }, { _id: 'odd', count: 1, credits: 50 }, { _id: 'uncategorized', count: 1, credits: 50 }],
            byModel: [{ _id: { category: 'tts', provider: 'fish' }, count: 2, credits: 200 }],
            bySource: [{ _id: { category: 'tts', source: null }, count: 2, credits: 200 }],
            byChannel: [{ _id: '1', count: 2, credits: 200 }, { _id: '2', count: 1, credits: 100 }],
            byActor: [{ _id: '9', count: 1, credits: 10, latest: { login: 'viewer', name: null } }],
            daily: [{ _id: '2026-11-11', count: 3, credits: 300, providerUSD: 0.3 }]
        };
        const summary = shapeSummary({ range: { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-12T12:00:00Z') }, facets, granted: 5000,
            logins: new Map([['1', 'alpha']]), tiers: new Map([['1', 'pro']]) });
        assert.deepEqual(summary.totals, { count: 3, credits: 300, providerUSD: 0.3, providerKnown: 2, channels: 2, chatters: 0, withActor: 0 });
        assert.deepEqual(summary.byCategory.map(row => [row.category, row.count, row.credits]), [['tts', 2, 200], ['uncategorized', 2, 100]]);
        assert.deepEqual(summary.byModel[0], { count: 2, credits: 200, providerUSD: 0, providerKnown: 0, category: 'tts', provider: 'fish', model: null });
        assert.equal(summary.bySource[0].source, 'unknown');
        assert.deepEqual(summary.byChannel.map(row => [row.channel, row.planTier]), [['alpha', 'pro'], [null, null]]);
        assert.deepEqual(summary.byActor[0].actor, { id: '9', login: 'viewer', name: null });
        assert.deepEqual(summary.daily, [
            { date: '2026-11-10', count: 0, credits: 0, providerUSD: 0 },
            { date: '2026-11-11', count: 3, credits: 300, providerUSD: 0.3 },
            { date: '2026-11-12', count: 0, credits: 0, providerUSD: 0 }
        ]);
        assert.equal(summary.granted, 5000);
    });

    it('shapes a transaction without internals and treats missing like null', () => {
        const base = { entryId: 'e1', occurredAt: now, channelID: '1', entryKind: 'usage' as const, category: 'tts', operation: 'synthesize',
            provider: 'fish', model: null, quantity: 49, unit: 'characters', credits: 74 };
        const legacy = shapeTransaction({ ...base, source: 'ast' } as never, new Map([['1', 'alpha']]));
        assert.deepEqual(legacy, { id: 'e1', at: now.toISOString(), channelID: '1', channel: 'alpha', entryKind: 'usage', category: 'tts',
            operation: 'synthesize', source: 'ast', adjustmentType: null, provider: 'fish', model: null, voice: null, quantity: 49,
            unit: 'characters', credits: 74, providerUSD: null, actor: null });
        const recorded = shapeTransaction({ ...base, source: 'ast', voice: 'v1', costUsd: 0.0012, actorId: '9', actorLogin: 'viewer', actorName: 'Viewer',
            customerId: 'SECRET-polar' } as never, new Map());
        assert.deepEqual([recorded.voice, recorded.providerUSD, recorded.actor, recorded.channel], ['v1', 0.0012, { id: '9', login: 'viewer', name: 'Viewer' }, null]);
        assert.equal(JSON.stringify(recorded).includes('SECRET'), false);
        const grant = shapeTransaction({ ...base, entryKind: 'adjustment', category: 'credit_adjustment', source: 'admin_credit_grant', credits: -5000,
            provider: 'polar', unit: null, quantity: null } as never, new Map());
        assert.deepEqual([grant.category, grant.adjustmentType, grant.credits, grant.unit], ['credit_adjustment', 'manual_grant', -5000, null]);
    });
});
