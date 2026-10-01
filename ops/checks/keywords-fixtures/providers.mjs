// All external providers stay mocked inside saas-ops' private test network.
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let redis;
async function cache() {
  if (!redis) { redis = createClient({ url: 'redis://redis:6379' }); await redis.connect(); }
  return redis;
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return Response.json(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/chat/messages') {
    const body = JSON.parse(options.body);
    await (await cache()).rPush('keywords:test:messages', JSON.stringify(body));
    return Response.json({ data: [{ is_sent: true, message_id: 'mock-message' }] });
  }
  if (url.hostname === 'api.twitch.tv' && options?.method !== 'POST') return Response.json({ data: [] });
  throw new Error(`External request blocked in keyword test: ${url.origin}${url.pathname}`);
};
