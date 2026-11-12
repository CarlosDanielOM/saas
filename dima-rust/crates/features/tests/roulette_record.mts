// Records the reference's roulette (roulette/model.ts, service.ts, actions.ts) for
// tests/roulette.rs, against a scratch database `dima_test_features_<random>` (dropped
// afterwards), with a fixed clock and a fixed stream of random bytes, and the native completion
// worker of the old crate (`target/debug/roulette_completion`, unchanged) run once on the same
// kind of document.
//
//   eval "$(dima-rust/tools/test-env)"
//   tools/cargo build -p dima-rust --no-default-features --features mongo --bin roulette_completion
//   cd "$DIMABOT_DIR" && TZ=UTC OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/features/tests/roulette_record.mts" \
//     "$REPO/dima-rust/crates/features/tests/roulette_reference.json" "$REPO/dima-rust/target/debug/roulette_completion"
//
// Randomness: `crypto.randomBytes` and `crypto.randomUUID` are replaced (and the ES module
// bindings synced) before roulette/model.ts loads, both drawing from one byte stream: block i is
// SHA-256("dima-roulette-stream:" + i). `randomUUID` takes 16 bytes and sets the version and
// variant bits as Node does. The Rust test replays the same stream.
// What the imports start: service.ts loads mongoose, utils/overlay-token.ts and utils/crypto.ts
// (which needs SECRET_KEY: a test key is set; nothing is encrypted) and the command-language
// parser (pure). actions.ts loads its chat delivery lazily; the recorder passes its own `execute`.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON } = require('bson');
const [output, nativeBin] = process.argv.slice(2);
const base = process.env.DIMA_TEST_MONGO_URI!;
if (!base || !output || !nativeBin) throw Error('DIMA_TEST_MONGO_URI, an output path and the native binary are required');
delete process.env.DRAGONFLY_HOST;
process.env.SECRET_KEY = 'dima-features-test-key';
const crypto = require('node:crypto');
const database = `dima_test_features_${crypto.randomUUID().replaceAll('-', '')}`;
const withDb = (uri: string, db: string) => { const u = new URL(uri); u.pathname = `/${db}`; return u.toString(); };
process.env.MONGO_URI = withDb(base, database);

// The byte stream.
let block = 0, pool = Buffer.alloc(0), consumed = 0;
function take(n: number): Buffer {
  while (pool.length < n) { pool = Buffer.concat([pool, createHash('sha256').update(`dima-roulette-stream:${block++}`).digest()]); }
  const out = pool.subarray(0, n); pool = pool.subarray(n); consumed += n; return Buffer.from(out);
}
// The driver's own asynchronous calls (SCRAM nonces) keep the real generator.
// Only the roulette model's calls draw from the stream; the driver's own (session ids, SCRAM
// nonces) keep the real generator.
const realRandomBytes = crypto.randomBytes, realRandomUUID = crypto.randomUUID;
const fromModel = () => (new Error().stack ?? '').includes('/src/roulette/model.ts');
crypto.randomBytes = (n: number, callback?: any) => !callback && fromModel() ? take(n) : realRandomBytes(n, callback);
crypto.randomUUID = (...args: any[]) => fromModel() ? streamUUID() : realRandomUUID(...args);
const streamUUID = () => { const b = take(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
syncBuiltinESMExports();

const RealDate = Date;
let now = 1794355200000;
class FixedDate extends RealDate {
  constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); }
  static now() { return now; }
  static [Symbol.hasInstance](v: any) { return v instanceof RealDate; }
}
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };

const steps: any[] = [];
const native: any = {};
try {
  const model = await import(`${root}/src/roulette/model.ts`);
  const service = await import(`${root}/src/roulette/service.ts`);
  const actions = await import(`${root}/src/roulette/actions.ts`);
  await (await import(`${root}/src/utils/databases/mongodb.database.ts`)).getMongoDBConnection('roulette-recorder');
  await service.RouletteChannel.init();
  globalThis.Date = FixedDate as any;
  const docs = async () => (await mongoose.connection.db.collection('roulette_channels').find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson);
  const C = '1001';
  async function step(name: string, call: any, run: () => Promise<unknown>) {
    const before = consumed;
    let result: any;
    try { result = { ok: await run() }; } catch (e: any) { result = e instanceof model.RouletteError ? { error: { code: e.code, message: e.message, status: e.status, row: e.row ?? null } } : { thrown: String(e?.message ?? e) }; }
    steps.push({ name, now, call, bytes: consumed - before, result: JSON.parse(JSON.stringify(result ?? null)), documents: await docs() });
  }
  const exec = (name: string, action: any, key?: string, revision?: number, actor?: any, channel = C) =>
    step(name, { kind: 'execute', channel, action, key: key ?? null, revision: revision ?? null, actor: actor ?? null }, () => service.execute(channel, structuredClone(action), key, revision, actor));
  const snap = (name: string, channel = C) => step(name, { kind: 'snapshot', channel }, () => service.snapshot(channel));
  const overlay = (name: string, channel = C) => step(name, { kind: 'overlay', channel }, () => service.overlaySnapshot(channel));
  const at = (ms: number) => { now = ms; };

  await snap('empty');
  await exec('create', { operation: 'create', data: { name: 'Giveaway 🎁', alias: 'give' } });
  await exec('create-bad-alias', { operation: 'create', data: { name: 'X', alias: 'Bad' } });
  await exec('create-missing-alias', { operation: 'create', data: { name: 'X' } });
  await exec('create-unknown-field', { operation: 'create', data: { name: 'X', alias: 'x', size: 1 } });
  await exec('create-duplicate-alias', { operation: 'create', data: { name: 'Again', alias: 'give' } });
  await exec('create-cards', { operation: 'create', data: { name: 'Cards', alias: 'cards', design: 'cards', cardSize: 'small', colors: ['#ABCDEF', '#000000'], durationSeconds: 7, settings: { insertion: 'random', duplicate: 'increase', winnerAction: 'remove-copy', hideAfterSeconds: 5, shuffleBeforeDraw: true } } });
  await exec('configure', { operation: 'configure', roulette: 'give', data: { name: '  Renamed ', durationSeconds: 3, settings: { winnerAction: 'remove-item', hideAfterSeconds: 2 } } });
  for (const [name, data] of Object.entries({ 'configure-bad-color': { colors: ['red'] }, 'configure-no-colors': { colors: [] }, 'configure-duration': { durationSeconds: 0 }, 'configure-setting': { settings: { loud: true } }, 'configure-bool': { settings: { showOnStart: 'yes' } }, 'configure-hide': { settings: { hideAfterSeconds: 3601 } }, 'configure-design': { design: 'cube' } }))
    await exec(name, { operation: 'configure', roulette: 'give', data });
  await exec('add', { operation: 'add', roulette: 'give', data: { label: 'VIP 👑', multiplier: 3, weight: 5, action: '  $(user) won $(roulette_item)!  ' } });
  await exec('add-plain', { operation: 'add', roulette: 'give', data: { label: 'Nothing' } });
  await exec('add-bad-action', { operation: 'add', roulette: 'give', data: { label: 'Bad', action: '$(user' } });
  await exec('add-long-label', { operation: 'add', roulette: 'give', data: { label: 'x'.repeat(121) } });
  await exec('add-zero', { operation: 'add', roulette: 'give', data: { label: 'z', multiplier: 0 } });
  await exec('add-unknown', { operation: 'add', roulette: 'give', data: { label: 'z', color: 1 } });
  await exec('add-missing-roulette', { operation: 'add', roulette: 'nope', data: { label: 'z' } });
  await exec('add-increase', { operation: 'add', roulette: 'cards', data: { label: 'Copy', multiplier: 4 } });
  await exec('add-increase-again', { operation: 'add', roulette: 'cards', data: { label: 'Copy', multiplier: 2 } });
  await exec('add-increase-weight-conflict', { operation: 'add', roulette: 'cards', data: { label: 'Copy', weight: 2 } });
  await exec('add-increase-action-conflict', { operation: 'add', roulette: 'cards', data: { label: 'Copy', action: 'hi' } });
  await exec('add-over-capacity', { operation: 'add', roulette: 'cards', data: { label: 'Many', multiplier: 95 } });
  await exec('add-unsafe-weight', { operation: 'add', roulette: 'give', data: { label: 'Heavy', weight: 9007199254740991, multiplier: 2 } });
  await exec('import', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'Copy', multiplier: 1 }, { label: 'New 🌟', weight: 3, action: '$(user)' }, { label: 'שלום' }] } });
  await exec('import-bad-row', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'ok' }, { label: '' }] } });
  await exec('import-bad-action', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'ok' }, { label: 'b', action: '*(' }] } });
  await exec('import-not-object', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'ok' }, 5] } });
  await exec('import-capacity', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'a', multiplier: 90 }] } });
  await exec('import-empty', { operation: 'import', roulette: 'cards', data: { items: [] } });
  await exec('import-replace-flag', { operation: 'import', roulette: 'cards', data: { items: [{ label: 'a' }], replace: 'yes' } });
  const stored = (await mongoose.connection.db.collection('roulette_channels').findOne({ _id: C })).state;
  const give = stored.roulettes.find((r: any) => r.alias === 'give'), vip = give.items[0], cards = stored.roulettes.find((r: any) => r.alias === 'cards');
  await exec('update', { operation: 'update', roulette: 'give', itemId: vip.id, data: { multiplier: 2, weight: 4 } });
  await exec('update-grow-random', { operation: 'update', roulette: 'cards', itemId: cards.items[0].id, data: { multiplier: 8 } });
  await exec('update-bad-action', { operation: 'update', roulette: 'give', itemId: vip.id, data: { action: '$(' } });
  await exec('update-missing', { operation: 'update', roulette: 'give', itemId: 'missing', data: { multiplier: 2 } });
  await exec('shuffle', { operation: 'shuffle', roulette: 'cards' });
  await exec('switch', { operation: 'switch', roulette: 'cards' });
  await exec('show', { operation: 'show' });
  await exec('hide', { operation: 'hide' });
  await exec('switch-back', { operation: 'switch', roulette: give.id });
  const actor = { userId: '42', userLogin: 'viewer', userDisplayName: 'Viewer 😀', argument: 'arg' };
  await exec('start', { operation: 'start', roulette: 'give' }, 'key-start', undefined, actor);
  await exec('start-replay', { operation: 'start', roulette: 'give' }, 'key-start', undefined, actor);
  await exec('start-key-conflict', { operation: 'start', roulette: 'cards' }, 'key-start', undefined, actor);
  await exec('start-while-spinning', { operation: 'start', roulette: 'give' });
  await exec('configure-while-spinning', { operation: 'configure', roulette: 'give', data: { name: 'n' } });
  await exec('add-while-spinning', { operation: 'add', roulette: 'give', data: { label: 'Late' } });
  await exec('revision-conflict', { operation: 'hide' }, undefined, 0);
  await overlay('overlay-spinning');
  at(now + 3000);
  await snap('completed');
  at(now + 2000);
  await snap('hidden');
  await snap('settled-again');
  // Winner actions: one due action, run by the recorder's executor.
  const ran: any[] = [];
  await step('run-actions', { kind: 'run_actions', fail: false }, async () => { await actions.runDueActions(async (channel: string, job: any) => { ran.push({ channel, job: JSON.parse(JSON.stringify(job)) }); }); return ran; });
  await step('run-actions-again', { kind: 'run_actions', fail: false }, async () => { const before = ran.length; await actions.runDueActions(async (channel: string, job: any) => { ran.push({ channel, job }); }); return ran.length - before; });
  // A failing action, and a spin whose winner item is removed meanwhile.
  await exec('start-again', { operation: 'start', roulette: 'give' }, undefined, undefined, { userId: '', userLogin: '', userDisplayName: '' });
  const spinning = (await mongoose.connection.db.collection('roulette_channels').findOne({ _id: C })).state.draw;
  at(now + 3000);
  await step('run-actions-fail', { kind: 'run_actions', fail: true }, async () => { await actions.runDueActions(async () => { throw new Error('boom'); }); return null; });
  await exec('start-cards', { operation: 'start', roulette: 'cards' });
  const cardsDraw = (await mongoose.connection.db.collection('roulette_channels').findOne({ _id: C })).state.draw;
  await exec('remove-winner-meanwhile', { operation: 'remove', roulette: 'cards', itemId: cardsDraw.winner.itemId });
  at(now + 7000);
  await snap('completed-without-winner');
  void spinning;
  await exec('delete', { operation: 'delete', roulette: 'cards' });
  await exec('delete-again', { operation: 'delete', roulette: 'cards' });
  // Many draws on one wheel: the distribution for the fixed byte stream.
  const W = '1002';
  await exec('draws-create', { operation: 'create', data: { name: 'Odds', alias: 'odds', durationSeconds: 1 } }, undefined, undefined, undefined, W);
  for (const [label, weight] of [['rare', 1], ['two', 2], ['three', 3], ['common', 10000], ['huge', 4503599627370496]] as const)
    await exec(`draws-add-${label}`, { operation: 'add', roulette: 'odds', data: { label, weight } }, undefined, undefined, undefined, W);
  for (let i = 0; i < 30; i++) { at(now + 1000); await exec(`draw-${i}`, { operation: 'start' }, undefined, undefined, undefined, W); }
  globalThis.Date = RealDate;

  // The native worker: a spinning remove-copy draw with a hide deadline, settled by the old
  // binary (it reads the real clock: every deadline here is in the past) and by the reference.
  const N = '2001', T = '2002';
  globalThis.Date = FixedDate as any;
  now = 1794355200000;
  for (const channel of [N, T]) {
    await service.execute(channel, { operation: 'create', data: { name: 'Native', alias: 'nat', durationSeconds: 2, settings: { winnerAction: 'remove-copy', hideAfterSeconds: 1 } } });
    await service.execute(channel, { operation: 'add', roulette: 'nat', data: { label: 'One', multiplier: 2, weight: 3 } });
    await service.execute(channel, { operation: 'start' });
  }
  const seeded = (await mongoose.connection.db.collection('roulette_channels').find({ _id: { $in: [N, T] } }, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson);
  globalThis.Date = RealDate;
  execFileSync(nativeBin, ['--once', '--database', database], { env: { ...process.env, MONGO_URI: base }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  globalThis.Date = FixedDate as any;
  now = 1794355200000 + 3_600_000;
  await service.snapshot(T);
  globalThis.Date = RealDate;
  native.seeded = seeded;
  native.after = (await mongoose.connection.db.collection('roulette_channels').find({ _id: { $in: [N, T] } }, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson);
} finally {
  globalThis.Date = RealDate;
  await mongoose.disconnect();
  if (!database.startsWith('dima_test_features_')) throw Error('unsafe cleanup');
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(base, { serverSelectionTimeoutMS: 5000 });
  try { await c.connect(); await c.db(database).dropDatabase(); } finally { await c.close(); }
}
await writeFile(output, JSON.stringify({ reference: '0c71108e', stream: 'sha256("dima-roulette-stream:" + i)', steps, native }, null, 1) + '\n');
console.log(`recorded ${steps.length} roulette steps and the native completion`);
process.exit(0);
