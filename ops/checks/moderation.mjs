// Moderation pipeline behavior check. Runs inside the saas-ops candidate with
// disposable Mongo/Redis and mocked Twitch providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { ChannelModerationSettingsSchema, buildDefaultModerationRules } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { ModerationActionLogSchema } from '/app/dist/schemas/moderation_action_log.schema.js';
import { runChatModeration, moderationSettingsCacheKey, NO_SETTINGS_SENTINEL } from '/app/dist/handlers/moderation.handler.js';
import { grantPermit } from '/app/dist/utils/moderation/permit.js';
import { offenseKey } from '/app/dist/utils/moderation/offenses.js';
import { parsePermitArgs } from '/app/dist/utils/moderation/permit.js';
import { seedDefaultModerationSettings } from '/app/dist/utils/moderation/defaults.js';

const mongo = await getMongoDBConnection('moderation-check');
const redis = await getDragonflyClient('moderation-check');
const channel = 'mod-check-1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => { try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw new Error(`timeout: ${label}`); }

// Bot account token fixture so warn/delete/ban resolve the bot header.
await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy-token', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });

const identity = (level, tags = []) => ({ level, tags: new Set(['everyone', ...tags]) });
const message = (id, text, fragments = [], user = 'user1', login = 'viewer1') => ({
    chatter_user_id: user,
    chatter_user_login: login,
    chatter_user_name: 'Viewer1',
    message_id: id,
    badges: [],
    message: { text, fragments }
});

// --- Seed enabled settings with the default ladder (warn -> delete -> timeout 60s) ---
const rules = buildDefaultModerationRules();
rules.find(rule => rule.type === 'links').allowlistDomains = ['twitch.tv'];
await ChannelModerationSettingsSchema.create({
    channelID: channel,
    channel: 'fixture',
    enabled: true,
    offenseWindowSeconds: 3600,
    rules,
    settingsVersion: 1
});
const capsRule = rules.find(rule => rule.type === 'caps');

// --- Escalation ladder over four caps offenses ---
for (const [index, expectation] of [['warn', c => c.warn === 'user1'], ['delete', c => c.delete === `msg-${2}`], ['timeout', c => c.ban === 'user1' && c.duration === 60], ['timeout-repeat', c => c.ban === 'user1' && c.duration === 60]].entries()) {
    const result = await runChatModeration(channel, message(`msg-${index + 1}`, 'THIS IS WAY TOO LOUD BRO'), identity(1));
    assert.equal(result.actionTaken, true, `offense ${index + 1} should be actioned`);
    assert.equal(Number(await redis.get(offenseKey(channel, capsRule.id, 'user1'))), index + 1, 'offense counter increments');
    await until(() => calls().filter(expectation[1]).length >= (expectation[0] === 'timeout-repeat' ? 2 : 1), `provider call for ${expectation[0]}`);
}
assert.deepEqual(calls().filter(c => c.warn).length, 1, 'exactly one Twitch warning');
assert.deepEqual(calls().filter(c => c.delete).length, 1, 'exactly one delete');
assert.deepEqual(calls().filter(c => c.ban).length, 2, 'two timeouts (3rd rung repeats)');
await until(() => calls().some(c => c.chat), 'public notice');
const noticesBefore = calls().filter(c => c.chat).length;
await until(async () => (await ModerationActionLogSchema.countDocuments({ channelID: channel })) >= 4, 'action log entries');
assert.equal(noticesBefore, 1, 'notice throttle: one public notice across four offenses');

// --- Permit bypasses all rules ---
await grantPermit(channel, 60, 'viewer1');
const permitted = await runChatModeration(channel, message('msg-permit', 'STILL ALL CAPS HERE FRIEND'), identity(1));
assert.equal(permitted.actionTaken, false, 'active permit bypasses rules');
assert.equal(Number(await redis.get(offenseKey(channel, capsRule.id, 'user1'))), 4, 'permit does not count offenses');

// --- Exemptions, disabled settings, missing settings ---
assert.equal((await runChatModeration(channel, message('msg-mod', 'MORE CAPS THAN ALLOWED HERE', [], 'mod1', 'modone'), identity(7, ['mod']))).actionTaken, false, 'mods exempt at default level');
assert.equal((await runChatModeration(channel, message('msg-broadcaster', 'I CAN SHOUT ALL I WANT', [], channel, 'fixture'), identity(10, ['broadcaster']))).actionTaken, false, 'broadcaster never moderated');
assert.equal((await runChatModeration('no-settings-channel', message('msg-none', 'NO SETTINGS AT ALL HERE'), identity(1))).actionTaken, false, 'missing settings = no moderation');
await ChannelModerationSettingsSchema.create({ channelID: 'disabled-channel', enabled: false, rules });
assert.equal((await runChatModeration('disabled-channel', message('msg-off', 'DISABLED SHOULD NOT FIRE'), identity(1))).actionTaken, false, 'disabled master switch = no moderation');

// --- Links rule with allowlist ---
assert.equal((await runChatModeration(channel, message('msg-link', 'check scam.xyz/free please', [], 'user2', 'viewer2'), identity(1))).actionTaken, true, 'non-allowlisted link blocked');
assert.equal((await runChatModeration(channel, message('msg-oklink', 'nice clips.twitch.tv/abc clip', [], 'user3', 'viewer3'), identity(1))).actionTaken, false, 'allowlisted subdomain passes');

// --- Emote spam rule (fragments, not regex) ---
const emoteFragments = Array.from({ length: 11 }, () => ({ type: 'emote', text: 'KAPPA' }));
assert.equal((await runChatModeration(channel, message('msg-emotes', 'KAPPA '.repeat(11).trim(), emoteFragments, 'user4', 'viewer4'), identity(1))).actionTaken, true, 'emote spam blocked');

// --- Caps rule ignores emote text ---
const capsOnly = 'caps-only-channel';
const capsOnlyRule = { ...rules.find(rule => rule.type === 'caps'), id: 'caps-only-rule' };
await ChannelModerationSettingsSchema.create({ channelID: capsOnly, enabled: true, rules: [capsOnlyRule], settingsVersion: 1 });
const kappaMessage = 'KAPPA KAPPA KAPPA KAPPA';
assert.equal((await runChatModeration(capsOnly, message('msg-kappa', kappaMessage, Array.from({ length: 4 }, () => ({ type: 'emote', text: 'KAPPA' })), 'user5', 'viewer5'), identity(1))).actionTaken, false, 'emote text never counts as caps');

// --- Blacklist whole-word + accent folding ---
const blacklistChannel = 'blacklist-channel';
const blacklistRule = { ...rules.find(rule => rule.type === 'blacklist'), id: 'blacklist-rule', enabled: true, terms: ['café scam', 'badword'] };
await ChannelModerationSettingsSchema.create({ channelID: blacklistChannel, enabled: true, rules: [blacklistRule], settingsVersion: 1 });
assert.equal((await runChatModeration(blacklistChannel, message('msg-bl1', 'come get your CAFE SCAM here', [], 'user6', 'viewer6'), identity(1))).actionTaken, true, 'accent-folded phrase matches');
assert.equal((await runChatModeration(blacklistChannel, message('msg-bl2', 'this is a BADWORD situation', [], 'user6', 'viewer6'), identity(1))).actionTaken, true, 'case-insensitive term matches');
assert.equal((await runChatModeration(blacklistChannel, message('msg-bl3', 'badwordss should not match', [], 'user7', 'viewer7'), identity(1))).actionTaken, false, 'whole-word: embedded term does not match');

// --- Permit argument parsing (AST $(permit) contract) ---
assert.deepEqual(parsePermitArgs([]), { login: null, seconds: 60 });
assert.deepEqual(parsePermitArgs(['SomeUser']), { login: 'someuser', seconds: 60 });
assert.deepEqual(parsePermitArgs(['120']), { login: null, seconds: 120 });
assert.deepEqual(parsePermitArgs(['someuser', '300']), { login: 'someuser', seconds: 300 });
assert.ok('error' in parsePermitArgs(['601']));

// --- Channel-wide permit bypasses too ---
await grantPermit(channel, 60, null);
assert.equal((await runChatModeration(channel, message('msg-wide', 'CHANNEL WIDE PERMIT CAPS', [], 'user8', 'viewer8'), identity(1))).actionTaken, false, 'channel-wide permit bypasses');

// --- New-channel seed vs negative cache and GET stub ---
const seedChannel = 'seed-race-channel';
await redis.set(moderationSettingsCacheKey(seedChannel), NO_SETTINGS_SENTINEL);
await seedDefaultModerationSettings(seedChannel, 'seedrace');
const seeded = await ChannelModerationSettingsSchema.findOne({ channelID: seedChannel }).lean();
assert.equal(seeded.enabled, true, 'new channel seed enables moderation');
assert.ok(seeded.rules.some(rule => rule.type === 'caps' && rule.enabled), 'new channel seed writes default rules');
assert.notEqual(await redis.get(moderationSettingsCacheKey(seedChannel)), NO_SETTINGS_SENTINEL, 'seed overwrites the no-settings sentinel');
assert.equal((await runChatModeration(seedChannel, message('msg-seed-caps', 'THIS IS WAY TOO LOUD BRO'), identity(1))).actionTaken, true, 'seeded channel moderates immediately after a cached miss');

const stubChannel = 'seed-stub-channel';
await ChannelModerationSettingsSchema.create({ channelID: stubChannel, channel: 'stub', enabled: false, rules: [], settingsVersion: 1 });
await seedDefaultModerationSettings(stubChannel, 'stub');
const healed = await ChannelModerationSettingsSchema.findOne({ channelID: stubChannel }).lean();
assert.equal(healed.enabled, true, 'GET stub is replaced by new-channel defaults');
assert.ok(healed.rules.length >= 3, 'replaced stub has the default rule set');
const stubCachedRaw = await redis.get(moderationSettingsCacheKey(stubChannel));
assert.notEqual(stubCachedRaw, NO_SETTINGS_SENTINEL, 'stub heal does not leave the negative sentinel cached');
assert.equal(JSON.parse(stubCachedRaw).enabled, true, 'primed cache reflects healed settings, never the stale stub');

const savedChannel = 'seed-saved-channel';
await ChannelModerationSettingsSchema.create({ channelID: savedChannel, channel: 'saved', enabled: false, rules: [], settingsVersion: 2 });
await seedDefaultModerationSettings(savedChannel, 'saved');
const saved = await ChannelModerationSettingsSchema.findOne({ channelID: savedChannel }).lean();
assert.equal(saved.enabled, false, 'user-saved empty settings are not overwritten');
assert.equal(saved.settingsVersion, 2, 'user-saved settingsVersion is left intact');

// --- Tag-expression rule exemptions (permission expressions) ---
const expressionChannel = 'expression-exempt-channel';
const expressionRule = { ...rules.find(rule => rule.type === 'caps'), id: 'expression-rule' };
expressionRule.exemptExpression = { or: [{ role: 'sub' }, { role: 'vip' }] };
await ChannelModerationSettingsSchema.create({ channelID: expressionChannel, enabled: true, rules: [expressionRule], settingsVersion: 1 });
assert.equal((await runChatModeration(expressionChannel, message('msg-expr-sub', 'SHOUTING IN CAPS AS A SUB', [], 'sub1', 'subone'), identity(2, ['sub']))).actionTaken, false, 'sub tag exempt via expression');
assert.equal((await runChatModeration(expressionChannel, message('msg-expr-vip', 'SHOUTING IN CAPS AS A VIP', [], 'vip1', 'vipone'), identity(5, ['vip']))).actionTaken, false, 'vip tag exempt via expression');
assert.equal((await runChatModeration(expressionChannel, message('msg-expr-mod', 'SHOUTING IN CAPS AS A MOD', [], 'mod9', 'modnine'), identity(7, ['mod']))).actionTaken, true, 'mod without sub/vip tags is NOT exempt (stored numeric level stays inert in tag mode)');
assert.equal((await runChatModeration(expressionChannel, message('msg-expr-bc', 'SHOUTING IN CAPS AS BROADCASTER', [], expressionChannel, 'expr'), identity(10, ['broadcaster']))).actionTaken, false, 'broadcaster always bypasses moderation');

const invalidRule = { ...rules.find(rule => rule.type === 'caps'), id: 'invalid-expression-rule', exemptExpression: { role: 'supermod' } };
await ChannelModerationSettingsSchema.create({ channelID: 'invalid-expression-channel', enabled: true, rules: [invalidRule], settingsVersion: 1 });
assert.equal((await runChatModeration('invalid-expression-channel', message('msg-inv', 'CAPS WITH A BROKEN POLICY', [], 'admin1', 'adminone'), identity(9, ['admin']))).actionTaken, true, 'present invalid expression grants no exemption, even to admins');

// Consume the shared fixtures when provided (keeps server/client lockstep).
try {
    const fixtures = JSON.parse(fs.readFileSync('/tmp/saas-fixtures/permission-expressions.json', 'utf8'));
    assert.ok(fixtures.valid.length >= 10, 'fixture valid set is populated');
    assert.ok(fixtures.invalid.length >= 10, 'fixture invalid set is populated');
    assert.ok(fixtures.evaluations.length >= 20, 'fixture evaluation matrix is populated');
} catch (err) {
    if (process.env.SAAS_FIXTURES_REQUIRED === '1') throw err;
}

console.log(`PASS ${process.env.SAAS_TARGET}: ladder escalation, notices throttled, permits, exemptions, links/emote/blacklist rules, parser contract, seed vs cache/stub, expression exemptions`);

// --- API surface (only when verifying the api target) ---
if (process.env.SAAS_TARGET === 'api') {
    const apiChannel = 'api-mod-channel';
    await redis.hSet(`accounts:twitch:${apiChannel}:data`, { id: apiChannel, name: 'apimod' });
    await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: apiChannel, name: 'apimod' }], plan_tier: 'free' });
    await redis.hSet('token:mod-owner', { id: apiChannel, login: 'apimod', display_name: 'ApiMod' });

    let up = false;
    for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:3000/moderation/x/settings'); up = true; break; } catch { await sleep(500); } }
    assert.ok(up, 'api ready');

    const api = (method, path, body, token = 'mod-owner') => fetch(`http://127.0.0.1:3000${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    assert.equal((await api('GET', `/moderation/${apiChannel}/settings`, null, null)).status, 401, 'unauthenticated rejected');

    const created = await (await api('GET', `/moderation/${apiChannel}/settings`)).json();
    assert.equal(created.data.enabled, false, 'existing channels default to NO moderation');
    assert.deepEqual(created.data.rules, [], 'existing channels get no rules');
    assert.equal(await ChannelModerationSettingsSchema.countDocuments({ channelID: apiChannel }), 0, 'GET does not insert a settings document');

    const capsPayload = { enabled: true, rules: [{ type: 'caps', minCapsCount: 99999, firstOffense: { action: 'warn', timeoutSeconds: 60 }, secondOffense: { action: 'delete', timeoutSeconds: 60 }, thirdOffense: { action: 'timeout', timeoutSeconds: 60 } }] };
    const saved = await api('PUT', `/moderation/${apiChannel}/settings`, capsPayload);
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.data.enabled, true);
    assert.equal(savedBody.data.rules[0].minCapsCount, 500, 'threshold clamped to schema bounds');
    assert.ok(savedBody.data.rules[0].id, 'rule id assigned');

    assert.equal((await api('PUT', `/moderation/${apiChannel}/settings`, { rules: [{ type: 'mind_control' }] })).status, 400, 'invalid rule type rejected');

    const badExpression = await api('PUT', `/moderation/${apiChannel}/settings`, { rules: [{ type: 'caps', exemptExpression: { role: 'supermod' } }] });
    assert.equal(badExpression.status, 400, 'invalid exemption expression rejected');
    assert.match((await badExpression.json()).message, /invalid permission expression/i);

    const goodExpression = await api('PUT', `/moderation/${apiChannel}/settings`, { rules: [{ type: 'caps', exemptExpression: { or: [{ role: 'sub' }, { role: 'vip' }] } }] });
    assert.equal(goodExpression.status, 200, 'valid exemption expression persisted');
    assert.deepEqual((await goodExpression.json()).data.rules[0].exemptExpression, { or: [{ role: 'sub' }, { role: 'vip' }] });

    const nullExpression = await api('PUT', `/moderation/${apiChannel}/settings`, { rules: [{ type: 'caps', exemptExpression: null }] });
    assert.equal(nullExpression.status, 200, 'explicit null returns to the numeric exemption gate');
    assert.equal((await nullExpression.json()).data.rules[0].exemptExpression, null);

    const logs = await (await api('GET', `/moderation/${apiChannel}/logs?limit=10`)).json();
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.data.logs), 'logs endpoint returns a list');

    // The gate wrote logs for its own channel earlier in this same run; that
    // channel's owner can read them, another channel's owner cannot.
    await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'fixture' });
    await redis.hSet('token:gate-owner', { id: channel, login: 'fixture', display_name: 'Fixture' });
    const gateLogs = await (await api('GET', `/moderation/${channel}/logs?limit=100`, null, 'gate-owner')).json();
    assert.equal(gateLogs.status, 200);
    assert.ok(gateLogs.data.logs.length >= 4, 'gate actions are visible in the logs API');

    await redis.hSet('accounts:twitch:other-channel:data', { id: 'other-channel', name: 'other' });
    const forbidden = await api('GET', `/moderation/other-channel/logs`, null, 'mod-owner');
    assert.equal(forbidden.status, 403, 'owner of another channel is rejected');
    console.log('PASS api: authz, no-disruption defaults, sanitized save, invalid rejected, logs');
}

process.exit(0);
