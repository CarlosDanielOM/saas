// Cron target only: run with saas-ops, disposable Mongo/Redis and spam-protection-fixtures.
// The full spam-protection check loads the chat handler next to every supervised worker and exceeds
// the cron candidate's memory limit. This one queues decisions the way the handler does and lets the
// supervised semantic-moderation worker of the candidate review them: model routing, the broadcaster
// named to the classifier, the overall-score guard, provider cost and which reviews are charged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { ModerationDecision: Decisions } = await import('/app/dist/schemas/moderation_decision.schema.js');
const { createModerationDecision } = await import('/app/dist/utils/moderation/decisions.js');
const { SPAM_RULE_ID, spamRuleForContext } = await import('/app/dist/utils/moderation/spam.js');

const LUNA = 'openai/gpt-6-luna-decisions';
const mongo = await getMongoDBConnection('spam-protection-cron-check');
const redis = await getDragonflyClient('spam-protection-cron-check');
await Decisions.init();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => { try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.spamReview); } catch { return []; } };
const credits = (used, balance, status = 'available') => JSON.stringify({ version: 3, used, limit: 1000, balance, available: true, status });
async function seed(channel, tier, name = channel, credit = credits(0, 1000)) {
    await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name }], plan_tier: tier, polar_sh_customer_id: `customer-${channel}` });
    await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name, plan_tier: tier });
    await redis.set(`twitch:${channel}:ai:credits`, credit);
}
// What the chat handler stores for a first message: unsaved default settings (version 0) and a 4-second deadline.
async function review(channel, id, text, { login = '', source = 'first_message', context = [] } = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const messageID = `${id}-${attempt}`;
        await createModerationDecision({ channelID: channel, userID: `viewer-${id}`, username: `viewer_${id}`, messageID, messageText: text, ruleID: SPAM_RULE_ID,
            rule: spamRuleForContext(context, {}, login), settingsVersion: 0, matches: [], context, mode: 'semantic', reviewSource: source, deadline: new Date(Date.now() + 4000) });
        for (let i = 0; i < 60; i++) {
            const row = await Decisions.findOne({ messageID }).lean();
            // The candidate starts every worker at once. A review that expired before the worker
            // was ready (maintenance marks it `timeout`) is simply asked again.
            if (row?.state === 'completed' && row.status === 'timeout' && !text.includes('TIMEOUT')) break;
            if (row?.state === 'completed') return row;
            await sleep(100);
        }
    }
    throw new Error(`Timeout: ${id} was never reviewed by the supervised worker`);
}

await seed('cron-free', 'free', 'stored_name');
await seed('cron-paid', 'premium');
await seed('cron-empty', 'pro', 'cron_empty', credits(1000, 0, 'exhausted'));
await redis.set('twitch:cron-empty:ai:credits:exhausted', '1');

// Free: Luna, banned, never charged; the provider charge on our own key is kept as the cost.
const ad = await review('cron-free', 'ad', 'Want to buy more viewers? Visit viewerbuy . com!', { login: 'New_Name' });
assert.equal(ad.model, LUNA);
assert.equal(ad.verdict, 'violation');
assert.equal(ad.status, 'completed');
assert.equal(ad.charge.credits, 0);
assert.equal(ad.charge.status, 'none');
assert.equal(ad.cost, 0.000155);
// The login from the chat event wins over the stored account name; the stored name is the fallback.
assert.equal(calls().find(call => call.spamReview.startsWith('Want to buy more viewers?'))?.broadcaster, 'new_name');
await review('cron-free', 'fallback', 'Hello from the fallback');
assert.equal(calls().find(call => call.spamReview === 'Hello from the fallback')?.broadcaster, 'stored_name');
// A verified invitation replaces the self-promotion question; no name is added to it.
const invitation = [{ messageID: 'invite', username: 'New_Name', message: 'Please share your channel links!', timestamp: Date.now() - 1000, isBroadcaster: true }];
const invited = await review('cron-free', 'invited', 'Follow my channel twitch.tv/mine', { login: 'new_name', context: invitation });
assert.equal(invited.verdict, 'allow');
assert.equal(calls().find(call => call.spamReview === 'Follow my channel twitch.tv/mine')?.broadcaster, null);

// A category the overall answer contradicts (real Luna scores: 0.99 against 0.04) is never a violation.
const contradicted = await review('cron-free', 'contradict', 'Juega mis cartas CONTRADICT');
assert.equal(contradicted.verdict, 'uncertain');
assert.equal(contradicted.status, 'uncertain');
assert.equal(contradicted.scores.violation, 0.99);
assert.ok(Math.abs(contradicted.scores.safe - 0.96) < 1e-9);

// Paid with credits: the same model, and the review is charged from its input tokens.
const paid = await review('cron-paid', 'paid', 'Hello everyone!');
assert.equal(paid.model, LUNA);
assert.equal(paid.verdict, 'allow');
assert.ok(paid.charge.credits > 0);
assert.equal(paid.charge.customerID, 'customer-cron-paid');
// Paid without credits: the Lite fallback, never charged.
const empty = await review('cron-empty', 'empty', 'Hello everyone!');
assert.equal(empty.model, 'respan/span-01-lite');
assert.equal(empty.charge.credits, 0);

// Failures stay fail-open and free.
for (const marker of ['INVALID', 'UNAVAILABLE']) {
    const failed = await review('cron-paid', marker.toLowerCase(), `Want to buy viewers? ${marker}`);
    assert.equal(failed.verdict, 'uncertain', marker);
    assert.equal(failed.charge.credits, 0, marker);
}
assert.equal(await Decisions.countDocuments({ channelID: 'cron-free', 'charge.credits': { $gt: 0 } }), 0, 'a Free channel is never charged');
assert.ok(calls().every(call => [LUNA, 'respan/span-01-lite'].includes(call.model)));
console.log('PASS cron semantic worker: Luna on Free and paid, Lite fallback without credits, broadcaster from the chat event with stored-name fallback, no name under an invitation, overall-score guard, own-key cost recorded, Free never charged, fail-open errors');
// Preloaded provider fixtures keep handles open; leave explicitly once everything passed.
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
