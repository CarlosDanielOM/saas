import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutSounds, makeDesign, makeScene, type AlertLayout, type OverlayScene } from './model.js';
import { buildPublished, liveStatus } from './publish.js';

process.env.SECRET_KEY ??= 'a'.repeat(32); // the save validator's module reads it at load; nothing is encrypted here
const { validateState, OverlayError } = await import('./store.js');

const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24);
const sound = (assetId: string, extra: Record<string, unknown> = {}) => ({ assetId, name: 'Chime', volume: 0.8, delay: 0, fadeIn: 0, fadeOut: 0.5, ...extra });
const empty = { schemaVersion: 1 as const, revision: 0, scenes: [], designs: [] };
/** A JSON save body; `edit` changes the follow layout. */
function body(edit: (follow: Record<string, any>) => void, writer?: number) {
  const design = makeDesign('starter', 'My alerts'), scene = makeScene('main', 'My overlay', design.id);
  const draft = JSON.parse(JSON.stringify({ scenes: [scene], designs: [design], ...(writer === undefined ? {} : { writer }) }));
  edit(draft.designs[0].events.follow);
  return draft;
}
const save = (draft: unknown) => validateState(draft, empty);
const follow = (draft: unknown): AlertLayout => save(draft).designs[0].events.follow;
const rejects = (draft: unknown, message?: string) => assert.throws(() => save(draft), (e: unknown) => e instanceof OverlayError && e.status === 400 && (!message || e.message === message));

test('writer 2: sounds are canonical, unknown fields dropped, mirror is sounds[0] without its id', () => {
  const layout = follow(body(f => { f.sounds = [{ id: 'one', ...sound(A), extra: true, url: 'https://x.invalid/a.mp3' }, { id: 'two', ...sound(B, { end: 3 }) }]; f.sound = sound(C); }, 2));
  assert.deepEqual(layout.sounds, [{ id: 'one', ...sound(A) }, { id: 'two', ...sound(B, { end: 3 }) }]);
  assert.deepEqual(layout.sound, sound(A), 'the body sound is ignored; the mirror follows sounds[0]');
  assert.equal(JSON.stringify(layout.sound), JSON.stringify(sound(A)), 'mirror keeps the legacy key order');
});

test('writer 2: no sounds stores neither key, even with a body sound', () => {
  for (const edit of [(f: Record<string, any>) => { f.sound = sound(A); }, (f: Record<string, any>) => { f.sounds = []; }]) {
    const layout = follow(body(edit, 2));
    assert.equal(Object.hasOwn(layout, 'sounds'), false); assert.equal(Object.hasOwn(layout, 'sound'), false);
  }
});

test('sounds limits: at most 10, unique valid ids, the same per-sound bounds', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, ...sound(A) }));
  assert.equal(follow(body(f => { f.sounds = many(10); }, 2)).sounds!.length, 10);
  rejects(body(f => { f.sounds = many(11); }, 2), 'Too many or invalid items');
  rejects(body(f => { f.sounds = [{ id: 'x', ...sound(A) }, { id: 'x', ...sound(B) }]; }, 2), 'Duplicate ID');
  for (const bad of [{ id: undefined }, { id: 'bad id' }, { id: 'x'.repeat(101) }, { assetId: 'nope' }, { volume: 1.1 }, { delay: 121 }, { fadeIn: 11 }, { fadeOut: -1 }, { end: 0 }, { name: 'n'.repeat(121) }, { mediaId: A, assetId: undefined }]) {
    rejects(body(f => { f.sounds = [{ id: 'x', ...sound(A), ...bad }]; }, 2));
  }
  rejects(body(f => { f.sounds = 'nope'; }, 2));
  rejects(body(f => { f.sounds = []; }, 'x' as never), 'Invalid editor version');
});

test('no writer, only sound (old editor or old data): one sound with id "sound" plus the mirror', () => {
  const layout = follow(body(f => { f.sound = sound(A, { end: 4 }); }));
  assert.deepEqual(layout.sounds, [{ id: 'sound', ...sound(A, { end: 4 }) }]);
  assert.deepEqual(layout.sound, sound(A, { end: 4 }));
});

test('no writer, sounds and sound: the old editor edited sound, so it replaces sounds[0] (keeping its id)', () => {
  const layout = follow(body(f => { f.sounds = [{ id: 'one', ...sound(A) }, { id: 'two', ...sound(B) }]; f.sound = sound(C, { volume: 0.2 }); }));
  assert.deepEqual(layout.sounds, [{ id: 'one', ...sound(C, { volume: 0.2 }) }, { id: 'two', ...sound(B) }]);
  assert.deepEqual(layout.sound, sound(C, { volume: 0.2 }));
});

test('no writer, sounds without sound: the old editor removed its sound, so sounds[0] goes and the rest stay', () => {
  const layout = follow(body(f => { f.sounds = [{ id: 'one', ...sound(A) }, { id: 'two', ...sound(B) }]; }));
  assert.deepEqual(layout.sounds, [{ id: 'two', ...sound(B) }]);
  assert.deepEqual(layout.sound, sound(B), 'the mirror moves to the new first sound');
  const none = follow(body(f => { f.sounds = [{ id: 'one', ...sound(A) }]; }));
  assert.equal(Object.hasOwn(none, 'sounds'), false); assert.equal(Object.hasOwn(none, 'sound'), false);
});

test('no writer, neither key: no sounds; a saved state saves again unchanged', () => {
  const layout = follow(body(() => {}));
  assert.equal(Object.hasOwn(layout, 'sounds'), false); assert.equal(Object.hasOwn(layout, 'sound'), false);
  const saved = save(body(f => { f.sounds = [{ id: 'one', ...sound(A) }, { id: 'two', ...sound(B) }]; }, 2));
  // The server's own revalidation (recovery) sends stored layouts back without a writer: sounds + mirror is a no-op.
  assert.deepEqual(save(JSON.parse(JSON.stringify(saved))).designs[0].events, saved.designs[0].events);
});

test('layoutSounds reads sounds first, then the legacy sound', () => {
  assert.deepEqual(layoutSounds({ duration: 5, widgets: [] }), []);
  assert.deepEqual(layoutSounds({ duration: 5, widgets: [], sound: sound(A) }), [{ id: 'sound', ...sound(A) }]);
  assert.deepEqual(layoutSounds({ duration: 5, widgets: [], sounds: [{ id: 'x', ...sound(B) }], sound: sound(A) }), [{ id: 'x', ...sound(B) }]);
});

test('a copy published with only the legacy sound stays live after the draft is saved with sounds + mirror', () => {
  const legacy = save(body(f => { f.sound = sound(A); }));
  const scene = legacy.scenes[0] as OverlayScene, design = structuredClone(legacy.designs[0]);
  // What older servers published: the sound alone.
  const old = buildPublished(scene, [design], new Map());
  const { sounds: _sounds, ...plain } = old.designs[0].events.follow; old.designs[0].events.follow = plain;
  assert.equal(liveStatus([{ ...scene, published: old }], legacy.designs, new Map())[scene.id], true);
  const changed = save(body(f => { f.sounds = [{ id: 'sound', ...sound(A) }, { id: 'two', ...sound(B) }]; }, 2));
  assert.equal(liveStatus([{ ...scene, published: old }], changed.designs, new Map())[scene.id], false);
});

const video = (extra: Record<string, unknown>) => ({ id: 'clip', kind: 'video', x: 0, y: 0, width: 100, height: 100, visible: true, locked: false, ...extra });
test('A2: volume and loop are kept on videos inside layouts, absent stays absent', () => {
  for (const [extra, expected] of [[{ volume: 0 }, { volume: 0 }], [{ volume: 1, loop: false }, { volume: 1, loop: false }], [{ loop: true }, { loop: true }], [{}, {}]] as const) {
    const saved = follow(body(f => { f.widgets.push(video(extra)); }, 2)).widgets.find(w => w.id === 'clip')!;
    assert.equal(saved.volume, (expected as { volume?: number }).volume); assert.equal(saved.loop, (expected as { loop?: boolean }).loop);
    assert.equal(Object.hasOwn(saved, 'volume'), 'volume' in expected); assert.equal(Object.hasOwn(saved, 'loop'), 'loop' in expected);
  }
});

test('A2: bad values, other kinds and scene-level videos are rejected', () => {
  for (const bad of [{ volume: 1.5 }, { volume: -0.1 }, { volume: '1' }, { volume: null }, { loop: 'no' }, { loop: 0 }]) rejects(body(f => { f.widgets.push(video(bad)); }, 2));
  rejects(body(f => { f.widgets[1].volume = 0.5; }, 2), 'Only videos have sound and looping settings');
  rejects(body(f => { f.widgets.push({ ...video({}), kind: 'image', loop: false }); }, 2), 'Only videos have sound and looping settings');
  const scene = body(() => {}, 2); scene.scenes[0].widgets.push(video({ volume: 0.5 }));
  rejects(scene, 'Video sound and looping require an alert layout');
  const looping = body(() => {}, 2); looping.scenes[0].widgets.push(video({ loop: false }));
  rejects(looping, 'Video sound and looping require an alert layout');
});

test('alert designs drop a mediaId (trigger looks only) and keep assetId sounds required', () => {
  const layout = follow(body(f => { f.widgets.push(video({ mediaId: A })); }, 2));
  assert.equal(Object.hasOwn(layout.widgets.find(w => w.id === 'clip')!, 'mediaId'), false);
  rejects(body(f => { f.sounds = [{ id: 'x', mediaId: A, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }]; }, 2), 'Invalid alert sound');
});
