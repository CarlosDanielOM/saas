// Shared Bits rules (saas-ops only: disposable Mongo/Redis, fixture identities, mocked Twitch chat via bits-text-fixtures).
// - Unit suites: rule matching/validation/legacy conversion, cheer handler, durable chat announcements.
// - api target: /bits-rules HTTP API (auth, view-only admins, validation, legacy tiers fallback + first-save copy,
//   concurrent saves without lost updates, 50-rule cap, looks count from Overlay Studio).
// - every target: the immediate cheer handler and the durable chat consumer read the stored shared rules
//   (most specific wins, silent rules, default mode, disabled rules, alert-only rules).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';
import { BitsRulesModel } from '/app/dist/bits_rules/store.js';
import { applyChatAnnouncementDomainEvent } from '/app/dist/domain_events/chat_announcement_events.js';
import { cheerHandler } from '/app/dist/handlers/cheer.handler.js';

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
    '/app/dist/bits_rules/model.test.js', '/app/dist/handlers/cheer.handler.test.js',
    '/app/dist/domain_events/chat_announcement_events.test.js'], { stdio: 'inherit', timeout: 60000 });

const target = process.env.SAAS_TARGET;
assert.ok(['api', 'bot', 'cron'].includes(target));
await getMongoDBConnection('BitsRulesCheck');
const redis = await getDragonflyClient('BitsRulesCheck');
const chat = () => (fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.chat);

const owner = '99007701', viewer = '99007702', manager = '99007703', stranger = '99007704', legacy = '99007705';
for (const id of [owner, viewer, manager, stranger, legacy]) {
    await UsersSchema.create({ name: `Fixture ${id}`, accounts: [{ type: 'twitch', id, name: `fixture${id}`, actived: true, has_permissions: true, chat_enabled: true }] });
    await redis.hSet(`token:rules-${id}`, { id, login: `fixture${id}`, display_name: `Fixture${id}` });
    await redis.hSet(`accounts:twitch:${id}:data`, { id, name: `fixture${id}`, plan_tier: 'free', chat_enabled: 'true', actived: 'true', has_permissions: 'true' });
}
await redis.set('app:twitch:token', 'app-token');
await AdminSchema.create({ channelID: owner, adminID: viewer, actived: true, permissions: ['eventsubs:view'] });
await AdminSchema.create({ channelID: owner, adminID: manager, actived: true, permissions: ['eventsubs:manage'] });
const eventsub = (channelID, extra) => EventsubSchema.create({ channelID, type: 'channel.bits.use', enabled: true, id: `bits-${channelID}`, status: 'enabled',
    version: '1', channel: `fixture${channelID}`, cost: 0, condition: { broadcaster_user_id: channelID }, created_at: new Date().toISOString(),
    transport: { method: 'webhook', callback: 'https://fixture.test/eventsub' }, message: 'Default thanks $(user)', ...extra });
await eventsub(owner, { cheerTiers: [] });
// Tiers saved by the old editor: one camelCase (never matched before), one snake_case with an empty message.
await eventsub(legacy, { cheerTiers: [
    { id: 'tier-nice', name: 'Nice', message: 'Nice one $(user)', minAmount: 69, maxAmount: 69 },
    { id: 'tier-quiet', name: 'Quiet', message: '', min_amount: 1, max_amount: 10 }] });

if (target === 'api') {
    const call = async (method, path, body, token = owner) => {
        const response = await fetch('http://127.0.0.1:3000/bits-rules/' + path, { method,
            headers: { ...(token ? { Authorization: `Bearer rules-${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await response.text();
        try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: { raw: text.slice(0, 300) } }; }
    };
    const expect = async (status, ...args) => { const r = await call(...args); assert.equal(r.status, status, `${args[0]} ${args[1]}: ${JSON.stringify(r.body)}`); return r.body.data; };
    const rule = (min, max, extra = {}) => ({ name: '', min, max, chat: { mode: 'default', message: '' }, alert: true, ...extra });

    // Access.
    assert.equal((await call('GET', owner, undefined, null)).status, 401);
    await expect(403, 'GET', owner, undefined, stranger);
    const asViewer = await expect(200, 'GET', owner, undefined, viewer);
    assert.equal(asViewer.canManage, false);
    await expect(403, 'POST', owner + '/rules', rule(100, null), viewer);
    let view = await expect(200, 'GET', owner);
    assert.deepEqual({ revision: view.revision, rules: view.rules, maxRules: view.maxRules, canManage: view.canManage, chat: view.chat, looks: view.looks },
        { revision: 0, rules: [], maxRules: 50, canManage: true, chat: { subscribed: true, enabled: true, defaultMessage: 'Default thanks $(user)' }, looks: {} });

    // Create / validate / update / delete.
    view = await expect(201, 'POST', owner + '/rules', rule(1000, null, { name: ' Big ' }));
    const big = view.created; assert.match(big, /^rule-[a-f0-9]{12}$/);
    assert.deepEqual(view.rules, [{ id: big, name: 'Big', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true }]);
    for (const bad of [rule(0, null), rule(10, 5), rule(1.5, null), rule(10, null, { chat: { mode: 'custom', message: '  ' } }), rule(10, null, { chat: { mode: 'loud', message: '' } }),
        rule(10, null, { name: 'x'.repeat(61) }), rule(10, null, { extra: true }), rule(10, null, { enabled: 'yes' }), rule(2000000, null), 'nope']) {
        await expect(400, 'POST', owner + '/rules', bad);
    }
    view = await expect(201, 'POST', owner + '/rules', rule(69, 69, { name: 'Nice', chat: { mode: 'custom', message: 'Nice $(user)' } }));
    const nice = view.created;
    view = await expect(201, 'POST', owner + '/rules', rule(2, 9, { chat: { mode: 'silent', message: '' }, alert: false }));
    const quiet = view.created;
    view = await expect(201, 'POST', owner + '/rules', rule(500, 500, { chat: { mode: 'custom', message: 'Alert only' } }));
    const off = view.created;
    view = await expect(200, 'PATCH', `${owner}/rules/${off}`, { enabled: false }, manager);
    assert.equal(view.rules.find(r => r.id === off).enabled, false);
    assert.equal(view.rules.find(r => r.id === off).chat.message, 'Alert only', 'partial update keeps the rest');
    await expect(400, 'PATCH', `${owner}/rules/${off}`, { max: 1 });
    await expect(404, 'PATCH', `${owner}/rules/rule-missing`, { enabled: true });
    const temp = (await expect(201, 'POST', owner + '/rules', rule(5, 5))).created;
    await expect(200, 'DELETE', `${owner}/rules/${temp}`);
    await expect(404, 'DELETE', `${owner}/rules/${temp}`);
    assert.equal((await BitsRulesModel.findById(owner).lean()).updatedBy, owner);

    // Parallel saves from two pages never lose a rule.
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', owner + '/rules', rule(10000 + i, 10000 + i))));
    assert.ok(results.every(r => [201, 409].includes(r.status)), JSON.stringify(results.map(r => r.status)));
    const createdCount = results.filter(r => r.status === 201).length;
    assert.ok(createdCount >= 1);
    view = await expect(200, 'GET', owner);
    assert.equal(view.rules.length, 4 + createdCount, 'no lost updates');
    assert.equal(view.revision, (await BitsRulesModel.findById(owner).lean()).revision);
    for (const r of view.rules.filter(r => r.min >= 10000)) await expect(200, 'DELETE', `${owner}/rules/${r.id}`);

    // Legacy tiers are read as rules (the camelCase tier too); the first change copies them for good.
    view = await expect(200, 'GET', legacy, undefined, legacy);
    assert.equal(view.revision, 0);
    assert.deepEqual(view.rules.map(r => [r.id, r.min, r.max, r.chat.mode]), [['tier-nice', 69, 69, 'custom'], ['tier-quiet', 1, 10, 'silent']]);
    view = await expect(200, 'PATCH', `${legacy}/rules/tier-quiet`, { name: 'Shh' }, legacy);
    assert.equal(view.revision, 1); assert.deepEqual(view.rules.map(r => r.name), ['Nice', 'Shh']);
    assert.equal((await BitsRulesModel.findById(legacy).lean()).rules.length, 2);

    // Cap of 50 rules.
    const cap = '99007706';
    await UsersSchema.create({ name: 'Cap', accounts: [{ type: 'twitch', id: cap, name: 'cap' }] });
    await redis.hSet(`token:rules-${cap}`, { id: cap, login: 'cap', display_name: 'Cap' });
    await BitsRulesModel.create({ _id: cap, revision: 1, updatedAt: new Date(), rules: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, ...rule(i + 1, i + 1) })) });
    const full = await call('POST', cap + '/rules', rule(999, 999), cap);
    assert.equal(full.status, 409); assert.match(full.body.message, /up to 50/);

    // Looks count comes from Overlay Studio designs.
    const { Studio } = await import('/app/dist/overlays/store.js');
    await Studio.collection.insertOne({ _id: owner, schemaVersion: 1, revision: 1, scenes: [], designs: [
        { id: 'a', variants: { bits: [{ id: 'l1', ruleId: big }, { id: 'l2', ruleId: nice }] } }, { id: 'b', variants: { bits: [{ id: 'l3', ruleId: big }] } }] });
    assert.deepEqual((await expect(200, 'GET', owner)).looks, { [big]: 2, [nice]: 1 });
    console.log('PASS api: access (401/403/view-only), validation, create/update/delete, partial updates, legacy fallback + copy, concurrent saves, 50 cap, looks');
} else {
    await BitsRulesModel.create({ _id: owner, revision: 1, updatedAt: new Date(), rules: [
        { id: 'big', name: 'Big', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true },
        { id: 'nice', name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'Nice $(user)' }, alert: true },
        { id: 'quiet', name: '', enabled: true, min: 2, max: 9, chat: { mode: 'silent', message: '' }, alert: false },
        { id: 'off', name: '', enabled: false, min: 500, max: 500, chat: { mode: 'custom', message: 'Alert only' }, alert: true }] });
}

// Both chat paths read the stored shared rules (they win over the old tiers on the eventsub).
await EventsubSchema.updateOne({ channelID: owner }, { $set: { cheerTiers: [{ name: 'stale', message: 'stale tier', min_amount: 1, max_amount: 100000 }] } });
const config = await EventsubSchema.findOne({ channelID: owner });
const event = (bits, channelID = owner) => ({ broadcaster_user_id: channelID, broadcaster_user_login: `fixture${channelID}`, broadcaster_user_name: 'Fixture',
    user_id: '99007799', user_login: 'viewer', user_name: 'Viewer', bits, type: 'cheer', is_anonymous: false, message: { text: 'hi', fragments: [] } });
const expected = [[69, 'Nice Viewer'], [5, null], [500, 'Default thanks Viewer'], [1500, 'Default thanks Viewer'], [70, 'Default thanks Viewer']];
for (const [bits, message] of expected) {
    const before = chat().length;
    assert.equal((await cheerHandler(event(bits), config, true)).error, false);
    if (message === null) assert.equal(chat().length, before, `${bits} Bits stay silent`);
    else assert.equal(chat().at(-1)?.chat.message, message, `${bits} Bits immediate`);
}
const now = new Date();
for (const [index, [bits, message]] of expected.entries()) {
    const before = chat().length;
    await applyChatAnnouncementDomainEvent({ _id: new mongoose.Types.ObjectId(), eventKey: `bits-rules-${target}-${index}`, source: 'twitch-eventsub', sourceEventId: `bits-rules-${index}`,
        type: 'channel.bits.received', topic: 'channel', schemaVersion: 1, channelID: owner, occurredAt: now, journaledAt: now,
        payload: { event: event(bits) }, metadata: { originalEventType: 'channel.bits.use', durableChatHandled: true }, expiresAt: new Date(Date.now() + 86400000) });
    if (message === null) assert.equal(chat().length, before, `${bits} Bits durable silent`);
    else assert.equal(chat().at(-1)?.chat.message, message, `${bits} Bits durable`);
}
// The old camelCase tier that never fired now matches (read through the legacy fallback).
if (target !== 'api') {
    const legacyConfig = await EventsubSchema.findOne({ channelID: legacy });
    await cheerHandler(event(69, legacy), legacyConfig, true);
    assert.equal(chat().at(-1)?.chat.message, 'Nice one Viewer');
}
console.log(`PASS ${target}: immediate and durable cheer chat follow shared Bits rules (exact beats wide, silent, default, off, legacy camelCase)`);
await mongoose.disconnect();
await redis.quit();
process.exit(0);
