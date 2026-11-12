// Records what the frozen TypeScript does for credit gifts (P2-BILLING-02b part 1): every
// document of `creditgifts` and the touched users, every request to Polar (method, target, the
// headers that matter, the body) with the answer the local mock gave, and every return value,
// for the scenario below. Polar is a stateful mock on loopback; MongoDB is a scratch database
// and Dragonfly logical database 9; the clock is fixed and moved by the script. Run from the
// dimabot checkout:
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/9 \
//     OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/billing/tests/gifts_recorded/record.mts" \
//     "$REPO/dima-rust/crates/billing/tests/gifts_recorded/typescript.json"
//
// Names, ids and e-mails are fictional. The database is dropped and the Dragonfly keys deleted
// at the end, also on failure.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON, ObjectId } = require('bson');
const output = process.argv[2];
const NOW = 1794484800000, MIN = 60_000, RealDate = Date;
let now = NOW;
class FixedDate extends RealDate { constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); } static now() { return now; } static [Symbol.hasInstance](v: any) { return v instanceof RealDate; } }
const database = `dima_test_billing_${randomUUID().replaceAll('-', '')}`;
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };
const json = (v: any) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const METER = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const PAIRS = [
  { paid: '6e0c530d-affc-44be-a51b-e11453ef1fa7', free: 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a', credits: 40_000, price: 999, benefit: 'ben_40k' },
  { paid: '815d0efe-1d23-4fca-8762-ae3a9253b0bc', free: '019b6291-80a0-4b31-bb09-feaaa9afe5eb', credits: 250_000, price: 4999, benefit: 'ben_250k' },
  { paid: '7d0d5f0e-102a-4255-abf3-6f379e2da4ce', free: '3f6010b6-4108-4bf9-ab83-b035eeed6962', credits: 550_000, price: 9999, benefit: 'ben_550k' },
];
const BUYER = '64b000000000000000000a01', RECIPIENT = '64b000000000000000000a02', OTHER = '64b000000000000000000a03',
  NOCUSTOMER = '64b000000000000000000a04', RECIPIENT2 = '64b000000000000000000a05', MISSING = '64b000000000000000000aff';
const CB = 'a1b2c3d4-0000-4000-8000-000000000001', CR = 'a1b2c3d4-0000-4000-8000-000000000002', CR2 = 'a1b2c3d4-0000-4000-8000-000000000005';
const user = (id: string, twitch: string, name: string, extra: any = {}) => ({
  _id: new ObjectId(id), name: name.toLowerCase(), email: `${name.toLowerCase()}@example.test`, language: 'en', plan_tier: 'free',
  accounts: [{ _id: new ObjectId(), type: 'twitch', id: twitch, name, actived: true }], token_balance: 0,
  created_at: new RealDate(NOW - 86_400_000), updated_at: new RealDate(NOW - 86_400_000), __v: 0, ...extra,
});
const users = [
  user(BUYER, '9101', 'GiftBuyer', { polar_sh_customer_id: CB }),
  user(RECIPIENT, '9102', 'GiftReceiver', { polar_sh_customer_id: CR, language: 'es' }),
  user(OTHER, '9103', 'GiftOther', { polar_sh_customer_id: null }),
  user(NOCUSTOMER, '9104', 'NoCustomerHere', { polar_sh_customer_id: null }),
  user(RECIPIENT2, '9105', 'GiftDeleted', { polar_sh_customer_id: CR2 }),
];
for (const u of users) u.accounts[0]._id = new ObjectId(u._id.toHexString().replace(/^64b/, '64c'));

// ------------------------------------------------------------------ the Polar mock (stateful)
const world: any = { checkouts: [] as any[], orders: [] as any[], grants: [] as any[], deleted: new Set<string>(), n: 0 };
const customerOf: Record<string, string> = { [CB]: BUYER, [CR]: RECIPIENT, [CR2]: RECIPIENT2 };
const product = (id: string) => {
  const pair = PAIRS.find(p => p.paid === id || p.free === id);
  if (!pair) return null;
  const free = pair.free === id;
  return { id, name: free ? 'Gift delivery' : ` Gift ${pair.credits} `, is_archived: false, is_recurring: false, visibility: 'public',
    prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: free ? 0 : pair.price, price_currency: free ? 'usd' : 'USD', is_archived: false },
      { type: 'one_time', amount_type: 'fixed', price_amount: 5, price_currency: 'usd', is_archived: true }],
    benefits: free ? [{ id: pair.benefit, type: 'meter_credit', is_deleted: false, properties: { units: pair.credits, rollover: true, meter_id: METER } }] : [] };
};
const page = (items: any[]) => ({ items, pagination: { total_count: items.length, max_page: 1 } });
function makeOrder(checkout: any) {
  const id = `ord_${++world.n}`;
  const order = { id, paid: true, status: 'paid', product_id: checkout.product_id, checkout_id: checkout.id, subscription_id: null,
    customer_id: checkout.customer_id, customer: { id: checkout.customer_id, external_id: checkout.customer_external_id, email: 'secret@example.test' },
    net_amount: checkout.total_amount, total_amount: checkout.total_amount, discount_amount: 0, refunded_amount: 0, currency: 'usd',
    metadata: checkout.metadata, created_at: new RealDate(now).toISOString() };
  world.orders.push(order);
  checkout.status = 'succeeded';
  return order;
}
function answer(method: string, url: URL, body: any): [number, any] {
  const p = url.pathname, q = url.searchParams;
  let m: RegExpMatchArray | null;
  if (method === 'GET' && (m = p.match(/^\/v1\/products\/([^/]+)$/))) { const x = product(m[1]); return x ? [200, x] : [404, { detail: 'nf' }]; }
  if (method === 'GET' && (m = p.match(/^\/v1\/customers\/([^/]+)\/state$/))) {
    const credited = world.grants.filter((g: any) => g.customer_id === m![1]).reduce((t: number, g: any) => t + g.benefit.properties.units, 0);
    return [200, { id: m[1], active_meters: [{ id: 'cm', meter_id: METER, consumed_units: 120, credited_units: credited, balance: credited - 120 }] }];
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/customers\/([^/]+)$/))) {
    if (!customerOf[m[1]]) return [404, { detail: 'nf' }];
    return [200, { id: m[1], external_id: customerOf[m[1]], email: 'secret@example.test', deleted_at: world.deleted.has(m[1]) ? new RealDate(now).toISOString() : null }];
  }
  if (method === 'POST' && p === '/v1/checkouts/') {
    const prod = product(body.products[0]);
    const amount = prod!.prices[0].price_amount;
    const checkout = { id: `chk_${++world.n}`, url: `https://sandbox.polar.test/checkout/polar_c_secret${world.n}`, client_secret: `polar_c_secret${world.n}`,
      status: 'open', product_id: body.products[0], customer_id: body.customer_id, customer_external_id: body.external_customer_id,
      customer_email: body.customer_email, amount, discount_amount: 0, total_amount: amount, currency: 'usd', metadata: body.metadata, success_url: body.success_url };
    world.checkouts.push(checkout);
    return [201, checkout];
  }
  if (method === 'GET' && p === '/v1/checkouts/') {
    return [200, page(world.checkouts.filter((c: any) => c.product_id === q.get('product_id') && c.customer_external_id === q.get('external_customer_id')))];
  }
  if (method === 'POST' && (m = p.match(/^\/v1\/checkouts\/client\/([^/]+)\/confirm$/))) {
    const checkout = world.checkouts.find((c: any) => c.client_secret === decodeURIComponent(m![1]));
    if (!checkout || checkout.status !== 'open') return [400, { detail: 'not open' }];
    checkout.status = 'confirmed';
    const order = makeOrder(checkout);
    const pair = PAIRS.find(x => x.free === checkout.product_id)!;
    world.grants.push({ id: `grant_${++world.n}`, order_id: order.id, customer_id: order.customer_id, benefit_id: pair.benefit, is_granted: true, is_revoked: false,
      granted_at: new RealDate(now).toISOString(), benefit: { id: pair.benefit, type: 'meter_credit', properties: { meter_id: METER, units: pair.credits, rollover: true } } });
    return [200, { ...checkout, status: 'confirmed' }];
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/checkouts\/([^/]+)$/))) { const c = world.checkouts.find((c: any) => c.id === m![1]); return c ? [200, c] : [404, { detail: 'nf' }]; }
  if (method === 'GET' && p === '/v1/orders/') return [200, page(world.orders.filter((o: any) => o.checkout_id === q.get('checkout_id')))];
  if (method === 'GET' && (m = p.match(/^\/v1\/orders\/([^/]+)$/))) { const o = world.orders.find((o: any) => o.id === decodeURIComponent(m![1])); return o ? [200, o] : [404, { detail: 'nf' }]; }
  if (method === 'GET' && p === '/v1/benefit-grants/') return [200, page(world.grants.filter((g: any) => g.customer_id === q.get('customer_id')))];
  return [501, { detail: 'unexpected' }];
}
let exchanges: any[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url!, 'http://mock');
    const [status, body] = answer(req.method!, url, raw ? JSON.parse(raw) : undefined);
    const text = JSON.stringify(body);
    exchanges.push({ method: req.method, target: req.url, headers: { authorization: req.headers.authorization, 'content-type': req.headers['content-type'] ?? null,
      'idempotency-key': req.headers['idempotency-key'] ?? null }, body: raw || null, status, response: text });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
process.env.POLARSH_OAT = 'rec-polar-token';
process.env.POLARSH_API_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.BILLING_SUCCESS_URL; delete process.env.BILLING_RETURN_URL; delete process.env.BILLING_ALLOWED_REDIRECT_HOSTS;

const sources: Record<string, string> = {};
for (const file of ['utils/credit_gifts.ts', 'utils/credit_gift_provider.ts', 'schemas/credit_gift.schema.ts', 'schemas/users.schema.ts', 'utils/billing.ts', 'domain_events/credit_gift_events.ts']) {
  sources[file] = createHash('sha256').update(await readFile(`${root}/src/${file}`)).digest('hex');
}
let cache: any;
try {
  await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: database, autoCreate: true, autoIndex: true });
  const gifts = await import(`${root}/src/utils/credit_gifts.ts`);
  const provider = await import(`${root}/src/utils/credit_gift_provider.ts`);
  const events = await import(`${root}/src/domain_events/credit_gift_events.ts`);
  const Users = (await import(`${root}/src/schemas/users.schema.ts`)).default;
  const { CreditGiftSchema } = await import(`${root}/src/schemas/credit_gift.schema.ts`);
  const { getDragonflyClient } = await import(`${root}/src/utils/databases/dragonfly.database.ts`);
  await CreditGiftSchema.init(); await Users.init();
  await Users.collection.insertMany(users);
  cache = await getDragonflyClient('record');
  globalThis.Date = FixedDate as any;
  const snapshot = async () => ({
    creditgifts: (await CreditGiftSchema.collection.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map((d: any) => bson(d)),
    users: (await Users.collection.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map((d: any) => bson(d)),
  });
  const steps: any[] = [];
  const chats: any[] = [];
  let chatAnswer: any = { error: false, data: { message_id: 'msg-1', is_sent: true } };
  const sendChat = async (channel: string, message: string) => { chats.push({ channel, message }); return chatAnswer; };
  const loadUser = async (id: string) => Users.findById(id);
  async function step(name: string, op: string, input: any, run: () => Promise<any>) {
    exchanges = [];
    let result: any;
    try { result = { ok: json(await run()) }; } catch (e: any) { result = { error: e.message, status: e.statusCode ?? null, request: e instanceof gifts.CreditGiftRequestError }; }
    steps.push({ name, op, now, input, result, requests: exchanges, documents: await snapshot(), chats: chats.splice(0) });
  }
  const create = (name: string, input: any) => step(name, 'create', input, async () => gifts.createCreditGiftCheckout({ ...input, user: await loadUser(input.userId) }));
  const work = (name: string) => step(name, 'process', {}, async () => gifts.processCreditGift({ sendChat }));
  const ok = { userId: BUYER, productId: PAIRS[0].paid, recipientId: RECIPIENT, requestId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', acknowledgeNoRefunds: true };

  await step('catalog', 'catalog', {}, async () => provider.getGiftPackCatalog());
  await step('find-exact', 'find', { login: ' @GiftReceiver ' }, async () => gifts.findGiftRecipient(' @GiftReceiver '));
  await step('find-missing', 'find', { login: 'nobody_here' }, async () => gifts.findGiftRecipient('nobody_here'));
  await step('find-invalid', 'find', { login: 'bad name!' }, async () => gifts.findGiftRecipient('bad name!'));
  await step('search', 'search', { query: 'GIFT', buyer: BUYER }, async () => gifts.searchGiftRecipients('GIFT', await loadUser(BUYER)));
  await step('search-short', 'search', { query: '@ab', buyer: BUYER }, async () => gifts.searchGiftRecipients('@ab', await loadUser(BUYER)));
  await create('create-no-ack', { ...ok, acknowledgeNoRefunds: false });
  await create('create-bad-request', { ...ok, requestId: 'not-a-uuid' });
  await create('create-bad-product', { ...ok, productId: 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a' });
  await create('create-self', { ...ok, recipientId: BUYER });
  await create('create-missing-recipient', { ...ok, recipientId: MISSING });
  await create('create-recipient-no-customer', { ...ok, recipientId: NOCUSTOMER });
  await create('create-bad-host', { ...ok, successUrl: 'https://evil.example/x' });
  await create('create-http', { ...ok, returnUrl: 'http://domdimabot.com/back' });
  await create('create', { ...ok, successUrl: 'https://www.domdimabot.com/dashboard?tab=gifts&gift=old&x=a b' });
  const giftId = createHash('sha256').update(`${BUYER}:${ok.requestId}`).digest('hex');
  await create('create-repeat', ok);
  await create('create-other-pack', { ...ok, productId: PAIRS[1].paid });
  await step('view-buyer', 'view', { id: giftId, userId: BUYER }, async () => gifts.getCreditGift(giftId, await loadUser(BUYER)));
  await step('view-stranger', 'view', { id: giftId, userId: OTHER }, async () => gifts.getCreditGift(giftId, await loadUser(OTHER)));
  await step('view-bad-id', 'view', { id: 'XYZ', userId: BUYER }, async () => gifts.getCreditGift('XYZ', await loadUser(BUYER)));
  now += MIN; await work('work-unpaid');
  // The buyer pays at Polar.
  const order = makeOrder(world.checkouts.find((c: any) => c.metadata?.gift_id === giftId));
  now += MIN; await step('event-other-source', 'event', { source: 'twitch-eventsub', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: true } },
    async () => events.applyCreditGiftDomainEvent({ source: 'twitch-eventsub', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: true } }));
  await step('event-unpaid', 'event', { source: 'polar-webhook', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: false } },
    async () => events.applyCreditGiftDomainEvent({ source: 'polar-webhook', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: false } }));
  await step('event-paid', 'event', { source: 'polar-webhook', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: true } },
    async () => events.applyCreditGiftDomainEvent({ source: 'polar-webhook', type: 'billing.order.paid', payload: { orderId: order.id, productId: PAIRS[0].paid, paid: true } }));
  now += MIN; await step('accept-again', 'accept', { orderId: order.id }, async () => gifts.acceptCreditGiftPaidOrder(order.id));
  await create('create-after-paid', ok);
  now += MIN; await work('work-fulfillment');
  now += MIN; await work('work-confirm');
  now += MIN; await work('work-deliver');
  now += MIN; await work('work-announce');
  now += MIN; await work('work-idle');
  // Gift 2: paid without a webhook (the worker reconciles), then held for moderation.
  const second = { ...ok, requestId: '6f1c2a3b-4d5e-4f60-9a7b-8c9d0e1f2a3b', productId: PAIRS[1].paid };
  now += MIN; await create('create-second', second);
  const secondId = createHash('sha256').update(`${BUYER}:${second.requestId}`).digest('hex');
  makeOrder(world.checkouts.find((c: any) => c.metadata?.gift_id === secondId));
  now += MIN; await work('work-second-reconcile');
  now += MIN; await work('work-second-fulfillment');
  now += MIN; await work('work-second-confirm');
  now += MIN; await work('work-second-deliver');
  chatAnswer = { error: true, type: 'held_for_moderation' };
  now += MIN; await work('work-second-held');
  // Gift 3: the recipient's Polar customer is deleted before delivery: the failure is counted.
  const third = { ...ok, requestId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', productId: PAIRS[2].paid, recipientId: RECIPIENT2 };
  now += MIN; await create('create-third', third);
  const thirdId = createHash('sha256').update(`${BUYER}:${third.requestId}`).digest('hex');
  makeOrder(world.checkouts.find((c: any) => c.metadata?.gift_id === thirdId));
  now += MIN; await work('work-third-reconcile');
  world.deleted.add(CR2);
  now += MIN; await work('work-third-deleted');
  now += 20_000; await work('work-third-again');
  globalThis.Date = RealDate;
  const keys: string[] = [];
  for (const id of ['9101', '9102', '9105']) for (const k of await cache.keys(`*${id}*`)) keys.push(k);
  const credits = await cache.get('twitch:9102:ai:credits');
  for (const k of keys) await cache.del(k);
  await writeFile(output, JSON.stringify({ reference: { commit: '0c71108e', sources }, now: NOW, users: users.map(u => bson(u)), steps,
    recipientCredits: credits ? JSON.parse(credits) : null }, null, 2) + '\n');
  console.log(`recorded ${steps.length} gift steps`);
} finally {
  globalThis.Date = RealDate;
  // Collections Mongoose creates in the background (autoCreate) must not outlive the drop.
  await new Promise(r => setTimeout(r, 1_000));
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
  await cache?.quit?.().catch?.(() => {});
  setTimeout(() => process.exit(0), 200).unref();
}
