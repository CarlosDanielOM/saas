// Runs the candidate's actual moderation handler/worker against disposable data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { ChannelModerationSettingsSchema as Settings, buildDefaultModerationRules } from '/app/dist/schemas/channel_moderation_settings.schema.js';
import { ModerationDecision as Decisions } from '/app/dist/schemas/moderation_decision.schema.js';
import { ModerationChatter as Chatters } from '/app/dist/schemas/moderation_chatter.schema.js';
import { ModerationActionLogSchema as Actions } from '/app/dist/schemas/moderation_action_log.schema.js';
import { runChatModeration, invalidateModerationSettingsCache } from '/app/dist/handlers/moderation.handler.js';
import { grantPermit } from '/app/dist/utils/moderation/permit.js';
import { chatterMarkerID, claimFirstObservedMessage, claimSpamReviewBudget, SPAM_RULE_ID } from '/app/dist/utils/moderation/spam.js';
import ChatHistory from '/app/dist/classes/chat_history.js';
import { DEFAULT_SPAM_CATEGORIES } from '/app/dist/utils/moderation/spam_categories.js';

const mongo = await getMongoDBConnection('spam-protection-check');
const redis = await getDragonflyClient('spam-protection-check');
await Chatters.init();
await Decisions.init();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw new Error(`Timeout: ${label}`); }
const calls = () => { try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const reviews = () => calls().filter(call => call.spamReview);
const msg = (id, text, user = 'viewer') => ({ message_id: id, chatter_user_id: user, chatter_user_login: user, chatter_user_name: user,
    message: { text, fragments: [] }, badges: [] });
const identity = { level: 1, tags: new Set(['everyone']) };
const review = (channel, id, text, user) => runChatModeration(channel, msg(id, text, user), identity);
const decision = id => Decisions.findOne({ messageID: id }).lean();
async function seed(channel, tier = 'free', protection = { enabled: true, reviewAllMessages: false }) {
    await Settings.create({ channelID: channel, channel, enabled: true, spamProtection: protection, rules: [], settingsVersion: 1 });
    await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: channel }], plan_tier: tier, polar_sh_customer_id: `customer-${channel}` });
    await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: tier });
    await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 1000, balance: 1000, available: true, status: 'available' }));
}
let worker;
if (process.env.SAAS_TARGET !== 'cron') worker = spawn(process.execPath, ['dist/workers/semantic_moderation.worker.js'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
try {
    await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });
    // Even an exhausted free account gets its first review, without any billing writes.
    await seed('spam-free');
    const exhausted = JSON.stringify({ version: 3, used: 1000, limit: 1000, balance: 0, available: true, status: 'exhausted' });
    await redis.set('twitch:spam-free:ai:credits', exhausted);
    await redis.set('twitch:spam-free:ai:credits:exhausted', '1');
    assert.equal((await review('spam-free', 'first-ad', 'Want to buy more viewers? Visit viewerbuy . com!', 'advertiser')).actionTaken, true);
    await until(async () => (await decision('first-ad'))?.consequence.status === 'executed', 'first-message ban');
    const first = await decision('first-ad');
    assert.equal(first.reviewSource, 'first_message');
    assert.equal(first.consequence.action, 'ban');
    assert.equal(first.consequence.offenseNumber, 1);
    assert.equal(first.charge.status, 'none');
    assert.equal(first.charge.credits, 0);
    assert.equal(first.charge.billableCostUSD, 0);
    assert.equal(await redis.get('twitch:spam-free:ai:credits'), exhausted);
    assert.equal(await redis.get(`moderation:spam-free:offenses:${SPAM_RULE_ID}:advertiser`), null, 'ban never touches ladder');
    const bans = calls().filter(call => call.ban === 'advertiser');
    assert.equal(bans.length, 1);
    assert.equal(bans[0].duration, null, 'permanent channel ban');
    assert.equal(calls().some(call => call.warn === 'advertiser'), false);
    await review('spam-free', 'first-ad', 'Want to buy more viewers? Visit viewerbuy . com!', 'advertiser');
    assert.equal(reviews().length, 1, 'delivery retry cannot rereview');

    for (const [id, text] of [['hello', 'Hello everyone!'], ['quoted', 'Someone posted "buy viewers at viewerbuy.com". Is that a scam?'],
        ['warning', 'Do not buy viewers; those sites are scams.'], ['discussion', 'I stream too, how do you set up your microphone?']]) {
        assert.equal((await review('spam-free', id, text, id)).actionTaken, false, id);
        assert.equal((await decision(id)).verdict, 'allow', id);
        assert.equal((await decision(id)).charge.credits, 0);
    }
    const beforeSecond = reviews().length;
    assert.equal((await review('spam-free', 'second-ad', 'Want to buy viewers? viewerbuy.com', 'hello')).actionTaken, false);
    assert.equal(await decision('second-ad'), null);
    assert.equal(reviews().length, beforeSecond, 'free later message is not reviewed');

    // The durable marker survives cache loss and is channel-specific.
    const marker = chatterMarkerID('spam-free', 'hello');
    await redis.del(`moderation:seen:${marker}`);
    assert.equal(await claimFirstObservedMessage('spam-free', 'hello'), false);
    const claims = await Promise.all(Array.from({ length: 16 }, () => claimFirstObservedMessage('atomic-channel', 'atomic-user')));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await Chatters.countDocuments({ _id: chatterMarkerID('atomic-channel', 'atomic-user') }), 1);
    assert.equal(await claimFirstObservedMessage('another-channel', 'atomic-user'), true);
    await Promise.all([review('spam-free', 'race-hello', 'Hello!', 'race'), review('spam-free', 'race-ad', 'Want to buy viewers?', 'race')]);
    assert.equal(await Decisions.countDocuments({ channelID: 'spam-free', userID: 'race' }), 1);

    // Premium and Pro can opt into later reviews; their first review is still free.
    for (const tier of ['premium', 'pro']) {
        const channel = `spam-${tier}`;
        await seed(channel, tier, { enabled: true, reviewAllMessages: true });
        await review(channel, `${tier}-hello`, 'Hello everyone!');
        assert.equal((await decision(`${tier}-hello`)).charge.status, 'none');
        assert.equal((await review(channel, `${tier}-ad`, 'Want to buy viewers? viewerbuy.com')).actionTaken, true);
        await until(async () => (await decision(`${tier}-ad`))?.consequence.status === 'executed', `${tier} ban`);
        const paid = await decision(`${tier}-ad`);
        assert.equal(paid.reviewSource, 'spam_continuous');
        assert.ok(paid.charge.credits > 0);
        const users = mongo.connection.db.collection('users');
        await users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'free' } });
        assert.equal((await review(channel, `${tier}-downgrade`, 'Want to buy viewers?')).actionTaken, false);
        assert.equal(await decision(`${tier}-downgrade`), null, 'downgrade fences continuous reviews');
        await review(channel, `${tier}-new-first`, 'Hello!', 'newviewer');
        assert.equal((await decision(`${tier}-new-first`)).charge.status, 'none', 'downgrade keeps first review free');
    }

    await seed('spam-errors');
    for (const marker of ['UNCERTAIN', 'BORDERLINE', 'INVALID', 'UNAVAILABLE', 'TIMEOUT']) {
        assert.equal((await review('spam-errors', marker, `Want to buy viewers? ${marker}`, marker.toLowerCase())).actionTaken, false, marker);
        const row = await decision(marker);
        assert.equal(row.verdict, 'uncertain');
        assert.equal(row.charge.credits, 0);
        assert.equal(row.consequence.action, undefined);
    }

    await seed('spam-invited');
    await ChatHistory.addMessage('spam-invited', 'streamer', 'Please share your channel!', ['[STREAMER]'], 'twitch', 'invite', Date.now() - 100);
    assert.equal((await review('spam-invited', 'invited', 'Follow my channel at twitch.tv/mychannel')).actionTaken, false);
    assert.equal((await decision('invited')).context[0].isBroadcaster, true);
    assert.match((await decision('invited')).rule.semantic.policy, /explicitly permitted/);
    assert.equal((await review('spam-invited', 'ad-in-invited', 'Want to buy viewers? viewerbuy.com', 'seller')).actionTaken, true, 'channel invitation never permits selling viewers');
    await seed('spam-permit');
    await grantPermit('spam-permit', 60, 'permitted');
    const prior = reviews().length;
    await review('spam-permit', 'permitted', 'Want to buy viewers?', 'permitted');
    await runChatModeration('spam-permit', msg('moderator', 'Want to buy viewers?', 'mod'), { level: 7, tags: new Set(['mod']) });
    await runChatModeration('spam-permit', msg('broadcaster', 'Want to buy viewers?', 'spam-permit'), identity);
    assert.equal(reviews().length, prior, 'permits, moderators and broadcaster bypass');
    const pendingPermit = review('spam-permit', 'late-permit', 'Want to buy viewers? SLOW', 'late');
    await until(() => reviews().some(call => call.spamReview.includes('SLOW')), 'review in progress');
    await grantPermit('spam-permit', 60, 'late');
    assert.equal((await pendingPermit).actionTaken, false);
    assert.equal((await decision('late-permit')).consequence.status, 'cancelled');

    await seed('spam-disabled');
    await Settings.updateOne({ channelID: 'spam-disabled' }, { $set: { enabled: false } });
    assert.equal((await review('spam-disabled', 'master-off', 'Want to buy viewers?')).actionTaken, false);
    assert.equal(await decision('master-off'), null);
    await seed('spam-setting-off', 'free', { enabled: false, reviewAllMessages: false });
    assert.equal((await review('spam-setting-off', 'spam-off', 'Want to buy viewers?')).actionTaken, false);
    assert.equal(await decision('spam-off'), null);
    await seed('spam-policy-change');
    const pendingPolicy = review('spam-policy-change', 'policy-change', 'Want to buy viewers? SLOW');
    await until(() => reviews().filter(call => call.spamReview.includes('SLOW')).length === 2, 'policy review in progress');
    await Settings.updateOne({ channelID: 'spam-policy-change' }, { $inc: { settingsVersion: 1 } });
    assert.equal((await pendingPolicy).actionTaken, false);
    assert.equal((await decision('policy-change')).consequence.status, 'cancelled');

    // Old moderation remains available when ad protection is disabled.
    const caps = buildDefaultModerationRules()[0];
    await Settings.updateOne({ channelID: 'spam-setting-off' }, { $set: { rules: [caps] } });
    await invalidateModerationSettingsCache('spam-setting-off');
    assert.equal((await review('spam-setting-off', 'caps-legacy', 'THIS IS A LONG SHOUT')).actionTaken, true);
    await until(async () => (await decision('caps-legacy'))?.consequence.status === 'executed', 'legacy action');
    assert.equal((await decision('caps-legacy')).consequence.action, 'warn');

    if (process.env.SAAS_TARGET === 'api') {
        await redis.hSet('token:spam-owner', { id: 'spam-free', login: 'spam-free', display_name: 'Owner' });
        await redis.hSet('token:paid-owner', { id: 'spam-premium', login: 'spam-premium', display_name: 'Owner' });
        await mongo.connection.db.collection('users').updateOne({ 'accounts.id': 'spam-premium' }, { $set: { plan_tier: 'premium' } });
        const api = (method, path, body, token = 'spam-owner') => fetch(`http://127.0.0.1:3000/moderation/${path}`, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        await until(async () => (await api('GET', 'spam-free/settings')).status === 200, 'API ready');
        assert.equal((await api('GET', 'spam-free/settings', null, null)).status, 401);
        const settings = await (await api('GET', 'spam-free/settings')).json();
        assert.deepEqual(settings.data.spamProtection, { enabled: true, reviewAllMessages: false, categories: DEFAULT_SPAM_CATEGORIES, thresholdPercent: 90 });
        assert.equal((await api('PUT', 'spam-free/settings', { enabled: true, rules: [], spamProtection: { enabled: true, reviewAllMessages: true } })).status, 403);
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: { enabled: 'yes', reviewAllMessages: false } })).status, 400);
        assert.equal((await api('PUT', 'spam-free/settings', { enabled: true, rules: [], spamProtection: { enabled: false, reviewAllMessages: false } })).status, 200);
        assert.equal((await (await api('GET', 'spam-free/settings')).json()).data.spamProtection.enabled, false);
        assert.equal((await api('PUT', 'spam-free/settings', { enabled: true, rules: [], spamProtection: { enabled: true, reviewAllMessages: false } })).status, 200);
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [{ ...caps, id: SPAM_RULE_ID }] })).status, 400);
        const view = await (await api('GET', 'spam-free/decisions')).json();
        assert.ok(view.data.decisions.some(row => row.reviewSource === 'first_message' && row.charge.credits === 0));
        assert.equal((await api('GET', 'spam-free/settings', null, 'paid-owner')).status, 403);
        assert.equal((await api('PUT', 'spam-premium/settings', { enabled: true, rules: [], spamProtection: { enabled: true, reviewAllMessages: true } }, 'paid-owner')).status, 200);
        const protection = { enabled: true, reviewAllMessages: false, categories: ['ads'], thresholdPercent: 90 };
        for (const invalid of [{ categories: ['unknown'] }, { categories: ['ads', 'ads'] }, { categories: null }, { thresholdPercent: 79 }, { thresholdPercent: 101 }, { thresholdPercent: '90' }]) {
            assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: { ...protection, ...invalid } })).status, 400);
        }
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: { ...protection, thresholdPercent: 85 } })).status, 403);
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: protection })).status, 200);
        assert.deepEqual((await (await api('GET', 'spam-free/settings')).json()).data.spamProtection.categories, ['ads']);
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: { enabled: true, reviewAllMessages: false } })).status, 200);
        assert.deepEqual((await (await api('GET', 'spam-free/settings')).json()).data.spamProtection.categories, ['ads'], 'legacy client preserves selected categories');
        assert.equal((await api('PUT', 'spam-premium/settings', { rules: [], spamProtection: { ...protection, categories: ['profanity', 'insults'], thresholdPercent: 85 } }, 'paid-owner')).status, 200);
        const paidSettings = (await (await api('GET', 'spam-premium/settings', null, 'paid-owner')).json()).data.spamProtection;
        assert.deepEqual(paidSettings.categories, ['profanity', 'insults']);
        assert.equal(paidSettings.thresholdPercent, 85);
        assert.equal((await api('PUT', 'spam-free/settings', { rules: [], spamProtection: { ...protection, categories: [] } })).status, 200);

    }

    // Score each category separately and enforce only the channel's selected set.
    await seed('spam-selected', 'free', { enabled: true, reviewAllMessages: false, categories: ['ads'] });
    assert.equal((await review('spam-selected', 'disabled-selfpromo', 'Follow my channel at twitch.tv/mine', 'promo')).actionTaken, false);
    assert.equal((await decision('disabled-selfpromo')).scores.self_promotion, undefined);
    assert.equal((await review('spam-selected', 'disabled-profanity', 'What a damn game', 'swear')).actionTaken, false);
    assert.equal((await decision('disabled-profanity')).scores.profanity, undefined);
    assert.equal((await review('spam-selected', 'selected-ad', 'Buy my service now!', 'seller')).actionTaken, true);
    await until(async () => (await decision('selected-ad'))?.consequence.status === 'executed', 'selected category ban');
    for (const [category, text] of [['spam', 'SCAM SPAM claim a fake prize'], ['self_promotion', 'Follow my channel'], ['profanity', 'What a damn game'], ['insults', 'You are a worthless idiot']]) {
        await seed(`only-${category}`, 'free', { enabled: true, reviewAllMessages: false, categories: [category] });
        assert.equal((await review(`only-${category}`, `only-${category}`, text, category)).actionTaken, true, category);
        assert.equal((await decision(`only-${category}`)).scores[category], 0.995);
        assert.equal(Object.keys((await decision(`only-${category}`)).scores).length, 3);
    }
    await seed('spam-none', 'free', { enabled: true, reviewAllMessages: true, categories: [] });
    assert.equal((await review('spam-none', 'none-ad', 'Want to buy viewers?', 'not-consumed')).actionTaken, false);
    assert.equal(await decision('none-ad'), null);
    assert.equal(await Chatters.findById(chatterMarkerID('spam-none', 'not-consumed')), null, 'no categories does not consume first review');
    await seed('spam-safe');
    assert.equal((await review('spam-safe', 'safe-wins', 'Want to buy viewers? SAFE-WINS')).actionTaken, false);
    assert.equal((await decision('safe-wins')).verdict, 'allow');
    assert.equal((await decision('safe-wins')).scores.safe, 0.99);
    assert.equal((await review('spam-safe', 'tied', 'Want to buy viewers? TIED', 'tied')).actionTaken, false);
    assert.equal((await decision('tied')).verdict, 'uncertain');
    await seed('spam-threshold', 'premium', { enabled: true, reviewAllMessages: true, categories: ['ads'], thresholdPercent: 85 });
    assert.equal((await review('spam-threshold', 'custom-first', 'Want to buy viewers? BORDERLINE')).actionTaken, true);
    assert.equal((await decision('custom-first')).charge.credits, 0, 'paid first review remains free with custom threshold');
    await mongo.connection.db.collection('users').updateOne({ 'accounts.id': 'spam-threshold' }, { $set: { plan_tier: 'free' } });
    assert.equal((await review('spam-threshold', 'downgraded-threshold', 'Want to buy viewers? BORDERLINE', 'another')).actionTaken, false);
    assert.equal((await decision('downgraded-threshold')).rule.semantic.thresholdPercent, 90, 'free downgrade uses default threshold');
    // Existing channels with no new fields acquire enabled defaults without migration.
    await seed('spam-old-settings');
    await Settings.updateOne({ channelID: 'spam-old-settings' }, { $unset: { spamProtection: '' } });
    assert.equal((await review('spam-old-settings', 'old-settings-ad', 'Want to buy viewers?')).actionTaken, true);

    for (let i = 0; i < 30; i++) assert.equal(await claimSpamReviewBudget('budget-channel'), true);
    assert.equal(await claimSpamReviewBudget('budget-channel'), false);
    const window = Math.floor(Number(await redis.eval("return redis.call('TIME')[1]", { keys: [], arguments: [] })) / 60);
    await redis.hSet('moderation:spam-budget:global', { window: String(window), count: '300' });
    await seed('spam-capped');
    const reviewCount = reviews().length;
    assert.equal((await review('spam-capped', 'budget-skipped', 'Want to buy viewers?')).actionTaken, false);
    assert.equal(reviews().length, reviewCount);
    assert.equal(await decision('budget-skipped'), null, 'budget blocks queue admission');
    assert.equal(await Decisions.countDocuments({ reviewSource: 'first_message', 'charge.status': { $ne: 'none' } }), 0);
    assert.equal(await Actions.countDocuments({ ruleID: SPAM_RULE_ID, action: { $ne: 'ban' } }), 0);
    console.log('PASS free first-message reviews, zero credits, immediate bans, durable/atomic tracking, Premium/Pro continuation, downgrades, quotes/context, category selection, safe veto/ties, paid thresholds/downgrades, permits, policy cancellation, failure fallback, legacy rules, API authorization and bounded admission');
} finally {
    if (worker) { worker.kill('SIGTERM'); await new Promise(resolve => worker.once('exit', resolve)); }
}
process.exit(0);
