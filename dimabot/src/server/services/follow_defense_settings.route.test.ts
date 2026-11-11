/**
 * Pins GET/PATCH /follow-defense/:channelID/settings (follow_defense_settings.service.ts extraction).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const access = { allowed: true as boolean, permissions: [] as unknown[] };
const cancelled: string[] = [];
const cached: Record<string, string> = {};
const realAdmin = await import('../../middleware/admin.middleware.js');
const realActions = await import('../../utils/follow_defense_actions.js');
const realDragonfly = await import('../../utils/databases/dragonfly.database.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('../../middleware/admin.middleware.js', {
    namedExports: { ...realAdmin, getChannelAccessContext: async (_r: string, _c: string, permission: unknown) => { access.permissions.push(permission); return { allowed: access.allowed, role: 'admin' }; } }
});
mock.module('../../utils/follow_defense_actions.js', { namedExports: { ...realActions, cancelFollowDefenseActions: async (id: string) => { cancelled.push(id); return 0; } } });
mock.module('../../utils/databases/dragonfly.database.js', {
    namedExports: { ...realDragonfly, getDragonflyClient: async () => ({ set: async (key: string, value: string) => { cached[key] = value; return 'OK'; } }) }
});

const { default: TwitchStreamers } = await import('../../classes/twitch_streamers.class.js');
const { FollowDefenseSettingsSchema } = await import('../../schemas/follow_defense_settings.schema.js');
const { followDefenseRoute } = await import('../routes/follow_defense.route.js');

const state: { doc: any; updates: any[] } = { doc: null, updates: [] };
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => ({ id, name: 'Chan' }));
mock.method(FollowDefenseSettingsSchema, 'findOneAndUpdate', async (filter: any, update: any, options: any) => {
    state.updates.push({ filter, update, options });
    state.doc = { ...(update.$setOnInsert && !state.doc ? update.$setOnInsert : {}), ...(state.doc ?? {}), ...(update.$set ?? {}) };
    return { toObject: () => ({ ...state.doc }) };
});

const harness = await startRouter('/follow-defense', followDefenseRoute);
after(() => harness.close());
beforeEach(() => {
    harness.user = { id: '2', login: 'mod', display_name: 'Mod' };
    access.allowed = true; access.permissions = []; cancelled.length = 0; state.doc = null; state.updates = [];
    for (const key of Object.keys(cached)) delete cached[key];
});

test('GET needs moderation:view and creates the defaults (existing behavior)', async () => {
    const res = await harness.request('GET', '/1/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'admin');
    assert.equal(res.body.data.silentThresholdX, 10);
    assert.equal(res.body.data.attackThreshold, null);
    assert.deepEqual(access.permissions, ['moderation:view']);
    assert.ok(state.updates[0].update.$setOnInsert);
});

test('PATCH validates the attack threshold and rejects an empty patch', async () => {
    let res = await harness.request('PATCH', '/1/settings', { attackThreshold: 0 });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Attack threshold must be a positive integer or empty for dynamic sensitivity', status: 400 } });
    res = await harness.request('PATCH', '/1/settings', { language: 'fr', bogus: true, silentThresholdX: -1 });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'No valid settings fields provided', status: 400 } });
    access.allowed = false;
    res = await harness.request('PATCH', '/1/settings', { enabled: false });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'You do not have permission to manage Follow Defense for this channel', status: 403 } });
});

test('PATCH saves the patch, caches it and cancels pending actions when protection is turned off', async () => {
    const res = await harness.request('PATCH', '/1/settings', { silentThresholdX: '12.6', attackThreshold: '', protectionModeEnabled: false, resetAttackOnNewRaid: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Follow Defense settings updated successfully');
    assert.deepEqual(access.permissions, ['moderation:manage', 'moderation:manage']);
    const update = state.updates.at(-1);
    assert.deepEqual(update.update.$set, { silentThresholdX: 13, attackThreshold: null, protectionModeEnabled: false, resetAttackOnNewRaid: false, channel: 'Chan' });
    assert.equal(res.body.data.protectionModeEnabled, false);
    assert.deepEqual(cancelled, ['1']);
    assert.equal(JSON.parse(Object.values(cached).at(-1)!).silentThresholdX, 13);
    const next = await harness.request('PATCH', '/1/settings', { silentDurationSeconds: 90 });
    assert.equal(next.status, 200);
    assert.deepEqual(cancelled, ['1']);
});
