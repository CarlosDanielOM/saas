import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.TWITCH_EXTENSION_SECRET = Buffer.from('fixture-extension-secret').toString('base64');
process.env.DIMAFX_SERVICE_TOKEN = 'fixture-service-token';
process.env.NODE_ENV = 'test';
const { verifyBitsReceipt, assertProductionConfiguration } = await import('./middleware/twitch-extension-auth.js');
const { createServer } = await import('./server.js');
const { dimabotClient, DimabotClient } = await import('./services/dimabot-client.js');
const secret = Buffer.from(process.env.TWITCH_EXTENSION_SECRET, 'base64');
const jwt = (payload: object, key = secret) => {
  const body = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
};
const auth = (extra = {}) => jwt({ channel_id: '42', user_id: '77', opaque_user_id: 'U77', exp: Date.now() / 1000 + 3600, ...extra });
const receipt = (extra = {}, product = {}, top = {}) => jwt({ topic: 'bits_transaction_receipt', exp: 1,
  data: { transactionId: 'verified-tx', userId: '77', time: new Date().toISOString(), product: { sku: 'dimafx_bits_5', cost: { amount: 5, type: 'bits' }, ...product }, ...extra }, ...top });
const identity = { channelID: '42', userID: '77', token: '', identityShared: true };
const calls: Record<string, unknown>[] = [];
mock.method(dimabotClient, 'post', async (_path: string, body: Record<string, unknown>) => { calls.push(body); return { error: false, status: 200, data: { accepted: true } }; });
const server = createServer().listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
const post = async (body: object, token = auth(), path = 'purchase') => {
  const response = await fetch(`${base}/v1/channels/42/items/item/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test('forged, wrong-user, wrong-topic and non-Bits receipts are rejected before forwarding', async () => {
  const forged = jwt({ topic: 'bits_transaction_receipt' }, Buffer.from('attacker'));
  const before = calls.length;
  for (const transactionReceipt of [forged, receipt({ userId: '88' }), receipt({}, {}, { topic: 'other' }), receipt({}, { cost: { amount: 5, type: 'money' } })]) {
    assert.equal((await post({ transactionReceipt })).status, 400);
  }
  assert.equal(calls.length, before);
});
test('verified receipt fields replace client identity, SKU, transaction and price; expired receipt can resume', async () => {
  assert.equal((await post({ transactionReceipt: receipt(), transactionID: 'fake', sku: 'fake', userID: 'fake', amount: 999, action: 'use_now' })).status, 200);
  const body = calls.at(-1)!;
  assert.equal(body.transactionID, undefined);
  assert.deepEqual(body.bitsTransaction, { transactionID: 'verified-tx', userID: '77', sku: 'dimafx_bits_5', amount: 5, time: (body.bitsTransaction as { time: string }).time, inDevelopment: false });
  assert.equal(body.userID, '77');
});
test('signed time prevents replay after claim TTL; Hosted Test products have an explicit switch', () => {
  assert.equal(verifyBitsReceipt(receipt({ time: new Date(Date.now() - 31 * 86400_000).toISOString() }), identity), null);
  assert.equal(verifyBitsReceipt(receipt({}, { inDevelopment: true }), identity)?.inDevelopment, true);
  process.env.DIMAFX_REJECT_DEVELOPMENT_PRODUCTS = 'true';
  assert.equal(verifyBitsReceipt(receipt({}, { inDevelopment: true }), identity), null);
  delete process.env.DIMAFX_REJECT_DEVELOPMENT_PRODUCTS;
});
test('A viewers cannot mutate free, credits, saved copies or config; Bits receipt supplies unshared buyer', async () => {
  const token = auth({ opaque_user_id: 'A77', user_id: undefined });
  for (const path of ['purchase', 'use-credit', 'redeem']) assert.equal((await post({ sku: 'free' }, token, path)).status, 403);
  assert.equal((await post({ transactionReceipt: receipt() }, token)).status, 200);
  assert.equal(calls.at(-1)!.userID, undefined);
  assert.equal((calls.at(-1)!.bitsTransaction as { userID: string }).userID, '77');
  const config = await fetch(`${base}/v1/channels/42/me/config`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(config.status, 403);
});
test('TTS pre-check requires a logged-in shared identity and forwards only JWT identity', async () => {
  assert.equal((await post({ userID: 'spoofed', ttsText: 'hello' }, auth({ user_id: undefined }), 'tts-check')).status, 403);
  assert.equal((await post({ userID: 'spoofed', ttsText: 'hello' }, auth(), 'tts-check')).status, 200);
  assert.equal(calls.at(-1)!.userID, '77'); assert.equal(calls.at(-1)!.ttsText, 'hello');
});
test('auth JWT requires numeric future exp; production rejects missing credentials or bypass mode', async () => {
  for (const exp of [undefined, '9999999999', 1, null]) assert.equal((await post({}, auth({ exp }))).status, 401);
  process.env.NODE_ENV = 'production'; process.env.DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT = 'true';
  assert.throws(assertProductionConfiguration, /must be disabled/);
  delete process.env.DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT;
  process.env.TWITCH_EXTENSION_SECRET = '';
  assert.throws(assertProductionConfiguration, /TWITCH_EXTENSION_SECRET/);
  process.env.TWITCH_EXTENSION_SECRET = secret.toString('base64'); process.env.NODE_ENV = 'test';
});
test('ambiguous mutations are never retried; only reads and receipt-claimed purchases may fall back', async () => {
  const nativeFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('ambiguous network failure'); };
  try {
    const client = new DimabotClient();
    for (const path of ['/use-credit', '/redeem', '/purchase']) { attempts = 0; await client.post(path, {}); assert.equal(attempts, 1, path); }
    attempts = 0; await client.patch('/config', {}); assert.equal(attempts, 1);
    attempts = 0; await client.post('/purchase', { bitsTransaction: {} }); assert.equal(attempts, 2);
    attempts = 0; await client.get('/items'); assert.equal(attempts, 2);
  } finally { globalThis.fetch = nativeFetch; }
});
