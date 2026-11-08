// DomDimaBot Twitter header (1500x500, 3:1), English and Spanish.
// Art layer: procedural SVG (dark base, purple + cyan light, sound waves, chat bubbles).
// Brand layer: official mark from dimasite/public/assets/brand + typeset wordmark, tagline, chips, URL.
//
//   node marketing/twitter/build-banner.mjs            # writes twitter-banner-{en,es}-1500x500.png here
//   node marketing/twitter/build-banner.mjs --hires    # also writes 3000x1000 versions
//   DEBUG_SHEETS=1 node marketing/twitter/build-banner.mjs   # also writes layout-mock.png + wordmark-compare.png
//
// Needs network access for Google Fonts (Playfair Display, Space Grotesk) and the Playwright
// install the ops browser checks use (/tmp/saas-cooldown-browser).
import {writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadChromium, makeRng, smooth, wavePath, bubble, particles as specks, FILTER_DEFS, FONTS, fontsReady as fontsReadyFor, brandAssets} from '../lib/art.mjs';
const chromium = loadChromium();

const W = 1500, H = 500;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || HERE);
const HIRES = process.argv.includes('--hires');
const DEBUG = !!process.env.DEBUG_SHEETS;
mkdirSync(OUT, {recursive: true});

const rng = makeRng(20261107);
const {markPng: mark, wordmarkPng} = brandAssets(REPO);

// ---------- sound waves ----------
// Right cluster: fades in from ~x=780, full strength by ~1200, runs off the right edge.
const rightEnv = x => smooth((x - 1000) / 380);
const rightWaves = [];
const rightSpecs = [
  {amp: 74, period: 320, op: 0.16, sw: 1.1},
  {amp: 58, period: 245, op: 0.30, sw: 1.3},
  {amp: 46, period: 200, op: 0.42, sw: 1.5, glow: true},
  {amp: 36, period: 270, op: 0.26, sw: 1.2},
  {amp: 26, period: 160, op: 0.36, sw: 1.2},
  {amp: 18, period: 215, op: 0.22, sw: 1.0},
  {amp: 66, period: 360, op: 0.13, sw: 1.0},
];
rightSpecs.forEach((s, i) => {
  const d = wavePath({x0: 990, x1: 1510, yc: 258, amp: s.amp, period: s.period, phase: i * 1.37 + 0.4, env: rightEnv, drift: 22, driftPeriod: 1200});
  if (s.glow) rightWaves.push(`<path d="${d}" fill="none" stroke="url(#wgR)" stroke-width="7" opacity="0.20" filter="url(#blur6)"/>`);
  rightWaves.push(`<path d="${d}" fill="none" stroke="url(#wgR)" stroke-width="${s.sw}" stroke-linecap="round" opacity="${s.op}"/>`);
});

// Left echo: quieter, under the cyan light, fades out toward the centre.
const leftEnv = x => 1 - smooth((x - 60) / 600);
const leftWaves = [];
[{amp: 26, period: 270, op: 0.22, sw: 1.1}, {amp: 17, period: 185, op: 0.28, sw: 1.2}, {amp: 11, period: 225, op: 0.18, sw: 1.0}, {amp: 32, period: 330, op: 0.11, sw: 1.0}]
  .forEach((s, i) => {
    const d = wavePath({x0: -10, x1: 680, yc: 94, amp: s.amp, period: s.period, phase: i * 1.9 + 2.1, env: leftEnv, drift: 10, driftPeriod: 800});
    leftWaves.push(`<path d="${d}" fill="none" stroke="url(#wgL)" stroke-width="${s.sw}" stroke-linecap="round" opacity="${s.op}"/>`);
  });

// ---------- chat bubbles ----------
const bubbles = [
  {x: 1030, y: 58,  w: 88,  h: 40, tail: 'bl', tint: 'violet',  inner: 'bars', op: 0.55},
  {x: 1186, y: 112, w: 62,  h: 32, tail: 'br', tint: 'cyan',    inner: 'dots', op: 0.62, glow: true},
  {x: 1258, y: 48,  w: 94,  h: 40, tail: 'bl', tint: 'neutral', inner: 'bars', op: 0.46},
  {x: 1388, y: 116, w: 58,  h: 30, tail: 'br', tint: 'violet',  inner: 'dots', op: 0.72, glow: true},
  {x: 1296, y: 176, w: 74,  h: 34, tail: 'bl', tint: 'cyan',    inner: 'bars', op: 0.42},
  {x: 1426, y: 28,  w: 46,  h: 26, tail: 'bl', tint: 'neutral', inner: 'dots', op: 0.38},
  {x: 1150, y: 404, w: 50,  h: 28, tail: 'bl', tint: 'cyan',    inner: 'dots', op: 0.40},
  {x: 392,  y: 44,  w: 56,  h: 30, tail: 'br', tint: 'cyan',    inner: 'dots', op: 0.46},
  {x: 300,  y: 118, w: 42,  h: 24, tail: 'bl', tint: 'neutral', inner: 'none', op: 0.34},
].map(bubble).join('\n');

// ---------- particles ----------
const particles = specks(rng, [
  {x: [960, 1480], y: [18, 210], n: 9},
  {x: [1250, 1480], y: [330, 420], n: 4},
  {x: [40, 660], y: [18, 150], n: 7},
]);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0a0813"/><stop offset="0.55" stop-color="#0f0b1b"/><stop offset="1" stop-color="#130d22"/>
  </linearGradient>
  <radialGradient id="vig" cx="0.5" cy="0.5" r="0.72">
    <stop offset="0.55" stop-color="#05030a" stop-opacity="0"/><stop offset="1" stop-color="#05030a" stop-opacity="0.46"/>
  </radialGradient>
  <linearGradient id="wgR" gradientUnits="userSpaceOnUse" x1="990" y1="0" x2="1500" y2="0">
    <stop offset="0" stop-color="#67e8f9" stop-opacity="0"/>
    <stop offset="0.38" stop-color="#67e8f9" stop-opacity="0.75"/>
    <stop offset="0.72" stop-color="#a78bfa" stop-opacity="0.95"/>
    <stop offset="1" stop-color="#c4b5fd" stop-opacity="0.8"/>
  </linearGradient>
  <linearGradient id="wgL" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="680" y2="0">
    <stop offset="0" stop-color="#a5f3fc" stop-opacity="0.9"/>
    <stop offset="0.6" stop-color="#67e8f9" stop-opacity="0.5"/>
    <stop offset="1" stop-color="#67e8f9" stop-opacity="0"/>
  </linearGradient>
${FILTER_DEFS}
</defs>

<rect width="${W}" height="${H}" fill="url(#base)"/>

<!-- soft lighting -->
<ellipse cx="1290" cy="60" rx="520" ry="260" fill="#5b21b6" opacity="0.40" filter="url(#blur120)"/>
<ellipse cx="1400" cy="-20" rx="300" ry="190" fill="#8b5cf6" opacity="0.36" filter="url(#blur90)"/>
<ellipse cx="1500" cy="420" rx="320" ry="170" fill="#4c1d95" opacity="0.42" filter="url(#blur90)"/>
<ellipse cx="1120" cy="540" rx="300" ry="95" fill="#06b6d4" opacity="0.20" filter="url(#blur60)"/>
<ellipse cx="200" cy="0" rx="420" ry="190" fill="#22d3ee" opacity="0.28" filter="url(#blur120)"/>
<ellipse cx="-20" cy="90" rx="200" ry="140" fill="#0ea5e9" opacity="0.14" filter="url(#blur60)"/>

<!-- sound waves -->
<g>${leftWaves.join('\n')}</g>
<g>${rightWaves.join('\n')}</g>

<!-- chat shapes -->
${bubbles}

<!-- light specks -->
${particles.join('\n')}

<rect width="${W}" height="${H}" fill="url(#vig)"/>
<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.10" style="mix-blend-mode:soft-light"/>
</svg>`;

const COPY = {
  en: {tagline: 'A Twitch chatbot that grows with you', chips: ['Commands', 'TTS', 'Moderation', 'Analytics', 'Alerts & overlays']},
  es: {tagline: 'Un chatbot de Twitch que crece contigo', chips: ['Comandos', 'TTS', 'Moderación', 'Analíticas', 'Alertas y overlays']},
};
const brandHtml = lang => `
<div class="brand">
  <div class="mark"><img src="${mark}" alt=""></div>
  <div class="text">
    <div class="name">DomDimaBot</div>
    <div class="sub">Stream Companion</div>
    <div class="tagline">${COPY[lang].tagline}</div>
    <div class="chips">${COPY[lang].chips.map((c, i) => `<span class="chip ${i % 2 ? 'c' : 'v'}">${c}</span>`).join('')}</div>
  </div>
</div>
<div class="url">domdimabot.com</div>`;
const css = `
html,body{margin:0;background:#0a0813}
.stage{position:relative;width:${W}px;height:${H}px;overflow:hidden}
.stage>svg{position:absolute;inset:0;display:block}
.brand{position:absolute;left:372px;top:0;height:${H}px;display:flex;align-items:center;gap:40px;color:#f4edff}
.mark{position:relative;width:160px;height:174px;flex:0 0 auto}
.mark::before{content:"";position:absolute;inset:-70px;border-radius:50%;background:radial-gradient(closest-side,rgba(139,92,246,.34),rgba(139,92,246,.14) 45%,rgba(139,92,246,.04) 75%,rgba(139,92,246,0))}
.mark img{position:relative;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 0 18px rgba(167,139,250,.35))}
.text{display:flex;flex-direction:column;align-items:flex-start}
.name{font:700 80px/1 'Playfair Display',serif;letter-spacing:-.3px;text-shadow:0 2px 24px rgba(0,0,0,.45)}
.sub{font:400 34px/1.1 'Playfair Display',serif;color:#efe6ff;margin-top:8px;letter-spacing:.3px}
.tagline{font:500 24px/1.3 'Space Grotesk',sans-serif;color:rgba(244,237,255,.78);margin-top:24px}
.chips{display:flex;gap:10px;margin-top:18px}
.chip{font:600 14px/1 'Space Grotesk',sans-serif;letter-spacing:.2px;padding:8px 13px 8px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.045);color:rgba(244,237,255,.86);display:inline-flex;align-items:center;gap:7px}
.chip::before{content:"";width:6px;height:6px;border-radius:50%}
.chip.v::before{background:#a78bfa;box-shadow:0 0 8px rgba(167,139,250,.8)}
.chip.c::before{background:#67e8f9;box-shadow:0 0 8px rgba(103,232,249,.8)}
.url{position:absolute;right:48px;bottom:30px;font:600 22px/1 'Space Grotesk',sans-serif;color:rgba(244,237,255,.72);letter-spacing:.2px}`;
const pageFor = lang => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>${css}</style></head><body><div class="stage">${svg}${brandHtml(lang)}</div></body></html>`;
if (DEBUG) writeFileSync(resolve(OUT, 'banner.svg'), svg);

const browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']});
const fontsReady = page => fontsReadyFor(page, ['700 80px "Playfair Display"', '400 34px "Playfair Display"', '500 24px "Space Grotesk"', '600 14px "Space Grotesk"']);
const SIZES = HIRES ? [[1, '1500x500'], [2, '3000x1000']] : [[1, '1500x500']];
for (const lang of ['en', 'es']) for (const [scale, size] of SIZES) {
  const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: scale});
  await page.setContent(pageFor(lang), {waitUntil: 'networkidle'});
  await fontsReady(page);
  await page.waitForTimeout(100);
  await page.screenshot({path: resolve(OUT, `twitter-banner-${lang}-${size}.png`), clip: {x: 0, y: 0, width: W, height: H}});
  await page.close();
}
if (DEBUG) { // wordmark fidelity check: official PNG next to the typeset version
  const wm = wordmarkPng;
  const page = await browser.newPage({viewport: {width: 1100, height: 260}, deviceScaleFactor: 1});
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${FONTS}"><style>${css} body{display:flex;gap:40px;align-items:center;padding:20px;color:#fff;font:13px system-ui}</style></head><body><div>official PNG (x2.5)<br><img src="${wm}" width="670"></div><div>typeset<br><div class="name">DomDimaBot</div><div class="sub">Stream Companion</div></div></body></html>`, {waitUntil: 'networkidle'});
  await fontsReady(page);
  await page.screenshot({path: resolve(OUT, 'wordmark-compare.png')});
  await page.close();
}
if (DEBUG) { // Twitter avatar zone over the English banner
  const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});
  const mock = pageFor('en').replace('</body>', `<div style="position:absolute;left:62px;top:362px;width:276px;height:276px;border-radius:50%;background:#1a1426;border:6px solid #000;box-shadow:0 0 0 2px rgba(255,255,255,.08)"></div>
</body>`);
  await page.setContent(mock, {waitUntil: 'networkidle'});
  await fontsReady(page);
  await page.waitForTimeout(100);
  await page.screenshot({path: resolve(OUT, 'layout-mock.png'), clip: {x: 0, y: 0, width: W, height: H}});
  await page.close();
}
await browser.close();
console.log('wrote', OUT);
