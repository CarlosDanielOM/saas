import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayDraftStorage, type LocalOverlayDraft } from './overlay-draft-storage.service';
import { createWidget } from './overlay-widget-registry';
import { makeDesign } from './overlay.model';

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
});
