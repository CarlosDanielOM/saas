// Records the reference's Bits rules (bits_rules/model.ts, bits_rules/store.ts) for
// tests/bits_rules.rs. Pure functions over tables of inputs; the store against a scratch
// database `dima_test_features_<random>` (dropped afterwards) with a fixed clock; and read-only
// loads of the local production copy `domdimabot` (ids, amounts and hashes only).
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/features/tests/bits_rules_record.mts" \
//     "$REPO/dima-rust/crates/features/tests/bits_rules_reference.json"
//
// What the imports start: store.ts loads mongoose, the eventsub schema and utils/eventsub.ts
// (which imports the Twitch token helpers and the streamer directory: module-level constants
// only, no client, no timer). The MongoDB connection is made by the reference's own
// getMongoDBConnection with MONGO_URI pointing at the scratch database; telemetry stays off
// (OBSERVABILITY_DISABLED, no DRAGONFLY_HOST). Nothing talks to Twitch.
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON, Double } = require('bson');
const output = process.argv[2];
const base = process.env.DIMA_TEST_MONGO_URI!;
if (!base || !output) throw Error('DIMA_TEST_MONGO_URI and an output path are required');
delete process.env.DRAGONFLY_HOST;
// utils/crypto.ts refuses to load without a key; nothing here encrypts. A test key, never the real one.
process.env.SECRET_KEY = 'dima-features-test-key';
const database = `dima_test_features_${randomUUID().replaceAll('-', '')}`;
const withDb = (uri: string, db: string) => { const u = new URL(uri); u.pathname = `/${db}`; return u.toString(); };
process.env.MONGO_URI = withDb(base, database);

const RealDate = Date;
let now = 1794355200000;
class FixedDate extends RealDate {
  constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); }
  static now() { return now; }
  static [Symbol.hasInstance](v: any) { return v instanceof RealDate; }
}
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const outcome = (run: () => unknown) => { try { return { ok: run() }; } catch (e: any) { return { error: e.message, status: e.status ?? null }; } };

const model = await import(`${root}/src/bits_rules/model.ts`);
const rule = (id: string, min: number, max: number | null, extra: any = {}) => ({ id, name: id, enabled: true, min, max, chat: { mode: 'custom', message: `say ${id}` }, alert: true, ...extra });

// Matching: rule sets against a table of amounts.
const sets: Record<string, any[]> = {
  ranges: [rule('any', 1, null), rule('hundreds', 100, 999), rule('thousand', 1000, null), rule('nice', 69, 69), rule('wide', 50, 150)],
  overlaps: [rule('a', 10, 100), rule('b', 50, 60), rule('c', 50, 60), rule('d', 55, 65), rule('e', 1, 1000000)],
  gaps: [rule('low', 1, 9), rule('mid', 20, 29), rule('high', 100, 100)],
  open: [rule('ten', 10, null), rule('hundred', 100, null), rule('also-ten', 10, null), rule('one', 1, null)],
  disabled: [rule('off', 1, null, { enabled: false }), rule('on', 5, 5), rule('off2', 5, 5, { enabled: false })],
  modes: [rule('custom', 1, 10), rule('silent', 11, 20, { chat: { mode: 'silent', message: '' } }), rule('default', 21, 30, { chat: { mode: 'default', message: 'ignored' } }), rule('chatless-alert', 31, 40, { alert: false })],
  empty: [],
  max: [rule('top', 1000000, 1000000), rule('all', 1, null)],
};
const amounts: any[] = [0, -0, -5, 1, 1.5, 5, 9, 10, 15, 25, 35, 50, 55, 60, 69, 99, 100, 101, 999, 1000, 5000, 999999, 1000000, 1000001, 9007199254740991, 9007199254740992, 1e21, -1e21, '100', null, true, [5], { bits: 5 }];
const matches = Object.entries(sets).flatMap(([set, rules]) => amounts.map(bits => ({
  set, bits, match: model.matchBitsRule(rules, bits)?.id ?? null, chat: model.bitsChatMessage(rules, 'Default thanks', bits), chatEmptyDefault: model.bitsChatMessage(rules, '', bits),
})));

// parseRule: create and merge, valid and refused.
const previous = model.parseRule({ name: 'Prev', min: 10, max: 20, chat: { mode: 'custom', message: 'hi 👋' }, alert: false }, 'prev');
const bodies: any[] = [
  { name: ' Big ', min: 100, max: null, chat: { mode: 'default' } }, { min: 1 }, { min: 1000000, max: 1000000 }, { min: 1, max: 1 },
  { name: null, enabled: null, alert: null, min: 5, max: null, chat: null }, { min: 5, chat: { mode: 'custom', message: ' x ' } },
  { min: 5, chat: { mode: 'silent', message: null } }, { min: 5, chat: { mode: 'default', message: 'kept' } },
  { name: '👋'.repeat(30), min: 5 }, { name: 'a'.repeat(60), min: 5 }, { name: 'a'.repeat(61), min: 5 }, { name: '  ' + 'a'.repeat(59) + '  ', min: 5 },
  { name: 'é'.repeat(60), min: 5 }, { name: 'שלום עולם', min: 5 }, { name: 'é', min: 5 },
  { min: 5, chat: { mode: 'custom', message: 'm'.repeat(1000) } }, { min: 5, chat: { mode: 'custom', message: 'm'.repeat(1001) } },
  { min: 0 }, { min: -1 }, { min: 1.5 }, { min: 1000001 }, { min: '5' }, { min: true }, { min: null }, {}, { min: 10, max: 5 }, { min: 10, max: 10.5 }, { min: 10, max: 0 },
  { min: 10, max: '20' }, { min: 10, extra: 1 }, { min: 10, chat: { mode: 'loud' } }, { min: 10, chat: 'custom' }, { min: 10, chat: [] }, { min: 10, chat: { mode: 'custom' } },
  { min: 10, chat: { mode: 'custom', message: 5 } }, { min: 10, enabled: 'yes' }, { min: 10, alert: 1 }, { min: 10, name: 5 }, null, [], 'rule', 5,
];
const parses = bodies.map(body => ({ body, created: outcome(() => model.parseRule(body, 'r1')) }));
const merges = [{ enabled: false }, {}, { max: null }, { min: 25 }, { chat: { mode: 'default' } }, { name: 'New' }, { min: 15, max: 15 }, { alert: true }, { chat: null }]
  .map(body => ({ body, merged: outcome(() => model.parseRule(body, 'prev', previous)) }));

// Legacy tiers, stored as BSON (so the Rust side reads the same types).
const legacyInputs: any[] = [
  [{ id: 'tier-1', name: 'Nice', message: 'Nice', minAmount: 69, maxAmount: 69 }, { id: 'tier 2', name: 'Quiet', message: '', min_amount: 0, max_amount: 10 }, { name: 'broken' }],
  [{ min_amount: '100', max_amount: '200', message: 'text amounts' }, { min_amount: '', max_amount: ' 7 ', message: ' ' }, { min_amount: null, minAmount: 3, max_amount: 4, message: 'snake null' }],
  [{ min_amount: true, max_amount: [5], message: 'bool and array' }, { min_amount: {}, max_amount: 5 }, { min_amount: 2.5, max_amount: -0.5 }, { min_amount: 1e9, max_amount: 2e9 }],
  [{ min_amount: new Double(Infinity), max_amount: 5 }, { min_amount: 'abc', max_amount: 5 }, { min_amount: 0x10, max_amount: '0x20' }, { min_amount: 50, max_amount: 10, message: 'x'.repeat(1200), name: '  ' + 'n'.repeat(70) }],
  [{ id: 'a'.repeat(64), min_amount: 1, max_amount: 2 }, { id: 'a'.repeat(65), min_amount: 1, max_amount: 2 }, { id: 5, min_amount: 1, max_amount: 2 }, 7, null, [1, 2], { min_amount: 1, max_amount: 2, message: '👋'.repeat(600) }],
  Array.from({ length: 60 }, (_, i) => ({ min_amount: i + 1, max_amount: i + 1, message: `m${i}` })),
];
const legacy = legacyInputs.map(tiers => ({ tiers: bson({ tiers }).tiers, rules: model.rulesFromLegacyTiers(EJSON.deserialize(bson({ tiers }), { relaxed: false }).tiers) }));
const ids = ['a', 'A-z_0', '', 'a'.repeat(64), 'a'.repeat(65), 'a b', 'é', 'rule-65f1e108e8b4'].map(id => ({ id, valid: model.validRuleId(id) }));

// The store, against the scratch database.
const steps: any[] = [], found: any[] = [], real: any[] = [];
let eventsubSeeds: any[] = [];
try {
const store = await import(`${root}/src/bits_rules/store.ts`);
const { default: Eventsub } = await import(`${root}/src/schemas/eventsub.schema.ts`);
await (await import(`${root}/src/utils/databases/mongodb.database.ts`)).getMongoDBConnection('bits-rules-recorder');
globalThis.Date = FixedDate as any;
const snapshot = async () => (await mongoose.connection.db.collection('bits_rules').find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson);
async function step(name: string, run: () => Promise<unknown>) {
  let result: any;
  try { result = { ok: await run() }; } catch (e: any) { result = { error: e.message, status: e.status ?? null }; }
  steps.push({ name, now, result: JSON.parse(JSON.stringify(result)), documents: await snapshot() });
  now += 1000;
}
const tiers = [{ id: 'tier-1', name: 'Nice', message: 'Nice one', minAmount: 69, maxAmount: 69 }, { name: 'Big', message: 'Big!', min_amount: 1000, max_amount: 5000 }];
const eventsubSeed = (channel: string, type: string, extra: any = {}) => ({ id: `sub-${channel}-${type}`, status: 'enabled', type, version: '1', condition: { broadcaster_user_id: channel }, created_at: '2026-11-11T00:00:00Z', transport: { method: 'webhook' }, cost: 0, channel: `login${channel}`, channelID: channel, message: 'Thanks $(user)', ...extra });
const seeds = [eventsubSeed('100', 'channel.bits.use', { cheerTiers: tiers }), eventsubSeed('200', 'channel.cheer', { cheerTiers: [tiers[1]] }), eventsubSeed('300', 'channel.cheer', { cheerTiers: [tiers[0]] }), eventsubSeed('300', 'channel.bits.use', { cheerTiers: [], enabled: false })];
for (const seed of seeds) await Eventsub.create(seed);
eventsubSeeds = (await mongoose.connection.db.collection('eventsubs').find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson);
for (const channel of ['100', '200', '300', '400']) { const doc = await store.findBitsEventsub(channel); found.push({ channel, id: doc?.id ?? null, type: doc?.type ?? null }); }
await step('load-empty', () => store.loadBitsRules('400'));
await step('load-legacy-lookup', () => store.loadBitsRules('100'));
await step('load-legacy-given-null', () => store.loadBitsRules('100', null));
await step('load-legacy-given', () => store.loadBitsRules('100', [tiers[1]]));
await step('load-legacy-type', () => store.loadBitsRules('200'));
await step('load-canonical-wins', () => store.loadBitsRules('300'));
const created = model.parseRule({ name: 'Hype', min: 100, max: 999, chat: { mode: 'custom', message: 'Hype $(user)!' } }, 'rule-aaaaaaaaaaaa');
await step('create-copies-legacy', () => store.changeBitsRules('100', 'editor-1', (rules: any[]) => [...rules, created]));
await step('update', () => store.changeBitsRules('100', 'editor-2', (rules: any[]) => { const i = rules.findIndex(r => r.id === 'rule-aaaaaaaaaaaa'); rules[i] = model.parseRule({ enabled: false, max: null }, rules[i].id, rules[i]); return rules; }));
await step('delete', () => store.changeBitsRules('100', 'editor-1', (rules: any[]) => rules.filter(r => r.id !== 'tier-1')));
await step('refused-404', () => store.changeBitsRules('100', 'editor-1', (rules: any[]) => { if (!rules.some(r => r.id === 'gone')) throw new model.BitsRuleError('This rule was already deleted.', 404); return rules; }));
await step('create-empty-channel', () => store.changeBitsRules('400', 'editor-3', () => [model.parseRule({ min: 1, chat: { mode: 'silent' } }, 'only')]));
await step('load-stored', () => store.loadBitsRules('100', [tiers[0]]));
await step('clear-all', () => store.changeBitsRules('400', 'editor-3', () => []));
await step('load-cleared', () => store.loadBitsRules('400'));
globalThis.Date = RealDate;

// Read-only: the production copy.
{
  const client = mongoose.connection.getClient();
  const prod = client.db('domdimabot');
  const channels = [...new Set([
    ...(await prod.collection('bits_rules').find({}, { projection: { _id: 1 } }).toArray()).map((d: any) => d._id),
    ...(await prod.collection('eventsubs').find({ type: { $in: ['channel.bits.use', 'channel.cheer', 'channel.bit.use'] }, 'cheerTiers.0': { $exists: true } }, { projection: { channelID: 1 } }).limit(20).toArray()).map((d: any) => d.channelID),
  ])].sort();
  // The reference's functions read through the default connection; point it at the copy.
  const scratch = mongoose.connection.useDb(database);
  await mongoose.disconnect();
  await mongoose.connect(withDb(base, 'domdimabot'), { autoCreate: false, autoIndex: false });
  for (const channel of channels) {
    const eventsub = await store.findBitsEventsub(channel);
    const state = await store.loadBitsRules(channel, eventsub?.cheerTiers ?? null);
    const lookup = await store.loadBitsRules(channel);
    const view = (r: any) => ({ id: r.id, enabled: r.enabled, min: r.min, max: r.max, mode: r.chat.mode, alert: r.alert, name: sha(r.name), message: sha(r.chat.message) });
    const table = [1, 10, 50, 51, 69, 70, 99, 100, 400, 401, 500, 999, 1000, 5000, 1000000].map(bits => ({ bits, match: model.matchBitsRule(state.rules, bits)?.id ?? null, chat: sha(model.bitsChatMessage(state.rules, eventsub?.message ?? '', bits)) }));
    real.push({ channel, eventsub: eventsub ? String(eventsub._id) : null, revision: state.revision, rules: state.rules.map(view), lookupRevision: lookup.revision, lookupRules: lookup.rules.map(view), table });
  }
  void scratch;
}
} finally {
  globalThis.Date = RealDate;
  await mongoose.disconnect();
  if (!database.startsWith('dima_test_features_')) throw Error('unsafe cleanup');
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(base, { serverSelectionTimeoutMS: 5000 });
  try { await c.connect(); await c.db(database).dropDatabase(); } finally { await c.close(); }
}
await writeFile(output, JSON.stringify({ reference: '0c71108e', matches, parses, merges, previous, legacy, ids, eventsubSeeds, found, steps, real }, null, 1) + '\n');
console.log(`recorded ${matches.length} matches, ${parses.length + merges.length} parses, ${legacy.length} legacy sets, ${steps.length} store steps, ${real.length} real channels`);
process.exit(0);
