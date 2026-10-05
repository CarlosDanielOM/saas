import type { OverlayWidget } from './overlay.model';

interface CanvasSize { width: number; height: number }

/** Keep a usable area even when a saved margin outgrows a resized canvas. */
export function triggerPlacementMargin(canvas: CanvasSize, margin: number): number {
  return Math.max(0, Math.min(margin, (Math.min(canvas.width, canvas.height) - 20) / 2));
}

/** Resolve once per event. The same event/widget seed agrees across browser sources. */
export function placeTrigger(widget: OverlayWidget, canvas: CanvasSize, eventId: string): OverlayWidget {
  if (widget.kind !== 'trigger' || widget.triggerPlacement?.mode !== 'random') return { ...widget };
  const margin = triggerPlacementMargin(canvas, widget.triggerPlacement.margin);
  const availableWidth = canvas.width - 2 * margin, availableHeight = canvas.height - 2 * margin;
  const scale = Math.min(1, availableWidth / widget.width, availableHeight / widget.height);
  const width = widget.width * scale, height = widget.height * scale;
  let seed = 2166136261;
  for (const char of JSON.stringify([eventId, widget.id])) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const random = () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  return { ...widget, width, height,
    x: margin + random() * Math.max(0, availableWidth - width),
    y: margin + random() * Math.max(0, availableHeight - height) };
}
