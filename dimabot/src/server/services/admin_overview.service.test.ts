import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FeedItem, FeedPage, FeedSummary } from './admin_feed/index.js';
import type { OverviewDeps, OverviewFragment, OverviewLoaders } from './admin_overview.service.js';

// The service's imports reach modules that refuse to load without these.
process.env.SECRET_KEY ??= 'overview-test-secret';
const {
    buildOverview, computeOverview, createOverviewService, overviewWindows, rankChannels, receiptFeature, SPEND_FEATURES
} = await import('./admin_overview.service.js');

const now = new Date('2026-11-13T12:00:00.000Z');
const windows = overviewWindows(now);

const item = (id: string): FeedItem => ({
    id, at: now.toISOString(), kind: 'command', name: '!so', outcome: 'ok', reason: null, channelID: '1', channel: null,
    actor: null, text: null, credits: null, providerUSD: null, durationMs: null, data: {}, ref: null
});
const summary: FeedSummary = {
    from: windows.dayFrom.toISOString(), to: now.toISOString(), partial: [],
    kinds: [{ kind: 'command', total: 10, problems: 3, failed: 2 }, { kind: 'voice', total: 4, problems: 1, failed: 1 }]
};
const page: FeedPage = { items: Array.from({ length: 12 }, (_, index) => item(`activity:${index}`)), nextCursor: null, partial: [] };

const fragments: Record<keyof OverviewLoaders, OverviewFragment> = {
    activity: {
        daily: { '2026-11-13': { events: 5, problems: 2 }, '2026-11-01': { events: 99 } },
        channels: { '111': { events: 5, problems: 2 }, '': { events: 7 } },
        features: { voice: { failed: 1 } }
    },
    usage: {
        daily: { '2026-11-13': { events: 3, credits: 50_000, providerUSD: 0.01 } },
        channels: { '222': { events: 9, credits: 50_000 } },
        day: { credits: 50_000, providerUSD: 0.01 },
        features: { voice: { count: 3, credits: 40_000, providerUSD: null }, other: { count: 1, credits: 10_000, providerUSD: 0.01 } }
    },
    decisions: {
        daily: { '2026-11-13': { events: 2, problems: 1, providerUSD: 0.002 } },
        channels: { '111': { events: 2, problems: 1 } },
        day: { providerUSD: 0.002 },
        features: { protection: { count: 2, failed: 1, credits: 0, providerUSD: 0.002 } }
    },
    assistant: { day: { providerUSD: 0.5 }, daily: { '2026-11-13': { providerUSD: 0.5 } }, features: { assistant: { count: 4, failed: 1, credits: 0, providerUSD: 0.5 } } },
    docs: { day: { providerUSD: 0.03 }, daily: { '2026-11-12': { providerUSD: 0.03 } }, features: { docs: { count: 2, failed: 0, credits: 0, providerUSD: 0.03 } } },
    attention: { attention: { verdicts_waiting: 3, dead_deliveries: 0, gifts_need_support: 1, usage_import_stuck: 0 } }
};

function deps(overrides: Partial<OverviewDeps> = {}, failing: Partial<Record<keyof OverviewLoaders, 'throw' | 'hang'>> = {}): Omit<OverviewDeps, 'cacheMs'> & { calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const loader = (name: keyof OverviewLoaders) => async () => {
        calls[name] = (calls[name] || 0) + 1;
        if (failing[name] === 'throw') throw new Error(`${name} down`);
        if (failing[name] === 'hang') return new Promise<OverviewFragment>(() => {});
        return fragments[name];
    };
    return {
        calls,
        listFeed: async () => page,
        summarizeFeed: async () => summary,
        channelLogins: async (ids) => new Map([...ids].filter(id => id === '111').map(id => [id, 'streamer_one'])),
        loaders: Object.fromEntries((Object.keys(fragments) as (keyof OverviewLoaders)[]).map(name => [name, loader(name)])) as unknown as OverviewLoaders,
        now: () => now,
        timeoutMs: 50,
        ...overrides
    };
}

describe('admin overview windows', () => {
    it('has 14 UTC days ending today and a 7-day feature window', () => {
        assert.equal(windows.days.length, 14);
        assert.equal(windows.days[0], '2026-10-31');
        assert.equal(windows.days.at(-1), '2026-11-13');
        assert.equal(windows.dailyFrom.toISOString(), '2026-10-31T00:00:00.000Z');
        assert.equal(windows.weekFrom.toISOString(), '2026-11-07T00:00:00.000Z');
        assert.equal(windows.dayFrom.toISOString(), '2026-11-12T12:00:00.000Z');
    });
});

describe('admin overview assembly', () => {
    it('adds every store into one answer', async () => {
        const overview = await computeOverview(deps());
        assert.deepEqual(overview.partial, []);
        assert.equal(overview.generatedAt, now.toISOString());
        assert.deepEqual(overview.day.kinds, summary.kinds);
        assert.equal(overview.day.credits, 50_000);
        assert.equal(overview.day.providerUSD, 0.542);
        assert.equal(overview.day.activeChannels, 2);
        assert.equal(overview.recent.length, 8);
        const today = overview.daily.at(-1)!;
        assert.deepEqual(today, { date: '2026-11-13', events: 10, problems: 3, credits: 50_000, providerUSD: 0.512 });
        assert.deepEqual(overview.daily.at(-2), { date: '2026-11-12', events: 0, problems: 0, credits: 0, providerUSD: 0.03 });
        assert.equal(overview.daily[0].date, '2026-10-31');
        assert.deepEqual(overview.daily[1], { date: '2026-11-01', events: 99, problems: 0, credits: 0, providerUSD: 0 });
        assert.deepEqual(overview.topChannels, [
            { channelID: '222', channel: null, events: 9, problems: 0, credits: 50_000 },
            { channelID: '111', channel: 'streamer_one', events: 7, problems: 3, credits: 0 }
        ]);
        assert.deepEqual(overview.attention, [
            { key: 'verdicts_waiting', count: 3 }, { key: 'failed_24h', count: 3 }, { key: 'gifts_need_support', count: 1 }
        ]);
    });

    it('lists every feature once, biggest spend first, null cost where nothing was recorded', async () => {
        const overview = await computeOverview(deps());
        assert.deepEqual(overview.features.map(row => row.feature), ['assistant', 'voice', 'other', 'docs', 'protection', 'ai_chat', 'memory']);
        assert.deepEqual(overview.features.find(row => row.feature === 'voice'), { feature: 'voice', count: 3, failed: 1, credits: 40_000, providerUSD: null });
        assert.equal(overview.features.find(row => row.feature === 'memory')!.providerUSD, null);
        assert.equal(overview.features.find(row => row.feature === 'protection')!.providerUSD, 0.002);
        assert.equal(overview.features.length, SPEND_FEATURES.length);
    });

    it('lists a failing part and keeps the rest', async () => {
        const overview = await computeOverview(deps({}, { decisions: 'throw', docs: 'hang' }));
        assert.deepEqual(overview.partial, ['decisions', 'docs']);
        assert.deepEqual(overview.features.find(row => row.feature === 'protection'), { feature: 'protection', count: 0, failed: 0, credits: 0, providerUSD: null });
        assert.equal(overview.features.find(row => row.feature === 'docs')!.count, 0);
        assert.equal(overview.day.providerUSD, 0.51);
        assert.equal(overview.day.credits, 50_000);
        assert.deepEqual(overview.topChannels.map(row => [row.channelID, row.events]), [['222', 9], ['111', 5]]);
    });

    it('answers without the feed', async () => {
        const overview = await computeOverview(deps({
            listFeed: async () => { throw new Error('listFeed is not implemented yet'); },
            summarizeFeed: async () => { throw new Error('summarizeFeed is not implemented yet'); }
        }));
        assert.deepEqual(overview.partial, ['feed']);
        assert.deepEqual(overview.day.kinds, []);
        assert.deepEqual(overview.recent, []);
        assert.equal(overview.attention.some(row => row.key === 'failed_24h'), false);
        assert.equal(overview.day.credits, 50_000);
    });

    it('lists the feed when it answered without some of its stores', async () => {
        const overview = await computeOverview(deps({ summarizeFeed: async () => ({ ...summary, partial: ['protection'] }) }));
        assert.deepEqual(overview.partial, ['feed']);
        assert.deepEqual(overview.day.kinds, summary.kinds);
    });

    it('keeps ids when channel names cannot be read', async () => {
        const overview = await computeOverview(deps({ channelLogins: async () => { throw new Error('users down'); } }));
        assert.deepEqual(overview.partial, []);
        assert.deepEqual(overview.topChannels.map(row => row.channel), [null, null]);
    });

    it('ranks at most 8 channels and drops rows with no channel id', () => {
        const channels = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(100 + index), { events: index }]));
        const ranked = rankChannels([{ channels: { ...channels, '': { events: 1000 }, 'global': { events: 1000 } } }]);
        assert.equal(ranked[0].channelID, '111');
        assert.equal(ranked.some(row => row.channelID === '100'), false, 'a channel with nothing is not active');
        const overview = buildOverview({ windows, kinds: [], recent: [], fragments: [{ channels }], partial: new Set() });
        assert.equal(overview.topChannels.length, 8);
        assert.equal(overview.day.activeChannels, 11);
    });
});

describe('admin overview cache', () => {
    it('reuses one answer for 15 seconds and shares one build between callers', async () => {
        let clock = now.getTime();
        const base = deps({ now: () => new Date(clock) });
        const service = createOverviewService({ ...base, cacheMs: 15_000 });
        const [first, second] = await Promise.all([service.get(), service.get()]);
        assert.equal(first, second);
        assert.equal(base.calls.usage, 1);
        clock += 14_000;
        assert.equal(await service.get(), first);
        assert.equal(base.calls.usage, 1);
        clock += 2_000;
        await service.get();
        assert.equal(base.calls.usage, 2);
    });
});

describe('receipt categories', () => {
    it('maps receipt categories to features', () => {
        assert.equal(receiptFeature('tts'), 'voice');
        assert.equal(receiptFeature('ai_chat'), 'ai_chat');
        assert.equal(receiptFeature('memory'), 'memory');
        for (const category of ['other', 'ai_agent', 'clip_recommendation', 'uncategorized', null]) assert.equal(receiptFeature(category), 'other');
    });
});
