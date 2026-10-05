import { describe, expect, it } from 'vitest';
import { placeTrigger, triggerPlacementMargin } from './overlay-trigger-placement';
import type { OverlayWidget } from './overlay.model';

const canvas = { width: 1920, height: 1080 };
const widget: OverlayWidget = { id: 'trigger-a', kind: 'trigger', x: 70, y: 80, width: 400, height: 200,
  visible: true, locked: false, triggerPlacement: { mode: 'random', margin: 24 } };

describe('trigger placement', () => {
  it('preserves legacy and explicit fixed positions, including off-canvas coordinates', () => {
    for (const triggerPlacement of [undefined, { mode: 'fixed' as const, margin: 24 }]) {
      const fixed = { ...widget, x: -200, triggerPlacement };
      expect(placeTrigger(fixed, canvas, 'event')).toEqual(fixed);
    }
  });
  it('agrees across sources, varies between events/widgets, and never mutates the draft', () => {
    const before = structuredClone(widget), first = placeTrigger(widget, canvas, 'event-a');
    expect(placeTrigger(widget, canvas, 'event-a')).toEqual(first);
    expect(placeTrigger(widget, canvas, 'event-b')).not.toEqual(first);
    expect(placeTrigger({ ...widget, id: 'trigger-b' }, canvas, 'event-a').x).not.toBe(first.x);
    expect(widget).toEqual(before);
  });
  it('keeps every placement inside the margin on landscape and portrait canvases', () => {
    for (const size of [canvas, { width: 390, height: 844 }, { width: 100, height: 100 }]) {
      for (let i = 0; i < 200; i++) {
        const placed = placeTrigger(widget, size, String(i));
        expect(placed.x).toBeGreaterThanOrEqual(24);
        expect(placed.y).toBeGreaterThanOrEqual(24);
        expect(placed.x + placed.width).toBeLessThanOrEqual(size.width - 24 + 1e-9);
        expect(placed.y + placed.height).toBeLessThanOrEqual(size.height - 24 + 1e-9);
        expect(placed.width / placed.height).toBeCloseTo(2);
      }
    }
  });
  it('keeps the chosen size when it fits and proportionally shrinks oversized media', () => {
    expect(placeTrigger(widget, canvas, 'event').width).toBe(widget.width);
    const placed = placeTrigger(widget, { width: 300, height: 150 }, 'event');
    expect(placed.width).toBe(204); expect(placed.height).toBe(102);
  });
  it('safely reduces excessive margins after a canvas resize and supports zero margin', () => {
    const tiny = { width: 100, height: 100 }, largeMargin = { ...widget, triggerPlacement: { mode: 'random' as const, margin: 500 } };
    expect(triggerPlacementMargin(tiny, 500)).toBe(40);
    const placed = placeTrigger(largeMargin, tiny, 'event');
    expect(placed.x).toBeGreaterThanOrEqual(40); expect(placed.x + placed.width).toBeLessThanOrEqual(60);
    expect(placed.y).toBeGreaterThanOrEqual(40); expect(placed.y + placed.height).toBeLessThanOrEqual(60);
    const zero = placeTrigger({ ...widget, triggerPlacement: { mode: 'random', margin: 0 } }, canvas, 'event');
    expect(zero.width).toBe(400); expect(zero.x).toBeGreaterThanOrEqual(0);
  });
});
