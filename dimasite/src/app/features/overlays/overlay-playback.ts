import type { Snapshot } from './overlay-api.service';
import type { TestMedia } from './overlay-media.component';
import type { AlertEvent, AlertLayout, EventKind, OverlayWidget } from './overlay.model';
import { ALERT_EVENTS } from './overlay.model';
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

/** OBS starts these deadlines only once the prepared event is mounted. */
export function placementStartSeconds(event: OverlayRenderEvent, widget: OverlayWidget): number {
  return event.tts && !event.media ? event.tts.durationMs / 1000
    : event.media ? 30 : event.layouts?.[widget.designId || '']?.duration || 5;
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
