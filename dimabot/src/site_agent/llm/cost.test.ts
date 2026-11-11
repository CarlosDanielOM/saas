import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmUsage } from '../types.js';
import { effectiveCostUsd, estimateUsageCost } from './cost.js';

const MODEL = 'openai/gpt-6-luna';
const usage = (extra: Partial<LlmUsage> = {}): LlmUsage => ({
    promptTokens: 10_000, cachedTokens: 8_000, completionTokens: 1_000, reasoningTokens: 600,
    upstreamCostUsd: null, routerCostUsd: 0, source: 'reported', isByok: true, ...extra,
});

test('estimates BYOK steps without an upstream cost; cached input at the cached price', () => {
    const input = usage();
    const out = estimateUsageCost(MODEL, input);
    // 2000 × $0.10/M + 8000 × $0.01/M + 1000 × $0.50/M (reasoning is inside completion tokens)
    assert.equal(out.upstreamCostUsd, 0.00078);
    assert.equal(out.source, 'estimated');
    assert.notEqual(out, input, 'returns a copy');
    assert.equal(input.upstreamCostUsd, null, 'input untouched');
    assert.equal(estimateUsageCost(`${MODEL}:nitro`, input).upstreamCostUsd, 0.00078, 'variants use the base price');
    assert.equal(effectiveCostUsd(out), 0.00078);
});

test('keeps provider costs; skips unknown models and empty usage', () => {
    const reported = usage({ upstreamCostUsd: 0.0002 });
    assert.deepEqual(estimateUsageCost(MODEL, reported), reported);
    const nonByok = usage({ isByok: false, routerCostUsd: 0.0009 });
    assert.equal(estimateUsageCost(MODEL, nonByok).source, 'reported');
    assert.equal(estimateUsageCost('other/model', usage()).upstreamCostUsd, null);
    assert.equal(estimateUsageCost(MODEL, usage({ promptTokens: 0, cachedTokens: 0, completionTokens: 0 })).source, 'reported');
    // Unknown billing mode, no upstream and a zero router fee: estimate.
    assert.equal(estimateUsageCost(MODEL, usage({ isByok: null })).source, 'estimated');
    // Unknown billing mode with a real router price: that is the cost.
    assert.equal(estimateUsageCost(MODEL, usage({ isByok: null, routerCostUsd: 0.001 })).source, 'reported');
    // Cached count above prompt count never goes negative.
    assert.equal(estimateUsageCost(MODEL, usage({ promptTokens: 100, cachedTokens: 500, completionTokens: 0 })).upstreamCostUsd, 0.000001);
});

test('effectiveCostUsd: BYOK adds the router fee, non-BYOK uses the router price', () => {
    assert.equal(effectiveCostUsd(null), null);
    assert.equal(effectiveCostUsd(usage({ upstreamCostUsd: 0.0004, routerCostUsd: 0 })), 0.0004);
    assert.equal(effectiveCostUsd(usage({ upstreamCostUsd: 0.0004, routerCostUsd: 0.00002 })), 0.00042);
    assert.equal(effectiveCostUsd(usage({ isByok: false, upstreamCostUsd: 0.0004, routerCostUsd: 0.0005 })), 0.0005);
    assert.equal(effectiveCostUsd(usage({ isByok: false, upstreamCostUsd: 0.0004, routerCostUsd: null })), 0.0004);
    assert.equal(effectiveCostUsd(usage({ upstreamCostUsd: null, routerCostUsd: null })), null);
    assert.equal(effectiveCostUsd(usage({ isByok: null, upstreamCostUsd: 0.0004, routerCostUsd: 0.0005 })), 0.0005);
    assert.equal(effectiveCostUsd(usage({ isByok: null, upstreamCostUsd: 0.0004, routerCostUsd: 0 })), 0.0004);
});
