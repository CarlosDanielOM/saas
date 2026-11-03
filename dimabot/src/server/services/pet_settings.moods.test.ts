import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { defaultPetMoods } from '../../pets/moods.js';

const userId = '111111111111111111111111';
const missing = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const valid = 'bbbbbbbbbbbbbbbbbbbbbbbb';
let record: any;
const query = <T>(value: T) => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
mock.module('../../schemas/users.schema.js', { defaultExport: { findOne: () => query({ plan_tier: 'premium', _id: userId }) } });
mock.module('../../schemas/pet_runtime.schema.js', { namedExports: { PetRuntime: { findById: () => query(null) } } });
mock.module('../../schemas/pet_settings.schema.js', { namedExports: { PetSettingsSchema: {
    findOne: () => query(record), init: async () => {}, exists: async () => false,
    findOneAndUpdate: async (_filter: unknown, update: any) => { record = { ...record, ...update.$set }; return record; }
} } });
mock.module('../../schemas/channel_ai_personality.schema.js', { namedExports: { ChannelAIPersonalitySchema: { findOne: () => query(null), exists: async () => false } } });
mock.module('../../assets/library.js', { namedExports: {
    findAsset: async (_owner: string, id: string) => {
        if (id !== valid) throw Object.assign(new Error('not_found'), { code: 'not_found', status: 404 });
        return { kind: 'image', purpose: 'pet-mood', mime: 'image/png' };
    },
    registerAssetConsumer: () => {}, withAssetLibrary: async (_owner: string, fn: () => Promise<unknown>) => fn()
} });
mock.module('../../pets/state.js', { namedExports: { invalidatePet: async () => {} } });
mock.module('../../pets/peers.js', { namedExports: { validatePetSessions: async () => {} } });
mock.module('../../pets/readiness.js', { namedExports: { hasSharedVtsReadiness: async () => false } });
mock.module('./tts/fish_tts.service.js', { namedExports: { FISH_VOICES: {} } });
const { defaultPetSettings, getPetConfiguration, savePetConfiguration } = await import('./pet_settings.service.js');

test('corrupt and invalid moods fail open and later valid moods work', async () => {
    const settings = defaultPetSettings();
    record = { settings: { ...settings, moods: { enabled: true, emotions: null } }, revision: 1 };
    const loaded = await getPetConfiguration(userId, 'channel');
    assert.deepEqual(loaded.settings.moods, defaultPetMoods());
    const legacy: any = structuredClone(settings); delete legacy.moods; legacy.name = 'New name';
    const saved = await savePetConfiguration(userId, 'channel', { revision: 1, settings: legacy });
    assert.equal(saved.settings.name, 'New name');
    assert.deepEqual(saved.settings.moods, defaultPetMoods());
    const invalid = await savePetConfiguration(userId, 'channel', { revision: 2, settings: { ...legacy, name: 'Still saved', moods: null } });
    assert.equal(invalid.settings.name, 'Still saved');
    assert.deepEqual(invalid.settings.moods, defaultPetMoods());
    const enabled = defaultPetMoods(); enabled.enabled = true;
    const restored = await savePetConfiguration(userId, 'channel', { revision: 3, settings: { ...legacy, moods: enabled } });
    assert.equal(restored.settings.moods.enabled, true);
});

test('unchanged missing mood refs survive unrelated saves, changed refs are checked', async () => {
    const settings = defaultPetSettings();
    settings.moods!.images.happy = { idleAssetId: missing };
    record = { settings, revision: 1 };
    const next = structuredClone(settings); next.name = 'Changed';
    const saved = await savePetConfiguration(userId, 'channel', { revision: 1, settings: next });
    assert.equal(saved.settings.moods.images.happy?.idleAssetId, missing);
    const moved = structuredClone(next); moved.moods!.images.happy = { talkingAssetId: missing };
    const movedResult = await savePetConfiguration(userId, 'channel', { revision: 2, settings: moved });
    assert.equal(movedResult.settings.moods.images.happy?.talkingAssetId, undefined);
    const replaced = structuredClone(next); replaced.moods!.images.happy = { idleAssetId: valid };
    const result = await savePetConfiguration(userId, 'channel', { revision: 3, settings: replaced });
    assert.equal(result.settings.moods.images.happy?.idleAssetId, valid);
});


test('invalid replacement and excessive mood slots keep prior decoration while saving other settings', async () => {
    const settings = defaultPetSettings();
    settings.moods!.images.happy = { idleAssetId: valid };
    record = { settings, revision: 1 };
    const invalid = structuredClone(settings); invalid.name = 'Still saved'; invalid.moods!.images.happy!.idleAssetId = missing;
    const saved = await savePetConfiguration(userId, 'channel', { revision: 1, settings: invalid });
    assert.equal(saved.settings.name, 'Still saved');
    assert.equal(saved.settings.moods.images.happy?.idleAssetId, valid);
    const excessive = structuredClone(invalid); excessive.name = 'Other edit';
    for (const mood of ['happy', 'excited', 'sad', 'angry', 'surprised'] as const) excessive.moods!.images[mood] = { idleAssetId: valid, talkingAssetId: valid };
    const result = await savePetConfiguration(userId, 'channel', { revision: 2, settings: excessive });
    assert.equal(result.settings.name, 'Other edit');
    assert.deepEqual(result.settings.moods.images, settings.moods!.images);
});
