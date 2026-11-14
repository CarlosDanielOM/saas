/** Run only inside a saas-ops candidate with disposable Mongo/Redis and oauth-beta-fixtures. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createConnection } from 'node:net';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { OAuthSession } = await import('/app/dist/schemas/oauth_session.schema.js');
const { OAuthGrant } = await import('/app/dist/schemas/oauth_grant.schema.js');
const { OAuthRefreshToken } = await import('/app/dist/schemas/oauth_refresh_token.schema.js');
const { OAuthClient } = await import('/app/dist/schemas/oauth_client.schema.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const mongo = await getMongoDBConnection('oauth-beta-check');
const redis = await getDragonflyClient('oauth-beta-check');
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/, 'disposable database only');
const owner = '99003101';
const other = '99003102';
const users = await mongo.connection.db.collection('users').insertMany([
  { name: 'OAuth Owner', email: 'private@example.invalid', plan_tier: 'free', polar_sh_customer_id: 'oauth-beta-customer',
    accounts: [{ type: 'twitch', id: owner, name: 'oauth_owner' }] },
  { name: 'OAuth Other', plan_tier: 'free', accounts: [{ type: 'twitch', id: other, name: 'oauth_other' }] }
]);
await redis.set(`twitch:${owner}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
  used: 8, limit: 50, balance: 42, available: true, status: 'available', updatedAt: new Date().toISOString() }));
const base = 'http://127.0.0.1:3000';
const rand = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
async function call(path, options = {}) {
  const response = await fetch(base + path, { ...options, redirect: 'manual' });
  return { status: response.status, headers: response.headers, body: response.status === 302 ? null : await response.json() };
}
const post = (path, input, token, extra = {}) => call(path, { method: 'POST', headers: {
  'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(input) });
const get = (path, token) => call(path, { headers: { Authorization: `Bearer ${token}` } });
const tokenRequest = input => post('/oauth/token', { client_id: 'dima-desktop', ...input });
/** An undefined override omits that parameter. */
async function authorizeRequest(scope = 'profile:read credits:read desktop:connect', overrides = {}) {
  const verifier = rand();
  const input = Object.fromEntries(Object.entries({ client_id: 'dima-desktop', response_type: 'code', scope,
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback', state: rand(),
    code_challenge: digest(verifier), code_challenge_method: 'S256', device_name: 'Streaming PC', ...overrides })
    .filter(([, value]) => value !== undefined));
  return { ...(await call(`/oauth/authorize?${new URLSearchParams(input)}`)), input, verifier, state: input.state };
}
async function begin(scope, overrides = {}) {
  const result = await authorizeRequest(scope, overrides);
  if (result.status !== 302) return result;
  const location = new URL(result.headers.get('location'));
  assert.equal(location.origin, 'https://domdimabot.com');
  assert.equal(location.pathname, '/oauth/authorize');
  return { ...result, request: location.searchParams.get('request') };
}
/** Failures after the client and redirect_uri checks return to the callback (RFC 6749 4.1.2.1), never the Dima site. */
async function rejected(overrides, error, echoState = true) {
  const result = await authorizeRequest(undefined, overrides);
  const label = JSON.stringify(overrides);
  assert.equal(result.status, 302, label);
  const location = new URL(result.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, result.input.redirect_uri, label);
  assert.equal(location.searchParams.get('error'), error, label);
  assert.equal(location.searchParams.get('iss'), 'https://api.domdimabot.com', label);
  assert.equal(location.searchParams.get('state'), echoState ? result.state : null, label);
  assert.equal(location.searchParams.get('code'), null, label);
  const description = location.searchParams.get('error_description');
  assert.match(description, /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/, label);
  for (const value of Object.values(overrides)) if (value) assert.equal(description.includes(value), false, `${label} not echoed`);
}
async function authorize(scope, overrides = {}, browser = 'oauth-beta-browser-owner') {
  const start = await begin(scope, overrides);
  assert.equal(start.status, 302);
  const decision = await post(`/oauth/requests/${start.request}/decision`, { approve: true }, browser);
  assert.equal(decision.status, 200);
  const callback = new URL(decision.body.redirect_uri);
  assert.equal(callback.searchParams.get('state'), start.state ?? null);
  assert.equal(callback.searchParams.get('iss'), 'https://api.domdimabot.com');
  return { ...start, code: callback.searchParams.get('code') };
}
async function exchange(auth, overrides = {}) {
  return tokenRequest({ grant_type: 'authorization_code', code: auth.code, code_verifier: auth.verifier,
    redirect_uri: auth.input.redirect_uri, ...overrides });
}
async function mint(scope) {
  const auth = await authorize(scope);
  const result = await exchange(auth);
  assert.equal(result.status, 200);
  assert.equal(result.body.token_type, 'Bearer');
  assert.match(result.body.access_token, /^dima_at_/);
  assert.match(result.body.refresh_token, /^dima_rt_/);
  return result.body;
}
const refresh = (token, extra = {}) => tokenRequest({ grant_type: 'refresh_token', refresh_token: token, ...extra });

let result = await call('/.well-known/oauth-authorization-server');
assert.equal(result.status, 200);
assert.deepEqual(result.body.code_challenge_methods_supported, ['S256']);
assert.ok(result.body.scopes_supported.includes('credits:read'));
assert.ok(result.body.scopes_supported.includes('pet:interact'));
assert.ok(result.body.scopes_supported.includes('ai:interact'));
assert.ok(result.body.scopes_supported.includes('pet:playback:select'));
assert.deepEqual(result.body.beta.socket_io, { path: '/socket.io/', namespace: '/desktop', protocol_version: 1 });
assert.match(result.headers.get('cache-control'), /no-store/);
// Startup gives first-party clients only their registry scopes; a restart adds listed ones and removes none.
const { FIRST_PARTY_CLIENTS } = await import('/app/dist/server/oauth/clients.js');
const { initializeOAuth } = await import('/app/dist/server/oauth/service.js');
const registryScopes = [...FIRST_PARTY_CLIENTS.find(client => client.client_id === 'dima-desktop').allowed_scopes].sort();
const desktopScopes = async () => [...(await OAuthClient.findOne({ client_id: 'dima-desktop' }).lean()).allowed_scopes].sort();
assert.deepEqual(await desktopScopes(), registryScopes, 'desktop client holds exactly its registry scopes');
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $pull: { allowed_scopes: 'credits:read' } });
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $addToSet: { allowed_scopes: 'usage:read' } });
await initializeOAuth();
assert.deepEqual(await desktopScopes(), [...registryScopes, 'usage:read'].sort(), 'restart re-adds listed scopes, keeps DB-added ones');
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $pull: { allowed_scopes: 'usage:read' } });
assert.deepEqual(await desktopScopes(), registryScopes);
// Malformed origin-form targets must not throw out of the HTTP upgrade listener.
const malformedUpgrade = await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port: 3000 });
  let response = '';
  socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Malformed upgrade timed out')); });
  socket.on('connect', () => socket.write('GET //% HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: YWJjZGVmZ2hpamtsbW5vcA==\r\n\r\n'));
  socket.on('data', data => { response += data.toString(); });
  socket.on('end', () => { socket.destroy(); resolve(response); });
  socket.on('error', reject);
});
assert.match(malformedUpgrade, /^HTTP\/1\.1 400/);
assert.equal((await call('/oauth/metadata')).status, 200, 'API remains healthy after malformed upgrade');
// An untrusted client or callback is answered in the browser, never redirected, whatever else is wrong.
for (const override of [
  { redirect_uri: 'https://evil.invalid/oauth/callback' }, { redirect_uri: 'http://localhost:42781/oauth/callback' },
  { redirect_uri: 'http://127.0.0.1:42781/other' }, { redirect_uri: 'http://127.0.0.1:42781/oauth/callback?redirect=evil' },
  { redirect_uri: 'http://127.0.0.1:42781/oauth/callback#fragment' }, { client_id: 'unknown' },
  { client_id: 'unknown', code_challenge_method: 'plain' }, { redirect_uri: 'https://evil.invalid/oauth/callback', scope: '*' }
]) {
  result = await authorizeRequest(undefined, override);
  assert.equal(result.status, 400, JSON.stringify(override));
  assert.equal(result.headers.get('location'), null, JSON.stringify(override));
}
for (const [override, error, echoState] of [
  [{ response_type: 'token' }, 'unsupported_response_type'], [{ response_type: undefined }, 'invalid_request'],
  [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge_method: undefined }, 'invalid_request'],
  [{ code_challenge: 'short' }, 'invalid_request'], [{ code_challenge: undefined }, 'invalid_request'],
  [{ scope: '*' }, 'invalid_scope'], [{ scope: 'usage:read' }, 'invalid_scope'], [{ scope: 'profile:read  credits:read' }, 'invalid_scope'],
  [{ device_name: 'bad\nname' }, 'invalid_request'], [{ scope: '*', state: 'a b+c&d=%/~' }, 'invalid_scope'],
  [{ scope: '*', state: undefined }, 'invalid_scope', false], [{ scope: '*', redirect_uri: 'http://[::1]:42781/oauth/callback' }, 'invalid_scope'],
  [{ state: '' }, 'invalid_request', false], [{ state: 'x'.repeat(501) }, 'invalid_request', false],
  [{ state: 'bad\nstate' }, 'invalid_request', false], [{ state: 'caf\u00e9' }, 'invalid_request', false]
]) await rejected(override, error, echoState ?? true);
assert.equal((await begin(undefined, { redirect_uri: 'http://[::1]:42781/oauth/callback' })).status, 302);
result = await call('/oauth/authorize?client_id=dima-desktop&client_id=other');
assert.equal(result.status, 400);
result = await call(`/oauth/authorize?client_id=dima-desktop&${new URLSearchParams([['redirect_uri', 'http://127.0.0.1:42781/oauth/callback'],
  ['redirect_uri', 'http://127.0.0.1:42782/oauth/callback']])}`);
assert.equal(result.status, 400, 'duplicate redirect_uri is never redirected');
assert.equal(result.headers.get('location'), null);

const start = await begin();
result = await call(`/oauth/requests/${start.request}`);
assert.deepEqual(result.body.scopes, ['profile:read', 'credits:read', 'desktop:connect']);
result = await post(`/oauth/requests/${start.request}/decision`, { approve: true });
assert.equal(result.status, 401);
assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="dima-browser"', 'browser routes: own realm, no Dima scopes');
assert.equal((await post(`/oauth/requests/${start.request}/decision`, { approve: true }, 'oauth-beta-wrong-client')).status, 401);
assert.equal((await post(`/oauth/requests/${start.request}/decision`, { approve: true }, 'oauth-beta-browser-owner', { Origin: 'https://evil.invalid' })).status, 403);
result = await post(`/oauth/requests/${start.request}/decision`, { approve: false }, 'oauth-beta-browser-owner');
assert.equal(result.status, 200);
assert.equal(new URL(result.body.redirect_uri).searchParams.get('error'), 'access_denied');
assert.equal((await post(`/oauth/requests/${start.request}/decision`, { approve: true }, 'oauth-beta-browser-owner')).status, 400);
// state is optional: without one, neither the deny nor the approve callback carries it.
const deniedNoState = await begin(undefined, { state: undefined });
result = await post(`/oauth/requests/${deniedNoState.request}/decision`, { approve: false }, 'oauth-beta-browser-owner');
assert.equal(result.status, 200);
assert.deepEqual([...new URL(result.body.redirect_uri).searchParams.keys()], ['iss', 'error']);
const expiredRequest = await begin();
await redis.del(`oauth:request:${digest(expiredRequest.request)}`);
assert.equal((await call(`/oauth/requests/${expiredRequest.request}`)).status, 400);

const auth = await authorize();
assert.equal((await exchange(auth, { code_verifier: rand() })).status, 400, 'wrong PKCE rejected');
assert.equal((await exchange(auth, { redirect_uri: 'http://127.0.0.1:42782/oauth/callback' })).status, 400, 'exact callback retained');
const pair = await exchange(auth);
assert.equal(pair.status, 200, 'bad verifier does not consume valid code');
assert.equal((await exchange(auth)).status, 400, 'single-use code');
const token = pair.body;
const codeRace = await authorize('profile:read');
assert.deepEqual((await Promise.all([exchange(codeRace), exchange(codeRace)])).map(item => item.status).sort(), [200, 400]);
const formAuth = await authorize('profile:read');
result = await call('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: 'dima-desktop', grant_type: 'authorization_code', code: formAuth.code,
    redirect_uri: formAuth.input.redirect_uri, code_verifier: formAuth.verifier }) });
assert.equal(result.status, 200, 'native clients can use the standard form token request');
assert.equal(result.body.data, undefined, 'OAuth responses are not wrapped in the legacy envelope');
const expiredCode = await authorize('profile:read');
await redis.del(`oauth:code:${digest(expiredCode.code)}`);
assert.equal((await exchange(expiredCode)).status, 400);
// Standard client libraries: a shorter state, or none, works end to end (authorize() checks the echo).
assert.equal((await exchange(await authorize('profile:read', { state: 'abcdefghij0123456789' }))).status, 200, '20-character state');
assert.equal((await exchange(await authorize('profile:read', { state: undefined }))).status, 200, 'omitted state');

result = await get('/v1/me', token.access_token);
assert.equal(result.status, 200);
assert.equal(result.body.user_id, users.insertedIds[0].toString());
assert.equal(result.body.channel.id, owner);
assert.equal(result.body.email, undefined);
assert.equal(result.body.accounts, undefined);
result = await get('/v1/me/credits', token.access_token);
assert.equal(result.status, 200);
assert.equal(result.body.balance, 42);
assert.equal((await get(`/v1/me/credits?channelID=${other}`, token.access_token)).status, 400);
result = await get('/v1/me', 'oauth-beta-browser-owner');
assert.equal(result.status, 401, 'Twitch tokens are not Dima tokens');
assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="dima", error="invalid_token"');
result = await call('/v1/me');
assert.deepEqual([result.status, result.body], [401, { error: 'invalid_token' }], 'no credentials: body unchanged for the desktop app');
assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="dima"', 'RFC 6750 §3.1: no error code without credentials');
const limited = await mint('profile:read');
result = await get('/v1/me/credits', limited.access_token);
assert.deepEqual([result.status, result.body], [403, { error: 'insufficient_scope' }]);
assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="dima", error="insufficient_scope", scope="credits:read"');
assert.equal((await get('/v1/desktop/session', limited.access_token)).status, 403);
assert.equal((await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: limited.refresh_token,
  client_id: 'dima-desktop', client_secret: 'not-a-secret' })).status, 400);
result = await tokenRequest({ grant_type: 'password' });
assert.equal(result.status, 400);
assert.equal(result.headers.get('www-authenticate'), null, 'token endpoint errors carry no Bearer challenge');
assert.equal((await refresh(limited.refresh_token, { scope: 'profile:read credits:read' })).status, 400, 'refresh cannot expand scopes');

// Real native WebSocket, no Socket.IO client or query-string credentials.
const ws = new WebSocket('ws://127.0.0.1:3000/v1/desktop/ws', 'dima.desktop.v1', { headers: { Authorization: `Bearer ${token.access_token}` } });
const helloPromise = once(ws, 'message');
await once(ws, 'open');
const [helloRaw] = await helloPromise;
const hello = JSON.parse(helloRaw.toString());
assert.equal(hello.type, 'hello');
assert.equal(hello.channel_id, owner);
assert.equal(hello.pet_available, false);
const pongPromise = once(ws, 'message');
ws.send(JSON.stringify({ type: 'ping', id: 'integration-1' }));
assert.deepEqual(JSON.parse((await pongPromise)[0].toString()), { type: 'pong', id: 'integration-1' });
const unsupported = once(ws, 'message');
ws.send(JSON.stringify({ type: 'pet:interact' }));
assert.equal(JSON.parse((await unsupported)[0].toString()).error, 'unsupported_message');
async function rejectedSocket(access, url = 'ws://127.0.0.1:3000/v1/desktop/ws', headers = {}) {
  return new Promise(resolve => {
    const socket = new WebSocket(url, 'dima.desktop.v1', { headers: { Authorization: `Bearer ${access}`, ...headers } });
    socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    socket.on('error', () => {});
    socket.on('open', () => { socket.terminate(); resolve(101); });
  });
}
assert.equal(await rejectedSocket(limited.access_token), 403);
assert.equal(await rejectedSocket(token.access_token, `ws://127.0.0.1:3000/v1/desktop/ws?token=${token.access_token}`), 403);

// Rate limits key on the real client (CF-Connecting-IP behind a Cloudflare edge), never on the proxy.
const rateKey = bucket => `oauth:rate:${digest(bucket)}`;
const edge = client => ({ 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': client });
await redis.set(rateKey('oauth:203.0.113.7'), '600', { EX: 60 });
result = await call('/oauth/metadata', { headers: edge('203.0.113.7') });
assert.equal(result.status, 429, 'exhausted client is limited');
assert.equal(result.headers.get('retry-after'), '60');
assert.equal((await call('/oauth/metadata', { headers: edge('203.0.113.8') })).status, 200, 'clients behind the same edge keep their own bucket');
assert.equal((await call('/oauth/metadata')).status, 200, 'direct callers use the socket address');
await redis.set(rateKey('oauth:untrusted'), '600', { EX: 60 });
assert.equal((await call('/oauth/metadata', { headers: { 'X-Real-IP': '192.0.2.9', 'CF-Connecting-IP': '203.0.113.9' } })).status, 429,
  'conflicting proxy headers share one bucket');
const cappedToken = `dima_at_${rand()}`;
await redis.set(rateKey(`desktop-token:${digest(cappedToken)}`), '1200', { EX: 60 });
assert.equal((await call('/v1/me', { headers: { ...edge('203.0.113.10'), Authorization: `Bearer ${cappedToken}` } })).status, 429,
  'per-installation limit applies from any IP');
assert.equal((await call('/v1/me', { headers: { ...edge('203.0.113.10'), Authorization: `Bearer dima_at_${rand()}` } })).status, 401,
  'other installations behind that IP pass the limiter');
await redis.set(rateKey('ws:203.0.113.11'), '120', { EX: 60 });
assert.notEqual(await rejectedSocket(token.access_token, undefined, edge('203.0.113.11')), 101, 'exhausted client cannot open a socket');
assert.equal(await rejectedSocket(token.access_token, undefined, edge('203.0.113.12')), 101, 'its neighbour can');

result = await refresh(token.refresh_token);
assert.equal(result.status, 200);
assert.notEqual(result.body.refresh_token, token.refresh_token);
assert.equal((await get('/v1/me', result.body.access_token)).status, 200);
assert.equal((await refresh(token.refresh_token)).status, 400, 'reuse revokes family');
assert.equal((await get('/v1/me', result.body.access_token)).status, 401);
const closed = once(ws, 'close');
ws.send(JSON.stringify({ type: 'ping', id: 'after-revoke' }));
assert.equal((await closed)[0], 4401);

const race = await mint('profile:read');
assert.deepEqual((await Promise.all([refresh(race.refresh_token), refresh(race.refresh_token)])).map(item => item.status).sort(), [200, 400]);
assert.equal((await get('/v1/me', race.access_token)).status, 401, 'concurrent refresh fails closed');
const expiring = await mint('profile:read');
await redis.del(`oauth:access:${digest(expiring.access_token)}`);
assert.equal((await get('/v1/me', expiring.access_token)).status, 401);
assert.equal((await refresh(expiring.refresh_token)).status, 200, 'expired access can renew with valid refresh');
const idle = await mint('profile:read');
await OAuthSession.updateOne({ _id: idle.session_id }, { $set: { idle_expires_at: new Date(0) } });
assert.equal((await refresh(idle.refresh_token)).status, 400);

const revoked = await mint('profile:read');
assert.equal((await post('/oauth/revoke', { client_id: 'dima-desktop', token: revoked.refresh_token })).status, 200);
result = await get('/v1/me', revoked.access_token);
assert.equal(result.status, 401);
assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="dima", error="invalid_token"', 'revoked token');
assert.equal((await post('/oauth/revoke', { client_id: 'dima-desktop', token: 'unknown-token' })).status, 200);
const idleSocketToken = await mint('desktop:connect');
const idleSocket = new WebSocket('ws://127.0.0.1:3000/v1/desktop/ws', 'dima.desktop.v1', { headers: { Authorization: `Bearer ${idleSocketToken.access_token}` } });
await once(idleSocket, 'open');
const idleClosed = once(idleSocket, 'close');
await post('/oauth/revoke', { client_id: 'dima-desktop', token: idleSocketToken.refresh_token });
const deadline = setTimeout(() => idleSocket.terminate(), 17000);
assert.equal((await idleClosed)[0], 4401, 'idle socket observes revocation within the validity-check interval');
clearTimeout(deadline);
const selfLogout = await mint('profile:read');
assert.equal((await call('/v1/desktop/session', { method: 'DELETE', headers: { Authorization: `Bearer ${selfLogout.access_token}` } })).status, 200);
assert.equal((await get('/v1/me', selfLogout.access_token)).status, 401);

const managed = await mint('profile:read');
assert.equal((await call(`/oauth/connections/${managed.session_id}`, { method: 'DELETE', headers: { Authorization: 'Bearer oauth-beta-browser-other' } })).status, 404);
result = await get('/oauth/connections', 'oauth-beta-browser-owner');
assert.equal(result.status, 200);
assert.ok(result.body.sessions.some(item => item._id === managed.session_id));
assert.equal(JSON.stringify(result.body).includes('current_refresh_hash'), false);
const grantID = result.body.sessions.find(item => item._id === managed.session_id).grant_id;
assert.equal((await call(`/oauth/grants/${grantID}`, { method: 'DELETE', headers: { Authorization: 'Bearer oauth-beta-browser-owner' } })).status, 200);
const newApproval = await mint('profile:read');
assert.equal((await get('/v1/me', managed.access_token)).status, 401, 'reapproval does not resurrect old sessions');
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $set: { enabled: false } });
assert.notEqual((await get('/v1/me', newApproval.access_token)).status, 200);
await OAuthClient.updateOne({ client_id: 'dima-desktop' }, { $set: { enabled: true } });
await mongo.connection.db.collection('users').deleteOne({ _id: users.insertedIds[0] });
assert.equal((await get('/v1/me', newApproval.access_token)).status, 401, 'deleted owner fails closed');
assert.equal(await OAuthRefreshToken.countDocuments({ token_hash: { $regex: '^dima_' } }), 0, 'raw credentials never persisted');
assert.ok(await OAuthGrant.countDocuments() > 0);
console.log('PASS OAuth beta: PKCE/replay/races/expiry, optional state + error callbacks, provider identity, consent, own-account scopes/credits, refresh rotation/reuse, revocation, management, native WebSocket, Bearer challenges, client scope registry, per-client/per-token rate limits');
await mongo.disconnect();
await redis.quit();
process.exit(0);
