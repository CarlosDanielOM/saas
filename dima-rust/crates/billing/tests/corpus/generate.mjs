// Records the reference's billing decisions from today's TypeScript (dimabot/src, frozen) and the
// real @polar-sh/sdk 0.42.5, for `tests/corpus.rs`. Offline and throwaway, Node 24:
//
//   docker run --rm --network none -v "$REPO":/work:ro \
//     -v "$REPO/dima-rust/crates/billing/tests/corpus":/out \
//     -v /home/dom/Projects/saas/dimabot/node_modules:/deps/node_modules:ro \
//     -w /work node:24-alpine node dima-rust/crates/billing/tests/corpus/generate.mjs /out/billing.json
//
// Each reference file is transpiled on its own (typescript from /deps) and run in a VM whose
// imports are this script's stand-ins: no store, network, environment file or real clock. The
// clock is fixed per case; `randomUUID` returns 00000000-0000-4000-8000-000000000000. The SDK is
// the real package with a recording `fetch`. Grids derive from `policy_utils_parity.mjs` (the old
// generator) and extend it over billing.ts. Never edit billing.json by hand: regenerate it.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const DEPS = process.env.DIMA_DEPS || '/deps/node_modules';
const ts = (await import(`${DEPS}/typescript/lib/typescript.js`)).default;
const sdk = await import(`${DEPS}/@polar-sh/sdk/dist/esm/index.js`);
const { HTTPClient } = await import(`${DEPS}/@polar-sh/sdk/dist/esm/lib/http.js`);
const ROOT = new URL('../../../../../dimabot/src/', import.meta.url);
const destination = process.argv[2];
assert.ok(destination, 'usage: generate.mjs <output.json>');

const FIXED_UUID = '00000000-0000-4000-8000-000000000000';
const sources = {};
const shared = {};

// One VM context for everything, with a settable clock.
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {}, info() {} },
  URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout,
  AbortSignal, Headers, Response, Request,
  process: { env: {} },
  shared,
});
vm.runInContext(`
  const RealDate = Date;
  let NOW = 0;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
    static now() { return NOW; }
  }
  FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
  globalThis.__setNow = (ms) => { NOW = ms; };
  globalThis.__date = (ms) => new FakeDate(ms);
`, context);
const setNow = ms => vm.runInContext(`__setNow(${JSON.stringify(ms)})`, context);
const inVm = expression => vm.runInContext(expression, context);

async function load(file, imports, extraExports = []) {
  const input = await readFile(new URL(file, ROOT), 'utf8');
  sources[file] = createHash('sha256').update(input).digest('hex');
  const ast = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join('\n');
  const tail = extraExports.map(name => `exports.${name} = ${name};`).join('\n');
  const result = ts.transpileModule(`${body}\n${tail}`, { reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0, file);
  const name = `m_${file.replace(/[^a-z0-9]/gi, '_')}`;
  context.__imports = imports;
  vm.runInContext(`globalThis.${name} = { exports: {} };
    (function (exports, imports) { with (imports) { ${result.outputText} } })(globalThis.${name}.exports, __imports);`, context, { filename: file });
  return context[name].exports;
}

// ----------------------------------------------------------------------------- stand-ins
const PRODUCT_IDS = { FREE: 'fccf0669-adab-447d-89c8-d77d8b83bea5', PREMIUM: '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134', PRO: '1468eea1-7ad0-40d2-b828-4d4cd6b4abdc' };
const cryptoImports = { createHash, randomUUID: () => FIXED_UUID };
let activeCache = null;
const getDragonflyClient = async () => { if (!activeCache) throw new Error('no cache'); return activeCache; };

const fence = await load('utils/plan_cache_fence.ts', {});
const packs = await load('utils/credit_packs.ts', {});
const usageEvent = await load('utils/ai_usage_event.ts', { ...cryptoImports });
const classification = await load('utils/ai_usage_classification.ts', {});
const reset = await load('utils/free_credit_reset.ts', {});
const billing = await load('utils/billing.ts', {
  PRODUCT_IDS, getDragonflyClient, ...cryptoImports, ...fence, ...packs,
}, ['diffMonths', 'inferScenario', 'sanitizeRedirectUrl', 'isUuidV4', 'compactMetadata', 'estimateDiscountValue',
  'selectBestDiscount', 'extractPriceAmountCents', 'validCachedBillingContext', 'isDiscountApplicableToProduct',
  'getCurrentPlanFromActiveSubscription', 'getPaidSubscriptionFromSubscriptions']);
const entitlements = await load('domain_events/polar_entitlements.ts', { PRODUCT_IDS, createHash });
const GIFT_PACK_PAIRS = [
  { productId: '6e0c530d-affc-44be-a51b-e11453ef1fa7', fulfillmentProductId: 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a', credits: 40000 },
  { productId: '815d0efe-1d23-4fca-8762-ae3a9253b0bc', fulfillmentProductId: '019b6291-80a0-4b31-bb09-feaaa9afe5eb', credits: 250000 },
  { productId: '7d0d5f0e-102a-4255-abf3-6f379e2da4ce', fulfillmentProductId: '3f6010b6-4108-4bf9-ab83-b035eeed6962', credits: 550000 },
];
const sourcesModule = await load('utils/ai_credit_sources.ts', {
  AI_CREDITS_METER_ID: billing.AI_CREDITS_METER_ID, getCreditPackDefinition: packs.getCreditPackDefinition,
  GIFT_PACK_PAIRS, giftPolarRequest: async () => { throw new Error('reads are injected'); },
});

// The SDK with a recording fetch: answers come from `sdkAnswer`, requests go to `sdkSeen`.
let sdkSeen = [];
let sdkAnswer = () => ({ status: 200, body: { inserted: 1, duplicates: 0 } });
const fetcher = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  sdkSeen.push({ method: request.method, target: url.pathname + url.search, body: await request.clone().text(),
    headers: Object.fromEntries([...request.headers.entries()].filter(([k]) => k !== 'authorization')) });
  const answer = sdkAnswer(request);
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
};
class RecordingPolar extends sdk.Polar {
  constructor(options) { super({ ...options, httpClient: new HTTPClient({ fetcher }) }); }
}
let projected = [];
let receipts = [];
const polarsh = await load('utils/polarsh.ts', {
  Polar: RecordingPolar, ...cryptoImports, getDragonflyClient,
  error: async () => {}, info: () => {},
  recordAiCreditUsage: async (channel, credits, externalId) => { projected.push({ channel, credits, externalId: externalId ?? null }); },
  createAiUsageContext: usageEvent.createAiUsageContext, enrichPolarUsageMetadata: usageEvent.enrichPolarUsageMetadata,
  trackAiUsageRecorded: () => {},
  buildQueuedAiUsageReceipt: input => ({ channelID: input.channelID, customerId: input.customerId, entryId: input.context.entryId, credits: input.credits }),
  enqueueAiUsageReceipt: async (_cache, receipt) => { receipts.push(receipt); },
});
context.process.env.POLARSH_OAT = 'polar_oat_corpus';

// ----------------------------------------------------------------------------- recording
function encode(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: '+Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
  }
  if (value === undefined) return { $undefined: true };
  if (Object.prototype.toString.call(value) === '[object Map]') return { $map: [...value.entries()].map(encode) };
  if (value && typeof value === 'object' && typeof value.getTime === 'function' && typeof value.toISOString === 'function') {
    return { $date: value.getTime() };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
const cases = [];
async function add(op, input, run) {
  const item = { op, input: encode(input) };
  try { item.expected = encode(await run()); }
  catch (error) { item.error = String(error?.message ?? error); item.errorType = error?.constructor?.name ?? 'Error'; }
  cases.push(item);
  return item;
}
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const date = ms => inVm(`__date(${JSON.stringify(ms)})`);
// Plain objects cross the VM boundary as they are (property reads and Array.isArray work across
// realms); only Dates are made inside the VM, so `instanceof Date` holds there.
const toVm = value => value;

// ============================================================ free credit reset (old grid)
const start = '2026-09-07T10:30:00.123Z';
const old = '2026-08-07T10:30:00.123Z';
const previous = (periodStart = old, overrides = {}) => ({ periodStart, periodEnd: 'unused invalid', status: 'completed', credits: 0, externalId: 'previous-id', ...overrides });
async function resetCase(input) {
  const item = await add('free_reset', input, () => reset.decideFreeCreditReset(toVm(input)));
  item.dateInputs = encode({
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
  '123.9', '﻿0x20', '+0x20', '0o17', '0b11', 'Infinity', 'inf', 'NaN', '', [], ['17.9'], [[null]], [1, 2], {}, true, false,
  '0x20000000000001', '0xfffffffffffffffffffffffffff', '0x' + 'f'.repeat(300)]) {
  await resetCase({ ...base, previous: previous(), usedCredits: value });
  await resetCase({ ...base, previous: previous(), maximumResetCredits: value });
  await resetCase({ ...base, previous: previous(start, { status: 'pending', credits: value, externalId: '' }) });
}
await resetCase({ ...base, previous: previous(), maximumResetCredits: Infinity, usedCredits: Infinity });
await resetCase({ ...base, previous: previous(start, { status: 'pending', credits: 4321, externalId: 'persisted-id' }) });
for (const status of ['initialized', 'completed', 'PENDING', '']) {
  await resetCase({ ...base, previous: previous(start, { status, credits: 9 }) });
}
for (const millis of [0, -1, .9, -.9, 951782400000, 8640000000000000, -8640000000000000, 1e12 + .5]) {
  await add('reset_external_id', { userId: 'user', millis }, () => reset.buildFreeCreditResetExternalId('user', date(millis)));
}

// ============================================================ credit packs (old grid, extended)
for (const subscription of [{}, { current_period_end: 'invalid' }, { current_period_end: '' },
  { current_period_end: '2026-09-20T11:59:59Z' },
  { current_period_end: '2026-09-29T12:00:00Z', ends_at: '2026-09-22T12:00:00Z' },
  { current_period_end: '2024-02-29T23:30:00-02:00', ends_at: 'invalid' },
  { current_period_end: '1969-12-31T23:59:59.999Z' },
  { current_period_end: '2026-09-19T12:00:00.001Z' }, { ends_at: '2026-09-19T12:00:00.000Z' },
  { current_period_end: '2026-09-18T12:00:00.000Z', ends_at: '2026-10-19T12:00:00.000Z' },
  { current_period_end: '+275760-09-13T00:00:00.000Z', ends_at: null }]) {
  for (const now of ['2026-09-19T12:00:00Z', '1969-12-31T23:59:59.999Z', '-271821-04-20T00:00:00.000Z']) {
    await add('recharge_expiry', { subscription, nowMs: Date.parse(now) }, () => packs.getRechargeExpiry(toVm(subscription), date(Date.parse(now))));
  }
}
for (const productId of [...packs.CREDIT_PACK_DEFINITIONS.map(pack => pack.id), '', 'unknown', PRODUCT_IDS.PRO]) {
  await add('pack_definition', { productId }, () => packs.getCreditPackDefinition(productId));
}
const products = packs.CREDIT_PACK_DEFINITIONS.map((definition, index) => ({
  id: definition.id, name: `${definition.size} ${definition.kind}`, visibility: 'private', is_archived: false,
  prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 500, price_currency: 'USD', is_archived: false }],
  benefits: [{ type: 'meter_credit', properties: { units: 10000 * (index + 1), rollover: definition.kind === 'credits', meter_id: 'meter-ai' } }],
}));
async function offers(input, paid = false) {
  await add('pack_offers', { products: input, meterId: 'meter-ai', paid }, () => packs.buildCreditPackOffers(toVm(input), 'meter-ai', paid));
}
await offers(products);
await offers(products, true);
await offers([]);
await offers(products.slice(1));
for (const change of [
  p => { p.is_archived = true; }, p => { p.visibility = 'draft'; }, p => { p.name = ''; }, p => { p.name = ' '; },
  p => { p.prices = []; }, p => { p.prices[0].is_archived = true; }, p => { p.prices[0].price_amount = 1e309; },
  p => { p.prices[0].price_amount = -.5; },
  p => { p.prices[0].price_amount = -1.5; }, p => { p.prices[0].price_currency = ''; },
  p => { p.prices[0].price_amount = 0.49999999999999994; },
  p => { p.prices[0].price_amount = 4503599627370495; },
  p => { p.prices[0].price_amount = 9007199254740992; },
  p => { p.prices[0].price_currency = 'İΣ'; },
  p => { p.prices.unshift({ ...p.prices[0], type: 'recurring', price_amount: 99 }); },
  p => { p.prices.unshift({ ...p.prices[0], price_currency: '' }); },
  p => { p.prices.unshift({ ...p.prices[0], price_amount: '500' }); },
  p => { p.benefits = []; }, p => { p.benefits[0].properties.meter_id = 'other'; },
  p => { p.benefits[0].properties.rollover = false; }, p => { delete p.benefits[0].properties.rollover; },
  p => { p.benefits[0].properties.units = 0; }, p => { p.benefits[0].properties.units = -1; },
  p => { p.benefits[0].properties.units = '5'; },
  p => { p.benefits[0].properties.units = .5; }, p => { p.benefits[0].properties.units = .1; },
  p => { p.benefits.unshift({ ...structuredClone(p.benefits[0]), properties: { meter_id: 'meter-ai', units: 0, rollover: true } }); },
  // Shapes the reference throws a TypeError on, or reads loosely.
  p => { p.prices = null; }, p => { delete p.prices; }, p => { p.prices = {}; }, p => { p.prices.unshift(null); },
  p => { p.benefits = null; }, p => { p.benefits.unshift(null); }, p => { p.benefits[0].properties = null; },
  p => { p.benefits[0].properties = 7; }, p => { p.prices[0].price_currency = 5; }, p => { p.is_archived = 'yes'; },
  p => { p.is_archived = 0; }, p => { p.prices[0].is_archived = 'true'; }, p => { delete p.name; },
  p => { p.name = 'Starter 😃 pack'; }, p => { p.extra_field = { anything: [1, 2] }; },
]) {
  const changed = structuredClone(products); change(changed[0]); await offers(changed);
}
await offers([...products, { ...structuredClone(products[0]), name: 'last duplicate wins' }]);
await offers([...products, { ...structuredClone(products[0]), is_archived: true }]);
await offers([...products, null]);
const rechargeMismatch = structuredClone(products); rechargeMismatch[3].benefits[0].properties.rollover = true; await offers(rechargeMismatch);

// ============================================================ usage events
const reasons = ['tts_fish', 'tts_kokoro', 'tts_piper', 'messages', 'harness_tools', 'harness_end', 'planner', 'coding_agent',
  'stream_summary', 'weekly_summary', 'monthly_summary', 'vod_clip_recommendation', 'Free benefits', '', 'custom_reason',
  'TTS_FISH', 'contextual_moderation', 'constructor', 'gift 🎁'];
const contextInputs = [{}, { entryId: 'entry-1' }, { entryId: '  ', requestId: ' req ' }, { entryId: 'e', parentRequestId: 'p', model: 'openai/gpt',
  channelID: '123', quantity: 42, unit: 'tokens', resourceType: 'llm_generation', resourceId: 'r1' },
  { entryKind: 'adjustment', category: 'credit_adjustment', operation: ' grant ', source: 'src', provider: 'polar' },
  { quantity: NaN }, { quantity: Infinity }, { quantity: -0 }, { quantity: 1.5 }, { model: '　 ﻿' }, { channelID: '😃' }];
for (const reason of reasons) {
  for (const input of contextInputs) {
    await add('usage_context', { reason, input }, () => {
      const context = usageEvent.createAiUsageContext(reason, toVm(input));
      return { context, metadata: usageEvent.toPolarUsageMetadata(context),
        enriched: usageEvent.enrichPolarUsageMetadata(toVm({ cost: 1, credits: 1000, provider: 'kept-position', reason }), context) };
    });
  }
}
const kinds = [undefined, 'adjustment', 'usage', 'Adjustment'];
for (const entryKind of kinds) {
  for (const adjustmentType of [undefined, 'gifted_credits', 'unknown', 'native_grant']) {
    for (const [source, operation, reason] of [[undefined, undefined, undefined], ['polar_meter_credit', 'refund', undefined],
      ['free_credit_reset', undefined, undefined], ['free_credit_reset_worker', undefined, undefined], [undefined, 'monthly_reset', undefined],
      ['admin_credit_grant', undefined, undefined], ['credit_pack_purchase', undefined, undefined], [undefined, 'purchase_pack', undefined],
      [undefined, 'refund', undefined], [undefined, 'correction', undefined], ['activation', undefined, undefined],
      [undefined, undefined, 'Free benefits'], ['', '', ''], ['other', 'grant', 'x']]) {
      const input = { entryKind, adjustmentType, source, operation, reason };
      await add('classify_adjustment', input, () => classification.classifyAdjustment(toVm(input)));
    }
  }
}

// ============================================================ plan limits and credit snapshots
const METER = billing.AI_CREDITS_METER_ID;
for (const tier of ['free', 'premium', 'pro', 'PRO', '', null, undefined, 'gold']) {
  await add('plan_limit', { tier }, () => billing.getAiCreditLimitForPlan(tier));
}
const meterValues = [undefined, null, 0, -0, 1, -1, 24999, 25000, 25001, -25000, 199999.5, 200000, 1e15, '', '12', ' -40000 ', 'abc', NaN, true, [7], {}];
const meters = [undefined, null, {}];
for (const consumed of meterValues) meters.push({ meter_id: METER, consumed_units: consumed, balance: -25000 });
for (const balance of meterValues) meters.push({ meter_id: METER, consumed_units: 1000, balance });
for (const credited of [0, 40000, '40000', -5, 1e9]) {
  for (const balance of [undefined, 39000.4, 0, -100, 50000]) {
    for (const consumed of [undefined, -40000, 0, 1000]) meters.push({ consumed_units: consumed, credited_units: credited, balance });
  }
}
for (const limit of [undefined, 0, 500000, '900000', -1, 1e21]) meters.push({ consumed_units: 10, limit });
for (const meter of meters) {
  for (const tier of ['free', 'premium', 'pro', 'gold', undefined]) {
    await add('credits_from_meter', { meter, tier }, () => billing.buildAiCreditsDataFromMeter(toVm(meter), tier, '2026-11-11T00:00:00.000Z'));
  }
}
const snapshots = [
  billing.buildAiCreditsDataFromMeter({ consumed_units: 24999, balance: -24999 }, 'free', 'T0'),
  billing.buildAiCreditsDataFromMeter({ consumed_units: 25000, balance: -25000 }, 'free', 'T0'),
  { ...billing.buildAiCreditsDataFromMeter({ consumed_units: 10 }, 'pro', 'T0'), available: false, status: 'unavailable' },
  billing.buildAiCreditsDataFromMeter({ consumed_units: 1, credited_units: 50000, balance: 49999 }, 'premium', 'T0'),
];
for (const snapshot of snapshots) {
  for (const credits of [0, -0, -1, 0.0001, 1, 1.5, 9.2, 25000, 1e20, NaN, Infinity, -Infinity]) {
    await add('apply_usage', { snapshot, credits }, () => billing.applyAiCreditUsageToSnapshot(toVm(snapshot), credits, 'T1'));
  }
}

// ============================================================ billing decisions (internal helpers)
const msOf = text => Date.parse(text);
const monthDates = ['2026-01-31T00:00:00.000Z', '2026-02-28T23:59:59.999Z', '2026-03-01T00:00:00.000Z', '2025-05-11T12:00:00.000Z',
  '2026-05-11T12:00:00.000Z', '2026-05-12T00:00:00.000Z', '2026-11-11T11:59:59.999Z', '2026-11-11T12:00:00.000Z', '2027-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z', '2020-02-29T00:00:00.000Z'];
for (const from of monthDates) {
  for (const to of monthDates) {
    await add('diff_months', { fromMs: msOf(from), toMs: msOf(to) }, () => billing.diffMonths(date(msOf(from)), date(msOf(to))));
  }
}
for (const requestedAction of ['auto', 'new', 'upgrade', 'change', 'reactivate']) {
  for (const hasActiveSubscription of [false, true]) {
    for (const targetPlan of ['premium', 'pro']) {
      for (const currentPlan of ['free', 'premium', 'pro', 'gold']) {
        for (const winbackEligible of [false, true]) {
          for (const hasAnySubscriptionHistory of [false, true]) {
            const input = { requestedAction, hasActiveSubscription, targetPlan, currentPlan, winbackEligible, hasAnySubscriptionHistory };
            await add('infer_scenario', input, () => billing.inferScenario(toVm(input)));
          }
        }
      }
    }
  }
}
for (const raw of [undefined, '', 'https://domdimabot.com/billing?x=1#y', 'https://Evil.Example:8443/a b', 'HTTP://WWW.DomDimaBot.com:80/',
  'not a url', 'javascript:alert(1)', 'https://user:pass@domdimabot.com/', 'https://[::1]:9/x', 'https://ñandú.example/ruta', 'https://domdimabot.com.evil/']) {
  for (const fallback of [undefined, '', 'https://domdimabot.com/default', 'bad fallback']) {
    for (const allowed of [undefined, '', ' , ', 'domdimabot.com, WWW.DOMDIMABOT.COM', 'evil.example:8443', '[::1]:9']) {
      const input = { raw, fallback, allowed };
      context.process.env = { BILLING_SUCCESS_URL: fallback, BILLING_ALLOWED_REDIRECT_HOSTS: allowed };
      await add('sanitize_redirect', input, () => billing.sanitizeRedirectUrl(raw, 'BILLING_SUCCESS_URL'));
    }
  }
}
for (const value of [undefined, null, '', '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134', ' 55C8D1D0-5CB8-405C-BCF2-D8DBB9BA0134\n',
  '55c8d1d0-5cb8-305c-bcf2-d8dbb9ba0134', '55c8d1d0-5cb8-405c-ccf2-d8dbb9ba0134', '55c8d1d05cb8405cbcf2d8dbb9ba0134', 'cus_abc']) {
  await add('is_uuid_v4', { value }, () => billing.isUuidV4(value));
}
const discount = (type, amount, basis_points, extra = {}) => ({ id: `d_${type}_${amount}_${basis_points}`, code: 'CODE', type, amount, basis_points, ...extra });
const discounts = [discount('fixed', 500), discount('fixed', 0), discount('fixed', undefined), discount('percentage', undefined, 2500),
  discount('percentage', undefined, 0), discount('percentage', undefined, 3333), discount('other', 900, 900), discount(undefined, 1, 1)];
for (const d of discounts) {
  for (const base of [0, -1, 999, 1000, 1999.99]) {
    await add('discount_value', { discount: d, base }, () => billing.estimateDiscountValue(toVm(d), base));
  }
}
for (const base of [0, 1000, 4000]) {
  const candidates = [['referral', discounts[0]], ['promo', discounts[3]], ['winback', discounts[5]], ['change', discounts[0]]];
  await add('best_discount', { candidates, base }, () => billing.selectBestDiscount(toVm(candidates.map(([reason, discount]) => ({ reason, discount }))), base));
}
for (const products of [undefined, null, [], [{ id: PRODUCT_IDS.PRO }], [{ id: 'x' }, { id: PRODUCT_IDS.PRO }], [{}], [null], {}, 'string']) {
  await add('discount_applies', { products }, () => billing.isDiscountApplicableToProduct(toVm({ id: 'd', products }), PRODUCT_IDS.PRO));
}
for (const price of [null, {}, { amount: 500 }, { price_amount: 0, fixed_amount: 700 }, { amount: '900', unit_amount: 100 }, { amount: -5, price_amount: Infinity, unit_amount: 1.5 }]) {
  await add('price_amount', { price }, () => billing.extractPriceAmountCents(toVm(price)));
}
for (const value of [{ version: 1, planTier: 'free' }, { version: 1, planTier: 'pro', expiresAt: '2026-11-11T12:00:00.000Z' },
  { version: 1, planTier: 'pro', expiresAt: '2026-11-11T12:00:00.001Z' }, { version: 1, planTier: 'premium', expiresAt: '2026-12-01T00:00:00+02:00' },
  { version: '1', planTier: 'pro', expiresAt: '2027-01-01T00:00:00Z' }, { version: 1, planTier: 'gold' }, { version: 1, planTier: 'pro', expiresAt: 1798761600000 },
  { version: 1, planTier: 'pro' }, null, 'text', []]) {
  await add('valid_pack_context', { value }, () => billing.validCachedBillingContext(toVm(value), NOW));
}
for (const tier of ['free', 'premium', 'pro', 'gold']) {
  for (const product of [undefined, PRODUCT_IDS.FREE, PRODUCT_IDS.PREMIUM, PRODUCT_IDS.PRO, 'other']) {
    await add('current_plan_from_active', { tier, product }, () => billing.getCurrentPlanFromActiveSubscription(tier, product));
  }
}

// ============================================================ billing flows over a scripted Polar (fetch)
// Each answer is keyed by `METHOD target`; a list answers repeated calls in order.
let fetchSeen = [];
let fetchAnswers = {};
context.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const target = parsed.pathname + parsed.search;
  const headers = init.headers || {};
  fetchSeen.push({ method: init.method || 'GET', target, body: init.body ?? null,
    idempotencyKey: headers['Idempotency-Key'] ?? null, contentType: headers['Content-Type'] ?? null });
  const key = `${init.method || 'GET'} ${target}`;
  const queue = fetchAnswers[key];
  const answer = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
  if (!answer) return new Response('{"detail":"Not Found"}', { status: 404 });
  return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
};
function memoryCache(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return 'OK'; },
  };
}
const CUSTOMER = '9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b';
const sub = (id, product, status = 'active', extra = {}) => ({ id, status, product_id: product, ended_at: null, trial_start: null, trial_end: null,
  current_period_end: '2026-12-01T00:00:00Z', ends_at: null, ...extra });
const subsTarget = active => `/v1/subscriptions/?customer_id=${CUSTOMER}&limit=100${active === undefined ? '' : `&active=${active}`}`;
const histories = {
  none: { active: [], all: [] },
  freeActive: { active: [sub('s_free', PRODUCT_IDS.FREE)], all: [sub('s_free', PRODUCT_IDS.FREE)] },
  premiumActive: { active: [sub('s_prem', PRODUCT_IDS.PREMIUM)], all: [sub('s_prem', PRODUCT_IDS.PREMIUM, 'active', { trial_start: '2026-01-01T00:00:00Z' })] },
  proActive: { active: [sub('s_pro', PRODUCT_IDS.PRO), sub('s_prem', PRODUCT_IDS.PREMIUM)], all: [sub('s_pro', PRODUCT_IDS.PRO)] },
  pastDue: { active: [], all: [sub('s_due', PRODUCT_IDS.PREMIUM, 'past_due'), sub('s_old', PRODUCT_IDS.PRO, 'past_due', { ended_at: '2026-01-01T00:00:00Z' })] },
  pastDueFree: { active: [], all: [sub('s_due', PRODUCT_IDS.FREE, 'past_due')] },
  canceled: { active: [], all: [sub('s_c', PRODUCT_IDS.PRO, 'canceled', { ended_at: '2025-01-01T00:00:00Z', trial_end: '2024-12-01T00:00:00Z' })] },
  otherProduct: { active: [sub('s_x', 'some-other-product')], all: [sub('s_x', 'some-other-product')] },
};
const users = {
  plain: { _id: '650000000000000000000001', email: 'streamer@example.com', name: 'streamer', plan_tier: 'free', polar_sh_customer_id: CUSTOMER,
    last_app_activity_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', referralCodeUsed: null },
  stale: { _id: '650000000000000000000002', email: 'old@example.com', name: 'old', plan_tier: 'premium', polar_sh_customer_id: CUSTOMER,
    last_app_activity_at: null, updated_at: '2025-11-11T12:00:00.000Z', referralCodeUsed: 'FRIEND' },
  noCustomer: { _id: '650000000000000000000003', name: 'nocust', plan_tier: 'free', polar_sh_customer_id: null, referralCodeUsed: 'FRIEND',
    last_app_activity_at: null, updated_at: null },
  legacyCustomer: { _id: '650000000000000000000004', email: '', name: 'legacy', plan_tier: 'pro', polar_sh_customer_id: 'cus_legacy',
    last_app_activity_at: '2026-05-11T12:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', referralCodeUsed: '' },
};
const userInVm = user => {
  const copy = { ...user, _id: { toString: () => user._id } };
  for (const key of ['last_app_activity_at', 'updated_at']) if (user[key]) copy[key] = date(Date.parse(user[key]));
  return copy;
};
function scriptHistory(history, customer = CUSTOMER) {
  const target = active => `/v1/subscriptions/?customer_id=${customer}&limit=100${active === undefined ? '' : `&active=${active}`}`;
  return { [`GET ${target(true)}`]: { body: { items: history.active } }, [`GET ${target()}`]: { body: { items: history.all } } };
}
async function flow(op, input, answers, env, run) {
  setNow(NOW);
  fetchSeen = []; fetchAnswers = structuredClone(answers); context.process.env = { POLARSH_OAT: 'polar_oat_corpus', ...env };
  const item = await add(op, { ...input, answers, env }, run);
  item.requests = fetchSeen.map(request => ({ ...request, target: request.target }));
  return item;
}
for (const [userName, user] of Object.entries(users)) {
  for (const [historyName, history] of Object.entries(histories)) {
    for (const targetPlan of [undefined, 'premium', 'pro']) {
      for (const action of ['auto', 'new', 'reactivate']) {
        const customer = user.polar_sh_customer_id;
        await flow('billing_context', { user, targetPlan, action, history: historyName }, customer ? scriptHistory(history, customer) : {}, {},
          () => billing.getBillingContext(userInVm(user), targetPlan, action));
      }
    }
  }
}
await flow('billing_context', { user: users.plain, targetPlan: 'pro', action: 'auto', history: 'error' },
  { [`GET ${subsTarget(true)}`]: { status: 500, body: { detail: 'boom victim@example.com' } }, [`GET ${subsTarget()}`]: { body: { items: [] } } }, {},
  () => billing.getBillingContext(userInVm(users.plain), 'pro', 'auto'));

const discountAnswers = {
  'GET /v1/discounts/d_ref/': { body: { id: 'd_ref', code: 'REF', type: 'percentage', basis_points: 1000, products: [] } },
  'GET /v1/discounts/d_win/': { body: { id: 'd_win', code: 'WIN', type: 'fixed', amount: 300, products: [{ id: PRODUCT_IDS.PREMIUM }, { id: PRODUCT_IDS.PRO }] } },
  'GET /v1/discounts/d_up/': { body: { id: 'd_up', code: null, type: 'percentage', basis_points: 5000, products: [{ id: PRODUCT_IDS.PRO }] } },
  'GET /v1/discounts/d_change/': { status: 404, body: { detail: 'Not found' } },
  'GET /v1/discounts/?query=summer&limit=100': { body: { items: [{ id: 'd_sum', code: 'SUMMER', type: 'fixed', amount: 450, products: [] }, { id: 'd_other', code: 'SUMMERX', type: 'fixed', amount: 9999 }] } },
  'GET /v1/discounts/?query=premonly&limit=100': { body: { items: [{ id: 'd_pre', code: 'PremOnly', type: 'fixed', amount: 100, products: [{ id: PRODUCT_IDS.PREMIUM }] }] } },
  [`GET /v1/products/${PRODUCT_IDS.PREMIUM}/`]: { body: { id: PRODUCT_IDS.PREMIUM, prices: [{ amount_type: 'fixed', price_amount: 900 }, { price_amount: 9000 }] } },
  [`GET /v1/products/${PRODUCT_IDS.PRO}/`]: { status: 500, body: {} },
  'POST /v1/checkouts/': { body: { id: 'chk_1', url: 'https://polar.sh/checkout/chk_1', client_secret: 'secret' } },
  'POST /v1/customer-sessions/': { body: { id: 'cs_1', customer_portal_url: 'https://polar.sh/portal/cs_1', expires_at: '2026-11-11T13:00:00Z' } },
};
const discountEnv = { POLARSH_REFERRAL_DISCOUNT_ID: 'd_ref', POLARSH_WINBACK_DISCOUNT_ID: 'd_win', POLARSH_UPGRADE_DISCOUNT_ID: 'd_up',
  POLARSH_CHANGE_DISCOUNT_ID: 'd_change', BILLING_SUCCESS_URL: 'https://domdimabot.com/billing/success', BILLING_RETURN_URL: 'https://domdimabot.com/billing',
  BILLING_PORTAL_RETURN_URL: 'https://domdimabot.com/portal', BILLING_ALLOWED_REDIRECT_HOSTS: 'domdimabot.com' };
for (const [userName, user] of Object.entries(users)) {
  for (const historyName of ['none', 'freeActive', 'premiumActive', 'pastDue', 'canceled', 'otherProduct']) {
    for (const targetPlan of ['premium', 'pro']) {
      for (const promoCode of [undefined, 'summer', ' PremOnly ', '   ', 'nope']) {
        for (const env of [{}, discountEnv]) {
          const customer = user.polar_sh_customer_id;
          const answers = { ...(customer ? scriptHistory(histories[historyName], customer) : {}), ...discountAnswers,
            'GET /v1/discounts/?query=nope&limit=100': { body: { items: [] } } };
          await flow('billing_checkout', { user, targetPlan, promoCode, history: historyName, successUrl: 'https://evil.example/x', returnUrl: 'https://domdimabot.com/back' },
            answers, env, () => billing.createBillingCheckout(toVm({ user: userInVm(user), targetPlan, action: 'auto', promoCode,
              successUrl: 'https://evil.example/x', returnUrl: 'https://domdimabot.com/back' })));
        }
      }
    }
  }
}
for (const status of [422, 409, 500]) {
  const answers = { ...scriptHistory(histories.none), ...discountAnswers, 'POST /v1/checkouts/': [{ status, body: { detail: 'customer_id bad victim@example.com' } },
    { body: { id: 'chk_retry', url: 'https://polar.sh/checkout/chk_retry' } }] };
  await flow('billing_checkout', { user: users.plain, targetPlan: 'premium', history: 'none', status }, answers, {},
    () => billing.createBillingCheckout(toVm({ user: userInVm(users.plain), targetPlan: 'premium' })));
}
for (const [userName, user] of Object.entries(users)) {
  for (const returnUrl of [undefined, 'https://domdimabot.com/x', 'https://evil.example/']) {
    await flow('portal_session', { user, returnUrl }, discountAnswers, discountEnv,
      () => billing.createCustomerPortalSession(toVm({ user: userInVm(user), returnUrl })));
  }
}
// Credit-pack catalog and checkout, with the context cache.
const productList = packs.CREDIT_PACK_DEFINITIONS.map((definition, index) => ({ ...products[index], benefits: [{ type: 'meter_credit',
  properties: { units: 10000 * (index + 1), rollover: definition.kind === 'credits', meter_id: METER } }] }));
const contextKey = billing.creditPackBillingContextCacheKey(CUSTOMER);
for (const [userName, user] of Object.entries(users)) {
  for (const historyName of ['none', 'premiumActive', 'proActive', 'freeActive']) {
    for (const cached of [null, JSON.stringify({ version: 1, planTier: 'pro', expiresAt: '2026-11-20T00:00:00.000Z' }),
      JSON.stringify({ version: 1, planTier: 'free', expiresAt: null }), JSON.stringify({ version: 1, planTier: 'pro', expiresAt: '2026-11-11T11:00:00.000Z' }), '{bad']) {
      for (const productId of [null, packs.CREDIT_PACK_DEFINITIONS[0].id, packs.CREDIT_PACK_DEFINITIONS[4].id, 'unknown']) {
        const customer = user.polar_sh_customer_id;
        const history = histories[historyName];
        const answers = { 'GET /v1/products/?limit=100': { body: { items: productList } },
          ...(customer ? { [`GET /v1/subscriptions/?customer_id=${customer}&limit=100&active=true`]: { body: { items: history.active } } } : {}),
          'POST /v1/checkouts/': { body: { id: 'chk_pack', url: 'https://polar.sh/checkout/chk_pack' } } };
        const cache = memoryCache(cached && customer ? { [billing.creditPackBillingContextCacheKey(customer)]: cached } : {});
        activeCache = cache;
        const item = await flow(productId === null ? 'pack_catalog' : 'pack_checkout', { user, history: historyName, cached, productId }, answers, discountEnv,
          () => productId === null ? billing.getCreditPackCatalog(userInVm(user))
            : billing.createCreditPackCheckout(toVm({ user: userInVm(user), productId, successUrl: 'https://domdimabot.com/ok', returnUrl: undefined })));
        item.cacheAfter = customer ? cache.values.get(billing.creditPackBillingContextCacheKey(customer)) ?? null : null;
        activeCache = null;
      }
    }
  }
}
for (const items of [null, undefined, {}, [null]]) {
  activeCache = memoryCache();
  await flow('pack_catalog', { user: users.noCustomer, items }, { 'GET /v1/products/?limit=100': { body: items === undefined ? {} : { items } } }, {},
    () => billing.getCreditPackCatalog(userInVm(users.noCustomer)));
  activeCache = null;
}
await add('pack_context_key', { customerId: CUSTOMER }, () => contextKey);

// ============================================================ getAiCredits over a scripted cache
function fencedCache(initial) {
  const values = new Map(Object.entries(initial));
  const cache = {
    values,
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return 'OK'; },
    exists: async key => values.has(key) ? 1 : 0,
    del: async key => { values.delete(key); return 1; },
    eval: async (script, { keys, arguments: args }) => {
      assert.equal(script, fence.ACCEPT_PLAN_CREDITS_SCRIPT);
      const current = values.get(keys[3]);
      if (current && current > args[0]) return 0;
      if (args[2] === 'read') { if (values.get(keys[0]) !== args[1]) return 0; } else values.set(keys[0], args[1]);
      if (args[3] === '1') { values.set(keys[1], 'true'); values.set(keys[2], 'true'); } else { values.delete(keys[1]); values.delete(keys[2]); }
      return 1;
    },
  };
  return cache;
}
const ID = '41245072';
const creditKey = `twitch:${ID}:ai:credits`;
const fenceKey = fence.planCacheFenceKey(ID);
const AT = Date.parse('2026-10-26T12:00:00Z');
const v = (ms, key) => `${String(ms).padStart(13, '0')}:${key}`;
const meterOk = { meter_id: METER, consumed_units: 30, balance: -30 };
const cacheStates = {
  empty: {},
  fenceNew: { [fenceKey]: v(AT, 'new') },
  fenceOld: { [fenceKey]: v(AT - 1000, 'old') },
  fenceEmpty: { [fenceKey]: '' },
  cachedFree: { [creditKey]: JSON.stringify({ ...billing.buildAiCreditsDataFromMeter(meterOk, 'free', '2026-11-01T00:00:00.000Z'), __polar_plan_version: v(AT, 'new') }) },
  cachedStale: { [fenceKey]: v(AT, 'new'), [creditKey]: JSON.stringify({ ...billing.buildAiCreditsDataFromMeter(meterOk, 'premium', '2026-11-01T00:00:00.000Z'), __polar_plan_version: v(AT - 1000, 'old') }) },
  cachedNoVersion: { [creditKey]: JSON.stringify(billing.buildAiCreditsDataFromMeter(meterOk, 'pro', '2026-11-01T00:00:00.000Z')) },
  cachedUnavailable: { [creditKey]: JSON.stringify({ version: 3, used: 5, limit: 25000, available: false, status: 'unavailable', meterId: '', updatedAt: '' }) },
  cachedExhausted: { [creditKey]: JSON.stringify({ version: 3, used: 25000, limit: 25000, balance: 0, meterId: METER, updatedAt: 'x', available: true, status: 'available' }) },
  cachedBadJson: { [creditKey]: '{"version":3' },
  cachedOldSchema: { [creditKey]: JSON.stringify({ version: 2, used: 1, limit: 2 }) },
  exhaustedFlag: { [`twitch:${ID}:ai:exhaust`]: 'true' },
  legacyFlag: { [`${ID}:ai:exhaust`]: 'true' },
};
const owners = {
  freeCurrent: { plan_tier: 'free', polar_sh_customer_id: CUSTOMER, polar_plan_event_at: AT, polar_plan_event_key: 'new' },
  premiumOld: { plan_tier: 'premium', polar_sh_customer_id: CUSTOMER, polar_plan_event_at: AT - 1000, polar_plan_event_key: 'old' },
  proNoVersion: { plan_tier: 'pro', polar_sh_customer_id: CUSTOMER },
  noCustomer: { plan_tier: 'premium', polar_sh_customer_id: null, polar_plan_event_at: AT, polar_plan_event_key: 'new' },
  missing: null,
  failing: 'throw',
};
const states = {
  meter: { active_meters: [meterOk] },
  exhausted: { active_meters: [null, { meter_id: 'other' }, { meter_id: METER, consumed_units: 25000, balance: -25000 }] },
  granted: { active_meters: [{ meter_id: METER, consumed_units: -40000, credited_units: 40000, balance: 39000 }] },
  noMeter: { active_meters: [] },
  notArray: { active_meters: {} },
  failing: 'throw',
};
const callers = { premium: { plan_tier: 'premium', polar_sh_customer_id: CUSTOMER }, free: { plan_tier: 'free', polar_sh_customer_id: CUSTOMER },
  noCustomer: { plan_tier: 'pro', polar_sh_customer_id: '' } };
for (const [cacheName, initial] of Object.entries(cacheStates)) {
  for (const [ownerName, owner] of Object.entries(owners)) {
    for (const [stateName, state] of Object.entries(states)) {
      for (const [callerName, caller] of Object.entries(callers)) {
        for (const requireVerified of [false, true]) {
          if (ownerName !== 'freeCurrent' && !cacheName.startsWith('fence') && cacheName !== 'cachedStale') continue;
          setNow(NOW);
          const cache = fencedCache(initial);
          const lookups = [];
          const deps = {
            getCache: async () => cache,
            getCurrentPlan: async (id, customerId) => {
              lookups.push({ id, customerId: customerId ?? null });
              if (owner === 'throw') throw new Error('lookup failed');
              return owner && toVm({ ...owner, polar_plan_event_at: owner.polar_plan_event_at === undefined ? undefined : date(owner.polar_plan_event_at) });
            },
            getState: async () => { if (state === 'throw') throw new Error('Polar API error 503: down'); return toVm(state); },
          };
          const item = await add('get_ai_credits', { cache: initial, owner, state, caller, requireVerified, names: [cacheName, ownerName, stateName, callerName] },
            () => billing.getAiCredits(toVm(caller), ID, { requireVerified }, deps));
          item.lookups = lookups;
          item.cacheAfter = Object.fromEntries([...cache.values.entries()].sort());
        }
      }
    }
  }
}

// ============================================================ entitlements
const ent = (id, productId, status, dates = {}) => ({ id, productId, status, currentPeriodEnd: null, endsAt: null, trialEnd: null, trialStart: null, ...dates });
const NOWE = Date.parse('2026-11-11T00:00:00Z');
const entitlementCases = [
  { activeSubscriptions: [], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE + 1 })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PRO, 'active', { currentPeriodEnd: NOWE - 1 }), ent('b', PRODUCT_IDS.PREMIUM, 'trialing', { currentPeriodEnd: NOWE + 5e9, trialEnd: NOWE + 1e9 })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE + 2e9 }), ent('b', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE + 3e9, endsAt: NOWE + 1e9 })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PREMIUM, 'active'), ent('b', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE + 3e9 })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.FREE, 'active'), ent('b', PRODUCT_IDS.PRO, 'canceled', { currentPeriodEnd: NOWE + 3e9 }), ent('c', PRODUCT_IDS.PRO, 'past_due')], grantedBenefits: [] },
  { activeSubscriptions: [ent('', PRODUCT_IDS.PRO, 'active')], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PRO, 'trialing', { trialEnd: NOWE - 1, currentPeriodEnd: NOWE + 1e9 })], grantedBenefits: [] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PRO, 'active', { trialEnd: NOWE - 1, currentPeriodEnd: NOWE + 1e9 })], grantedBenefits: [] },
  { activeSubscriptions: [], grantedBenefits: [{ id: 'g1', benefitId: 'b1' }], grace: [{ ...ent('s1', PRODUCT_IDS.PRO, 'past_due', { currentPeriodEnd: NOWE - 5 }), customerId: 'cust' }] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PREMIUM, 'active', { currentPeriodEnd: NOWE + 1e9 })], grantedBenefits: [{ id: 'g1', benefitId: 'b1' }], grace: [{ ...ent('s1', PRODUCT_IDS.PREMIUM, 'past_due'), customerId: 'cust' }] },
  { activeSubscriptions: [ent('a', PRODUCT_IDS.PRO, 'active')], grantedBenefits: [{ id: 'g1', benefitId: 'b1' }], grace: 'never called' },
  { activeSubscriptions: [], grantedBenefits: [{ id: 'g1', benefitId: '' }], grace: [] },
  { activeSubscriptions: [], grantedBenefits: [{ id: 'g1', benefitId: 'b1' }], grace: [{ ...ent('s1', PRODUCT_IDS.PRO, 'past_due'), customerId: 'other' }] },
  { activeSubscriptions: [], grantedBenefits: [{ id: 'g1', benefitId: 'b1' }], grace: [{ ...ent('s1', PRODUCT_IDS.PRO, 'active', { currentPeriodEnd: NOWE + 1 }), customerId: 'cust' }] },
];
for (const testCase of entitlementCases) {
  for (const stateId of ['cust', 'other']) {
    const vmDates = sub => Object.fromEntries(Object.entries(sub).map(([k, val]) => [k, typeof val === 'number' ? date(val) : val]));
    const state = toVm({ id: stateId, activeSubscriptions: [], grantedBenefits: testCase.grantedBenefits });
    state.activeSubscriptions = testCase.activeSubscriptions.map(vmDates);
    const grace = async () => { if (!Array.isArray(testCase.grace)) throw new Error('grace lookup called'); return testCase.grace.map(vmDates); };
    await add('entitled_plan', { ...testCase, stateId, nowMs: NOWE }, () => entitlements.resolvePolarEntitledPlan(state, 'cust', date(NOWE), grace));
  }
}
const fpSubs = [
  { id: 'b', productId: 'p', status: 'active', currentPeriodEnd: '2026-12-01T00:00:00.123456Z', endsAt: null, trialStart: undefined, trialEnd: null },
  { id: 'a', productId: 'p', status: 'trialing', currentPeriodEnd: '2026-12-01T00:00:00+02:00', endsAt: '2027-01-01T00:00:00Z', trialStart: '2026-11-01T00:00:00Z', trialEnd: '2026-11-15T00:00:00Z' },
  { id: 'Z', productId: 'p', status: 'active' }, { id: 'ä', productId: 'p', status: 'active' }, { id: '_', productId: 'p', status: 'active' },
  { id: '10', productId: 'p', status: 'active' }, { id: '9', productId: 'p', status: 'active' },
];
for (let n = 0; n <= fpSubs.length; n++) {
  for (const grants of [[], [{ id: 'g2', benefitId: 'b' }, { id: 'g1', benefitId: 'B' }, { id: 'G1', benefitId: 'a' }]]) {
    const input = { activeSubscriptions: fpSubs.slice(0, n), grantedBenefits: grants };
    await add('fingerprint', input, () => entitlements.polarEntitlementFingerprint(toVm(input)));
  }
}
await add('fingerprint', { activeSubscriptions: [{ id: 'a', productId: 'p', status: 's', currentPeriodEnd: 'not a date' }], grantedBenefits: [] },
  () => entitlements.polarEntitlementFingerprint(toVm({ activeSubscriptions: [{ id: 'a', productId: 'p', status: 's', currentPeriodEnd: 'not a date' }], grantedBenefits: [] })));

// ============================================================ credit sources
const credit = (id = 'credit', rollover = true, timestamp = '2026-10-08T00:00:00.000Z', extra = {}) =>
  ({ id, name: 'meter.credited', timestamp, metadata: { meter_id: METER, units: 40000, rollover, ...extra } });
const benefit = (id = 'benefit', timestamp = '2026-10-08T00:00:00.100Z', extra = {}) =>
  ({ id, name: 'benefit.granted', timestamp, metadata: { benefit_type: 'meter_credit', benefit_id: 'b', benefit_grant_id: 'g', ...extra } });
const grant = (subscription = false, extra = {}) => ({ id: 'g', customer_id: 'customer', benefit_id: 'b',
  order_id: subscription ? null : 'order', subscription_id: subscription ? 'sub' : null,
  benefit: { id: 'b', type: 'meter_credit', properties: { meter_id: METER, units: 40000, rollover: !subscription } }, ...extra });
const order = (extra = {}) => ({ id: 'order', customer_id: 'customer', product_id: packs.CREDIT_PACK_DEFINITIONS[0].id,
  subscription_id: null, paid: true, total_amount: 100, metadata: {}, ...extra });
const giftOrder = order({ product_id: GIFT_PACK_PAIRS[1].fulfillmentProductId, total_amount: 0, metadata: { source: 'dimabot_gift_fulfillment', gift_id: 'gift_1' } });
const sourceCases = [
  { events: [credit(), benefit()], grant: grant(), order: order() },
  { events: [credit('credit', false), benefit()], grant: grant(true), order: order() },
  { events: [credit(), benefit()], grant: grant(), order: giftOrder },
  { events: [credit(), benefit()], grant: grant(), order: { ...giftOrder, total_amount: 1 } },
  { events: [credit(), benefit()], grant: grant(), order: { ...giftOrder, product_id: packs.CREDIT_PACK_DEFINITIONS[0].id } },
  { events: [credit(), benefit()], grant: grant(), order: order({ paid: false }) },
  { events: [credit(), benefit()], grant: grant(), order: order({ subscription_id: 's' }) },
  { events: [credit(), benefit()], grant: grant(), order: order({ customer_id: 'other' }) },
  { events: [credit(), benefit()], grant: grant(), order: order({ product_id: PRODUCT_IDS.PRO }) },
  { events: [credit(), benefit()], grant: grant(), order: order({ metadata: null }) },
  { events: [credit(), benefit('benefit', '2026-10-08T00:00:05.000Z')], grant: grant(), order: order() },
  { events: [credit(), benefit('benefit', '2026-10-08T00:00:05.001Z')], grant: grant(), order: order() },
  { events: [credit(), benefit('benefit', '2026-10-07T23:59:59.999Z')], grant: grant(), order: order() },
  { events: [credit(), credit('credit2'), benefit()], grant: grant(), order: order() },
  { events: [credit(), benefit(), benefit('benefit2', '2026-10-08T00:00:00.200Z')], grant: grant(), order: order() },
  { events: [credit('credit', true, '2026-10-08T00:00:00.000Z', { units: 39999 }), benefit()], grant: grant(), order: order() },
  { events: [credit('credit', false, '2026-10-08T00:00:00.000Z', { units: 1 }), benefit()], grant: grant(true), order: order() },
  { events: [credit('bad id!'), benefit()], grant: grant(), order: order() },
  { events: [credit('credit', true, 'not a date'), benefit()], grant: grant(), order: order() },
  { events: [{ ...credit(), metadata: { meterId: METER, units: 40000, rollover: true } }, { ...benefit(), name: 'benefit.cycled', metadata: { benefitType: 'meter_credit', benefitId: 'b', benefitGrantId: 'g' } }], grant: grant(), order: order() },
  { events: [credit(), benefit()], grant: null, order: order() },
  { events: [credit(), benefit()], grant: grant(false, { customer_id: 'x' }), order: order() },
  { events: [credit(), benefit()], grant: grant(false, { benefit_id: 'c' }), order: order() },
  { events: [credit(), benefit()], grant: { ...grant(), benefit: { ...grant().benefit, properties: { ...grant().benefit.properties, meter_id: 'x' } } }, order: order() },
  { events: [credit(), benefit()], grant: grant(false, { subscription_id: 'sub' }), order: order() },
  { events: [credit(), benefit()], grant: grant(false, { order_id: null }), order: order() },
  { events: [credit(), benefit()], grant: grant(false, { benefit: null }), order: order() },
  { events: [credit(), benefit()], grant: grant(false, { benefit: { id: 'b', type: 'meter_credit', properties: null } }), order: order() },
  { events: [credit(), benefit()], grant: grant(), order: order({ id: 'other-order' }) },
  { events: [], grant: grant(), order: order() },
  { events: [credit(), { ...benefit(), metadata: null }], grant: grant(), order: order() },
  { events: [credit(), { ...benefit(), metadata: ['x'] }], grant: grant(), order: order() },
  { events: [{ ...credit(), metadata: { meter_id: METER, units: '40000', rollover: true } }, benefit()], grant: grant(), order: order() },
];
for (const testCase of sourceCases) {
  const reads = { grant: async () => toVm(testCase.grant), order: async () => toVm(testCase.order) };
  await add('credit_sources', testCase, async () => sourcesModule.classifyPolarCreditSources('customer', toVm(testCase.events), reads));
}

// ============================================================ Polar ingest (SDK wire)
context.process.env = { POLARSH_OAT: 'polar_oat_corpus' };
function ingestCache() {
  const lists = new Map(); const strings = new Map();
  return {
    lists,
    set: async () => 'OK', get: async key => strings.get(key) ?? null, del: async key => { lists.delete(key); strings.delete(key); return 1; },
    type: async key => lists.has(key) ? 'list' : strings.has(key) ? 'string' : 'none',
    rPush: async (key, values) => { const list = lists.get(key) ?? []; list.push(...[].concat(values)); lists.set(key, list); return list.length; },
    lRange: async key => [...(lists.get(key) ?? [])],
    lTrim: async (key, start) => { lists.set(key, (lists.get(key) ?? []).slice(start)); return 'OK'; },
  };
}
const llm = (model, prompt, completion, total) => ({ model, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } });
const ingestInputs = [];
for (const cost of [0, -25, 0.0015, 0.000123456789123, 1.23456789012345, 123456789.0123456789, 1e-12, 0.1 + 0.2, 25, NaN]) {
  ingestInputs.push({ cost, reason: 'messages' });
  ingestInputs.push({ cost, reason: 'messages', llm: llm('openai/gpt-4o:free', 10, 5, 15) });
  ingestInputs.push({ cost, reason: 'tts_fish', _cost: cost * 100, characters: 120 });
}
for (const model of ['', 'noslash', '/leading', 'vendor/', 'a/b/c:d:e', 'vendor/model:variant']) {
  ingestInputs.push({ cost: 0.01, reason: 'harness_tools', llm: llm(model, 1, 2, 3) });
}
ingestInputs.push({ cost: 0.01, reason: 'messages', llm: llm('a/b', 1.5, 2, 3) });
ingestInputs.push({ cost: 0.01, reason: 'messages', llm: { model: 'a/b' } });
ingestInputs.push({ cost: 0.01, reason: 'tts_kokoro', _cost: 0.5 });
ingestInputs.push({ cost: 0.01, reason: 'messages', externalId: 'ext-1', usage: { requestId: 'r', channelID: '999', quantity: 7, unit: 'minutes', resourceType: 'vod_analysis', resourceId: 'v' } });
ingestInputs.push({ cost: 0.01, reason: 'messages', usage: { entryId: 'from-usage', model: 'usage/model', category: 'other', operation: 'op', source: 'src', provider: 'prov' }, llm: llm('x/y', 1, 1, 2) });
for (const input of ingestInputs) {
  for (const mode of ['immediate', 'batch']) {
    setNow(NOW);
    sdkSeen = []; projected = []; receipts = [];
    const ingest = ingestCache();
    activeCache = ingest;
    sdkAnswer = () => ({ status: 200, body: { inserted: 1, duplicates: 0 } });
    const options = { customerId: 'cus_1', channelID: '123', mode, ...input };
    const item = await add('ingest_usage', options, () => polarsh.ingestPolarSHEvent(toVm(options)));
    item.wire = sdkSeen.map(r => ({ method: r.method, target: r.target, body: r.body, headers: r.headers }));
    item.projected = projected; item.receipts = receipts;
    activeCache = null;
  }
}
for (const grantInput of [{ credits: 100, reason: 'support' }, { credits: 12.7, reason: 'gift', externalId: 'x1', source: '  ', adminLogin: 'admin' },
  { credits: 0.9, reason: 'r' }, { credits: '50', reason: 'r', source: 'é'.repeat(100), channelID: '123' }, { credits: NaN, reason: 'r' },
  { credits: 10, reason: 'r', source: 'free_credit_reset_worker', externalId: 'free-credit-reset-u-2026-11-01' }]) {
  setNow(NOW);
  sdkSeen = []; receipts = [];
  activeCache = ingestCache();
  const options = { customerId: 'cus_1', ...grantInput };
  const item = await add('grant_credits', options, () => polarsh.grantPolarAiCredits(toVm(options)));
  item.wire = sdkSeen.map(r => ({ method: r.method, target: r.target, body: r.body }));
  item.receipts = receipts;
  activeCache = null;
}
for (const answer of [{ status: 200, body: { inserted: 0, duplicates: 1 } }, { status: 200, body: { inserted: 0, duplicates: 0 } },
  { status: 422, body: { detail: [] } }, { status: 500, body: {} }]) {
  setNow(NOW);
  sdkSeen = []; projected = []; receipts = [];
  activeCache = ingestCache();
  sdkAnswer = () => answer;
  const options = { customerId: 'cus_1', channelID: '123', mode: 'immediate', cost: 0.01, reason: 'messages', externalId: 'ext-answer' };
  const item = await add('ingest_answer', { ...options, answer }, () => polarsh.ingestPolarSHEvent(toVm(options)));
  item.projected = projected;
  activeCache = null;
}
sdkAnswer = () => ({ status: 200, body: { inserted: 1, duplicates: 0 } });

const output = {
  schemaVersion: 1,
  numberEncoding: 'Tagged $number values preserve NaN, infinities and negative zero; $undefined marks undefined; $date is epoch ms; $map is a Map.',
  sources: Object.fromEntries(Object.entries(sources).sort()),
  sdk: '@polar-sh/sdk 0.42.5',
  now: NOW,
  cases,
};
await writeFile(destination, JSON.stringify(output, null, 1) + '\n');
const counts = {};
for (const item of cases) counts[item.op] = (counts[item.op] ?? 0) + 1;
console.log(`Generated ${cases.length} cases from ${Object.keys(sources).length} hashed TypeScript sources:`, JSON.stringify(counts));
