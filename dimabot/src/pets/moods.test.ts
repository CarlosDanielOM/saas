import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeMoodImages, defaultPetMoods, savedPetMoods, moodConfiguration, moodImageSlots, MOOD_NAMES, resolvePetMood, validatePetMoods } from './moods.js';
import { filterExpressiveTtsTags, normalizeExpressiveTtsTags } from '../utils/tts/expressive_tts_tags.util.js';

test('defaults and paid wire config include the contract lists and hold time', () => {
    const moods = defaultPetMoods();
    assert.equal(moods.enabled, false); assert.equal(moods.holdMs, 2000);
    assert.deepEqual(moods.emotions.thinking, ['curious', 'confused', 'uncertain', 'doubtful']);
    assert.equal(moods.emotions.happy.length, 15);
    assert.deepEqual(moodConfiguration(moods, 'free'), { available: false, enabled: false });
    assert.deepEqual(moodConfiguration(moods, 'premium'), { available: true, enabled: false, holdMs: 2000, emotions: moods.emotions });
    moods.emotions.happy.pop(); assert.equal(defaultPetMoods().emotions.happy.length, 15);
});
test('Mongo-minimized empty image maps normalize before settings round-trip validation', () => {
    const stored = defaultPetMoods();
    delete (stored as Partial<typeof stored>).images;
    assert.deepEqual(validatePetMoods(savedPetMoods(stored)).images, {});
    assert.deepEqual(moodImageSlots(stored), []);
    assert.deepEqual(savedPetMoods(), defaultPetMoods());
});
test('validation normalizes aliases and rejects delivery, duplicate tags and invalid hold', () => {
    const moods = defaultPetMoods();
    moods.emotions.angry = ['anger'];
    assert.deepEqual(validatePetMoods(moods).emotions.angry, ['angry']);
    moods.emotions.happy.push('anger'); assert.throws(() => validatePetMoods(moods));
    moods.emotions.happy.pop(); moods.emotions.happy.push('whisper'); assert.throws(() => validatePetMoods(moods));
    moods.emotions.happy.pop(); moods.holdMs = 10001; assert.throws(() => validatePetMoods(moods));
    moods.holdMs = 1.5; assert.throws(() => validatePetMoods(moods));
});
test('validation rejects unknown tags, duplicate aliases, invalid fields and every invalid hold boundary', () => {
    for (const holdMs of [-1, 0.5, 10001, NaN, Infinity, '2000', null]) {
        assert.throws(() => validatePetMoods({ ...defaultPetMoods(), holdMs }));
    }
    for (const holdMs of [0, 10000]) assert.equal(validatePetMoods({ ...defaultPetMoods(), holdMs }).holdMs, holdMs);
    for (const tag of ['not-an-emotion', 'pause', 'singing', 'background laughter']) {
        const moods = defaultPetMoods(); moods.emotions.happy.push(tag);
        assert.throws(() => validatePetMoods(moods));
    }
    const duplicate = defaultPetMoods(); duplicate.emotions.angry.push('anger');
    assert.throws(() => validatePetMoods(duplicate), 'aliases cannot duplicate a canonical tag within a list');
    assert.throws(() => validatePetMoods({ ...defaultPetMoods(), customMood: [] }));
    assert.throws(() => validatePetMoods({ ...defaultPetMoods(), images: { happy: { idleAssetId: 'https://example.invalid/image' } } }));
    const allUnassigned = defaultPetMoods();
    for (const name of MOOD_NAMES) allUnassigned.emotions[name] = [];
    assert.equal(resolvePetMood('[happy] Hello', validatePetMoods(allUnassigned)), 'neutral');
});
test('first known emotion or sound chooses a single mood before provider filtering', () => {
    const moods = defaultPetMoods();
    assert.equal(resolvePetMood('[whisper] [anger] hi [happy]', moods), 'angry');
    assert.equal(resolvePetMood('[pause] [sigh] [happy]', moods), 'neutral');
    assert.equal(resolvePetMood('<laughing> hi', moods), 'happy');
    assert.equal(resolvePetMood('plain text', moods), 'neutral');
});
test('raw talk and generated reply cues select moods when Fish cues are disabled', () => {
    const moods = defaultPetMoods();
    const enabledTags = { ...normalizeExpressiveTtsTags(), happy: false, angry: false };
    for (const [raw, expected] of [['[happy] Hello', 'happy'], ['[anger] Stop', 'angry']] as const) {
        assert.equal(resolvePetMood(raw, moods), expected);
        assert.equal(resolvePetMood(filterExpressiveTtsTags(raw, { provider: 'fish', enabledTags }), moods), 'neutral');
    }
});
test('premium uses first eight configured slots in mood and idle/talking order, preserving the rest', () => {
    const moods = defaultPetMoods();
    MOOD_NAMES.forEach((mood, i) => { moods.images[mood] = { idleAssetId: `idle-${i}`, talkingAssetId: `talk-${i}` }; });
    assert.equal(moodImageSlots(moods).length, 16);
    assert.equal(moodImageSlots({ ...moods, images: activeMoodImages(moods, 'premium') }).length, 8);
    assert.deepEqual(Object.keys(activeMoodImages(moods, 'premium')), MOOD_NAMES.slice(0, 4));
    assert.equal(moodImageSlots({ ...moods, images: activeMoodImages(moods, 'pro') }).length, 16);
    assert.deepEqual(activeMoodImages(moods, 'free'), {});
    delete moods.images.happy!.idleAssetId;
    assert.equal(activeMoodImages(moods, 'premium').surprised?.idleAssetId, 'idle-4');
    assert.equal(moods.images.thinking?.talkingAssetId, 'talk-7');
});


test('invalid stored decoration falls back to disabled defaults without weakening input validation', () => {
    const missingImages = defaultPetMoods(); missingImages.enabled = true;
    delete (missingImages as Partial<typeof missingImages>).images;
    assert.equal(savedPetMoods(missingImages).enabled, true);
    for (const value of [null, 'broken', [], { enabled: true }, { ...defaultPetMoods(), holdMs: -1 }, { ...defaultPetMoods(), images: null }]) {
        assert.deepEqual(savedPetMoods(value), defaultPetMoods());
        assert.throws(() => validatePetMoods(value));
    }
});
