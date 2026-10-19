import fs from 'node:fs';

const originalFetch = globalThis.fetch;
const dir = process.env.SAAS_BILLING_FIXTURES || '/tmp/saas-fixtures';
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' && url.port === '3000') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result: { collections: [] } });
  }
  if (url.hostname !== 'api.polar.sh') throw new Error(`Unmocked provider: ${url.origin}${url.pathname}`);
  const state = JSON.parse(fs.readFileSync(`${dir}/state.json`, 'utf8'));
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  const path = url.pathname.replace(/\/$/, '');
  fs.appendFileSync(`${dir}/calls.jsonl`, JSON.stringify({ method, path, body }) + '\n');
  if (path === '/v1/subscriptions') {
    if (state.subscriptionStatus) return json({ detail: 'Subscriptions unavailable' }, state.subscriptionStatus);
    return json({ items: url.searchParams.has('active') ? state.active : state.history || state.active });
  }
  if (path === '/v1/customer-sessions' && method === 'POST') {
    if (state.portalStatus) return json({ detail: 'Portal unavailable' }, state.portalStatus);
    return json({ id: 'portal-session-fixture', customer_portal_url: 'https://polar.sh/test-org/portal?customer_session_token=fixture', expires_at: '2027-01-01T00:00:00Z' }, 201);
  }
  if (path === '/v1/checkouts' && method === 'POST') {
    if (state.rejectCustomer && body.customer_id) return json({ detail: 'Invalid customer' }, 422);
    return json({ id: 'new-checkout-fixture', url: 'https://checkout.polar.sh/new-checkout-fixture' }, 201);
  }
  if (path.startsWith('/v1/products/')) return json({ prices: [{ price_amount: 1500 }] });
  if (path.startsWith('/v1/discounts')) return json({ items: [] });
  throw new Error(`Unexpected Polar request: ${method} ${path}`);
};
