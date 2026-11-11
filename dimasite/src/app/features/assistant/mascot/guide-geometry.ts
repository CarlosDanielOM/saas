/**
 * Pure geometry for the guide overlay: where the flying mascot stands next to a highlighted element.
 * No DOM access, so it can be unit-tested with plain `node --test`.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type GuideSide = 'left' | 'right' | 'below' | 'above' | 'inside';

export interface FigurePlacement {
  x: number;
  y: number;
  side: GuideSide;
  /** Mirror the figure so its pointing arm faces the target. */
  flip: boolean;
}

export interface PlacementOptions {
  /** Space between the element and the figure. */
  gap?: number;
  /** Minimum distance from the viewport edges. */
  margin?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The part of `box` inside the viewport (empty when it is off screen). */
export function visiblePart(box: Box, viewport: Size): Box {
  const left = clamp(box.left, 0, viewport.width);
  const top = clamp(box.top, 0, viewport.height);
  const right = clamp(box.left + box.width, 0, viewport.width);
  const bottom = clamp(box.top + box.height, 0, viewport.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function isOnScreen(box: Box, viewport: Size): boolean {
  const part = visiblePart(box, viewport);
  return part.width > 0 && part.height > 0;
}

/**
 * Stand to the left of the element (pointing right), else to its right (mirrored), else below or above it,
 * else inside its visible top-right corner (for elements bigger than the screen). Always inside the viewport.
 */
export function placeFigure(target: Box, viewport: Size, figure: Size, options: PlacementOptions = {}): FigurePlacement {
  const gap = options.gap ?? 10;
  const margin = options.margin ?? 8;
  const seen = visiblePart(target, viewport);
  const box = seen.width > 0 && seen.height > 0 ? seen : target;
  const maxX = viewport.width - margin - figure.width;
  const maxY = viewport.height - margin - figure.height;
  const midY = clamp(box.top + box.height / 2 - figure.height / 2, margin, maxY);

  const left = target.left - gap - figure.width;
  if (left >= margin) return { x: left, y: midY, side: 'left', flip: false };

  const right = target.left + target.width + gap;
  if (right <= maxX) return { x: right, y: midY, side: 'right', flip: true };

  // Below/above: under the element's start, so the raised arm points up at it.
  const startX = clamp(box.left + Math.min(box.width, 160) / 2 - figure.width / 2, margin, maxX);
  const below = target.top + target.height + gap;
  if (below <= maxY) return { x: startX, y: below, side: 'below', flip: false };

  const above = target.top - gap - figure.height;
  if (above >= margin) return { x: startX, y: above, side: 'above', flip: false };

  return {
    x: clamp(box.left + box.width - figure.width - gap, margin, maxX),
    y: clamp(box.top + gap, margin, maxY),
    side: 'inside',
    flip: true,
  };
}

/**
 * Speech label next to the figure, on the side away from the element so it never covers it: above the figure and
 * stretching away from the element when standing beside it; beside the figure when standing below/above it.
 */
export function placeLabel(figureAt: { x: number; y: number }, figure: Size, label: Size, viewport: Size, side: GuideSide = 'left', margin = 8): { x: number; y: number } {
  const maxX = viewport.width - margin - label.width;
  const maxY = viewport.height - margin - label.height;
  if (side === 'below' || side === 'above') {
    const y = clamp(figureAt.y + figure.height / 2 - label.height / 2, margin, maxY);
    const right = figureAt.x + figure.width + 6;
    if (right <= maxX) return { x: right, y };
    const left = figureAt.x - 6 - label.width;
    if (left >= margin) return { x: left, y };
    return { x: clamp(figureAt.x, margin, maxX), y: side === 'below' ? clamp(figureAt.y + figure.height + 6, margin, maxY) : clamp(figureAt.y - label.height - 6, margin, maxY) };
  }
  // Beside the element: grow away from it (left of a figure on the left, right of a figure on the right).
  const x = side === 'left' ? clamp(figureAt.x + figure.width - label.width, margin, maxX)
    : side === 'right' ? clamp(figureAt.x, margin, maxX)
      : clamp(figureAt.x + figure.width / 2 - label.width / 2, margin, maxX);
  const above = figureAt.y - label.height - 6;
  const y = above >= margin ? above : Math.min(figureAt.y + figure.height + 6, maxY);
  return { x, y };
}

/** Highlight ring around the element, padded, in viewport coordinates. */
export function ringBox(target: Box, pad = 6): Box {
  return { left: target.left - pad, top: target.top - pad, width: target.width + pad * 2, height: target.height + pad * 2 };
}

/** Ease-out cubic: fast start, gentle landing. */
export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/** Point along a short hop from `from` to `to` (the arc lifts the figure mid-flight). */
export function flightPoint(from: { x: number; y: number }, to: { x: number; y: number }, progress: number, lift = 56): { x: number; y: number } {
  const p = easeOut(progress);
  const arc = Math.sin(Math.PI * clamp(progress, 0, 1)) * lift;
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p - arc };
}

/** CSS selector for an anchor key (keys are a fixed list, but never trust them inside a selector). */
export function anchorSelector(key: string): string {
  return `[data-assistant-anchor="${key.replace(/["\\]/g, '\\$&')}"]`;
}
