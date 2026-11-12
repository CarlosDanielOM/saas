// Records the reference's duel (duel/model.ts, service.ts, stats.ts, completion.ts) for
// tests/duel.rs, against a scratch database `dima_test_features_<random>` (dropped afterwards)
// with a fixed clock and a fixed stream of random bytes; and the leaderboards of the production
// copy `domdimabot` (read only; logins hashed).
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC OBSERVABILITY_DISABLED=true node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/features/tests/duel_record.mts" \
//     "$REPO/dima-rust/crates/features/tests/duel_reference.json"
//
// The outside world is replaced before the duel modules load, with Node's module hooks: the
// Twitch wrappers (user lookup, moderator list, demotion, timeout, re-mod), the chat send, the
// Dragonfly client (overlay presence), the editor check, the widget feed and the logger resolve
// to stubs that record each call and answer from the step's script. So the recording holds
// every call the reference makes to Twitch's wrappers and to chat, in order, with arguments.
// `crypto.randomInt` and `crypto.randomUUID` called from the duel modules draw from a byte
// stream (block i is SHA-256("dima-duel-stream:" + i)); randomInt is Node's algorithm (6 bytes,
// rejection above the largest multiple of the range), which dima_core::Random::int ports.
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const root = process.env.DIMABOT_DIR!, require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose'), { EJSON } = require('bson');
const [output] = process.argv.slice(2);
const base = process.env.DIMA_TEST_MONGO_URI!;
if (!base || !output) throw Error('DIMA_TEST_MONGO_URI and an output path are required');
delete process.env.DRAGONFLY_HOST;
process.env.SECRET_KEY = 'dima-features-test-key';
const crypto = require('node:crypto');
const database = `dima_test_features_${crypto.randomUUID().replaceAll('-', '')}`;
const withDb = (uri: string, db: string) => { const u = new URL(uri); u.pathname = `/${db}`; return u.toString(); };
process.env.MONGO_URI = withDb(base, database);

let block = 0, pool = Buffer.alloc(0);
function take(n: number): Buffer {
  while (pool.length < n) pool = Buffer.concat([pool, createHash('sha256').update(`dima-duel-stream:${block++}`).digest()]);
  const out = Buffer.from(pool.subarray(0, n)); pool = pool.subarray(n); return out;
}
const fromDuel = () => (new Error().stack ?? '').includes('/src/duel/');
const realUUID = crypto.randomUUID, realInt = crypto.randomInt;
crypto.randomUUID = (...a: any[]) => { if (!fromDuel()) return realUUID(...a); const b = take(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
crypto.randomInt = (...a: any[]) => {
  if (!fromDuel() || a.length !== 1) return realInt(...a);
  const range = a[0], RAND_MAX = 0xffffffffffff, limit = RAND_MAX - (RAND_MAX % range);
  for (;;) { const x = take(6).readUIntBE(0, 6); if (x < limit) return x % range; }
};
syncBuiltinESMExports();

// The stubs.
const g = globalThis as any;
g.__duel = { calls: [] as any[], script: {} as any, mods: new Set<string>(), events: [] as any[] };
const stubs: Record<string, string> = {
  'widget_feed/bot-events.js': `export function duelWidgetEvent(c, run, phase) { globalThis.__duel.calls.push(['event', c, run.id, phase]); }`,
  'utils/databases/dragonfly.database.js': `export async function getDragonflyClient() { return globalThis.__duel.dragonfly; }`,
  'utils/permissions/roles.js': `export async function isEditorLoginCached(cache, channel, login) { const d = globalThis.__duel; d.calls.push(['editor', channel, login]); return (d.script.editors ?? []).includes(String(login).toLowerCase()); }`,
  'utils/header.js': `export const TWITCH_BOT_ACCOUNT_ID = '698614112';`,
  'utils/logger.js': `export async function error() {} export async function info() {} export async function warn() {}`,
  'functions/users/get_user_by_login.users.js': `export async function getTwitchUserByLogin(login) { const d = globalThis.__duel; d.calls.push(['user', login]); const id = (d.script.users ?? {})[login]; return id ? { error: false, message: 'Success', data: { id } } : { error: true, message: 'User not found' }; }`,
  'functions/moderation/get_moderators.moderation.js': `export async function getChannelModerators(channel, ids) { const d = globalThis.__duel; d.calls.push(['moderators', channel, ids[0]]); if (d.script.moderatorsError) return { error: true, message: 'moderators failed' }; return { error: false, message: 'Success', data: d.mods.has(ids[0]) ? [{ user_id: ids[0], user_login: 'x', user_name: 'X' }] : [] }; }`,
  'functions/moderation/ban.moderation.js': `export async function ban(channel, user, mod, duration, reason) { const d = globalThis.__duel; d.calls.push(['ban', channel, user, mod, duration, reason]); return d.script.ban === 'error' ? { error: true, message: 'ban failed', status: 400 } : { error: false, message: 'User banned', status: 200 }; }`,
  'functions/channels/remove_moderator.channel.js': `export async function removeChannelModerator(channel, user) { const d = globalThis.__duel; d.calls.push(['remove', channel, user]); if (d.script.disableOnRemove) await d.disable(channel); if (d.script.remove === 'error') return { error: true, message: 'remove failed' }; d.mods.delete(user); return { error: false, message: 'Moderator removed' }; }`,
  'functions/channels/add_moderator.channel.js': `export async function addModerator(channel, user) { const d = globalThis.__duel; d.calls.push(['add', channel, user]); if (d.script.add === 'error') return { error: 'add failed', message: 'add failed', status: 400 }; d.mods.add(user); return { status: 200, message: 'Success' }; }`,
  'functions/chats/send_message.chat.js': `export async function sendTwitchChatMessage(channel, text) { const d = globalThis.__duel; d.calls.push(['chat', channel, text]); return d.script.chat === 'error' ? { error: true, message: 'chat failed', status: 500 } : { error: false, message: 'Message sent', status: 200 }; }`,
};
registerHooks({
  resolve(specifier: string, context: any, next: any) {
    if (context.parentURL?.includes('/src/duel/') || context.parentURL?.includes('/src/widgets/service')) {
      for (const [suffix, source] of Object.entries(stubs)) {
        if (specifier.endsWith(suffix)) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true, format: 'module' };
      }
    }
    return next(specifier, context);
  },
});

const RealDate = Date;
let now = 1794355200000;
class FixedDate extends RealDate {
  constructor(...a: any[]) { super(...(a.length ? a : [now]) as [any]); return new RealDate(...(a.length ? a : [now]) as [any]); }
  static now() { return now; }
  static [Symbol.hasInstance](v: any) { return v instanceof RealDate; }
}
const bson = (v: any) => { const d = globalThis.Date; globalThis.Date = RealDate; try { return EJSON.serialize(v, { relaxed: false }); } finally { globalThis.Date = d; } };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const steps: any[] = [], real: any[] = [];
let seeds: any[] = [];
try {
  const service = await import(`${root}/src/duel/service.ts`);
  const stats = await import(`${root}/src/duel/stats.ts`);
  const completion = await import(`${root}/src/duel/completion.ts`);
  const model = await import(`${root}/src/duel/model.ts`);
  await (await import(`${root}/src/utils/databases/mongodb.database.ts`)).getMongoDBConnection('duel-recorder');
  const db = mongoose.connection.db;
  const presence: Record<string, string | null> = {};
  g.__duel.dragonfly = {
    get: async (key: string) => { const c = key.split(':')[2]; g.__duel.calls.push(['presence.get', c]); return presence[c] ?? null; },
    del: async (key: string) => { const c = key.split(':')[2]; g.__duel.calls.push(['presence.del', c]); presence[c] = null; return 1; },
  };
  g.__duel.disable = async (channel: string) => { await db.collection('duel_widgets').updateOne({ _id: channel }, { $set: { 'settings.timeoutEnabled': false } }); };
  // Users: 3002 speaks Spanish (free), 3003 is premium.
  await db.collection('users').insertMany([
    { accounts: [{ type: 'twitch', id: '3002' }], language: 'es', plan_tier: 'free' },
    { accounts: [{ type: 'twitch', id: '3003' }], language: 'es', plan_tier: 'premium' },
  ]);
  seeds = (await db.collection('users').find({}, { projection: { _id: 0 } }).toArray()).map(bson);
  globalThis.Date = FixedDate as any;
  const collections = ['duel_widgets', 'duel_results', 'duel_moderator_restores'];
  const docs = async () => { const out: any = {}; for (const c of collections) out[c] = (await db.collection(c).find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(bson); return out; };
  async function step(name: string, call: any, script: any, run: () => Promise<unknown>) {
    g.__duel.calls = []; g.__duel.script = script ?? {};
    if (script?.presence) for (const [c, v] of Object.entries(script.presence)) presence[c] = v === null ? null : JSON.stringify(v);
    if (script?.mods) g.__duel.mods = new Set(script.mods);
    let result: any;
    try { result = { ok: await run() }; } catch (e: any) { result = e?.code ? { error: { code: e.code, message: e.message, status: e.status } } : { thrown: String(e?.message ?? e) }; }
    steps.push({ name, now, call, script: script ?? {}, result: JSON.parse(JSON.stringify(result ?? null)), calls: g.__duel.calls, mods: [...g.__duel.mods].sort(), documents: await docs() });
  }
  const at = (ms: number) => { now = ms; };
  const C = '3001', ES = '3002', P = '3003';
  const snapshot = (name: string, c = C, script?: any) => step(name, { kind: 'snapshot', channel: c }, script, () => service.duelSnapshot(c));
  const configure = (name: string, input: any, revision: number, key: string, c = C) => step(name, { kind: 'configure', channel: c, input, revision, key }, {}, async () => { await service.configureDuel(c, input, revision, key); return null; });
  const challenge = (name: string, a: string, b: string, enraged: any = null, c = C, script?: any) => step(name, { kind: 'challenge', channel: c, challenger: a, opponent: b, enraged }, script, () => service.challengeDuel(c, a, b, enraged));
  const accept = (name: string, who: string, c = C, script?: any) => step(name, { kind: 'accept', channel: c, opponent: who }, script, () => service.acceptDuel(c, who));
  const decline = (name: string, who: string, c = C) => step(name, { kind: 'decline', channel: c, opponent: who }, {}, () => service.declineDuel(c, who));
  const fight = (name: string, who: string, streamer: string, c = C, script?: any) => step(name, { kind: 'fight', channel: c, challenger: who, streamer }, script, () => service.fightStreamer(c, who, streamer));
  const tick = (name: string, script?: any) => step(name, { kind: 'tick' }, script, async () => { await completion.settleDuels(); return null; });
  const board = (name: string, c = C) => step(name, { kind: 'leaderboard', channel: c }, {}, () => stats.duelLeaderboard(c));
  const runOf = async (c: string) => (await db.collection('duel_widgets').findOne({ _id: c })).run;

  await snapshot('snapshot-default');
  await snapshot('snapshot-spanish-free', ES);
  await snapshot('snapshot-premium', P);
  await configure('configure-bad-key', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, loud: 1 }, 0, 'k1');
  await configure('configure-bad-switch', { enabled: 'yes', timeoutEnabled: true, timeoutSeconds: 60 }, 0, 'k1');
  await configure('configure-bad-timeout', { enabled: true, timeoutEnabled: true, timeoutSeconds: 1209601 }, 0, 'k1');
  await configure('configure-bad-language', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, language: 'fr' }, 0, 'k1');
  await configure('configure-bad-step', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, rules: { hp: 55 } }, 0, 'k1');
  await configure('configure-bad-heal', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, rules: { healMin: 50, healMax: 40 } }, 0, 'k1');
  await configure('configure-bad-rule', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, rules: { speed: 1 } }, 0, 'k1');
  await configure('configure', { enabled: true, timeoutEnabled: true, timeoutSeconds: 120, quality: 'high' }, 0, 'k1');
  await configure('configure-replay', { enabled: true, timeoutEnabled: true, timeoutSeconds: 120, quality: 'high' }, 0, 'k1');
  await configure('configure-key-conflict', { enabled: true, timeoutEnabled: true, timeoutSeconds: 30 }, 1, 'k1');
  await configure('configure-revision-conflict', { enabled: true, timeoutEnabled: true, timeoutSeconds: 30 }, 0, 'k2');
  await configure('configure-spanish', { enabled: true, timeoutEnabled: true, timeoutSeconds: 60, language: 'es' }, 0, 'k3', ES);
  // A chat duel: challenge, a second challenge, a wrong accept, the accept, narration, the end.
  await challenge('challenge', 'alice', 'bob');
  await challenge('challenge-busy', 'carol', 'dave');
  await accept('accept-wrong', 'carol');
  await decline('decline-wrong', 'carol');
  await accept('accept', 'bob');
  await accept('accept-again', 'bob');
  const chatRun = await runOf(C);
  for (const [i, phrase] of chatRun.phrases.entries()) { at(phrase.at); await tick(`tick-phrase-${i}`); }
  at(chatRun.endsAt);
  await tick('tick-end', { users: { bob: '501', alice: '500' } });
  await tick('tick-done');
  await snapshot('snapshot-after');
  // Decline, then an expired challenge.
  await challenge('challenge-2', 'alice', 'bob');
  await decline('decline', 'bob');
  await challenge('challenge-3', 'alice', 'erin');
  at(now + 30000);
  await tick('tick-expire');
  // An overlay duel (tracked, rivalries): the source is ready.
  const token = 'a'.repeat(43);
  await db.collection('duel_widgets').updateOne({ _id: C }, { $set: { tokenHash: service.tokenHash(token) } });
  const ready = { presence: { [C]: { hash: service.tokenHash(token), at: now } } };
  await challenge('challenge-overlay', 'alice', 'bob', null, C, ready);
  await accept('accept-overlay', 'bob', C, { presence: { [C]: { hash: service.tokenHash(token), at: now } } });
  let run = await runOf(C);
  at(run.endsAt);
  await tick('tick-overlay-end', { users: { bob: '501', alice: '500' } });
  await board('leaderboard-one');
  // The loser is a moderator: demoted, timed out, restored.
  at(now + 10000);
  await challenge('challenge-mod', 'frank', 'gina', null, C, { presence: { [C]: null } });
  await accept('accept-mod', 'gina');
  run = await runOf(C);
  at(run.endsAt);
  const loserMod = run.winner === 'left' ? 'gina' : 'frank';
  await tick('tick-mod', { users: { frank: '600', gina: '601' }, mods: ['600', '601'] });
  at(now + 120000 + 31000);
  await tick('tick-restore', { mods: [...g.__duel.mods] });
  await tick('tick-restore-done');
  // Moderator loser with a failing timeout: the restore is due at once.
  at(now + 10000);
  await challenge('challenge-mod-fail', 'frank', 'gina');
  await accept('accept-mod-fail', 'gina');
  run = await runOf(C);
  at(run.endsAt);
  await tick('tick-mod-ban-fails', { users: { frank: '600', gina: '601' }, mods: ['600', '601'], ban: 'error' });
  await tick('tick-mod-restore-fails', { mods: [...g.__duel.mods], add: 'error' });
  at(now + 30000);
  await tick('tick-mod-restore-retry', { mods: [...g.__duel.mods] });
  // Moderator loser while the switch is turned off during the demotion.
  at(now + 10000);
  await challenge('challenge-mod-off', 'frank', 'gina');
  await accept('accept-mod-off', 'gina');
  run = await runOf(C);
  at(run.endsAt);
  await tick('tick-mod-switch-off', { users: { frank: '600', gina: '601' }, mods: ['600', '601'], disableOnRemove: true });
  await tick('tick-mod-switch-off-restore', { mods: [...g.__duel.mods] });
  await configure('configure-on-again', { enabled: true, timeoutEnabled: true, timeoutSeconds: 120 }, (await db.collection('duel_widgets').findOne({ _id: C })).revision, 'k9');
  // Editors, unknown users, failing chat, the streamer.
  at(now + 10000);
  await challenge('challenge-editor', 'hank', 'ivy');
  await accept('accept-editor', 'ivy');
  run = await runOf(C); at(run.endsAt);
  await tick('tick-editor', { editors: ['hank', 'ivy'], chat: 'error' });
  at(now + 10000);
  await challenge('challenge-unknown', 'jack', 'kim');
  await accept('accept-unknown', 'kim');
  run = await runOf(C); at(run.endsAt);
  await tick('tick-unknown-user', { users: {} });
  at(now + 10000);
  for (let i = 0; i < 4; i++) {
    await fight(`fight-streamer-${i}`, 'liam', 'streamer', C, { presence: { [C]: { hash: service.tokenHash(token), at: now } } });
    run = await runOf(C); at(run.endsAt);
    await tick(`tick-streamer-${i}`, { users: { liam: '700', streamer: C } });
    at(now + 1000);
  }
  await board('leaderboard');
  await step('head-to-head', { kind: 'h2h', channel: C, left: 'alice', right: 'bob' }, {}, () => stats.headToHead(C, 'alice', 'bob'));
  // Pure: settings normalisation, battles for fixed bytes, messages.
  const battles: any[] = [];
  for (const [enraged, rules] of [[null, model.DEFAULT_RULES], ['right', model.DEFAULT_RULES], ['left', { ...model.DEFAULT_RULES, hp: 300, damage: 50, healCharges: 10, healChance: 60, defenseChance: 50, comboHealChance: 100 }], [null, { ...model.DEFAULT_RULES, ultimate: 50, extraTurnChance: 50 }]] as const) {
    for (let i = 0; i < 10; i++) battles.push({ enraged, rules, battle: model.simulateBattle(crypto.randomInt, enraged, rules) });
  }
  void battles;
} finally {
  globalThis.Date = RealDate;
  // The production copy: every channel's leaderboard (logins hashed), read only.
  try {
    await mongoose.disconnect();
    await mongoose.connect(withDb(base, 'domdimabot'), { autoCreate: false, autoIndex: false });
    const stats = await import(`${root}/src/duel/stats.ts`);
    const channels = (await mongoose.connection.db.collection('duel_results').distinct('channel')).sort();
    let total = 0;
    for (const channel of channels) {
      const board = await stats.duelLeaderboard(channel);
      total += board.duels;
      real.push({ channel, ranked: board.ranked, duels: board.duels, players: board.players.map((p: any) => ({ login: sha(p.login), kills: p.kills, deaths: p.deaths, kd: p.kd })) });
    }
    console.log(`production: ${channels.length} channels, ${total} results`);
  } finally {
    await mongoose.disconnect();
    if (!database.startsWith('dima_test_features_')) throw Error('unsafe cleanup');
    const { MongoClient } = require('mongodb');
    const c = new MongoClient(base, { serverSelectionTimeoutMS: 5000 });
    try { await c.connect(); await c.db(database).dropDatabase(); } finally { await c.close(); }
  }
}
await writeFile(output, JSON.stringify({ reference: '0c71108e', stream: 'sha256("dima-duel-stream:" + i)', seeds, steps, real }, null, 1) + '\n');
console.log(`recorded ${steps.length} duel steps`);
process.exit(0);
