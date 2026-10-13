// Use with saas-ops API + disposable Mongo/Redis and chat-notification-fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { EventSchema } from '/app/dist/schemas/event.schema.js';
import { SUBSCRIPTION_CHAT_EVENTS } from '/app/dist/utils/chat_event_catalog.js';
import { normalizeTwitchEventsubDomainEvent } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { applyChatAnnouncementDomainEvent } from '/app/dist/domain_events/chat_announcement_events.js';
import { eventsubHandler } from '/app/dist/handlers/eventsub.handler.js';

await getMongoDBConnection('SubscriptionChatEventsCheck');
const redis = await getDragonflyClient('SubscriptionChatEventsCheck');
const channelID = '99005501';
await UsersSchema.create({ name: 'Subscription Fixture', accounts: [{ type: 'twitch', id: channelID,
    name: 'subscriptionfixture', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'subscriptionfixture',
    actived: 'true', has_permissions: 'true', chat_enabled: 'true', access_token: 'dummy-streamer-token',
    expires_at: String(Math.floor(Date.now() / 1000) + 3600) });
await redis.set('app:twitch:token', 'app-token');
await redis.hSet('token:fixture-subscription-token', { id: channelID, login: 'subscriptionfixture', display_name: 'Fixture' });
await redis.hSet('token:fixture-outsider-token', { id: '99005502', login: 'outsider', display_name: 'Outsider' });
const headers = { Authorization: 'Bearer fixture-subscription-token', 'Content-Type': 'application/json' };
const base = 'http://127.0.0.1:3000';
async function request(path, options = {}) {
    const response = await fetch(base + path, { headers, ...options });
    const body = await response.json();
    assert.equal(response.status, options.method === 'POST' ? 201 : 200, JSON.stringify(body));
    return body.data;
}
const chats = () => fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line)).filter(call => call.chat).map(call => call.chat.message);
fs.writeFileSync('/tmp/saas-fixtures/calls.jsonl', '');
assert.equal((await fetch(base + '/site/events')).status, 401);
const catalog = await request('/site/events');
assert.equal(SUBSCRIPTION_CHAT_EVENTS.length, 4);
assert.equal(await EventSchema.countDocuments(), 0);

for (const template of SUBSCRIPTION_CHAT_EVENTS) {
    const type = template.type;
    assert.equal(catalog.filter(event => event.type === type).length, 1);
    assert.deepEqual(catalog.find(event => event.type === type), template);
    assert.deepEqual(await request(`/site/events/${type}`), template);
    assert.equal(template.plan_tier, 'free');
    assert.equal(template.enabled, false);
    const subscription = await EventsubSchema.create({ channelID, channel: 'subscriptionfixture', cost: 0,
        created_at: new Date().toISOString(), type, version: '1', id: `fixture-${type}`,
        enabled: true, status: 'enabled', condition: { broadcaster_user_id: channelID },
        transport: { method: 'webhook', callback: 'https://fixture.test/eventsub' }, message: `Existing ${type}` });
    const path = `/eventsubs/${channelID}/${subscription._id}`;
    assert.equal((await request(`/eventsubs/${channelID}`)).find(event => event.type === type).message, `Existing ${type}`);
    // Real persistence, parser and chat delivery, with only the external provider mocked.
    const payload = { broadcaster_user_id: channelID, broadcaster_user_login: 'subscriptionfixture',
        broadcaster_user_name: 'SubscriptionFixture', user_id: '99005503', user_login: 'viewer', user_name: 'Viewer',
        tier: '2000', is_gift: false, is_anonymous: false, total: 5, cumulative_total: 20,
        cumulative_months: 12, streak_months: 3, duration_months: 1, message: { text: 'Hello!', emotes: [] } };
    const envelope = normalizeTwitchEventsubDomainEvent({ messageId: `check-${type}`,
        subscription: { type, version: '1', condition: { broadcaster_user_id: channelID } },
        event: payload, durableChatHandled: true });
    assert.ok(envelope);
    async function announce() { await applyChatAnnouncementDomainEvent(envelope); }
    const message = type === 'channel.subscription.message'
        ? 'Thanks $(user): $(sub.tier), $(sub.months) months!'
        : 'Thanks $(user): $(sub.tier)!';
    await request(path, { method: 'PATCH', body: JSON.stringify({ message }) });
    const before = chats().length;
    await announce();
    assert.equal(chats().length, before + 1, type);
    assert.equal(chats().at(-1), type === 'channel.subscription.message' ? 'Thanks Viewer: Tier 2, 12 months!' : 'Thanks Viewer: Tier 2!');
    // Manual test/legacy handler must use the same stored configuration.
    await eventsubHandler({ type, version: '1', condition: { broadcaster_user_id: channelID } }, payload);
    assert.equal(chats().length, before + 2, `${type} legacy handler`);
    for (const update of [{ enabled: false }, { enabled: true, message: '' }]) {
        await request(path, { method: 'PATCH', body: JSON.stringify(update) });
        await announce();
        await eventsubHandler({ type, version: '1', condition: { broadcaster_user_id: channelID } }, payload);
        assert.equal(chats().length, before + 2, `${type} disabled/empty is silent`);
    }
    await request(path, { method: 'PATCH', body: JSON.stringify({ message: template.config[0].value }) });
    if (type === 'channel.subscription.gift') {
        Object.assign(envelope.payload.event, { is_anonymous: true, user_id: null, user_login: null, user_name: null });
        await announce();
        assert.equal(chats().at(-1), 'Thank you for the gifted Tier 2 subscriptions!');
    }
    const denied = await fetch(base + path, { method: 'PATCH',
        headers: { ...headers, Authorization: 'Bearer fixture-outsider-token' }, body: JSON.stringify({ message: 'Forbidden' }) });
    assert.equal(denied.status, 403);
    assert.equal((await EventsubSchema.findById(subscription._id).lean()).message, template.config[0].value);
}
assert.equal(await EventSchema.countDocuments(), 0, 'discovery does not migrate the catalog');
await EventSchema.create({ ...SUBSCRIPTION_CHAT_EVENTS[0], name: 'Catalog Override' });
const overridden = await request('/site/events');
assert.equal(overridden.filter(event => event.type === 'channel.subscribe').length, 1);
assert.equal(overridden.find(event => event.type === 'channel.subscribe').name, 'Catalog Override');
assert.equal((await request('/site/events/channel.subscribe')).name, 'Catalog Override');
assert.equal((await fetch(base + '/site/events/channel.unknown', { headers })).status, 404);
// A channel without a stored subscription can opt in using the catalog contract.
await EventsubSchema.deleteMany({ channelID });
for (const template of SUBSCRIPTION_CHAT_EVENTS) {
    const created = await request(`/eventsubs/${channelID}`, { method: 'POST', body: JSON.stringify({
        type: template.type, version: template.version, condition: { broadcaster_user_id: channelID },
        config: { message: template.config[0].value }
    }) });
    assert.equal(created.type, template.type);
    const stored = await EventsubSchema.findOne({ channelID, type: template.type }).lean();
    assert.equal(stored.enabled, true);
    assert.equal(stored.message, template.config[0].value);
    assert.deepEqual(stored.condition, { broadcaster_user_id: channelID });
}
console.log('PASS: four subscription cards; existing settings; save/toggle/empty; permissions; overrides; durable/legacy announcements; tiers/months; anonymous gifts.');
await mongoose.disconnect();
await redis.quit();
process.exit(0);
