// API target only: scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-owner-edits-api.mjs
// The owner console's edits "like the database" (admin_site/channel_edit.route.ts with `override`) and referrals
// (admin_site/referrals.route.ts):
// 1. Commands: built-in trigger/reply/description editable and deletable, blocks on a free plan, invalid blocks
//    refused with a message, plan cooldown rules and the one 0-second slot skipped, command ⇄ keyword with the
//    command cache and keyword index refreshed, a used trigger still 409, unknown fields 400, owner only.
// 2. Twitch event settings: any stored chat field, typed; a plan-gated event and "can't be disabled" events save;
//    identity fields and bad types refused.
// 3. Referrals: who invited them / their codes / people they invited (credits, cursor pages); set by hand =
//    `manual` (inviter's oldest active code by default, chosen code, no code), 409 before moving someone,
//    remove, self/unknown refused; the 10% discount only for sign-ups with a code; the inviter's own ledger
//    lists people added by hand.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { CommandsSchema as Commands } from '/app/dist/schemas/commands.schema.js';
import Eventsubs from '/app/dist/schemas/eventsub.schema.js';
import { ReferralCodeSchema as Codes } from '/app/dist/schemas/referral_code.schema.js';
import { CreditTransactionSchema as Credits } from '/app/dist/schemas/credit_transaction.schema.js';
import { importCommandText } from '/app/dist/utils/ast_blocks/index.js';
import { getBillingContext } from '/app/dist/utils/billing.js';
import { getReferralPeoplePage } from '/app/dist/utils/referral_ledger.js';

const mongo = await getMongoDBConnection('owner-edits-check');
const redis = await getDragonflyClient('owner-edits-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, tries = 150) { for (let i = 0; i < tries; i++) { try { if (await fn()) return; } catch { /* not ready */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:edits-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:edits-streamer', { id: '9100001', login: 'free_fjord', display_name: 'free_fjord' });
const BASE = 'http://127.0.0.1:3000/admin-site';
const call = async (method, path, body, token = 'edits-owner') => {
    const res = await fetch(`${BASE}/${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined || method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, cache: res.headers.get('cache-control') };
};
const ok = async (method, path, body) => {
    const res = await call(method, path, body);
    assert.equal(res.status, 200, `${method} ${path}: ${res.text.slice(0, 300)}`);
    assert.equal(res.cache, 'no-store');
    return res.json;
};
const refused = async (status, method, path, body, pattern) => {
    const res = await call(method, path, body);
    assert.equal(res.status, status, `${method} ${path}: ${res.text.slice(0, 300)}`);
    if (pattern) assert.match(res.json?.message ?? '', pattern, `${method} ${path} message`);
    return res.json;
};

// ---- People (fictional) ----
const user = (login, id, extra = {}) => Users.create({ name: login, email: `${login}@example.invalid`, plan_tier: 'free',
    accounts: [{ type: 'twitch', id, name: login, actived: true, chat_enabled: true, has_permissions: true }], ...extra });
const fjord = await user('free_fjord', '9100001');
const lantern = await user('lantern_ref', '9100002', { plan_tier: 'pro' });
const mist = await user('mist_person', '9100003');
await Codes.create([
    { code: 'lantern', owner: lantern._id, label: 'Main link' },
    { code: 'lamp2', owner: lantern._id, label: 'Second' },
    { code: 'oldcode', owner: lantern._id, active: false },
]);
// Creation dates set directly (timestamps would stamp "now"): the oldest active code is the default.
for (const [code, at] of [['oldcode', '2025-12-01'], ['lantern', '2026-01-01'], ['lamp2', '2026-02-01']]) {
    await Codes.collection.updateOne({ code }, { $set: { createdAt: new Date(at) } });
}
const tide = await user('tide_person', '9100004', { referrerId: lantern._id, referralCodeUsed: 'lantern' });
const orphan = await user('orphan_person', '9100005', { referrerId: new mongo.Types.ObjectId(), referralCodeUsed: 'gone' });
await Credits.create({ user: lantern._id, type: 'referral_bonus', amount: 100, metadata: { referredUserId: tide._id, referralCodeUsed: 'lantern' } });

try {
    await until(async () => (await call('GET', 'users/9100001/referrals')).status === 200, 'API ready');

    // ---------------------------------------------------------------- 1. Commands
    const [so, lurk, hello] = await Commands.create([
        { channelID: '9100001', channel: 'free_fjord', name: 'Shoutout', cmd: 'so', func: 'shoutout', message: 'old so', cooldown: 5, enabled: true, userLevel: 7, reserved: true, description: 'built-in' },
        { channelID: '9100001', channel: 'free_fjord', name: 'Lurk', cmd: 'lurk', func: 'custom', message: '$(user) lurks', cooldown: 30, enabled: true, userLevel: 1 },
        { channelID: '9100001', channel: 'free_fjord', name: 'Hello', cmd: 'hello', func: 'custom', message: 'Hi', cooldown: 20, enabled: true, userLevel: 1 },
    ]);
    for (const [method, path] of [['PUT', `users/9100001/commands/${lurk._id}`], ['POST', 'users/9100001/commands'], ['DELETE', `users/9100001/commands/${lurk._id}`], ['PATCH', 'users/9100001/eventsubs/0123456789abcdef01234567'], ['GET', 'users/9100001/referrals'], ['PUT', 'users/9100001/referrer']]) {
        assert.equal((await call(method, path, {}, null)).status, 401, `${method} ${path} without sign-in`);
        assert.equal((await call(method, path, {}, 'edits-streamer')).status, 403, `${method} ${path} as a streamer`);
    }

    // Built-in: trigger, reply and description editable.
    await redis.set('9100001:commands:so', 'cached');
    let row = (await ok('PUT', `users/9100001/commands/${so._id}`, { cmd: 'shout', message: 'new so text', description: 'edited by owner' })).data;
    assert.deepEqual([row.cmd, row.message, row.description, row.reserved], ['shout', 'new so text', 'edited by owner', true]);
    assert.equal(await redis.exists('9100001:commands:so'), 0, 'old trigger cache cleared');

    // Blocks on a free plan; invalid blocks refused with a message.
    const { root } = importCommandText('Hello $(user)!');
    row = (await ok('PUT', `users/9100001/commands/${lurk._id}`, { authoring: 'blocks', blocks: root })).data;
    assert.equal(row.authoring, 'blocks'); assert.ok(row.blocks, 'block tree returned for editing'); assert.match(row.message, /Hello/);
    await refused(400, 'PUT', `users/9100001/commands/${lurk._id}`, { authoring: 'blocks', blocks: { nope: true } });
    // The stored shape the list returns (`{ v, root }`) is accepted back as is.
    row = (await ok('PUT', `users/9100001/commands/${lurk._id}`, { authoring: 'blocks', blocks: row.blocks })).data;
    assert.equal(row.authoring, 'blocks', 'stored wrapper accepted');
    // Back to text.
    row = (await ok('PUT', `users/9100001/commands/${lurk._id}`, { authoring: 'text', message: 'plain again' })).data;
    assert.deepEqual([row.authoring, row.message, row.blocks], ['text', 'plain again', null]);

    // Plan cooldown rules and the one 0-second slot don't apply to the owner.
    await ok('PUT', `users/9100001/commands/${lurk._id}`, { cooldown: 0 });
    await ok('PUT', `users/9100001/commands/${hello._id}`, { cooldown: 0 });
    assert.equal(await Commands.countDocuments({ channelID: '9100001', cooldown: 0 }), 2);
    await ok('PUT', `users/9100001/commands/${so._id}`, { cooldown: 1 });

    // Custom rule as JSON, then back to a level.
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { permissionExpression: { role: 'vip' } })).data;
    assert.equal(row.permissionMode, 'tags'); assert.deepEqual(row.permissionExpression, { role: 'vip' });
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { permissionExpression: null, userLevel: 7, userLevelName: 'mod' })).data;
    assert.deepEqual([row.permissionMode, row.userLevel, row.permissionExpression], ['level', 7, null]);
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { permissionExpression: { nonsense: 1 } }, /permission/i);

    // Runs: a plain reply ⇄ a built-in action.
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { func: 'promo' })).data;
    assert.equal(row.runsBuiltIn, true);
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { func: 'custom' })).data;
    assert.equal(row.runsBuiltIn, false);

    // Command → keyword → command, caches refreshed both ways.
    await redis.set('9100001:commands:hello', 'cached');
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { activation: 'keyword', keywordSettings: { matchMode: 'anywhere' } })).data;
    assert.deepEqual([row.activation, row.keywordMatch, row.func], ['keyword', 'anywhere', 'custom']);
    assert.equal(await redis.exists('9100001:commands:hello'), 0, 'command cache cleared when it became a keyword');
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { activation: 'command' })).data;
    assert.deepEqual([row.activation, row.keywordMatch], ['command', null]);
    assert.equal((await Commands.findById(hello._id).lean()).keywordSettings, undefined, 'keyword settings removed');

    // Integrity stays: a used trigger, unknown fields, bad types.
    await refused(409, 'PUT', `users/9100001/commands/${hello._id}`, { cmd: 'lurk' }, /already exists/);
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { channelID: '1' }, /Unknown command fields: channelID/);
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { cooldown: -1 }, /Cooldown/);
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { enabled: 'yes' });
    await refused(404, 'PUT', 'users/9100001/commands/0123456789abcdef01234567', { enabled: false });
    await refused(404, 'PUT', 'users/abc/commands/0123456789abcdef01234567', { enabled: false });

    // Cooldown set here is used as stored (also below a keyword's plan minimum); a site edit brings back the rules.
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { cooldown: 0 })).data;
    assert.equal(row.cooldownOverride, true);
    const siteEdit = await fetch(`http://127.0.0.1:3000/commands/9100001/${hello._id}`, { method: 'PUT',
        headers: { Authorization: 'Bearer edits-streamer', 'Content-Type': 'application/json' }, body: JSON.stringify({ cooldown: 30 }) });
    assert.equal(siteEdit.status, 200, await siteEdit.text());
    assert.equal((await Commands.findById(hello._id).lean()).cooldownOverride, false, 'a site edit of the cooldown clears the override');

    // Triggers chat can actually match: "!" stripped, symbols refused, a keyword phrase needs a new trigger to become a command.
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { cmd: 'my_cmd' }, /can't be typed as a chat command/);
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { activation: 'keyword', cmd: 'hello there' })).data;
    assert.deepEqual([row.activation, row.cmd, row.keywordMatch], ['keyword', 'hello there', 'start'], 'no match sent: starts with');
    await refused(400, 'PUT', `users/9100001/commands/${hello._id}`, { activation: 'command' }, /"hello there" can't be typed as a chat command/);
    row = (await ok('PUT', `users/9100001/commands/${hello._id}`, { activation: 'command', cmd: '!hellothere' })).data;
    assert.deepEqual([row.activation, row.cmd], ['command', 'hellothere']);

    // Create with only a trigger; delete a built-in.
    await refused(400, 'POST', 'users/9100001/commands', { cmd: 'my_cmd' }, /letters and numbers/);
    assert.equal((await ok('POST', 'users/9100001/commands', { cmd: '!banner' })).data.cmd, 'banner', 'leading ! stripped');
    row = (await ok('POST', 'users/9100001/commands', { cmd: 'discord', message: 'join us' })).data;
    assert.deepEqual([row.cmd, row.name, row.func, row.channel, row.message], ['discord', 'discord', 'custom', 'free_fjord', 'join us']);
    await refused(409, 'POST', 'users/9100001/commands', { cmd: 'discord' });
    await refused(404, 'POST', 'users/9999999/commands', { cmd: 'x' }, /Channel not found/);
    const deleted = await ok('DELETE', `users/9100001/commands/${so._id}`);
    assert.deepEqual(deleted.data, { id: String(so._id), cmd: 'shout' });
    assert.equal(await Commands.exists({ _id: so._id }), null, 'built-in deleted');

    // Seeded defaults the owner changed keep working with the site's own seeding (the public list seeds the basic
    // defaults on every load for a channel without full access).
    await user('basic_chan', '9100009', { accounts: [{ type: 'twitch', id: '9100009', name: 'basic_chan', actived: false, chat_enabled: true, has_permissions: false }] });
    const publicList = () => fetch('http://127.0.0.1:3000/commands/9100009');
    assert.equal((await publicList()).status, 200);
    const seeded = await Commands.find({ channelID: '9100009', reserved: true }).lean();
    assert.ok(seeded.length >= 2, 'basic defaults seeded');
    const total = await Commands.countDocuments({ channelID: '9100009' });
    await ok('PUT', `users/9100009/commands/${seeded[0]._id}`, { activation: 'keyword', keywordSettings: { matchMode: 'start' } });
    await ok('PUT', `users/9100009/commands/${seeded[1]._id}`, { cmd: 'renamed', func: 'custom' });
    for (let i = 0; i < 2; i++) assert.equal((await publicList()).status, 200, 'the public list still answers after the owner changed seeded defaults');
    assert.equal(await Commands.countDocuments({ channelID: '9100009' }), total, 'no duplicate defaults');

    // The list carries what the editor needs.
    const list = (await ok('GET', 'users/9100001/commands?limit=50')).data;
    assert.ok(list.meta.builtInActions.includes('promo') && list.meta.builtInActions.includes('vip'));
    assert.ok(list.rows.every(item => 'blocks' in item && 'permissionExpression' in item && 'runsBuiltIn' in item));
    console.log('PASS commands: built-in trigger/reply/description + delete, blocks on free plan (invalid refused), cooldown rules skipped, rule JSON ⇄ level, Runs, command ⇄ keyword with caches, integrity (409/400/404), owner only');

    // ---------------------------------------------------------------- 2. Twitch event settings
    const base = { status: 'enabled', version: '1', created_at: '2026-11-01T00:00:00Z', transport: { method: 'webhook', callback: 'https://example.test/eventsub' }, cost: 0, channel: 'free_fjord', channelID: '9100001' };
    const [raid, online, adBreak] = await Eventsubs.create([
        { ...base, id: 'sub-raid', type: 'channel.raid', condition: { to_broadcaster_user_id: '9100001' }, message: 'raid!' },
        { ...base, id: 'sub-online', type: 'stream.online', condition: { broadcaster_user_id: '9100001' }, message: 'live!' },
        { ...base, id: 'sub-ad', type: 'channel.ad_break.begin', condition: { broadcaster_user_id: '9100001' }, message: 'ads' },
    ]);
    // A plan-gated event (Pro) on this free channel.
    await db.collection('events').insertOne({ name: 'Ad breaks', type: 'channel.ad_break.begin', version: '1', plan_tier: 'pro', config: [], description: { EN: 'x', ES: 'x' } });
    let sub = (await ok('PATCH', `users/9100001/eventsubs/${raid._id}`, { delay: 15, todayFollows: true, temporalBanMessage: 'bye', minViewers: 0 })).data;
    assert.deepEqual([sub.settings.delay, sub.settings.todayFollows, sub.settings.temporalBanMessage, sub.settings.minViewers], [15, true, 'bye', 0]);
    sub = (await ok('PATCH', `users/9100001/eventsubs/${online._id}`, { enabled: false })).data;
    assert.equal(sub.enabled, false, '"can\'t be disabled" events turn off for the owner');
    sub = (await ok('PATCH', `users/9100001/eventsubs/${adBreak._id}`, { message: 'Ad time', endEnabled: true, endMessage: 'Back!' })).data;
    assert.deepEqual([sub.message, sub.settings.endEnabled, sub.settings.endMessage], ['Ad time', true, 'Back!'], 'plan-gated event saved');
    await refused(400, 'PATCH', `users/9100001/eventsubs/${raid._id}`, { type: 'channel.follow' }, /Not an editable setting: type/);
    await refused(400, 'PATCH', `users/9100001/eventsubs/${raid._id}`, { condition: {} }, /Not an editable setting/);
    await refused(400, 'PATCH', `users/9100001/eventsubs/${raid._id}`, { delay: '5' }, /Invalid delay/);
    await refused(400, 'PATCH', `users/9100001/eventsubs/${raid._id}`, { delay: 1.5 }, /Invalid delay/);
    await refused(400, 'PATCH', `users/9100001/eventsubs/${raid._id}`, {}, /Nothing to change/);
    const stored = await Eventsubs.findById(raid._id).lean();
    assert.deepEqual([stored.type, stored.condition, stored.id], ['channel.raid', { to_broadcaster_user_id: '9100001' }, 'sub-raid'], 'identity untouched');
    console.log('PASS eventsub settings: every stored field typed, plan-gated and "can\'t be disabled" events save for the owner, identity fields and bad types refused');

    // ---------------------------------------------------------------- 3. Referrals
    let ref = (await ok('GET', 'users/9100002/referrals')).data;
    assert.deepEqual(ref.person, { userId: String(lantern._id), login: 'lantern_ref', channelID: '9100002', plan: 'pro' });
    assert.equal(ref.referredBy, null);
    assert.deepEqual(ref.codes.map(code => [code.code, code.active]), [['oldcode', false], ['lantern', true], ['lamp2', true]]);
    assert.deepEqual(ref.referred.map(person => [person.login, person.code, person.source, person.creditsEarned]), [['tide_person', 'lantern', 'code', 100]]);
    assert.deepEqual([ref.referredTotal, ref.creditsEarnedTotal], [1, 100]);
    const tideView = (await ok('GET', 'users/9100004/referrals')).data;
    assert.deepEqual(tideView.referredBy, { userId: String(lantern._id), login: 'lantern_ref', channelID: '9100002', code: 'lantern', source: 'code', setAt: null, rewardsReferrer: true, discount: true });
    const orphanView = (await ok('GET', 'users/9100005/referrals')).data;
    assert.deepEqual([orphanView.referredBy.login, orphanView.referredBy.rewardsReferrer], [null, false], 'a deleted inviter');
    // A deleted inviter whose code survived: still no rewards (payouts check the account too).
    await Codes.create({ code: 'gone', owner: orphan.referrerId });
    assert.equal((await ok('GET', 'users/9100005/referrals')).data.referredBy.rewardsReferrer, false);

    // Add by hand: the inviter's oldest active code, no discount, rewards keep flowing.
    let set = await ok('PUT', 'users/9100003/referrer', { referrer: 'lantern_ref' });
    assert.match(set.message, /Now invited by lantern_ref \(code lantern\)/);
    assert.deepEqual([set.data.referredBy.login, set.data.referredBy.code, set.data.referredBy.source, set.data.referredBy.discount, set.data.referredBy.rewardsReferrer],
        ['lantern_ref', 'lantern', 'manual', false, true]);
    assert.ok(set.data.referredBy.setAt);
    const mistDoc = await Users.findById(mist._id);
    assert.deepEqual([String(mistDoc.referrerId), mistDoc.referralCodeUsed, mistDoc.referralSource], [String(lantern._id), 'lantern', 'manual']);
    // The discount: only for sign-ups with a code.
    assert.equal((await getBillingContext(mistDoc)).isReferralEligible, false, 'no 10% discount for a referrer added by hand');
    assert.equal((await getBillingContext(await Users.findById(tide._id))).isReferralEligible, true, 'sign-up with a code keeps the discount');
    // The inviter's own referrals page lists people added by hand.
    assert.ok((await getReferralPeoplePage(lantern._id, 0)).items.some(item => item.id === String(mist._id)));
    // Conversions per code come from completed reward receipts (each invited person once), not the code's old counter.
    for (const key of ['mist-order-1', 'mist-order-2']) {
        await Credits.create({ user: lantern._id, type: 'subscription_reward', amount: 50, appliedAt: new Date(), idempotencyKey: key,
            metadata: { referredUserId: mist._id, referralCodeUsed: 'lantern', rewardTargetType: 'referrer' } });
    }
    const lanternCode = (await ok('GET', 'users/9100002/referrals')).data.codes.find(code => code.code === 'lantern');
    assert.deepEqual([lanternCode.signups, lanternCode.conversions], [2, 2], 'tide (bonus) + mist (two renewals = one conversion)');

    // Choose a code; refuse codes that aren't theirs.
    set = await ok('PUT', 'users/9100003/referrer', { referrer: '9100002', code: 'lamp2', expectedReferrer: String(lantern._id) });
    assert.equal(set.data.referredBy.code, 'lamp2');
    // A stale page (it showed another inviter) writes nothing: removal and moves alike.
    await refused(409, 'PUT', 'users/9100003/referrer', { referrer: null, expectedReferrer: String(fjord._id) }, /changed since this page loaded/);
    await refused(409, 'PUT', 'users/9100003/referrer', { referrer: 'free_fjord', replace: true, expectedReferrer: null }, /changed since this page loaded/);
    await refused(400, 'PUT', 'users/9100003/referrer', { referrer: null, expectedReferrer: 'nope' }, /Invalid expectedReferrer/);
    assert.equal(String((await Users.findById(mist._id).lean()).referrerId), String(lantern._id), 'still under lantern_ref');
    await refused(400, 'PUT', 'users/9100003/referrer', { referrer: 'lantern_ref', code: 'nope' }, /has no code "nope"/);
    await refused(400, 'PUT', 'users/9100003/referrer', { referrer: 'lantern_ref', code: 'bad code!' }, /Invalid code/);
    await refused(400, 'PUT', 'users/9100003/referrer', { referrer: 'mist_person' }, /can't invite themselves/);
    await refused(404, 'PUT', 'users/9100003/referrer', { referrer: 'no_such_streamer' }, /No account/);
    await refused(400, 'PUT', 'users/9100003/referrer', { referrer: '' });

    // Moving someone already invited by another person needs a confirmation.
    const conflict = await refused(409, 'PUT', 'users/9100004/referrer', { referrer: 'free_fjord' }, /tide_person was invited by lantern_ref \(code lantern\)\. Confirm to move them\./);
    assert.ok(conflict);
    set = await ok('PUT', 'users/9100004/referrer', { referrer: 'free_fjord', replace: true });
    assert.match(set.message, /Now invited by free_fjord, without a code/);
    assert.deepEqual([set.data.referredBy.login, set.data.referredBy.code, set.data.referredBy.rewardsReferrer, set.data.referredBy.discount], ['free_fjord', null, false, false]);
    assert.equal((await getBillingContext(await Users.findById(tide._id))).isReferralEligible, false, 'moved by hand: no discount');
    assert.equal(await Credits.countDocuments({ user: lantern._id }), 3, 'rewards already paid stay');
    // Added by hand without a code: still in the new inviter's own list.
    assert.ok((await getReferralPeoplePage(fjord._id, 0)).items.some(item => item.id === String(tide._id)));

    // Remove.
    set = await ok('PUT', 'users/9100004/referrer', { referrer: null });
    assert.equal(set.data.referredBy, null);
    const removed = await Users.findById(tide._id).lean();
    assert.deepEqual([removed.referrerId, removed.referralCodeUsed, removed.referralSource], [null, null, null]);

    // Cursor pages of the people someone invited.
    for (const [index, name] of ['wave_a', 'wave_b', 'wave_c'].entries()) {
        const wave = await user(name, `91001${index}0`, { referrerId: lantern._id, referralCodeUsed: 'lamp2' });
        await Users.collection.updateOne({ _id: wave._id }, { $set: { created_at: new Date(Date.now() - (index + 1) * 60_000) } });
    }
    const all = (await ok('GET', 'users/9100002/referrals?limit=100')).data;
    assert.equal(all.referredTotal, 4);
    const seen = [];
    let cursor = null;
    do {
        const page = (await ok('GET', `users/9100002/referrals?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).data;
        assert.ok(page.referred.length <= 2);
        seen.push(...page.referred.map(person => person.userId));
        cursor = page.next;
    } while (cursor);
    assert.deepEqual(seen, all.referred.map(person => person.userId), 'pages follow the list without gaps or repeats');
    await refused(400, 'GET', 'users/9100002/referrals?cursor=nope');
    await refused(404, 'GET', 'users/9999999/referrals');
    for (const path of ['users/9100002/referrals', 'users/9100004/referrals']) {
        const text = (await call('GET', path)).text;
        for (const secret of ['example.invalid', 'email', 'polar_sh_customer_id', 'token_balance']) assert.equal(text.includes(secret), false, `${path} leaks ${secret}`);
    }
    console.log('PASS referrals: inviter/codes/invited with credits, set by hand = manual (oldest active code, chosen code, none), 409 before moving, remove, self/unknown/bad codes refused, no discount for manual, inviter ledger lists them, cursor pages, no private data');
    console.log('PASS admin console owner edits + referrals API');
    process.exit(0);
} catch (error) {
    console.error(error);
    process.exit(1);
}
