// Source oracle: actual TS directory, token lifecycle and identity helper run in
// a closed VM. No application import, environment credential, socket or timer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
process.env.TZ = 'UTC';
const root = new URL('../../../', import.meta.url);
const require = createRequire(new URL('dimabot/package.json', root));
const ts = require('typescript');
const paths = ['src/classes/twitch_streamers.class.ts', 'src/utils/tokens.ts', 'src/utils/posthog_events.ts', 'src/utils/plan_cache_fence.ts'];
const sources = Object.fromEntries(paths.map(path => [path, readFileSync(new URL(`dimabot/${path}`, root), 'utf8')]));
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function execute(text, modules, globals = {}, filename = 'source.js') {
  const module = { exports: {} };
  vm.runInNewContext(compile(text), { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `unmocked import ${name}`); return modules[name];
  }, ...globals }, { filename });
  return module.exports;
}
const fence = execute(sources[paths[3]], {});
const versionField = fence.PLAN_CACHE_VERSION_FIELD;
const encrypted = content => ({ iv: 'fixture-only', content });
const clone = value => structuredClone(value);
const user = (id = 'user', changes = {}, accountChanges = {}) => ({
  accounts: [{ type: 'twitch', id, name: `owner-${id}`, email: `${id}@example.invalid`,
    access_token: encrypted('old-access'), refresh_token: encrypted('old-refresh'),
    access_token_expires_at: 1000, actived: true, chat_enabled: true,
    has_permissions: true, up_to_date_permissions: false, ...accountChanges }],
  plan_tier: 'free', ...changes,
});
const hash = (id = 'user', changes = {}) => ({ id, name: `owner-${id}`, email: `${id}@example.invalid`,
  plan_tier: 'free', plan_tier_until: '', polar_sh_customer_id: '', actived: 'true', chat_enabled: 'true',
  access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '1000',
  has_permissions: 'true', up_to_date_permissions: 'false', [versionField]: '', ...changes });
const credentials = fields => Object.fromEntries(['access_token', 'refresh_token', 'expires_at', 'has_permissions', 'up_to_date_permissions']
  .filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key]]));
const publicHash = fields => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== versionField));
const sorted = values => [...values].sort();
function normalizeResult(operation, result, error) {
  if (error) return { error };
  if (operation === 'db' || operation === 'update') throw new Error('reconciliation result must be explicit');
  if (result === null) return { error: 'Missing' };
  if (operation === 'list') result = [...result].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (operation === 'ids') result = sorted(result);
  return { ok: result };
}
async function run(input, operation) {
  const users = clone(input.users ?? [user()]);
  for (const user of users) for (const field of ['polar_plan_event_at', 'plan_tier_until']) {
    if (typeof user[field] === 'string') user[field] = new Date(user[field]);
  }
  const hashes = clone(input.hashes ?? {});
  const members = new Set(input.ids ?? []);
  const strings = new Map();
  if (input.aggregate !== undefined) strings.set('twitch:accounts', typeof input.aggregate === 'string' ? input.aggregate : JSON.stringify(input.aggregate));
  let nowMs = 1_000_000;
  const acquisitions = [...(input.acquire ?? [])], held = [...(input.held ?? [])];
  const logs = [], captures = [], identityRequests = [], oauthRequests = [], leases = [];
  let releases = 0, sleeps = 0, dbReads = 0;
  const publish = fields => { hashes['accounts:twitch:user:data'] = { ...(hashes['accounts:twitch:user:data'] ?? {}), ...fields }; };
  const fail = name => { if (input.fault === name) throw new Error(`fixture-${name}`); };
  const cache = {
    get: async key => { fail('cache_read'); return strings.get(key) ?? null; },
    set: async (key, value, options) => {
      if (key.startsWith('locks:')) {
        leases.push(options.PX);
        const acquired = acquisitions.length ? acquisitions.shift() : !strings.has(key);
        if (acquired) { strings.set(key, value); if (input.publish_on_acquire) publish(input.publish_on_acquire); }
        return acquired ? 'OK' : null;
      }
      strings.set(key, value); return 'OK';
    },
    del: async key => { if (key.startsWith('locks:')) releases++; return Number(strings.delete(key)); },
    exists: async key => held.length ? Number(held.shift()) : Number(strings.has(key)),
    hGet: async (key, field) => { fail('cache_read'); return hashes[key]?.[field] ?? null; },
    hGetAll: async key => { fail('cache_read'); return clone(hashes[key] ?? {}); },
    hSet: async (key, fields) => { fail('cache_write'); hashes[key] = { ...(hashes[key] ?? {}), ...fields }; return 1; },
    sAdd: async (_, id) => { members.add(id); return 1; },
    sMembers: async () => { fail('cache_read'); return [...members]; },
    keys: async () => { fail('cache_read'); return Object.keys(hashes).filter(key => key.startsWith('accounts:twitch:')); },
    eval: async (script, { keys, arguments: args }) => {
      if (script === fence.WRITE_PLAN_ACCOUNT_SCRIPT) {
        fail('publish');
        const id = keys[1].slice('accounts:twitch:'.length, -':data'.length);
        if ((input.fences?.[id] ?? '') > args[0]) return 0;
        const fields = {}; for (let i = 1; i < args.length; i += 2) fields[args[i]] = args[i + 1];
        hashes[keys[1]] = { ...(hashes[keys[1]] ?? {}), ...fields };
        strings.delete('twitch:accounts'); return 1;
      }
      assert.equal(script, fence.CHECK_PLAN_ACCOUNTS_SCRIPT);
      for (let i = 0; i < keys.length - 1; i++) {
        const id = keys[i].slice('twitch:'.length, -':ai:credits:plan-version'.length);
        if ((input.fences?.[id] ?? '') > args[i]) return 0;
      }
      if (args.at(-1)) strings.set('twitch:accounts', args.at(-1));
      return 1;
    },
  };
  const findUser = query => {
    fail('db_read'); dbReads++;
    const id = query.accounts?.$elemMatch?.id ?? query['accounts.id'];
    return users.find(user => user.accounts.some(account => account.id === id && account.type === 'twitch')) ?? null;
  };
  const schema = {
    find: () => ({ select: () => ({ lean: async () => { fail('db_read'); dbReads++; return clone(users); } }) }),
    findOne: query => {
      const value = () => clone(findUser(query));
      return { select: () => ({ lean: async () => value() }), then: (resolve, reject) => Promise.resolve().then(value).then(resolve, reject) };
    },
    findOneAndUpdate: async (query, update) => {
      fail('db_write');
      const stored = findUser(query); if (!stored) return null;
      const account = stored.accounts.find(account => account.id === query['accounts.id']);
      for (const [key, value] of Object.entries(update.$set)) account[key.slice('accounts.$.'.length)] = clone(value);
      return stored;
    },
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [nowMs])); } static now() { return nowMs; } }
  const globals = {
    Date: FakeDate, URLSearchParams,
    process: { env: { CLIENT_ID: 'fixture-client', CLIENT_SECRET: 'fixture-secret' } },
    setTimeout: (callback, milliseconds) => { nowMs += milliseconds; sleeps++; if (input.publish_on_sleep && sleeps === 1) publish(input.publish_on_sleep); callback(); return 0; },
    clearTimeout: () => {},
  };
  const logger = Object.fromEntries(['error', 'warn', 'info', 'debug'].map(level => [level, async (data, options) => { logs.push({ level, data: clone(data), options: clone(options) }); }]));
  const events = execute(sources[paths[2]], {
    'posthog-node': { PostHog: class { identify(event) { captures.push(clone(event)); } } },
    './ai_usage_event.js': { AI_USAGE_SCHEMA_VERSION: 1 },
  }, globals, 'posthog_events.js');
  const tokenModule = {};
  const classModule = execute(sources[paths[0]], {
    'dotenv/config': {}, 'node:crypto': { randomUUID: () => 'fixture-owner' },
    '../utils/crypto.js': { decrypt: value => value?.content || null },
    '../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => cache },
    '../schemas/users.schema.js': schema, '../utils/logger.js': logger,
    '../utils/posthog_events.js': { identifyStreamer: (id, name) => { identityRequests.push([id, name]); events.identifyStreamer(id, name); } },
    '../utils/plan_cache_fence.js': fence, '../utils/tokens.js': tokenModule,
  }, globals, 'twitch_streamers.class.js');
  Object.assign(tokenModule, execute(sources[paths[1]], {
    './databases/dragonfly.database.js': { getDragonflyClient: async () => cache },
    '../classes/twitch_streamers.class.js': classModule, '../schemas/users.schema.js': schema,
    './crypto.js': { encrypt: encrypted }, './links.js': { getTwitchOAuthUrl: () => 'https://fixture.invalid/token' },
    './oauth_debug_cache.js': { cacheOAuthTokenRefreshFailure: async () => {} }, './logger.js': logger,
  }, { ...globals, fetch: async (url, options) => {
    oauthRequests.push({ url, refresh_token: new URLSearchParams(options.body).get('refresh_token') });
    const outcome = input.oauth ?? 'success';
    const status = outcome === 'transient' ? 503 : outcome === 'revoked' ? 400 : 200;
    const body = outcome === 'transient' ? { message: 'fixture transient' }
      : outcome === 'revoked' ? { message: 'invalid refresh token' }
      : { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
    return { status, ok: status === 200, text: async () => JSON.stringify(body) };
  } }, 'tokens.js'));
  const service = classModule.default;
  const invoke = async () => {
    switch (operation) {
      case 'account': return service.getTwitchAccountById('user');
      case 'reconcile_account': await service.getTwitchAccountsFromDB(); return service.getTwitchAccountById('user');
      case 'list': return service.getTwitchAccountsFromCache();
      case 'db': return service.getTwitchAccountsFromDB();
      case 'ids': return service.getTwitchStreamers();
      case 'update': return service.updateTwitchAccountsInCache();
      case 'token': return vm.runInNewContext("async function behaviorCommand() { return service.getAccountTokenById('user', platform); } behaviorCommand();", {
        service, platform: input.platform ?? 'twitch',
      }, { filename: 'behavior_caller.js' });
      case 'refresh': return service.getAccountRefreshTokenById('user', input.platform ?? 'twitch');
      case 'identity': {
        const results = [await service.getTwitchAccountsFromDB(), await service.getTwitchAccountsFromDB()];
        if (input.rename !== undefined) { users[0].accounts[0].name = input.rename; results.push(await service.getTwitchAccountsFromDB()); }
        return results.map(result => result?.length ?? null);
      }
      default: throw new Error(`unknown operation ${operation}`);
    }
  };
  const result = await invoke();
  const records = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => [key, publicHash(value)]));
  const storedCredentials = Object.fromEntries(users.flatMap(user => user.accounts.filter(account => account.type === 'twitch').map(account => [account.id, {
    access_token: account.access_token?.content || '', refresh_token: account.refresh_token?.content || '',
    expires_at: account.access_token_expires_at == null ? '' : String(account.access_token_expires_at),
    has_permissions: Boolean(account.has_permissions), up_to_date_permissions: Boolean(account.up_to_date_permissions),
  }])));
  const tokenLogs = logs.filter(log => log.data.function === 'TwitchStreamers.getAccountTokenById');
  if (operation === 'token') {
    assert.ok(tokenLogs.length > 0, 'source token request logs');
    assert.ok(tokenLogs.every(log => log.data.caller.startsWith('behaviorCommand (behavior_caller.js:')), 'caller skips token pipeline frames and points at the requesting command');
    assert.ok(tokenLogs.every(log => log.options.channelId === 'user' && log.options.destination === 'cache'));
    assert.ok(!JSON.stringify(tokenLogs).includes('old-refresh'), 'token request diagnostics do not include secrets');
    assert.ok(logs.filter(log => log.data.function === 'refreshTwitchToken').every(log => log.data.caller === tokenLogs[0].data.caller), 'OAuth lifecycle receives the originating caller');
  }
  return { result: result === undefined ? { undefined: true } : clone(result),
    state: { records, stored_credentials: storedCredentials, ids: sorted(members), identity_requests: identityRequests, oauth_used: oauthRequests.length > 0,
      acquisitions: leases.length, releases, locked: [...strings.keys()].some(key => key.startsWith('locks:')) },
    diagnostics: { posthog_events: captures, oauth_requests: oauthRequests.length, lease_ms: leases, sleeps, db_reads: dbReads,
      log_actions: logs.filter(log => log.data.action).map(log => log.data.action), caller_present: tokenLogs.length ? tokenLogs.every(log => Boolean(log.data.caller)) : null,
      caller: tokenLogs[0]?.data.caller ?? null } };
}
const cases = [];
async function add(name, operation, input, expected = {}, reason = null) {
  const source = await run(input, operation);
  if (expected.error) assert.ok(source.result === null || (Array.isArray(source.result) && source.result.length === 0), `${name}: source failure must remain observable`);
  let result = expected.result;
  if (!result) result = normalizeResult(operation, source.result, expected.error);
  const native = { result, state: { ...clone(source.state), ...clone(expected.state ?? {}) } };
  // A caller must name every accepted state difference explicitly. Error/result
  // normalization is recorded separately from implementation improvements.
  cases.push({ name, operation, input, classification: reason ? 'approved-difference' : 'exact',
    reason: reason ?? 'Same public value and meaningful state after typed missing/error and sorted collection normalization.', source, expected: native });
}
const key = 'accounts:twitch:user:data';
const kickKey = 'accounts:kick:user:data';
const withHash = changes => ({ hashes: { [key]: hash('user', changes) }, ids: ['user'] });
const errorReason = 'Rust preserves the failure as a typed error instead of TypeScript null/empty success.';
await add('account-cache-hit', 'account', withHash({ expires_at: '4600' }));
await add('account-cold', 'account', {});
for (const [name, expiry, nativeExpiry] of [['null', null, ''], ['zero', 0, '0']]) {
  const nativeAccount = publicHash(hash('user', { expires_at: nativeExpiry }));
  await add(`account-cold-persisted-expiry-${name}`, 'account', {
    users: [user('user', {}, { access_token_expires_at: expiry })],
  }, { result: { ok: nativeAccount }, state: { records: { [key]: nativeAccount } } },
  expiry === null
    ? 'The source omits unknown persisted expiry from its full DTO and hash; the closed native DTO and credential tuple represent unknown expiry as an empty string. Both remain unusable, with no OAuth exchange or permission change.'
    : 'The source truthiness check omits persisted zero expiry from its full DTO and hash; the native credential tuple preserves the stored value as string zero. Both remain unusable, with no OAuth exchange or permission change.');
}
await add('account-missing', 'account', { users: [] });
await add('account-plan-stale-rehydrates', 'account', { ...withHash({ plan_tier: 'free' }), fences: { user: '0000000001000:new' }, users: [user('user', { plan_tier: 'pro', polar_plan_event_at: '1970-01-01T00:00:01.000Z', polar_plan_event_key: 'new' })] });
await add('account-cache-read-failure', 'account', { fault: 'cache_read' }, { error: 'CacheUnavailable' }, errorReason);
await add('account-store-read-failure', 'account', { fault: 'db_read' }, { error: 'StoreUnavailable' }, errorReason);
await add('list-legacy-aggregate', 'list', { ...withHash({}), aggregate: [hash()] });
await add('list-hash-fallback', 'list', withHash({}));
const missingExpiry = hash('user', { has_permissions: 'false', up_to_date_permissions: 'false' }); delete missingExpiry.expires_at;
await add('list-legacy-missing-optional-expiry', 'list', { hashes: { [key]: missingExpiry }, ids: ['user'], users: [user('user', {}, { access_token_expires_at: null, has_permissions: false })] }, {
  result: { ok: [{ ...publicHash(missingExpiry), expires_at: '' }] },
}, 'A typed native account represents absent optional expiry as an empty string; the legacy hash must remain untouched, and false permission flags are preserved.');
await add('list-empty', 'list', { users: [] });
await add('list-plan-stale', 'list', { ...withHash({}), fences: { user: 'new' } }, { error: 'Stale' }, errorReason);
await add('list-cache-failure', 'list', { fault: 'cache_read' }, { error: 'CacheUnavailable' }, errorReason);
await add('list-orphan-hash-excluded', 'list', { hashes: { [key]: hash() } }, { result: { ok: [] } }, 'ID membership is authoritative; Rust does not discover unindexed hashes through KEYS.');
await add('list-ignores-corrupt-legacy-aggregate', 'list', { ...withHash({}), aggregate: '{broken' }, { result: { ok: [publicHash(hash())] } }, 'Rust reads bounded indexed hashes rather than parsing the legacy serialized aggregate.');
const report = { ok: { published: 1, removed: 0, checked: 1 } };
await add('db-refresh-current-credentials-preserved', 'db', withHash({ access_token: 'current-access', refresh_token: 'current-refresh', expires_at: '4600', has_permissions: 'false' }), {
  result: report, state: { records: { [key]: publicHash(hash('user', { access_token: 'current-access', refresh_token: 'current-refresh', expires_at: '4600', has_permissions: 'false' })) } },
}, 'Reconciliation returns a metadata report and preserves the current credential tuple and permission flags; TypeScript rewrites credentials from DB.');
const metadataOnly = Object.fromEntries(Object.entries(publicHash(hash())).filter(([field]) => !['id', ...Object.keys(credentials(hash()))].includes(field)));
await add('db-cold-metadata-only', 'db', {}, { result: report, state: { records: { [key]: metadataOnly } } }, 'Reconciliation publishes metadata and membership without decrypting credentials or creating a complete-account id marker.');
const twoTwitch = user('first'); twoTwitch.accounts.push(user('second').accounts[0]);
const metadataFor = id => Object.fromEntries(Object.entries(publicHash(hash(id))).filter(([field]) => !['id', ...Object.keys(credentials(hash(id)))].includes(field)));
await add('db-publishes-both-twitch-identities', 'db', { users: [twoTwitch] }, {
  result: { ok: { published: 2, removed: 0, checked: 2 } },
  state: { records: { 'accounts:twitch:first:data': metadataFor('first'), 'accounts:twitch:second:data': metadataFor('second') },
    ids: ['first', 'second'], identity_requests: [['first', 'owner-first'], ['second', 'owner-second']] },
}, 'Bulk native reconciliation deliberately publishes every Twitch identity in the user, while the source selects only the first. Both native cache hashes remain metadata-only; membership, identity requests and the report explicitly include both accounts.');
await add('db-absent-account-removes-orphan', 'db', { ...withHash({}), users: [] }, { result: { ok: { published: 0, removed: 1, checked: 0 } }, state: { records: {}, ids: [] } }, 'Full reconciliation evicts authoritatively absent accounts and their membership instead of retaining stale hashes.');
await add('db-read-failure', 'db', { fault: 'db_read' }, { result: { error: 'StoreUnavailable' } }, errorReason);
await add('account-after-reconcile-missing-optional-expiry', 'reconcile_account', { hashes: { [key]: missingExpiry }, ids: ['user'], users: [user('user', {}, { access_token_expires_at: null, has_permissions: false })] }, {
  result: { ok: { ...publicHash(missingExpiry), expires_at: '' } },
}, 'Metadata reconciliation keeps a complete account readable when optional expiry is absent; the typed public expiry is empty while the cache field stays absent and permissions stay false.');
await add('ids-sort-index', 'ids', { ids: ['z', 'a', 'user'] });
await add('ids-empty', 'ids', { users: [] });
await add('ids-cache-failure', 'ids', { fault: 'cache_read' }, { error: 'CacheUnavailable' }, errorReason);
await add('update-metadata', 'update', withHash({}), { result: report }, 'The update wrapper maps to explicit metadata reconciliation and returns its report.');
await add('update-store-failure', 'update', { fault: 'db_read' }, { result: { error: 'StoreUnavailable' } }, 'Rust reports refresh failure; the TypeScript update wrapper swallows the nested null result.');
await add('identity-first-and-repeat', 'identity', withHash({}), { result: { ok: [1, 1] } });
await add('identity-rename', 'identity', { ...withHash({}), rename: 'renamed' }, { result: { ok: [1, 1, 1] } });
await add('identity-empty-name', 'identity', { ...withHash({}), users: [user('user', {}, { name: '' })] }, { result: { ok: [1, 1] } });
for (const [name, changes] of [
  ['valid', { expires_at: '4600' }], ['skew-301', { expires_at: '1301' }], ['skew-300', { expires_at: '1300' }],
  ['skew-299', { expires_at: '1299' }], ['expired', {}], ['missing-expiry', { expires_at: '' }],
  ['missing-access', { access_token: '' }], ['permission-false', { expires_at: '4600', has_permissions: 'false' }],
]) await add(`twitch-token-${name}`, 'token', withHash(changes));
const coldNative = Object.fromEntries(Object.entries(credentials(hash())).map(([field, value]) => [field, value]));
await add('twitch-token-cold-valid', 'token', { users: [user('user', {}, { access_token_expires_at: 4600 })] }, {
  result: { ok: 'old-access' }, state: { records: { [key]: { ...coldNative, expires_at: '4600' } },
    stored_credentials: { user: { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '4600', has_permissions: true, up_to_date_permissions: false } },
    identity_requests: [], oauth_used: false, acquisitions: 0, releases: 0 },
}, 'Cold native credentials reuse the valid persisted token with its own expiry and publish credential fields plus membership; TS also hydrates metadata and performs OAuth.');
await add('twitch-token-cold-expired', 'token', {}, {
  state: { records: { [key]: { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: '4600', has_permissions: 'true', up_to_date_permissions: 'true' } }, identity_requests: [] },
}, 'Cold native token acquisition hydrates credentials and membership; metadata/id marker/identity remain owned by directory hydration.');
for (const [name, changes, error] of [
  ['valid', { expires_at: '4600' }, null], ['skew-301', { expires_at: '1301' }, null],
  ['skew-300', { expires_at: '1300' }, 'UnsupportedRefresh'], ['expired', {}, 'UnsupportedRefresh'],
  ['missing-expiry', { expires_at: '' }, 'UnsupportedRefresh'],
]) await add(`kick-token-${name}`, 'token', { platform: 'kick', hashes: { [kickKey]: hash('user', changes) } }, error ? { error } : {}, error ? errorReason : null);
await add('kick-token-missing', 'token', { platform: 'kick', users: [] }, { error: 'Missing' }, errorReason);
await add('refresh-twitch-cached', 'refresh', withHash({}));
await add('refresh-twitch-cold', 'refresh', {}, { state: { records: { [key]: coldNative }, identity_requests: [] } }, 'Native refresh-secret retrieval hydrates credential fields and membership; TS also publishes metadata/id marker and identifies.');
await add('refresh-twitch-missing', 'refresh', { users: [] });
for (const [name, value] of [['missing', null], ['empty', '']]) {
  const fields = hash(); if (value === null) delete fields.refresh_token; else fields.refresh_token = value;
  await add(`refresh-twitch-partial-${name}`, 'refresh', { hashes: { [key]: fields }, ids: ['user'] }, {
    state: { records: { [key]: publicHash(fields) }, identity_requests: [] },
  }, 'The getter returns the authoritative stored refresh secret, matching the source result, while preserving the existing partial cache tuple and permission flags without a DB-to-cache overwrite or metadata identity request.');
}
const newerPartial = hash('user', { access_token: 'newer-access', expires_at: '', has_permissions: 'false', up_to_date_permissions: 'false' });
delete newerPartial.refresh_token;
await add('refresh-twitch-partial-preserves-newer-cache-and-false-permissions', 'refresh', {
  hashes: { [key]: newerPartial }, ids: ['user'],
}, { state: { records: { [key]: publicHash(newerPartial) }, identity_requests: [] } },
'The getter returns the authoritative stored refresh secret after rechecking the stable partial tuple; it preserves newer cached access, unknown expiry and false permission flags rather than overwriting them with older stored credentials.');
const tombstone = { access_token: '', refresh_token: '', expires_at: '', has_permissions: 'false', up_to_date_permissions: 'false' };
await add('refresh-twitch-revocation-tombstone', 'refresh', withHash(tombstone), {
  result: { error: 'Credentials(Revoked)' }, state: { records: { [key]: publicHash(hash('user', tombstone)) }, identity_requests: [] },
}, 'An explicit complete revocation tombstone must not be revived from stale stored credentials.');
await add('refresh-kick-cached', 'refresh', { platform: 'kick', hashes: { [kickKey]: hash() } });
await add('refresh-kick-empty', 'refresh', { platform: 'kick', hashes: { [kickKey]: hash('user', { refresh_token: '' }) } });
await add('refresh-cache-failure', 'refresh', { fault: 'cache_read' }, { error: 'Credentials(CacheUnavailable)' }, errorReason);
await add('lock-owner', 'token', { ...withHash({}), acquire: [true] });
await add('lock-waiter-61', 'token', { ...withHash({}), acquire: [false], publish_on_sleep: { access_token: 'winner-access', expires_at: '1061' } });
await add('lock-waiter-60-takeover', 'token', { ...withHash({}), acquire: [false, true], held: [false], publish_on_sleep: { access_token: 'winner-access', expires_at: '1060' } });
await add('lock-takeover', 'token', { ...withHash({}), acquire: [false, true], held: [false] });
await add('lock-busy-timeout', 'token', { ...withHash({}), acquire: [false, false], held: Array(30).fill(true) }, { error: 'Busy' }, errorReason);
await add('lock-double-check', 'token', { ...withHash({}), publish_on_acquire: { access_token: 'winner-access', expires_at: '4600' } });
await add('oauth-transient-preserves-credentials', 'token', { ...withHash({}), oauth: 'transient' }, { error: 'Credentials(RefreshTransient)' }, errorReason);
await add('oauth-revoked-clears-credentials', 'token', { ...withHash({}), oauth: 'revoked' }, { error: 'Credentials(Revoked)' }, errorReason);
await add('oauth-store-failure', 'token', { ...withHash({}), fault: 'db_write' }, { error: 'Credentials(PersistenceAfterOAuth)' }, errorReason);
await add('oauth-cache-after-persistence-failure', 'token', { ...withHash({}), fault: 'cache_write' }, { error: 'Credentials(CacheAfterPersistence)' }, errorReason);
// Source expectations guard oracle seams and all retained source-only assertions.
assert.equal(cases.find(c => c.name === 'identity-first-and-repeat').source.diagnostics.posthog_events.length, 1);
assert.equal(cases.find(c => c.name === 'identity-rename').source.diagnostics.posthog_events.length, 2);
assert.equal(cases.find(c => c.name === 'identity-empty-name').source.diagnostics.posthog_events.length, 0);
for (const c of cases) {
  assert.ok(c.expected.result.ok !== undefined || c.expected.result.error, c.name);
  if (c.operation === 'token' && c.source.state.oauth_used) assert.ok(c.source.diagnostics.oauth_requests >= 1, c.name);
  if (c.name.startsWith('refresh-twitch-partial-')) assert.equal(c.source.result, 'old-refresh', c.name);
}
const artifact = {
  version: 1, timezone: 'UTC', sources: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(sources[path]).digest('hex')])),
  normalization: ['TypeScript null maps to a named typed error; original null remains in source.result.', 'Collections are sorted by id for comparison; membership and full account contents remain asserted.', 'DB/update outputs explicitly map accepted full-user lists/void to metadata reconciliation reports.', 'Internal plan/directory generation fields and serialized aggregate maintenance are excluded; account values, membership and credential side effects remain asserted.', 'Native diagnostic payloads use explicit caller context; source stack caller presence and native caller/channel/action are separately asserted.'],
  gaps: ['Provider transport retries are covered by the separate token lifecycle suite; this suite compares OAuth use while preserving the source fetch-attempt count.', 'The injected native identity sink checks publication requests; production PostHog transport and dedup adapter require the optional posthog profile.', 'No live store adapters, real OAuth provider, cancellation scheduling, or cross-process Redis atomicity are exercised by these in-memory differential fixtures.'],
  cases,
};
const target = new URL('twitch_streamers_behavior.json', import.meta.url);
const rendered = JSON.stringify(artifact, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), rendered, 'regenerate streamer behavioral source fixture');
else writeFileSync(target, rendered);
console.log(`Streamer behavioral source oracle: ${cases.length} cases across all seven public methods; ${process.argv.includes('--check') ? 'fixture matches' : 'fixture written'}; closed mocked VM, no network.`);
