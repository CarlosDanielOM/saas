/** get_ai_credits: the Credits page's numbers (free-plan display when there is one), billing:view, free on MCP. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ToolContext } from '../types.js';

let owner: Record<string, unknown> | null = null;
let raw = { version: 3, used: 400, limit: 25000, balance: 24600, meterId: 'm', updatedAt: '2026-11-14T00:00:00Z', available: true, status: 'available' };
let display: unknown = undefined;
mock.module('../../schemas/users.schema.js', { defaultExport: { findOne: async () => owner } });
mock.module('../../utils/billing.js', { namedExports: { getAiCredits: async () => raw } });
mock.module('../../utils/ai_credit_display.js', { namedExports: { getFreeAiCreditDisplay: async () => display } });
const { getAiCreditsTool } = await import('./credits_read.js');
const ctx = { channelId: '111', channelLogin: 'luna', lang: 'en', signal: new AbortController().signal } as unknown as ToolContext;

test('premium/pro: the live balance, with where to buy more', async () => {
    owner = { plan_tier: 'pro' }; display = undefined;
    const out = await getAiCreditsTool.run({} as never, ctx) as { result: Record<string, unknown> };
    assert.deepEqual(out.result, { plan: 'pro', available: true, status: 'available', balance: 24600, used: 400, limit: 25000,
        updatedAt: '2026-11-14T00:00:00Z', buyMoreAt: 'https://domdimabot.com/luna/credits' });
});

test('free plan: the same estimated figures the website shows; an empty balance reads as exhausted', async () => {
    owner = { plan_tier: 'free' };
    display = { estimated: true, credits: { ...raw, used: 25000, balance: 0 }, pacing: null };
    const out = await getAiCreditsTool.run({} as never, ctx) as { result: Record<string, unknown> };
    assert.equal(out.result.balance, 0);
    assert.equal(out.result.status, 'exhausted');
    assert.equal(out.result.estimated, true);
});

test('no account or unavailable billing is reported plainly and never billed', async () => {
    owner = null;
    const none = await getAiCreditsTool.run({} as never, ctx) as { billable?: boolean };
    assert.equal(none.billable, false);
    owner = { plan_tier: 'premium' }; display = undefined; raw = { ...raw, available: false, status: 'unavailable' };
    const out = await getAiCreditsTool.run({} as never, ctx) as { result: Record<string, unknown> };
    assert.equal(out.result.available, false);
    assert.match(String(out.result.message), /can't be read/);
});

test('same permission as the Credits page', () => {
    assert.deepEqual(getAiCreditsTool.permissions, ['billing:view']);
});
