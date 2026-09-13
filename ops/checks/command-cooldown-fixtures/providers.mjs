// Test-only provider boundary; disposable Mongo/Redis are supplied by saas-ops.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return new Response(JSON.stringify(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } }
  ), { headers: { 'Content-Type': 'application/json' } });
  throw new Error(`External request blocked in cooldown test: ${url.origin}${url.pathname}`);
};
