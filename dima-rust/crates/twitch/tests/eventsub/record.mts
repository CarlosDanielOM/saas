// Records what the frozen TypeScript reference does with EventSub subscriptions, for the
// `eventsub_*` tests of `dima-twitch`: the condition and request golden table (part 1),
// `subscribeTwitchEvent`, `getEventsubs`, `unsubscribeTwitchEvent` and
// `migrateLegacyBitsEventsubs` (part 2), and whole `reconcileEventsubs` scenarios (part 3).
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/twitch/tests/eventsub/record.mts" \
//     "$REPO/dima-rust/crates/twitch/tests/eventsub"
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference.
// The reference's modules run as they are against a throwaway MongoDB database
// (`dima_test_twitch_rec_<random>`, dropped at the end, also after a failure) and a local Twitch
// mock (`fetch` to `https://api.twitch.tv` is sent to it); only the token cache, the streamer
// directory and the logger are stubbed (`hooks.mjs`), because importing them opens connections.
// The clock is fixed per scenario. Every request the reference sent, the answer the mock gave,
// the value the function returned (or threw) and every `eventsubs` document afterwards (typed
// extended JSON, natural order) are written; the Rust tests replay the answers and compare.
import { register, createRequire } from 'node:module';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

register('./hooks.mjs', import.meta.url);

const root = process.env.DIMABOT_DIR;
const outDir = process.argv[2];
if (!root || !outDir) throw new Error('usage: DIMABOT_DIR=... record.mts <out-dir>');
if (process.env.TZ !== 'UTC') throw new Error('run with TZ=UTC');
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const { EJSON, ObjectId } = require('bson');

// ------------------------------------------------------------------ provenance
const SOURCES = [
  'src/utils/eventsub.ts', 'src/utils/eventsub_condition.ts', 'src/utils/eventsub_access.ts',
  'src/utils/eventsub_bits_config.ts', 'src/utils/chat_event_catalog.ts',
  'src/utils/eventsub_reconciliation.ts', 'src/utils/eventsub_reconciliation_policy.ts',
  'src/utils/header.ts', 'src/utils/links.ts', 'src/utils/raid_direction.ts',
  'src/utils/raid_subscriptions.ts', 'src/utils/chat_notification_defaults.ts',
  'src/utils/notifications.ts', 'src/overlays/interaction-model.ts',
  'src/schemas/eventsub.schema.ts', 'src/schemas/users.schema.ts',
  'src/schemas/raid_subscription_preference.schema.ts', 'src/schemas/admin.schema.ts',
  'src/middleware/admin.middleware.ts',
];
const sources: Record<string, string> = {};
for (const file of SOURCES) sources[file] = createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex');
const reference = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', 'src'], { encoding: 'utf8' }).trim();

// ------------------------------------------------------------------ clock
const RealDate = Date;
export const NOW_MS = 1_794_355_200_000; // 2026-11-11T00:00:00Z (the Rust support's NOW_MS)
let now = NOW_MS;
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    super(...((args.length ? args : [now]) as [any]));
    return new RealDate(...((args.length ? args : [now]) as [any]));
  }
  static now() { return now; }
  static [Symbol.hasInstance](value: any) { return value instanceof RealDate; }
}
const iso = (ms: number, nanos = 0) => `${new RealDate(ms).toISOString().slice(0, 19)}.${String(nanos).padStart(9, '0')}Z`;

// ------------------------------------------------------------------ Twitch mock
type Rec = { method: string; target: string; headers: Record<string, string | undefined>; body: string };
type Resp = { status: number; headers?: Record<string, string>; body?: string };
let handler: (request: Rec) => Resp = () => ({ status: 599, body: '{"error":"unexpected request"}' });
let exchanges: Array<{ request: Rec; response: Resp }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const request: Rec = {
      method: req.method ?? '',
      target: req.url ?? '',
      headers: {
        'client-id': req.headers['client-id'] as string | undefined,
        authorization: req.headers.authorization,
        'content-type': req.headers['content-type'] as string | undefined,
      },
      body: Buffer.concat(chunks).toString('utf8'),
    };
    const response = handler(request);
    exchanges.push({ request, response });
    res.writeHead(response.status, response.headers ?? (response.body === undefined ? {} : { 'content-type': 'application/json' }));
    res.end(response.body ?? '');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init: any) => realFetch(String(url).replace('https://api.twitch.tv', base), init)) as any;

/** A stateful Twitch: subscriptions, ids `sub-0001`..., 409 for a second one with the same
 * type, version, condition and callback, pages of `pageSize`, 204 / 404 deletes. */
class FakeTwitch {
  subs: any[] = [];
  next = 1;
  pageSize = 100;
  status = 'webhook_callback_verification_pending';
  cost = 1;
  override?: (request: Rec, n: number) => Resp | undefined;
  served = 0;
  key(sub: any) {
    const condition = Object.entries(sub.condition ?? {}).filter(([, v]) => v !== '' && v != null).sort(([a], [b]) => (a < b ? -1 : 1));
    return `${sub.type}|${sub.version}|${JSON.stringify(condition)}|${sub.transport?.callback}`;
  }
  create(body: any, status = this.status, createdAt = now) {
    const condition = body.type === 'channel.raid'
      ? { from_broadcaster_user_id: body.condition?.from_broadcaster_user_id ?? '', to_broadcaster_user_id: body.condition?.to_broadcaster_user_id ?? '' }
      : { ...body.condition };
    const sub = {
      id: `sub-${String(this.next).padStart(4, '0')}`,
      status,
      type: body.type,
      version: body.version,
      condition,
      created_at: iso(createdAt, this.next * 1000),
      transport: { method: body.transport?.method ?? 'webhook', callback: body.transport?.callback ?? '' },
      cost: this.cost,
    };
    this.next += 1;
    this.subs.push(sub);
    return sub;
  }
  totals() {
    return { total: this.subs.length, total_cost: this.subs.reduce((sum, sub) => sum + sub.cost, 0), max_total_cost: 10000 };
  }
  handle(request: Rec): Resp {
    const n = this.served++;
    const scripted = this.override?.(request, n);
    if (scripted) return scripted;
    const url = new URL(request.target, 'http://x');
    if (url.pathname !== '/helix/eventsub/subscriptions') return { status: 404, body: '{"error":"Not Found","status":404,"message":""}' };
    if (request.method === 'POST') {
      const body = JSON.parse(request.body);
      if (this.subs.some((sub) => this.key(sub) === this.key({ ...body, transport: body.transport }))) {
        return { status: 409, body: '{"error":"Conflict","status":409,"message":"subscription already exists"}' };
      }
      const sub = this.create(body);
      return { status: 202, body: JSON.stringify({ data: [sub], ...this.totals() }) };
    }
    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const index = this.subs.findIndex((sub) => sub.id === id);
      if (index < 0) return { status: 404, body: '{"error":"Not Found","status":404,"message":"subscription not found"}' };
      this.subs.splice(index, 1);
      return { status: 204 };
    }
    if (request.method === 'GET') {
      const user = url.searchParams.get('user_id');
      const first = Number(url.searchParams.get('first') ?? '20');
      const after = Number(url.searchParams.get('after')?.replace('cursor-', '') ?? '0');
      const listed = user ? this.subs.filter((sub) => Object.values(sub.condition).includes(user)) : this.subs;
      const size = Math.min(first, this.pageSize);
      const page = listed.slice(after, after + size);
      const more = after + size < listed.length;
      return { status: 200, body: JSON.stringify({ data: page, ...this.totals(), pagination: more ? { cursor: `cursor-${after + size}` } : {} }) };
    }
    return { status: 405, body: '{"error":"Method Not Allowed","status":405,"message":""}' };
  }
}

// ------------------------------------------------------------------ scratch database
const database = `dima_test_twitch_rec_${randomUUID().replaceAll('-', '')}`;
await mongoose.connect(uri, { dbName: database, autoCreate: true, autoIndex: true });
async function main() {
  const imported = (file: string) => import(`${root}/${file}`);
  const eventsub = await imported('src/utils/eventsub.ts');
  const condition = await imported('src/utils/eventsub_condition.ts');
  const access = await imported('src/utils/eventsub_access.ts');
  const bitsConfig = await imported('src/utils/eventsub_bits_config.ts');
  const catalog = await imported('src/utils/chat_event_catalog.ts');
  const reconciliation = await imported('src/utils/eventsub_reconciliation.ts');
  const policy = await imported('src/utils/eventsub_reconciliation_policy.ts');
  const raidDirection = await imported('src/utils/raid_direction.ts');
  const { default: Eventsub } = await imported('src/schemas/eventsub.schema.ts');
  const { default: Users } = await imported('src/schemas/users.schema.ts');
  const { RaidSubscriptionPreferenceSchema: Preferences } = await imported('src/schemas/raid_subscription_preference.schema.ts');
  const { AdminSchema: Admins } = await imported('src/schemas/admin.schema.ts');
  await Promise.all([Eventsub, Users, Preferences, Admins].map((model: any) => model.init()));
  globalThis.Date = FixedDate as any;

  const ejson = (value: any) => {
    const date = globalThis.Date;
    globalThis.Date = RealDate;
    try { return EJSON.serialize(value, { relaxed: false }); } finally { globalThis.Date = date; }
  };
  const fromEjson = (value: any) => {
    const date = globalThis.Date;
    globalThis.Date = RealDate;
    try { return EJSON.deserialize(value, { relaxed: false }); } finally { globalThis.Date = date; }
  };
  const documents = async () => (await Eventsub.collection.find({}, { promoteValues: false }).toArray()).map(ejson);
  const preferences = async () => (await Preferences.collection.find({}, { promoteValues: false }).toArray()).map(ejson);

  /** A channel as both sides seed it: a user with one Twitch account. */
  type Channel = { id: string; name: string; actived?: boolean; has_permissions?: boolean; token?: boolean };
  const SECRET = 'test-eventsub-secret-0123456789';
  const APP_TOKEN = 'app-token-1';
  type Env = { secret: string | null; clientId: string | null; appToken: string | null };
  const DEFAULT_ENV: Env = { secret: SECRET, clientId: 'test-client-id', appToken: APP_TOKEN };

  async function seed(channels: Channel[], eventsubs: any[] = [], prefs: any[] = [], admins: any[] = [], env: Env = DEFAULT_ENV) {
    for (const model of [Eventsub, Users, Preferences, Admins]) await model.collection.deleteMany({});
    for (const channel of channels) {
      await Users.collection.insertOne({
        _id: new ObjectId(), name: channel.name, email: `${channel.name}@example.invalid`,
        accounts: [{ _id: new ObjectId(), type: 'twitch', id: channel.id, name: channel.name, actived: channel.actived ?? true, has_permissions: channel.has_permissions ?? true }],
      });
    }
    for (const document of eventsubs) await Eventsub.collection.insertOne(fromEjson(document));
    for (const document of prefs) await Preferences.collection.insertOne(fromEjson(document));
    for (const document of admins) await Admins.collection.insertOne(fromEjson(document));
    (globalThis as any).__eventsubFixture = {
      appToken: env.appToken,
      directory: Object.fromEntries(channels.map((c) => [c.id, { id: c.id, name: c.name, has_permissions: String(c.has_permissions ?? true) }])),
      tokens: Object.fromEntries(channels.filter((c) => c.token ?? true).map((c) => [c.id, `${c.id}-access`])),
    };
    if (env.secret === null) delete process.env.TWITCH_EVENTSUB_SECRET; else process.env.TWITCH_EVENTSUB_SECRET = env.secret;
    if (env.clientId === null) delete process.env.CLIENT_ID; else process.env.CLIENT_ID = env.clientId;
  }

  /** Runs `call`, recording requests, answers, the result (or what it threw) and the documents. */
  async function capture(twitch: FakeTwitch, call: () => Promise<any>) {
    exchanges = [];
    handler = (request) => twitch.handle(request);
    let result: any;
    let threw: string | null = null;
    try {
      result = JSON.parse(JSON.stringify(await call(), (key, value) => (value instanceof Response ? { response: value.status } : value)) ?? 'null');
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    return { exchanges, result: threw === null ? result : null, threw, documents: await documents() };
  }

  // ================================================================== part 1
  const KINDS: Array<[string, string]> = [['ordinary', '12345'], ['bot', '698614112'], ['leading-zero', '0042'], ['text', 'ü🙂ש'], ['empty', '']];
  const table = eventsub.SUBSCRIPTION_TYPES.map((entry: any) => ({ type: entry.type, version: entry.version, condition: entry.condition, config: entry.config ?? null, autoSubscribe: entry.autoSubscribe ?? null }));
  const conditions = KINDS.flatMap(([kind, channel]) => eventsub.SUBSCRIPTION_TYPES.map((entry: any, index: number) => ({
    kind, channel, index, condition: condition.buildExpectedEventsubCondition(entry, channel),
  })));
  const extraTemplates = [
    { type: 'channel.raid', condition: { from_broadcaster_user_id: 'x', to_broadcaster_user_id: 'y' } },
    { type: 'channel.raid', condition: { from_broadcaster_user_id: '', to_broadcaster_user_id: 'y' } },
    { type: 'channel.raid', condition: {} },
    { type: 'user.update', condition: { broadcaster_user_id: 'x' } },
    { type: 'stream.online', condition: { user_id: 'x' } },
    { type: 'channel.channel_points_custom_reward_redemption.add', condition: { reward_id: 'r', broadcaster_user_id: 'x' } },
  ].map((template) => ({ template, channel: '777', condition: condition.buildExpectedEventsubCondition(template, '777') }));
  const bitsTypes = ['channel.cheer', 'channel.bit.use', 'channel.bits.use', 'channel.follow', 'channel.raid', ''].map((type) => ({
    type, legacy: eventsub.isLegacyBitsEventType(type), bits: eventsub.isBitsEventType(type),
    canonical: eventsub.canonicalizeEventsubType(type), equivalents: eventsub.getEquivalentEventsubTypes(type),
  }));
  const raidConditions = [{}, { from_broadcaster_user_id: 'a' }, { to_broadcaster_user_id: 'b' }, { from_broadcaster_user_id: 'a', to_broadcaster_user_id: 'b' }, { from_broadcaster_user_id: 'a', to_broadcaster_user_id: '' }, { from_broadcaster_user_id: '', to_broadcaster_user_id: '' }, null]
    .map((c) => ({ condition: c, direction: raidDirection.raidDirection(c ?? undefined), raidConfig: raidDirection.raidConfigType('channel.raid', c ?? undefined), other: raidDirection.raidConfigType('stream.online', c ?? undefined) }));
  const bitsCases = [
    { canonical: null, legacy: [{ message: 'Cheer received', minViewers: 2 }, { enabled: false, delay: 10, clipEnabled: true }, { cheerTiers: [{ id: 'large', name: 'Large', message: 'Big cheer', min_amount: 100, max_amount: 999 }] }] },
    { canonical: { message: 'Canonical', enabled: false, delay: 5 }, legacy: [{ message: 'Legacy', enabled: true, delay: 10 }] },
    { canonical: { message: null, minViewers: 2.5, enabled: true, cheerTiers: [] }, legacy: [{ message: '  ' }, { message: 'x 🙂', endMessage: null, minViewers: 2 }] },
    { canonical: { endEnabled: false, clipEnabled: false, delay: 0, endMessage: '' }, legacy: [{ endEnabled: true }, { delay: Infinity }, { endMessage: ' ' }] },
    { canonical: null, legacy: [] },
    { canonical: {}, legacy: [{}] },
  ].map((input) => ({ input: ejson(input), output: ejson(bitsConfig.buildBitsEventsubConfig(input.canonical, input.legacy)) }));
  const breaker = [[20, 6, 0.25, 5], [20, 4, 0.25, 5], [100, 10, 0.25, 5], [0, 0, 0.25, 5], [10, 5, 0.5, 5], [10, 6, 0.5, 5], [3, 3, 2, 0], [3, 1, -1, 0], [10, 3, undefined, undefined], [10, 5, undefined, undefined]]
    .map(([total, unhealthy, ratio, min]) => ({ total, unhealthy, ratio: ratio ?? null, min: min ?? null, trips: policy.shouldTripEventsubCircuitBreaker(total, unhealthy, ratio, min) }));
  const builtins = catalog.withBuiltinChatEvents([]);
  const catalogCases = {
    builtins: JSON.stringify(builtins),
    get: ['channel.shoutout.receive', 'channel.raid', 'channel.raid.outgoing', 'channel.follow', 'channel.subscription.end', ''].map((type) => ({ type, event: catalog.getBuiltinChatEvent(type) ?? null })),
    merged: JSON.stringify(catalog.withBuiltinChatEvents([{ type: 'channel.shoutout.receive', name: 'Custom' }, { type: 'channel.follow' }, { name: 'no type' }, { type: 5 }])),
  };

  // The request body of every table entry for each kind of channel (Twitch answers 409, so
  // nothing is stored): `subscribeTwitchEvent(channel, type, version, condition, config,
  // {ignoreExisting: true, appAuthOnly: true})`.
  const bodies: any[] = [];
  for (const [kind, channel] of KINDS.filter(([kind]) => kind !== 'empty')) {
    await seed([{ id: channel, name: `name-${kind}` }]);
    for (const [index, entry] of eventsub.SUBSCRIPTION_TYPES.entries()) {
      const twitch = new FakeTwitch();
      twitch.override = () => ({ status: 409, body: '{"error":"Conflict","status":409,"message":"subscription already exists"}' });
      const expected = condition.buildExpectedEventsubCondition(entry, channel);
      const recorded = await capture(twitch, () => eventsub.subscribeTwitchEvent(channel, entry.type, entry.version, expected, entry.config, { ignoreExisting: true, appAuthOnly: true }));
      bodies.push({ kind, channel, index, ...recorded });
    }
  }

  // `getEventsubAccess`: the owner, the creator, a super admin (also on the creator's channel),
  // channel admins with `*`, the permission, another permission, inactive.
  const adminRows = [
    { _id: { $oid: '00000000000000000000a001' }, adminID: 'super-1', channelID: 'anything', role: 'super', actived: true, permissions: [] },
    { _id: { $oid: '00000000000000000000a002' }, adminID: 'mod-star', channelID: 'chan', role: 'channel', actived: true, permissions: ['*'] },
    { _id: { $oid: '00000000000000000000a003' }, adminID: 'mod-view', channelID: 'chan', role: 'channel', actived: true, permissions: ['eventsubs:view'] },
    { _id: { $oid: '00000000000000000000a004' }, adminID: 'mod-manage', channelID: 'chan', role: 'channel', actived: true, permissions: ['eventsubs:manage', 'commands:view'] },
    { _id: { $oid: '00000000000000000000a005' }, adminID: 'mod-off', channelID: 'chan', role: 'channel', actived: false, permissions: ['*'] },
    { _id: { $oid: '00000000000000000000a006' }, adminID: 'mod-other', channelID: 'chan', role: 'channel', actived: true, permissions: ['commands:manage'] },
    { _id: { $oid: '00000000000000000000a007' }, adminID: 'super-off', channelID: 'x', role: 'super', actived: false, permissions: [] },
  ];
  await seed([], [], [], adminRows);
  const accessCases: any[] = [];
  for (const requester of ['chan', '533538623', 'super-1', 'super-off', 'mod-star', 'mod-view', 'mod-manage', 'mod-off', 'mod-other', 'nobody', '']) {
    for (const channel of ['chan', '533538623', '']) {
      for (const permission of ['eventsubs:view', 'eventsubs:manage']) {
        accessCases.push({ requester, channel, permission, access: await access.getEventsubAccess(requester, channel, permission) });
      }
    }
  }

  const part1 = { reference, sources, table, conditions, extraTemplates, bitsTypes, raidConditions, bitsCases, breaker, catalog: catalogCases, bodies, adminRows, accessCases };
  writeFileSync(`${outDir}/part1.json`, `${JSON.stringify(part1, null, 1)}\n`);
  console.log(`part 1: ${conditions.length} conditions, ${bodies.length} bodies, ${accessCases.length} access cases`);
}

// ------------------------------------------------------------------ cleanup
try {
  await main();
} finally {
  globalThis.Date = RealDate;
  if (!database.startsWith('dima_test_twitch_rec_')) throw new Error('unsafe cleanup');
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  server.close();
}
