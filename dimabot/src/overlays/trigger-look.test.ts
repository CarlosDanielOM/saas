import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SECRET_KEY ??= 'a'.repeat(32); // the save validator's module reads it at load; nothing is encrypted here
const { OverlayError } = await import('./store.js');
const { validateLookLayout, applyLookMedia, masterVolume, lookReferences, lookSummary, lookRevisionOf, lookRevisionFilter, withTriggerMediaLock } = await import('./trigger-look.js');

const IMG = '1'.repeat(24), VID = '2'.repeat(24), SND = '3'.repeat(24), GONE = '4'.repeat(24);
const object = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, x: 0, y: 0, width: 200, height: 100, visible: true, locked: false, ...extra });
const sound = (id: string, mediaId: string, extra: Record<string, unknown> = {}) => ({ id, mediaId, volume: 0.8, delay: 0, fadeIn: 0, fadeOut: 0, ...extra });
const look = (layout: Record<string, unknown>) => ({ width: 800, height: 400, layout: { duration: 5, widgets: [], ...layout } });
const rejects = (raw: unknown, message?: string) => assert.throws(() => validateLookLayout(raw), (e: unknown) => e instanceof OverlayError && e.status === 400 && (!message || e.message === message));

test('trigger-media mode: mediaId kept, mediaUrl/url discarded, mediaIds derived once each', () => {
  const saved = validateLookLayout(look({
    widgets: [object('pic', 'image', { mediaId: IMG, mediaUrl: 'https://evil.invalid/a.png', mediaType: 'gif', unavailable: true }),
      object('pic2', 'image', { mediaId: IMG }), object('clip', 'video', { mediaId: VID, volume: 0.5, loop: false }), object('title', 'text', { text: 'Thanks $(user)' }), object('box', 'shape')],
    sounds: [sound('boom', SND, { url: 'https://evil.invalid/a.mp3', end: 2 })]
  }));
  assert.deepEqual(saved.mediaIds, [IMG, VID, SND]);
  assert.equal(saved.width, 800); assert.equal(saved.height, 400);
  const pic = saved.layout.widgets[0];
  assert.equal(pic.mediaId, IMG); for (const key of ['mediaUrl', 'mediaType', 'unavailable', 'assetId']) assert.equal(Object.hasOwn(pic, key), false, key);
  assert.deepEqual(saved.layout.sounds, [{ id: 'boom', mediaId: SND, volume: 0.8, delay: 0, fadeIn: 0, fadeOut: 0, end: 2 }]);
  assert.equal(Object.hasOwn(saved.layout, 'sound'), false, 'looks store no legacy mirror');
  assert.deepEqual(lookReferences(saved.layout).map(r => r.kind), ['image', 'image', 'video', 'audio']);
});

test('trigger-media mode: assetId rejected on objects and sounds, bad mediaIds rejected, legacy sound ignored', () => {
  rejects(look({ widgets: [object('pic', 'image', { assetId: IMG })] }), 'Trigger looks use media from your trigger library, not Overlay Studio assets');
  rejects(look({ sounds: [{ ...sound('s', SND), assetId: SND }] }), 'Trigger looks use media from your trigger library, not Overlay Studio assets');
  rejects(look({ widgets: [object('pic', 'image', { mediaId: 'nope' })] }), 'Invalid trigger media');
  rejects(look({ widgets: [object('title', 'text', { text: 'x', mediaId: IMG })] }), 'Invalid trigger media');
  rejects(look({ sounds: [{ ...sound('s', SND), mediaId: undefined }] }), 'Invalid trigger sound');
  rejects(look({ sounds: Array.from({ length: 11 }, (_, i) => sound(`s${i}`, SND)) }));
  rejects(look({ widgets: [object('t', 'text', { text: '$(unknownfn)' })] }));
  rejects({ ...look({}), width: 50 });
  rejects({ ...look({}), height: 8000 });
  for (const kind of ['tts', 'trigger', 'alert', 'poll', 'custom']) rejects(look({ widgets: [object('x', kind)] }));
  const legacy = validateLookLayout(look({ sound: { mediaId: SND, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 } }));
  assert.equal(Object.hasOwn(legacy.layout, 'sounds'), false); assert.equal(Object.hasOwn(legacy.layout, 'sound'), false);
});

test('A2 fields on look videos, rejected elsewhere', () => {
  assert.equal(validateLookLayout(look({ widgets: [object('clip', 'video', { mediaId: VID, volume: 0 })] })).layout.widgets[0].volume, 0);
  rejects(look({ widgets: [object('pic', 'image', { mediaId: IMG, loop: false })] }), 'Only videos have sound and looping settings');
});

const media = new Map([[IMG, { url: 'https://api.invalid/media/a1', mediaType: 'gif' as const }], [VID, { url: 'https://api.invalid/media/a2', mediaType: 'video' as const }], [SND, { url: 'https://api.invalid/media/a3', mediaType: 'audio' as const }]]);
const stored = () => validateLookLayout(look({
  widgets: [object('pic', 'image', { mediaId: IMG }), object('gone', 'image', { mediaId: GONE }), object('clip', 'video', { mediaId: VID, volume: 0.5 }), object('mute', 'video', { mediaId: VID, volume: 0 }), object('deco', 'video', { mediaId: VID }), object('wrong', 'video', { mediaId: SND }), object('empty', 'image')],
  sounds: [sound('boom', SND), sound('lost', GONE)]
})).layout;

test('editor form: every object/sound stays with url + mediaType or unavailable, no master volume', () => {
  const layout = applyLookMedia(stored(), media, 'editor');
  const byId = Object.fromEntries(layout.widgets.map(w => [w.id, w as unknown as Record<string, unknown>]));
  assert.equal(byId.pic.mediaUrl, 'https://api.invalid/media/a1'); assert.equal(byId.pic.mediaType, 'gif');
  assert.equal(byId.gone.unavailable, true); assert.equal(Object.hasOwn(byId.gone, 'mediaUrl'), false);
  assert.equal(byId.wrong.unavailable, true, 'a kind mismatch is unavailable');
  assert.equal(byId.clip.volume, 0.5);
  assert.equal(Object.hasOwn(byId.empty, 'unavailable'), false);
  assert.deepEqual(layout.sounds, [{ ...sound('boom', SND), url: 'https://api.invalid/media/a3', mediaType: 'audio' }, { ...sound('lost', GONE), unavailable: true }]);
});

test('playback form: unavailable dropped, master volume on sounds and timed videos, volume 0 stays present', () => {
  const layout = applyLookMedia(stored(), media, 'playback', masterVolume(50));
  assert.deepEqual(layout.widgets.map(w => w.id), ['pic', 'clip', 'mute', 'deco', 'empty']);
  const byId = Object.fromEntries(layout.widgets.map(w => [w.id, w]));
  assert.equal(byId.clip.volume, 0.25); assert.equal(byId.mute.volume, 0); assert.equal(Object.hasOwn(byId.mute, 'volume'), true);
  assert.equal(Object.hasOwn(byId.deco, 'volume'), false, 'a decoration video gets no volume');
  assert.equal(byId.pic.mediaUrl, 'https://api.invalid/media/a1');
  for (const w of layout.widgets) assert.equal(Object.hasOwn(w, 'mediaType'), false);
  assert.deepEqual(layout.sounds, [{ ...sound('boom', SND, { volume: 0.4 }), url: 'https://api.invalid/media/a3' }]);
  const silent = applyLookMedia(stored(), media, 'playback', masterVolume(0));
  assert.equal(silent.sounds![0].volume, 0); assert.equal(silent.widgets.find(w => w.id === 'clip')!.volume, 0);
  const none = applyLookMedia(stored(), new Map(), 'playback');
  assert.equal(Object.hasOwn(none, 'sounds'), false); assert.deepEqual(none.widgets.map(w => w.id), ['empty']);
});

test('master volume: clamp(volume / 100, 0, 1), non-numeric plays at 1', () => {
  assert.equal(masterVolume(100), 1); assert.equal(masterVolume(50), 0.5); assert.equal(masterVolume(0), 0);
  assert.equal(masterVolume(250), 1); assert.equal(masterVolume(-5), 0); assert.equal(masterVolume('40'), 0.4);
  for (const value of [undefined, null, '', 'loud', NaN, true, {}]) assert.equal(masterVolume(value), 1, String(value));
});

test('summary counts objects and sounds, never the layout', () => {
  const layout = stored();
  const summary = lookSummary({ width: 800, height: 400, layout, mediaIds: [], revision: 3, updatedAt: new Date(0) });
  assert.deepEqual(summary, { revision: 3, width: 800, height: 400, updatedAt: new Date(0), objectCount: 7, soundCount: 2 });
  assert.equal(lookSummary({ width: 1, height: 1, mediaIds: [], revision: 1, updatedAt: new Date(0) } as never, { objectCount: 4, soundCount: 1 }).objectCount, 4);
});

test('look counter: missing counts as 0, the filter matches a missing counter only for revision 0', () => {
  assert.equal(lookRevisionOf({}), 0); assert.equal(lookRevisionOf({ lookRevision: null }), 0); assert.equal(lookRevisionOf({ lookRevision: 7 }), 7);
  assert.deepEqual(lookRevisionFilter('t', 'c', 0), { _id: 't', channelID: 'c', lookRevision: { $in: [0, null] } });
  assert.deepEqual(lookRevisionFilter('t', 'c', 3), { _id: 't', channelID: 'c', lookRevision: 3 });
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test('media lock: operations of one channel never overlap, a failure releases the next, channels are independent', async () => {
  const log: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = withTriggerMediaLock('chan', async () => { log.push('first:start'); await barrier; log.push('first:end'); return 1; });
  const second = withTriggerMediaLock('chan', async () => { log.push('second:start'); return 2; });
  const other = withTriggerMediaLock('other', async () => { log.push('other:start'); return 3; });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(log, ['first:start', 'other:start'], 'the second waits for the first; another channel does not');
  assert.equal(await other, 3);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(log, ['first:start', 'other:start', 'first:end', 'second:start']);

  const failing = withTriggerMediaLock('chan', async () => { await tick(); throw new Error('boom'); });
  const after = withTriggerMediaLock('chan', async () => 'next');
  await assert.rejects(failing, /boom/);
  assert.equal(await after, 'next', 'a thrown operation releases the next one');
  assert.equal(await withTriggerMediaLock('chan', async () => 'idle'), 'idle', 'the lock is free again');
});
