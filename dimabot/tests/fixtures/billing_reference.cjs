'use strict';
// Actual billing policy declarations, evaluated from the TypeScript sources.
// No production imports, no reconstructed algorithms, no Redis/Mongo emulation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const files = {
  billing: 'src/utils/billing.ts',
  packs: 'src/utils/credit_packs.ts',
  gift: 'src/utils/credit_gift_provider.ts',
  sources: 'src/utils/ai_credit_sources.ts'
};
const sourcePath = key => path.join(root, files[key]);
const source = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')]));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  billing: 'a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d',
  gift: '611f71d10265cc250f6cf50c80c8fe280de88d3c7e27ef8580af050f049121bc',
  packs: '0c2214abf807730f16a89fa9aadd94b68bd851613f923c7041a6ca783d829471',
  sources: '2f6a3f438799306f72e61aab56612a7dbfb177fe5065e83d478e90da06fa9350',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
const hashes = {
  billing: sha(Buffer.from(source.billing)),
  gift: sha(Buffer.from(source.gift)),
  packs: sha(Buffer.from(source.packs)),
  sources: sha(Buffer.from(source.sources)),
  package: sha(fs.readFileSync(path.join(root, 'package.json'))),
  lock: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  typescript: sha(fs.readFileSync(require.resolve('typescript'))),
  typescriptPackage: sha(fs.readFileSync(require.resolve('typescript/package.json'))),
  oracle: sha(fs.readFileSync(__filename)),
  node: sha(fs.readFileSync(process.execPath))
};
for (const [key, hash] of Object.entries(pins)) assert.equal(hashes[key], hash, key);
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');

// Declarations this oracle pins. `exported` means the source exports the name.
const names = {
  billing: ['PlanTier', 'BillingAction', 'BillingScenario', 'DiscountLike', 'CheckoutDecision',
    'PolarSubscription', 'PLAN_PRODUCT_MAP', 'PLAN_RANK', 'WINBACK_MONTHS',
    'CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION', 'CreditPackBillingContextCacheValue',
    'creditPackBillingContextCacheKey', 'validCachedBillingContext', 'isUuidV4', 'getDefaultUrl',
    'isAllowedHost', 'sanitizeRedirectUrl', 'extractPriceAmountCents', 'compactMetadata',
    'estimateDiscountValue', 'isDiscountApplicableToProduct', 'selectBestDiscount', 'inferScenario',
    'getCurrentPlanFromActiveSubscription', 'getPaidSubscriptionFromSubscriptions',
    'getPaidPlanFromSubscriptions', 'diffMonths'],
  packs: ['CreditPackKind', 'CreditPackSize', 'CreditPackDefinition', 'CREDIT_PACK_DEFINITIONS',
    'getCreditPackDefinition'],
  gift: ['GIFT_PACK_PAIRS', 'GiftOffer', 'GiftProduct', 'validateGiftPair'],
  sources: ['CreditSourceEvent', 'CreditGrant', 'CreditOrder', 'CreditSourceReads',
    'CREDIT_SOURCE_MATCH_MS', 'classifyPolarCreditSources', 'polarCreditSourceReads']
};
const exported = new Set(['creditPackBillingContextCacheKey',
  'CreditPackKind', 'CreditPackSize', 'CreditPackDefinition', 'CREDIT_PACK_DEFINITIONS',
  'getCreditPackDefinition', 'GIFT_PACK_PAIRS', 'GiftOffer', 'GiftProduct', 'validateGiftPair',
  'CreditSourceEvent', 'CreditSourceReads', 'CREDIT_SOURCE_MATCH_MS',
  'classifyPolarCreditSources']);

const declarations = [];
const extractions = [];
for (const key of Object.keys(files)) {
  const text = source[key];
  const ast = ts.createSourceFile(sourcePath(key), text, ts.ScriptTarget.ES2022, true);
  assert.equal(ast.parseDiagnostics.length, 0, key);
  const found = new Map();
  for (const statement of ast.statements) {
    const declared = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(d => d.name.getText(ast))
      : statement.name ? [statement.name.text] : [];
    for (const name of declared.filter(n => names[key].includes(n))) {
      assert(!found.has(name), `duplicate ${key}:${name}`);
      found.set(name, statement);
    }
  }
  assert.equal(found.size, names[key].length, `missing ${key} declarations`);
  for (const name of names[key]) {
    const statement = found.get(name);
    const isExported = !!statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    assert.equal(isExported, exported.has(name), `${key}:${name} export state`);
    const body = statement.getText(ast);
    declarations.push({
      file: files[key], name, exported: isExported,
      kind: ts.isVariableStatement(statement) ? 'VariableStatement' : ts.SyntaxKind[statement.kind],
      sha256: sha(body), text: body
    });
  }
  extractions.push(names[key].map(name => found.get(name).getText(ast)).join('\n'));
}
const extraction = extractions.join('\n');

// Stubs are signatures only. All runtime bodies come from the TypeScript sources.
const stubs = `
declare const PRODUCT_IDS: { readonly FREE: string; readonly PREMIUM: string; readonly PRO: string };
declare const AI_CREDITS_METER_ID: string;
declare function createHash(name: string): { update(value: string): { digest(encoding: string): string } };
declare const process: { env: Record<string, string | undefined> };
declare function giftPolarRequest<T>(path: string, init?: { method?: string }): Promise<T>;
`;
const virtualFile = path.join(root, '__billing_oracle__.ts');
const virtualSource = stubs + extraction;
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, skipLibCheck: true, types: [] };
const host = ts.createCompilerHost(compilerOptions);
const hostRead = host.readFile.bind(host), hostExists = host.fileExists.bind(host);
host.readFile = f => f === virtualFile ? virtualSource : hostRead(f);
host.fileExists = f => f === virtualFile || hostExists(f);
const program = ts.createProgram([virtualFile], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
// Only runtime declarations can be exported; types are erased. The tail makes
// every extracted value declaration observable through the CommonJS module.
const runtimeNames = declarations
  .filter(entry => entry.kind === 'VariableStatement' || entry.kind === 'FunctionDeclaration')
  .map(entry => entry.name);
const exportTail = `\nexport {${runtimeNames.join(', ')}};\n`;
const transpiled = ts.transpileModule(extraction + exportTail, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(transpiled.diagnostics.length, 0);

const PRODUCT_IDS = {
  FREE: 'fccf0669-adab-447d-89c8-d77d8b83bea5',
  PREMIUM: '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134',
  PRO: '1468eea1-7ad0-40d2-b828-4d4cd6b4abdc'
};
const AI_CREDITS_METER_ID = '5103e79b-fd74-4ba8-a287-f95574f9addf';
let activeTransport = async () => { throw new Error('no fixture transport'); };
const context = vm.createContext({
  exports: {}, module: { exports: {} }, Error, URL, Date, Math, JSON, Number, String, Object, Array,
  RegExp,
  PRODUCT_IDS, AI_CREDITS_METER_ID,
  createHash: crypto.createHash,
  process: { env: {} },
  giftPolarRequest: (p, init) => activeTransport(p, init)
});
context.exports = context.module.exports;
vm.runInContext(transpiled.outputText, context, { filename: 'actual-billing-policy.js' });
const api = context.module.exports;

// Every number keeps its raw binary64 tag so -0/NaN/Infinity survive the gold file.
const bits = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };
function encode(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === 'number') return { $f64: bits(v) };
  if (Array.isArray(v)) return { $array: v.map(encode) };
  if (v && typeof v === 'object') return { $object: Object.keys(v).map(k => [k, encode(v[k])]) };
  return v;
}

const cases = [];
function add(kind, input, expected) {
  cases.push({ id: `${kind}-${cases.length}`, kind, input: plain(input), expected: encode(expected) });
}
// Inputs are plain JSON; only expected values need binary64 fidelity.
function plain(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) if (nested !== undefined) out[key] = plain(nested);
    return out;
  }
  return value;
}
const env = vars => { context.process.env = { ...vars }; };
const discountShape = (id, type, options = {}) => ({
  id, code: options.code ?? null, type,
  basis_points: options.basisPoints, amount: options.amount,
  products: options.products
});

// 1. Discount estimation, applicability, and selection.
for (const [type, basisPoints, amount] of [['fixed', undefined, 500], ['percentage', 1000, undefined],
  ['percentage', 0, undefined], ['mystery', 2500, 700], [null, undefined, undefined],
  ['fixed', 1200, 0]]) {
  for (const base of [0, 10_050]) {
    const input = { type, basisPoints: basisPoints ?? null, amount: amount ?? null, base };
    add('estimate', input, api.estimateDiscountValue(discountShape('d', type, { basisPoints, amount }), base));
  }
}
for (const [products, productId] of [[undefined, PRODUCT_IDS.PREMIUM],
  [[], PRODUCT_IDS.PREMIUM], [[{ id: PRODUCT_IDS.PREMIUM }], PRODUCT_IDS.PREMIUM],
  [[{ id: PRODUCT_IDS.PREMIUM }], PRODUCT_IDS.PRO]]) {
  add('applicable', { products: products ?? null, productId },
    api.isDiscountApplicableToProduct(discountShape('d', 'fixed', { amount: 1, products }), productId));
}
const candidateSets = [
  [],
  [{ reason: 'referral', discount: discountShape('referral', 'fixed', { amount: 500 }) },
    { reason: 'promo', discount: discountShape('promo', 'fixed', { amount: 900 }) }],
  [{ reason: 'referral', discount: discountShape('referral', 'fixed', { amount: 500 }) },
    { reason: 'promo', discount: discountShape('promo', 'fixed', { amount: 500 }) }],
  [{ reason: 'promo', discount: discountShape('promo', 'percentage', { basisPoints: 1000 }) },
    { reason: 'winback', discount: discountShape('winback', 'fixed', { amount: 1200 }) }],
  [{ reason: 'upgrade', discount: discountShape('upgrade', 'mystery', { amount: 900 }) },
    { reason: 'change', discount: discountShape('change', 'fixed', { amount: 1 }) }]
];
for (const base of [0, 10_000]) {
  for (const candidates of candidateSets) {
    const best = api.selectBestDiscount(candidates, base);
    add('select', { candidates, base },
      best ? { reason: best.reason, id: best.discount.id } : null);
  }
}

// 2. Scenario inference: Polar's live subscription outranks the requested action.
for (const [action, active, target, current, winback, history] of [
  ['new', true, 'pro', 'pro', true, true],
  ['new', true, 'pro', 'premium', false, true],
  ['auto', true, 'premium', 'pro', false, true],
  ['auto', true, 'pro', 'free', false, true],
  ['new', false, 'premium', 'free', true, true],
  ['upgrade', false, 'pro', 'free', false, false],
  ['change', false, 'premium', 'free', false, false],
  ['reactivate', false, 'premium', 'free', false, true],
  ['reactivate', false, 'premium', 'free', true, true],
  ['auto', false, 'premium', 'free', true, true],
  ['auto', false, 'premium', 'free', false, true],
  ['auto', false, 'premium', 'free', true, false]
]) {
  add('scenario', { action, active, target, current, winback, history },
    api.inferScenario({ requestedAction: action, hasActiveSubscription: active, targetPlan: target,
      currentPlan: current, winbackEligible: winback, hasAnySubscriptionHistory: history }));
}

// 3. Plan mapping from the active product and the paid subscription list.
for (const [userPlan, activeProductId] of [['free', PRODUCT_IDS.PRO], ['free', PRODUCT_IDS.PREMIUM],
  ['premium', PRODUCT_IDS.FREE], ['pro', null], ['pro', 'unknown']]) {
  add('currentPlan', { userPlan, activeProductId },
    api.getCurrentPlanFromActiveSubscription(userPlan, activeProductId ?? undefined));
}
for (const ids of [[PRODUCT_IDS.PREMIUM, PRODUCT_IDS.PRO], [PRODUCT_IDS.PREMIUM], [PRODUCT_IDS.FREE], []]) {
  const subscriptions = ids.map((productId, index) => ({ id: `sub-${index}`, product_id: productId }));
  add('paidPlan', { subscriptions }, api.getPaidPlanFromSubscriptions(subscriptions));
}

// 4. Redirect sanitising with the source's environment names.
for (const [vars, rawUrl] of [
  [{}, 'https://elsewhere.example/x'],
  [{}, 'not a url'],
  [{}, ''],
  [{ BILLING_ALLOWED_REDIRECT_HOSTS: ' APP.example.com , ,b.example.com ', BILLING_SUCCESS_URL: 'https://fallback.example/success' }, 'https://app.example.com/ok'],
  [{ BILLING_ALLOWED_REDIRECT_HOSTS: 'app.example.com', BILLING_SUCCESS_URL: 'https://fallback.example/success' }, 'https://elsewhere.example/x'],
  [{ BILLING_ALLOWED_REDIRECT_HOSTS: 'app.example.com', BILLING_SUCCESS_URL: 'not a valid url' }, 'https://elsewhere.example/x'],
  [{ BILLING_SUCCESS_URL: 'https://app.example.com' }, null]
]) {
  env(vars);
  add('redirect', { env: vars, rawUrl }, api.sanitizeRedirectUrl(rawUrl ?? undefined, 'BILLING_SUCCESS_URL'));
}
env({});

// 5. UUID v4, cache key, and cached-context validity.
for (const value of ['5103e79b-fd74-4ba8-a287-f95574f9addf', ' 5103E79B-FD74-4BA8-A287-F95574F9ADDF ',
  '5103e79b-fd74-3ba8-a287-f95574f9addf', '5103e79b-fd74-4ba8-1287-f95574f9addf',
  '5103e79b-fd74-4ba8-a287-f95574f9add', 'not-a-uuid', '', null]) {
  add('uuid', { value }, api.isUuidV4(value ?? undefined));
}
for (const customerId of ['', 'cust', 'another-customer']) {
  add('cacheKey', { customerId }, api.creditPackBillingContextCacheKey(customerId));
}
for (const [value, nowMs] of [
  [{ version: 1, planTier: 'free', expiresAt: '2027-01-01T00:00:00.000Z' }, 1793001600000],
  [{ version: 1, planTier: 'pro', expiresAt: '2026-12-01T00:00:00.000Z' }, 1793001600000],
  [{ version: 2, planTier: 'pro', expiresAt: '2026-12-01T00:00:00.000Z' }, 1793001600000],
  [{ version: 1, planTier: 'gold' }, 1793001600000],
  [{ version: 1, planTier: 'premium', expiresAt: '2026-11-01T00:00:00.000Z' }, 1793001600000],
  [{ version: 1, planTier: 'premium' }, 1793001600000],
  ['pro', 1793001600000],
  [null, 1793001600000]
]) {
  const normalized = api.validCachedBillingContext(value, nowMs);
  add('cached', { value, nowMs }, normalized
    ? { planTier: normalized.planTier, expiresAt: normalized.expiresAt, version: normalized.version }
    : null);
}

// 6. Whole-month differences.
for (const [from, to] of [['2026-01-15T00:00:00Z', '2026-07-20T00:00:00Z'],
  ['2026-01-31T00:00:00Z', '2026-02-28T00:00:00Z'],
  ['2026-03-01T00:00:00Z', '2025-12-31T00:00:00Z'],
  ['2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z']]) {
  add('months', { from, to }, api.diffMonths(new Date(from), new Date(to)));
}

// 7. Metadata compaction: null/undefined/blank/structural values are dropped.
for (const entries of [
  [['source', 'dimabot_billing'], ['blank', '   '], ['count', 3], ['flag', true]],
  [['null', null], ['object', { a: 1 }], ['empty', '']]
]) {
  const metadata = {};
  for (const [key, value] of entries) if (value !== null) metadata[key] = value;
  const compacted = api.compactMetadata(metadata);
  add('compact', { entries }, Object.entries(compacted).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// 8. Gift pair validation against the real configured pairs.
const GIFT_PAIRS = api.GIFT_PACK_PAIRS;
const giftProduct = (id, options = {}) => ({
  id,
  name: options.name ?? 'Gift credits',
  is_archived: options.archived ?? false,
  is_recurring: options.recurring ?? false,
  visibility: options.visibility ?? 'public',
  prices: options.prices ?? [{ type: 'one_time', amount_type: 'fixed', price_amount: options.price ?? 1999, price_currency: options.currency ?? 'USD', is_archived: false }],
  benefits: options.benefits ?? []
});
const giftBenefit = (units, options = {}) => ({
  id: options.id ?? 'benefit-1',
  type: options.type ?? 'meter_credit',
  is_deleted: options.deleted ?? false,
  properties: { units, rollover: options.rollover ?? true, meter_id: options.meter ?? AI_CREDITS_METER_ID }
});
function giftCase(paid, free) {
  try {
    const value = api.validateGiftPair(paid, free);
    return { ok: true, value: {
      offer: { id: value.offer.id, name: value.offer.name, credits: value.offer.credits,
        rollover: value.offer.rollover, priceAmount: value.offer.priceAmount,
        priceCurrency: value.offer.priceCurrency },
      fulfillmentProductId: value.fulfillmentProductId, benefitId: value.benefitId } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
const validFulfillment = index => giftProduct(GIFT_PAIRS[index].fulfillmentProductId,
  { price: 0, currency: 'usd', benefits: [giftBenefit(GIFT_PAIRS[index].credits)] });
const giftCases = [
  [giftProduct(GIFT_PAIRS[0].productId, { name: '  Gift credits  ' }), validFulfillment(0)],
  [giftProduct(GIFT_PAIRS[0].productId), validFulfillment(1)],
  [giftProduct(GIFT_PAIRS[0].productId, { archived: true }), validFulfillment(0)],
  [giftProduct(GIFT_PAIRS[0].productId, { visibility: 'draft' }), validFulfillment(0)],
  [giftProduct(GIFT_PAIRS[1].productId), giftProduct(GIFT_PAIRS[1].fulfillmentProductId, { price: 100, currency: 'usd', benefits: [giftBenefit(GIFT_PAIRS[1].credits)] })],
  [giftProduct(GIFT_PAIRS[1].productId), giftProduct(GIFT_PAIRS[1].fulfillmentProductId, { price: 0, currency: 'eur', benefits: [giftBenefit(GIFT_PAIRS[1].credits)] })],
  [giftProduct(GIFT_PAIRS[1].productId), giftProduct(GIFT_PAIRS[1].fulfillmentProductId, { price: 0, currency: 'usd', benefits: [giftBenefit(GIFT_PAIRS[1].credits), giftBenefit(GIFT_PAIRS[1].credits)] })],
  [giftProduct(GIFT_PAIRS[2].productId), giftProduct(GIFT_PAIRS[2].fulfillmentProductId, { price: 0, currency: 'usd', benefits: [giftBenefit(GIFT_PAIRS[2].credits, { rollover: false })] })],
  [giftProduct(GIFT_PAIRS[2].productId, { name: '   ' }), validFulfillment(2)]
];
for (const [paid, free] of giftCases) add('gift', { paid, free }, giftCase(paid, free));

// 9. Credit-source classification and the grant/order read paths.
const creditEvent = (id, at, units, rollover) => ({
  id, name: 'meter.credited', timestamp: at,
  metadata: { meterId: AI_CREDITS_METER_ID, units, rollover }
});
const benefitEvent = (id, grantId, benefitId, at) => ({
  id, name: 'benefit.granted', timestamp: at,
  metadata: { benefitType: 'meter_credit', benefitGrantId: grantId, benefitId }
});
const grantRecord = (id, benefitId, options = {}) => ({
  id, benefit_id: benefitId, customer_id: options.customer ?? 'customer-1',
  order_id: options.order ?? null, subscription_id: options.subscription ?? null,
  benefit: { id: benefitId, type: 'meter_credit', properties: {
    meter_id: AI_CREDITS_METER_ID, units: options.units ?? 40_000, rollover: options.rollover ?? true } }
});
const orderRecord = (id, productId, options = {}) => ({
  id, customer_id: options.customer ?? 'customer-1', product_id: productId,
  subscription_id: null, paid: options.paid ?? true, total_amount: options.total ?? 1999,
  metadata: options.metadata ?? {}
});
async function classifyCase(input) {
  const reads = {
    grant: async id => input.grants.find(grant => grant.id === id) ?? null,
    order: async id => input.orders.find(order => order.id === id) ?? orderRecord(id, 'unknown')
  };
  try {
    const result = await api.classifyPolarCreditSources(input.customerId, input.events, reads);
    return { ok: true, value: [...result.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

(async () => {
  const PACK_ID = '45c32959-3fa2-41a6-855c-bbeafcf9ce3c';
  const GIFT_FULFILLMENT_ID = GIFT_PAIRS[0].fulfillmentProductId;
  const classificationInputs = [
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 25_000, false), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:02Z')],
      grants: [grantRecord('g1', 'b1', { subscription: 'sub-1', units: 25_000 })], orders: [] },
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 40_000, true), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:01Z')],
      grants: [grantRecord('g1', 'b1', { order: 'o1', units: 40_000 })],
      orders: [orderRecord('o1', PACK_ID)] },
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 40_000, true), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:01Z')],
      grants: [grantRecord('g1', 'b1', { order: 'o1', units: 40_000 })],
      orders: [orderRecord('o1', GIFT_FULFILLMENT_ID, { total: 0, metadata: { source: 'dimabot_gift_fulfillment', gift_id: 'gift-1' } })] },
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 40_000, true), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:01Z'), benefitEvent('e2', 'g2', 'b1', '2026-09-04T10:00:02Z')],
      grants: [grantRecord('g1', 'b1', { order: 'o1' }), grantRecord('g2', 'b1', { order: 'o2' })],
      orders: [orderRecord('o1', PACK_ID), orderRecord('o2', PACK_ID)] },
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 40_000, false), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:01Z')],
      grants: [grantRecord('g1', 'b1', { subscription: 'sub-1', rollover: true, units: 40_000 })], orders: [] },
    { customerId: 'customer-1', events: [creditEvent('c1', '2026-09-04T10:00:00Z', 40_000, true), benefitEvent('e1', 'g1', 'b1', '2026-09-04T10:00:01Z')],
      grants: [grantRecord('g1', 'b1', { order: 'o1', units: 40_000, customer: 'elsewhere' })],
      orders: [orderRecord('o1', PACK_ID)] }
  ];
  for (const input of classificationInputs) add('classify', input, await classifyCase(input));

  const grantPages = [
    { items: [
      { id: 'g1', benefit_id: 'b1', customer_id: 'customer-1', is_granted: true, is_revoked: false, subscription_id: 'sub-1' },
      { id: 'g2', benefit_id: 'b1', customer_id: 'customer-1', is_granted: false, is_revoked: false, subscription_id: 'sub-2' }
    ], pagination: { max_page: 2 } },
    { items: [
      { id: 'g1', benefit_id: 'b1', customer_id: 'customer-1', is_granted: true, is_revoked: false, subscription_id: 'sub-3' }
    ], pagination: { max_page: 2 } }
  ];
  const grantPaths = [];
  activeTransport = async transportPath => {
    grantPaths.push(transportPath);
    if (transportPath.startsWith('/v1/orders/')) return orderRecord('order-1', PACK_ID);
    const page = Number(new URL('https://polar.invalid' + transportPath).searchParams.get('page'));
    return grantPages[page - 1];
  };
  const reads = api.polarCreditSourceReads('customer-1');
  const grant = await reads.grant('g1');
  add('grantPath', { customerId: 'customer-1', grantId: 'g1' },
    { paths: grantPaths.slice(), grant: grant && { id: grant.id, benefit_id: grant.benefit_id, subscription_id: grant.subscription_id } });
  grantPaths.length = 0;
  const order = await reads.order('order-1');
  add('grantPath', { customerId: 'customer-1', orderId: 'order-1' },
    { paths: grantPaths.slice(), order: { id: order.id, product_id: order.product_id } });

  const counts = {};
  for (const item of cases) counts[item.kind] = (counts[item.kind] || 0) + 1;
  const output = {
    metadata: {
      schema: 1, node: process.version, v8: process.versions.v8, typescript: ts.version,
      hashes,
      extractionSha256: sha(extraction),
      typecheckSourceSha256: sha(virtualSource),
      transpiledSha256: sha(transpiled.outputText),
      typeDiagnostics: diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      declarations,
      constants: {
        productIds: PRODUCT_IDS,
        meterId: AI_CREDITS_METER_ID,
        giftPairs: GIFT_PAIRS,
        winbackMonths: api.WINBACK_MONTHS,
        cacheVersion: api.CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION,
        packs: api.CREDIT_PACK_DEFINITIONS,
        eventTypes: api.CREDIT_SOURCE_MATCH_MS
      },
      counts, total: cases.length
    },
    cases
  };

  const [mode, dir, ...extra] = process.argv.slice(2);
  assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(), 'parent must create the owned output directory');
  const target = path.join(fs.realpathSync(dir), 'billing_reference.json');
  const body = JSON.stringify(output, null, 2) + '\n';
  const artifacts = [
    [target, body],
    [path.join(dir, 'billing_reference_extracted.ts'), extraction],
    [path.join(dir, 'billing_reference_typecheck.ts'), virtualSource],
    [path.join(dir, 'billing_reference_compiled.cjs'), transpiled.outputText]
  ];
  if (mode === '--write') {
    for (const [file] of artifacts) assert(!fs.existsSync(file), `refuse overwrite ${file}`);
    for (const [file, content] of artifacts) fs.writeFileSync(file, content, { flag: 'wx' });
  } else {
    for (const [file, content] of artifacts) {
      const actual = fs.readFileSync(file, 'utf8');
      assert(actual.length > 0);
      assert.equal(actual, content, 'metadata/source/matrix drift');
    }
  }
  process.stdout.write(`${mode} ${target}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
