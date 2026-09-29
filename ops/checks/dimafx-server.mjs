// DimaFX extension-server check (no database dependencies).
// Verifies JWT verification (valid/mismatch/bad-signature/expired), service
// token forwarding, and that viewer TTS text is proxied to dimabot on both
// purchase and credit flows.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const root = 'http://127.0.0.1:8080';
const secret = process.env.TWITCH_EXTENSION_SECRET;
assert.ok(secret, 'TWITCH_EXTENSION_SECRET is required');

const b64u = (value) => Buffer.from(value).toString('base64url');
const jwt = (payload, key = Buffer.from(secret, 'base64')) => {
  const unsigned = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
};
const validJwt = (overrides = {}) => jwt({
  channel_id: '555777', user_id: 'u-1', opaque_user_id: 'op-1', role: 'viewer',
  exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
});

const received = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, serviceToken: req.headers['x-dimafx-service-token'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: false, status: 200, data: { ok: true } }));
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

  // Purchase: TTS text and identity are proxied to dimabot.
  const purchase = await post('/v1/channels/555777/items/item-1/purchase', validJwt(), {
    sku: 'dimafx_bits_5', transactionID: 'tx-fixture', action: 'use_now', ttsText: 'hello fixture',
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase));
  const proxied = received.find((r) => r.url === '/extensions/dimafx/internal/channels/555777/items/item-1/purchase');
  assert.ok(proxied, 'purchase proxied to dimabot');
  assert.equal(proxied.serviceToken, 'fixture-service-token', 'service token forwarded');
  assert.equal(proxied.body.userID, 'u-1');
  assert.equal(proxied.body.ttsText, 'hello fixture', 'viewer TTS text forwarded on purchase');
  assert.equal(proxied.body.transactionID, 'tx-fixture');

  // Credit flow forwards TTS text too.
  const credit = await post('/v1/channels/555777/items/item-1/use-credit', validJwt(), { action: 'use_now', ttsText: 'credit fixture' });
  assert.equal(credit.status, 200, JSON.stringify(credit));
  const proxiedCredit = received.find((r) => r.url === '/extensions/dimafx/internal/channels/555777/items/item-1/use-credit');
  assert.equal(proxiedCredit?.body.ttsText, 'credit fixture', 'viewer TTS text forwarded on credit use');

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

  console.log('PASS: JWT verification, service-token proxying, and TTS text forwarding on purchase/credit flows');
} finally {
  stub.close();
}
