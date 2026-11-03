import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPetMoods, normalizePetMoodMetadata, normalizePetMoodsSettings } from './pet-moods.model';

describe('incoming pet mood settings', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    undefined, null, false, 1, 'broken', [], {},
    { ...defaultPetMoods(), enabled: 'true' },
    { ...defaultPetMoods(), enabled: true, holdMs: -1 },
    { ...defaultPetMoods(), enabled: true, holdMs: 10_001 },
    { ...defaultPetMoods(), enabled: true, holdMs: 1.5 },
    { ...defaultPetMoods(), enabled: true, holdMs: '2000' },
    { ...defaultPetMoods(), enabled: true, emotions: null },
    { ...defaultPetMoods(), enabled: true, emotions: [] },
    { ...defaultPetMoods(), enabled: true, emotions: { ...defaultPetMoods().emotions, happy: 'happy' } },
    { ...defaultPetMoods(), enabled: true, emotions: { ...defaultPetMoods().emotions, happy: [null] } },
    { ...defaultPetMoods(), enabled: true, emotions: { ...defaultPetMoods().emotions, happy: ['whisper'] } },
    { ...defaultPetMoods(), enabled: true, emotions: { ...defaultPetMoods().emotions, thinking: ['happy'] } },
    { ...defaultPetMoods(), enabled: true, images: null },
    { ...defaultPetMoods(), enabled: true, images: [] },
    { ...defaultPetMoods(), enabled: true, images: { happy: 'missing' } },
    { ...defaultPetMoods(), enabled: true, images: { happy: { idleAssetId: 'https://example.invalid/image' } } },
    { ...defaultPetMoods(), enabled: true, images: { happy: { talkingAssetId: null } } },
    { ...defaultPetMoods(), enabled: true, images: { custom: { idleAssetId: 'a'.repeat(24) } } },
  ])('defaults corrupt/legacy value to disabled without throwing: %o', input => {
    expect(() => normalizePetMoodsSettings(input)).not.toThrow();
    expect(normalizePetMoodsSettings(input)).toEqual(defaultPetMoods());
  });

  it('handles a throwing accessor safely', () => {
    const input = { get enabled(): boolean { throw new Error('legacy getter'); } };
    expect(normalizePetMoodsSettings(input)).toEqual(defaultPetMoods());
  });

  it('keeps valid settings and creates an independent editable copy', () => {
    const input = defaultPetMoods(); input.enabled = true; input.holdMs = 0;
    input.images.happy = { idleAssetId: 'a'.repeat(24) };
    const normalized = normalizePetMoodsSettings(input);
    expect(normalized).toEqual(input);
    normalized.emotions.happy.pop(); delete normalized.images.happy?.idleAssetId;
    expect(input.emotions.happy).toEqual(defaultPetMoods().emotions.happy);
    expect(input.images.happy.idleAssetId).toBe('a'.repeat(24));
  });
});


describe('optional mood wire data', () => {
  it('keeps old snapshots without moods unchanged', () => {
    expect(normalizePetMoodMetadata(undefined, undefined)).toEqual({});
  });
  it.each([null, false, [], 'bad', { available: true, enabled: true, holdMs: Infinity, emotions: {} }])('ignores malformed config: %o', input => {
    expect(() => normalizePetMoodMetadata(input, {})).not.toThrow();
    expect(normalizePetMoodMetadata(input, {})).toEqual({ moods: { available: false, enabled: false } });
  });
  it('isolates malformed per-state images and throwing diagnostics', () => {
    const settings = defaultPetMoods();
    const config = { available: true, enabled: true, holdMs: settings.holdMs, emotions: settings.emotions };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('logging offline'); });
    const images = { happy: { idleUrl: { invalid: true }, talkingUrl: '/normal-test' }, sad: 'bad' };
    expect(() => normalizePetMoodMetadata(config, images)).not.toThrow();
    expect(normalizePetMoodMetadata(config, images).assets).toEqual({ happy: { idleUrl: null, talkingUrl: '/normal-test' } });
    warn.mockRestore();
  });
});
