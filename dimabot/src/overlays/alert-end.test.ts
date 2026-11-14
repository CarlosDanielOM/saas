import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDesign, makeScene, type AlertDesign, type OverlayScene } from './model.js';
import { buildPublished } from './publish.js';

process.env.SECRET_KEY ??= 'a'.repeat(32); // the save validator's module reads it at load; nothing is encrypted here
const { validateState, OverlayError } = await import('./store.js');

const SOUND = 'c'.repeat(24);
const motion = (extra: Record<string, unknown> = {}) => ({ enter: 'fade', exit: 'fade', loop: 'none', delay: 0.5, enterDuration: 0.4, exitDuration: 0.4, loopDuration: 2, ...extra });
const sound = (extra: Record<string, unknown> = {}) => ({ assetId: SOUND, name: 'Chime', volume: 0.8, delay: 0, fadeIn: 0, fadeOut: 0.5, ...extra });

/** A JSON draft (as the HTTP body) with the follow layout's text object animated and a follow sound. */
function draft(motionExtra?: Record<string, unknown>, soundExtra?: Record<string, unknown>) {
  const design = makeDesign('starter', 'My alerts'), scene = makeScene('main', 'My overlay', design.id);
  const body = JSON.parse(JSON.stringify({ scenes: [scene], designs: [design] })) as { scenes: Record<string, unknown>[]; designs: Record<string, any>[] };
  const follow = body.designs[0].events.follow;
  if (motionExtra) follow.widgets[1].motion = motion(motionExtra);
  if (soundExtra) follow.sound = sound(soundExtra);
  return body;
}
const empty = { schemaVersion: 1 as const, revision: 0, scenes: [], designs: [] };
const save = (body: unknown) => validateState(body, empty);
const follow = (designs: AlertDesign[]) => designs[0].events.follow;

test('end round-trips on an object animation and on the alert sound', () => {
  const saved = save(draft({ end: 3.5 }, { end: 4 }));
  assert.deepEqual(follow(saved.designs).widgets[1].motion, motion({ end: 3.5 }));
  assert.deepEqual(follow(saved.designs).sound, sound({ end: 4 }));
  // Saving the saved state again keeps it (what the Studio does on every later save).
  const again = save(JSON.parse(JSON.stringify(saved)));
  assert.equal(follow(again.designs).widgets[1].motion!.end, 3.5);
  assert.equal(follow(again.designs).sound!.end, 4);
});

test('the bounds 0.1 and 120 are accepted', () => {
  for (const end of [0.1, 120]) {
    const saved = save(draft({ end }, { end }));
    assert.equal(follow(saved.designs).widgets[1].motion!.end, end);
    assert.equal(follow(saved.designs).sound!.end, end);
  }
});

test('an absent end stays absent: no key at all, same bytes as before', () => {
  const saved = save(draft({}, {}));
  const layout = follow(saved.designs);
  assert.equal(Object.hasOwn(layout.widgets[1].motion!, 'end'), false);
  assert.equal(Object.hasOwn(layout.sound!, 'end'), false);
  assert.equal(JSON.stringify(layout.widgets[1].motion), JSON.stringify(motion()));
  assert.equal(JSON.stringify(layout.sound), JSON.stringify(sound()));
});

test('out-of-range, non-number, NaN, Infinity and null end values are rejected', () => {
  for (const end of [0, 0.05, -1, 120.01, 1000, '3', true, {}, [], null, NaN, Infinity]) {
    // NaN/Infinity cannot cross JSON, so these go in as objects (validateState is also called in-process by recovery).
    const motionBody = draft({}); motionBody.designs[0].events.follow.widgets[1].motion.end = end;
    assert.throws(() => save(motionBody), (e: unknown) => e instanceof OverlayError && e.status === 400 && e.message === 'Invalid dimension or duration', `motion end ${String(end)}`);
    const soundBody = draft(undefined, {}); soundBody.designs[0].events.follow.sound.end = end;
    assert.throws(() => save(soundBody), (e: unknown) => e instanceof OverlayError && e.status === 400 && e.message === 'Invalid dimension or duration', `sound end ${String(end)}`);
  }
});

test('end is accepted on variant layouts too (they share the same layout validator)', () => {
  const body = draft();
  const layout = JSON.parse(JSON.stringify(body.designs[0].events.follow));
  layout.widgets[1].motion = motion({ end: 2 }); layout.sound = sound({ end: 2.5 });
  body.designs[0].variants = { raid: [{ id: 'big', name: 'Big raid', enabled: true, min: 10, layout }] };
  const saved = save(body).designs[0].variants!.raid![0].layout;
  assert.equal(saved.widgets[1].motion!.end, 2);
  assert.equal(saved.sound!.end, 2.5);
});

test('a scene-level (non-design) widget still rejects motion, with or without end', () => {
  for (const extra of [{}, { end: 3 }]) {
    const body = draft();
    body.scenes[0] = { ...body.scenes[0], widgets: [...(body.scenes[0].widgets as unknown[]), { id: 'text-1', kind: 'text', x: 0, y: 0, width: 100, height: 50, visible: true, locked: false, text: 'Hi', motion: motion(extra) }] };
    assert.throws(() => save(body), (e: unknown) => e instanceof OverlayError && e.message === 'Object animations require an alert design');
  }
});

test('publishing keeps end in the published snapshot, and leaves it out when unset', () => {
  const withEnd = save(draft({ end: 3.5 }, { end: 4 }));
  const scene: OverlayScene = { ...withEnd.scenes[0] };
  const published = JSON.parse(JSON.stringify(buildPublished(scene, withEnd.designs, new Map()))) as NonNullable<OverlayScene['published']>;
  assert.equal(follow(published.designs).widgets[1].motion!.end, 3.5);
  assert.equal(follow(published.designs).sound!.end, 4);
  // A later save carries the published copy through unchanged.
  const resaved = validateState(JSON.parse(JSON.stringify({ ...withEnd, scenes: [{ ...scene, published }] })), { ...empty, scenes: [{ ...scene, published }], designs: withEnd.designs });
  assert.equal(follow(resaved.scenes[0].published!.designs).sound!.end, 4);

  const without = save(draft({}, {}));
  const plain = buildPublished(without.scenes[0], without.designs, new Map());
  assert.equal(Object.hasOwn(follow(plain.designs).widgets[1].motion!, 'end'), false);
  assert.equal(Object.hasOwn(follow(plain.designs).sound!, 'end'), false);
});
