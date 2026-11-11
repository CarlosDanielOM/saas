/**
 * Pins GET/PUT /speech/settings/:channelID (tts_settings.service.ts extraction keeps them identical).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const fishLookups: string[] = [];
const realCatalog = await import('./tts/fish_voice_catalog.service.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('./tts/fish_voice_catalog.service.js', {
    namedExports: {
        ...realCatalog,
        getFishVoice: async (id: string) => {
            fishLookups.push(id);
            if (id === 'f'.repeat(32)) throw new realCatalog.VoiceRequestError(404, 'voice_not_found', 'Voice not found');
            return { id, name: 'Found voice' };
        }
    }
});

const { default: TwitchStreamers } = await import('../../classes/twitch_streamers.class.js');
const { AdminSchema } = await import('../../schemas/admin.schema.js');
const { ChannelTtsSettingsSchema } = await import('../../schemas/channel_tts_settings.schema.js');
const { default: UsersSchema } = await import('../../schemas/users.schema.js');
const { speechRoute } = await import('../routes/speech.route.js');

const state: { doc: any; admin: any; saves: any[] } = { doc: null, admin: null, saves: [] };
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => ({ id, name: 'Chan' }));
mock.method(AdminSchema, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
mock.method(AdminSchema, 'findOne', () => ({ lean: async () => state.admin }));
mock.method(UsersSchema, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
mock.method(ChannelTtsSettingsSchema, 'findOne', () => {
    const doc = state.doc ? { ...structuredClone(state.doc), set(value: any) { Object.assign(this, value); }, async save() { state.saves.push('update'); const { set: _s, save: _v, ...rest } = this as any; state.doc = rest; } } : null;
    return { lean: async () => state.doc ? structuredClone(state.doc) : null, exec: async () => doc };
});
mock.method(ChannelTtsSettingsSchema.prototype, 'save', async function (this: any) { state.saves.push('insert'); state.doc = this.toObject(); });

const harness = await startRouter('/speech', speechRoute);
after(() => harness.close());
beforeEach(() => {
    harness.user = { id: '1', login: 'chan', display_name: 'Chan' };
    state.doc = null; state.admin = null; state.saves = []; fishLookups.length = 0;
});

test('GET and PUT check tts:view / tts:manage with the manager role for admins', async () => {
    harness.user = { id: '9', login: 'x', display_name: 'X' };
    let res = await harness.request('PUT', '/settings/1', { enabled: false });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'TTS Manage permission required to update TTS settings', status: 403 } });
    state.admin = { permissions: ['tts:view'] };
    res = await harness.request('GET', '/settings/1');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'admin');
    assert.equal(res.body.data.settings.provider, 'piper');
    assert.equal(state.saves.length, 0);
});

test('PUT rejects unknown Kokoro and Fish voices', async () => {
    let res = await harness.request('PUT', '/settings/1', { voices: { kokoroDefault: 'zz_nope' } });
    assert.deepEqual(res, { status: 400, body: { error: true, message: 'Invalid Kokoro voice', status: 400 } });
    res = await harness.request('PUT', '/settings/1', { voices: { cloneDefault: 'not a voice' } });
    assert.deepEqual(res, { status: 400, body: { error: true, status: 400, code: 'invalid_voice', message: 'Invalid Fish voice' } });
    res = await harness.request('PUT', '/settings/1', { voices: { cloneDefault: 'f'.repeat(32) } });
    assert.deepEqual(res, { status: 404, body: { error: true, status: 404, code: 'voice_not_found', message: 'Voice not found' } });
    assert.equal(state.saves.length, 0);
});

test('PUT normalizes the full settings body, checks a new Fish voice and saves', async () => {
    const id = 'a'.repeat(32);
    const res = await harness.request('PUT', '/settings/1', { enabled: false, provider: 'fish', voices: { cloneDefault: id }, filters: { maxLength: 9000 }, queue: { maxItems: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'TTS settings updated successfully');
    assert.equal(res.body.data.role, 'owner');
    const settings = res.body.data.settings;
    assert.equal(settings.enabled, false);
    assert.equal(settings.provider, 'fish');
    assert.equal(settings.voices.cloneDefault, id);
    assert.equal(settings.filters.maxLength, 500);
    assert.equal(settings.queue.maxItems, 1);
    assert.deepEqual(fishLookups, [id]);
    assert.deepEqual(state.saves, ['insert']);
    // Built-in voices and unchanged voices skip the catalog lookup.
    const again = await harness.request('PUT', '/settings/1', { ...settings, voices: { ...settings.voices, cloneDefault: 'gojo' } });
    assert.equal(again.status, 200);
    assert.deepEqual(fishLookups, [id]);
    assert.deepEqual(state.saves, ['insert', 'update']);
});
