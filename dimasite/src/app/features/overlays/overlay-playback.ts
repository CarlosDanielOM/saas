import type { Snapshot } from './overlay-api.service';
import type { TestMedia } from './overlay-media.component';
import type { AlertEvent, AlertLayout, EventKind, OverlayWidget } from './overlay-model.generated';
import { ALERT_EVENTS } from './overlay-model.generated';
import { clipPlaybackLimit } from './overlay-clip-motion';
import type { OverlayPlatform } from './overlay-queue.model';

export type OverlayPlaybackId = string | number;
export interface OverlayRenderEvent {
  id: OverlayPlaybackId;
  kind: EventKind;
  platform?: OverlayPlatform;
  media?: TestMedia;
  text?: string;
  tts?: { speechID: string; ownerClientId: string | null; durationMs: number };
  layouts?: Record<string, AlertLayout>;
  /** A trigger's look (alert-style layout on its own canvas). When present, trigger boxes play it instead of `media`. */
  look?: TriggerLook;
}
export interface TriggerLook { width: number; height: number; layout: AlertLayout }
/** The layout a placement plays and the canvas its objects are positioned on. */
export interface PlacementLayout { layout: AlertLayout; width: number; height: number; key: string; look: boolean }
/** A usable look, else undefined (a malformed one falls back to the plain media). */
export function eventLook(event: Pick<OverlayRenderEvent, 'look'>): TriggerLook | undefined {
  const look = event.look;
  return look && Number.isFinite(look.width) && look.width > 0 && Number.isFinite(look.height) && look.height > 0
    && look.layout && Array.isArray(look.layout.widgets) ? look : undefined;
}
/**
 * Which layout a placement plays, and on what canvas: a trigger box plays the event's look (its own size),
 * an alert box the layout of its design (the design's size).
 */
export function placementLayout(event: Pick<OverlayRenderEvent, 'look' | 'layouts'>, widget: OverlayWidget, designs: readonly { id: string; width?: number; height?: number }[] = []): PlacementLayout | null {
  if (widget.kind === 'trigger') {
    const look = eventLook(event);
    return look ? { layout: look.layout, width: look.width, height: look.height, key: '$look', look: true } : null;
  }
  const layout = event.layouts?.[widget.designId || '']; if (!layout) return null;
  const design = designs.find(d => d.id === widget.designId);
  return { layout, width: design?.width || 800, height: design?.height || 240, key: widget.designId || '', look: false };
}
/** Look media come as server playback URLs; a relative one is resolved against the API, like a trigger's plain media. */
export function absoluteLook(look: TriggerLook, base: string): TriggerLook {
  const absolute = <T extends string | undefined>(url: T): T => (url?.startsWith('/') ? base + url : url) as T;
  const layout = look.layout;
  return { ...look, layout: { ...layout, widgets: layout.widgets.map(part => part.mediaUrl?.startsWith('/') ? { ...part, mediaUrl: absolute(part.mediaUrl) } : part),
    ...(layout.sounds ? { sounds: layout.sounds.map(sound => sound.url?.startsWith('/') ? { ...sound, url: absolute(sound.url) } : sound) } : {}) } };
}
/** A look keeps its aspect ratio inside the box (like object-fit: contain): the stage rectangle in % of the box. */
export function lookFit(look: { width: number; height: number }, box: { width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const scale = Math.min(box.width / look.width, box.height / look.height);
  if (!Number.isFinite(scale) || scale <= 0) return { left: 0, top: 0, width: 100, height: 100 };
  const width = look.width * scale / box.width * 100, height = look.height * scale / box.height * 100;
  return { left: (100 - width) / 2, top: (100 - height) / 2, width, height };
}
/** Prepared playback data only; networking, queues and receipts stay with the caller. */
export interface OverlayRenderJob {
  event: OverlayRenderEvent;
  widgets: readonly OverlayWidget[];
  snapshot: Snapshot;
  assets?: ReadonlyMap<string, { url: string }>;
  playbackKey?: OverlayPlaybackId;
  pending?: ReadonlySet<string>;
  audioWidgetId?: string;
  idle?: boolean;
}
export interface OverlayPlacementReport { id: OverlayPlaybackId; widgetId: string; duration?: number }

/** Designed alerts stay hidden until their displayed pictures are decoded; media and TTS report their own start. */
export function waitsForPictures(event: OverlayRenderEvent): boolean { return !!eventLook(event) || !event.media && !event.tts; }
/** An alert whose pictures never become ready is still shown after this long. */
export const ALERT_READY_LIMIT_MS = 8000;
/** Until the renderer reports readiness, a waiting alert's deadline also covers the wait. */
export function placementMountSeconds(event: OverlayRenderEvent, widget: OverlayWidget): number {
  return placementStartSeconds(event, widget) + (waitsForPictures(event) ? ALERT_READY_LIMIT_MS / 1000 + 2 : 0);
}
/** OBS starts these deadlines only once the prepared event is mounted. */
export function placementStartSeconds(event: OverlayRenderEvent, widget: OverlayWidget): number {
  if (event.tts && !event.media) return event.tts.durationMs / 1000;
  const play = placementLayout(event, widget);
  return play?.look ? play.layout.duration || 5 : event.media ? 30 : play?.layout.duration || 5;
}
/** A real media start replaces its loading deadline, independently for every placement. */
export function placementMediaSeconds(event: OverlayRenderEvent, actualDuration?: number): number {
  return event.kind === 'clip' ? clipPlaybackLimit(event.media, actualDuration) + 4
    : event.media?.type === 'image' ? 5
    : event.media?.duration ?? (Number.isFinite(actualDuration) && actualDuration! > 0 ? actualDuration! + 15 : 300);
}
export function alertPlacementIds(widgets: readonly OverlayWidget[], kind: EventKind): string[] {
  return ALERT_EVENTS.includes(kind as AlertEvent)
    ? widgets.filter(w => w.visible && w.kind === 'alert' && w.events?.includes(kind as AlertEvent)).map(w => w.id) : [];
}
export function sceneScale(scene: { width: number; height: number }, viewport: { width: number; height: number }): number {
  const scale = Math.min(viewport.width / scene.width, viewport.height / scene.height);
  return viewport.width > 0 && viewport.height > 0 && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
