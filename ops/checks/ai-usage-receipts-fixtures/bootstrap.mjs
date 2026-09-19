const realFetch = globalThis.fetch;

const polarEvents = [
  {
    id: 'polar-tts-2',
    timestamp: '2026-09-19T15:00:00.000Z',
    organization_id: 'candidate-organization',
    customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null,
    external_customer_id: null,
    child_count: 0,
    label: 'AI usage',
    name: 'ai_usage',
    source: 'user',
    metadata: {
      schema_version: 1,
      entry_id: 'entry-tts-2',
      request_id: 'request-tts-2',
      entry_kind: 'usage',
      category: 'tts',
      operation: 'synthesize',
      usage_source: 'chat-command',
      provider: 'fish',
      quantity: 20,
      unit: 'characters',
      resource_type: 'speech',
      resource_id: 'speech-2',
      credits: 30,
      cost: 0.0003,
      currency: 'usd'
    }
  },
  {
    id: 'polar-tts-1',
    timestamp: '2026-09-19T12:00:00.000Z',
    organization_id: 'candidate-organization',
    customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null,
    external_customer_id: null,
    child_count: 0,
    label: 'AI usage',
    name: 'ai_usage',
    source: 'user',
    metadata: {
      schema_version: 1,
      entry_id: 'entry-tts-1',
      request_id: 'request-tts-1',
      entry_kind: 'usage',
      category: 'tts',
      operation: 'synthesize',
      usage_source: 'chat-command',
      provider: 'fish',
      quantity: 100,
      unit: 'characters',
      resource_type: 'speech',
      resource_id: 'speech-1',
      credits: 150,
      cost: 0.0015,
      currency: 'usd'
    }
  },
  {
    id: 'polar-chat-1',
    timestamp: '2026-09-18T10:00:00.000Z',
    organization_id: 'candidate-organization',
    customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null,
    external_customer_id: null,
    child_count: 0,
    label: 'AI usage',
    name: 'ai_usage',
    source: 'user',
    metadata: {
      schema_version: 1,
      entry_id: 'entry-chat-1',
      request_id: 'request-chat-1',
      entry_kind: 'usage',
      category: 'ai_chat',
      operation: 'message',
      usage_source: 'chat',
      provider: 'openrouter',
      model: 'openai/test',
      quantity: 15,
      unit: 'tokens',
      resource_type: 'llm_generation',
      credits: 50,
      cost: 0.0005,
      currency: 'usd'
    }
  },
  {
    id: 'polar-grant-1',
    timestamp: '2026-09-18T09:00:00.000Z',
    organization_id: 'candidate-organization',
    customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null,
    external_customer_id: null,
    child_count: 0,
    label: 'AI usage',
    name: 'ai_usage',
    source: 'user',
    metadata: {
      schema_version: 1,
      entry_id: 'entry-grant-1',
      request_id: 'request-grant-1',
      entry_kind: 'adjustment',
      category: 'credit_adjustment',
      operation: 'grant',
      usage_source: 'admin_credit_grant',
      provider: 'polar',
      credits: -1000,
      cost: 0,
      currency: 'usd'
    }
  },
  {
    id: 'polar-legacy-1',
    timestamp: '2026-09-18T08:00:00.000Z',
    organization_id: 'candidate-organization',
    customer_id: '11111111-1111-4111-8111-111111111111',
    customer: null,
    external_customer_id: null,
    child_count: 0,
    label: 'AI usage',
    name: 'ai_usage',
    source: 'user',
    metadata: {
      credits: 25,
      cost: 0.00025,
      currency: 'usd',
      reason: 'legacy'
    }
  }
];

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'qdrant.invalid') {
    const body = url.pathname === '/collections'
      ? { result: { collections: [] }, status: 'ok', time: 0 }
      : { result: true, status: 'ok', time: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events') {
    return new Response(JSON.stringify({
      items: polarEvents,
      pagination: { total_count: polarEvents.length, max_page: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.hostname === 'api.polar.sh' && /^\/v1\/customers\/[^/]+\/state\/?$/.test(url.pathname)) {
    return new Response(JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-09-07T00:00:00.000Z',
      modified_at: null,
      metadata: {},
      external_id: null,
      email: 'fixture@example.invalid',
      email_verified: true,
      type: 'individual',
      name: 'Fixture User',
      billing_address: null,
      tax_id: null,
      organization_id: 'candidate-organization',
      deleted_at: null,
      active_subscriptions: [{
        id: 'fixture-subscription',
        created_at: '2026-09-07T00:00:00.000Z',
        modified_at: null,
        metadata: {},
        status: 'active',
        amount: 1000,
        currency: 'usd',
        recurring_interval: 'month',
        current_period_start: '2026-09-07T00:00:00.000Z',
        current_period_end: '2026-10-07T00:00:00.000Z',
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
        started_at: '2026-09-07T00:00:00.000Z',
        ends_at: null,
        product_id: 'fixture-product',
        discount_id: null,
        meters: []
      }],
      granted_benefits: [],
      active_meters: [],
      avatar_url: ''
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.hostname === 'us.i.posthog.com') {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
