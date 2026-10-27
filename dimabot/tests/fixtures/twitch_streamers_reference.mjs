// Execute the current TypeScript class with all stores, decryption, logging and
// analytics stubbed. Also inventory actual production source consumers/writers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
process.env.TZ = 'UTC';
const root = new URL('../../../', import.meta.url);
const require = createRequire(new URL('dimabot/package.json', root));
const ts = require('typescript');
const sourcePath = 'src/classes/twitch_streamers.class.ts';
const sourceText = readFileSync(new URL(`dimabot/${sourcePath}`, root), 'utf8');
const fenceText = readFileSync(new URL('dimabot/src/utils/plan_cache_fence.ts', root), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const fenceModule = { exports: {} };
vm.runInNewContext(compile(fenceText), { module: fenceModule, exports: fenceModule.exports });
const fence = fenceModule.exports;
const encrypted = content => ({ iv: 'fixture-only', content });
async function map(user) {
  const hashes = new Map();
  const cache = {
    del: async () => 1, sAdd: async () => 1,
    hGet: async (key, field) => hashes.get(key)?.[field] ?? null,
    eval: async (script, { keys, arguments: args }) => {
      assert.equal(script, fence.WRITE_PLAN_ACCOUNT_SCRIPT);
      const fields = {};
      for (let i = 1; i < args.length; i += 2) fields[args[i]] = args[i + 1];
      hashes.set(keys[1], fields); return 1;
    },
  };
  const modules = {
    'dotenv/config': {}, 'node:crypto': require('node:crypto'),
    '../utils/crypto.js': { decrypt: value => value?.content || null },
    '../utils/databases/dragonfly.database.js': { getDragonflyClient: async () => cache },
    '../schemas/users.schema.js': { find: () => ({ select: () => ({ lean: async () => [user] }) }) },
    '../utils/logger.js': Object.fromEntries(['error', 'warn', 'info', 'debug'].map(key => [key, async () => {}])),
    '../utils/posthog_events.js': { identifyStreamer: () => {} },
    '../utils/plan_cache_fence.js': fence,
  };
  const module = { exports: {} };
  vm.runInNewContext(compile(sourceText), { module, exports: module.exports, require: name => {
    assert.ok(name in modules, `unexpected dependency ${name}`); return modules[name];
  }, setTimeout, clearTimeout });
  const result = await new module.exports.TwitchStreamers().getTwitchAccountsFromDB();
  assert.equal(result?.length, 1);
  const raw = [...hashes.values()][0];
  const { [fence.PLAN_CACHE_VERSION_FIELD]: version, ...expected } = raw;
  return { expected, version };
}
const cases = [];
const base = { accounts: [{ type: 'twitch', id: 'fixture-user', name: 'owner', email: 'owner@example.invalid', access_token: encrypted('fixture-access'), refresh_token: encrypted('fixture-refresh'), access_token_expires_at: 1793104200, actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true }], plan_tier: 'free' };
const add = async (name, changes = {}, accountChanges = {}) => {
  const user = structuredClone(base); Object.assign(user, changes); Object.assign(user.accounts[0], accountChanges);
  const { expected, version } = await map(user);
  cases.push({ name, input: user, expected, version });
};
for (const tier of ['free', 'premium', 'pro']) await add(`plan-${tier}`, { plan_tier: tier });
await add('null-defaults', { plan_tier: null, plan_tier_until: null, polar_sh_customer_id: null }, { name: null, email: null, actived: null, chat_enabled: null, has_permissions: null, up_to_date_permissions: null, access_token: null, refresh_token: null, access_token_expires_at: null });
await add('false-flags', {}, { actived: false, chat_enabled: false, has_permissions: false, up_to_date_permissions: false });
await add('missing-flags', {}, { actived: undefined, chat_enabled: undefined, has_permissions: undefined, up_to_date_permissions: undefined });
await add('expired-credential', {}, { access_token_expires_at: 1 });
await add('zero-expiry', {}, { access_token_expires_at: 0 });
await add('fractional-expiry', {}, { access_token_expires_at: 123.5 });
for (const date of ['1969-12-31T23:59:59Z', '1970-01-01T00:00:00Z', '2024-02-29T12:34:56Z', '2026-10-27T23:59:59Z', '0099-01-01T00:00:00Z']) {
  await add(`until-${date}`, { plan_tier_until: new Date(date) });
}
await add('plan-event-version', { polar_plan_event_at: new Date('2026-10-27T12:00:00Z'), polar_plan_event_key: 'event-key', polar_sh_customer_id: 'fixture-customer' });
await add('unicode-metadata', {}, { name: 'é😀owner', email: '' });

const calls = [], writers = [], files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.simulate.ts') && !entry.name.endsWith('.run.ts')) files.push(path);
  }
}
walk(new URL('dimabot/src/', root));
for (const path of files) {
  const text = readFileSync(path, 'utf8');
  const relative = fileURLToPath(path).slice(fileURLToPath(new URL('dimabot/', root)).length);
  if (!text.includes('twitch_streamers') && !/accounts:twitch:|streamers:by:id|twitch:accounts/.test(text)) continue;
  const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const aliases = new Set();
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.includes('twitch_streamers')) {
      if (statement.importClause?.name) aliases.add(statement.importClause.name.text);
    }
  }
  // Existing workers resolve the same singleton through deferred imports and
  // Promise.all destructuring under this shared local name.
  if (text.includes('twitch_streamers.class')) aliases.add('TwitchStreamers');
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && aliases.has(node.expression.expression.text)) {
      calls.push({ file: relative, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, method: node.expression.name.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (/accounts:twitch:|streamers:by:id|twitch:accounts/.test(text)) {
    writers.push({ file: relative, sha256: createHash('sha256').update(text).digest('hex'), note: 'cache-key owner/reference; inspect actual operations before adoption' });
  }
}
calls.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line);
writers.sort((a, b) => a.file.localeCompare(b.file, 'en'));
const artifact = {
  version: 1, timezone: 'UTC',
  sources: { [sourcePath]: createHash('sha256').update(sourceText).digest('hex'), 'src/utils/plan_cache_fence.ts': createHash('sha256').update(fenceText).digest('hex') },
  cases,
  consumerInventory: calls,
  cacheKeyOwners: writers,
  inventoryLimit: 'Default-import aliases and the established deferred-import TwitchStreamers binding. Reflective calls are outside this static inventory; key references are not proof of writes.',
  intentionalDifferences: ['Metadata publication preserves credential fields and current permission flags.', 'Credential expiry stays paired with its token instead of borrowing a cached expiry for an older DB token.', 'Full refresh reconciles removed accounts; per-account refresh is available.', 'ID-only consumers use the membership index rather than a serialized account aggregate.', 'Errors are explicit rather than false empty/missing success.'],
};
const target = new URL('twitch_streamers_parity.json', import.meta.url);
const rendered = JSON.stringify(artifact, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), rendered, 'regenerate streamer source fixture');
else writeFileSync(target, rendered);
console.log(`Streamer source oracle: ${cases.length} mapping cases, ${calls.length} static calls, ${writers.length} key-owner references; ${process.argv.includes('--check') ? 'fixture matches' : 'fixture written'}; no network.`);
