// Regenerate/check without a TS loader or application imports:
// node dima-rust/tests/fixtures/policy_utils_parity.mjs [--check]
// Actual source statements are transpiled in isolated VMs. Imports are removed
// from pure modules; tts_usage selects ONLY its rate constant and calculation.
// No service imports, tracking functions, env files, clocks, or network calls.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

const root = new URL('../../../dimabot/src/utils/', import.meta.url);
const sources = {};
async function load(name, selected) {
  const input = await readFile(new URL(`${name}.ts`, root), 'utf8');
  sources[`${name}.ts`] = createHash('sha256').update(input).digest('hex');
  const ast = ts.createSourceFile(`${name}.ts`, input, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(statement => {
    if (ts.isImportDeclaration(statement)) return false;
    if (!selected) return true;
    if (ts.isFunctionDeclaration(statement)) return selected.includes(statement.name?.text);
    return ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => selected.includes(declaration.name.getText(ast)));
  });
  if (selected) assert.equal(statements.length, selected.length, `selection drift: ${name}`);
  const body = statements.map(statement => statement.getText(ast)).join('\n');
  const result = ts.transpileModule(body, { reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const context = vm.createContext({ exports: {} });
  new vm.Script(result.outputText, { filename: `${name}.isolated.js` }).runInContext(context, { timeout: 1000 });
  return context.exports;
}
const chat = await load('shared_chat_origin');
const bits = await load('bits_message');
const badges = await load('badges');
const timer = await load('timer_policy');
const reset = await load('free_credit_reset');
const packs = await load('credit_packs');
const tts = await load('tts_usage', ['TTS_CREDITS_PER_CHARACTER', 'calculateTtsUsage']);

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
async function add(operation, input, run, dateInputs) {
  const item = { operation, input: encode(input) };
  if (dateInputs) item.dateInputs = encode(dateInputs);
  try { item.expected = encode(await run()); }
  catch (error) { item.error = error.message; }
  cases.push(item);
}

for (const type of ['channel.chat.message', 'channel.chat.notification', 'channel.cheer', 'channel.follow', 'CHANNEL.CHAT.MESSAGE']) {
  for (const event of [{}, { broadcaster_user_id: '1', source_broadcaster_user_id: '1' },
    { broadcaster_user_id: '1', source_broadcaster_user_id: '2' },
    { broadcaster_user_id: 2, source_broadcaster_user_id: '2' },
    { broadcaster_user_id: '1', source_broadcaster_user_id: '' },
    { source_broadcaster_user_id: ' ' }, { source_broadcaster_user_id: null }, { source_broadcaster_user_id: 1 }]) {
    for (const receiver of [undefined, null, '2', 2]) {
      await add('shared_origin', { type, event, receiver }, () => chat.isForeignSharedChatEvent(type, event, receiver));
    }
  }
}
for (const message of [undefined, null, false, 0, 42, '', ' Cheer100 😃 ', {}, { text: '' }, { text: 'canonical' },
  { text: 123 }, { text: null }, { message: 'wrong field' }, ['text'], [{ text: 'nested' }]]) {
  await add('bits_text', { message }, () => bits.getBitsMessageText(message));
}
const badge = (set_id, info = '') => ({ set_id, id: 'ignored', info });
for (const input of [undefined, null, [], [badge('vip')], [badge('moderator'), badge('vip')],
  [badge('broadcaster'), badge('moderator'), badge('vip')],
  ['sub-gifter', 'turbo', 'staff', 'partner', 'premium', 'subscriber', 'founder', 'broadcaster'].map((id) => badge(id, '12')),
  [badge('subscriber', '7'), badge('subscriber', '99')], [badge('founder', 'invalid'), badge('subscriber', '30')],
  [badge('unknown')]]) {
  await add('badges', { badges: input }, () => badges.formatBadges({ badges: input }));
}
for (const info of ['', '0', '-0', '-12 months', '+007x', '  12M ', '\ufeff0x20tail', '0Xff', '-0xFzz',
  '0b10', '0o17', '1e3', '1.9', 'Infinity', 'NaN', '\u008512', '１２', '9007199254740993',
  '1000000000000000000000', '9999999999999999999999999999999', '9'.repeat(400),
  '0xfffffffffffffffffffffffffff', '-0x20000000000001']) {
  await add('badges', { badges: [badge('subscriber', info)] }, () => badges.formatBadges({ badges: [badge('subscriber', info)] }));
}
for (const frequency of [undefined, null, false, true, '12', {}, [], -Infinity, NaN, -0, 0, -1, .5, 1, 2, 287, 288, 289, Infinity]) {
  await add('legacy_frequency', { frequency }, () => timer.convertLegacyTimerFrequency(frequency));
}
for (const raw of [undefined, '', ' ', '7', '0007', '7m', ' 2H ', '\ufeff2h\u2028', '\u00852h', '1.5h',
  '1 h', '+2h', '-2', '0', '0h', '１h', '1\n2', '3mh', '1e3', '9007199254740993', '1' + '0'.repeat(307) + 'h', '9'.repeat(400)]) {
  await add('parse_frequency', { raw }, () => timer.parseTimerFrequencyInput(raw));
}
for (const frequency of [-0, NaN, Infinity, -Infinity, -.5, 1, 7.5, 288, 1e308]) {
  for (const frequencyUnit of [undefined, null, 'minutes', 'Minutes', 'ticks']) {
    const value = { frequency, frequencyUnit };
    await add('interval_minutes', value, () => timer.getTimerIntervalMinutes(value));
    for (const storedHeartbeat of [-0, -1, 0, 2.5, NaN, Infinity, 1e308]) {
      const heartbeatUnit = frequencyUnit === 'minutes' ? undefined : 'minutes';
      await add('heartbeat_minutes', { ...value, storedHeartbeat, heartbeatUnit },
        () => timer.getTimerHeartbeatMinutes(value, storedHeartbeat, heartbeatUnit));
    }
  }
}
// Explicit legacy heartbeat conversion, including post-multiplication infinity.
for (const storedHeartbeat of [-0, 2.5, 1e308, NaN, Infinity, -Infinity]) {
  await add('heartbeat_minutes', { frequency: 12, storedHeartbeat }, () => timer.getTimerHeartbeatMinutes({ frequency: 12 }, storedHeartbeat));
}
for (const tier of ['free', 'premium', 'pro', 'unknown', 'PRO']) {
  for (const minutes of [-Infinity, NaN, -0, -1, .5, 1, 5, 7, 10, 15, 20, 30, 40, 50, 60, 61, 175, 180, 181, Infinity]) {
    await add('validate_interval', { minutes, tier }, () => timer.validateTimerInterval(minutes, tier));
  }
  for (const value of [{ frequency: 1 }, { frequency: 2 }, { frequency: 7, frequencyUnit: 'minutes' }, { frequency: NaN }]) {
    for (const requested of [undefined, null, 0, NaN, 10]) {
      await add('validate_edit', { ...value, requested, tier }, () => timer.validateTimerEditInterval(value, requested, tier));
    }
  }
}

const start = '2026-09-07T10:30:00.123Z';
const old = '2026-08-07T10:30:00.123Z';
const previous = (periodStart = old, overrides = {}) => ({ periodStart, periodEnd: 'unused invalid', status: 'completed', credits: 0, externalId: 'previous-id', ...overrides });
async function resetCase(input) {
  await add('free_reset', input, () => reset.decideFreeCreditReset(input), {
    periodStartMs: new Date(input.period.startsAt).getTime(),
    previousPeriodStartMs: input.previous?.periodStart ? new Date(input.previous.periodStart).getTime() : null,
  });
}
const base = { userId: 'user-😃', period: { source: 'free_monthly', startsAt: start }, maximumResetCredits: 25000, usedCredits: 5000 };
for (const source of ['free_monthly', 'subscription', 'unknown']) {
  for (const startsAt of [start, 'invalid', '', '1969-12-31T23:59:59.999Z', '2024-02-29T23:30:00-02:00',
    '2026-09-07T12:30:00.123+02:00', '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z']) {
    await resetCase({ ...base, period: { source, startsAt } });
  }
}
for (const prior of [null, previous('invalid'), previous(''), previous(start), previous('2026-10-07T00:00:00Z'),
  previous('2026-09-07T12:30:00.123+02:00', { status: 'pending', credits: 7 }),
  previous('2026-09-07T10:30:00.122Z'), previous('2026-09-07T10:30:00.124Z')]) {
  await resetCase({ ...base, previous: prior });
}
for (const value of [undefined, null, -0, -1, -1.5, .9, 1.9, 50000, NaN, Infinity, -Infinity,
  '123.9', '\ufeff0x20', '+0x20', '0o17', '0b11', 'Infinity', 'inf', 'NaN', '', [], ['17.9'], [[null]], [1, 2], {}, true, false,
  '0x20000000000001', '0xfffffffffffffffffffffffffff', '0x' + 'f'.repeat(300)]) {
  await resetCase({ ...base, previous: previous(), usedCredits: value });
  await resetCase({ ...base, previous: previous(), maximumResetCredits: value });
  await resetCase({ ...base, previous: previous(start, { status: 'pending', credits: value, externalId: '' }) });
}
await resetCase({ ...base, previous: previous(), maximumResetCredits: Infinity, usedCredits: Infinity });
await resetCase({ ...base, previous: previous(start, { status: 'pending', credits: 4321, externalId: 'persisted-id' }) });
for (const millis of [0, -1, .9, -.9, 951782400000, 8640000000000000, -8640000000000000, 8640000000000001, Infinity, NaN]) {
  await add('date_iso', { millis }, () => new Date(millis).toISOString());
  await add('reset_external_id', { userId: 'user', millis }, () => reset.buildFreeCreditResetExternalId('user', new Date(millis)));
}
for (const subscription of [{}, { current_period_end: 'invalid' }, { current_period_end: '' },
  { current_period_end: '2026-09-20T11:59:59Z' },
  { current_period_end: '2026-09-29T12:00:00Z', ends_at: '2026-09-22T12:00:00Z' },
  { current_period_end: '2024-02-29T23:30:00-02:00', ends_at: 'invalid' },
  { current_period_end: '1969-12-31T23:59:59.999Z' },
  { current_period_end: '+275760-09-13T00:00:00.000Z', ends_at: null }]) {
  for (const now of ['2026-09-19T12:00:00Z', 'invalid', '1969-12-31T23:59:59.999Z', '-271821-04-20T00:00:00.000Z']) {
    await add('recharge_expiry', { subscription, now }, () => packs.getRechargeExpiry(subscription, new Date(now)), {
      currentPeriodEndMs: subscription.current_period_end ? Date.parse(subscription.current_period_end) : null,
      endsAtMs: subscription.ends_at ? Date.parse(subscription.ends_at) : null,
      nowMs: new Date(now).getTime(),
    });
  }
}
for (const productId of [...packs.CREDIT_PACK_DEFINITIONS.map(pack => pack.id), '', 'unknown']) {
  await add('pack_definition', { productId }, () => packs.getCreditPackDefinition(productId));
}
const products = packs.CREDIT_PACK_DEFINITIONS.map((definition, index) => ({
  id: definition.id, name: `${definition.size} ${definition.kind}`, visibility: 'private', is_archived: false,
  prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 500, price_currency: 'USD', is_archived: false }],
  benefits: [{ type: 'meter_credit', properties: { units: 10000 * (index + 1), rollover: definition.kind === 'credits', meter_id: 'meter-ai' } }],
}));
async function offers(input, paid = false) {
  await add('pack_offers', { products: input, meterId: 'meter-ai', paid }, () => packs.buildCreditPackOffers(input, 'meter-ai', paid));
}
await offers(products);
await offers(products, true);
await offers([]);
await offers(products.slice(1));
for (const change of [
  p => { p.is_archived = true; }, p => { p.visibility = 'draft'; }, p => { p.name = ''; }, p => { p.name = ' '; },
  p => { p.prices = []; }, p => { p.prices[0].is_archived = true; }, p => { p.prices[0].price_amount = Infinity; },
  p => { p.prices[0].price_amount = NaN; }, p => { p.prices[0].price_amount = -.5; },
  p => { p.prices[0].price_amount = -1.5; }, p => { p.prices[0].price_currency = ''; },
  p => { p.prices[0].price_amount = 0.49999999999999994; },
  p => { p.prices[0].price_amount = 4503599627370495; },
  p => { p.prices[0].price_amount = 9007199254740992; },
  p => { p.prices[0].price_currency = 'İΣ'; },
  p => { p.prices.unshift({ ...p.prices[0], type: 'recurring', price_amount: 99 }); },
  p => { p.prices.unshift({ ...p.prices[0], price_currency: '' }); },
  p => { p.prices.unshift({ ...p.prices[0], price_amount: NaN }); },
  p => { p.benefits = []; }, p => { p.benefits[0].properties.meter_id = 'other'; },
  p => { p.benefits[0].properties.rollover = false; }, p => { delete p.benefits[0].properties.rollover; },
  p => { p.benefits[0].properties.units = 0; }, p => { p.benefits[0].properties.units = -1; },
  p => { p.benefits[0].properties.units = Infinity; }, p => { p.benefits[0].properties.units = NaN; },
  p => { p.benefits[0].properties.units = .5; }, p => { p.benefits[0].properties.units = .1; },
  p => { p.benefits.unshift({ ...structuredClone(p.benefits[0]), properties: { meter_id: 'meter-ai', units: 0, rollover: true } }); },
]) {
  const changed = structuredClone(products); change(changed[0]); await offers(changed);
}
await offers([...products, { ...structuredClone(products[0]), name: 'last duplicate wins' }]);
await offers([...products, { ...structuredClone(products[0]), is_archived: true }]);
const rechargeMismatch = structuredClone(products); rechargeMismatch[3].benefits[0].properties.rollover = true; await offers(rechargeMismatch);
for (const provider of ['piper', 'kokoro', 'fish', 'unknown', 'FISH', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
  for (const characters of [-Infinity, NaN, -0, 0, -.1, -.5, -1, -1.5, -15, -50, 1, 15, 50, 51, 101, .1, 1e20, 1e308, Infinity]) {
    await add('tts_usage', { provider, characters }, () => tts.calculateTtsUsage(provider, characters));
  }
}
const output = { schemaVersion: 1, numberEncoding: 'Tagged $number values preserve NaN, infinities, and negative zero.',
  dateContract: 'Source strings are executed by actual JS; dateInputs records their parsed epoch milliseconds for the typed Rust boundary. No legacy date-string parser is ported.',
  sources: Object.fromEntries(Object.entries(sources).sort()), cases };
const serialized = JSON.stringify(output, null, 2) + '\n';
const destination = new URL('policy_utils_parity.json', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(await readFile(destination, 'utf8'), serialized, 'Fixture/source drift: regenerate policy_utils_parity.json');
  console.log(`Checked ${cases.length} actual-source cases and ${Object.keys(sources).length} SHA-256 source hashes.`);
} else {
  await writeFile(destination, serialized);
  console.log(`Generated ${cases.length} actual-source cases from ${Object.keys(sources).length} hashed TS sources.`);
}
