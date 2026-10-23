// Safe source execution: only selected AST declarations, injected fixture values,
// fake stores/fetch/clock. No application imports, environment reads or network.
// Run: node dima-rust/tests/fixtures/token_storage_parity.mjs [--check]
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

// The selected source calls both Date.now() and new Date().toISOString().
// Keep the complete constructor contract while freezing both clock paths.
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [1_000_000])); }
  static now() { return 1_000_000; }
}
assert.equal(new FixtureDate().getTime(), FixtureDate.now());

const sources = {};
async function ast(path) {
  const source = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
  sources[path] = createHash('sha256').update(source).digest('hex');
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}
function compile(source, sandbox) {
  const js = ts.transpileModule(source.replace(/\bexport\s+/g, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return vm.runInNewContext(js, sandbox);
}
const cryptoAst = await ast('dimabot/src/utils/crypto.ts');
const cryptoSource = cryptoAst.statements.filter(s => !ts.isImportDeclaration(s))
  .map(s => s.getText(cryptoAst)).join('\n');
const fixedIv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
function cryptoFor(key, iv = fixedIv) {
  return compile(`${cryptoSource}\n({encrypt,decrypt});`, {
    crypto: { createCipheriv, createDecipheriv, randomBytes: n => {
      assert.equal(n, 16); return iv;
    } }, Buffer, process: { env: { SECRET_KEY: key } },
  });
}
const cases = [];
function add(operation, input, run) {
  try { cases.push({ operation, input, expected: run() }); }
  catch { cases.push({ operation, input, error: true }); }
}
for (const key of ['fixture', '01234567890123456789012345678901', ' '.repeat(32), '', 'x'.repeat(33), 'é', '😀', 'é'.repeat(16), 'é'.repeat(32)]) {
  add('key', { key }, () => cryptoFor(key).encrypt('probe') && true);
}
for (const text of ['', 'access&+ /', 'résumé 🎮\u0000 token', 'x'.repeat(80)]) {
  add('encrypt', { text, iv: fixedIv.toString('hex') }, () => cryptoFor('fixture').encrypt(text));
}
const carryIv = Buffer.from('0000000000000000fffffffffffffffe', 'hex');
add('encrypt', { text: 'counter-carry-'.repeat(8), iv: carryIv.toString('hex') },
  () => cryptoFor('fixture', carryIv).encrypt('counter-carry-'.repeat(8)));
const normal = cryptoFor('fixture').encrypt('résumé 🎮\u0000 token');
const corruptUtf8 = createCipheriv('aes-256-ctr', Buffer.from('fixture'.padEnd(32)), fixedIv)
  .update(Buffer.from([0x61, 0xff, 0xe2, 0x82, 0x62, 0xc0, 0xaf]));
for (const envelope of [null, {}, { iv: null, content: null }, { iv: '', content: '' },
  normal, { iv: normal.iv.toUpperCase(), content: normal.content.toUpperCase() },
  { iv: normal.iv + 'g0', content: normal.content + 'f' },
  { iv: normal.iv, content: 'z' }, { iv: '0', content: '00' },
  { iv: normal.iv, content: corruptUtf8.toString('hex') }]) {
  add('decrypt', { envelope }, () => cryptoFor('fixture').decrypt(envelope));
}
const streamersAst = await ast('dimabot/src/classes/twitch_streamers.class.ts');
const declaration = streamersAst.statements.find(ts.isClassDeclaration);
const usable = declaration.members.find(s => s.name?.getText(streamersAst) === 'isAccessTokenUsable');
assert.ok(usable);
const usableFn = compile(`const TOKEN_EXPIRY_SKEW_SECONDS=300;\nfunction ${usable.getText(streamersAst).replace(/^private\s+/, '')}\nisAccessTokenUsable;`, {
  Date: FixtureDate,
});
for (const expiry of [null, '', '1301', '1300', '1061', '1060', '2000garbage', '+2000.9', '-0x10', '\ufeff2000', '\u00852000', 'Infinity', '1e9']) {
  for (const skew of [300, 60]) {
    add('usable', { token: 'access', expiry, skew, now: 1000 }, () => usableFn('access', expiry, skew));
  }
}
add('usable', { token: '', expiry: '9999', skew: 300, now: 1000 }, () => usableFn('', '9999'));

const tokensAst = await ast('dimabot/src/utils/tokens.ts');
const functionNames = ['getRefreshFailureMessage', 'isPermanentRefreshFailure', 'invalidateStoredTwitchTokens'];
const variableNames = ['REFRESH_MAX_ATTEMPTS', 'REFRESH_RETRY_BACKOFF_MS', 'refreshTwitchToken'];
const refreshSource = tokensAst.statements.filter(s =>
  ts.isFunctionDeclaration(s) && functionNames.includes(s.name?.text)
  || ts.isVariableStatement(s) && s.declarationList.declarations.some(d => variableNames.includes(d.name.getText(tokensAst)))
).map(s => s.getText(tokensAst)).join('\n');
const refreshCases = [];
for (const scenario of ['success', 'default_expiry', 'permanent', 'rotated_usable', 'rotated_expired', 'transient', 'incomplete', 'store_failure', 'missing_user']) {
  const events = [];
  const fields = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '1000' };
  const payload = ['permanent', 'rotated_usable', 'rotated_expired'].includes(scenario)
    ? { message: 'Invalid refresh token' }
    : scenario === 'transient' ? { message: 'busy' }
    : scenario === 'incomplete' ? { access_token: 'new-access' }
    : { access_token: 'new-access', refresh_token: 'new-refresh', ...(scenario === 'default_expiry' ? { expires_in: '3600' } : { expires_in: 3600 }) };
  const status = ['permanent', 'rotated_usable', 'rotated_expired'].includes(scenario) ? 400 : scenario === 'transient' ? 503 : 200;
  if (scenario.startsWith('rotated')) Object.assign(fields, { access_token: 'winner-access', refresh_token: 'winner-refresh', expires_at: scenario === 'rotated_usable' ? '4600' : '1050' });
  const refresh = compile(`${refreshSource}\nrefreshTwitchToken;`, {
    process: { env: { CLIENT_ID: 'fixture-id', CLIENT_SECRET: 'fixture-secret' } },
    URLSearchParams, Date: FixtureDate,
    sleep: async () => {},
    fetch: async () => ({ status, ok: status < 400, text: async () => JSON.stringify(payload) }),
    getTwitchOAuthUrl: () => 'http://fixture.invalid/oauth2/token',
    getDragonflyClient: async () => ({ hSet: async (_, patch) => { events.push('cache'); Object.assign(fields, patch); }, hGet: async (_, key) => fields[key] ?? null }),
    UsersSchema: { findOne: async () => scenario === 'missing_user' ? null : {}, findOneAndUpdate: async () => { events.push('store'); if (scenario === 'store_failure') throw new Error('fixture store failure'); } },
    TwitchStreamers: { getAccountRefreshTokenById: async () => fields.refresh_token },
    encrypt: cryptoFor('fixture').encrypt,
    cacheOAuthTokenRefreshFailure: async () => {},
    logError: async () => {}, logInfo: async () => {}, logWarn: async () => {},
  });
  const result = await refresh('old-refresh', 'fixture-user');
  const expectedKind = ['success', 'default_expiry', 'rotated_usable'].includes(scenario)
    ? 'success' : scenario === 'permanent' ? 'permanent_failure' : 'transient_failure';
  assert.equal(result.kind, expectedKind, `source scenario failed before its intended branch: ${scenario}`);
  assert.ok(!/not a constructor|not defined/.test(result.message ?? ''), 'oracle sandbox is incomplete');
  if (scenario === 'permanent') {
    assert.deepEqual(events, ['store', 'cache']);
    assert.equal(fields.has_permissions, 'false');
  }

  refreshCases.push({ scenario, result: JSON.parse(JSON.stringify(result)), events, fields });
}
const generated = JSON.stringify({ sources, cases, refreshCases }, null, 2) + '\n';
const output = new URL('token_storage_parity.json', import.meta.url);
if (process.argv.includes('--check')) assert.equal(await readFile(output, 'utf8'), generated, 'source parity fixture is stale');
else await writeFile(output, generated);
console.log(`Token storage: ${cases.length} source parity cases and ${refreshCases.length} lifecycle traces verified.`);
