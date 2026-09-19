import fs from 'node:fs';

const originalFetch = globalThis.fetch;
const callsPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const meterId = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const product = (id, name, credits, rollover, amount) => ({
  id,
  name,
  visibility: 'private',
  is_archived: false,
  prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: amount, price_currency: 'usd', is_archived: false }],
  benefits: [{ type: 'meter_credit', properties: { units: credits, rollover, meter_id: meterId } }],
});
const products = [
  product('45c32959-3fa2-41a6-855c-bbeafcf9ce3c', 'Sample Credit Pack', 40_000, true, 100),
  product('2f446a84-69a9-42f6-96ed-6be2b31fdf0c', 'Starter Credits Pack', 250_000, true, 500),
  product('4315e89b-bf47-4ddd-a889-e6be6056853d', 'Medium Credits Pack', 550_000, true, 1000),
  product('44d391d1-8952-408d-ad51-06200404d3ad', 'Small Recharge Pack', 110_000, false, 200),
  product('44a6baba-e057-4af7-82c4-ec8ddd528913', 'Starter Recharge Pack', 325_000, false, 500),
  product('ac85860a-dee1-4399-9c32-932229d112c1', 'Medium Recharge Pack', 699_984, false, 1000),
];
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' && url.port === '3000') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result: { collections: [] } });
  }
  if (url.hostname === 'api.polar.sh') {
    const method = options.method || 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    fs.appendFileSync(callsPath, JSON.stringify({ method, path: url.pathname, query: url.search, body }) + '\n');

    if (url.pathname.replace(/\/$/, '') === '/v1/products') {
      return json({ items: products, pagination: { total_count: products.length, max_page: 1 } });
    }
    if (url.pathname.replace(/\/$/, '') === '/v1/subscriptions') {
      const paid = url.searchParams.get('customer_id') === '22222222-2222-4222-8222-222222222222';
      const currentPeriodEnd = new Date(Date.now() + (6.5 * 24 * 60 * 60 * 1000)).toISOString();
      return json({ items: paid ? [{
        id: '33333333-3333-4333-8333-333333333333',
        status: 'active',
        product_id: '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134',
        current_period_end: currentPeriodEnd,
      }] : [] });
    }
    if (url.pathname.replace(/\/$/, '') === '/v1/checkouts' && method === 'POST') {
      return json({ id: '44444444-4444-4444-8444-444444444444', url: 'https://checkout.polar.sh/test-credit-pack' }, 201);
    }
    if (url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
      return json({ inserted: 1, duplicates: 0 });
    }
    return json({ items: [] });
  }
  throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
