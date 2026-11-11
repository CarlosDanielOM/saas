/**
 * Pins POST/PATCH/DELETE /eventsubs/:channelID (eventsub_config.service.ts extraction keeps them identical).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const access = { level: 'owner' as 'owner' | 'admin' | 'none', permissions: [] as unknown[] };
const calls: { subscribe: unknown[][]; unsubscribe: string[] } = { subscribe: [], unsubscribe: [] };
const results: { subscribe: unknown; unsubscribe: unknown } = { subscribe: null, unsubscribe: null };
const realEventsub = await import('../../utils/eventsub.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('../../utils/eventsub_access.js', { namedExports: { getEventsubAccess: async (_r: string, _c: string, permission?: string) => { access.permissions.push(permission); return access.level; } } });
mock.module('../../handlers/eventsub.handler.js', { namedExports: { eventsubHandler: async () => {} } });
mock.module('../../utils/domain_events.js', { namedExports: { journalDomainEvent: async () => {} } });
mock.module('../../utils/eventsub.js', {
    namedExports: {
        ...realEventsub,
        subscribeTwitchEvent: async (...args: unknown[]) => { calls.subscribe.push(args); return results.subscribe; },
        unsubscribeTwitchEvent: async (id: string) => { calls.unsubscribe.push(id); return results.unsubscribe; }
    }
});

const { default: EventsubSchema } = await import('../../schemas/eventsub.schema.js');
const { default: UsersSchema } = await import('../../schemas/users.schema.js');
const { EventSchema } = await import('../../schemas/event.schema.js');
const { RaidSubscriptionPreferenceSchema } = await import('../../schemas/raid_subscription_preference.schema.js');
const { eventsubRoute } = await import('../routes/eventsub.route.js');

const ID = '64b7f0f0f0f0f0f0f0f0f0f0';
const state: { plan: string; templates: any[]; doc: any; updates: any[]; prefs: any[] } = { plan: 'free', templates: [], doc: null, updates: [], prefs: [] };
mock.method(UsersSchema, 'findOne', () => ({ lean: async () => ({ plan_tier: state.plan }) }));
mock.method(EventSchema, 'find', () => ({ lean: async () => state.templates }));
mock.method(EventsubSchema, 'findOne', async () => state.doc);
mock.method(EventsubSchema, 'findOneAndUpdate', (filter: unknown, update: unknown, options: unknown) => {
    state.updates.push({ filter, update, options });
    return { lean: async () => state.doc ? { ...state.doc, ...(update as object) } : null };
});
mock.method(RaidSubscriptionPreferenceSchema, 'updateOne', async (filter: unknown, update: unknown, options: unknown) => { state.prefs.push({ filter, update, options }); return {}; });
mock.method(RaidSubscriptionPreferenceSchema, 'findById', () => ({ lean: async () => ({ deleted: false }) }));

const harness = await startRouter('/eventsubs', eventsubRoute);
after(() => harness.close());
beforeEach(() => {
    harness.user = { id: '1', login: 'chan', display_name: 'Chan' };
    access.level = 'owner'; access.permissions = []; calls.subscribe = []; calls.unsubscribe = [];
    results.subscribe = { id: 'twitch-sub', type: 'channel.follow' }; results.unsubscribe = { error: false };
    state.plan = 'free'; state.templates = []; state.doc = null; state.updates = []; state.prefs = [];
});

test('POST checks eventsubs:manage and required fields', async () => {
    access.level = 'none';
    let res = await harness.request('POST', '/1', { type: 'channel.follow', version: '2', condition: {} });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'You do not have permission to manage eventsubs for this channel', status: 403 } });
    assert.deepEqual(access.permissions, ['eventsubs:manage']);
    access.level = 'admin';
    res = await harness.request('POST', '/1', { type: 'channel.follow' });
    assert.deepEqual(res, { status: 400, body: { error: 'Bad Request', message: 'Missing type, version or condition', status: 400 } });
});

test('POST enforces the catalog plan and cheer tier limits, then subscribes', async () => {
    state.templates = [{ type: 'channel.hype_train.begin', plan_tier: 'premium' }];
    let res = await harness.request('POST', '/1', { type: 'channel.hype_train.begin', version: '1', condition: { broadcaster_user_id: '1' } });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'This event requires premium plan', status: 403 } });
    state.templates = [{ type: 'channel.bits.use', plan_tier: 'free', tierLimits: { free: 1, premium: 2, pro: 5 } }];
    const tier = { id: 't', name: 'x', message: 'm', min_amount: 1, max_amount: 5 };
    res = await harness.request('POST', '/1', { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: '1' }, config: { cheerTiers: [tier, tier] } });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'Your free plan allows up to 1 cheer tiers', status: 403 } });
    state.templates = [];
    res = await harness.request('POST', '/1', { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '1', moderator_user_id: '698614112' }, config: { message: 'Hi $(user)' } });
    assert.deepEqual(res, { status: 201, body: { error: false, data: { id: 'twitch-sub', type: 'channel.follow' } } });
    assert.deepEqual(calls.subscribe[0], ['1', 'channel.follow', '2', { broadcaster_user_id: '1', moderator_user_id: '698614112' }, { message: 'Hi $(user)' }]);
    results.subscribe = { error: true };
    res = await harness.request('POST', '/1', { type: 'channel.follow', version: '2', condition: {} });
    assert.deepEqual(res, { status: 400, body: { error: 'Bad Request', message: 'Failed to create eventsub', status: 400 } });
});

test('POST validates raids and records the raid preference', async () => {
    let res = await harness.request('POST', '/1', { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '2' } });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Raid condition must match this channel and one direction' } });
    res = await harness.request('POST', '/1', { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '1' }, config: { bad: 1 } });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Invalid raid event settings' } });
    res = await harness.request('POST', '/1', { type: 'channel.raid.outgoing', version: '1', condition: { from_broadcaster_user_id: '1' }, config: { message: '' } });
    assert.equal(res.status, 201);
    assert.deepEqual(calls.subscribe[0].slice(0, 4), ['1', 'channel.raid', '1', { from_broadcaster_user_id: '1' }]);
    assert.equal(state.prefs.length, 1);
    assert.equal((state.prefs[0].update as any).$set.direction, 'outgoing');
    assert.equal((state.prefs[0].update as any).$set.deleted, false);
});

test('PATCH validates the id, protects stream online/offline and raids, then updates', async () => {
    let res = await harness.request('PATCH', '/1/not-an-id', { enabled: true });
    assert.deepEqual(res, { status: 400, body: { error: 'Invalid ID', message: 'ID is not a valid ObjectID', status: 400 } });
    res = await harness.request('PATCH', `/1/${ID}`, { enabled: true });
    assert.deepEqual(res, { status: 404, body: { error: 'Not Found', message: 'Eventsub not found', status: 404 } });
    state.doc = { _id: ID, channelID: '1', type: 'stream.online', enabled: true };
    res = await harness.request('PATCH', `/1/${ID}`, { enabled: false });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'This event cannot be disabled. Clear its message to silence chat output.', status: 403 } });
    state.doc = { _id: ID, channelID: '1', type: 'channel.raid', condition: { to_broadcaster_user_id: '1' } };
    res = await harness.request('PATCH', `/1/${ID}`, { endMessage: 'x' });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Invalid raid event settings' } });
    state.doc = { _id: ID, channelID: '1', type: 'channel.follow', enabled: true, message: 'old' };
    res = await harness.request('PATCH', `/1/${ID}`, { message: 'new', enabled: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { error: false, data: { ...state.doc, message: 'new', enabled: false }, status: 200 });
    assert.deepEqual(state.updates[0], { filter: { _id: ID, channelID: '1' }, update: { message: 'new', enabled: false }, options: { new: true } });
});

test('DELETE protects stream online/offline, unsubscribes and rolls back the raid preference on error', async () => {
    let res = await harness.request('DELETE', `/1/${ID}`);
    assert.deepEqual(res, { status: 404, body: { error: 'Not Found', message: 'Eventsub not found', status: 404 } });
    state.doc = { _id: ID, id: 'tw', channelID: '1', type: 'stream.offline' };
    res = await harness.request('DELETE', `/1/${ID}`);
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'This event cannot be deleted. Clear its message to silence chat output.', status: 403 } });
    state.doc = { _id: ID, id: 'tw', channelID: '1', type: 'channel.follow', condition: {} };
    res = await harness.request('DELETE', `/1/${ID}`);
    assert.deepEqual(res, { status: 200, body: { error: false, message: 'Eventsub deleted', status: 200 } });
    assert.deepEqual(calls.unsubscribe, ['tw']);
    state.doc = { _id: ID, id: 'tw2', channelID: '1', type: 'channel.raid', condition: { to_broadcaster_user_id: '1' } };
    results.unsubscribe = { error: 'Twitch', message: 'nope', status: 502 };
    res = await harness.request('DELETE', `/1/${ID}`);
    assert.deepEqual(res, { status: 502, body: { error: 'Twitch', message: 'nope', status: 502 } });
    assert.equal(state.prefs.length, 2);
    assert.equal((state.prefs[0].update as any).$set.deleted, true);
    assert.equal((state.prefs[1].update as any).$set.deleted, false);
});
