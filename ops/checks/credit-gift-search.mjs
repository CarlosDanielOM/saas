// Runs inside the isolated API candidate with disposable Mongo/Redis and provider mocks.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';

await getMongoDBConnection('gift-search-check');
const redis = await getDragonflyClient('gift-search-check');
let channelId = 900000;
async function user(login, type = 'twitch', id = String(++channelId)) {
    return Users.create({ name: login, email: `${login}@example.invalid`,
        accounts: [{ type, id, name: login, actived: false, chat_enabled: false, has_permissions: false }] });
}
const buyer = await user('lunabuyer');
const recipient = await user('Luna_TV');
await user('moonluna');
await user('luna_youtube', 'youtube');
await user('luna_no_id', 'twitch', null);
await user('different');
await redis.hSet('token:gift-search-buyer', { id: buyer.accounts[0].id, login: 'lunabuyer', display_name: 'LunaBuyer' });
const request = (query, token = 'gift-search-buyer') => fetch(
    `http://127.0.0.1:3000/billing/gift-packs/recipients?query=${encodeURIComponent(query)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} });

for (const query of ['lun', 'LUN', '@Lun', ' lun ']) {
    const response = await request(query);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, false);
    assert.deepEqual(body.data.map(person => person.login).sort(), ['luna_tv', 'moonluna']);
    const match = body.data.find(person => person.login === 'luna_tv');
    assert.equal(match.id, recipient._id.toString());
    assert.equal(match.displayName, 'Luna_TV');
    for (const person of body.data) assert.deepEqual(Object.keys(person).sort(), ['avatarUrl', 'displayName', 'id', 'login']);
}
assert.deepEqual((await (await request('zzz')).json()).data, []);
for (const query of ['', 'lu', '.*', 'lun.*', 'a'.repeat(26), 'lun name']) {
    assert.equal((await request(query)).status, 400, query);
}
assert.equal((await request('lun', null)).status, 401);
assert.equal((await request('lun', 'unknown')).status, 401);
const exact = await fetch('http://127.0.0.1:3000/billing/gift-packs/recipient?login=Luna_TV', {
    headers: { Authorization: 'Bearer gift-search-buyer' } });
assert.equal(exact.status, 200);
assert.equal((await exact.json()).data.id, recipient._id.toString());
for (let i = 0; i < 20; i++) await user(`limit_${String(i).padStart(2, '0')}`);
const limited = (await (await request('limit')).json()).data;
assert.equal(limited.length, 15);
assert.deepEqual(limited.map(person => person.login), [...limited.map(person => person.login)].sort());
console.log('PASS gift search: partial/case-insensitive names, 3-character minimum, bounded results, buyer exclusion, private fields, authentication, exact confirmation');
process.exit(0);
