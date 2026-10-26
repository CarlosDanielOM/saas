/**
 * Polar entitlement projection check for the exact API/bot/cron candidate.
 *
 * The real compiled webhook router, journal producer, plan consumer and handler
 * run against disposable MongoDB/Dragonfly. Polar authority is served by the
 * fixture preload (`providers.mjs`), so the installed SDK performs a real HTTP
 * request and validates the complete CustomerState response.
 *
 * Signature transport itself is already covered by
 * dimabot/src/server/routes/webhooks/polarsh.webhook.test.ts. This check sends
 * one genuinely signed customer.state_changed webhook through the real transport
 * and uses an injected verifier only for event shapes whose full SDK payloads
 * are not the subject of this projection check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const express = require('express');
const { Webhook } = require('standardwebhooks');
const { Types } = require('mongoose');

const target = process.env.SAAS_TARGET;
assert.ok(['api', 'bot', 'cron'].includes(target), 'SAAS_TARGET must be api, bot, or cron');
const baseUri = process.env.MONGO_URI;
assert.ok(baseUri, 'MONGO_URI is required');
// In bot/cron mode the packaged entrypoint owns the production-looking database.
// The in-process consumer drain must not race it, so use a check-private DB.
if (target !== 'api') {
    const query = baseUri.indexOf('?');
    const clean = query < 0 ? baseUri : baseUri.slice(0, query);
    process.env.MONGO_URI = `${clean.slice(0, clean.lastIndexOf('/'))}/saas_ops_polar_entitlements_inproc`;
}
// Direct execution must refuse a live-shaped environment. The helper already
// isolates the candidate; these guards keep the checker safe on its own.
assert.equal(process.env.NODE_ENV, 'production', 'refusing non-candidate NODE_ENV');
const verifiedUri = new URL(process.env.MONGO_URI);
assert.equal(verifiedUri.hostname, 'mongo', 'refusing MONGO_URI outside the disposable mongo alias');
assert.match(verifiedUri.pathname, /^\/saas_ops_polar_entitlements_[a-z0-9_]+$/, 'refusing non-disposable Mongo database');
assert.equal(process.env.DRAGONFLY_HOST, 'redis', 'refusing DRAGONFLY_HOST outside the disposable redis alias');
assert.equal(process.env.DRAGONFLY_PORT, '6379', 'refusing a non-disposable Dragonfly port');
assert.equal(process.env.POLARSH_OAT, 'dummy', 'refusing a configured Polar credential');

const fixtureDir = process.env.SAAS_POLAR_FIXTURES || '/tmp/saas-fixtures';
const statePath = `${fixtureDir}/polar-state.json`;
const callsPath = `${fixtureDir}/polar-calls.jsonl`;
const secret = process.env.POLARSH_WEBHOOK_SECRET;
assert.ok(secret, 'POLARSH_WEBHOOK_SECRET is required');

const CUSTOMER_ID = '7a000000-0000-4000-8000-000000000001';
const OTHER_CUSTOMER_ID = '7a000000-0000-4000-8000-000000000002';
const OWNER_ID = '0123456789abcdef01234567';
const CHANNEL_ID = 'polar-entitlements-check-channel';
const CREDIT_PACK_PRODUCT = 'prod_credit_pack_fixture_not_a_plan';
const CREDITS_KEY = `twitch:${CHANNEL_ID}:ai:credits`;
const EXHAUST_KEY = `twitch:${CHANNEL_ID}:ai:exhaust`;
const LEGACY_EXHAUST_KEY = `${CHANNEL_ID}:ai:exhaust`;
const VERSION_KEY = `twitch:${CHANNEL_ID}:ai:credits:polar-version`;
const PLAN_VERSION_KEY = `twitch:${CHANNEL_ID}:ai:credits:plan-version`;
const ACCOUNTS_KEY = 'twitch:accounts';
const ACCOUNT_DATA_KEY = `accounts:twitch:${CHANNEL_ID}:data`;
const PAST = new Date(Date.now() - 30 * 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 86_400_000).toISOString();

const { default: UsersSchema } = await import('/app/dist/schemas/users.schema.js');
const { default: AiUsageReceiptSchema } = await import('/app/dist/schemas/ai_usage_receipt.schema.js');
const { DomainEventSchema } = await import('/app/dist/schemas/domain_event.schema.js');
const { DomainEventDeliverySchema } = await import('/app/dist/schemas/domain_event_delivery.schema.js');
const { DomainEventCheckpointSchema } = await import('/app/dist/schemas/domain_event_checkpoint.schema.js');
const { createPolarWebhookRouter } = await import('/app/dist/server/routes/webhooks/polarsh.webhook.js');
const { dispatchDomainEvents, drainDomainEvents } = await import('/app/dist/utils/domain_event_consumer.js');
const { DOMAIN_EVENT_CONSUMERS } = await import('/app/dist/domain_events/domain_event_consumers.js');
const { applyPolarPlanDomainEvent, applyPolarCreditsDomainEvent } = await import('/app/dist/domain_events/polar_billing_events.js');
const {
    WRITE_PLAN_ACCOUNT_SCRIPT, CHECK_PLAN_ACCOUNTS_SCRIPT, ACCEPT_PLAN_CREDITS_SCRIPT,
} = await import('/app/dist/utils/plan_cache_fence.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const {
    AI_CREDITS_CACHE_SCHEMA_VERSION, AI_CREDITS_METER_ID, AI_CREDIT_LIMITS, getAiCredits,
} = await import('/app/dist/utils/billing.js');
const { PRODUCT_IDS } = await import('/app/dist/utils/referral.js');

const planConsumer = DOMAIN_EVENT_CONSUMERS.find(item => item.consumer === 'polar-plan-v1');
assert.ok(planConsumer, 'polar-plan-v1 consumer must remain registered');

function pause(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function until(fn, label, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
}
function meter(consumed = 30_000, balance = -30_000, credited = 0) {
    return {
        id: 'meter-customer-fixture', created_at: PAST, modified_at: null,
        meter_id: AI_CREDITS_METER_ID, consumed_units: consumed,
        credited_units: credited, balance,
    };
}
function subscription({
    id = 'subscription-premium', productId = PRODUCT_IDS.PREMIUM, status = 'active',
    currentPeriodEnd = FUTURE, endsAt = null, trialEnd = null, cancelAtPeriodEnd = false,
} = {}) {
    return {
        id, created_at: PAST, modified_at: null, metadata: {}, status,
        amount: 1500, currency: 'usd', recurring_interval: 'month',
        current_period_start: PAST, current_period_end: currentPeriodEnd,
        trial_start: status === 'trialing' ? PAST : null, trial_end: trialEnd,
        cancel_at_period_end: cancelAtPeriodEnd, canceled_at: null,
        started_at: PAST, ends_at: endsAt, product_id: productId,
        discount_id: null, meters: [],
    };
}
function wireState({ subscriptions = [], meters = [meter()], grants = [], id = CUSTOMER_ID } = {}) {
    return {
        id, created_at: PAST, modified_at: null, metadata: {}, external_id: null,
        email: 'polar-entitlement-fixture@example.invalid', email_verified: true,
        type: 'individual', name: 'Polar Entitlement Fixture', billing_address: null,
        tax_id: null, organization_id: 'organization-polar-fixture', deleted_at: null,
        active_subscriptions: subscriptions, granted_benefits: grants,
        active_meters: meters, avatar_url: 'https://example.invalid/avatar.png',
    };
}
function setState({ status = 200, state, body } = {}) {
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
        customers: {
            [CUSTOMER_ID]: status === 200 && state ? { status, state } : { status, body: body ?? { detail: 'Polar unavailable' } },
        },
    }));
    fs.renameSync(tmp, statePath);
}
function setEmptyState() {
    setState({ state: wireState({ subscriptions: [], meters: [] }) });
}
function readCalls() {
    try {
        const text = fs.readFileSync(callsPath, 'utf8');
        return text.split('\n').filter(Boolean).flatMap(line => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
    } catch {
        return [];
    }
}
function stateCalls() {
    return readCalls().filter(call => call.customerId === CUSTOMER_ID && call.path?.endsWith('/state'));
}

fs.writeFileSync(callsPath, '');
setEmptyState();

const mongo = await getMongoDBConnection('polar-entitlements-check');
const redis = await getDragonflyClient('polar-entitlements-check');
const pid1 = fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean).join(' ');
const expectedEntry = { api: 'dist/server/index.js', bot: 'dist/bot/index.js', cron: 'dist/workers/cron.index.js' }[target];
assert.ok(pid1.includes(expectedEntry), `expected packaged ${target} entrypoint, got: ${pid1}`);
if (target === 'cron') {
    const childrenPath = '/proc/1/task/1/children';
    await until(() => {
        const pids = fs.readFileSync(childrenPath, 'utf8').trim().split(/\s+/).filter(Boolean);
        return pids.some(pid => {
            try {
                return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/workers/domain_events.worker.js');
            } catch {
                return false;
            }
        });
    }, 'cron supervisor must run the packaged domain-events worker');
}
for (const model of [UsersSchema, AiUsageReceiptSchema, DomainEventSchema, DomainEventDeliverySchema, DomainEventCheckpointSchema]) {
    await model.deleteMany({});
}

let queuedEvent = null;
const app = express();
// Real SDK signature verification and real router assembly.
app.use('/signed/polar/webhook', createPolarWebhookRouter());
// Minimal normalized event for shapes whose SDK wire model is unrelated to the projection.
app.use('/fixture/polar/webhook', createPolarWebhookRouter({
    verify: () => {
        assert.ok(queuedEvent, 'fixture verifier called without a queued event');
        const event = queuedEvent;
        queuedEvent = null;
        return event;
    },
}));
const server = http.createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const fixtureBase = `http://127.0.0.1:${address.port}`;
const apiBase = 'http://127.0.0.1:3000';

let sequence = 0;
const nextId = label => `polar-entitlements-${label}-${++sequence}`;

async function postFixture(type, data, { occurredAt = new Date(), label = type } = {}) {
    // The transport accepts provider event names; the normalizer adds its domain prefix.
    type = type.replace(/^provider\.polar\./, '');
    const webhookId = nextId(label);
    queuedEvent = { type, timestamp: occurredAt, data };
    const response = await fetch(`${fixtureBase}/fixture/polar/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'webhook-id': webhookId },
        body: '{}',
        signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 202, `fixture webhook ${type} must be accepted`);
    return webhookId;
}
async function postSigned(state) {
    const webhookId = nextId('signed-state-changed');
    const body = JSON.stringify({
        type: 'customer.state_changed',
        timestamp: new Date().toISOString(),
        data: state,
    });
    const signer = new Webhook(Buffer.from(secret, 'utf8').toString('base64'));
    const timestamp = new Date();
    const headers = {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'webhook-signature': signer.sign(webhookId, timestamp, body),
    };
    // The real API container owns the transport in api mode; otherwise the
    // in-process router uses the same compiled route and real SDK verifier.
    const url = target === 'api' ? `${apiBase}/polar/webhook` : `${fixtureBase}/signed/polar/webhook`;
    const response = await fetch(url, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 202, `signed ${url} must be accepted`);
    return webhookId;
}

async function drain() {
    await dispatchDomainEvents([planConsumer], 100);
    return drainDomainEvents(planConsumer);
}
async function deliveryFor(webhookId) {
    const event = await DomainEventSchema.findOne({ sourceEventId: webhookId }).lean();
    assert.ok(event, `journal event missing for ${webhookId}`);
    const delivery = await DomainEventDeliverySchema.findOne({
        consumer: 'polar-plan-v1', eventKey: event.eventKey,
    }).lean();
    assert.ok(delivery, `polar-plan-v1 delivery missing for ${event.type}; consumer filter must cover this plan event`);
    return { event, delivery };
}
async function plan() {
    return UsersSchema.findById(OWNER_ID).lean();
}
async function assertPlan(expected, label, untilDate) {
    const owner = await plan();
    assert.equal(owner.plan_tier, expected, label);
    if (untilDate !== undefined) {
        assert.equal(owner.plan_tier_until?.toISOString() ?? null, untilDate, `${label} period end`);
    }
    return owner;
}
async function runFixture(type, data, options) {
    const webhookId = await postFixture(type, data, options);
    const result = await drain();
    const { event, delivery } = await deliveryFor(webhookId);
    assert.equal(delivery.status, 'succeeded', `${type} delivery: ${delivery.lastError || 'no error'}`);
    assert.ok(result.succeeded >= 1, `${type} drain must report a success`);
    return { event, delivery };
}

/** Exact compiled Lua against task-owned scratch keys; the source tests fake eval. */
async function verifyPlanCacheLua(cache) {
    const prefix = `polar-entitlements-check:lua:${process.pid}`;
    const fence = `${prefix}:fence`;
    const account = `${prefix}:account`;
    const accountData = `${prefix}:account-data`;
    const aggregate = `${prefix}:aggregate`;
    const credits = `${prefix}:credits`;
    const exhaust = `${prefix}:exhaust`;
    const legacyExhaust = `${prefix}:legacy-exhaust`;
    const keys = [fence, account, accountData, aggregate, credits, exhaust, legacyExhaust];
    const oldVersion = '0000000000001:old';
    const currentVersion = '0000000000002:current';
    const newerVersion = '0000000000003:newer';
    try {
        await cache.del(keys);
        await cache.set(fence, currentVersion);
        await cache.hSet(account, { id: 'old', name: 'old' });
        await cache.set(accountData, 'old-data');
        const staleWrite = await cache.eval(WRITE_PLAN_ACCOUNT_SCRIPT, {
            keys: [fence, account, accountData],
            arguments: [oldVersion, 'id', 'stale', 'name', 'stale'],
        });
        assert.equal(Number(staleWrite), 0, 'stale bootstrap/hydrate write must be fenced');
        assert.deepEqual({ ...await cache.hGetAll(account) }, { id: 'old', name: 'old' }, 'stale write must not HSET');
        assert.equal(await cache.get(accountData), 'old-data', 'stale write must not delete account data');
        const freshWrite = await cache.eval(WRITE_PLAN_ACCOUNT_SCRIPT, {
            keys: [fence, account, accountData],
            arguments: [currentVersion, '__polar_plan_version', currentVersion, 'id', 'fresh', 'name', 'fresh'],
        });
        assert.equal(Number(freshWrite), 1, 'current bootstrap/hydrate write must be accepted');
        assert.deepEqual({ ...await cache.hGetAll(account) }, {
            __polar_plan_version: currentVersion, id: 'fresh', name: 'fresh',
        });
        assert.equal(await cache.get(accountData), null, 'accepted write must delete stale account data');

        await cache.set(fence, newerVersion);
        await cache.set(aggregate, 'existing');
        const staleAggregate = await cache.eval(CHECK_PLAN_ACCOUNTS_SCRIPT, {
            keys: [fence, aggregate],
            arguments: [currentVersion, 'stale-aggregate'],
        });
        assert.equal(Number(staleAggregate), 0, 'stale aggregate publication/read must be rejected');
        assert.equal(await cache.get(aggregate), 'existing', 'rejected aggregate must not overwrite cache');
        await cache.set(fence, currentVersion);
        const freshAggregate = await cache.eval(CHECK_PLAN_ACCOUNTS_SCRIPT, {
            keys: [fence, aggregate],
            arguments: [currentVersion, 'fresh-aggregate'],
        });
        assert.equal(Number(freshAggregate), 1, 'current aggregate publication/read must be accepted');
        assert.equal(await cache.get(aggregate), 'fresh-aggregate');
        assert.ok((await cache.ttl(aggregate)) > 0, 'accepted aggregate must expire');

        await cache.del([credits, exhaust, legacyExhaust]);
        await cache.set(fence, newerVersion);
        await cache.set(exhaust, 'true');
        await cache.set(legacyExhaust, 'true');
        const staleCredits = await cache.eval(ACCEPT_PLAN_CREDITS_SCRIPT, {
            keys: [credits, exhaust, legacyExhaust, fence],
            arguments: [currentVersion, 'stale-paid-allowance', 'write', '0', '300'],
        });
        assert.equal(Number(staleCredits), 0, 'stale credit fallback write must be fenced');
        assert.equal(await cache.get(credits), null, 'stale credit fallback must not publish an allowance');
        assert.equal(await cache.get(exhaust), 'true', 'stale credit fallback must preserve exhaustion');
        assert.equal(await cache.get(legacyExhaust), 'true', 'stale credit fallback must preserve legacy exhaustion');
        await cache.set(fence, currentVersion);
        const freshCredits = await cache.eval(ACCEPT_PLAN_CREDITS_SCRIPT, {
            keys: [credits, exhaust, legacyExhaust, fence],
            arguments: [currentVersion, 'fresh-free-allowance', 'write', '1', '300'],
        });
        assert.equal(Number(freshCredits), 1, 'current credit write must be accepted');
        assert.equal(await cache.get(credits), 'fresh-free-allowance');
        assert.ok((await cache.ttl(credits)) > 0, 'accepted credit write must expire');
        const exactRead = await cache.eval(ACCEPT_PLAN_CREDITS_SCRIPT, {
            keys: [credits, exhaust, legacyExhaust, fence],
            arguments: [currentVersion, 'fresh-free-allowance', 'read', '1', '300'],
        });
        assert.equal(Number(exactRead), 1, 'exact cached read must be accepted');
        const changedRead = await cache.eval(ACCEPT_PLAN_CREDITS_SCRIPT, {
            keys: [credits, exhaust, legacyExhaust, fence],
            arguments: [currentVersion, 'changed-raw-value', 'read', '1', '300'],
        });
        assert.equal(Number(changedRead), 0, 'changed cached raw value must be rejected');
        await cache.set(fence, newerVersion);
        const fencedRead = await cache.eval(ACCEPT_PLAN_CREDITS_SCRIPT, {
            keys: [credits, exhaust, legacyExhaust, fence],
            arguments: [currentVersion, 'fresh-free-allowance', 'read', '1', '300'],
        });
        assert.equal(Number(fencedRead), 0, 'advanced fence must reject an otherwise exact cached read');
        assert.equal(await cache.get(exhaust), 'true', 'fenced read must preserve exhaustion');
        console.log('PASS compiled plan-cache Lua fences stale writes/reads while accepting current versions');
    } finally {
        await cache.del(keys);
    }
}

await UsersSchema.create({
    _id: OWNER_ID,
    name: 'Polar Entitlements Fixture',
    email: 'polar-owner@example.invalid',
    accounts: [{ type: 'twitch', id: CHANNEL_ID, name: 'polar_owner' }],
    polar_sh_customer_id: CUSTOMER_ID,
    plan_tier: 'premium',
    plan_tier_until: new Date(FUTURE),
    polar_credit_snapshot: {
        occurredAt: new Date(PAST),
        eventKey: 'polar-webhook:snapshot-fixture',
        meters: [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 30_000, credited_units: 0, balance: -30_000 }],
    },
});
const seededSnapshot = JSON.parse(JSON.stringify(
    (await UsersSchema.findById(OWNER_ID).select('+polar_credit_snapshot').lean()).polar_credit_snapshot));
await AiUsageReceiptSchema.create({
    channelID: CHANNEL_ID, customerId: CUSTOMER_ID, entryId: 'usage-fixture-1',
    requestId: null, occurredAt: new Date(), entryKind: 'usage', category: 'ai_chat',
    operation: 'debit', provider: 'fixture', model: 'fixture-model', quantity: 120,
    unit: 'tokens', credits: 17, resourceType: null, resourceId: null, itemized: false,
    retentionTier: 'premium', expiresAt: new Date('2027-12-31T00:00:00.000Z'),
});

async function seedCaches() {
    await redis.del([ACCOUNTS_KEY, ACCOUNT_DATA_KEY, CREDITS_KEY, VERSION_KEY, PLAN_VERSION_KEY, EXHAUST_KEY, LEGACY_EXHAUST_KEY]);
    await redis.set(ACCOUNTS_KEY, '1');
    await redis.set(ACCOUNT_DATA_KEY, JSON.stringify({ plan: 'pro', stale: true }));
    await redis.set(CREDITS_KEY, JSON.stringify({
        version: AI_CREDITS_CACHE_SCHEMA_VERSION, used: 10, limit: AI_CREDIT_LIMITS.pro,
        balance: AI_CREDIT_LIMITS.pro - 10, meterId: AI_CREDITS_METER_ID,
        updatedAt: PAST, available: true, status: 'available',
    }));
    await redis.set(VERSION_KEY, '0000000000001:polar-webhook:credit-fixture');
    await redis.set(EXHAUST_KEY, 'true');
    await redis.set(LEGACY_EXHAUST_KEY, 'true');
}
await seedCaches();

try {
    // 1. Current authority is the customer state, not the webhook product/status.
    setEmptyState();
    await runFixture('subscription.updated', {
        id: 'subscription-premium', customerId: CUSTOMER_ID, status: 'past_due',
        productId: PRODUCT_IDS.PREMIUM, recurringInterval: 'month', currentPeriodEnd: new Date(FUTURE),
    }, { label: 'past-due-premium' });
    await assertPlan('free', 'past_due Premium with no entitlements must project Free', null);
    assert.equal(await redis.get(CREDITS_KEY), null, 'plan projection must invalidate stale computed credits');
    assert.equal(await redis.get(ACCOUNTS_KEY), null, 'plan projection must invalidate the accounts cache');
    assert.equal(await redis.get(ACCOUNT_DATA_KEY), null, 'plan projection must invalidate account data cache');
    assert.ok(await redis.get(PLAN_VERSION_KEY), 'plan projection must publish the persistent plan fence');
    assert.equal(await redis.get(VERSION_KEY), '0000000000001:polar-webhook:credit-fixture', 'polar credit version marker must be preserved');
    assert.equal(await redis.get(EXHAUST_KEY), 'true', 'credit exhaust marker must be preserved');
    assert.equal(await redis.get(LEGACY_EXHAUST_KEY), 'true', 'legacy exhaust marker must be preserved');
    console.log('PASS past_due Premium without entitlements projects Free, invalidates computed credits/account caches, and preserves credit markers');

    // 2. Real signed transport for a current active Premium subscription.
    await seedCaches();
    setState({ state: wireState({ subscriptions: [subscription()] }) });
    const signedId = await postSigned(wireState({ subscriptions: [subscription()] }));
    await drain();
    const signed = await deliveryFor(signedId);
    assert.equal(signed.delivery.status, 'succeeded', `signed delivery: ${signed.delivery.lastError || 'no error'}`);
    await assertPlan('premium', 'signed active Premium projection', FUTURE);
    console.log('PASS signed customer.state_changed grants Premium from the current active subscription');

    const lookupsBeforeUnchangedState = readCalls().length;
    const unchangedId = await postSigned(wireState({ subscriptions: [subscription()] }));
    await drain();
    assert.equal((await deliveryFor(unchangedId)).delivery.status, 'succeeded');
    assert.equal(readCalls().length, lookupsBeforeUnchangedState,
        'unchanged signed entitlement contents must skip redundant provider reads');
    console.log('PASS unchanged signed entitlement contents skip provider lookup');

    // 3. Benefit revocation never relies on the revoked event's retained product.
    setEmptyState();
    await runFixture('benefit_grant.revoked', { id: 'grant-fixture-1', customerId: CUSTOMER_ID }, { label: 'benefit-revoked' });
    await assertPlan('free', 'benefit revocation must clear Premium', null);

    // 4. Recovery after revocation is driven by a new active state, not the old grant.
    setState({ state: wireState({ subscriptions: [subscription()] }) });
    await runFixture('subscription.updated', {
        id: 'subscription-premium', customerId: CUSTOMER_ID, status: 'active',
        productId: PRODUCT_IDS.PREMIUM, recurringInterval: 'month', currentPeriodEnd: new Date(FUTURE),
    }, { label: 'recovery' });
    await assertPlan('premium', 'recovery after revoke must restore Premium');
    console.log('PASS benefit revocation clears Premium and a later active state recovers it');

    // 5. Scheduled cancellation keeps access through the paid period.
    setState({ state: wireState({ subscriptions: [subscription({ cancelAtPeriodEnd: true })] }) });
    await runFixture('provider.polar.subscription.canceled', { id: 'subscription-premium', customerId: CUSTOMER_ID }, { label: 'scheduled-cancel' });
    await assertPlan('premium', 'scheduled cancellation retains active access', FUTURE);

    // 6. Trialing Pro and multiple subscriptions choose the strongest live tier.
    setState({ state: wireState({ subscriptions: [subscription({ id: 'subscription-pro', productId: PRODUCT_IDS.PRO, status: 'trialing', trialEnd: FUTURE })] }) });
    await runFixture('provider.polar.subscription.active', { id: 'subscription-pro', customerId: CUSTOMER_ID }, { label: 'trialing-pro' });
    await assertPlan('pro', 'trialing Pro projects Pro', FUTURE);

    setState({ state: wireState({ subscriptions: [subscription(), subscription({ id: 'subscription-pro', productId: PRODUCT_IDS.PRO })] }) });
    await runFixture('subscription.updated', {
        id: 'subscription-premium', customerId: CUSTOMER_ID, status: 'active',
        productId: PRODUCT_IDS.PREMIUM, recurringInterval: 'month', currentPeriodEnd: new Date(FUTURE),
    }, { label: 'multiple-subscriptions' });
    await assertPlan('pro', 'multiple subscriptions must choose Pro');
    console.log('PASS scheduled cancellation, trialing Pro, and strongest-tier selection use current entitlements');

    // 7. customer.state_changed payload cannot restore a stale paid entitlement.
    setEmptyState();
    await runFixture('customer.state_changed', {
        id: CUSTOMER_ID,
        activeMeters: [{ meterId: AI_CREDITS_METER_ID, consumedUnits: 0, creditedUnits: 0, balance: 0 }],
        activeSubscriptions: [{ id: 'stale-premium', productId: PRODUCT_IDS.PREMIUM, status: 'active', currentPeriodEnd: new Date(FUTURE) }],
        grantedBenefits: [],
    }, { label: 'stale-state-payload' });
    await assertPlan('free', 'stale state payload must not restore Premium', null);
    console.log('PASS customer.state_changed ignores stale payload entitlements and reads fresh authority');

    // 8. An older webhook cannot regrant from its own product.
    await runFixture('order.paid', {
        id: 'order-old-premium', customerId: CUSTOMER_ID, status: 'paid', paid: true,
        totalAmount: 1500, productId: PRODUCT_IDS.PREMIUM, subscriptionId: 'subscription-premium',
        subscription: { id: 'subscription-premium', recurringInterval: 'month', currentPeriodEnd: new Date(FUTURE) },
    }, { occurredAt: new Date('2020-01-01T00:00:00Z'), label: 'old-order-paid' });
    const afterOld = await assertPlan('free', 'older order.paid must not regrant from its product', null);
    assert.ok(afterOld.polar_plan_event_at && Date.now() - new Date(afterOld.polar_plan_event_at).getTime() < 120_000,
        'projection version must be the fresh lookup time, not the old event time');
    console.log('PASS older order.paid product cannot regrant access without a current entitlement');

    // 9. Unrelated credit pack purchases do not downgrade the plan or call Polar state.
    setState({ state: wireState({ subscriptions: [subscription({ id: 'subscription-pro', productId: PRODUCT_IDS.PRO })] }) });
    await runFixture('subscription.updated', {
        id: 'subscription-pro', customerId: CUSTOMER_ID, status: 'active',
        productId: PRODUCT_IDS.PRO, recurringInterval: 'month', currentPeriodEnd: new Date(FUTURE),
    }, { label: 'pro-before-credit-pack' });
    await assertPlan('pro', 'Pro before credit pack');
    const callsBeforePack = stateCalls().length;
    await runFixture('order.paid', {
        id: 'order-credit-pack', customerId: CUSTOMER_ID, status: 'paid', paid: true,
        totalAmount: 500, productId: CREDIT_PACK_PRODUCT, subscriptionId: undefined,
    }, { label: 'credit-pack-order' });
    await assertPlan('pro', 'unrelated credit pack must not downgrade Pro');
    assert.equal(stateCalls().length, callsBeforePack, 'credit pack order must not read entitlement authority');
    console.log('PASS unrelated credit pack keeps Pro and skips entitlement lookup');

    // 10. Polar failure preserves the prior plan and retries the durable delivery.
    setState({ status: 503 });
    const failingId = await postFixture('provider.polar.subscription.past_due', {
        id: 'subscription-pro', customerId: CUSTOMER_ID,
    }, { label: 'polar-error' });
    await drain();
    const failing = await deliveryFor(failingId);
    assert.equal(failing.delivery.status, 'retry', 'Polar failure must schedule a retry');
    assert.match(failing.delivery.lastError, /503|Polar API error|Polar/i);
    await assertPlan('pro', 'Polar failure must preserve the prior plan');
    setState({ state: wireState({ subscriptions: [subscription()] }) });
    await until(async () => {
        const { delivery } = await deliveryFor(failingId);
        if (delivery.status === 'succeeded') return true;
        await drain();
        return false;
    }, 'durable retry after Polar recovery', 30_000);
    await assertPlan('premium', 'retry after Polar recovery must apply fresh authority');
    console.log('PASS Polar failure preserves the plan and the durable retry applies recovered authority');

    // 11. Plan downgrade invalidates only computed allowance, not provider/ledger facts.
    await seedCaches();
    setState({ state: wireState({ subscriptions: [], meters: [meter(30_000, -30_000)] }) });
    await runFixture('provider.polar.subscription.revoked', { id: 'subscription-premium', customerId: CUSTOMER_ID }, { label: 'cache-downgrade' });
    await assertPlan('free', 'downgrade to Free');
    assert.equal(await redis.get(CREDITS_KEY), null, 'stale paid computed credits must be removed on downgrade');
    assert.equal(await redis.get(VERSION_KEY), '0000000000001:polar-webhook:credit-fixture');
    assert.equal(await redis.get(EXHAUST_KEY), 'true');
    assert.equal(await redis.get(LEGACY_EXHAUST_KEY), 'true');
    const snapshot = (await UsersSchema.findById(OWNER_ID).select('+polar_credit_snapshot').lean()).polar_credit_snapshot;
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), seededSnapshot, 'provider meter snapshot must remain unchanged');
    const receipt = await AiUsageReceiptSchema.findOne({ entryId: 'usage-fixture-1' }).lean();
    assert.ok(receipt, 'usage receipt must remain');
    assert.equal(receipt.credits, 17, 'usage ledger credits must remain unchanged');
    const owner = await plan();
    assert.equal(owner.plan_tier, 'free');
    const credits = await getAiCredits(owner, CHANNEL_ID, { requireVerified: true });
    assert.equal(credits.limit, AI_CREDIT_LIMITS.free, 'recomputed allowance must be the Free limit');
    assert.equal(credits.status, 'exhausted', 'recomputed Free allowance must be exhausted by provider usage');
    console.log('PASS downgrade removes stale paid allowance, recomputes Free exhausted, and preserves provider/usage facts');

    // 12. Deterministic cross-consumer fence: a credits projection that read the
    // old Premium plan must not refill paid allowance after the plan projection
    // publishes the newer Free version.
    await seedCaches();
    await UsersSchema.updateOne({ _id: OWNER_ID }, {
        $set: {
            plan_tier: 'premium', plan_tier_until: new Date(FUTURE),
            polar_plan_event_at: new Date(PAST), polar_plan_event_key: 'polar-webhook:premium-before-race',
        },
    });
    const stalePremium = await UsersSchema.findById(OWNER_ID).select('+polar_credit_snapshot').lean();
    assert.equal(stalePremium.plan_tier, 'premium');
    assert.ok(stalePremium.polar_credit_snapshot);
    const oldMeters = [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 30_000, credited_units: 0, balance: -30_000 }];
    stalePremium.polar_credit_snapshot = {
        occurredAt: new Date(PAST), eventKey: 'polar-webhook:premium-before-race', meters: oldMeters,
    };
    const oldEvent = type => ({
        _id: new Types.ObjectId(), eventKey: `polar-webhook:race-${type}:premium-before-race`,
        source: 'polar-webhook', sourceEventId: `race-${type}`, type, topic: 'domain', schemaVersion: 1,
        ownerUserId: OWNER_ID, subject: { provider: 'polar', kind: 'customer', id: CUSTOMER_ID },
        occurredAt: new Date(PAST), journaledAt: new Date(PAST), expiresAt: new Date(FUTURE),
        metadata: {}, payload: {},
    });
    let releaseCredits;
    const creditGate = new Promise(resolve => { releaseCredits = resolve; });
    let released = false;
    const resumeCredits = () => { if (!released) { released = true; releaseCredits(); } };
    const originalFindOneAndUpdate = UsersSchema.findOneAndUpdate;
    UsersSchema.findOneAndUpdate = function intercepted(filter, update, options) {
        if (String(filter?._id) === OWNER_ID && update?.$set?.polar_credit_snapshot) {
            return { select: () => ({ lean: async () => { await creditGate; return stalePremium; } }) };
        }
        return originalFindOneAndUpdate.call(this, filter, update, options);
    };
    try {
        const creditsEvent = oldEvent('billing.customer.state.changed');
        creditsEvent.payload = {
            customerId: CUSTOMER_ID,
            meters: [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 0, credited_units: 0, balance: AI_CREDIT_LIMITS.premium }],
        };
        const creditsPromise = applyPolarCreditsDomainEvent(creditsEvent, {
            getOwner: async () => stalePremium,
        });
        // Plan projection to Free runs while the credits projection is paused on
        // its stale Premium read and publishes the newer plan version fence.
        setState({ state: wireState({ subscriptions: [], meters: [] }) });
        await applyPolarPlanDomainEvent(oldEvent('provider.polar.subscription.revoked'));
        resumeCredits();
        await creditsPromise;
    } finally {
        UsersSchema.findOneAndUpdate = originalFindOneAndUpdate;
        resumeCredits();
    }
    const racedCreditsRaw = await redis.get(CREDITS_KEY);
    if (racedCreditsRaw) {
        const raced = JSON.parse(racedCreditsRaw);
        assert.notEqual(raced.limit, AI_CREDIT_LIMITS.premium, 'stale credits projection must not refill the paid allowance');
        assert.equal(raced.limit, AI_CREDIT_LIMITS.free, 'a fenced recompute may only publish the Free allowance');
        assert.equal(raced.status, 'exhausted', 'fenced recompute must keep the newer exhaustion');
    }
    assert.equal(await redis.get(EXHAUST_KEY), 'true', 'stale credits projection must not clear newer exhaustion');
    assert.equal(await redis.get(LEGACY_EXHAUST_KEY), 'true', 'stale credits projection must not clear the legacy exhaustion marker');
    assert.equal(await redis.get(VERSION_KEY), '0000000000001:polar-webhook:credit-fixture', 'stale credits projection must not overwrite polar-version');
    assert.equal((await plan()).plan_tier, 'free');
    console.log('PASS cross-consumer plan fence rejects a stale Premium credits projection and preserves exhaustion/version');

    // Reject an unknown customer rather than silently projecting it.
    setState({ state: wireState({ subscriptions: [subscription()], id: OTHER_CUSTOMER_ID }) });
    const mismatchId = await postFixture('provider.polar.subscription.active', { id: 'subscription-premium', customerId: CUSTOMER_ID }, { label: 'customer-mismatch' });
    await drain();
    const mismatch = await deliveryFor(mismatchId);
    assert.equal(mismatch.delivery.status, 'retry', 'customer-state mismatch must fail closed');
    await assertPlan('free', 'customer-state mismatch must not change the plan');
    console.log('PASS mismatched customer state fails closed without changing the plan');

    await verifyPlanCacheLua(redis);

    assert.equal(await UsersSchema.countDocuments({ _id: OWNER_ID }), 1);
    assert.ok((await DomainEventDeliverySchema.countDocuments({ consumer: 'polar-plan-v1' })) >= 11);
    console.log(`PASS ${target}: Polar plan entitlements from current customer state, cache invalidation, retries, and credit preservation`);
} finally {
    server.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await redis.del([ACCOUNTS_KEY, ACCOUNT_DATA_KEY, CREDITS_KEY, VERSION_KEY, PLAN_VERSION_KEY, EXHAUST_KEY, LEGACY_EXHAUST_KEY]);
    for (const model of [UsersSchema, AiUsageReceiptSchema, DomainEventSchema, DomainEventDeliverySchema, DomainEventCheckpointSchema]) {
        await model.deleteMany({});
    }
    await redis.quit();
    await mongo.disconnect();
}
process.exit(0);
