// Records the frozen TypeScript's answers over the production copy (`domdimabot`, read only:
// Mongoose connects with autoIndex and autoCreate off, and only read functions run) for every
// referral owner and referred account (stats, people and timeline pages) and every gift (the
// view its buyer sees). Text that could name a person (names, logins, labels, codes) is kept
// only as a SHA-256 prefix: the fixture holds ids and numbers. Run from the dimabot checkout:
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && SECRET_KEY=<64 zeros> TZ=UTC OBSERVABILITY_DISABLED=true \
//     node_modules/.bin/tsx "$REPO/dima-rust/crates/billing/tests/gifts_referrals_real/record.mts" \
//     "$REPO/dima-rust/crates/billing/tests/gifts_referrals_real/reference.json"
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const output = process.argv[2];
const HASHED = new Set(['name', 'login', 'displayName', 'label', 'code']);
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
const scrub = (value: any, key = ''): any => {
  if (Array.isArray(value)) return value.map(v => scrub(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  return HASHED.has(key) && typeof value === 'string' ? hash(value) : value;
};
const json = (v: any) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const sources: Record<string, string> = {};
for (const file of ['utils/referral.ts', 'utils/referral_ledger.ts', 'utils/credit_gifts.ts']) {
  sources[file] = createHash('sha256').update(await readFile(`${root}/src/${file}`)).digest('hex');
}
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: 'domdimabot', autoIndex: false, autoCreate: false });
try {
  const referral = await import(`${root}/src/utils/referral.ts`);
  const ledger = await import(`${root}/src/utils/referral_ledger.ts`);
  const gifts = await import(`${root}/src/utils/credit_gifts.ts`);
  const db = mongoose.connection.db;
  const owners = new Set<string>();
  for (const c of await db.collection('referralcodes').find({}).toArray()) owners.add(String(c.owner));
  for (const u of await db.collection('users').find({ referrerId: { $type: 'objectId' } }).toArray()) owners.add(String(u.referrerId));
  for (const t of await db.collection('credittransactions').find({}).toArray()) owners.add(String(t.user));
  const referrals: any[] = [];
  for (const owner of [...owners].sort()) {
    const id = new mongoose.Types.ObjectId(owner);
    const answer = async (run: () => Promise<any>) => { try { return { ok: scrub(json(await run())) }; } catch (e: any) { return { error: e.message }; } };
    referrals.push({ owner, stats: await answer(() => referral.getReferralStats(id)),
      people: await answer(() => ledger.getReferralPeoplePage(id, 0)), timeline: await answer(() => ledger.getReferralTimelinePage(id, 0)) });
  }
  const giftViews: any[] = [];
  for (const g of await db.collection('creditgifts').find({}).sort({ _id: 1 }).toArray()) {
    const buyer = await db.collection('users').findOne({ _id: g.buyerId });
    let view: any;
    try { view = { ok: scrub(json(await gifts.getCreditGift(g._id, buyer ?? { _id: g.buyerId }))) }; } catch (e: any) { view = { error: e.message }; }
    giftViews.push({ id: g._id, buyer: String(g.buyerId), view });
  }
  await writeFile(output, JSON.stringify({ reference: { commit: '0c71108e', sources }, referrals, gifts: giftViews }, null, 2) + '\n');
  console.log(`recorded ${referrals.length} referral owners and ${giftViews.length} gifts`);
} finally {
  await mongoose.disconnect();
  setTimeout(() => process.exit(0), 200).unref();
}
