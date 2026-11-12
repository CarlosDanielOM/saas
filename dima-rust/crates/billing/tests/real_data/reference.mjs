// The reference's answers for every user of the dump (tests/real_data/users.json), recorded once
// with the real billing.ts and polar_billing_events.ts under Node 24, offline (see real_data.rs).
// Stores and Polar are stand-ins; the clock is fixed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const DEPS = process.env.DIMA_DEPS || '/deps/node_modules';
const ts = (await import(`${DEPS}/typescript/lib/typescript.js`)).default;
const ROOT = new URL('../../../../../dimabot/src/', import.meta.url);
const [dumpPath, outPath] = process.argv.slice(2);
assert.ok(dumpPath && outPath, 'usage: reference.mjs <users.json> <reference.json>');
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const sources = {};

const context = vm.createContext({ console: { log() {}, warn() {}, error() {}, info() {} }, URL, URLSearchParams, Response, process: { env: { POLARSH_OAT: 'x' } } });
vm.runInContext(`
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(${NOW}); else super(...args); }
    static now() { return ${NOW}; }
  }
  FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
  globalThis.__date = (ms) => new FakeDate(ms);
`, context);
const date = ms => vm.runInContext(`__date(${ms})`, context);

async function load(file, imports) {
  const input = await readFile(new URL(file, ROOT), 'utf8');
  sources[file] = createHash('sha256').update(input).digest('hex');
  const ast = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast)).join('\n');
  const result = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const name = `m_${file.replace(/[^a-z0-9]/gi, '_')}`;
  context.__imports = imports;
  vm.runInContext(`globalThis.${name} = { exports: {} };
    (function (exports, imports) { with (imports) { ${result.outputText} } })(globalThis.${name}.exports, __imports);`, context, { filename: file });
  return context[name].exports;
}

const PRODUCT_IDS = { FREE: 'fccf0669-adab-447d-89c8-d77d8b83bea5', PREMIUM: '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134', PRO: '1468eea1-7ad0-40d2-b828-4d4cd6b4abdc' };
const fence = await load('utils/plan_cache_fence.ts', {});
const packs = await load('utils/credit_packs.ts', {});
const billing = await load('utils/billing.ts', { PRODUCT_IDS, getDragonflyClient: async () => { throw new Error('no cache'); }, createHash, ...fence, ...packs });

// polar_billing_events.ts with every dependency a stand-in the case sets.
const sentinel = message => Object.assign(new Error(message), { sentinel: true });
let current = null;
let syncCalls = [];
let fingerprintFor = () => '';
const UsersSchema = {
  findOneAndUpdate: () => { const chain = { select: () => chain, lean: async () => { if (current.mode === 'plan') throw sentinel('PROJECTED'); return current.doc; } }; return chain; },
  findById: () => { const chain = { select: () => chain, lean: async () => current.doc }; return chain; },
  updateOne: async () => ({}),
};
class DomainEventPrerequisiteMissingError extends Error {}
const events = await load('domain_events/polar_billing_events.ts', {
  DomainEventPrerequisiteMissingError, polarWebhookProducer: {}, UsersSchema, PRODUCT_IDS, applyPaidOrderReward: async () => {},
  getDragonflyClient: async () => ({ eval: async (_script, options) => { syncCalls.push(options.arguments); return 1; }, del: async () => 1 }),
  AI_CREDITS_METER_ID: billing.AI_CREDITS_METER_ID, AI_CREDITS_CACHE_TTL_SECONDS: billing.AI_CREDITS_CACHE_TTL_SECONDS,
  buildAiCreditsDataFromMeter: billing.buildAiCreditsDataFromMeter, creditPackBillingContextCacheKey: billing.creditPackBillingContextCacheKey,
  adjustAiUsageRetention: async () => {}, getPolarShClient: async () => ({}), Types: { ObjectId: class {} }, randomUUID: () => 'u',
  PLAN_CACHE_VERSION_FIELD: fence.PLAN_CACHE_VERSION_FIELD, planCacheVersion: fence.planCacheVersion,
  POLAR_PLAN_EVENT_TYPES: ['billing.customer.state.changed'], POLAR_ENTITLEMENT_REQUEST_OPTIONS: {},
  loadPolarGraceSubscriptions: async () => [], resolvePolarEntitledPlan: async () => current.entitled,
  polarEntitlementFingerprint: (...args) => fingerprintFor(...args),
});

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if ('$date' in value) return date(value.$date);
    return Object.fromEntries(Object.entries(value).filter(([, v]) => !(v && typeof v === 'object' && '$undefined' in v)).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

let fetchAnswer = { items: [] };
context.fetch = async () => new Response(JSON.stringify(fetchAnswer), { status: 200 });

const dump = JSON.parse(await readFile(dumpPath, 'utf8'));
const answers = {};
for (const raw of dump.users) {
  const user = revive(raw);
  const twitch = Array.from({ length: raw.twitch_accounts }, (_, i) => ({ type: 'twitch', id: `t${i}` }));
  const doc = { ...user, _id: { toString: () => raw._id }, accounts: twitch };
  const out = {};
  out.limit = billing.getAiCreditLimitForPlan(user.plan_tier);
  out.planVersion = fence.planCacheVersion(user.polar_plan_event_at, user.polar_plan_event_key);
  const product = user.plan_tier === 'pro' ? PRODUCT_IDS.PRO : user.plan_tier === 'premium' ? PRODUCT_IDS.PREMIUM : null;
  for (const [variant, answer] of [['none', { items: [] }],
    ['active', { items: product ? [{ id: 'sub_real', status: 'active', product_id: product, current_period_end: '2026-12-01T00:00:00Z' }] : [] }]]) {
    fetchAnswer = answer;
    for (const target of [undefined, 'premium', 'pro']) {
      for (const action of ['auto', 'new', 'reactivate']) {
        out[`context:${variant}:${target ?? 'none'}:${action}`] = await billing.getBillingContext(doc, target, action);
      }
    }
  }
  if (user.polar_credit_snapshot) {
    const snapshot = user.polar_credit_snapshot;
    current = { mode: 'credits', doc };
    syncCalls = [];
    await events.applyPolarCreditsDomainEvent({ source: 'polar-webhook', type: 'billing.customer.state.changed', ownerUserId: raw._id,
      occurredAt: snapshot.occurredAt, eventKey: snapshot.eventKey, payload: { meters: snapshot.meters } }, { getOwner: async () => doc });
    if (syncCalls.length) {
      out.snapshotCredits = syncCalls[0][1] ? JSON.parse(syncCalls[0][1]) : null;
      out.snapshotCreditsText = syncCalls[0][1];
      out.snapshotExhaustion = syncCalls[0][2];
    } else {
      const meter = snapshot.meters.find(m => m.meter_id === billing.AI_CREDITS_METER_ID);
      out.snapshotCredits = meter ? billing.buildAiCreditsDataFromMeter(meter, user.plan_tier, snapshot.occurredAt.toISOString()) : null;
      const balance = out.snapshotCredits?.balance ?? snapshot.meters.find(m => m.meter_id === '01d90c16-87d0-4e31-880a-4045a8da90cd')?.balance;
      out.snapshotExhaustion = balance === undefined ? '' : balance <= 0 ? '1' : '0';
    }
  }
  // The first skip rule, with the payload's fingerprint equal to the stored one.
  const event = { source: 'polar-webhook', type: 'billing.customer.state.changed', ownerUserId: raw._id, eventKey: 'k',
    payload: { customerId: user.polar_sh_customer_id || 'cust', activeSubscriptions: [], grantedBenefits: [] } };
  const plainOwner = { ...doc, polar_sh_customer_id: user.polar_sh_customer_id || 'cust' };
  const run = async () => {
    try { await events.applyPolarPlanDomainEvent(event, { getOwner: async () => plainOwner, getCustomerState: async () => { throw sentinel('FETCHED'); } }); return 'skipped'; }
    catch (error) { if (error.sentinel) return error.message; throw error; }
  };
  // A real fingerprint is a hex digest, so a user without a stored one never matches.
  fingerprintFor = () => user.polar_plan_entitlement_fingerprint ?? 'no-stored-fingerprint';
  current = { mode: 'plan', doc };
  out.stateUnchanged = (await run()) === 'skipped';
  // The second skip rule, for each entitled tier (the fingerprint differs).
  fingerprintFor = () => 'different';
  for (const tier of ['free', 'premium', 'pro']) {
    current = { mode: 'plan', doc, entitled: { planTier: tier, until: null } };
    const outcome = await (async () => {
      try { await events.applyPolarPlanDomainEvent(event, { getOwner: async () => plainOwner, getCustomerState: async () => ({}) }); return 'skipped'; }
      catch (error) { if (error.sentinel) return error.message; throw error; }
    })();
    out[`keepsUnmanaged:${tier}`] = outcome === 'skipped';
  }
  answers[raw._id] = JSON.parse(JSON.stringify(out, (key, value) => value === undefined ? { $undefined: true } : value));
}
await writeFile(outPath, JSON.stringify({ now: NOW, sources: Object.fromEntries(Object.entries(sources).sort()), answers }, null, 1) + '\n');
console.log(`Recorded the reference's answers for ${dump.users.length} users.`);
