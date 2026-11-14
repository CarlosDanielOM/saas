// MCP v1 candidate check: every outside provider stays mocked inside saas-ops' private test network.
// Loaded into the API process with --import, so the CIMD test hook reaches the server's own module instance.
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let redis;
async function cache() {
  if (!redis) { redis = createClient({ url: 'redis://redis:6379' }); await redis.connect(); }
  return redis;
}

export const CIMD_CLIENT = 'https://client.example.com/oauth/mcp-client.json';
const cimd = await import('/app/dist/server/oauth/cimd.js');
cimd.__setCimdFetcherForTests(async url => url === CIMD_CLIENT
  ? { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({
      client_id: CIMD_CLIENT, client_name: 'Check MCP Client', redirect_uris: ['http://localhost:5555/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }
  : { status: 404, headers: { 'content-type': 'application/json' }, body: '{}' });

const original = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return original(input, options);
  const raw = options.body ?? (input instanceof Request ? await input.clone().text() : '');
  // Browser (website) Twitch tokens: OAuth consent sends "OAuth <t>", the website API "Bearer <t>".
  const users = { 'mcp-browser-owner': '99004101', 'mcp-browser-admin': '99004102', 'mcp-browser-stranger': '99004103',
    'mcp-browser-creator': '533538623' };
  const browserToken = () => new Headers(options.headers).get('authorization')?.replace(/^(OAuth|Bearer) /, '');
  if (url.hostname === 'id.twitch.tv' && url.pathname === '/oauth2/validate') {
    const token = browserToken();
    if (!users[token]) return Response.json({ status: 401 }, { status: 401 });
    return Response.json({ client_id: 'oauth-beta-test-client', user_id: users[token], expires_in: 3600 });
  }
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/users' && (options.method ?? 'GET') === 'GET' && users[browserToken()]) {
    const id = users[browserToken()];
    return Response.json({ data: [{ id, login: `login_${id}`, display_name: `Login_${id}`, profile_image_url: '' }] });
  }
  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
    const { events = [] } = JSON.parse(String(raw || '{}'));
    for (const event of events) await (await cache()).rPush('mcp:test:billing-events', JSON.stringify(event));
    return Response.json({ inserted: events.length, duplicates: 0 });
  }
  if (url.hostname === 'qdrant.test') return Response.json(url.pathname === '/' ? { version: '1.18.0' }
    : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
  if (url.hostname === 'us.i.posthog.com') return Response.json({ status: 1 });
  if (url.hostname === 'api.twitch.tv' && (options.method ?? 'GET') === 'GET') return Response.json({ data: [] });
  throw new Error(`External request blocked in MCP check: ${url.origin}${url.pathname}`);
};
