// Records what today's TypeScript does for keywords and cooldowns, under Node 24 (the
// production runtime), offline:
//   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD":/work \
//     -v <checkout with node_modules>/dimabot/node_modules:/nm:ro -e DIMABOT_NODE_MODULES=/nm \
//     -w /work node:24-alpine node dima-rust/crates/commands/tests/fixtures/keywords_cooldown_reference.mjs [--check]
//
// Derived from dima-rust/tests/fixtures/bot_utils_parity.mjs (the keyword and cooldown part),
// without the tsx loader: keywords.ts and command_cooldown.ts import nothing and are transpiled
// whole; from command_cooldown_write.ts only CommandCooldownError, validateKeywordCooldown and
// writeCommandWithCooldown are transpiled, and run in a VM whose MongoDB, Dragonfly, account
// and randomUUID bindings are recording fakes. No service, network, clock or env is touched.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const repo = new URL('../../../../../', import.meta.url);
const nodeModules = process.env.DIMABOT_NODE_MODULES
  ? new URL(`file://${process.env.DIMABOT_NODE_MODULES.replace(/\/?$/, '/')}`)
  : new URL('dimabot/node_modules/', repo);
const { default: ts } = await import(new URL('typescript/lib/typescript.js', nodeModules));
const outputUrl = new URL('keywords_cooldown_cases.json', import.meta.url);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sources = {};

async function load(name, selected, globals = {}) {
  const input = await readFile(new URL(`dimabot/src/utils/${name}.ts`, repo), 'utf8');
  sources[`${name}.ts`] = sha256(input);
  const ast = ts.createSourceFile(`${name}.ts`, input, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter((statement) => {
    if (ts.isImportDeclaration(statement)) return false;
    if (!selected) return true;
    const name = statement.name?.text;
    return selected.includes(name);
  });
  if (selected) assert.equal(statements.length, selected.length, `selection drift: ${name}`);
  const body = statements.map((statement) => statement.getText(ast)).join('\n');
  const result = ts.transpileModule(body, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${name} does not compile: ${errors.map((e) => e.messageText).join('; ')}`);
  const context = vm.createContext({ exports: {}, ...globals });
  new vm.Script(result.outputText, { filename: `${name}.isolated.js` }).runInContext(context, { timeout: 1000 });
  return context.exports;
}

const keywords = await load('keywords');
const cooldown = await load('command_cooldown');

// JSON cannot hold undefined, NaN or the infinities: tag them.
function encode(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: '+Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
  }
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}

const cases = [];
async function add(operation, input, run) {
  const item = { operation, input: encode(input) };
  try { item.expected = encode(await run()); }
  catch (error) { item.error = error.message; }
  cases.push(item);
}

// ---------------------------------------------------------------------------
// Plan minimums.
// ---------------------------------------------------------------------------
for (const plan of [undefined, null, 'free', 'premium', 'pro', 'PRO', 'Pro', ' pro', 'pró', 'ｐｒｏ', 'unknown', 7, true]) {
  await add('minimum_cooldown', { plan }, () => cooldown.getMinimumCommandCooldown(plan));
}

// ---------------------------------------------------------------------------
// normalizeKeyword.
// ---------------------------------------------------------------------------
const astralLetter = '𐐀'; // DESERET CAPITAL LETTER LONG I: lowercases to 𐐨, 2 UTF-16 units
const mathLetter = '𝐀'; // MATHEMATICAL BOLD CAPITAL A: a letter, no case mapping
const cjkExtB = '𠀀';
const normalizeTexts = [
  '  Hello   WORLD  ', 'café', 'CAFÉ', 'ΟΣ', 'ΟΔΟΣ ΑΣ', 'Σ', 'İ', 'İSTANBUL', 'ß', 'ẞ', 'ǅ',
  'uno dos', '﻿hello﻿', '\u0085hello\u0085', '𐐀  A', 'a b', 'a b', 'a\u000bb',
  'a　b', 'a​b', 'a᠎b', 'a b c', '\t\n\r a \f', 'K', 'Å', 'ﬁ', 'Ⅻ',
  '한국어', '각', 'مرحبا بالعالم', 'שָׁלוֹם', '‏משהו‎', 'नमस्ते', 'ภาษาไทย',
  '😀', '👨‍👩‍👧', '👍🏽', '🇪🇸', 'x️', '́', '́́́', 'á̂',
  astralLetter.repeat(3), mathLetter + mathLetter, cjkExtB, 'ＦＵＬＬ', 'Ǆ', 'ﬀ', '', ' ', '　'
];
for (const text of normalizeTexts) {
  await add('normalize_keyword', { text }, () => keywords.normalizeKeyword(text));
}

// ---------------------------------------------------------------------------
// validateKeyword: every limit boundary in ASCII, combining marks and astral characters.
// ---------------------------------------------------------------------------
const validateTexts = [
  'hello', '  CAFÉ  ', 'café', 'hello!', '!hello', 'a.*', 'a-b', 'a_b', '_', '', ' ', 'hola mundo',
  'hola  mundo', ' hola\tmundo ', 'a\u0085b', 'a​b', 'a‍b', 'a b',
  'a'.repeat(59), 'a'.repeat(60), 'a'.repeat(61), 'á'.repeat(60), 'á'.repeat(61),
  'á'.repeat(30), 'á'.repeat(31), // NFD: 2 units per letter before NFC
  astralLetter.repeat(29), astralLetter.repeat(30), astralLetter.repeat(31), astralLetter.repeat(59),
  astralLetter.repeat(60), astralLetter.repeat(61), mathLetter.repeat(31), cjkExtB.repeat(45),
  'a'.repeat(58) + astralLetter, 'a'.repeat(59) + astralLetter, 'a'.repeat(60) + astralLetter,
  '😀', 'hola😀', '😀'.repeat(31), '👍🏽', 'x️',
  '́', '́'.repeat(60), '́'.repeat(61), ' ́ ̂ ',
  'مرحبا', 'مرحبا بالعالم', 'שָׁלוֹם', '‏משהו', 'नमस्ते', 'ภาษาไทย', '한국어', '你好', '٣٤', '١٢٣ abc',
  '١'.repeat(60), '١'.repeat(61), 'Ⅻ', 'K', 'İ', 'ǅ', 'ＦＵＬＬ'
];
for (const text of validateTexts) {
  await add('validate_keyword', { text, settings: { matchMode: 'start' } }, () => keywords.validateKeyword(text, { matchMode: 'start' }));
}
for (const [text, settings] of [
  ['hi', { matchMode: 'anywhere' }], ['hi', { matchMode: 'exact' }], ['hi', { matchMode: 'bad' }],
  ['hi', { matchMode: 'Start' }], ['hi', { matchMode: null }], ['hi', {}], ['hi', null], ['hi', 'start'],
  ['hi', ['start']], ['hi', { matchMode: ['start'] }], ['hi', { matchMode: ['exact', 'start'] }],
  ['hi', { matchMode: 7 }], ['hi', { matchMode: 'start́' }], ['hi', { matchMode: 'ｓｔａｒｔ' }],
  ['bad!', { matchMode: 'bad' }], [7, { matchMode: 'start' }], [null, { matchMode: 'start' }],
  [['hi'], { matchMode: 'start' }], [{ text: 'hi' }, { matchMode: 'start' }]
]) {
  await add('validate_keyword', { text, settings }, () => keywords.validateKeyword(text, settings));
}

// ---------------------------------------------------------------------------
// Matching. Entries are normalised as the shared loader stores them; a few raw
// (unnormalised) texts check that the matcher itself does not normalise them.
// ---------------------------------------------------------------------------
const rawEntries = [
  ['hello', 'anywhere'], ['hello world', 'start'], ['café', 'exact'], ['42', 'anywhere'], ['f', 'anywhere'],
  ['f', 'start'], ['hola mundo', 'anywhere'], ['éxito', 'anywhere'], ['a a', 'anywhere'], ['hormiga', 'anywhere'],
  ['مرحبا', 'anywhere'], ['שלום', 'start'], ['你好', 'anywhere'], ['नमस्ते', 'anywhere'],
  [astralLetter, 'anywhere'], [mathLetter + 'x', 'anywhere'], ['́', 'anywhere'], ['k', 'anywhere'],
  ['istanbul', 'anywhere'], ['i̇stanbul', 'anywhere'], ['straße', 'anywhere'], ['ss', 'anywhere'],
  ['٣', 'anywhere'], ['x_y', 'anywhere'], ['ab', 'start'], ['ab', 'exact']
];
const entries = rawEntries.map(([text, matchMode], index) => ({ id: `n${index}`, text: keywords.normalizeKeyword(text), matchMode }));
const unnormalized = [
  { id: 'raw-upper', text: 'Hello', matchMode: 'anywhere' },
  { id: 'raw-nfd', text: 'café', matchMode: 'anywhere' },
  { id: 'raw-space', text: ' hi', matchMode: 'start' },
  { id: 'raw-empty', text: '', matchMode: 'anywhere' },
  { id: 'raw-empty-start', text: '', matchMode: 'start' },
  { id: 'raw-regex', text: 'a.b', matchMode: 'anywhere' },
  { id: 'raw-unknown-mode', text: 'hello', matchMode: 'regex' }
];
// Two buckets holding the same id: the later value replaces the earlier one in place.
const duplicates = [
  { id: 'dup', text: 'alpha', matchMode: 'anywhere' },
  { id: 'other', text: 'beta', matchMode: 'anywhere' },
  { id: 'dup', text: 'beta gamma', matchMode: 'anywhere' }
];
const messages = [
  'HELLO world!', 'say hello?', 'xhello hello_', 'café', 'CAFÉ', 'café!', '42 hello', 'hello 42', 'hello-world',
  'helló hello', '', ' ', 'F! f f', 'failure hormiguero', 'vi una HORMIGA hoy', '¡ÉXITO!', 'éxitosa', ' f ',
  'f otra falla', 'otra falla f', '¡hola mundo!', 'hola mundoso', 'xa a a', 'a a', 'a  a', 'a a',
  '¡مرحبا! كيف حالك', 'مرحبا،', 'مرحباً', 'שלום עולם', '‏שלום', 'ני שלום', '你好世界', '你好 世界', '说你好',
  'नमस्ते दोस्त', 'नमस्तेजी', '𐐨 ok', '𐐀𐐀', 'x𐐀', '𝐀x!', '𝐀xy', 'á', ' ́ ', '́́', 'K',
  'K!', 'İSTANBUL', 'istanbul', 'ISTANBUL', 'STRASSE', 'straße', 'Straße', '٣ items', '١٢٣', 'x_y z', 'x_yz',
  'hola😀', '😀hello😀', 'hello‍', 'hello​world', 'ab', 'abc', 'ab c', ' ab', 'Ab!', 'a.b', 'axb',
  'alpha beta gamma', 'beta gamma alpha', 'gamma', 'hi there', 'hello hello hello'
];
const allEntries = [...entries, ...unnormalized];
for (const message of messages) {
  await add('match_keywords', { entries: allEntries, message }, () =>
    keywords.matchKeywords(keywords.compileKeywordIndex(allEntries), message).map((entry) => entry.id));
  await add('match_keywords', { entries: duplicates, message }, () =>
    keywords.matchKeywords(keywords.compileKeywordIndex(duplicates), message));
  for (const entry of allEntries) {
    await add('keyword_matches', { entry, message }, () => keywords.keywordMatches(message, entry));
  }
}
await add('compile_index', { entries: [...allEntries, ...duplicates] }, () =>
  [...keywords.compileKeywordIndex([...allEntries, ...duplicates])].map(([word, bucket]) => [word, bucket.map((entry) => entry.id)]));

// ---------------------------------------------------------------------------
// command_cooldown_write.ts with recording fakes.
// ---------------------------------------------------------------------------
let scenario;
let calls;
const fakes = {
  TwitchStreamers: {
    async getTwitchAccountById(channelID) {
      calls.push(['owner_plan', channelID]);
      return scenario.plan === undefined ? null : { plan_tier: scenario.plan };
    }
  },
  getDragonflyClient: async () => ({
    async set(key, token, options) {
      calls.push(['acquire_lease', key, token, options.EX]);
      assert.equal(JSON.stringify(Object.keys(options)), JSON.stringify(['NX', 'EX']));
      return scenario.leaseTaken ? null : 'OK';
    },
    async eval(script, { keys, arguments: args }) {
      calls.push(['release_lease', keys[0], args[0]]);
      assert.equal(script, "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0");
      if (scenario.releaseFails) throw new Error('release failed');
      return 1;
    }
  }),
  CommandsSchema: {
    async exists(query) {
      calls.push(['editable_zero_exists', query.channelID, query._id ? query._id.$ne : null]);
      assert.equal(JSON.stringify(Object.keys(query).filter((key) => key !== '_id')), JSON.stringify(['channelID', 'cooldown', 'reserved']));
      assert.equal(query.cooldown, 0);
      assert.equal(JSON.stringify(query.reserved), JSON.stringify({ $ne: true }));
      if (scenario.existsFails) throw new Error('exists failed');
      return scenario.zeroExists ? { _id: 'other' } : null;
    }
  },
  getMinimumCommandCooldown: cooldown.getMinimumCommandCooldown,
  randomUUID: () => 'lease-token'
};
const write = await load('command_cooldown_write',
  ['CommandCooldownError', 'validateKeywordCooldown', 'writeCommandWithCooldown'], fakes);

async function runWrite(input) {
  scenario = input;
  calls = [];
  try {
    const result = await write.writeCommandWithCooldown('c1', input.cooldown, input.current ?? null, async () => {
      calls.push(['write']);
      if (input.writeFails) throw new Error('write failed');
      return 'written';
    });
    return { result, calls };
  } catch (error) {
    return { error: error.message, cooldownError: error instanceof write.CommandCooldownError, calls };
  }
}
async function runKeyword(input) {
  scenario = input;
  calls = [];
  try {
    await write.validateKeywordCooldown('c1', input.cooldown);
    return { ok: true, calls };
  } catch (error) {
    return { error: error.message, calls };
  }
}

const cooldownValues = [undefined, null, 0, -0, 0.5, 1, 2, 2.999, 3, 4, 5, 5.5, 10, 1e308, -1, NaN, Infinity, -Infinity, '5', '0', '', true, false, [], [5], {}];
const currents = [
  undefined,
  { _id: 'id-1', cooldown: 5, reserved: false },
  { _id: 'id-1', cooldown: 0, reserved: false },
  { _id: 'id-1', cooldown: 0, reserved: true },
  { _id: 'id-1', cooldown: 2, reserved: false },
  { cooldown: 0 },
  { _id: '', cooldown: 1, reserved: true }
];
for (const plan of [undefined, 'free', 'premium', 'pro']) {
  for (const value of cooldownValues) {
    await add('keyword_cooldown', { plan, cooldown: value }, () => runKeyword({ plan, cooldown: value }));
    for (const current of currents) {
      await add('write_cooldown', { plan, cooldown: value, current }, () => runWrite({ plan, cooldown: value, current }));
    }
  }
}
for (const flags of [{ leaseTaken: true }, { zeroExists: true }, { writeFails: true }, { releaseFails: true },
  { existsFails: true }, { zeroExists: true, releaseFails: true }, { writeFails: true, releaseFails: true }]) {
  for (const current of [undefined, { _id: 'id-1', cooldown: 5, reserved: false }, { _id: 'id-1', cooldown: 0, reserved: true }]) {
    const input = { plan: 'pro', cooldown: 0, current, ...flags };
    await add('write_cooldown', input, () => runWrite(input));
  }
  const nonzero = { plan: 'pro', cooldown: 7, ...flags };
  await add('write_cooldown', nonzero, () => runWrite(nonzero));
}

const operationCounts = {};
for (const item of cases) operationCounts[item.operation] = (operationCounts[item.operation] ?? 0) + 1;
const output = {
  description: 'Recorded from today\'s TypeScript (keywords.ts, command_cooldown.ts, command_cooldown_write.ts) under Node. Do not edit by hand.',
  node: process.version,
  sources: Object.fromEntries(Object.entries(sources).sort()),
  counts: { cases: cases.length, ...Object.fromEntries(Object.entries(operationCounts).sort()) },
  cases
};
const serialized = `${JSON.stringify(output, null, 1)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(await readFile(outputUrl, 'utf8'), serialized, 'drift: regenerate keywords_cooldown_cases.json');
  console.log(`Checked ${cases.length} cases.`);
} else {
  await writeFile(outputUrl, serialized);
  console.log(`Generated ${cases.length} cases on Node ${process.version}: ${JSON.stringify(operationCounts)}`);
}
