// Disposable API startup only. All outbound providers are blocked or mocked.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' } : {
    status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] },
  });
  if (url.hostname === 'api.resend.com') return json({ id: 'fixture-email' });
  if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
  throw new Error(`External request blocked in analytics access test: ${url.origin}${url.pathname}`);
};
