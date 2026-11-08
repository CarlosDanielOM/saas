// Scene rules shared by the player and the recorder.
import assert from 'node:assert/strict';
import test from 'node:test';
import {captionSpans, normalizeScene, sceneCues, validateScene} from '../../../dimasite/src/app/features/demo-video/demo-scene.ts';
import {checkScene} from '../lib/scene.mjs';

const scene = beats => ({id: 't', v: 1, beats});
const at = (raw, lang = 'en') => Object.fromEntries(normalizeScene(raw, lang, {duel: () => 9000}).scene.beats.map(b => [b.id, [b.at, b.end]]));

test('+N counts from the end of the beat above; with/after anchor to a named beat', () => {
  const t = at(scene([
    {do: 'intro', id: 'i', dur: 1000},
    {do: 'caption', id: 'c', at: '+200', dur: 2000, text: 'x'},
    {do: 'chat', id: 'm', with: 'c', at: '+500', user: 'u', text: 'hi'},
    {do: 'duel', id: 'd', at: '+100', left: 'a', right: 'b'},
    {do: 'bot', id: 'b', with: 'd', at: '+0', text: 'go'},
    {do: 'outro', id: 'o', after: 'd', at: '+300'}
  ]));
  assert.deepEqual(t, {i: [0, 1000], c: [1200, 3200], m: [1700, 1700], d: [1800, 10800], b: [1800, 1800], o: [11100, 13500]});
});

test('text must have both languages, ids must be unique, targets must exist', () => {
  const errors = validateScene(scene([
    {do: 'chat', id: 'm', user: 'u', text: {en: 'hi', es: ''}},
    {do: 'chat', id: 'm', user: 'u', text: 'b'},
    {do: 'ban', target: 'nobody'},
    {do: 'nope'}
  ]));
  assert.ok(errors.some(e => e.includes('needs both English and Spanish')));
  assert.ok(errors.some(e => e.includes('id "m" is used twice')));
  assert.ok(errors.some(e => e.includes('target "nobody" is not a beat id')));
  assert.ok(errors.some(e => e.includes('"do" must be one of')));
});

test('an outro may not cover a beat that is still playing', () => {
  const errors = validateScene(scene([{do: 'duel', id: 'd', left: 'a', right: 'b'}, {do: 'caption', with: 'd', text: 'x'}, {do: 'outro', at: '+0'}]), {duel: () => 9000});
  assert.ok(errors.some(e => e.includes('time it with "after": "d"')));
});

test('captions hold until the next one in their place, a card, or the end of the video', () => {
  const {scene: s, errors} = normalizeScene(scene([
    {do: 'intro', id: 'i', dur: 1000},
    {do: 'caption', id: 'a', at: '+0', dur: 1000, text: 'a'},
    {do: 'caption', id: 'up', with: 'a', place: 'top', text: 'up'},
    {do: 'caption', id: 'b', after: 'a', at: '+2000', dur: 500, text: 'b'},
    {do: 'caption', id: 'b2', with: 'b', dur: 500, text: 'b2'},
    {do: 'caption', id: 'z', after: 'b2', at: '+1000', dur: 500, text: 'z'},
    {do: 'outro', id: 'o', after: 'z', at: '+0'},
    {do: 'caption', id: 'late', with: 'o', dur: 0, text: 'late'}
  ]), 'en');
  assert.deepEqual(errors, []);
  const spans = format => Object.fromEntries(captionSpans(s, format).map(c => [c.beat.id, [c.beat.at, c.end]]));
  assert.deepEqual(spans('landscape'), {
    a: [1000, 4000],     // held past its dur until b
    up: [1000, 6000],    // another place: held until the outro
    b: [4000, 4000],     // same ms as b2: the one written later wins
    b2: [4000, 5500],
    z: [5500, 6000],     // the outro replaces it
    late: [6000, 6000]   // starts with the outro: covered, never comes back in the tail
  });
  assert.equal(spans('vertical').a[1], 1000, 'on vertical "up" shares the top band and replaces "a" at once');
  const {scene: open} = normalizeScene(scene([{do: 'caption', id: 'c', at: 0, text: 'x'}]), 'en');
  assert.equal(captionSpans(open, 'vertical')[0].end, Infinity);
});

test('a duel result is timed by the fight, not by a longer duel "dur"', () => {
  const t = at(scene([
    {do: 'duel', id: 'd', at: 1000, dur: 12000, left: 'a', right: 'b'},
    {do: 'bot', id: 'r', duel: 'd', text: '@{winner} won'}
  ]));
  assert.deepEqual(t.r, [1000 + 9000 - 1800, 1000 + 9000 - 1800]);
  const short = validateScene(scene([{do: 'duel', id: 'd', dur: 5000, left: 'a', right: 'b'}]), {duel: () => 9000});
  assert.ok(short.some(e => e.includes("can't be shorter than the fight")));
  const early = validateScene(scene([{do: 'duel', id: 'd', left: 'a', right: 'b'}, {do: 'bot', duel: 'd', with: 'd', at: '+7100', text: 'x'}]), {duel: () => 9000});
  assert.ok(early.some(e => e.includes('only known when the fight in d ends (7200 ms)')));
  const onTime = validateScene(scene([{do: 'duel', id: 'd', left: 'a', right: 'b'}, {do: 'bot', duel: 'd', with: 'd', at: '+7200', text: 'x'}]), {duel: () => 9000});
  assert.deepEqual(onTime, []);
});

test('bot wording is checked against the source file', () => {
  const ok = scene([{do: 'bot', text: '@x Selected unwanted chat behavior', refs: [{file: 'dimabot/src/utils/moderation/spam.ts', quote: 'Selected unwanted chat behavior'}]}]);
  assert.deepEqual(checkScene(ok), []);
  const drifted = scene([{do: 'bot', text: '@x You were removed', refs: [{file: 'dimabot/src/utils/moderation/spam.ts', quote: 'You were removed'}]}]);
  assert.ok(checkScene(drifted).some(e => e.includes('no longer appears in dimabot/src/utils/moderation/spam.ts')));
  const notSaid = scene([{do: 'bot', text: '@x bye', refs: [{file: 'dimabot/src/utils/moderation/spam.ts', quote: 'Selected unwanted chat behavior'}]}]);
  assert.ok(checkScene(notSaid).some(e => e.includes('must contain the quoted source wording')));
});

test('sounds must exist (kit) or be licensed files', () => {
  assert.ok(checkScene(scene([{do: 'sfx', src: 'kit:boom'}])).some(e => e.includes('unknown kit sound')));
  assert.ok(checkScene(scene([{do: 'sfx', src: 'song.mp3'}])).some(e => e.includes('not found')));
});

test('cues follow the overlay rules: alert sound after its delay, cut when the alert ends', () => {
  const {scene: s} = normalizeScene(scene([
    {do: 'alert', id: 'a', at: 1000, dur: 3000, event: 'follow', user: 'u', sound: {src: 'kit:chime', gain: 0.5, delay: 250, fadeIn: 100, fadeOut: 300}, sfx: 'kit:pop'},
    {do: 'tts', id: 't', at: '+0', user: 'u', text: 'hello'},
    {do: 'sfx', at: '+100', src: 'kit:ding', gain: 0.4}
  ]), 'en', {tts: {t: 1500}});
  assert.deepEqual(sceneCues(s, {t: '/__demo/media/tts/x.mp3'}).map(c => [c.kind, c.src, c.at, c.end, c.gain]), [
    ['sfx', 'kit:pop', 1000, null, 1], ['alert', 'kit:chime', 1250, 4000, 0.5], ['tts', '/__demo/media/tts/x.mp3', 4000, 5500, 1], ['sfx', 'kit:ding', 5600, null, 0.4]
  ]);
});

test('the sample scenes are valid', async () => {
  const {DEMO_SAMPLES} = await import('../../../dimasite/src/app/features/demo-video/demo-samples.ts');
  for (const sample of DEMO_SAMPLES) assert.deepEqual(checkScene(sample.scene), [], sample.id);
  const {readdirSync, readFileSync} = await import('node:fs');
  const {SCENES} = await import('../lib/paths.mjs');
  for (const name of readdirSync(SCENES).filter(n => n.endsWith('.json'))) assert.deepEqual(checkScene(JSON.parse(readFileSync(`${SCENES}/${name}`, 'utf8'))), [], name);
});
