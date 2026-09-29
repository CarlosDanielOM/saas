// Runs only in saas-ops' disposable Mongo/Redis network with provider mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { ChannelModerationSettingsSchema as Settings, buildDefaultModerationRules } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { ModerationDecision as Decisions } from '/app/dist/schemas/moderation_decision.schema.js';
import { ModerationActionLogSchema as Actions } from '/app/dist/schemas/moderation_action_log.schema.js';
import { runChatModeration, invalidateModerationSettingsCache } from '/app/dist/handlers/moderation.handler.js';
import { offenseKey } from '/app/dist/utils/moderation/offenses.js';
import { grantPermit } from '/app/dist/utils/moderation/permit.js';
import { parseAdvancedRule, findBlacklistMatches } from '/app/dist/utils/moderation/advanced.js';
import { ModerationVariationJob as VariationJobs, ModerationVariationCache as VariationCache } from '/app/dist/schemas/moderation_variation.schema.js';
import { requestVariationJob, resolveVariations } from '/app/dist/utils/moderation/variation_jobs.js';
import { buildVariation, rulePatterns } from '/app/dist/utils/moderation/variations.js';
import ChatHistory from '/app/dist/classes/chat_history.js';

const mongo = await getMongoDBConnection('semantic-test');
const redis = await getDragonflyClient('semantic-test');
await Decisions.init();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => { try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(fn, label) { for (let i = 0; i < 120; i++) { if (await fn()) return; await sleep(100); } throw new Error(`timeout: ${label}`); }
// cron's actual supervisor starts the worker. Other candidates use the exact
// compiled worker entrypoint as a task-owned child, never an in-process mock.
let worker;
if (process.env.SAAS_TARGET !== 'cron') worker = spawn(process.execPath, ['dist/workers/semantic_moderation.worker.js'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
const identity = { level: 1, tags: new Set(['everyone']) };
const message = (id, text, user = 'viewer') => ({ chatter_user_id: user, chatter_user_login: user, chatter_user_name: user, message_id: id, badges: [], message: { text, fragments: [] } });
const count = async (channel, rule, user = 'viewer') => Number(await redis.get(offenseKey(channel, rule.id, user)) || 0);
const decision = (id) => Decisions.findOne({ messageID: id }).lean();
const baseRule = () => ({ ...buildDefaultModerationRules()[3], id: 'words', enabled: true, terms: ['fuck'], ...parseAdvancedRule({ type: 'blacklist', patterns: [{ id: 'variants', source: 'f(?:u|a)?ck(?:ing|y)?' }] }) });
async function seed(channel, rule, tier = 'premium') {
    await Settings.create({ channelID: channel, channel, enabled: true, rules: [rule], settingsVersion: 2 });
    await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: channel }], plan_tier: tier, polar_sh_customer_id: `customer-${channel}` });
    await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: tier });
    await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 1000, balance: 1000, available: true, status: 'available' }));
}
try {
    await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });
    const direct = baseRule();
    await seed('regex-direct', direct);
    for (const [i, text] of ['fuck this', 'fucky', 'fcky', 'facky'].entries()) {
        assert.equal((await runChatModeration('regex-direct', message(`direct-${i}`, text), identity)).actionTaken, true);
        assert.equal(await count('regex-direct', direct), i + 1);
    }
    await until(async () => await Decisions.countDocuments({ channelID: 'regex-direct', 'consequence.status': 'executed' }) === 4, 'direct ladder');
    assert.deepEqual((await Decisions.find({ channelID: 'regex-direct' }).sort({ createdAt: 1 }).lean()).map(d => d.consequence.action), ['warn', 'delete', 'timeout', 'timeout']);
    assert.equal(calls().filter(c => c.review).length, 0, 'regex-only never calls AI');
    await runChatModeration('regex-direct', message('direct-0', 'fuck this'), identity);
    assert.equal(await count('regex-direct', direct), 4, 'duplicate does not increment');
    assert.equal((await runChatModeration('regex-direct', message('no-candidate', 'classic headshot'), identity)).actionTaken, false);
    assert.equal(await decision('no-candidate'), null, 'no candidate requires no review or decision');

    const semantic = { ...baseRule(), semantic: { enabled: true, policy: 'Prohibit negative or hostile profanity. Allow praise.', examples: [], onUncertain: 'allow_and_log' } };
    await seed('semantic-paid', semantic);
    await ChatHistory.addMessage('semantic-paid', 'another', 'earlier conversation', [], 'twitch', 'context-prior', Date.now() - 1000);
    await ChatHistory.addMessage('semantic-paid', 'another', 'old conversation', [], 'twitch', 'context-old', Date.now() - 120000);
    assert.equal((await runChatModeration('semantic-paid', message('positive', 'That was fucking awesome, pretty good headshot'), identity)).actionTaken, false);
    assert.equal(await count('semantic-paid', semantic), 0, 'positive candidate never increments');
    const positive = await decision('positive');
    assert.equal(positive.verdict, 'allow');
    assert.equal(positive.context.length, 1);
    assert.equal(positive.context[0].messageID, 'context-prior');
    assert.equal(Math.round((positive.expiresAt - positive.createdAt) / 86400000), 180);
    assert.equal((await runChatModeration('semantic-paid', message('negative', 'You are a fucking idiot'), identity)).actionTaken, true);
    assert.equal(await count('semantic-paid', semantic), 1);

    // The same 87% model score obeys each rule's saved threshold.
    for (const [name, thresholdPercent, flags] of [['default', undefined, true], ['strict', 90, false], ['decimal', 86.5, true], ['minimum', 0, true], ['maximum', 100, false]]) {
        const rule = { ...semantic, semantic: { ...semantic.semantic, ...(thresholdPercent === undefined ? {} : { thresholdPercent }) } };
        await seed(`confidence-${name}`, rule);
        if (thresholdPercent === undefined) await Settings.collection.updateOne({ channelID: `confidence-${name}` }, { $unset: { 'rules.0.semantic.thresholdPercent': '' } });
        assert.equal((await runChatModeration(`confidence-${name}`, message(`confidence-${name}`, 'fuck SCORE87'), identity)).actionTaken, flags);
        assert.equal(await count(`confidence-${name}`, rule), flags ? 1 : 0);
        const audit = await decision(`confidence-${name}`);
        assert.equal(audit.rule.semantic.thresholdPercent, thresholdPercent ?? 85, 'training snapshot explicitly preserves applied threshold, including legacy rules');
        assert.equal(audit.decisionPolicyVersion, 'contextual-v2');
    }

    for (const status of ['UNCERTAIN', 'INVALID', 'UNAVAILABLE', 'TIMEOUT']) {
        assert.equal((await runChatModeration('semantic-paid', message(`fallback-${status}`, `fuck ${status}`), identity)).actionTaken, false, status);
        assert.equal(await count('semantic-paid', semantic), 1, `${status} never increments`);
        const logged = await decision(`fallback-${status}`);
        assert.equal(logged.verdict, 'uncertain');
        assert.equal(logged.charge.credits, 0);
    }
    await sleep(700);
    assert.equal((await decision('fallback-TIMEOUT')).verdict, 'uncertain', 'late violation does not overwrite timeout');
    assert.equal(await count('semantic-paid', semantic), 1);

    await redis.set('twitch:semantic-paid:ai:exhaust', 'true');
    const beforeQuota = calls().filter(c => c.review).length;
    assert.equal((await runChatModeration('semantic-paid', message('quota', 'fuck this'), identity)).actionTaken, false);
    assert.equal((await decision('quota')).status, 'quota_exhausted');
    assert.equal(calls().filter(c => c.review).length, beforeQuota);
    await redis.del(['twitch:semantic-paid:ai:exhaust', 'semantic-paid:ai:exhaust']);

    const nickname = { ...semantic, terms: [], patterns: parseAdvancedRule({ type: 'blacklist', patterns: [{ source: 'r+i+(?:n+i+)*n+' }] }).patterns,
        semantic: { ...semantic.semantic, policy: 'Prohibit using Rinn as a nickname. Allow discussing or discouraging the nickname.' } };
    await seed('nickname-paid', nickname, 'pro');
    assert.equal((await runChatModeration('nickname-paid', message('nickname-allow', "Don't call her Rinn"), identity)).actionTaken, false);
    assert.equal((await runChatModeration('nickname-paid', message('nickname-violation', 'Yeah, Rinn is losing the game'), identity)).actionTaken, true);
    assert.equal((await runChatModeration('nickname-paid', message('nickname-no-match', 'bring'), identity)).actionTaken, false);
    nickname.semantic.policy = 'Prohibit any mention of Rinn, even when discouraging it.';
    await Settings.updateOne({ channelID: 'nickname-paid' }, { $set: { rules: [nickname] }, $inc: { settingsVersion: 1 } });
    await invalidateModerationSettingsCache('nickname-paid');
    assert.equal((await runChatModeration('nickname-paid', message('nickname-any', "Don't call her Rinn"), identity)).actionTaken, true);

    await seed('free-regex', direct, 'free');
    assert.equal((await runChatModeration('free-regex', message('free-regex', 'fcky'), identity)).actionTaken, false);
    assert.equal((await decision('free-regex')).status, 'plan_required');
    const literal = { ...baseRule(), patterns: [] };
    await seed('free-literal', literal, 'free');
    assert.equal((await runChatModeration('free-literal', message('free-literal', 'fuck this'), identity)).actionTaken, true);
    const mod = { level: 7, tags: new Set(['everyone', 'mod']) };
    assert.equal((await runChatModeration('semantic-paid', message('exempt', 'fuck this', 'mod'), mod)).actionTaken, false);
    await grantPermit('semantic-paid', 60, 'permitted');
    assert.equal((await runChatModeration('semantic-paid', message('permitted', 'fuck this', 'permitted'), identity)).actionTaken, false);
    assert.equal(await decision('exempt'), null);
    assert.equal(await decision('permitted'), null);

    // A model review that allows this rule must continue to later rules.
    const caps = { ...buildDefaultModerationRules()[0], minMessageLength: 1, minCapsCount: 2 };
    await seed('multiple-rules', semantic);
    await Settings.updateOne({ channelID: 'multiple-rules' }, { $set: { rules: [semantic, caps] } });
    assert.equal((await runChatModeration('multiple-rules', message('later-rule', 'WOW fucking awesome'), identity)).actionTaken, true);
    assert.equal(await count('multiple-rules', semantic), 0);
    assert.equal(await count('multiple-rules', caps), 1);

    // Slow responses cannot reorder the user's ladder.
    await seed('ordered', semantic);
    await Promise.all([
        runChatModeration('ordered', message('order-first', 'fuck SLOW', 'ordered-viewer'), identity),
        runChatModeration('ordered', message('order-second', 'fuck this', 'ordered-viewer'), identity)
    ]);
    assert.equal((await decision('order-first')).consequence.offenseNumber, 1);
    assert.equal((await decision('order-second')).consequence.offenseNumber, 2);
    // Settings changed while the provider is in flight cancel the consequence.
    const changed = runChatModeration('ordered', message('policy-changed', 'fuck SLOW', 'changed-viewer'), identity);
    await until(() => calls().some(c => c.review === 'fuck SLOW' && c.state.targetMessage.author === 'changed-viewer'), 'slow review started');
    await Settings.updateOne({ channelID: 'ordered' }, { $set: { enabled: false }, $inc: { settingsVersion: 1 } });
    assert.equal((await changed).actionTaken, false);
    assert.equal(await count('ordered', semantic, 'changed-viewer'), 0);

    await runChatModeration('semantic-paid', message('billable', 'fuck BILLABLE', 'billing-viewer'), identity);
    await until(async () => (await decision('billable')).charge.status === 'recorded', 'credit receipt');
    const bill = await decision('billable');
    assert.equal(bill.charge.credits, 1);
    assert.equal(bill.cost, 0, 'actual free provider cost retained');
    assert.equal(bill.charge.billableCostUSD, 150 * 0.042 / 1_000_000);
    assert.equal(bill.charge.pricingVersion, 'span-lite-jev-equivalent-v1');
    await runChatModeration('semantic-paid', message('billable', 'fuck BILLABLE', 'billing-viewer'), identity);
    assert.equal(JSON.parse(await redis.get('twitch:semantic-paid:ai:credits')).used, 3, 'two completed reviews and billable review charged once; uncertain reviews are free');

    // Automatic patterns support every word in a rule; both modes use the same
    // independently optional semantic gate and offense ladder.
    const commonRule = { ...baseRule(), terms: ['fuck', 'rinn'], patterns: [], variations: { mode: 'common', entries: ['fuck', 'rinn'].map(term => buildVariation(term)) } };
    await seed('auto-common', commonRule);
    assert.equal((await runChatModeration('auto-common', message('auto-repeat', 'fuuuck'), identity)).actionTaken, true);
    assert.equal((await runChatModeration('auto-common', message('auto-nickname', 'Riiinnnn'), identity)).actionTaken, true);
    assert.equal((await runChatModeration('auto-common', message('auto-boundary', 'bring'), identity)).actionTaken, false);
    await seed('auto-review', { ...commonRule, semantic: semantic.semantic });
    assert.equal((await runChatModeration('auto-review', message('auto-positive', 'fuuuck awesome'), identity)).actionTaken, false);
    assert.equal((await runChatModeration('auto-review', message('auto-negative', 'fuuuck this'), identity)).actionTaken, true);
    await seed('auto-free', commonRule, 'free');
    assert.equal((await runChatModeration('auto-free', message('auto-free', 'fuuuck'), identity)).actionTaken, false);

    for (const mode of ['common', 'broad']) {
        const entries = ['rin', 'rinn'].map(term => buildVariation(term, ['r1n']));
        const variations = { mode, entries, allowSpaces: true };
        const spacedRule = { ...commonRule, terms: ['rin', 'rinn'], variations };
        await seed(`spaces-${mode}`, spacedRule);
        const beforeReviews = calls().filter(c => c.review).length;
        for (const [index, text] of ['R I N', 'r 1 n', 'r i n n'].entries()) {
            assert.equal((await runChatModeration(`spaces-${mode}`, message(`space-${mode}-${index}`, text), identity)).actionTaken, true);
            assert.equal(await count(`spaces-${mode}`, spacedRule), index + 1);
        }
        assert.equal(calls().filter(c => c.review).length, beforeReviews, 'spaced regex-only uses ladder without AI');
        await seed(`spaces-review-${mode}`, { ...spacedRule, semantic: semantic.semantic });
        assert.equal((await runChatModeration(`spaces-review-${mode}`, message(`space-allow-${mode}`, 'R I N awesome'), identity)).actionTaken, false);
        assert.equal(await count(`spaces-review-${mode}`, spacedRule), 0);
        assert.equal((await runChatModeration(`spaces-review-${mode}`, message(`space-flag-${mode}`, 'R I N this'), identity)).actionTaken, true);
        const audit = await decision(`space-flag-${mode}`);
        assert.equal(audit.rule.variations.allowSpaces, true);
        assert.equal(audit.matches[0].text, 'R I N', 'training review keeps original spaced match');
        await seed(`spaces-off-${mode}`, { ...spacedRule, variations: { ...variations, allowSpaces: false } });
        assert.equal((await runChatModeration(`spaces-off-${mode}`, message(`space-off-${mode}`, 'R I N'), identity)).actionTaken, false);
        if (mode === 'broad') {
            for (const [index, text] of ['R ¡ N N', 'R | N N'].entries()) {
                assert.equal((await runChatModeration('spaces-broad', message(`symbol-direct-${index}`, text), identity)).actionTaken, true);
                const logged = await decision(`symbol-direct-${index}`);
                assert.equal(logged.matches[0].text, text);
                assert.equal(logged.rule.variations.entries[0].symbolVersion, 'symbol-families-v1');
                assert.ok(findBlacklistMatches(text, [], [logged.rule.variations.entries[0].pattern]).length, 'audit records effective generated regex');
            }
            assert.equal(await count('spaces-broad', spacedRule), 5);
            assert.equal((await runChatModeration('spaces-review-broad', message('symbol-allow', 'R | N N awesome'), identity)).actionTaken, false);
            assert.equal(await count('spaces-review-broad', spacedRule), 1);
            assert.equal((await runChatModeration('spaces-review-broad', message('symbol-flag', 'R ¡ N N this'), identity)).actionTaken, true);
            assert.equal(await count('spaces-review-broad', spacedRule), 2);
        }

    }

    const largeRule = { variations: { mode: 'common', entries: Array.from({ length: 200 }, (_, i) => buildVariation(`word${i}`)) } };
    assert.ok(findBlacklistMatches('wooord199', [], rulePatterns(largeRule)).length, '200 generated words run in native RE2');
    const timeoutJob = await VariationJobs.create({ _id: 'expired-generation', channelID: 'auto-common', terms: ['word'], entries: [], state: 'processing', deadline: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) });
    await until(async () => (await VariationJobs.findById(timeoutJob._id).lean()).state === 'failed', 'orphaned generation timeout');

    await seed('auto-muse', commonRule);
    const generation = await requestVariationJob('auto-muse', ['fuck', 'rinn'], []);
    assert.equal(generation.state, 'pending');
    assert.equal((await requestVariationJob('auto-muse', ['fuck', 'rinn'], [])).id, generation.id, 'in-flight job reused');
    await until(async () => (await VariationJobs.findById(generation.id).lean()).state === 'completed', 'Muse generation');
    const generated = await VariationJobs.findById(generation.id).lean();
    assert.equal(generated.model, 'meta/muse-spark-1.3-contributor');
    assert.equal(generated.entries.length, 2);
    assert.equal(generated.creditsCharged, 0);
    assert.equal(generated.providerUsage[0].cost, 0.00004, 'platform provider cost retained');
    assert.equal(JSON.parse(await redis.get('twitch:auto-muse:ai:credits')).used, 0, 'generation never debits user credits');
    const generatedCalls = calls().filter(c => c.generation).length;
    assert.equal((await requestVariationJob('auto-muse', ['fuck', 'rinn'], [])).state, 'completed');
    assert.equal(calls().filter(c => c.generation).length, generatedCalls, 'cached generation makes no new call');
    const changedTerms = await requestVariationJob('auto-muse', ['fuck', 'rinn', 'newword'], []);
    await until(async () => (await VariationJobs.findById(changedTerms.id).lean()).state === 'completed', 'only changed words');
    assert.deepEqual(calls().filter(c => c.generation).at(-1).generation, ['newword']);
    const broadRule = { ...commonRule, variations: await resolveVariations('auto-muse', ['fuck', 'rinn'], 'broad', []) };
    await Settings.updateOne({ channelID: 'auto-muse' }, { $set: { rules: [broadRule] }, $inc: { settingsVersion: 1 } });
    await invalidateModerationSettingsCache('auto-muse');
    assert.equal((await runChatModeration('auto-muse', message('auto-broad', 'facky'), identity)).actionTaken, true);
    await Settings.updateOne({ channelID: 'auto-muse' }, { $set: { rules: [{ ...broadRule, semantic: semantic.semantic }] }, $inc: { settingsVersion: 1 } });
    await invalidateModerationSettingsCache('auto-muse');
    assert.equal((await runChatModeration('auto-muse', message('auto-broad-allow', 'fucky awesome'), identity)).actionTaken, false);
    assert.equal((await runChatModeration('auto-muse', message('auto-broad-violation', 'fcky this'), identity)).actionTaken, true);
    for (const term of ['invalidgen', 'unavailablegen']) {
        const failed = await requestVariationJob('auto-muse', [term], []);
        await until(async () => (await VariationJobs.findById(failed.id).lean()).state === 'failed', term);
        assert.equal(await VariationCache.countDocuments({ channelID: 'auto-muse', 'entry.term': term }), 0);
    }
    await redis.set('moderation:auto-muse:variation-words', '500');
    await assert.rejects(requestVariationJob('auto-muse', ['quota-word'], []), error => error.status === 429);
    assert.equal((await requestVariationJob('auto-muse', ['fuck'], [])).state, 'completed', 'cached terms work after generation quota exhausted');

    const expired = new Date(Date.now() - 31 * 86400000);
    await Decisions.updateOne({ _id: positive._id }, { $set: { createdAt: expired } });
    assert.ok(await Decisions.findById(positive._id), '31-day decision retained for training');
    const indexes = await Decisions.collection.indexes();
    assert.ok(indexes.some(index => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));

    if (process.env.SAAS_TARGET === 'api') {
        await redis.hSet('token:semantic-owner', { id: 'semantic-paid', login: 'semantic-paid', display_name: 'Owner' });
        await redis.hSet('token:free-owner', { id: 'free-literal', login: 'free-literal', display_name: 'Owner' });
        const api = (method, path, body, token = 'semantic-owner') => fetch(`http://127.0.0.1:3000/moderation/${path}`, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        await until(async () => { try { return (await api('GET', 'semantic-paid/settings')).status === 200; } catch { return false; } }, 'API ready');
        assert.equal((await api('GET', 'semantic-paid/decisions', null, null)).status, 401);
        assert.equal((await api('GET', 'free-literal/decisions')).status, 403);
        const listed = await (await api('GET', 'semantic-paid/decisions?limit=100')).json();
        assert.ok(!listed.data.decisions.some(row => row._id === positive._id), '31-day records hidden server-side');
        assert.ok(listed.data.decisions.some(row => row.status === 'timeout'));
        assert.ok(listed.data.decisions.every(row => !row.context && !row.rule && !row.charge.customerID), 'internal training context and billing identifiers not exposed');
        assert.equal((await api('PUT', 'free-literal/settings', { enabled: true, rules: [direct] }, 'free-owner')).status, 403);
        assert.equal((await api('POST', 'free-literal/variations', { terms: ['fuck'], mode: 'broad' }, 'free-owner')).status, 403);
        assert.equal((await api('GET', `semantic-paid/variations/${generation.id}`)).status, 404, 'job IDs cannot cross channels');
        assert.equal((await api('POST', 'semantic-paid/variations', { terms: Array(201).fill('word'), mode: 'broad' })).status, 400);
        const commonResponse = await api('POST', 'semantic-paid/variations', { terms: ['fuck', 'rinn'], mode: 'common' });
        assert.equal((await commonResponse.json()).data.entries.length, 2);
        const forged = { ...commonRule, variations: { mode: 'broad', entries: [{ term: 'fuck', pattern: { source: '.*' } }] } };
        assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [forged] })).status, 409, 'client cannot inject generated patterns');
        const commonSaved = await (await api('PUT', 'semantic-paid/settings', { rules: [commonRule] })).json();
        assert.equal(commonSaved.data.rules[0].variations.entries.length, 2);
        const broadResponse = await (await api('POST', 'semantic-paid/variations', { terms: ['fuck', 'rinn'], mode: 'broad' })).json();
        let prepared;
        await until(async () => {
            prepared = await (await api('GET', `semantic-paid/variations/${broadResponse.data.id}`)).json();
            return prepared.data.state === 'completed';
        }, 'API broad generation');
        assert.equal(prepared.data.entries.length, 2);
        const trusted = await (await api('PUT', 'semantic-paid/settings', { rules: [forged] })).json();
        assert.equal(trusted.data.rules[0].variations.entries.length, 2);
        assert.ok(trusted.data.rules[0].variations.entries.every(entry => entry.pattern.source !== '.*'), 'generated artifacts come from owned server cache');

        for (const mode of ['common', 'broad']) {
            const edited = { ...commonRule, variations: { mode, entries: [], overrides: [{ term: 'rinn', source: 'rinn|rynn' }] } };
            const response = await api('PUT', 'semantic-paid/settings', { rules: [edited] });
            assert.equal(response.status, 200);
            const persisted = (await (await api('GET', 'semantic-paid/settings')).json()).data.rules[0];
            assert.equal(persisted.variations.overrides[0].source, 'rinn|rynn');
            await invalidateModerationSettingsCache('semantic-paid');
            assert.equal((await runChatModeration('semantic-paid', message(`edited-${mode}`, 'rynn', `edit-${mode}`), identity)).actionTaken, true);
            assert.equal((await runChatModeration('semantic-paid', message(`edited-no-${mode}`, 'riiinn', `edit-${mode}`), identity)).actionTaken, false, 'override replaces generated regex');
            assert.equal((await runChatModeration('semantic-paid', message(`edited-boundary-${mode}`, 'bring', `edit-${mode}`), identity)).actionTaken, false);
            for (const source of ['(', '.*', '(?=rinn)rinn']) {
                const invalidEdit = { ...edited, variations: { ...edited.variations, overrides: [{ term: 'rinn', source }] } };
                assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [invalidEdit] })).status, 400);
            }
            assert.equal((await api('PUT', 'free-literal/settings', { rules: [edited] }, 'free-owner')).status, 403);
            const reset = { ...edited, variations: { ...edited.variations, overrides: [] } };
            assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [reset] })).status, 200);
            await invalidateModerationSettingsCache('semantic-paid');
            assert.equal((await runChatModeration('semantic-paid', message(`reset-${mode}`, 'riiinn', `edit-${mode}`), identity)).actionTaken, true);
        }

        for (const mode of ['common', 'broad']) {
            const generationCount = calls().filter(c => c.generation).length;
            for (const allowSpaces of [true, false]) {
                const preview = await (await api('POST', 'semantic-paid/variations', { terms: ['fuck', 'rinn'], mode, allowSpaces })).json();
                assert.equal(preview.data.state, 'completed');
                assert.equal(findBlacklistMatches('R I N', [], [preview.data.entries[1].pattern]).length > 0, allowSpaces);
                const rule = { ...commonRule, variations: { mode, allowSpaces, entries: [] } };
                assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [rule] })).status, 200);
                const loaded = (await (await api('GET', 'semantic-paid/settings')).json()).data.rules[0];
                assert.equal(loaded.variations.allowSpaces, allowSpaces);
                for (const text of ['R ¡ N N', 'R | N N']) {
                    assert.equal(findBlacklistMatches(text, [], [preview.data.entries[1].pattern]).length > 0, mode === 'broad' && allowSpaces);
                    assert.equal(findBlacklistMatches(text, [], [loaded.variations.entries[1].pattern]).length > 0, mode === 'broad' && allowSpaces);
                }

                await invalidateModerationSettingsCache('semantic-paid');
                assert.equal((await runChatModeration('semantic-paid', message(`space-api-${mode}-${allowSpaces}`, 'R I N', `space-api-${mode}`), identity)).actionTaken, allowSpaces);
            }
            assert.equal(calls().filter(c => c.generation).length, generationCount, 'spacing reuses cached spellings without generation');
        }
        const polledSpaces = await (await api('GET', `semantic-paid/variations/${broadResponse.data.id}?allowSpaces=true`)).json();
        assert.ok(findBlacklistMatches('R I N', [], [polledSpaces.data.entries[1].pattern]).length, 'async job view applies spacing');
        for (const allowSpaces of ['true', 1, null]) {
            assert.equal((await api('POST', 'semantic-paid/variations', { terms: ['rinn'], mode: 'common', allowSpaces })).status, 400);
            assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [{ ...commonRule, variations: { mode: 'common', allowSpaces } }] })).status, 400);
        }

        const legacy = { ...commonRule, variations: { mode: 'broad', allowSpaces: true, entries: [buildVariation('rinn')] } };
        await Settings.updateOne({ channelID: 'semantic-paid' }, { $set: { rules: [legacy] } });
        const legacyView = (await (await api('GET', 'semantic-paid/settings')).json()).data.rules[0];
        assert.ok(findBlacklistMatches('R | N N', [], [legacyView.variations.entries[0].pattern]).length, 'settings GET displays upgraded legacy regex');
        const untouched = await Settings.findOne({ channelID: 'semantic-paid' }).lean();
        assert.equal(untouched.rules[0].variations.entries[0].symbolVersion, undefined, 'read upgrade never mutates saved data');

        const saved = await api('PUT', 'semantic-paid/settings', { enabled: true, rules: [semantic] });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).data.rules[0].semantic.policy, semantic.semantic.policy);
        for (const thresholdPercent of [0, 85.5, 100]) {
            const rule = { ...semantic, semantic: { ...semantic.semantic, thresholdPercent } };
            assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [rule] })).status, 200);
            const loaded = await (await api('GET', 'semantic-paid/settings')).json();
            assert.equal(loaded.data.rules[0].semantic.thresholdPercent, thresholdPercent);
        }
        for (const thresholdPercent of [-1, 101, '85', null]) {
            const rule = { ...semantic, semantic: { ...semantic.semantic, thresholdPercent } };
            assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [rule] })).status, 400);
        }
        const versions = await Promise.all([1, 2].map(async () => {
            const response = await api('PUT', 'semantic-paid/settings', { enabled: true, rules: [semantic] });
            assert.equal(response.status, 200);
            return (await response.json()).data.settingsVersion;
        }));
        assert.equal(new Set(versions).size, 2, 'concurrent saves receive distinct policy versions');
        const invalid = { ...direct, patterns: [{ id: 'bad', source: '(?<=x)y' }] };
        assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [invalid] })).status, 400);
        assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [semantic, semantic] })).status, 400);
        assert.equal((await api('PUT', 'semantic-paid/settings', { rules: [{ ...semantic, semantic: { enabled: true, policy: '' } }] })).status, 400);
        await Actions.updateMany({ channelID: 'semantic-paid' }, { $set: { createdAt: expired } });
        assert.equal((await (await api('GET', 'semantic-paid/logs')).json()).data.total, 0, 'action logs also enforce 30-day window');
    }
    console.log('PASS Muse variations: cache, changed words, two modes with/without semantics, free generation, ownership, quotas, invalid/unavailable outputs; semantic moderation: direct regex ladder; allow/violation/uncertain/error/late/quota; context; policies; tiers; permits; ordering; dedupe and credits; 180/30-day retention and authorization');
} finally {
    if (worker) { worker.kill('SIGTERM'); await new Promise(resolve => worker.once('exit', resolve)); }
}
process.exit(0);
