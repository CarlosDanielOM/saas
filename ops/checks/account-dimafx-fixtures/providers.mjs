// Loaded only by saas-ops --test-env NODE_OPTIONS, inside the isolated API candidate.
// Mocks Qdrant, Polar and Twitch; loopback API traffic passes through untouched.
const originalFetch = globalThis.fetch;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/'
      ? { version: '1.18.0' }
      : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : url.pathname.endsWith('/delete') ? { operation_id: 1, status: 'completed' } : { collections: [] } });
  }
  if (url.hostname === 'api.polar.sh') return json({ events: [], inserted: 1, duplicates: 0 });
  if (url.hostname === 'id.twitch.tv' || url.hostname === 'api.twitch.tv') return json({}, 401);
  throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
