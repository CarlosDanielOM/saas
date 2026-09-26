// Provider boundary used only in saas-ops' internal disposable network.
// The real timer executor, AST handlers, Mongo and Redis remain in use.
const originalFetch = globalThis.fetch;
let captureClient;
async function capture(kind, body) {
  if (!captureClient) {
    const { createClient } = await import('/app/node_modules/redis/dist/index.js');
    captureClient = createClient({ url: 'redis://redis:6379' });
    await captureClient.connect();
  }
  await captureClient.rPush('test:ast-timer:effects', JSON.stringify({ kind, body, at: Date.now() }));
}
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'api.domdimabot.com'].includes(url.hostname) && /^\/triggers\/[^/]+\/send$/.test(url.pathname)) {
    await capture('trigger', JSON.parse(options.body));
    return Response.json({ error: false, message: 'Trigger sent' });
  }
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/chat/messages') {
    await capture('chat', JSON.parse(options.body));
    return Response.json({ data: [{ message_id: 'fixture', is_sent: true }] });
  }
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/channel_points/custom_rewards') {
    const body = JSON.parse(options.body);
    await capture('reward', { id: url.searchParams.get('id'), ...body });
    const id = url.searchParams.get('id');
    if (await captureClient.get(`test:availability:fail:${id}`)) {
      return Response.json({ error: 'Unavailable', message: 'Fixture Twitch failure' }, { status: 503 });
    }
    await captureClient.set(`test:availability:reward:${id}`, String(body.is_enabled));
    return Response.json({ data: [{ id, is_enabled: body.is_enabled }] });
  }
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return Response.json(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } }
  );
  throw new Error(`External request blocked in AST timer test: ${url.origin}${url.pathname}`);
};
