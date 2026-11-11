// ingestPolarNamedEvents (utils/polarsh.ts): the site agent's Polar path. It must send events as they
// are and never reach the AI-credit projection, receipts or analytics used by `ai_usage`.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const ingest = mock.fn(async (_body: { events: unknown[] }) => ({ inserted: 1, duplicates: 0 }));
const forbidden = (name: string) => () => { throw new Error(`${name} must not be called`); };

mock.module('@polar-sh/sdk', { namedExports: { Polar: class { events = { ingest }; } } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: forbidden('getDragonflyClient') } });
mock.module('../utils/logger.js', { namedExports: { error: async () => ({}), info: async () => ({}) } });
mock.module('../utils/billing.js', { namedExports: { recordAiCreditUsage: forbidden('recordAiCreditUsage') } });
mock.module('../utils/ai_usage_ledger.js', { namedExports: { buildQueuedAiUsageReceipt: forbidden('buildQueuedAiUsageReceipt'), enqueueAiUsageReceipt: forbidden('enqueueAiUsageReceipt') } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiUsageRecorded: forbidden('trackAiUsageRecorded') } });
mock.module('../utils/ai_usage_event.js', { namedExports: { createAiUsageContext: forbidden('createAiUsageContext'), enrichPolarUsageMetadata: forbidden('enrichPolarUsageMetadata') } });
process.env.POLARSH_OAT = 'test-token';
const { ingestPolarNamedEvents } = await import('../utils/polarsh.js');

const event = { name: 'ai_assistant', customerId: 'cust_1', externalId: 'site_agent:t1:1', metadata: { model: 'openai/gpt-6-luna', prompt_tokens: 10, cost_usd: 0.0001 } };

beforeEach(() => {
    ingest.mock.resetCalls();
    ingest.mock.mockImplementation(async () => ({ inserted: 1, duplicates: 0 }));
});

test('sends the events unchanged in one ingest call', async () => {
    assert.deepEqual(await ingestPolarNamedEvents([event]), { inserted: 1, duplicates: 0 });
    assert.deepEqual(ingest.mock.calls[0].arguments[0], { events: [event] });
    ingest.mock.mockImplementation(async () => ({ inserted: 0, duplicates: 2 }));
    assert.deepEqual(await ingestPolarNamedEvents([event, { ...event, externalId: 'site_agent:t1:2' }]), { inserted: 0, duplicates: 2 }, 'duplicates count as delivered');
    assert.deepEqual(await ingestPolarNamedEvents([]), { inserted: 0, duplicates: 0 });
    assert.equal(ingest.mock.callCount(), 2);
});

test('refuses ai_usage, credits and missing ids; throws when Polar stores fewer events', async () => {
    await assert.rejects(ingestPolarNamedEvents([{ ...event, name: 'ai_usage' }]), /must not send AI credit usage/);
    await assert.rejects(ingestPolarNamedEvents([{ ...event, metadata: { credits: 5 } }]), /must not send AI credit usage/);
    await assert.rejects(ingestPolarNamedEvents([{ ...event, externalId: '' }]), /required/);
    assert.equal(ingest.mock.callCount(), 0);
    ingest.mock.mockImplementation(async () => ({ inserted: 0, duplicates: 0 }));
    await assert.rejects(ingestPolarNamedEvents([event]), /incomplete/);
});
