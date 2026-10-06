// Standalone experiment: no application bootstrap, .env loading, or real transport.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const app = path.join(repo, 'dimabot');
const require = createRequire(path.join(app, 'package.json'));
const ts = require('typescript');
const sdkEntry = require.resolve('@polar-sh/sdk');
const { Polar } = await import(pathToFileURL(sdkEntry));
const sdkDirectory = path.dirname(sdkEntry);
const { HTTPClient } = await import(pathToFileURL(path.join(sdkDirectory, '../esm/lib/http.js')));
const output = process.argv[2];
assert.ok(output, 'Usage: node --experimental-vm-modules application.mjs /tmp/results.json');
assert.ok(process.permission && !process.permission.has('net'), 'Run with Node --permission and without --allow-net');

// Capture the SDK's actual serialized requests, without sending them anywhere.
const requests = [];
const transport = new HTTPClient({ fetcher: async request => {
  requests.push({ url: request.url, body: JSON.parse(await request.text()) });
  return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
} });
const clientOptions = [];
const restRequests = [];
let creditProducts = [];
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
class CapturingPolar {
  constructor(options) {
    clientOptions.push({ ...options, accessToken: '<dummy>' });
    this.events = new Polar({ ...options, httpClient: transport }).events;
  }
}
const context = vm.createContext({
  process: { env: { POLARSH_OAT: 'sandbox-dummy', POLARSH_ENVIRONMENT: 'sandbox' } },
  setTimeout, clearTimeout, console: { log() {}, error() {} },
  URL, URLSearchParams,
  fetch: async (url, options = {}) => {
    assert.equal(new URL(url).origin, 'https://sandbox-api.polar.sh');
    restRequests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/products/') return json({ items: creditProducts });
    if (pathname === '/v1/subscriptions/') return json({ items: [] });
    if (pathname === '/v1/checkouts/') return json({ id: 'fixture-checkout', url: 'https://sandbox.polar.sh/checkout/fixture' });
    throw new Error(`Unstubbed REST path blocked: ${pathname}`);
  },
});
const noop = () => {};
const stubs = {
  '@polar-sh/sdk': { Polar: CapturingPolar },
  'node:crypto': { randomUUID, createHash },
  './databases/dragonfly.database.js': { getDragonflyClient: async () => ({ get: async () => null, set: async () => {} }) },
  './referral.js': { PRODUCT_IDS: { PREMIUM: 'fixture-premium', PRO: 'fixture-pro' } },
  './logger.js': { error: async () => {}, info: noop },
  './billing.js': { recordAiCreditUsage: async () => {} },
  './posthog_events.js': { trackAiUsageRecorded: noop },
  './ai_usage_ledger.js': { buildQueuedAiUsageReceipt: noop, enqueueAiUsageReceipt: async () => {} },
};
const sourceHashes = {};
function sourceModule(relative) {
  const source = readFileSync(path.join(app, relative), 'utf8');
  sourceHashes[relative] = createHash('sha256').update(source).digest('hex');
  const transpiled = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  assert.equal(transpiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return new vm.SourceTextModule(transpiled.outputText, { context, identifier: relative });
}
const usageModule = sourceModule('src/utils/ai_usage_event.ts');
const grantModule = sourceModule('src/utils/polarsh.ts');
const packModule = sourceModule('src/utils/credit_packs.ts');
const billingModule = sourceModule('src/utils/billing.ts');
const linker = async specifier => {
  if (specifier === './ai_usage_event.js') return usageModule;
  if (specifier === './credit_packs.js') return packModule;
  const exports = stubs[specifier];
  assert.ok(exports, `Unstubbed import blocked: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
};
await usageModule.link(linker);
await usageModule.evaluate();
await grantModule.link(linker);
await grantModule.evaluate();
await packModule.link(linker);
await packModule.evaluate();
await billingModule.link(linker);
await billingModule.evaluate();

const tests = [];
async function check(name, fn) {
  const evidence = await fn();
  tests.push({ name, status: 'passed', ...(evidence ? { evidence } : {}) });
  console.log(`PASS ${name}`);
}
const customerId = '11111111-1111-4111-8111-111111111111';
const { grantPolarAiCredits } = grantModule.namespace;
await check('Actual admin helper sends negative usage, not a rollover benefit grant', async () => {
  const result = await grantPolarAiCredits({
    customerId, credits: 40000, reason: 'sandbox_gift_probe',
    externalId: 'sandbox-gift-order-1', source: 'gift_experiment',
  });
  assert.equal(result.error, false, JSON.stringify(result));
  const event = requests.at(-1).body.events[0];
  assert.equal(event.name, 'ai_usage');
  assert.equal(event.metadata.credits, -40000);
  assert.equal(event.metadata.rollover, undefined);
  assert.equal(event.customer_id, customerId);
  return { eventName: event.name, usageCredits: event.metadata.credits, rolloverField: false };
});
await check('POLARSH_ENVIRONMENT=sandbox does not switch the existing SDK helper', async () => {
  assert.equal(clientOptions[0].server, undefined);
  assert.equal(new URL(requests[0].url).origin, 'https://api.polar.sh');
  return { capturedOrigin: new URL(requests[0].url).origin, networkRequestsSent: 0 };
});
await check('Explicit SDK server=sandbox selects the sandbox endpoint', async () => {
  const client = new Polar({ accessToken: 'sandbox-dummy', server: 'sandbox', httpClient: transport });
  await client.events.ingest({ events: [{ name: 'ai_usage', customerId, externalId: 'explicit-sandbox', metadata: { credits: -40000 } }] });
  assert.equal(new URL(requests.at(-1).url).origin, 'https://sandbox-api.polar.sh');
  return { capturedOrigin: new URL(requests.at(-1).url).origin, networkRequestsSent: 0 };
});
await check('Retries preserve the recipient and caller-provided external ID', async () => {
  for (let i = 0; i < 2; i++) {
    assert.equal((await grantPolarAiCredits({ customerId, credits: 40000, reason: 'sandbox_gift_probe', externalId: 'sandbox-gift-order-1' })).error, false);
    const event = requests.at(-1).body.events[0];
    assert.equal(event.external_id, 'sandbox-gift-order-1');
    assert.equal(event.customer_id, customerId);
  }
  return { externalId: 'sandbox-gift-order-1', providerDeduplicationTested: false };
});
await check('Invalid grants do not call the SDK transport', async () => {
  const before = requests.length;
  for (const credits of [0, -1, Number.NaN]) {
    assert.equal((await grantPolarAiCredits({ customerId, credits, reason: 'invalid' })).error, true);
  }
  assert.equal((await grantPolarAiCredits({ customerId: '', credits: 40000, reason: 'invalid' })).error, true);
  assert.equal(requests.length, before);
});
await check('Free accounts are eligible for all three existing rollover pack definitions', async () => {
  const { CREDIT_PACK_DEFINITIONS, buildCreditPackOffers } = packModule.namespace;
  const products = Array.from(CREDIT_PACK_DEFINITIONS, pack => ({
    id: pack.id, name: pack.size,
    prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 100, price_currency: 'usd' }],
    benefits: [{ type: 'meter_credit', properties: { units: 40000, meter_id: 'test-meter', rollover: pack.kind === 'credits' } }],
  }));
  const offers = buildCreditPackOffers(products, 'test-meter', false);
  const permanent = Array.from(offers).filter(p => p.kind === 'credits');
  assert.equal(permanent.length, 3);
  assert.ok(permanent.every(p => p.eligible && p.rollover));
  assert.ok(Array.from(offers).filter(p => p.kind === 'recharge').every(p => !p.eligible));
  return { pricesAndUnitsAreFixtures: true };
});
creditProducts = Array.from(packModule.namespace.CREDIT_PACK_DEFINITIONS, pack => ({
  id: pack.id, name: pack.size,
  prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 100, price_currency: 'usd' }],
  benefits: [{ type: 'meter_credit', properties: { units: 40000, meter_id: billingModule.namespace.AI_CREDITS_METER_ID, rollover: pack.kind === 'credits' } }],
}));
const buyer = { _id: { toString: () => 'fixture-buyer' }, name: 'Buyer', email: 'buyer@example.invalid', polar_sh_customer_id: customerId };
const recipient = { _id: { toString: () => 'fixture-recipient' }, name: 'Recipient', email: 'recipient@example.invalid', polar_sh_customer_id: '22222222-2222-4222-8222-222222222222' };
const productId = creditProducts[0].id;
await check('Current checkout ignores an extra recipient field and keeps the buyer as customer', async () => {
  await billingModule.namespace.createCreditPackCheckout({ user: buyer, productId, recipientUserId: 'fixture-recipient' });
  const checkout = restRequests.at(-1).body;
  assert.equal(checkout.customer_id, buyer.polar_sh_customer_id);
  assert.equal(checkout.external_customer_id, 'fixture-buyer');
  assert.equal(checkout.metadata.user_id, 'fixture-buyer');
  assert.equal(checkout.metadata.recipientUserId, undefined);
  return { checkoutCustomer: 'buyer', separateRecipientSupported: false };
});
await check('Swapping checkout user to the recipient also swaps customer email and order identity', async () => {
  await billingModule.namespace.createCreditPackCheckout({ user: recipient, productId });
  const checkout = restRequests.at(-1).body;
  assert.equal(checkout.customer_id, recipient.polar_sh_customer_id);
  assert.equal(checkout.external_customer_id, 'fixture-recipient');
  assert.equal(checkout.customer_email, recipient.email);
  return { checkoutCustomer: 'recipient', customerEmail: 'recipient@example.invalid' };
});
await check('Existing REST checkout honors sandbox mode, unlike the shared SDK helper', async () => {
  assert.ok(restRequests.every(r => new URL(r.url).origin === 'https://sandbox-api.polar.sh'));
  return { capturedOrigin: 'https://sandbox-api.polar.sh', networkRequestsSent: 0 };
});

writeFileSync(output, JSON.stringify({
  mode: 'local_application_and_sdk',
  node: process.version,
  sdkVersion: require('@polar-sh/sdk/package.json').version,
  sourceHashes, tests,
  isolation: { nodeNetworkPermission: false, realNetworkRequests: 0, productionEnvLoaded: false, applicationBootstrap: false },
  limitations: ['Provider responses are fixtures; external deduplication and payment behavior are not tested.'],
}, null, 2) + '\n');
