import { signal } from '@angular/core';
import type { TriggerLookState, TriggerLookSummary, TriggerLookTarget } from '../triggers/triggers.model';
import { TriggerLookError, type TriggerLooksService } from '../triggers/trigger-looks.service';
import { createWidget } from './overlay-widget-registry';
import { defaultMotion } from './overlay-object-motion';
import { layoutSounds, makeDesign, withSoundList, type AlertDesign, type AlertLayout, type AlertSound, type OverlayWidget } from './overlay.model';

export type { TriggerLookClosed, TriggerLookTarget } from '../triggers/triggers.model';

/** The editor holds a look as an alert design with one layout (the `follow` event); this id marks it. */
export const LOOK_DESIGN_ID = 'trigger-look';
export const LOOK_CANVAS = { width: 1280, height: 720 };
const MEASURE_MS = 4000;
const FALLBACK_SECONDS = 10;
const clampLength = (seconds: number) => Math.min(120, Math.max(1, Math.ceil(seconds * 10 - 1e-6) / 10));

/** Fields the API adds in editor form (and the editor adds for previews); never sent back. */
function storedWidget(widget: OverlayWidget): OverlayWidget {
  if (!widget.mediaId) return widget;
  const { mediaUrl: _url, mediaType: _type, unavailable: _gone, ...rest } = widget;
  return rest;
}
function storedSound(sound: AlertSound): AlertSound {
  const { url: _url, mediaType: _type, unavailable: _gone, ...rest } = sound;
  return rest;
}
/** The layout as the look routes store it: `sounds` only, `mediaId` references, no resolved URLs. */
export function storedLookLayout(layout: AlertLayout): AlertLayout {
  const { sound: _legacy, sounds: _sounds, ...rest } = layout, sounds = layoutSounds(layout).map(storedSound);
  return { ...rest, widgets: layout.widgets.map(storedWidget), ...(sounds.length ? { sounds } : {}) };
}

/**
 * Look mode's data: loading or seeding a trigger's look, saving it with the loaded revision, removing it, text
 * previews and the trigger's master volume. Only `/triggers` routes: never Overlay Studio state.
 */
export class TriggerLookSession {
  /** The revision counter the editor loaded (sent with every save/remove). */
  revision = 0;
  /** The trigger's Volume (0–100): master volume for every sound and video of the look. */
  readonly volume = signal(100);
  /** The trigger has a saved look (false while editing a new, unsaved seed). */
  readonly stored = signal(false);
  /** The look as last loaded or saved (or the untouched seed), to tell unsaved changes. */
  readonly baseline = signal('');
  /** Saved or removed at least once since opening (the host refreshes the trigger). */
  changed = false;
  summary: TriggerLookSummary | null = null;
  /** A new look whose trigger file couldn't be found in the library: it starts empty, and the editor says so. */
  missingFile = false;

  constructor(readonly target: TriggerLookTarget, private readonly api: TriggerLooksService) {}

  fingerprint(design: AlertDesign | null): string {
    if (!design) return '';
    return JSON.stringify({ width: design.width, height: design.height, layout: storedLookLayout(design.events.follow) });
  }

  /** Loads the look, or seeds a new one from the trigger's own file (not saved until the user presses Save). */
  async open(name: string): Promise<AlertDesign> {
    const state = await this.api.get(this.target.channelID, this.target.triggerId);
    this.accept(state);
    const design = state.look ? this.design(name, state.look.width, state.look.height, state.look.layout as AlertLayout) : await this.seed(name);
    this.baseline.set(this.fingerprint(design));
    return design;
  }

  private accept(state: TriggerLookState): void {
    this.revision = state.revision; this.volume.set(Math.max(0, Math.min(100, Number(state.volume)))); this.stored.set(!!state.look);
  }

  private design(name: string, width: number, height: number, layout: AlertLayout): AlertDesign {
    const design = makeDesign(LOOK_DESIGN_ID, name);
    const normalized = withSoundList({ duration: Number(layout?.duration) || 5, widgets: Array.isArray(layout?.widgets) ? layout.widgets : [], ...(layout?.sounds ? { sounds: layout.sounds } : {}) });
    return { ...design, width, height, events: { ...design.events, follow: normalized } };
  }

  /**
   * New look: the trigger's file is the first content. A video fills the canvas (own sound, plays once), a
   * picture/GIF fits inside it (5 s), an audio file becomes the look's sound. Video/audio length = the file's.
   */
  async seed(name: string): Promise<AlertDesign> {
    const { width, height } = LOOK_CANVAS, t = this.target, layout: AlertLayout = { duration: 5, widgets: [] };
    const media = t.libraryItemID && t.mediaType && t.mediaUrl ? { mediaId: t.libraryItemID, mediaUrl: t.mediaUrl, mediaType: t.mediaType } : null;
    this.missingFile = !media;
    if (media && (t.mediaType === 'video' || t.mediaType === 'audio')) layout.duration = await measureLength(t.mediaUrl, t.mediaType);
    if (media && t.mediaType === 'video') {
      layout.widgets.push(this.object('video', { x: 0, y: 0, width, height }, { ...media, volume: 1, loop: false }));
    } else if (media && (t.mediaType === 'image' || t.mediaType === 'gif')) {
      const box = fit(await pictureSize(t.mediaUrl), width, height);
      layout.widgets.push(this.object('image', box, media));
    } else if (media && t.mediaType === 'audio') {
      layout.sounds = [{ id: 'sound-1', mediaId: media.mediaId, url: media.mediaUrl, mediaType: 'audio', name: t.mediaName || t.name, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }];
    }
    return this.design(name, width, height, layout);
  }

  private object(kind: 'image' | 'video', box: { x: number; y: number; width: number; height: number }, extra: Partial<OverlayWidget>): OverlayWidget {
    const base = createWidget(kind, { id: kind + '-1', placement: 'design' }) ?? { id: kind + '-1', kind, x: 0, y: 0, width: 0, height: 0, visible: true, locked: false };
    const { assetId: _asset, ...rest } = base;
    return { ...rest, ...box, name: this.target.mediaName || this.target.name, motion: { ...defaultMotion(kind), enter: 'none', exit: 'none' }, ...extra };
  }

  /** Saves the look; on success the editor's copy becomes the saved one. */
  async save(design: AlertDesign): Promise<void> {
    const layout = storedLookLayout(design.events.follow);
    const state = await this.api.save(this.target.channelID, this.target.triggerId, { width: design.width, height: design.height, layout, revision: this.revision });
    this.accept(state); this.changed = true; this.baseline.set(this.fingerprint(design));
    this.summary = { revision: state.revision, width: design.width, height: design.height, updatedAt: state.look?.updatedAt ?? new Date().toISOString(),
      objectCount: layout.widgets.length, soundCount: layoutSounds(layout).length };
  }

  /** Removes the look: the trigger plays its plain file everywhere again. */
  async remove(): Promise<void> {
    const state = await this.api.remove(this.target.channelID, this.target.triggerId, this.revision);
    this.accept(state); this.changed = true; this.summary = null;
  }

  /** Text previews as they show on stream; at most 100 templates per request. */
  async render(texts: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(texts)], batches = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, (i + 1) * 100));
    const rendered = await Promise.all(batches.map(async batch => (await this.api.render(this.target.channelID, batch)).map((value, i) => [batch[i], value] as const)));
    return Object.fromEntries(rendered.flat());
  }

  /** The editor's playback of the look: every sound and video volume times the master volume, as the server delivers it. */
  private factor(): number { return Math.max(0, Math.min(1, this.volume() / 100)); }
  playbackWidgets(widgets: readonly OverlayWidget[]): OverlayWidget[] {
    const factor = this.factor();
    return widgets.map(w => w.kind === 'video' && typeof w.volume === 'number' && factor !== 1 ? { ...w, volume: w.volume * factor } : w);
  }
  playbackSounds(sounds: readonly AlertSound[]): AlertSound[] {
    const factor = this.factor();
    return factor === 1 ? [...sounds] : sounds.map(s => ({ ...s, volume: s.volume * factor }));
  }

  /** Plain words for a failed save/remove, by the API's error code. */
  static errorKey(error: unknown): string {
    const code = error instanceof TriggerLookError ? error.code : null;
    switch (code) {
      case 'look_conflict': return 'lookConflict';
      case 'look_media_unavailable': return 'lookErrorUnavailable';
      case 'look_media_kind': return 'lookErrorKind';
      case 'look_too_large': case 'too_large': return 'lookErrorTooLarge';
      case 'invalid_look': return 'lookErrorInvalid';
      default: return error instanceof TriggerLookError && error.status === 403 ? 'lookErrorPermission' : 'lookErrorSave';
    }
  }
}

/** The file's real length (metadata), rounded up to 0.1 s and kept within 1–120 s; 10 s if it can't be read in time. */
export function measureLength(url: string, kind: 'video' | 'audio'): Promise<number> {
  return new Promise(resolve => {
    if (typeof document === 'undefined') { resolve(FALLBACK_SECONDS); return; }
    const element = document.createElement(kind);
    let done = false;
    const finish = (seconds: number) => {
      if (done) return; done = true; clearTimeout(timer);
      element.onloadedmetadata = null; element.onerror = null; element.removeAttribute('src'); element.load();
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(FALLBACK_SECONDS), MEASURE_MS);
    element.preload = 'metadata'; element.muted = true;
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) && element.duration > 0 ? clampLength(element.duration) : FALLBACK_SECONDS);
    element.onerror = () => finish(FALLBACK_SECONDS);
    element.src = url;
  });
}

/** A picture's natural size, or null when it can't be read in time. */
export function pictureSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    if (typeof Image === 'undefined') { resolve(null); return; }
    const image = new Image();
    let done = false;
    const finish = (size: { width: number; height: number } | null) => { if (!done) { done = true; clearTimeout(timer); image.onload = image.onerror = null; resolve(size); } };
    const timer = setTimeout(() => finish(null), MEASURE_MS);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

/** The largest box with the picture's aspect ratio inside the canvas, centred (the whole canvas when unknown). */
export function fit(size: { width: number; height: number } | null, width: number, height: number): { x: number; y: number; width: number; height: number } {
  if (!size) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / size.width, height / size.height);
  const w = Math.max(20, Math.round(size.width * scale)), h = Math.max(20, Math.round(size.height * scale));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}
