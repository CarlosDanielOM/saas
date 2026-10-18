import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';

await getMongoDBConnection('admin-credit-chat-check');
const redis = await getDragonflyClient('admin-credit-chat-check');
const channelID = '99008801';
const user = await Users.create({ name: 'creditfixture', language: 'en',
    polar_sh_customer_id: '11111111-1111-4111-8111-111111111111',
    accounts: [{ type: 'twitch', id: channelID, name: 'creditfixture', actived: false }] });
for (const login of ['cdom201', 'ordinary']) await redis.hSet(`token:${login}`, {
    id: login === 'cdom201' ? '99008802' : '99008803', login, display_name: login,
});
await redis.set('app:twitch:token', 'dummy');
const directory = '/tmp/saas-fixtures';
const controls = value => fs.writeFileSync(`${directory}/controls.json`, JSON.stringify(value));
const calls = () => fs.existsSync(`${directory}/calls.jsonl`)
    ? fs.readFileSync(`${directory}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const request = async (body, token = 'cdom201', channel = channelID) => {
    const response = await fetch(`http://127.0.0.1:3000/admin-site/users/${channel}/ai-credits/grant`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits: 25000, reason: 'PRIVATE REIMBURSEMENT $(command)', ...body }),
    });
    return { status: response.status, ...await response.json() };
};
controls({});
const initial = calls().length;
assert.equal((await request({}, 'ordinary')).status, 403);
for (const body of [{ credits: 0 }, { credits: -1 }, { credits: 5000001 }, { announceInChat: 'false' }]) {
    assert.equal((await request(body)).status, 400);
}
assert.equal((await request({}, 'cdom201', 'missing')).status, 404);
assert.equal(calls().length, initial, 'rejected requests never grant or announce');
const first = await request({});
assert.equal(first.status, 200);
assert.equal(first.data.chatAnnouncement, 'sent', 'omitted option defaults to announcement');
assert.equal(first.data.after.balance, first.data.before.balance + 25000);
assert.equal(calls().filter(c => c.chat).length, 1);
assert.deepEqual(calls().filter(c => c.chat)[0].chat, { broadcaster_id: channelID,
    sender_id: '698614112', message: '🎁 An admin added 25,000 AI credits to this channel. The credits are ready to use!' });
assert.equal((await request({ announceInChat: false })).data.chatAnnouncement, 'skipped');
assert.equal(calls().filter(c => c.chat).length, 1);
await Users.updateOne({ _id: user._id }, { $set: { language: 'es' } });
assert.equal((await request({ announceInChat: true })).data.chatAnnouncement, 'sent');
assert.equal(calls().filter(c => c.chat).at(-1).chat.message,
    '🎁 Un administrador añadió 25.000 créditos de IA a este canal. ¡Ya están disponibles!');
for (const failure of ['chatFail', 'chatHeld', 'chatThrow']) {
    controls({ [failure]: true });
    const before = calls().filter(c => c.grant).length;
    const result = await request({ announceInChat: true });
    assert.equal(result.status, 200, 'chat failure must not imply grant failure');
    assert.equal(result.data.granted, 25000);
    assert.equal(result.data.chatAnnouncement, 'failed');
    assert.equal(calls().filter(c => c.grant).length, before + 1, 'one grant despite chat failure');
}
controls({ grantFail: true });
const chatsBefore = calls().filter(c => c.chat).length;
assert.equal((await request({})).status, 502);
assert.equal(calls().filter(c => c.chat).length, chatsBefore, 'failed grants never announce');
assert.ok(calls().filter(c => c.chat).every(c => !/PRIVATE|REIMBURSEMENT|cdom201|command/.test(c.chat.message)));
console.log('PASS admin credits: authorization, validation, EN/ES announcements, skip, moderation/network failures, private reason, and failed-grant suppression');
process.exit(0);
