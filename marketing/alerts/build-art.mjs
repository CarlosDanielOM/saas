// Art for the Dima default alerts (public overlay library): badges, cards, glows, rings and sparkles.
// SVG drawn here, rasterised by Playwright's Chromium (transparent), encoded to WebP with ffmpeg-static.
//   node alerts/build-art.mjs [outDir]   (default: dimasite/public/overlay-library/v1)
import {mkdirSync, writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadChromium} from '../lib/art.mjs';
import {PALETTE} from './palette.mjs';

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const out = resolve(process.argv[2] ?? new URL('../../dimasite/public/overlay-library/v1', import.meta.url).pathname);
mkdirSync(out, {recursive: true});

// ---------- icons (drawn in a 100×100 box, centred on 50,50) ----------
const icons = {
  follow: c => `
    <defs><linearGradient id="ic" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${c.h}"/></linearGradient></defs>
    <path d="M50 86 C20 66 8 49 8 33 C8 19.5 18.5 10 31 10 C40 10 46 15 50 22 C54 15 60 10 69 10 C81.5 10 92 19.5 92 33 C92 49 80 66 50 86 Z" fill="url(#ic)"/>
    <path d="M24 26 C27 20 33 18 38 19" fill="none" stroke="${c.l}" stroke-width="4" stroke-linecap="round" opacity=".55"/>`,
  bits: c => `
    <polygon points="12,37 29,13 71,13 88,37" fill="#ffffff"/>
    <polygon points="29,13 40,37 60,37 71,13" fill="#f0fdff"/>
    <polygon points="88,37 71,13 60,37" fill="${c.h}"/>
    <polygon points="12,37 40,37 50,90" fill="${c.h}"/>
    <polygon points="40,37 60,37 50,90" fill="#ffffff"/>
    <polygon points="60,37 88,37 50,90" fill="${c.l}"/>
    <g fill="none" stroke="${c.d}" stroke-opacity=".42" stroke-width="1.8" stroke-linejoin="round">
      <polygon points="12,37 29,13 71,13 88,37 50,90"/><polyline points="12,37 88,37"/><polyline points="29,13 40,37 50,90 60,37 71,13"/>
    </g>
    <path d="M21 31 L30 19" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" opacity=".95"/>`,
  sub: c => {
    const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 19 : 41, a = -Math.PI / 2 + i * Math.PI / 5; pts.push(`${(50 + r * Math.cos(a)).toFixed(2)},${(53 + r * Math.sin(a)).toFixed(2)}`); }
    return `<defs><linearGradient id="ic" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${c.h}"/></linearGradient></defs>
      <polygon points="${pts.join(' ')}" fill="url(#ic)" stroke="url(#ic)" stroke-width="7" stroke-linejoin="round"/>
      <polygon points="${pts.join(' ')}" fill="none" stroke="${c.l}" stroke-opacity=".5" stroke-width="1.5" stroke-linejoin="round" transform="translate(50 53) scale(.62) translate(-50 -53)"/>`;
  },
  gift: c => `
    <defs><linearGradient id="ic" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${c.h}"/></linearGradient>
      <linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
    <path d="M38 30 C28 14 14 20 20 28 C24 33 33 32 46 32 Z" fill="url(#rb)" stroke="#d97706" stroke-width="1.5"/>
    <path d="M62 30 C72 14 86 20 80 28 C76 33 67 32 54 32 Z" fill="url(#rb)" stroke="#d97706" stroke-width="1.5"/>
    <rect x="19" y="47" width="62" height="40" rx="5" fill="url(#ic)"/>
    <rect x="13" y="32" width="74" height="17" rx="5" fill="#ffffff"/>
    <rect x="19" y="49" width="62" height="5" fill="${c.l}" opacity=".55"/>
    <rect x="44" y="32" width="12" height="55" fill="url(#rb)"/>
    <circle cx="50" cy="31" r="6.5" fill="#fbbf24" stroke="#d97706" stroke-width="1.5"/>`,
  raid: c => `
    <defs><linearGradient id="fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset=".45" stop-color="#fbbf24"/><stop offset="1" stop-color="#f97316" stop-opacity="0"/></linearGradient>
      <linearGradient id="ic" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${c.h}"/></linearGradient></defs>
    <g transform="translate(50 50) scale(1.1) rotate(45) translate(-50 -50)">
      <path d="M41 70 Q50 104 59 70 Z" fill="url(#fl)"/>
      <path d="M35 52 L20 70 L22 79 L37 69 Z" fill="${c.l}"/>
      <path d="M65 52 L80 70 L78 79 L63 69 Z" fill="${c.l}"/>
      <path d="M50 6 C67 21 71 44 66 68 L34 68 C29 44 33 21 50 6 Z" fill="url(#ic)"/>
      <rect x="39" y="66" width="22" height="6" rx="2" fill="${c.l}"/>
      <circle cx="50" cy="37" r="10" fill="${c.d}" stroke="#ffffff" stroke-width="3.5"/>
      <circle cx="47" cy="34" r="3" fill="#ffffff" opacity=".7"/>
    </g>`
};

// ---------- pieces ----------
function badge(kind) {
  const c = PALETTE[kind];
  return {w: 200, h: 200, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <defs>
    <radialGradient id="disc" cx="36%" cy="28%" r="82%"><stop offset="0" stop-color="${c.l}"/><stop offset=".42" stop-color="${c.a}"/><stop offset="1" stop-color="${c.d}"/></radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".6"/><stop offset=".5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".25"/></linearGradient>
    <clipPath id="clip"><circle cx="100" cy="100" r="78"/></clipPath>
    <filter id="lift" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#05060a" flood-opacity=".55"/></filter>
    <filter id="icon" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="${c.d}" flood-opacity=".7"/></filter>
  </defs>
  <circle cx="100" cy="100" r="92" fill="none" stroke="${c.a}" stroke-opacity=".38" stroke-width="3"/>
  <circle cx="100" cy="100" r="78" fill="url(#disc)" filter="url(#lift)"/>
  <g clip-path="url(#clip)"><ellipse cx="100" cy="52" rx="70" ry="38" fill="#ffffff" opacity=".14"/></g>
  <circle cx="100" cy="100" r="77" fill="none" stroke="url(#rim)" stroke-width="2.5"/>
  <g filter="url(#icon)" transform="translate(56 56) scale(.88)">${icons[kind](c)}</g>
</svg>`};
}

// The tile: Live First dark surface, an accent wash from the badge side and a lit edge. `stat` adds the
// metric panel on the right (bits, gift and raid amounts).
function card(kind, stat) {
  const c = PALETTE[kind];
  return {w: 660, h: 150, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="150" viewBox="0 0 660 150">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2130"/><stop offset="1" stop-color="#13161d"/></linearGradient>
    <radialGradient id="wash" gradientUnits="userSpaceOnUse" cx="10" cy="75" r="330"><stop offset="0" stop-color="${c.a}" stop-opacity=".34"/><stop offset=".55" stop-color="${c.a}" stop-opacity=".08"/><stop offset="1" stop-color="${c.a}" stop-opacity="0"/></radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.a}" stop-opacity=".95"/><stop offset=".4" stop-color="${c.a}" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity=".08"/></linearGradient>
    <linearGradient id="statbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.a}" stop-opacity=".16"/><stop offset="1" stop-color="${c.a}" stop-opacity=".07"/></linearGradient>
    <clipPath id="clip"><rect x="10" y="9" width="640" height="124" rx="26"/></clipPath>
    <filter id="shadow" x="-10%" y="-30%" width="120%" height="170%"><feDropShadow dx="0" dy="7" stdDeviation="7" flood-color="#000000" flood-opacity=".5"/></filter>
  </defs>
  <rect x="10" y="9" width="640" height="124" rx="26" fill="url(#bg)" fill-opacity=".96" filter="url(#shadow)"/>
  <g clip-path="url(#clip)">
    <rect x="10" y="9" width="640" height="124" fill="url(#wash)"/>
    <rect x="10" y="9" width="640" height="1.5" fill="#ffffff" opacity=".06"/>
    ${stat ? `<rect x="498" y="23" width="138" height="96" rx="18" fill="url(#statbg)"/><rect x="498.75" y="23.75" width="136.5" height="94.5" rx="17.25" fill="none" stroke="${c.a}" stroke-opacity=".28" stroke-width="1.5"/>` : ''}
  </g>
  <rect x="10.75" y="9.75" width="638.5" height="122.5" rx="25.25" fill="none" stroke="url(#edge)" stroke-width="1.5"/>
</svg>`};
}

function glow(kind) {
  const c = PALETTE[kind];
  return {w: 256, h: 256, scale: 1, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${c.glow}" stop-opacity=".85"/><stop offset=".38" stop-color="${c.glow}" stop-opacity=".38"/><stop offset=".7" stop-color="${c.glow}" stop-opacity=".1"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient></defs>
  <circle cx="128" cy="128" r="128" fill="url(#g)"/>
</svg>`};
}

function ring(kind) {
  const c = PALETTE[kind];
  return {w: 200, h: 200, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter></defs>
  <circle cx="100" cy="100" r="80" fill="none" stroke="${c.a}" stroke-width="9" opacity=".55" filter="url(#b)"/>
  <circle cx="100" cy="100" r="80" fill="none" stroke="${c.l}" stroke-width="2.5" opacity=".9"/>
</svg>`};
}

function sparkle(kind) {
  const c = PALETTE[kind];
  return {w: 64, h: 64, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="s" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="${c.h}"/><stop offset="1" stop-color="${c.l}"/></radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${c.glow}" stop-opacity=".55"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="22" fill="url(#halo)"/>
  <path d="M32 4 C33.6 22 42 30.4 60 32 C42 33.6 33.6 42 32 60 C30.4 42 22 33.6 4 32 C22 30.4 30.4 22 32 4 Z" fill="url(#s)"/>
</svg>`};
}

// Raid speed line: a tapered streak on a 20 px tall canvas (the Studio's smallest object size).
function wind() {
  return {w: 200, h: 20, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20" viewBox="0 0 200 20">
  <defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fca5a5" stop-opacity="0"/><stop offset=".55" stop-color="#fecaca" stop-opacity=".75"/><stop offset=".92" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>
  <path d="M2 10 L196 8.4 Q199 10 196 11.6 Z" fill="url(#w)"/>
</svg>`};
}
// Gift confetti: one small rounded piece per colour, centred on a 20 px canvas.
const CONFETTI = ['#fbbf24', '#c084fc', '#f9a8d4', '#ffffff'];
function confetti(color) {
  return {w: 20, h: 20, scale: 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
  <rect x="6" y="3.5" width="8" height="13" rx="2" fill="${color}"/><rect x="6" y="3.5" width="4" height="13" rx="2" fill="#ffffff" opacity=".22"/>
</svg>`};
}

const pieces = {};
for (const kind of Object.keys(PALETTE)) {
  pieces[`badge-${kind}`] = badge(kind);
  pieces[`card-${kind}`] = card(kind, kind === 'bits' || kind === 'gift' || kind === 'raid');
  pieces[`glow-${kind}`] = glow(kind);
  pieces[`ring-${kind}`] = ring(kind);
  pieces[`sparkle-${kind}`] = sparkle(kind);
}

pieces['wind-raid'] = wind();
CONFETTI.forEach((color, i) => { pieces[`confetti${i + 1}-gift`] = confetti(color); });

const chromium = loadChromium();
const browser = await chromium.launch();
const work = mkdtempSync(join(tmpdir(), 'dima-alert-art-'));
try {
  for (const [name, piece] of Object.entries(pieces)) {
    const page = await browser.newPage({viewport: {width: piece.w, height: piece.h}, deviceScaleFactor: piece.scale});
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${piece.svg}</body></html>`);
    const png = join(work, `${name}.png`);
    await page.screenshot({path: png, omitBackground: true, clip: {x: 0, y: 0, width: piece.w, height: piece.h}});
    await page.close();
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '92', '-compression_level', '4', '-pix_fmt', 'yuva420p', join(out, `${name}.webp`)]);
    writeFileSync(join(work, `${name}.svg`), piece.svg);
  }
  console.log(`${Object.keys(pieces).length} pictures → ${out}`);
} finally {
  await browser.close();
  rmSync(work, {recursive: true, force: true});
}
