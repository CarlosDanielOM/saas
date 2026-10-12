// Runs only in saas-ops' disposable API/Mongo/Redis environment.
import assert from 'node:assert/strict';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { EventSchema } from '/app/dist/schemas/event.schema.js';
import { SHOUTOUT_RECEIVED_EVENT } from '/app/dist/utils/chat_event_catalog.js';

await getMongoDBConnection('ShoutoutReceivedCheck');
const redis = await getDragonflyClient('ShoutoutReceivedCheck');
const channelID = '99004401';
await UsersSchema.create({ name: 'Shoutout Fixture', accounts: [{ type: 'twitch', id: channelID,
    name: 'shoutoutfixture', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet('token:fixture-shoutout-token', { id: channelID, login: 'shoutoutfixture', display_name: 'Fixture' });
await redis.hSet('token:fixture-outsider-token', { id: '99004402', login: 'outsider', display_name: 'Outsider' });
const headers = { Authorization: 'Bearer fixture-shoutout-token', 'Content-Type': 'application/json' };
const base = 'http://127.0.0.1:3000';
const type = SHOUTOUT_RECEIVED_EVENT.type;
async function request(path, options = {}) {
    const response = await fetch(base + path, { headers, ...options });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.data;
}
assert.equal((await fetch(base + '/site/events')).status, 401);
const catalog = await request('/site/events');
assert.equal(catalog.filter(event => event.type === type).length, 1);
assert.deepEqual(catalog.find(event => event.type === type), SHOUTOUT_RECEIVED_EVENT);
assert.deepEqual(await request(`/site/events/${type}`), SHOUTOUT_RECEIVED_EVENT);
assert.equal((await fetch(base + '/site/events/channel.unknown', { headers })).status, 404);
assert.equal(await EventSchema.countDocuments(), 0, 'catalog discovery never writes a migration');

const subscription = await EventsubSchema.create({ channelID, channel: 'shoutoutfixture', cost: 0,
    created_at: new Date().toISOString(), type, version: '1', id: 'fixture-shoutout-sub',
    enabled: true, status: 'enabled', condition: { broadcaster_user_id: channelID, moderator_user_id: '698614112' },
    transport: { method: 'webhook', callback: 'https://fixture.test/eventsub' }, message: 'Existing thank-you message' });
const path = `/eventsubs/${channelID}/${subscription._id}`;
assert.equal((await request(`/eventsubs/${channelID}`)).find(event => event.type === type).message, 'Existing thank-you message');
for (const update of [{ message: 'Thanks $(shoutout.channel)!' }, { enabled: false }, { enabled: true }, { message: '' }]) {
    await request(path, { method: 'PATCH', body: JSON.stringify(update) });
    const stored = await EventsubSchema.findById(subscription._id).lean();
    for (const [key, value] of Object.entries(update)) assert.equal(stored[key], value);
}
const denied = await fetch(base + path, { method: 'PATCH',
    headers: { ...headers, Authorization: 'Bearer fixture-outsider-token' }, body: JSON.stringify({ message: 'Forbidden' }) });
assert.equal(denied.status, 403);
assert.equal((await EventsubSchema.findById(subscription._id).lean()).message, '');
await EventSchema.create({ ...SHOUTOUT_RECEIVED_EVENT, name: 'Catalog Override' });
const overridden = await request('/site/events');
assert.equal(overridden.filter(event => event.type === type).length, 1);
assert.equal(overridden.find(event => event.type === type).name, 'Catalog Override');
assert.equal((await request(`/site/events/${type}`)).name, 'Catalog Override');
await mongoose.disconnect();
await redis.quit();
console.log('Shoutout discovery, existing message edits, toggles, empty message, override, and permission checks passed.');
process.exit(0);
