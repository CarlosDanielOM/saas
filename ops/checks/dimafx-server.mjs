// DimaFX extension-server check (no database dependencies).
// Verifies auth expiry, signed Bits receipts, forged/wrong-user rejection,
// logged-out mutation gates, identity-safe TTS pre-checks and service proxying.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const root = process.env.DIMAFX_SERVER_CHECK_URL || 'http://127.0.0.1:8080';
const secret = process.env.TWITCH_EXTENSION_SECRET;
assert.ok(secret, 'TWITCH_EXTENSION_SECRET is required');

const b64u = (value) => Buffer.from(value).toString('base64url');
const jwt = (payload, key = Buffer.from(secret, 'base64')) => {
  const unsigned = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
};
const validJwt = (overrides = {}) => jwt({
  channel_id: '555777', user_id: 'u-1', opaque_user_id: 'Uop-1', role: 'viewer',
  exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
});

const receipt = (data = {}, product = {}, key) => jwt({ topic: 'bits_transaction_receipt', exp: 1, data: {
  transactionId: 'tx-fixture', userId: 'u-1', time: new Date().toISOString(),
  product: { sku: 'bits5', cost: { amount: 5, type: 'bits' }, inDevelopment: true, ...product }, ...data,
} }, key);

const received = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, serviceToken: req.headers['x-dimafx-service-token'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: false, status: 200, data: req.url.endsWith('/overlay-status') ? { connected: false } : { ok: true } }));
  });
});
await new Promise((resolve) => stub.listen(4099, '127.0.0.1', resolve));

const post = (path, token, body) =>
  fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, ...(await response.json()) }));

try {
  const health = await fetch(`${root}/health`).then((r) => r.json());
  assert.equal(health.data.ok, true, 'health endpoint');

  const statusResponse = await fetch(`${root}/v1/channels/555777/overlay-status`, { headers: { Authorization: `Bearer ${validJwt()}` } });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await statusResponse.json()).data.connected, false);
  assert.ok(received.some(r => r.url === '/extensions/dimafx/internal/channels/555777/overlay-status' && r.serviceToken === 'fixture-service-token'));
  const statusMismatch = await fetch(`${root}/v1/channels/999000/overlay-status`, { headers: { Authorization: `Bearer ${validJwt()}` } });
  assert.equal(statusMismatch.status, 403);

  // Purchase: TTS text and identity are proxied to dimabot.
  const purchase = await post('/v1/channels/555777/items/item-1/purchase', validJwt(), {
    sku: 'client-sku-is-ignored', transactionID: 'client-id-is-ignored', transactionReceipt: receipt(), action: 'use_now', ttsText: 'hello fixture',
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase));
  const proxied = received.find((r) => r.url === '/extensions/dimafx/internal/channels/555777/items/item-1/purchase');
  assert.ok(proxied, 'purchase proxied to dimabot');
  assert.equal(proxied.serviceToken, 'fixture-service-token', 'service token forwarded');
  assert.equal(proxied.body.userID, 'u-1');
  assert.equal(proxied.body.ttsText, 'hello fixture', 'viewer TTS text forwarded on purchase');
  assert.equal(proxied.body.transactionID, undefined);
  assert.equal(proxied.body.bitsTransaction.transactionID, 'tx-fixture');
  assert.equal(proxied.body.bitsTransaction.sku, 'bits5');
  assert.equal(proxied.body.bitsTransaction.amount, 5);
  assert.equal(proxied.body.bitsTransaction.inDevelopment, true);

  // Credit flow forwards TTS text too.
  const credit = await post('/v1/channels/555777/items/item-1/use-credit', validJwt(), { action: 'use_now', ttsText: 'credit fixture' });
  assert.equal(credit.status, 200, JSON.stringify(credit));
  const proxiedCredit = received.find((r) => r.url === '/extensions/dimafx/internal/channels/555777/items/item-1/use-credit');
  assert.equal(proxiedCredit?.body.ttsText, 'credit fixture', 'viewer TTS text forwarded on credit use');

  // Caller-supplied identity never overrides the verified Twitch JWT. The API
  // makes the final item decision using this trusted identity and its catalog.
  const anonymous = await post('/v1/channels/555777/items/item-2/purchase', validJwt({ user_id: undefined }), {
    sku: 'bits5', transactionID: 'tx-anonymous', transactionReceipt: receipt({ transactionId: 'tx-anonymous' }), action: 'use_now', ttsText: 'anonymous input',
    userID: 'spoofed-user', identityShared: true, displayName: 'spoofed-name',
  });
  assert.equal(anonymous.status, 200);
  const anonymousProxy = received.at(-1);
  assert.equal(anonymousProxy.body.userID, undefined, 'body cannot spoof a shared Twitch ID');
  assert.equal(anonymousProxy.body.identityShared, false, 'sharing flag is not trusted');
  assert.equal(anonymousProxy.body.displayName, undefined, 'display name is not trusted');
  assert.equal(anonymousProxy.body.opaqueUserID, 'Uop-1');
  const beforeAnonymousCredit = received.length;
  const anonymousCredit = await post('/v1/channels/555777/items/item-2/use-credit', validJwt({ user_id: undefined }), { userID: 'spoofed-user', identityShared: true, ttsText: 'anonymous input' });
  assert.equal(anonymousCredit.status, 403);
  assert.equal(received.length, beforeAnonymousCredit, 'anonymous credit attempt never proxied');

  // Channel mismatch is rejected before proxying.
  const before = received.length;
  const mismatch = await post('/v1/channels/555777/items/item-1/purchase', validJwt({ channel_id: '999000' }), { sku: 'x', transactionID: 'y' });
  assert.equal(mismatch.status, 403, 'channel mismatch rejected');
  assert.equal(received.length, before, 'mismatched request never reaches dimabot');

  // Bad signature and expired tokens are rejected.
  const badSig = await post('/v1/channels/555777/items/item-1/purchase', validJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }).slice(0, -2) + 'xx', { sku: 'x', transactionID: 'z' });
  assert.equal(badSig.status, 401, 'bad signature rejected');
  const expired = await post('/v1/channels/555777/items/item-1/purchase', validJwt({ exp: Math.floor(Date.now() / 1000) - 60 }), { sku: 'x', transactionID: 'w' });
  assert.equal(expired.status, 401, 'expired token rejected');

  const beforeInvalidReceipt = received.length;
  for (const transactionReceipt of [receipt({}, {}, Buffer.from('forged')), receipt({ userId: 'someone-else' })]) {
    assert.equal((await post('/v1/channels/555777/items/item-1/purchase', validJwt(), { transactionReceipt })).status, 400);
  }
  assert.equal(received.length, beforeInvalidReceipt, 'invalid receipts never reach the ledger');
  const loggedOut = validJwt({ user_id: undefined, opaque_user_id: 'Aanonymous' });
  for (const mutation of ['purchase', 'use-credit', 'redeem', 'tts-check']) {
    assert.equal((await post(`/v1/channels/555777/items/item-1/${mutation}`, loggedOut, { sku: 'free' })).status, 403);
  }
  for (const exp of [undefined, '9999999999']) assert.equal((await post('/v1/channels/555777/items/item-1/purchase', validJwt({ exp }), {})).status, 401);
  const ttsCheck = await post('/v1/channels/555777/items/item-1/tts-check', validJwt(), { userID: 'spoofed', ttsText: 'hello' });
  assert.equal(ttsCheck.status, 200);
  assert.equal(received.at(-1).body.userID, 'u-1');

  console.log('PASS: signed Bits receipt verification, auth expiry, logged-out gating, trusted TTS identity and service proxying');
} finally {
  stub.close();
}
