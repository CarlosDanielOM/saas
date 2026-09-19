import fs from 'node:fs';

const callsPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const realFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const log = (value) => fs.appendFileSync(callsPath, `${JSON.stringify(value)}\n`);

const events = [
  {
    id: 'polar-ledger-tts', timestamp: '2026-09-19T01:00:00.000Z', name: 'ai_usage', source: 'user',
    organization_id: 'candidate-organization', customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null, external_customer_id: null, child_count: 0, label: 'AI usage',
    metadata: {
      schema_version: 1, entry_id: 'ledger-tts', request_id: 'request-tts', entry_kind: 'usage',
      category: 'tts', operation: 'synthesize', usage_source: 'chat-command', provider: 'fish',
      quantity: 100, unit: 'characters', resource_type: 'speech', resource_id: 'speech-1',
      credits: 150, cost: 0.0015, currency: 'usd',
    },
  },
  {
    id: 'polar-ledger-chat', timestamp: '2026-09-18T10:00:00.000Z', name: 'ai_usage', source: 'user',
    organization_id: 'candidate-organization', customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null, external_customer_id: null, child_count: 0, label: 'AI usage',
    metadata: {
      schema_version: 1, entry_id: 'ledger-chat', request_id: 'request-chat', entry_kind: 'usage',
      category: 'ai_chat', operation: 'message', usage_source: 'chat', provider: 'openrouter',
      quantity: 15, unit: 'tokens', resource_type: 'llm_generation', credits: 50, cost: 0.0005, currency: 'usd',
    },
  },
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events') {
    log({ type: 'polar-events-list', page: url.searchParams.get('page') });
    return json({ items: events, pagination: { total_count: events.length, max_page: 1 } });
  }
  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
    const request = input instanceof Request ? input : null;
    const rawBody = init.body ?? (request ? await request.clone().text() : '{}');
    const body = JSON.parse(String(rawBody || '{}'));
    log({ type: 'polar-events-ingest', count: Array.isArray(body.events) ? body.events.length : 0 });
    return json({ inserted: Array.isArray(body.events) ? body.events.length : 0, duplicates: 0 });
  }
  if (url.hostname === 'api.polar.sh' && /^\/v1\/customers\/[^/]+\/state\/?$/.test(url.pathname)) {
    return json({ id: '11111111-1111-4111-8111-111111111111', created_at: '2025-01-07T00:00:00Z', modified_at: null,
      metadata: {}, external_id: null, email: 'fixture@example.invalid', email_verified: true, type: 'individual', name: 'Fixture',
      billing_address: null, tax_id: null, organization_id: 'candidate-organization', deleted_at: null,
      active_subscriptions: [], granted_benefits: [], active_meters: [], avatar_url: '' });
  }
  if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
  if (url.hostname === 'qdrant.test') return json({ result: { collections: [] }, status: 'ok', time: 0 });
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  throw new Error(`External request blocked in AI usage ledger test: ${url.origin}${url.pathname}`);
};
