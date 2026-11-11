// Run: cd dimabot && node --import tsx --test ../dimasite/src/app/features/assistant/mascot/*.spec.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorSelector, flightPoint, isOnScreen, placeFigure, placeLabel, ringBox, visiblePart } from './guide-geometry.ts';

const vp = { width: 1280, height: 800 };
const fig = { width: 64, height: 70 };

test('stands left of the element, else right (mirrored), else below/above, else inside', () => {
  assert.deepEqual(placeFigure({ left: 400, top: 300, width: 200, height: 40 }, vp, fig), { x: 326, y: 285, side: 'left', flip: false });
  const right = placeFigure({ left: 20, top: 300, width: 200, height: 40 }, vp, fig);
  assert.equal(right.side, 'right');
  assert.equal(right.flip, true);
  assert.equal(right.x, 230);
  const phone = { width: 375, height: 700 };
  const below = placeFigure({ left: 10, top: 100, width: 355, height: 60 }, phone, fig);
  assert.equal(below.side, 'below');
  assert.equal(below.y, 170);
  const above = placeFigure({ left: 10, top: 560, width: 355, height: 120 }, phone, fig);
  assert.equal(above.side, 'above');
  const inside = placeFigure({ left: 0, top: -400, width: 375, height: 2000 }, phone, fig);
  assert.equal(inside.side, 'inside');
  for (const p of [right, below, above, inside]) {
    assert.ok(p.x >= 8 && p.x + fig.width <= (p === right ? vp.width : phone.width) - 8, 'inside the viewport horizontally');
  }
});

test('vertical position stays on screen for tall or half-visible elements', () => {
  const p = placeFigure({ left: 500, top: -200, width: 300, height: 260 }, vp, fig);
  assert.equal(p.side, 'left');
  assert.ok(p.y >= 8 && p.y < 60);
  assert.deepEqual(visiblePart({ left: -10, top: 790, width: 50, height: 50 }, vp), { left: 0, top: 790, width: 40, height: 10 });
  assert.equal(isOnScreen({ left: 0, top: 900, width: 10, height: 10 }, vp), false);
});

test('label sits away from the element and inside the screen', () => {
  // Figure left of the element: label above, growing left (its right edge at the figure's right edge).
  assert.deepEqual(placeLabel({ x: 300, y: 300 }, fig, { width: 120, height: 30 }, vp, 'left'), { x: 244, y: 264 });
  // Figure right of the element: growing right.
  assert.deepEqual(placeLabel({ x: 300, y: 300 }, fig, { width: 120, height: 30 }, vp, 'right'), { x: 300, y: 264 });
  // No room above: below the figure, clamped to the screen.
  assert.deepEqual(placeLabel({ x: 1250, y: 10 }, fig, { width: 200, height: 30 }, vp, 'right'), { x: 1072, y: 86 });
  // Figure below a full-width element (phones): label beside the figure, never over the element above.
  const phone = { width: 375, height: 700 };
  const beside = placeLabel({ x: 60, y: 170 }, fig, { width: 150, height: 30 }, phone, 'below');
  assert.deepEqual(beside, { x: 130, y: 190 });
  assert.ok(beside.y >= 170, 'not above the figure');
  const leftSide = placeLabel({ x: 300, y: 170 }, fig, { width: 150, height: 30 }, phone, 'below');
  assert.deepEqual(leftSide, { x: 144, y: 190 });
});

test('flight: starts at the dock, lands on the spot, hops in between', () => {
  const from = { x: 1200, y: 720 };
  const to = { x: 300, y: 200 };
  assert.deepEqual(flightPoint(from, to, 0), from);
  assert.deepEqual(flightPoint(from, to, 1), { x: 300, y: 200 - Math.sin(Math.PI) * 56 });
  const mid = flightPoint(from, to, 0.5);
  assert.ok(mid.y < 720 - (720 - 200) * 0.875 + 1, 'lifted above the straight path');
  assert.deepEqual(ringBox({ left: 10, top: 20, width: 100, height: 40 }), { left: 4, top: 14, width: 112, height: 52 });
  assert.equal(anchorSelector('tts.enable'), '[data-assistant-anchor="tts.enable"]');
  assert.equal(anchorSelector('a"]x'), '[data-assistant-anchor="a\\"]x"]');
});
