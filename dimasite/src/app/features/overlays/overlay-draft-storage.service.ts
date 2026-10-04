import { validKeyframes } from './overlay-keyframes.model';
import { CLIP_DESIGN_VARIANTS } from '../clips/clips.model';
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { ALERT_EVENTS, EVENT_KINDS, ALERT_TRANSITIONS, ALERT_LOOPS, type AlertDesign, type AlertEvent, type OverlayScene, type OverlayWidget } from './overlay.model';

export type DraftScene = Omit<OverlayScene, 'publicId' | 'published' | 'revision'>;
export interface LocalOverlayDraft {
  schemaVersion: 1;
  channelID: string;
  updatedAt: number;
  revision: number;
  scenes: DraftScene[];
  designs: AlertDesign[];
  designDraft: AlertDesign | null;
  sceneId: string;
  designEvent: AlertEvent;
  variantId?: string | null;
  selectedId: string | null;
}
export interface OverlayRecovery { key: string; serialized: string; draft: LocalOverlayDraft }
const PREFIX = 'domdimabot-overlay-draft:';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validMotion(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || !ALERT_TRANSITIONS.includes(value['enter'] as never) || !ALERT_TRANSITIONS.includes(value['exit'] as never) || !ALERT_LOOPS.includes(value['loop'] as never)) return false;
  return ([['delay', 0, 120], ['enterDuration', .1, 5], ['exitDuration', .1, 5], ['loopDuration', .2, 10]] as [string, number, number][]).every(([key, min, max]) => {
    const n = value[key]; return finite(n) && n >= Number(min) && n <= Number(max);
  });
}
function validWidgets(value: unknown): value is OverlayWidget[] {
  return Array.isArray(value) && value.length <= 1000 && value.every(w => record(w)
    && typeof w['id'] === 'string' && typeof w['kind'] === 'string'
    && ['tts', 'trigger', 'clip', 'alert', 'text', 'image', 'video', 'animation', 'shape'].includes(w['kind'])
    && ['x', 'y', 'width', 'height'].every(key => finite(w[key]))
    && typeof w['visible'] === 'boolean' && typeof w['locked'] === 'boolean'
    && ['name', 'mediaUrl', 'assetId', 'color', 'designId', 'text'].every(key => w[key] === undefined || typeof w[key] === 'string')
    && (w['clipDesign'] === undefined || w['kind'] === 'clip' && CLIP_DESIGN_VARIANTS.includes(w['clipDesign'] as never))
    && (w['triggerIds'] === undefined || w['kind'] === 'trigger' && Array.isArray(w['triggerIds']) && w['triggerIds'].length <= 1000 && new Set(w['triggerIds']).size === w['triggerIds'].length && w['triggerIds'].every(value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)))
    && (w['keyframes'] === undefined || validKeyframes(w['keyframes']))
    && validStyle(w) && validMotion(w['motion'])
    && (w['fontSize'] === undefined || finite(w['fontSize']))
    && (w['events'] === undefined || Array.isArray(w['events']) && w['events'].every(event => ALERT_EVENTS.includes(event))));
}
function validSound(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || typeof value['assetId'] !== 'string' || !/^[a-f0-9]{24}$/.test(value['assetId'])) return false;
  if (value['name'] !== undefined && (typeof value['name'] !== 'string' || !value['name'].trim() || value['name'].length > 120)) return false;
  return ([['volume', 1], ['delay', 120], ['fadeIn', 10], ['fadeOut', 10]] as [string, number][]).every(([key, max]) => finite(value[key]) && value[key] >= 0 && value[key] <= max);
}
function validStyle(w: Record<string, unknown>): boolean {
  if (Object.entries({fontFamily:['sans','serif','mono'],fontWeight:[400,700],textAlign:['left','center','right'],shape:['rectangle','ellipse']}).some(([key, values]) => w[key] !== undefined && !(values as unknown[]).includes(w[key]))) return false;
  if (w['italic'] !== undefined && typeof w['italic'] !== 'boolean') return false;
  if (([['borderWidth',40],['radius',500],['opacity',1]] as const).some(([key,max]) => w[key] !== undefined && (!finite(w[key]) || w[key] < 0 || w[key] > max))) return false;
  const color = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (w['borderColor'] !== undefined && !color(w['borderColor'])) return false;
  const shadow = w['shadow'];
  return shadow === undefined || record(shadow) && color(shadow['color']) && finite(shadow['blur']) && shadow['blur'] >= 0 && shadow['blur'] <= 100 && ['x','y'].every(key => finite(shadow[key]) && Math.abs(shadow[key]) <= 100);
}
function validLayout(layout: unknown): boolean { return record(layout) && finite(layout['duration']) && layout['duration'] >= 1 && layout['duration'] <= 120 && validWidgets(layout['widgets']) && validSound(layout['sound']); }
function validDesign(value: unknown): value is AlertDesign {
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['name'] !== 'string'
    || !finite(value['width']) || !finite(value['height']) || !finite(value['revision'])) return false;
  const events = value['events'];
  if (value['variants'] !== undefined) {
    const variants = value['variants'];
    if (!record(variants) || Object.entries(variants).some(([kind, items]) => !['sub','bits','raid'].includes(kind) || !Array.isArray(items) || items.length > 10 || items.some(v => !record(v) || typeof v['id'] !== 'string' || typeof v['name'] !== 'string' || typeof v['enabled'] !== 'boolean' || !validLayout(v['layout']) || (kind === 'sub' ? !['1000','2000','3000'].includes(v['tier'] as string) : !finite(v['min']) || v['min'] < 0 || (v['max'] !== undefined && (!finite(v['max']) || v['max'] < v['min'])))))) return false;
  }
  return record(events) && ALERT_EVENTS.every(kind => {
    const layout = events[kind];
    return validLayout(layout);
  });
}
function parseDraft(serialized: string, channel: string): LocalOverlayDraft | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!record(value) || value['schemaVersion'] !== 1 || value['channelID'] !== channel
      || !finite(value['updatedAt']) || !Number.isInteger(value['revision']) || Number(value['revision']) < 0
      || typeof value['sceneId'] !== 'string' || !ALERT_EVENTS.includes(value['designEvent'] as AlertEvent)
      || !(value['variantId'] === undefined || value['variantId'] === null || typeof value['variantId'] === 'string')
      || !(value['selectedId'] === null || typeof value['selectedId'] === 'string')) return null;
    const scenes = value['scenes'], designs = value['designs'];
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > 1000
      || !scenes.every(s => record(s) && typeof s['id'] === 'string' && typeof s['name'] === 'string'
        && finite(s['width']) && finite(s['height']) && validWidgets(s['widgets'])
        && Array.isArray(s['waitFor']) && s['waitFor'].every(kind => EVENT_KINDS.includes(kind)))
      || !Array.isArray(designs) || !designs.length || designs.length > 1000 || !designs.every(validDesign)
      || !(value['designDraft'] === null || validDesign(value['designDraft']))) return null;
    if (!scenes.some(s => s.id === value['sceneId']) || scenes.some(s => s.widgets.some((w: OverlayWidget) => w.kind === 'alert' && !designs.some(d => d.id === w.designId)))) return null;
    return value as unknown as LocalOverlayDraft;
  } catch { return null; }
}

/** Recovery copies belong to a channel and tab, and never contain account credentials or OBS URLs. */
@Injectable()
export class OverlayDraftStorage {
  private readonly document = inject(DOCUMENT);
  private tabId = '';
  private previousTabId = '';
  private get storage(): Storage {
    const storage = this.document.defaultView?.localStorage;
    if (!storage) throw new Error('Local storage unavailable');
    return storage;
  }
  private key(channel: string): string {
    if (!this.tabId) {
      this.tabId = crypto.randomUUID();
      try {
        const session = this.document.defaultView?.sessionStorage;
        const previous = session?.getItem('domdimabot-overlay-tab');
        if (previous && /^[a-f0-9-]{36}$/.test(previous)) this.previousTabId = previous;
        // A duplicated tab inherits sessionStorage. Give every editor instance its own
        // writer ID, while retaining the previous ID solely to prefer its recovery copy.
        session?.setItem('domdimabot-overlay-tab', this.tabId);
      } catch { /* The in-memory tab identity still keeps other tabs' drafts separate. */ }
    }
    return `${PREFIX}${channel}:${this.tabId}`;
  }
  find(channel: string): OverlayRecovery | null {
    const storage = this.storage, ownKey = this.key(channel);
    const preferredKey = `${PREFIX}${channel}:${this.previousTabId}`;
    let latest: OverlayRecovery | null = null;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(`${PREFIX}${channel}:`)) continue;
      const serialized = storage.getItem(key);
      const draft = serialized && parseDraft(serialized, channel);
      if (!draft || !serialized) continue;
      const recovery = { key, serialized, draft };
      if (key === ownKey || key === preferredKey) return recovery;
      if (!latest || draft.updatedAt > latest.draft.updatedAt) latest = recovery;
    }
    return latest;
  }
  write(channel: string, draft: LocalOverlayDraft): void { this.storage.setItem(this.key(channel), JSON.stringify(draft)); }
  clear(channel: string): void { this.storage.removeItem(this.key(channel)); }
  discard(recovery: OverlayRecovery): void {
    // Another tab may have updated this copy since the recovery banner appeared.
    if (this.storage.getItem(recovery.key) === recovery.serialized) this.storage.removeItem(recovery.key);
  }
}
