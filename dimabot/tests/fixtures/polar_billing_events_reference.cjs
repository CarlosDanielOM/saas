'use strict';
// Actual Polar plan/credits projection behaviour, evaluated from the TypeScript
// sources with a scripted Mongoose schema and a recording cache.
//
// `plan_cache_fence.ts` has been retired (its Rust port owns the Lua and
// `planCacheVersion`), so `planCacheVersion`/`PLAN_CACHE_VERSION_FIELD` are the
// only stubs here; every projection body is real.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const files = {
  events: 'src/domain_events/polar_billing_events.ts',
  entitlements: 'src/domain_events/polar_entitlements.ts',
  billing: 'src/utils/billing.ts'
};
const sourcePath = key => path.join(root, files[key]);
const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')])
);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  events: 'bf134b805840bfee44b94f861736976dc6739ac535e75c6bf2203ae11a54948d',
  entitlements: '681d065391cdb2853959b52074476d5406e321c51cfa640d72d0c2e057795b81',
  billing: 'a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d',
  package: 'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  lock: 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  typescript: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  typescriptPackage: '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6'
};
const hashes = {
  events: sha(Buffer.from(source.events)),
  entitlements: sha(Buffer.from(source.entitlements)),
  billing: sha(Buffer.from(source.billing)),
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

const names = {
  events: ['LEGACY_USAGE_METER_ID', 'PolarBillingDependencies', 'dependencies',
    'applyPolarPlanDomainEvent', 'projectPolarPlan', 'reconcilePolarPlanEntitlement',
    'applyPolarCreditsDomainEvent'],
  entitlements: ['POLAR_PLAN_EVENT_TYPES'],
  billing: ['PlanTier', 'AiCreditStatus', 'AiCreditsData', 'PolarAiCreditsMeterLike',
    'AI_CREDIT_LIMITS', 'AI_CREDITS_CACHE_TTL_SECONDS', 'AI_CREDITS_CACHE_SCHEMA_VERSION',
    'toFiniteNumber', 'getAiCreditLimitForPlan', 'buildAiCreditsDataFromMeter',
    'creditPackBillingContextCacheKey', 'CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION']
};
const exported = new Set(['LEGACY_USAGE_METER_ID', 'POLAR_PLAN_EVENT_TYPES', 'AiCreditStatus',
  'AiCreditsData', 'PolarAiCreditsMeterLike', 'AI_CREDIT_LIMITS', 'AI_CREDITS_CACHE_TTL_SECONDS',
  'AI_CREDITS_CACHE_SCHEMA_VERSION', 'getAiCreditLimitForPlan', 'buildAiCreditsDataFromMeter',
  'creditPackBillingContextCacheKey', 'applyPolarPlanDomainEvent', 'applyPolarCreditsDomainEvent',
  'reconcilePolarPlanEntitlement']);

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

// Signatures only. The projection bodies and the credits payload builder are real.
const stubs = `
type DomainEventEnvelope = any;
type IUsers = any;
type PolarBillingPayload = any;
type PolarEntitlementState = any;
type PolarGraceLookup = any;
type PolarPlan = { planTier: 'free' | 'premium' | 'pro'; until: Date | null };
declare const POLAR_ENTITLEMENT_REQUEST_OPTIONS: { timeoutMs: number; retries: { strategy: 'none' } };
declare function resolvePolarEntitledPlan(state: any, customerId: string, now: Date, grace: any): Promise<PolarPlan>;
declare function polarEntitlementFingerprint(state: any): string;
declare function loadPolarGraceSubscriptions(client: any, customerId: string, grants: any): Promise<any[]>;
declare const PRODUCT_IDS: { readonly FREE: string; readonly PREMIUM: string; readonly PRO: string };
declare const AI_CREDITS_METER_ID: string;
declare const PLAN_CACHE_VERSION_FIELD: string;
declare function planCacheVersion(at: Date | null | undefined, key: string | null | undefined): string;
declare const UsersSchema: any;
declare function getDragonflyClient(context: string): Promise<any>;
declare function applyPaidOrderReward(input: any): Promise<void>;
declare function adjustAiUsageRetention(ids: string[], tier: string): Promise<void>;
declare function getPolarShClient(label: string): Promise<any>;
declare const Types: any;
declare function randomUUID(): string;
declare function createHash(name: string): { update(value: string): { digest(encoding: string): string } };
declare class DomainEventPrerequisiteMissingError extends Error { constructor(prerequisite: string); readonly outcome: string; }
`;
const virtualFile = path.join(root, '__polar_billing_oracle__.ts');
const virtualSource = stubs + extraction;
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, skipLibCheck: true, types: [] };
const host = ts.createCompilerHost(compilerOptions);
const hostRead = host.readFile.bind(host), hostExists = host.fileExists.bind(host);
host.readFile = f => f === virtualFile ? virtualSource : hostRead(f);
host.fileExists = f => f === virtualFile || hostExists(f);
const program = ts.createProgram([virtualFile], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);

const runtimeNames = declarations
  .filter(entry => entry.kind === 'VariableStatement' || entry.kind === 'FunctionDeclaration')
  .map(entry => entry.name);
const transpiled = ts.transpileModule(extraction + `\nexport {${runtimeNames.join(', ')}};\n`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(transpiled.diagnostics.length, 0);

const PRODUCT_IDS = {
  FREE: 'fccf0669-adab-447d-89c8-d77d8b83bea5',
  PREMIUM: '55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134',
  PRO: '1468eea1-7ad0-40d2-b828-4d4cd6b4abdc'
};
const AI_CREDITS_METER_ID = '5103e79b-fd74-4ba8-a287-f95574f9addf';
const PLAN_CACHE_VERSION_FIELD = '__polar_plan_version';
// The retired `plan_cache_fence.ts` formula, which the Rust port owns.
const planCacheVersion = (at, key) => {
  if (!at || !key) return '';
  return `${String(at.getTime()).padStart(13, '0')}:${key}`;
};

let active;
const chain = value => ({ lean: async () => value, select: () => chain(value) });
const UsersSchema = {
  findOneAndUpdate(filter, update) {
    active.updates.push({ filter, update });
    return chain(active.afterUpdate);
  },
  findById(id) {
    active.finds.push(id);
    return chain(active.afterFind);
  },
  updateOne(filter, update) {
    active.acknowledges.push({ filter, update });
    return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
  }
};
class DomainEventPrerequisiteMissingError extends Error {
  constructor(prerequisite) { super(`Missing prerequisite: ${prerequisite}`); this.outcome = 'prerequisite-missing'; }
}
class ObjectId {
  constructor(value) { this.value = value ?? crypto.randomBytes(12).toString('hex'); }
  toString() { return this.value; }
  toHexString() { return this.value; }
}
const context = vm.createContext({
  exports: {}, module: { exports: {} }, Error, Date, Math, JSON, Number, String, Object, Array,
  Promise, RegExp,
  PRODUCT_IDS, AI_CREDITS_METER_ID, PLAN_CACHE_VERSION_FIELD, planCacheVersion,
  createHash: crypto.createHash,
  randomUUID: crypto.randomUUID,
  Types: { ObjectId },
  UsersSchema,
  DomainEventPrerequisiteMissingError,
  resolvePolarEntitledPlan: async state => active.plan,
  polarEntitlementFingerprint: () => active.fingerprint,
  loadPolarGraceSubscriptions: async () => [],
  POLAR_ENTITLEMENT_REQUEST_OPTIONS: { timeoutMs: 10_000, retries: { strategy: 'none' } },
  getDragonflyClient: async () => active.cache,
  applyPaidOrderReward: async () => { active.rewards.push(true); },
  adjustAiUsageRetention: async (ids, tier) => { active.retention.push({ ids, tier }); },
  getPolarShClient: async () => ({ customers: { getState: async () => active.state } })
});
context.exports = context.module.exports;
vm.runInContext(transpiled.outputText, context, { filename: 'actual-polar-billing-events.js' });
const api = context.module.exports;

const bits = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };
function encode(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === 'number') return { $f64: bits(v) };
  if (v instanceof Date) return { $date: v.getTime() };
  if (v instanceof ObjectId) return { $oid: v.toString() };
  if (Array.isArray(v)) return { $array: v.map(encode) };
  if (v && typeof v === 'object') return { $object: Object.keys(v).map(k => [k, encode(v[k])]) };
  return v;
}

const cases = [];
const at = value => (value == null ? null : new Date(value));
function makeEvent(spec) {
  return {
    _id: new ObjectId('65e000000000000000000000'),
    eventKey: spec.eventKey,
    sourceEventId: 'delivery-1',
    source: 'polar-webhook',
    type: spec.type,
    topic: 'domain',
    schemaVersion: 1,
    ownerUserId: spec.ownerUserId ?? undefined,
    subject: spec.subject,
    occurredAt: new Date(spec.occurredAt),
    journaledAt: new Date('2026-09-05T10:00:00Z'),
    expiresAt: new Date('2026-10-05T10:00:00Z'),
    payload: spec.payload,
    metadata: spec.metadata ?? {}
  };
}
function ownerFrom(spec) {
  return {
    _id: new ObjectId(spec.ownerUserId),
    plan_tier: spec.ownerTier,
    plan_tier_until: at(spec.ownerUntil),
    polar_sh_customer_id: spec.ownerCustomer,
    polar_plan_event_at: at(spec.ownerEventAt),
    polar_plan_event_key: spec.ownerEventKey ?? undefined,
    polar_plan_effects_pending: spec.ownerPending ?? undefined,
    polar_plan_entitlement_fingerprint: spec.ownerFingerprint ?? undefined,
    accounts: spec.accounts.map(type => ({ type: 'twitch', id: type }))
  };
}
function dependenciesFor(spec) {
  return {
    getOwner: async () => ownerFrom(spec),
    getCache: async () => active.cache,
    applyReward: async () => { active.rewards.push(true); },
    adjustUsageRetention: async (ids, tier) => { active.retention.push({ ids, tier }); },
    getCustomerState: async () => spec.customerState ?? { id: spec.ownerCustomer, activeSubscriptions: [], grantedBenefits: [] },
    getGraceSubscriptions: async () => [],
    now: () => new Date(spec.now)
  };
}
function planSummary(state) {
  const inFilter = state.updates[0]?.filter ?? {};
  const set = state.updates[0]?.update?.$set ?? {};
  const branches = (inFilter.$or ?? []).map(branch => ({
    exists: branch.polar_plan_event_at?.$exists === false,
    lt: branch.polar_plan_event_at?.$lt instanceof Date ? branch.polar_plan_event_at.$lt.getTime() : null,
    eq: branch.polar_plan_event_at instanceof Date ? branch.polar_plan_event_at.getTime() : null,
    keyLte: branch.polar_plan_event_key?.$lte ?? null
  }));
  return {
    filter: { customer: inFilter.polar_sh_customer_id ?? null, branches },
    set: {
      tier: set.plan_tier ?? null,
      until: set.plan_tier_until instanceof Date ? set.plan_tier_until.getTime() : null,
      eventAt: set.polar_plan_event_at instanceof Date ? set.polar_plan_event_at.getTime() : null,
      eventKey: set.polar_plan_event_key ?? null,
      fingerprint: set.polar_plan_entitlement_fingerprint ?? null,
      pending: set.polar_plan_effects_pending === true
    },
    acknowledges: state.acknowledges.map(entry => ({
      owner: entry.filter._id?.toString?.() ?? null,
      key: entry.filter.polar_plan_event_key ?? null,
      unset: Object.keys(entry.update?.$unset ?? {})
    })),
    invalidation: state.evals.filter(entry => entry.kind === 'invalidate').map(entry => ({
      keys: entry.keys, args: entry.args
    })),
    deleted: state.dels,
    retention: state.retention,
    error: state.error
  };
}
function creditSummary(state) {
  const inFilter = state.updates[0]?.filter ?? {};
  const snapshot = state.updates[0]?.update?.$set?.polar_credit_snapshot ?? null;
  const branches = (inFilter.$or ?? []).map(branch => ({
    exists: branch['polar_credit_snapshot.occurredAt']?.$exists === false,
    lt: branch['polar_credit_snapshot.occurredAt']?.$lt instanceof Date ? branch['polar_credit_snapshot.occurredAt'].$lt.getTime() : null,
    eq: branch['polar_credit_snapshot.occurredAt'] instanceof Date ? branch['polar_credit_snapshot.occurredAt'].getTime() : null,
    keyLte: branch['polar_credit_snapshot.eventKey']?.$lte ?? null
  }));
  return {
    filter: { branches },
    snapshot: snapshot && {
      occurredAt: snapshot.occurredAt instanceof Date ? snapshot.occurredAt.getTime() : null,
      eventKey: snapshot.eventKey ?? null,
      meters: (snapshot.meters ?? []).map(meter => meter.meter_id)
    },
    sync: state.evals.filter(entry => entry.kind === 'sync').map(entry => ({
      keys: entry.keys, args: entry.args
    })),
    error: state.error
  };
}
function newState(spec) {
  const evals = [];
  return {
    updates: [], finds: [], acknowledges: [], evals, dels: [], retention: [], rewards: [],
    plan: spec.plan, fingerprint: spec.fingerprint,
    afterUpdate: spec.afterUpdate === false ? null : ownerFrom(spec),
    afterFind: spec.afterFind ? ownerFrom({ ...spec, ...spec.afterFind }) : null,
    customerState: spec.customerState,
    state: spec.customerState,
    error: null,
    cache: {
      eval: async (script, options) => {
        evals.push({
          kind: script.includes('currentPlanVersion') ? 'sync' : 'invalidate',
          keys: options.keys, args: options.arguments
        });
        return 1;
      },
      del: async key => {
        active.dels.push(key);
        return 1;
      }
    }
  };
}
async function planCase(id, spec) {
  active = newState(spec);
  const event = makeEvent(spec);
  try {
    await api.applyPolarPlanDomainEvent(event, dependenciesFor(spec));
  } catch (error) {
    active.error = error instanceof Error ? error.message : String(error);
  }
  cases.push({ id, kind: 'plan', input: spec, expected: encode(planSummary(active)) });
}
async function creditsCase(id, spec) {
  active = newState(spec);
  const event = makeEvent(spec);
  try {
    await api.applyPolarCreditsDomainEvent(event, dependenciesFor(spec));
  } catch (error) {
    active.error = error instanceof Error ? error.message : String(error);
  }
  cases.push({ id, kind: 'credits', input: spec, expected: encode(creditSummary(active)) });
}
async function reconcileCase(id, spec) {
  active = newState(spec);
  let result = null;
  let error = null;
  try {
    result = await api.reconcilePolarPlanEntitlement(
      { ownerUserId: spec.ownerUserId, customerId: spec.ownerCustomer, execute: spec.execute },
      dependenciesFor(spec)
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  cases.push({
    id, kind: 'reconcile', input: spec,
    expected: encode({
      executed: result?.executed ?? null,
      applied: result?.applied ?? null,
      proposed: result ? { tier: result.proposed.planTier, until: result.proposed.until ? result.proposed.until.getTime() : null } : null,
      before: result ? { tier: result.before.planTier, until: result.before.until ? result.before.until.getTime() : null } : null,
      updates: active.updates.length,
      error
    })
  });
}

const OWNER_ID = '0123456789abcdef01234567';
const CUSTOMER = 'cust-1';
const baseEvent = {
  eventKey: 'polar-webhook:delivery-1',
  type: 'billing.subscription.updated',
  occurredAt: '2026-09-04T10:00:00Z',
  ownerUserId: OWNER_ID,
  subject: { provider: 'polar', kind: 'customer', id: CUSTOMER },
  payload: { customerId: CUSTOMER },
  ownerCustomer: CUSTOMER,
  ownerTier: 'free',
  ownerUntil: null,
  ownerEventAt: null,
  ownerEventKey: null,
  ownerPending: false,
  ownerFingerprint: null,
  accounts: ['chan-1'],
  plan: { planTier: 'premium', until: new Date('2026-10-04T10:00:00Z') },
  fingerprint: 'f'.repeat(64),
  now: 1788000000000,
  afterUpdate: true
};

(async () => {
  await planCase('plan-projection', { ...baseEvent });
  await planCase('plan-no-twitch', { ...baseEvent, accounts: [] });
  await planCase('plan-legacy-guard', {
    ...baseEvent,
    type: 'billing.customer.state.changed',
    payload: { customerId: CUSTOMER, meters: [] },
    ownerTier: 'premium',
    ownerEventKey: null,
    plan: { planTier: 'free', until: null }
  });
  await planCase('plan-lost-race', {
    ...baseEvent,
    afterUpdate: false,
    afterFind: { ownerTier: 'premium', ownerUntil: '2026-12-01T10:00:00Z' }
  });
  await reconcileCase('plan-reconcile-dry-run', { ...baseEvent, execute: false });
  await creditsCase('credits-publish', {
    ...baseEvent,
    type: 'billing.customer.state.changed',
    eventKey: 'polar-webhook:delivery-2',
    accounts: ['chan-1', 'chan-2'],
    payload: {
      customerId: CUSTOMER,
      meters: [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 30, balance: -30 }]
    },
    ownerTier: 'premium',
    ownerEventAt: '2026-09-04T09:00:00Z',
    ownerEventKey: 'polar-webhook:delivery-0'
  });
  await creditsCase('credits-legacy-meter', {
    ...baseEvent,
    type: 'billing.customer.state.changed',
    payload: {
      customerId: CUSTOMER,
      meters: [{ meter_id: '01d90c16-87d0-4e31-880a-4045a8da90cd', balance: -2 }]
    },
    accounts: ['chan-1']
  });

  const counts = {};
  for (const item of cases) counts[item.kind] = (counts[item.kind] || 0) + 1;
  const output = {
    metadata: {
      schema: 1, node: process.version, v8: process.versions.v8, typescript: ts.version,
      hashes,
      extractionSha256: sha(extraction),
      typecheckSourceSha256: sha(virtualSource),
      transpiledSha256: sha(transpiled.outputText),
      typeDiagnostics: [],
      declarations,
      constants: {
        productIds: PRODUCT_IDS,
        meterId: AI_CREDITS_METER_ID,
        planEventTypes: api.POLAR_PLAN_EVENT_TYPES,
        legacyMeterId: api.LEGACY_USAGE_METER_ID,
        versionField: PLAN_CACHE_VERSION_FIELD,
        cacheTtl: api.AI_CREDITS_CACHE_TTL_SECONDS,
        schemaVersion: api.AI_CREDITS_CACHE_SCHEMA_VERSION
      },
      counts, total: cases.length
    },
    cases
  };

  const [mode, dir, ...extra] = process.argv.slice(2);
  assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(), 'parent must create the owned output directory');
  const target = path.join(fs.realpathSync(dir), 'polar_billing_events_reference.json');
  const body = JSON.stringify(output, null, 2) + '\n';
  const artifacts = [
    [target, body],
    [path.join(dir, 'polar_billing_events_extracted.ts'), extraction],
    [path.join(dir, 'polar_billing_events_typecheck.ts'), virtualSource],
    [path.join(dir, 'polar_billing_events_compiled.cjs'), transpiled.outputText]
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
