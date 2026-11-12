// Records what the frozen TypeScript does for referrals, paid-order rewards and the Polar
// account cancellation (P2-BILLING-02b parts 2 and 3): every document of `referralcodes`,
// `credittransactions` and `users`, every request to Polar with the mock's answer, and every
// return value, against a scratch MongoDB database with the clock fixed and moved by the
// script. Run from the dimabot checkout:
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && SECRET_KEY=<64 zeros> TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/9 \
//     OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/billing/tests/referrals_recorded/record.mts" \
//     "$REPO/dima-rust/crates/billing/tests/referrals_recorded/typescript.json"
//
// (`SECRET_KEY` only satisfies an import; nothing is encrypted.) Names and ids are fictional.
// The database is dropped at the end, also on failure.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON, ObjectId } = require('bson');
const output = process.argv[2];
const NOW = 1794484800000, MIN = 60_000, DAY = 86_400_000, RealDate = Date;
let now = NOW;
class FixedDate extends RealDate { constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); } static now() { return now; } static [Symbol.hasInstance](v: any) { return v instanceof RealDate; } }
const database = `dima_test_billing_${randomUUID().replaceAll('-', '')}`;
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };
const json = (v: any) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const PREMIUM = '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134', PRO = '1468eea1-7ad0-40d2-b828-4d4cd6b4abdc', FREE = 'fccf0669-adab-447d-89c8-d77d8b83bea5';
const id = (n: number) => new ObjectId(`64d0000000000000000000${n.toString(16).padStart(2, '0')}`);
const OWNER = id(1), PREM = id(2), BOT = id(3), U1 = id(4), U2 = id(5), U3 = id(6), N = id(7), M = id(8), GONE = id(9), LONE = id(10);
const user = (_id: any, name: string, extra: any = {}) => ({ _id, name, email: `${name}@example.test`, plan_tier: 'free',
  accounts: [{ _id: new ObjectId(_id.toHexString().replace(/^64d/, '64e')), type: 'twitch', id: `t-${name}`, name }],
  referrerId: null, referralCodeUsed: null, created_at: new RealDate(NOW - 30 * DAY), updated_at: new RealDate(NOW - 30 * DAY), __v: 0, ...extra });
const users = [
  user(OWNER, 'owner', { token_balance: 100, polar_sh_customer_id: 'a1b2c3d4-0000-4000-8000-0000000000a1' }),
  user(PREM, 'premiumowner', { plan_tier: 'premium' }),
  user(BOT, 'domdimabot', { token_balance: 10 }),
  user(U1, 'referred1', { referrerId: OWNER, referralCodeUsed: 'camp1', created_at: new RealDate(NOW - 5 * DAY), plan_tier: 'premium' }),
  user(U2, 'referred2', { referrerId: OWNER, referralCodeUsed: 'CAMP1', created_at: new RealDate(NOW - 4 * DAY) }),
  user(U3, 'referred3', { referrerId: OWNER, referralCodeUsed: 'gone', created_at: new RealDate(NOW - 3 * DAY) }),
  user(N, 'newcomer'),
  user(M, 'other'),
  user(LONE, 'lonely', { referrerId: GONE, referralCodeUsed: 'ghost' }),
];
delete (users[6] as any).referrerId; delete (users[6] as any).referralCodeUsed; delete (users[6] as any).token_balance;
const tx = (n: number, extra: any) => ({ _id: id(0x40 + n), createdAt: new RealDate(NOW - (10 - n) * DAY), updatedAt: new RealDate(NOW - (10 - n) * DAY), __v: 0, balanceAfter: null, ...extra });
const transactions = [
  tx(1, { user: OWNER, type: 'referral_bonus', amount: 100, metadata: { referralCodeUsed: 'camp1', referredUserId: U1, subscriptionId: 'sub-legacy', planId: PREMIUM, description: 'Referral bonus for PREMIUM subscription', externalReference: null } }),
  tx(2, { user: OWNER, type: 'subscription_reward', amount: 50, idempotencyKey: 'polar:paid-order:old-1', appliedAt: new RealDate(NOW - 2 * DAY), metadata: { referralCodeUsed: 'camp1', referredUserId: U1, subscriptionId: 'old-1', planId: PREMIUM, description: 'x', externalReference: 'polar:paid-order:old-1', rewardTargetType: 'referrer' } }),
  tx(3, { user: OWNER, type: 'subscription_reward', amount: 70, idempotencyKey: 'polar:paid-order:old-2', metadata: { referralCodeUsed: 'camp1', referredUserId: U1, subscriptionId: 'old-2', planId: PREMIUM, description: 'unapplied', externalReference: 'polar:paid-order:old-2', rewardTargetType: 'referrer' } }),
  tx(4, { user: BOT, type: 'subscription_reward', amount: 50, metadata: { referralCodeUsed: null, referredUserId: M, subscriptionId: 'order-legacy', planId: PREMIUM, description: 'legacy', externalReference: 'x', rewardTargetType: 'bot' } }),
  tx(5, { user: OWNER, type: 'subscription_reward', amount: 25, metadata: { referralCodeUsed: 'CAMP1', referredUserId: U2, subscriptionId: 'old-3', planId: PREMIUM, description: 'legacy capital', externalReference: 'y', rewardTargetType: 'referrer' } }),
];

// ------------------------------------------------------------------ the Polar mock (subscriptions)
const subs: any[] = [
  { id: 'sub_a', status: 'active', external_customer_id: OWNER.toHexString(), customer_id: 'a1b2c3d4-0000-4000-8000-0000000000a1' },
  { id: 'sub_b', status: 'canceled', external_customer_id: OWNER.toHexString(), customer_id: 'a1b2c3d4-0000-4000-8000-0000000000a1' },
  { id: 'sub_c', status: 'trialing', external_customer_id: OWNER.toHexString(), customer_id: 'a1b2c3d4-0000-4000-8000-0000000000a1' },
  { id: 'sub_d', status: 'past_due', external_customer_id: 'someone-else', customer_id: 'a1b2c3d4-0000-4000-8000-0000000000a1' },
  { id: 'sub_e', status: 'unpaid', external_customer_id: PREM.toHexString(), customer_id: null },
];
const failRevoke = new Set<string>(['sub_d']);
let stuck = false;
function answer(method: string, url: URL): [number, any] {
  const p = url.pathname, q = url.searchParams;
  let m: RegExpMatchArray | null;
  if (method === 'GET' && p === '/v1/subscriptions/') {
    const key = q.has('customer_id') ? 'customer_id' : 'external_customer_id';
    const all = subs.filter(s => s[key] === q.get(key));
    const page = Number(q.get('page'));
    return [200, { items: all.slice((page - 1) * 2, page * 2), pagination: { total_count: all.length, max_page: Math.max(1, Math.ceil(all.length / 2)) } }];
  }
  if (method === 'DELETE' && (m = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
    const s = subs.find(x => x.id === m![1]);
    if (!s) return [404, { detail: 'nf' }];
    if (failRevoke.has(s.id)) { if (!stuck) s.status = 'canceled'; return [409, { detail: 'conflict', email: 'secret@example.test' }]; }
    s.status = 'canceled';
    return [200, s];
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) { const s = subs.find(x => x.id === m![1]); return s ? [200, s] : [404, { detail: 'nf' }]; }
  return [501, { detail: 'unexpected' }];
}
let exchanges: any[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const [status, body] = answer(req.method!, new URL(req.url!, 'http://mock'));
    const text = JSON.stringify(body);
    exchanges.push({ method: req.method, target: req.url, headers: { authorization: req.headers.authorization, 'content-type': req.headers['content-type'] ?? null,
      'idempotency-key': req.headers['idempotency-key'] ?? null }, body: raw || null, status, response: text });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
process.env.POLARSH_OAT = 'rec-polar-token';
process.env.POLARSH_API_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;

const sources: Record<string, string> = {};
for (const file of ['utils/referral.ts', 'utils/referral_ledger.ts', 'utils/paid_order_reward.ts', 'utils/polar_account_cancellation.ts',
  'domain_events/polar_billing_events.ts', 'schemas/referral_code.schema.ts', 'schemas/credit_transaction.schema.ts', 'schemas/users.schema.ts']) {
  sources[file] = createHash('sha256').update(await readFile(`${root}/src/${file}`)).digest('hex');
}
try {
  await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: database, autoCreate: true, autoIndex: true });
  const referral = await import(`${root}/src/utils/referral.ts`);
  const ledger = await import(`${root}/src/utils/referral_ledger.ts`);
  const reward = await import(`${root}/src/utils/paid_order_reward.ts`);
  const cancel = await import(`${root}/src/utils/polar_account_cancellation.ts`);
  const billingEvents = await import(`${root}/src/domain_events/polar_billing_events.ts`);
  const Users = (await import(`${root}/src/schemas/users.schema.ts`)).default;
  const { ReferralCodeSchema } = await import(`${root}/src/schemas/referral_code.schema.ts`);
  const { CreditTransactionSchema } = await import(`${root}/src/schemas/credit_transaction.schema.ts`);
  await Promise.all([Users.init(), ReferralCodeSchema.init(), CreditTransactionSchema.init()]);
  await Users.collection.insertMany(users);
  await CreditTransactionSchema.collection.insertMany(transactions);
  await ReferralCodeSchema.collection.insertOne({ _id: id(0x30), code: 'gone', owner: OWNER, label: 'old', stats: { conversions: 3 }, active: false,
    createdAt: new RealDate(NOW - 20 * DAY), updatedAt: new RealDate(NOW - 20 * DAY), __v: 0 });
  globalThis.Date = FixedDate as any;
  const snapshot = async () => {
    const all = async (model: any) => (await model.collection.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map((d: any) => bson(d));
    return { referralcodes: await all(ReferralCodeSchema), credittransactions: await all(CreditTransactionSchema), users: await all(Users) };
  };
  const steps: any[] = [];
  async function step(name: string, op: string, input: any, run: () => Promise<any>) {
    now += MIN;
    exchanges = [];
    let result: any;
    try { result = { ok: json(await run()) }; } catch (e: any) { result = { error: e.message, prerequisite: e?.constructor?.name === 'DomainEventPrerequisiteMissingError' }; }
    steps.push({ name, op, now, input, result, requests: exchanges, documents: await snapshot() });
  }
  const oid = (h: string) => new mongoose.Types.ObjectId(h);
  const codeId = async (code: string) => (await ReferralCodeSchema.findOne({ code }).lean())!._id;
  const create = (name: string, owner: any, code: string, label: string) =>
    step(name, 'create', { owner: owner.toHexString(), code, label }, async () => referral.createCampaignCode(owner, code, label));
  await create('create-free', OWNER, 'Camp1', 'Launch 🚀 day');
  await create('create-over-limit', OWNER, 'second', '');
  await create('create-invalid', PREM, 'bad-code!', '');
  await create('create-taken', PREM, 'CAMP1', '');
  await create('create-taken-inactive', PREM, 'GONE', '');
  await create('create-long-label', PREM, 'p_code', 'é'.repeat(60));
  await create('create-no-user', id(0x2f), 'nobody', '');
  for (const [name, owner] of [['codes-owner', OWNER], ['codes-premium', PREM]] as const) {
    await step(name, 'codes', { owner: owner.toHexString() }, async () => referral.getUserCodes(owner));
  }
  for (const code of ['CAMP1', 'gone', 'nope']) {
    await step(`find-${code}`, 'find', { code }, async () => { const found = await ReferralCodeSchema.findByCode(code); return found ? { code: found.code, owner: found.owner } : null; });
  }
  const apply = (name: string, user: any, code: string) => step(name, 'apply', { user: user.toHexString(), code }, async () => referral.applyReferralCode(user, code));
  await apply('apply-newcomer', N, 'camp1');
  await apply('apply-second-code', N, 'p_code');
  await apply('apply-self', OWNER, 'camp1');
  await apply('apply-unknown', M, 'unknown');
  await apply('apply-inactive', M, 'gone');
  const reward_ = (name: string, input: any) => step(name, 'reward', input, async () => reward.applyPaidOrderReward(input));
  await reward_('reward-referrer', { ownerUserId: U1.toHexString(), orderId: 'order-1', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-repeat', { ownerUserId: U1.toHexString(), orderId: 'order-1', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-newcomer-pro-yearly', { ownerUserId: N.toHexString(), orderId: 'order-2', productId: PRO, cadence: 'yearly' });
  await reward_('reward-capital-code', { ownerUserId: U2.toHexString(), orderId: 'order-3', productId: PRO, cadence: 'monthly' });
  await reward_('reward-inactive-code', { ownerUserId: U3.toHexString(), orderId: 'order-4', productId: PREMIUM, cadence: 'yearly' });
  await reward_('reward-deleted-referrer', { ownerUserId: LONE.toHexString(), orderId: 'order-5', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-free', { ownerUserId: U1.toHexString(), orderId: 'order-6', productId: FREE, cadence: 'monthly' });
  await reward_('reward-unknown-product', { ownerUserId: U1.toHexString(), orderId: 'order-7', productId: 'other', cadence: 'monthly' });
  await reward_('reward-legacy', { ownerUserId: M.toHexString(), orderId: 'order-legacy', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-bad-owner', { ownerUserId: 'twitch-id', orderId: 'order-8', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-empty-order', { ownerUserId: U1.toHexString(), orderId: ' ', productId: PREMIUM, cadence: 'monthly' });
  await reward_('reward-missing-owner', { ownerUserId: id(0x2e).toHexString(), orderId: 'order-9', productId: PREMIUM, cadence: 'monthly' });
  const event = (name: string, payload: any, owner: any) => step(name, 'event', { payload, owner: owner ? owner.toHexString() : null }, async () =>
    billingEvents.applyPolarRewardDomainEvent({ source: 'polar-webhook', type: 'billing.order.paid', payload, ownerUserId: owner?.toHexString() } as any,
      { getOwner: async (e: any) => { const u = e.ownerUserId && await Users.findById(e.ownerUserId).lean(); if (!u) throw new (await import(`${root}/src/domain_events/domain_event.types.ts`)).DomainEventPrerequisiteMissingError('owner:Polar owner no longer exists'); return u; } }));
  await event('event-trial', { orderId: 'order-10', paid: true, productId: PREMIUM, subscriptionId: 'sub-10', totalAmount: 0, cadence: 'monthly' }, U1);
  await event('event-one-time', { orderId: 'order-11', paid: true, productId: PREMIUM, totalAmount: 500, cadence: 'monthly' }, U1);
  await event('event-pack', { orderId: 'order-12', paid: true, productId: 'pack', subscriptionId: 's', totalAmount: 500, cadence: 'monthly' }, U1);
  await event('event-no-cadence', { orderId: 'order-13', paid: true, productId: PRO, subscriptionId: 's', totalAmount: 500 }, U1);
  await event('event-unpaid', { orderId: 'order-14', paid: false, productId: PRO, subscriptionId: 's', totalAmount: 500, cadence: 'monthly' }, U1);
  await event('event-paid', { orderId: 'order-15', paid: true, productId: PRO, subscriptionId: 's', totalAmount: 1500, cadence: 'monthly' }, U1);
  await event('event-no-owner', { orderId: 'order-16', paid: true, productId: PRO, subscriptionId: 's', totalAmount: 1500, cadence: 'monthly' }, id(0x2d));
  await step('stats-owner', 'stats', { owner: OWNER.toHexString() }, async () => referral.getReferralStats(OWNER));
  await step('stats-premium', 'stats', { owner: PREM.toHexString() }, async () => referral.getReferralStats(PREM));
  await step('stats-missing', 'stats', { owner: id(0x2c).toHexString() }, async () => referral.getReferralStats(id(0x2c)));
  for (const page of [0, 1]) {
    await step(`people-${page}`, 'people', { owner: OWNER.toHexString(), page }, async () => ledger.getReferralPeoplePage(OWNER, page));
    await step(`timeline-${page}`, 'timeline', { owner: OWNER.toHexString(), page }, async () => ledger.getReferralTimelinePage(OWNER, page));
  }
  await step('delete-not-owner', 'delete', { owner: PREM.toHexString(), code: 'camp1' }, async () => referral.deleteCampaignCode(PREM, await codeId('camp1')));
  await step('delete', 'delete', { owner: OWNER.toHexString(), code: 'camp1' }, async () => referral.deleteCampaignCode(OWNER, await codeId('camp1')));
  await step('delete-again', 'delete', { owner: OWNER.toHexString(), code: 'camp1' }, async () => referral.deleteCampaignCode(OWNER, await codeId('camp1')));
  await step('stats-after-delete', 'stats', { owner: OWNER.toHexString() }, async () => referral.getReferralStats(OWNER));
  await step('create-after-delete', 'create', { owner: OWNER.toHexString(), code: 'camp2', label: '' }, async () => referral.createCampaignCode(OWNER, 'camp2', ''));
  const revoke = (name: string, who: any) => step(name, 'revoke', { user: who.toHexString() }, async () => cancel.revokePolarSubscriptionsForAccount(who.toHexString()));
  await revoke('revoke-owner', OWNER);
  await revoke('revoke-again', OWNER);
  await revoke('revoke-premium', PREM);
  await revoke('revoke-missing', id(0x2b));
  subs.push({ id: 'sub_f', status: 'active', external_customer_id: M.toHexString(), customer_id: null });
  failRevoke.add('sub_f'); stuck = true;
  await revoke('revoke-stuck', M);
  globalThis.Date = RealDate;
  await writeFile(output, JSON.stringify({ reference: { commit: '0c71108e', sources }, now: NOW, fixtures: { users: users.map(bson), credittransactions: transactions.map(bson),
    referralcodes: [bson({ _id: id(0x30), code: 'gone', owner: OWNER, label: 'old', stats: { conversions: 3 }, active: false, createdAt: new RealDate(NOW - 20 * DAY), updatedAt: new RealDate(NOW - 20 * DAY), __v: 0 })] },
    subscriptions: [], steps }, null, 2) + '\n');
  console.log(`recorded ${steps.length} referral, reward and cancellation steps`);
} finally {
  globalThis.Date = RealDate;
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
