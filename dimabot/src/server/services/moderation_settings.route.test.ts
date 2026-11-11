/**
 * Pins the HTTP behavior of PUT/GET /moderation/:channelID/settings so the service extraction
 * (moderation_settings.service.ts) keeps the route identical.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const access = { allowed: true as boolean };
const invalidated: string[] = [];
const realAdmin = await import('../../middleware/admin.middleware.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('../../middleware/admin.middleware.js', {
    namedExports: { ...realAdmin, getChannelAccessContext: async () => ({ allowed: access.allowed, role: access.allowed ? 'owner' : 'none' }) }
});
mock.module('../../handlers/moderation.handler.js', { namedExports: { invalidateModerationSettingsCache: async (id: string) => { invalidated.push(id); } } });

const { default: TwitchStreamers } = await import('../../classes/twitch_streamers.class.js');
const { ChannelModerationSettingsSchema } = await import('../../schemas/channel_moderation_settings.schema.js');
const { default: Users } = await import('../../schemas/users.schema.js');
const { moderationRoute } = await import('../routes/moderation.route.js');

const state: { stored: any; plan: string; updates: any[] } = { stored: null, plan: 'free', updates: [] };
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => id === '404' ? null : { id, name: 'Chan' });
mock.method(Users, 'findOne', () => ({ select: () => ({ lean: async () => ({ plan_tier: state.plan }) }) }));
mock.method(ChannelModerationSettingsSchema, 'findOne', () => ({ lean: async () => state.stored }));
mock.method(ChannelModerationSettingsSchema, 'findOneAndUpdate', async (filter: any, update: any, options: any) => {
    state.updates.push({ filter, update, options });
    const doc = { ...(state.stored ?? {}), channelID: filter.channelID, ...update.$set, settingsVersion: (state.stored?.settingsVersion ?? 0) + 1 };
    state.stored = doc;
    return { toObject: () => doc };
});

const harness = await startRouter('/moderation', moderationRoute);
after(() => harness.close());
beforeEach(() => {
    harness.user = { id: '1', login: 'chan', display_name: 'Chan' };
    access.allowed = true; state.stored = null; state.plan = 'free'; state.updates = []; invalidated.length = 0;
});

const capsRule = { id: 'caps-1', type: 'caps', enabled: true, firstOffense: { action: 'warn', timeoutSeconds: 60 } };

test('GET without a saved document returns the read-only default view (never inserts)', async () => {
    const res = await harness.request('GET', '/1/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Moderation settings');
    assert.equal(res.body.data.enabled, false);
    assert.deepEqual(res.body.data.rules, []);
    assert.equal(res.body.data.spamProtection.thresholdPercent, 85);
    assert.equal(state.updates.length, 0);
});

test('PUT denies without moderation:manage and 404s an unknown streamer', async () => {
    access.allowed = false;
    let res = await harness.request('PUT', '/1/settings', { rules: [] });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'You do not have permission to manage moderation for this channel', status: 403 } });
    access.allowed = true;
    res = await harness.request('PUT', '/404/settings', { rules: [] });
    assert.deepEqual(res, { status: 404, body: { error: true, message: 'Streamer not found', status: 404 } });
});

test('PUT rejects invalid rules, too many rules, reserved and duplicate ids', async () => {
    let res = await harness.request('PUT', '/1/settings', { rules: [{ type: 'nope' }] });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Rule 1: type must be one of caps, links, emote_spam, blacklist', status: 400 } });
    res = await harness.request('PUT', '/1/settings', { rules: Array.from({ length: 21 }, () => capsRule) });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'A channel can have at most 20 moderation rules', status: 400 } });
    res = await harness.request('PUT', '/1/settings', { rules: [{ ...capsRule, id: 'builtin-spam-protection' }] });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Reserved moderation rule ID', status: 400 } });
    res = await harness.request('PUT', '/1/settings', { rules: [capsRule, capsRule] });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Rule IDs must be unique', status: 400 } });
    res = await harness.request('PUT', '/1/settings', { rules: [], spamProtection: { enabled: 'yes' } });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Invalid spam protection settings', status: 400 } });
    assert.equal(state.updates.length, 0);
});

test('PUT blocks paid options on Free and allows them on Premium', async () => {
    const body = { rules: [], spamProtection: { enabled: true, reviewAllMessages: false, thresholdPercent: 90 } };
    let res = await harness.request('PUT', '/1/settings', body);
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'Custom protection confidence requires Premium or Pro', status: 403 } });
    res = await harness.request('PUT', '/1/settings', { rules: [], spamProtection: { enabled: true, reviewAllMessages: true } });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'Continuous spam review requires Premium or Pro', status: 403 } });
    state.plan = 'premium';
    res = await harness.request('PUT', '/1/settings', body);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.spamProtection.thresholdPercent, 90);
});

test('PUT saves sanitized rules, bumps the version and invalidates the cache', async () => {
    const res = await harness.request('PUT', '/1/settings', { enabled: true, offenseWindowSeconds: 10, rules: [{ ...capsRule, terms: ['x'], minCapsCount: 9999 }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Moderation settings saved');
    const update = state.updates[0];
    assert.deepEqual(update.filter, { channelID: '1' });
    assert.deepEqual(update.update.$inc, { settingsVersion: 1 });
    assert.deepEqual(update.options, { new: true, upsert: true, setDefaultsOnInsert: true });
    assert.equal(update.update.$set.channel, 'Chan');
    assert.equal(update.update.$set.enabled, true);
    assert.equal(update.update.$set.offenseWindowSeconds, 60);
    const [rule] = update.update.$set.rules;
    assert.equal(rule.id, 'caps-1');
    assert.equal(rule.minCapsCount, 500);
    assert.deepEqual(rule.secondOffense, { action: 'delete', timeoutSeconds: 60 });
    assert.deepEqual(rule.variations, { mode: 'off', allowSpaces: false, entries: [], overrides: [] });
    assert.deepEqual(invalidated, ['1']);
    // Values not sent keep the stored ones.
    const next = await harness.request('PUT', '/1/settings', { rules: [] });
    assert.equal(next.status, 200);
    assert.equal(state.updates[1].update.$set.enabled, true);
    assert.equal(state.updates[1].update.$set.offenseWindowSeconds, 60);
});
