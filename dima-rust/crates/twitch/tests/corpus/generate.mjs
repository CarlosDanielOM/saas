// Records what the frozen TypeScript reference does, for `tests/corpus.rs` and
// `tests/refresh_parity_live.rs`. It runs the reference's own source (transpiled with the
// TypeScript compiler, executed in a VM) with every store, clock, network call and log stubbed:
// no application import, no environment read, no network.
//
// Run with Node 24 (the production runtime), offline, from the repository root:
//
//   docker run --rm --network none -e TZ=UTC \
//     -v "$PWD":/work:ro \
//     -v "$PWD/dima-rust/crates/twitch/tests/corpus":/out \
//     -v /home/dom/Projects/saas/dimabot/node_modules/typescript:/deps/typescript:ro \
//     node:24-alpine node /out/generate.mjs
//
// `--check` compares instead of writing. The output records the SHA-256 of every reference file
// it read; `tests/corpus.rs` fails when one changed.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '/deps/typescript/lib/typescript.js';

const ROOT = process.env.REFERENCE_ROOT ?? '/work';
const OUT = process.env.CORPUS_OUT ?? '/out/reference.json';
const SECRET_KEY = 'dima-twitch-test-key';
const NOW_MS = 1_000_000;
assert.equal(new Date(0).getTimezoneOffset(), 0, 'run with TZ=UTC (the services run in UTC)');

const sources = {};
async function source(path) {
  const text = await readFile(`${ROOT}/${path}`, 'utf8');
  sources[path] = createHash('sha256').update(text).digest('hex');
  return text;
}
const commonjs = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
  static now() { return NOW_MS; }
}

// ---------------------------------------------------------------- crypto.ts with chosen IVs
const cryptoText = await source('dimabot/src/utils/crypto.ts');
let ivCounter = 0;
function nextIv() {
  ivCounter += 1;
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(ivCounter, 12);
  return iv;
}
function loadCrypto() {
  const module = { exports: {} };
  const crypto = { createCipheriv, createDecipheriv, randomBytes: (n) => { assert.equal(n, 16); return nextIv(); } };
  vm.runInNewContext(commonjs(cryptoText), {
    module, exports: module.exports, Buffer, process: { env: { SECRET_KEY } },
    require: (name) => { assert.equal(name, 'crypto'); return crypto; },
  });
  return module.exports;
}
const { encrypt, decrypt } = loadCrypto();
const env = (text) => text === undefined ? undefined : encrypt(text);
const plain = (value) => (value && typeof value === 'object' && 'iv' in value) ? { plain: decrypt(value) } : value;

// -------------------------------------------------------- plan_cache_fence.ts (scripts, version)
const fenceModule = { exports: {} };
vm.runInNewContext(commonjs(await source('dimabot/src/utils/plan_cache_fence.ts')), {
  module: fenceModule, exports: fenceModule.exports,
});
const fence = fenceModule.exports;

// ------------------------------------------------- the TwitchStreamers class with stub modules
const streamersText = await source('dimabot/src/classes/twitch_streamers.class.ts');
function loadStreamers({ users, cache }) {
  const modules = {
    'dotenv/config': {},
    'node:crypto': { randomUUID: () => 'fixture-uuid' },
    '../utils/crypto.js': { decrypt },
    '../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => cache },
    '../schemas/users.schema.js': {
      __esModule: true,
      default: { find: () => ({ select: () => ({ lean: async () => users }) }) },
    },
    '../utils/logger.js': Object.fromEntries(['error', 'warn', 'info', 'debug'].map((k) => [k, async () => {}])),
    '../utils/posthog_events.js': { identifyStreamer: () => {} },
    '../utils/plan_cache_fence.js': fence,
  };
  const module = { exports: {} };
  vm.runInNewContext(commonjs(streamersText), {
    module, exports: module.exports, Date: FixtureDate,
    require: (name) => { assert.ok(name in modules, `unexpected import ${name}`); return modules[name]; },
    setTimeout, clearTimeout,
  });
  return module.exports.TwitchStreamers;
}

// 1. isAccessTokenUsable at now = 1000 s.
const usable = [];
{
  const Streamers = loadStreamers({ users: [], cache: {} });
  const instance = new Streamers();
  for (const expiry of [null, '', '1301', '1300', '1061', '1060', '2000garbage', '+2000.9', '-0x10',
    '﻿2000', ' 2000', '\u00852000', 'Infinity', '1e9', '0x7d0', '  1400  ', '١٢٣٤', '1400😀']) {
    for (const skew of [300, 60]) {
      usable.push({ token: 'access', expiry, skew, now: 1000, expected: instance.isAccessTokenUsable('access', expiry, skew) });
    }
  }
  usable.push({ token: '', expiry: '9999', skew: 300, now: 1000, expected: instance.isAccessTokenUsable('', '9999', 300) });
  usable.push({ token: null, expiry: '9999', skew: 300, now: 1000, expected: instance.isAccessTokenUsable(null, '9999', 300) });
}

// 2. getTwitchAccountsFromDB: the WRITE_PLAN_ACCOUNT_SCRIPT arguments per user.
const ext = (value) => {
  if (value instanceof Date) return { $date: { $numberLong: String(value.getTime()) } };
  if (Array.isArray(value)) return value.map(ext);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ext(v)]));
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 31) return { $numberInt: String(value) };
  if (typeof value === 'number') return { $numberDouble: String(value) };
  return value;
};
const baseAccount = () => ({
  _id: { $oid: '000000000000000000000101' }, type: 'twitch', id: '111', name: 'chan', email: 'chan@example.invalid',
  refresh_token: env('refresh-1'), access_token: env('access-1'), access_token_expires_at: 1793104200,
  actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true,
});
const baseUser = () => ({ _id: { $oid: '000000000000000000000001' }, accounts: [baseAccount()], plan_tier: 'free' });
const mappingInputs = [
  ['plan-free', {}],
  ['plan-premium', { plan_tier: 'premium' }],
  ['plan-pro-until', { plan_tier: 'pro', plan_tier_until: new Date(Date.UTC(2026, 10, 11, 23, 59, 59)) }],
  ['plan-until-old-year', { plan_tier_until: new Date(Date.UTC(5, 0, 1)) }],
  ['polar-version', { polar_plan_event_at: new Date(1_700_000_000_000), polar_plan_event_key: 'evt_1' }],
  ['polar-version-key-missing', { polar_plan_event_at: new Date(1_700_000_000_000) }],
  ['polar-customer', { polar_sh_customer_id: 'cus_1' }],
  ['nulls', { plan_tier_until: null, polar_sh_customer_id: null }, { name: null, email: null, access_token_expires_at: null }],
  ['expiry-missing', {}, { access_token_expires_at: undefined }],
  ['expiry-zero', {}, { access_token_expires_at: 0 }],
  ['expiry-double', {}, { access_token_expires_at: 1793104200.5 }],
  ['expiry-past-int32', {}, { access_token_expires_at: 2_200_000_000 }],
  ['cache-expiry-wins', {}, {}, '1700000000'],
  ['cache-expiry-empty', {}, {}, ''],
  ['flags-false', {}, { actived: false, chat_enabled: false, has_permissions: false, up_to_date_permissions: false }],
  ['empty-envelopes', {}, { refresh_token: { iv: '', content: '' }, access_token: { iv: null, content: null } }],
  ['missing-envelopes', {}, { refresh_token: undefined, access_token: undefined }],
  ['unicode', {}, { name: 'cañón_👋', email: 'ñandú+🎮@example.invalid', refresh_token: env('rëfresh 🎮'), access_token: env('مرحبا é') }],
  ['second-account-first', {}, null],
];
const mapping = [];
for (const [name, userChanges, accountChanges, cachedExpiry] of mappingInputs) {
  const user = { ...baseUser(), ...userChanges };
  if (accountChanges === null) {
    user.accounts = [{ ...baseAccount(), _id: { $oid: '000000000000000000000102' }, type: 'youtube', id: 'yt' }, baseAccount()];
  } else {
    user.accounts = [{ ...baseAccount(), ...(accountChanges ?? {}) }];
  }
  for (const account of user.accounts) {
    for (const [k, v] of Object.entries(account)) if (v === undefined) delete account[k];
  }
  const writes = [];
  const hashes = new Map();
  if (cachedExpiry !== undefined) hashes.set('accounts:twitch:111:data', { expires_at: cachedExpiry });
  const cache = {
    del: async () => 1, sAdd: async () => 1,
    hGet: async (key, field) => hashes.get(key)?.[field] ?? null,
    eval: async (script, { keys, arguments: args }) => {
      assert.equal(script, fence.WRITE_PLAN_ACCOUNT_SCRIPT);
      writes.push({ keys, args });
      return 1;
    },
  };
  const Streamers = loadStreamers({ users: [user], cache });
  const accepted = await new Streamers().getTwitchAccountsFromDB();
  assert.equal(accepted?.length, 1, name);
  const stored = { ...user, accounts: user.accounts.map((a) => ({ ...a, _id: a._id })) };
  mapping.push({ name, user: ext(stored), cached_expires_at: cachedExpiry ?? null, keys: writes[0].keys, args: writes[0].args });
}

// 3. Refresh failure classification.
const tokensText = await source('dimabot/src/utils/tokens.ts');
const tokensAst = ts.createSourceFile('tokens.ts', tokensText, ts.ScriptTarget.Latest, true);
const pick = (names, variables = []) => tokensAst.statements.filter((s) =>
  (ts.isFunctionDeclaration(s) && names.includes(s.name?.text))
  || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => variables.includes(d.name.getText(tokensAst))))
).map((s) => s.getText(tokensAst).replace(/^export\s+/, '')).join('\n');
const classify = vm.runInNewContext(
  ts.transpileModule(`${pick(['getRefreshFailureMessage', 'isPermanentRefreshFailure'])}\n({getRefreshFailureMessage, isPermanentRefreshFailure});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {});
const classification = [];
for (const payload of [
  { status: 400, message: 'Invalid refresh token' },
  { error: 'Bad Request', status: 400, message: 'invalid client secret' },
  { status: 400, message: 'missing client secret' },
  { status: 403, message: 'invalid client' },
  { error: 'invalid_grant', error_description: 'The authorization grant is invalid' },
  { message: 'Authorization has been REVOKED' },
  { message: '  ', error_description: ' ', error: 'x' },
  { message: 5, error: ['invalid refresh token'] },
  { message: 'İNVALİD REFRESH TOKEN' },
  { message: 'invalid refresh 🔑 token' },
  'Invalid refresh token', null, [], {},
]) {
  for (const status of [400, 401, 403, 500, 200]) {
    classification.push({
      status, payload,
      message: classify.getRefreshFailureMessage(payload),
      permanent: classify.isPermanentRefreshFailure(status, payload),
    });
  }
}

// 4. formatBadges.
const badgesText = await source('dimabot/src/utils/badges.ts');
const badgesModule = { exports: {} };
vm.runInNewContext(commonjs(badgesText), { module: badgesModule, exports: badgesModule.exports });
const b = (set_id, info = '', id = '1') => ({ set_id, id, info });
const badges = [];
for (const list of [
  [], [b('broadcaster'), b('subscriber', '12')], [b('moderator'), b('vip'), b('founder', '3')],
  [b('vip'), b('subscriber', '0')], [b('subscriber', '')], [b('subscriber', '0x1A')], [b('subscriber', '12abc')],
  [b('subscriber', '-3')], [b('subscriber', ' 7')], [b('subscriber', '١٢')], [b('subscriber', '1e3')],
  [b('subscriber', '-0')], [b('subscriber', '12.9')], [b('subscriber', '99999999999999999999')],
  [b('premium'), b('partner'), b('staff'), b('turbo'), b('sub-gifter', '50')],
  [b('sub-gifter'), b('turbo'), b('staff'), b('partner'), b('premium')],
  [b('subscriber', '5'), b('subscriber', '9')], [b('glhf-pledge'), b('bits', '100')],
  [b('founder', '😀'), b('subscriber', '2')],
]) {
  badges.push({ badges: list, expected: await badgesModule.exports.formatBadges({ badges: list }) });
}

// 5. refreshTwitchToken traces.
const refreshSource = pick(['getRefreshFailureMessage', 'isPermanentRefreshFailure', 'invalidateStoredTwitchTokens'],
  ['REFRESH_MAX_ATTEMPTS', 'REFRESH_RETRY_BACKOFF_MS', 'refreshTwitchToken']);
const scenarios = [
  ['success', [[200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }]]],
  ['default-expiry', [[200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: '3600' }]]],
  ['fractional-expiry', [[200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600.5 }]]],
  ['permanent', [[400, { status: 400, message: 'Invalid refresh token' }]]],
  ['permanent-401-revoked', [[401, { status: 401, message: 'authorization has been revoked' }]]],
  ['rotated-usable', [[400, { status: 400, message: 'Invalid refresh token' }]], { stored: 'winner', expires: '4600' }],
  ['rotated-expired', [[400, { status: 400, message: 'Invalid refresh token' }]], { stored: 'winner', expires: '1050' }],
  ['transient-client-secret', [[400, { error: 'Bad Request', status: 400, message: 'invalid client secret' }]]],
  ['transient-forbidden', [[403, { status: 403, message: 'invalid client' }]]],
  ['transient-503-three-times', [[503, { message: 'busy' }], [503, { message: 'busy' }], [503, { message: 'busy' }]]],
  ['transient-503-then-success', [[503, { message: 'busy' }], [200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }]]],
  ['error-flag-on-200', [[200, { error: 'temporarily_unavailable' }]]],
  ['incomplete', [[200, { access_token: 'new-access' }]]],
  ['empty-body', [[200, '']]],
  ['unparseable-502', [[502, '<html>bad gateway</html>'], [502, '<html>bad gateway</html>'], [502, '<html>bad gateway</html>']]],
  ['unparseable-200', [[200, '{"access_token":"new-acc']]],
  ['missing-user', [[200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }]], { missingUser: true }],
];
const refresh = [];
for (const [name, answers, options = {}] of scenarios) {
  const fields = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '1000' };
  if (options.stored) Object.assign(fields, { access_token: 'winner-access', refresh_token: 'winner-refresh', expires_at: options.expires });
  const effects = { store: [], cache: [], actions: [] };
  let call = 0;
  const log = (level) => async (data) => { effects.actions.push(`${level}:${data.action ?? data.reason ?? ''}`); };
  const run = vm.runInNewContext(
    ts.transpileModule(`${refreshSource}\nrefreshTwitchToken;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
      process: { env: { CLIENT_ID: 'fixture-id', CLIENT_SECRET: 'fixture-secret' } },
      URLSearchParams, Date: FixtureDate, sleep: async () => {},
      fetch: async () => {
        const [status, body] = answers[Math.min(call, answers.length - 1)];
        call += 1;
        return { status, ok: status >= 200 && status < 300, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
      },
      getTwitchOAuthUrl: () => 'http://fixture.invalid/oauth2/token',
      getDragonflyClient: async () => ({
        hSet: async (_, patch) => { effects.cache.push(patch); Object.assign(fields, patch); },
        hGet: async (_, key) => fields[key] ?? null,
      }),
      UsersSchema: {
        findOne: async () => options.missingUser ? null : {},
        findOneAndUpdate: async (filter, update) => {
          effects.store.push(Object.fromEntries(Object.entries(update.$set).map(([k, v]) => [k, plain(v)])));
        },
      },
      TwitchStreamers: { getAccountRefreshTokenById: async () => fields.refresh_token },
      encrypt, cacheOAuthTokenRefreshFailure: async () => {},
      logError: log('error'), logInfo: log('info'), logWarn: log('warn'),
    });
  const result = await run('old-refresh', 'fixture-user', { endpoint: 'token_refresh', caller: 'corpus' });
  assert.ok(!/not a constructor|not defined/.test(result.message ?? ''), `${name}: incomplete sandbox`);
  refresh.push({ name, answers, options, attempts: call, result: JSON.parse(JSON.stringify(result)), effects, finalCache: fields });
}

const output = JSON.stringify({
  generator: 'dima-rust/crates/twitch/tests/corpus/generate.mjs',
  node: process.version,
  typescript: ts.version,
  secret_key: SECRET_KEY,
  now_ms: NOW_MS,
  sources,
  usable, mapping, classification, badges, refresh,
}, null, 2) + '\n';
if (process.argv.includes('--check')) {
  assert.equal(await readFile(OUT, 'utf8'), output, 'the corpus is stale: regenerate it');
} else {
  await writeFile(OUT, output);
}
console.log(`usable ${usable.length}, mapping ${mapping.length}, classification ${classification.length}, badges ${badges.length}, refresh ${refresh.length}`);
