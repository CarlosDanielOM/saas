// Sounds for the Dima default alerts (public overlay library). One family: soft glass bells in D major,
// a stereo room, nothing harsh (high partials decay fast, noise is band-limited, peaks stay under -1 dBFS).
//   node alerts/build-sounds.mjs [outDir]   (default: dimasite/public/overlay-library/v1)
import {mkdirSync, writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const out = resolve(process.argv[2] ?? new URL('../../dimasite/public/overlay-library/v1', import.meta.url).pathname);
mkdirSync(out, {recursive: true});

const SR = 48000, TAU = Math.PI * 2;
const midi = m => 440 * 2 ** ((m - 69) / 12);
const N = {D2: 38, A2: 45, D3: 50, A3: 57, D4: 62, 'F#4': 66, A4: 69, D5: 74, E5: 76, 'F#5': 78, A5: 81, B5: 83, D6: 86, E6: 88, 'F#6': 90, A6: 93, B6: 95, D7: 98, 'F#7': 102, A7: 105};
const f = name => midi(N[name]);

// Deterministic randomness: the same script always produces the same files.
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

class Mix {
  constructor(seconds) { this.n = Math.ceil(seconds * SR); this.L = new Float64Array(this.n); this.R = new Float64Array(this.n); }
  put(i, v, pan) { if (i < 0 || i >= this.n) return; const a = (pan + 1) * Math.PI / 4; this.L[i] += v * Math.cos(a); this.R[i] += v * Math.sin(a); }
}

/** Glass bell / celesta: harmonic partials with their own decays, a soft 3 ms attack and a touch of width. */
function bell(mix, t0, freq, {amp = .5, decay = 1.2, pan = 0, bright = 1} = {}) {
  const partials = [[1, 1, 1], [2, .32 * bright, .5], [3, .11 * bright, .3], [4.16, .07 * bright, .17], [5.43, .035 * bright, .1]];
  const start = Math.round(t0 * SR), len = Math.round(decay * 5 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR, attack = Math.min(1, t / .003);
    let v = 0;
    for (const [ratio, a, d] of partials) { const fr = freq * ratio; if (fr > 16000) continue; v += a * Math.exp(-t / (decay * d)) * Math.sin(TAU * fr * t); }
    mix.put(start + i, amp * attack * v * .6, pan);
  }
}
/** Music box tine: brighter, shorter, with a faint metallic overtone. */
function tine(mix, t0, freq, {amp = .4, decay = .7, pan = 0} = {}) {
  const partials = [[1, 1, 1], [3, .18, .35], [6.1, .05, .12]];
  const start = Math.round(t0 * SR), len = Math.round(decay * 5 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR, attack = Math.min(1, t / .002);
    let v = 0; for (const [r, a, d] of partials) { const fr = freq * r; if (fr < 16000) v += a * Math.exp(-t / (decay * d)) * Math.sin(TAU * fr * t); }
    mix.put(start + i, amp * attack * v * .6, pan);
  }
}
/** Mallet pluck (bits gems): fundamental + the marimba 3.93 partial that dies quickly. */
function mallet(mix, t0, freq, {amp = .4, decay = .6, pan = 0} = {}) {
  const start = Math.round(t0 * SR), len = Math.round(decay * 5 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR, attack = Math.min(1, t / .0025);
    const v = Math.exp(-t / decay) * Math.sin(TAU * freq * t) + .3 * Math.exp(-t / (decay * .18)) * Math.sin(TAU * freq * 3.93 * t) + .12 * Math.exp(-t / (decay * .4)) * Math.sin(TAU * freq * 2 * t);
    mix.put(start + i, amp * attack * v * .6, pan);
  }
}
/** Soft low body: a sine whose pitch glides down (boom, tom). */
function thump(mix, t0, f0, f1, {amp = .5, decay = .35, glide = .08, pan = 0} = {}) {
  const start = Math.round(t0 * SR), len = Math.round(decay * 5 * SR);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR, freq = f1 + (f0 - f1) * Math.exp(-t / glide), attack = Math.min(1, t / .004);
    phase += TAU * freq / SR;
    mix.put(start + i, amp * attack * Math.exp(-t / decay) * Math.sin(phase), pan);
  }
}
/** Band-passed noise whose centre sweeps (unwrap swish, raid whoosh). */
function sweep(mix, t0, dur, fa, fb, {amp = .15, q = 1.2, pan = 0, panTo = pan} = {}) {
  const start = Math.round(t0 * SR), len = Math.round(dur * SR);
  let low = 0, band = 0;
  for (let i = 0; i < len; i++) {
    const p = i / len, fc = fa * (fb / fa) ** p, g = 2 * Math.sin(Math.PI * Math.min(fc, 12000) / SR);
    const x = rnd() * 2 - 1; low += g * band; const high = x - low - band / q; band += g * high;
    const env = Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2;
    mix.put(start + i, amp * env * band, pan + (panTo - pan) * p);
  }
}
/** Warm pad / brass: detuned additive saws with a harmonic roll-off that can open over time. */
function pad(mix, t0, freqs, {amp = .1, attack = .15, hold = 1, release = .8, open = 0, warm = 3, pan = 0} = {}) {
  const start = Math.round(t0 * SR), total = attack + hold + release, len = Math.round(total * SR);
  freqs.forEach((freq, k) => {
    const voices = [-6, 0, 6].map(cents => freq * 2 ** (cents / 1200));
    const panK = pan + (k - (freqs.length - 1) / 2) * .25;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = t < attack ? (t / attack) ** 2 : t < attack + hold ? 1 : Math.exp(-(t - attack - hold) / (release / 3));
      const roll = warm + open * Math.min(1, t / (attack + .4));
      let v = 0;
      for (const vf of voices) for (let n = 1; n <= 10; n++) { const fr = vf * n; if (fr > 9000) break; v += Math.exp(-n / roll) / n * Math.sin(TAU * fr * t + n * k); }
      mix.put(start + i, amp * env * v * .35, panK);
    }
  });
}
function glints(mix, from, to, count, {amp = .07, low = 'D7', high = 'A7'} = {}) {
  const notes = ['D7', 'F#7', 'A7', 'B6', 'E6', 'A6'].filter(n => N[n] >= N[low] - 9 && N[n] <= N[high]);
  for (let i = 0; i < count; i++) bell(mix, from + (to - from) * rnd(), f(notes[Math.floor(rnd() * notes.length)]), {amp: amp * (.6 + .4 * rnd()), decay: .25 + .2 * rnd(), pan: rnd() * 1.6 - .8, bright: .5});
}

/** Freeverb-style stereo room with a short pre-delay and damping (no metallic ring). */
function reverb(mix, {wet = .3, room = .82, damp = .35, predelay = .018} = {}) {
  const scale = SR / 44100, combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], alls = [556, 441, 341, 225], spread = 23;
  const run = (input, offset) => {
    const outBuf = new Float64Array(input.length), pre = Math.round(predelay * SR);
    const cs = combs.map(c => ({b: new Float64Array(Math.round((c + offset) * scale)), i: 0, s: 0}));
    const as = alls.map(a => ({b: new Float64Array(Math.round((a + offset) * scale)), i: 0}));
    for (let n = 0; n < input.length; n++) {
      const x = (n >= pre ? input[n - pre] : 0) * .015;
      let y = 0;
      for (const c of cs) { const o = c.b[c.i]; c.s = o * (1 - damp) + c.s * damp; c.b[c.i] = x + c.s * room; c.i = (c.i + 1) % c.b.length; y += o; }
      for (const a of as) { const o = a.b[a.i]; const v = -y + o; a.b[a.i] = y + o * .5; a.i = (a.i + 1) % a.b.length; y = v; }
      outBuf[n] = y;
    }
    return outBuf;
  };
  const wl = run(mix.L, 0), wr = run(mix.R, spread);
  for (let n = 0; n < mix.n; n++) { mix.L[n] = mix.L[n] * (1 - wet * .5) + wl[n] * wet * 3; mix.R[n] = mix.R[n] * (1 - wet * .5) + wr[n] * wet * 3; }
}

/** High-pass at ~30 Hz, a short fade at the very end, peak at -1.5 dBFS, then a 16-bit stereo WAV. */
function finish(mix) {
  for (const ch of [mix.L, mix.R]) { let prevX = 0, prevY = 0; const a = Math.exp(-TAU * 30 / SR); for (let i = 0; i < ch.length; i++) { const y = a * (prevY + ch[i] - prevX); prevX = ch[i]; ch[i] = prevY = y; } }
  const fade = Math.round(.25 * SR);
  for (let i = 0; i < fade; i++) { const g = (1 - i / fade) ** 2, k = mix.n - fade + i; mix.L[k] *= g; mix.R[k] *= g; }
  let peak = 0; for (let i = 0; i < mix.n; i++) peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
  const gain = .84 / peak, data = Buffer.alloc(44 + mix.n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + mix.n * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(mix.n * 4, 40);
  for (let i = 0; i < mix.n; i++) { data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.L[i] * gain)) * 32767), 44 + i * 4); data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.R[i] * gain)) * 32767), 46 + i * 4); }
  return data;
}

const sounds = {
  // Two-note bloom, the gentlest: follows are the most frequent alert.
  follow() {
    const m = new Mix(2.4);
    bell(m, 0, f('A5'), {amp: .5, decay: 1.0, pan: -.18});
    bell(m, .11, f('D6'), {amp: .62, decay: 1.35, pan: .18});
    thump(m, .1, 300, f('D4'), {amp: .1, decay: .5, glide: .03});
    glints(m, .18, .55, 4, {amp: .055});
    reverb(m, {wet: .32});
    return m;
  },
  // A gem cascade: five quick crystal plucks rising, one clear ping on top, a faint shimmer.
  bits() {
    const m = new Mix(2.6);
    ['D6', 'F#6', 'A6', 'D7', 'F#7'].forEach((n, i) => mallet(m, i * .055, f(n), {amp: .34 + i * .02, decay: .5 + i * .06, pan: -.6 + i * .3}));
    bell(m, .3, f('A6'), {amp: .34, decay: 1.2, pan: .1});
    bell(m, .3, f('D6'), {amp: .16, decay: 1.1, pan: -.1, bright: .6});
    glints(m, .35, 1.0, 6, {amp: .045});
    reverb(m, {wet: .3});
    return m;
  },
  // A warm fanfare: soft boom, a Dadd9 pad and a rising bell line that lands on D6.
  sub() {
    const m = new Mix(3.4);
    thump(m, 0, 120, 55, {amp: .42, decay: .42});
    pad(m, 0, [f('D4'), f('F#4'), f('A4'), f('E5')], {amp: .085, attack: .14, hold: 1.1, release: 1.4, warm: 2.6});
    [['D5', .04, .42, .7], ['F#5', .16, .44, .75], ['A5', .28, .46, .8], ['D6', .44, .58, 1.6]].forEach(([n, t, a, d], i) => bell(m, t, f(n), {amp: a, decay: d, pan: [-.3, -.1, .1, .25][i]}));
    bell(m, .44, f('D7'), {amp: .12, decay: 1.2, pan: .35, bright: .5});
    glints(m, .55, 1.3, 6, {amp: .05});
    reverb(m, {wet: .34, room: .84});
    return m;
  },
  // Unwrap: a ribbon swish, a little pop, a music-box run, then a warm chord and confetti glints.
  gift() {
    const m = new Mix(3.4);
    sweep(m, 0, .36, 700, 5200, {amp: .2, q: 1.6, pan: -.4, panTo: .3});
    thump(m, .3, 240, 110, {amp: .18, decay: .12, glide: .02});
    mallet(m, .3, f('D6'), {amp: .22, decay: .25});
    ['A6', 'F#6', 'D6', 'A6', 'D7'].forEach((n, i) => tine(m, .36 + i * .075, f(n), {amp: .3, decay: .6 + i * .05, pan: [.3, -.1, -.35, .1, .3][i]}));
    ['D5', 'F#5', 'A5'].forEach((n, i) => bell(m, .78 + i * .012, f(n), {amp: .27, decay: 1.6, pan: (i - 1) * .3}));
    pad(m, .74, [f('D4'), f('A4'), f('F#5')], {amp: .05, attack: .2, hold: .6, release: 1.2, warm: 2.4});
    glints(m, .8, 1.6, 7, {amp: .05});
    reverb(m, {wet: .33});
    return m;
  },
  // An arrival: three soft drum hits, a whoosh, a warm brass swell opening up and a bright landing chord.
  raid() {
    const m = new Mix(3.9);
    [[0, .5, 'D2'], [.15, .55, 'D2'], [.3, .66, 'A2']].forEach(([t, a, n]) => { thump(m, t, 180, f(n), {amp: a, decay: .32, glide: .05}); sweep(m, t, .07, 900, 400, {amp: .08, q: .8}); });
    sweep(m, .36, .5, 300, 3200, {amp: .13, q: 1.1, pan: -.5, panTo: .5});
    pad(m, .42, [f('D3'), f('A3'), f('D4'), f('F#4')], {amp: .075, attack: .26, hold: 1.0, release: 1.4, warm: 1.8, open: 3.5});
    ['D5', 'A5', 'D6'].forEach((n, i) => bell(m, .62 + i * .01, f(n), {amp: .36 - i * .04, decay: 1.7, pan: (i - 1) * .35}));
    thump(m, .62, 110, 48, {amp: .34, decay: .45});
    glints(m, .72, 1.45, 6, {amp: .05});
    reverb(m, {wet: .32, room: .86});
    return m;
  }
};

const LOUDNESS = {follow: -17.5, bits: -16.5, sub: -16, gift: -16, raid: -15.5};
function loudness(file) {
  const stats = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr.toString();
  const pick = re => Number([...stats.matchAll(re)].at(-1)?.[1]);
  return {lufs: pick(/I:\s+(-?[\d.]+) LUFS/g), peak: pick(/Peak:\s+(-?[\d.]+) dBFS/g)};
}

const work = mkdtempSync(join(tmpdir(), 'dima-alert-sound-'));
try {
  for (const [name, build] of Object.entries(sounds)) {
    const wav = join(work, `${name}.wav`);
    writeFileSync(wav, finish(build()));
    // Same perceived loudness across the family (follows a little softer); peaks only ever go down from -1.5 dBFS.
    const before = loudness(wav), gain = Math.min(0, LOUDNESS[name] - before.lufs);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af', `volume=${gain.toFixed(2)}dB`, '-c:a', 'libmp3lame', '-b:a', '160k', '-ar', '48000', join(out, `sound-${name}.mp3`)]);
    const after = loudness(join(out, `sound-${name}.mp3`));
    console.log(`${name}: ${after.lufs} LUFS, peak ${after.peak} dBFS`);
  }
} catch (error) { console.error(error.stderr?.toString() ?? error); process.exitCode = 1; }
finally { rmSync(work, {recursive: true, force: true}); }
