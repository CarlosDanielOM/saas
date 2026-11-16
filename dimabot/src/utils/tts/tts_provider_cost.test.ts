import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    CLAIM_LEASE_MS, DELIVERY_RETRY_MS, LOOKUP_GIVE_UP_MS, LOOKUP_RETRY_MS, listPriceCostUsd, lookupOpenRouterGeneration,
    runTtsUsagePass, type GenerationLookup, type PendingTtsUsage, type TtsUsageDeliveryDependencies
} from './tts_provider_cost.js';

test('list prices are per million UTF-8 bytes', () => {
    // What OpenRouter charged for the probes: 4 and 41 bytes of Drama 3 at $10/M.
    assert.equal(listPriceCostUsd('fish', 'fish-audio/drama-3', 4), 0.00004);
    assert.equal(listPriceCostUsd('fish', 'fish-audio/drama-3', 41), 0.00041);
    assert.equal(listPriceCostUsd('fish', 's2.1-pro', 1_000_000), 15);
    assert.equal(listPriceCostUsd('kokoro', 'hexgrad/kokoro-82m', 1_000_000), 0.62);
    // An unknown model falls back to the provider's price.
    assert.equal(listPriceCostUsd('fish', 'fish', 100), 0.0015);
    assert.equal(listPriceCostUsd('fish', 'fish-audio/drama-3', -5), 0);
});

const response = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

test('the OpenRouter lookup reads total_cost and treats 404 as not recorded yet', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return response(200, { data: { total_cost: 0.00041 } }); }) as typeof fetch;
    assert.deepEqual(await lookupOpenRouterGeneration('gen-tts-1/x', { apiKey: 'key', fetchImpl }), { status: 'found', costUsd: 0.00041 });
    assert.equal(calls[0][0], 'https://openrouter.ai/api/v1/generation?id=gen-tts-1%2Fx');
    assert.equal((calls[0][1]?.headers as Record<string, string>).Authorization, 'Bearer key');

    assert.deepEqual(await lookupOpenRouterGeneration('g', { apiKey: 'key', fetchImpl: (async () => response(404, { error: {} })) as typeof fetch }), { status: 'pending' });
    assert.equal((await lookupOpenRouterGeneration('g', { apiKey: 'key', fetchImpl: (async () => response(502)) as typeof fetch })).status, 'failed');
    assert.equal((await lookupOpenRouterGeneration('g', { apiKey: 'key', fetchImpl: (async () => response(200, { data: {} })) as typeof fetch })).status, 'failed');
    assert.equal((await lookupOpenRouterGeneration('g', { apiKey: 'key', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch })).status, 'failed');
    assert.deepEqual(await lookupOpenRouterGeneration('g', { apiKey: ' ' }), { status: 'failed', message: 'OpenRouter API key is not configured' });
});

const NOW = Date.parse('2026-11-16T17:00:00.000Z');

function harness(rows: PendingTtsUsage[], lookups: Record<string, GenerationLookup>,
    sendResult: { recorded: boolean; queued?: boolean; message?: string } = { recorded: true },
    flushResult: { recorded: boolean; message?: string } = { recorded: true }) {
    const due = new Map(rows.map(row => [row.id, NOW]));
    const events: string[] = [];
    const sent: Array<{ entryId: string; costUsd: number }> = [];
    const deps: TtsUsageDeliveryDependencies = {
        async claimDue(now, leaseUntil) {
            const next = rows.find(row => (due.get(row.id) ?? Infinity) <= now.getTime());
            if (!next) return null;
            assert.equal(leaseUntil.getTime() - now.getTime(), CLAIM_LEASE_MS);
            due.set(next.id, leaseUntil.getTime());
            return next;
        },
        async reschedule(id, at, lastError) { due.set(id, at.getTime()); events.push(`reschedule ${id} +${at.getTime() - NOW} ${lastError ?? ''}`.trim()); },
        async markQueued(id, at, lastError) {
            const row = rows.find(item => item.id === id)!;
            row.queued = true; due.set(id, at.getTime()); events.push(`queued ${id} +${at.getTime() - NOW} ${lastError ?? ''}`.trim());
        },
        async remove(id) { due.delete(id); events.push(`remove ${id}`); },
        async flush(row) { events.push(`flush ${row.channelID}`); return flushResult; },
        async lookupGeneration(id) { return lookups[id] ?? { status: 'pending' }; },
        async send(row, costUsd) { sent.push({ entryId: row.entryId, costUsd }); return sendResult; },
        log: () => {},
        now: () => NOW,
    };
    return { deps, events, sent, due };
}

const row = (id: string, ageMs: number, generationId = `gen-${id}`): PendingTtsUsage => ({
    id, entryId: `entry-${id}`, channelID: '42', customerId: 'customer', provider: 'fish', backend: 'fish-audio/drama-3',
    generationId, bytes: 41, characters: 32, credits: 48, usage: { source: 'chat' }, occurredAt: new Date(NOW - ageMs), attempts: 1, queued: false
});

test('a line is sent with the real charge once OpenRouter has it, and removed', async () => {
    const { deps, events, sent } = harness([row('a', 40_000)], { 'gen-a': { status: 'found', costUsd: 0.00008 } });
    assert.deepEqual(await runTtsUsagePass(deps), { events: 1, failed: false, more: false });
    // A promotion shows up as a lower real charge; the credits stay as parked.
    assert.deepEqual(sent, [{ entryId: 'entry-a', costUsd: 0.00008 }]);
    assert.deepEqual(events, ['remove a']);
});

test('a line OpenRouter has not recorded yet waits, then falls back to the list price', async () => {
    const young = harness([row('b', 40_000)], {});
    assert.deepEqual(await runTtsUsagePass(young.deps), { events: 1, failed: false, more: false });
    assert.deepEqual(young.sent, []);
    assert.deepEqual(young.events, [`reschedule b +${LOOKUP_RETRY_MS}`]);

    const failing = harness([row('c', 40_000)], { 'gen-c': { status: 'failed', message: 'HTTP 502' } });
    assert.equal((await runTtsUsagePass(failing.deps)).failed, true);
    assert.deepEqual(failing.events, [`reschedule c +${LOOKUP_RETRY_MS} HTTP 502`]);

    const old = harness([row('d', LOOKUP_GIVE_UP_MS + 1)], {});
    await runTtsUsagePass(old.deps);
    assert.deepEqual(old.sent, [{ entryId: 'entry-d', costUsd: 0.00041 }]);
    assert.deepEqual(old.events, ['remove d']);
});

test('a line Polar did not take stays parked and is retried later', async () => {
    const { deps, events, sent } = harness([row('e', 40_000)], { 'gen-e': { status: 'found', costUsd: 0.00041 } }, { recorded: false, message: 'Polar down' });
    assert.deepEqual(await runTtsUsagePass(deps), { events: 1, failed: true, more: false });
    assert.equal(sent.length, 1);
    assert.deepEqual(events, [`reschedule e +${DELIVERY_RETRY_MS} Polar down`]);
});

test('a pass is bounded and reports that more lines are due', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => row(`r${index}`, 40_000));
    const lookups = Object.fromEntries(rows.map(item => [item.generationId, { status: 'found' as const, costUsd: 0.0001 }]));
    const { deps, sent } = harness(rows, lookups);
    assert.deepEqual(await runTtsUsagePass(deps, 3), { events: 3, failed: false, more: true });
    assert.deepEqual(await runTtsUsagePass(deps, 3), { events: 1, failed: false, more: false });
    assert.equal(sent.length, 4);
});

test('during a Polar outage the queued event is kept and flushed by the worker until Polar has it', async () => {
    const outage = harness([row('q', 40_000)], { 'gen-q': { status: 'found', costUsd: 0.00041 } }, { recorded: false, queued: true, message: 'Polar down' },
        { recorded: false, message: 'Polar down' });
    assert.deepEqual(await runTtsUsagePass(outage.deps), { events: 1, failed: true, more: false });
    assert.deepEqual(outage.events, [`queued q +${DELIVERY_RETRY_MS} Polar down`]);
    // Later passes never send again (the cost is fixed in the queued event); they only flush.
    outage.due.set('q', NOW);
    await runTtsUsagePass(outage.deps);
    assert.equal(outage.sent.length, 1);
    assert.deepEqual(outage.events.slice(1), ['flush 42', `reschedule q +${DELIVERY_RETRY_MS} Polar down`]);

    const recovered = harness([{ ...row('r', 40_000), queued: true }], {});
    await runTtsUsagePass(recovered.deps);
    assert.deepEqual(recovered.sent, []);
    assert.deepEqual(recovered.events, ['flush 42', 'remove r']);
});
