import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayDraftStorage, type LocalOverlayDraft } from './overlay-draft-storage.service';
import { createWidget } from './overlay-widget-registry';
import { makeDesign } from './overlay-model.generated';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}

function draft(): LocalOverlayDraft {
  return { schemaVersion: 1, channelID: '123', updatedAt: Date.now(), revision: 1, sceneId: 'scene-a', designEvent: 'follow', selectedId: 'poll-a',
    scenes: [{ id: 'scene-a', name: 'Scene', width: 1920, height: 1080, waitFor: [], widgets: [
      { ...createWidget('poll', { id: 'poll-a', placement: 'scene' })!, configVersion: undefined, interactionDesign: 'compact' },
      createWidget('prediction', { id: 'prediction-a', placement: 'scene' })!
    ] }], designs: [makeDesign('design-a', 'Design')], designDraft: null };
}
describe('module-aware local draft recovery', () => {
  let storage: OverlayDraftStorage;
  let local: Storage;
  beforeEach(() => {
    local = new MemoryStorage();
    TestBed.configureTestingModule({ providers: [OverlayDraftStorage, { provide: DOCUMENT, useValue: { defaultView: { localStorage: local, sessionStorage: new MemoryStorage() } } }] }); storage = TestBed.inject(OverlayDraftStorage);
  });
  afterEach(() => TestBed.resetTestingModule());
  it('recovers legacy and current poll/prediction widgets and their independent presets', () => {
    const value = draft(); storage.write('123', value);
    const recovered = storage.find('123');
    expect(recovered?.draft.scenes[0].widgets.map(widget => widget.kind)).toEqual(['poll', 'prediction']);
    expect(recovered?.draft.scenes[0].widgets[0].interactionDesign).toBe('compact');
    expect(recovered?.draft.scenes[0].widgets[1].interactionDesign).toBe('card');
    expect(storage.find('other-channel')).toBeNull();
  });
  it('recovers designs with Dima library sounds and gifted subs looks (the default alerts)', () => {
    const value: LocalOverlayDraft = { ...draft(), writer: 2 }, design = value.designs[0];
    design.events.follow = { ...design.events.follow, sounds: [{ id: 'sound', library: 'dima-follow-sound', volume: .8, delay: 0, fadeIn: 0, fadeOut: 0 }] };
    design.variants = { sub: [{ id: 'gift-look', name: 'Gifted subs', enabled: true, gift: true, layout: structuredClone(design.events.sub) }] };
    storage.write('123', value);
    const recovered = storage.find('123')?.draft.designs[0];
    expect(recovered?.events.follow.sounds?.[0]?.library).toBe('dima-follow-sound');
    expect(recovered?.variants?.sub?.[0]?.gift).toBe(true);
  });
  it('still rejects a sound from an unknown library item', () => {
    const value: LocalOverlayDraft = { ...draft(), writer: 2 };
    value.designs[0].events.follow = { ...value.designs[0].events.follow, sounds: [{ id: 'sound', library: 'dima-follow-badge', volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }] };
    storage.write('123', value);
    expect(storage.find('123')).toBeNull();
  });
  it('recovers a clip layer volume and rejects one out of range or on another layer', () => {
    const value = draft(); value.scenes[0].widgets.push({ ...createWidget('clip', { id: 'clip-a', placement: 'scene' })!, volume: .35 }); storage.write('123', value);
    expect(storage.find('123')?.draft.scenes[0].widgets.find(widget => widget.kind === 'clip')?.volume).toBe(.35);
    for (const edit of [(v: LocalOverlayDraft) => { v.scenes[0].widgets[2].volume = 1.5; }, (v: LocalOverlayDraft) => { v.scenes[0].widgets[2].loop = false; }, (v: LocalOverlayDraft) => { v.scenes[0].widgets[0].volume = .5; }]) {
      const bad = structuredClone(value); edit(bad); local.clear(); storage.write('123', bad);
      expect(storage.find('123')).toBeNull();
    }
  });
  it('leaves unsupported drafts intact and still offers the newest recoverable draft', () => {
    const old = draft(); storage.write('123', old);
    const unsupported = draft(); unsupported.updatedAt++; unsupported.scenes[0].widgets[0].configVersion = 2;
    local.setItem('domdimabot-overlay-draft:123:future', JSON.stringify(unsupported));
    expect(storage.find('123')?.draft.updatedAt).toBe(old.updatedAt);
    expect(local.getItem('domdimabot-overlay-draft:123:future')).toBe(JSON.stringify(unsupported));
  });
  it('rejects invalid module config and placement without deleting the copy', () => {
    const invalid = draft(); invalid.designs[0].events.follow.widgets.push(invalid.scenes[0].widgets[0]); storage.write('123', invalid);
    expect(storage.find('123')).toBeNull(); expect(local.length).toBe(1);
    const invalidPreset = draft(); invalidPreset.scenes[0].widgets[0].config = { interactionDesign: 'unknown' }; storage.write('123', invalidPreset);
    expect(storage.find('123')).toBeNull(); expect(local.length).toBe(1);
  });
  it('deletes copies that hold nothing new instead of offering them', () => {
    const newer = draft(); newer.updatedAt += 10; newer.scenes[0].name = 'Same as saved';
    const older = draft(); older.scenes[0].name = 'Unsaved edit';
    local.setItem('domdimabot-overlay-draft:123:newer', JSON.stringify(newer));
    local.setItem('domdimabot-overlay-draft:123:older', JSON.stringify(older));
    const offered = storage.find('123', copy => copy.scenes[0].name === 'Same as saved');
    expect(offered?.key).toBe('domdimabot-overlay-draft:123:older');
    expect(local.getItem('domdimabot-overlay-draft:123:newer')).toBeNull();
    expect(storage.find('123', () => true)).toBeNull(); expect(local.length).toBe(0);
  });
  it('keeps a copy another tab rewrote between the check and the delete', () => {
    const key = 'domdimabot-overlay-draft:123:other-tab', newer = draft(); newer.scenes[0].name = 'New work';
    local.setItem(key, JSON.stringify(draft()));
    expect(storage.find('123', () => { local.setItem(key, JSON.stringify(newer)); return true; })).toBeNull();
    expect(local.getItem(key)).toBe(JSON.stringify(newer));
  });
  it('discarding deletes only the copy that was offered', () => {
    const at = (offset: number, name: string) => { const value = draft(); value.updatedAt += offset; value.scenes[0].name = name; return value; };
    local.setItem('domdimabot-overlay-draft:123:older', JSON.stringify(at(-20, 'Older')));
    local.setItem('domdimabot-overlay-draft:123:offered', JSON.stringify(at(0, 'Offered')));
    const offered = storage.find('123')!;
    expect(offered.key).toBe('domdimabot-overlay-draft:123:offered');
    storage.discard(offered);
    expect(local.getItem('domdimabot-overlay-draft:123:offered')).toBeNull();
    expect(storage.find('123')?.draft.scenes[0].name).toBe('Older');
  });
});
