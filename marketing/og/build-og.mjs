// DomDimaBot link preview (Open Graph / Twitter card, 1200x630), three layouts, English and Spanish.
//   a-lockup  centred brand lockup (mark + wordmark + tagline + feature chips)
//   b-chat    headline on the left, abstract "bot in chat" panel on the right (no fake UI text)
//   c-mascot  big mascot bleeding off the right, headline + feature list on the left
//
//   node marketing/og/build-og.mjs                      # og-<variant>-<lang>.jpg here (production format)
//   node marketing/og/build-og.mjs --png                # also lossless .png copies
//   node marketing/og/build-og.mjs --only=b-chat        # one variant
//   DEBUG_SHEETS=1 node marketing/og/build-og.mjs       # also og-preview-<lang>.png (how cards show it)
//
// Production: the chosen variant (b-chat, EN) is copied to dimasite/public/og-image-v2.jpg (and og-image.jpg for
// old cached links); dimasite/src/index.html points og:image / twitter:image at the -v2 name so social caches refetch.
// Release it through scripts/saas-ops build site -> verify --check ops/checks/og-image.mjs -> deploy.
// Needs Google Fonts and the Playwright install the ops browser checks use (/tmp/saas-cooldown-browser).
import {mkdirSync, readFileSync, statSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadChromium, makeRng, smooth, waveBundle, bubble, particles, FILTER_DEFS, glow, FONTS, fontsReady, brandAssets} from '../lib/art.mjs';

const W = 1200, H = 630;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || HERE);
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const DEBUG = !!process.env.DEBUG_SHEETS;
const PNG = process.argv.includes('--png');
const JPEG_QUALITY = 82;
mkdirSync(OUT, {recursive: true});
const {mascotAt} = brandAssets(REPO);

const COPY = {
  en: {
    tagline: 'A Twitch chatbot that grows with you',
    chips: ['Commands', 'TTS', 'Moderation', 'Analytics', 'Alerts & overlays'],
    sub: 'Commands, TTS, moderation and analytics. Built for English and Spanish streams.',
    list: ['Commands & timers', 'TTS voices', 'Chat moderation', 'Analytics & alerts'],
  },
  es: {
    tagline: 'Un chatbot de Twitch que crece contigo',
    chips: ['Comandos', 'TTS', 'Moderación', 'Analíticas', 'Alertas y overlays'],
    sub: 'Comandos, TTS, moderación y analíticas. Hecho para streams en inglés y español.',
    list: ['Comandos y timers', 'Voces TTS', 'Moderación del chat', 'Analíticas y alertas'],
  },
};

// ---------- shared SVG scaffolding ----------
const defs = extra => `<defs>
  <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0a0813"/><stop offset="0.55" stop-color="#0f0b1b"/><stop offset="1" stop-color="#130d22"/>
  </linearGradient>
  <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75">
    <stop offset="0.55" stop-color="#05030a" stop-opacity="0"/><stop offset="1" stop-color="#05030a" stop-opacity="0.46"/>
  </radialGradient>
${FILTER_DEFS}
${extra}
</defs>`;
const waveGradient = (id, x1, x2, from, to) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">
    <stop offset="0" stop-color="${from}" stop-opacity="0"/><stop offset="0.4" stop-color="${from}" stop-opacity="0.75"/>
    <stop offset="0.75" stop-color="${to}" stop-opacity="0.95"/><stop offset="1" stop-color="${to}" stop-opacity="0.8"/>
  </linearGradient>`;
const fadeGradient = (id, x1, x2, color) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">
    <stop offset="0" stop-color="${color}" stop-opacity="0.9"/><stop offset="0.6" stop-color="${color}" stop-opacity="0.5"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
  </linearGradient>`;
const frame = (inner, grainOp = 0.09) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${inner}
<rect width="${W}" height="${H}" fill="url(#vig)"/>
<rect width="${W}" height="${H}" filter="url(#grain)" opacity="${grainOp}" style="mix-blend-mode:soft-light"/>
</svg>`;
const RIGHT_WAVES = [{amp: 54, period: 300, op: 0.16, sw: 1.1}, {amp: 42, period: 235, op: 0.30, sw: 1.3}, {amp: 32, period: 190, op: 0.42, sw: 1.5, glow: true},
  {amp: 24, period: 260, op: 0.26, sw: 1.2}, {amp: 16, period: 160, op: 0.34, sw: 1.2}, {amp: 48, period: 350, op: 0.12, sw: 1.0}];
const SOFT_WAVES = [{amp: 20, period: 260, op: 0.22, sw: 1.1}, {amp: 13, period: 180, op: 0.28, sw: 1.2}, {amp: 9, period: 220, op: 0.18, sw: 1.0}, {amp: 26, period: 320, op: 0.11, sw: 1.0}];

// ---------- A: centred lockup ----------
function artA() {
  const rng = makeRng(2026118);
  const right = waveBundle(RIGHT_WAVES, {x0: 740, x1: 1210, yc: 528, env: x => smooth((x - 760) / 300), drift: 14, driftPeriod: 900}, 'url(#wgR)');
  const left = waveBundle(SOFT_WAVES, {x0: -10, x1: 540, yc: 84, env: x => 1 - smooth((x - 40) / 480), drift: 8, driftPeriod: 700}, 'url(#wgL)');
  const bubbles = [
    {x: 870, y: 64, w: 84, h: 38, tail: 'bl', tint: 'violet', inner: 'bars', op: 0.55},
    {x: 990, y: 128, w: 60, h: 32, tail: 'br', tint: 'cyan', inner: 'dots', op: 0.62, glow: true},
    {x: 1060, y: 50, w: 92, h: 40, tail: 'bl', tint: 'neutral', inner: 'bars', op: 0.46},
    {x: 1108, y: 176, w: 56, h: 30, tail: 'br', tint: 'violet', inner: 'dots', op: 0.72, glow: true},
    {x: 300, y: 60, w: 56, h: 30, tail: 'br', tint: 'cyan', inner: 'dots', op: 0.46},
    {x: 176, y: 122, w: 42, h: 24, tail: 'bl', tint: 'neutral', inner: 'none', op: 0.34},
    {x: 110, y: 520, w: 50, h: 28, tail: 'bl', tint: 'violet', inner: 'dots', op: 0.36},
  ].map(bubble).join('\n');
  const specks = particles(rng, [{x: [800, 1180], y: [20, 220], n: 8}, {x: [40, 560], y: [20, 150], n: 6}, {x: [60, 420], y: [430, 580], n: 3}]).join('\n');
  return frame(`${defs(waveGradient('wgR', 740, 1200, '#67e8f9', '#a78bfa') + fadeGradient('wgL', 0, 540, '#a5f3fc'))}
<rect width="${W}" height="${H}" fill="url(#base)"/>
${glow(1000, 40, 480, 240, '#5b21b6', 0.42)} ${glow(1150, -40, 280, 180, '#8b5cf6', 0.34, 'blur90')} ${glow(1200, 600, 320, 170, '#4c1d95', 0.40, 'blur90')}
${glow(120, 20, 400, 200, '#22d3ee', 0.26)} ${glow(40, 640, 280, 130, '#0ea5e9', 0.16, 'blur60')}
<g>${left}</g><g>${right}</g>
${bubbles}
${specks}`);
}
const htmlA = (c) => `
<div class="a-lockup">
  <div class="a-mark"><svg viewBox="0 0 236 256">${mascotAt(0, 0, 256)}</svg></div>
  <div class="a-text">
    <div class="name a-name">DomDimaBot</div>
    <div class="sub a-sub">Stream Companion</div>
    <div class="a-tag">${c.tagline}</div>
    <div class="chips">${c.chips.map((t, i) => `<span class="chip ${i % 2 ? 'c' : 'v'}">${t}</span>`).join('')}</div>
  </div>
</div>
<div class="url a-url">domdimabot.com</div>`;

// ---------- B: headline + abstract chat panel ----------
function artB() {
  const rng = makeRng(2026119);
  const px = 712, py = 62, pw = 430;
  const rows = [
    {y: 150, tint: '#f472b6', name: 84, msg: [196]},
    {y: 212, tint: '#fbbf24', name: 64, msg: [138, 72]},
    {y: 282, bot: true, msg: 190, tts: true},
    {y: 360, tint: '#67e8f9', name: 96, msg: [228]},
    {y: 422, tint: '#a78bfa', name: 58, msg: [110, 54]},
    {y: 494, bot: true, msg: 150, tint: 'cyan'},
    {y: 572, typing: true, tint: '#34d399'},
  ];
  const bar = (x, y, w, h, fill, op) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" opacity="${op}"/>`;
  let panel = `<rect x="${px}" y="${py}" width="${pw}" height="${H + 40 - py}" rx="26" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.10)"/>
<line x1="${px + 26}" y1="${py + 0.5}" x2="${px + pw - 26}" y2="${py + 0.5}" stroke="rgba(255,255,255,0.18)"/>
<circle cx="${px + 40}" cy="${py + 42}" r="5" fill="#ef4444"/><circle cx="${px + 40}" cy="${py + 42}" r="11" fill="#ef4444" opacity="0.25" filter="url(#blur6)"/>
${bar(px + 56, py + 37.5, 66, 9, '#ffffff', 0.5)} ${bar(px + pw - 76, py + 37.5, 40, 9, '#67e8f9', 0.55)}
<line x1="${px + 26}" y1="${py + 72}" x2="${px + pw - 26}" y2="${py + 72}" stroke="rgba(255,255,255,0.08)"/>`;
  for (const r of rows) {
    const ax = px + 44, tx = px + 76;
    if (r.bot) {
      const isCyan = r.tint === 'cyan';
      panel += `<circle cx="${ax}" cy="${r.y}" r="17" fill="${isCyan ? '#0e7490' : '#6d28d9'}" stroke="${isCyan ? '#67e8f9' : '#c4b5fd'}" stroke-opacity="0.7"/>
${mascotAt(ax - 10.5, r.y - 12, 24)}
<rect x="${tx}" y="${r.y - 18}" width="${r.msg + 30}" height="36" rx="13" fill="${isCyan ? 'rgba(34,211,238,0.14)' : 'rgba(139,92,246,0.22)'}" stroke="${isCyan ? '#67e8f9' : '#a78bfa'}" stroke-opacity="0.6"/>
${bar(tx + 15, r.y - 5, r.msg * 0.62, 10, '#ffffff', 0.85)} ${bar(tx + 15 + r.msg * 0.62 + 8, r.y - 5, r.msg * 0.38 - 8, 10, '#ffffff', 0.45)}`;
      if (r.tts) {
        const hs = [6, 14, 22, 12, 26, 16, 8];
        panel += hs.map((h, i) => `<rect x="${tx + r.msg + 44 + i * 7}" y="${r.y - h / 2}" width="4" height="${h}" rx="2" fill="#67e8f9" opacity="${0.55 + 0.06 * i}"/>`).join('');
      }
    } else if (r.typing) {
      panel += `<circle cx="${ax}" cy="${r.y}" r="16" fill="${r.tint}" opacity="0.9"/>
<rect x="${tx}" y="${r.y - 16}" width="64" height="32" rx="12" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.16)"/>
${[0, 1, 2].map(i => `<circle cx="${tx + 20 + i * 12}" cy="${r.y}" r="3.5" fill="#ffffff" opacity="${0.45 + 0.2 * i}"/>`).join('')}`;
    } else {
      panel += `<circle cx="${ax}" cy="${r.y}" r="16" fill="${r.tint}" opacity="0.9"/>${bar(tx, r.y - 15, r.name, 9, r.tint, 0.85)}`;
      let x = tx;
      for (const w of r.msg) { panel += bar(x, r.y + 1, w, 10, '#ffffff', 0.32); x += w + 8; }
    }
  }
  const under = waveBundle(SOFT_WAVES, {x0: -10, x1: 620, yc: 606, env: x => 1 - smooth((x - 60) / 540), drift: 6, driftPeriod: 700}, 'url(#wgL)');
  const specks = particles(rng, [{x: [40, 640], y: [20, 120], n: 5}, {x: [660, 1180], y: [10, 60], n: 4}]).join('\n');
  return frame(`${defs(fadeGradient('wgL', 0, 620, '#67e8f9'))}
<rect width="${W}" height="${H}" fill="url(#base)"/>
${glow(930, 330, 400, 320, '#5b21b6', 0.46)} ${glow(1160, 60, 280, 200, '#8b5cf6', 0.30, 'blur90')} ${glow(100, 60, 380, 210, '#22d3ee', 0.24)} ${glow(60, 640, 300, 130, '#0ea5e9', 0.12, 'blur60')}
<g>${under}</g>
${panel}
${specks}`);
}
const htmlB = (c) => `
<div class="b-head"><svg viewBox="0 0 236 256">${mascotAt(0, 0, 256)}</svg><span class="name b-name">DomDimaBot</span></div>
<div class="b-col"><div class="b-title">${c.tagline}</div><div class="b-sub">${c.sub}</div></div>
<div class="url b-url">domdimabot.com</div>`;

// ---------- C: big mascot ----------
function artC() {
  const rng = makeRng(2026120);
  const across = waveBundle(RIGHT_WAVES, {x0: 540, x1: 1210, yc: 350, env: x => smooth((x - 560) / 260), drift: 18, driftPeriod: 1000}, 'url(#wgR)');
  const bubbles = [
    {x: 620, y: 104, w: 76, h: 34, tail: 'br', tint: 'violet', inner: 'bars', op: 0.52},
    {x: 1112, y: 84, w: 58, h: 30, tail: 'bl', tint: 'cyan', inner: 'dots', op: 0.62, glow: true},
    {x: 1150, y: 176, w: 44, h: 26, tail: 'bl', tint: 'neutral', inner: 'none', op: 0.40},
    {x: 560, y: 196, w: 46, h: 26, tail: 'br', tint: 'cyan', inner: 'dots', op: 0.40},
  ].map(bubble).join('\n');
  const specks = particles(rng, [{x: [560, 1180], y: [20, 200], n: 8}, {x: [40, 500], y: [20, 100], n: 4}]).join('\n');
  const mh = 640, mx = 712, my = 70;
  return frame(`${defs(waveGradient('wgR', 540, 1200, '#67e8f9', '#a78bfa'))}
<rect width="${W}" height="${H}" fill="url(#base)"/>
${glow(1000, 300, 340, 300, '#6d28d9', 0.48)} ${glow(1120, 90, 280, 190, '#8b5cf6', 0.32, 'blur90')} ${glow(60, 150, 360, 240, '#22d3ee', 0.22)} ${glow(1160, 650, 300, 110, '#06b6d4', 0.18, 'blur60')}
<g>${across}</g>
<g filter="url(#blur10)" opacity="0.55">${mascotAt(mx, my, mh, '#a78bfa')}</g>
${mascotAt(mx, my, mh)}
${bubbles}
${specks}`);
}
const htmlC = (c) => `
<div class="c-brand"><div class="name c-name">DomDimaBot</div><div class="sub c-sub">Stream Companion</div></div>
<div class="c-title">${c.tagline}</div>
<ul class="c-list">${c.list.map((t, i) => `<li class="${i % 2 ? 'c' : 'v'}">${t}</li>`).join('')}</ul>
<div class="url c-url">domdimabot.com</div>`;

const VARIANTS = {'a-lockup': [artA, htmlA], 'b-chat': [artB, htmlB], 'c-mascot': [artC, htmlC]};

const css = `
html,body{margin:0;background:#0a0813}
.stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;color:#f4edff}
.stage>svg{position:absolute;inset:0;display:block}
.name{font-family:'Playfair Display',serif;font-weight:700;letter-spacing:-.3px}
.sub{font-family:'Playfair Display',serif;font-weight:400;color:#efe6ff}
.url{position:absolute;font:600 20px/1 'Space Grotesk',sans-serif;color:rgba(244,237,255,.7);letter-spacing:.2px}
.chips{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
.chip{font:600 15px/1 'Space Grotesk',sans-serif;letter-spacing:.2px;padding:9px 14px 9px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.045);color:rgba(244,237,255,.86);display:inline-flex;align-items:center;gap:7px}
.chip::before,.c-list li::before{content:"";width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.chip.v::before,.c-list li.v::before{background:#a78bfa;box-shadow:0 0 8px rgba(167,139,250,.8)}
.chip.c::before,.c-list li.c::before{background:#67e8f9;box-shadow:0 0 8px rgba(103,232,249,.8)}
/* A */
.a-lockup{position:absolute;left:0;right:0;top:0;height:${H}px;display:flex;align-items:center;justify-content:center;gap:48px;padding-bottom:16px}
.a-mark{position:relative;width:206px;height:224px;flex:0 0 auto}
.a-mark::before{content:"";position:absolute;inset:-80px;border-radius:50%;background:radial-gradient(closest-side,rgba(139,92,246,.34),rgba(139,92,246,.14) 45%,rgba(139,92,246,.04) 75%,rgba(139,92,246,0))}
.a-mark svg{position:relative;width:100%;height:100%;display:block;filter:drop-shadow(0 0 18px rgba(167,139,250,.35))}
.a-text{display:flex;flex-direction:column;align-items:flex-start}
.a-name{font-size:86px;line-height:1;text-shadow:0 2px 24px rgba(0,0,0,.45)}
.a-sub{font-size:36px;line-height:1.1;margin-top:8px;letter-spacing:.3px}
.a-tag{font:500 26px/1.3 'Space Grotesk',sans-serif;color:rgba(244,237,255,.78);margin-top:26px}
.a-url{left:0;right:0;bottom:36px;text-align:center}
/* B */
.b-head{position:absolute;left:72px;top:58px;display:flex;align-items:center;gap:16px}
.b-head svg{width:48px;height:52px;display:block;filter:drop-shadow(0 0 10px rgba(167,139,250,.4))}
.b-name{font-size:34px;line-height:1}
.b-col{position:absolute;left:72px;top:180px;width:596px;display:flex;flex-direction:column;gap:30px}
.b-title{font:700 62px/1.1 'Playfair Display',serif;letter-spacing:-.4px;text-shadow:0 2px 24px rgba(0,0,0,.45)}
.lang-es .b-title{font-size:56px}
.b-sub{max-width:540px;font:500 24px/1.45 'Space Grotesk',sans-serif;color:rgba(244,237,255,.74)}
.b-url{left:72px;bottom:52px}
/* C */
.c-brand{position:absolute;left:72px;top:62px}
.c-name{font-size:46px;line-height:1}
.c-sub{font-size:21px;line-height:1.2;margin-top:6px;letter-spacing:.3px}
.c-title{position:absolute;left:72px;top:190px;width:600px;font:700 60px/1.1 'Playfair Display',serif;letter-spacing:-.4px;text-shadow:0 2px 24px rgba(0,0,0,.45)}
.c-list{position:absolute;left:72px;top:364px;margin:0;padding:0;list-style:none;display:grid;grid-template-columns:auto auto;gap:14px 36px}
.c-list li{font:500 23px/1 'Space Grotesk',sans-serif;color:rgba(244,237,255,.84);display:flex;align-items:center;gap:12px;white-space:nowrap}
.c-url{left:72px;bottom:52px}`;

const pageFor = (variant, lang) => {
  const [art, html] = VARIANTS[variant];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>${css}</style></head><body><div class="stage lang-${lang}">${art()}${html(COPY[lang])}</div></body></html>`;
};
const FACES = ['700 86px "Playfair Display"', '400 36px "Playfair Display"', '500 26px "Space Grotesk"', '600 15px "Space Grotesk"'];

const chromium = loadChromium();
const browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']});
const made = [];
for (const variant of Object.keys(VARIANTS)) {
  if (ONLY.length && !ONLY.includes(variant)) continue;
  for (const lang of ['en', 'es']) {
    const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});
    await page.setContent(pageFor(variant, lang), {waitUntil: 'networkidle'});
    await fontsReady(page, FACES);
    await page.waitForTimeout(100);
    const base = resolve(OUT, `og-${variant}-${lang}`);
    if (PNG) await page.screenshot({path: `${base}.png`, clip: {x: 0, y: 0, width: W, height: H}});
    await page.screenshot({path: `${base}.jpg`, type: 'jpeg', quality: JPEG_QUALITY, clip: {x: 0, y: 0, width: W, height: H}});
    made.push(`og-${variant}-${lang}.jpg ${(statSync(`${base}.jpg`).size / 1024).toFixed(0)} KB`);
    await page.close();
  }
}
if (DEBUG) for (const lang of ['en', 'es']) { // how link cards show it: ~520px wide, title + domain under the image
  const img = v => `data:image/jpeg;base64,${readFileSync(resolve(OUT, `og-${v}-${lang}.jpg`)).toString('base64')}`;
  const card = v => `<div style="width:520px;border:1px solid #2f3336;border-radius:16px;overflow:hidden;background:#000;color:#e7e9ea;font:15px system-ui">
    <img src="${img(v)}" style="display:block;width:520px;height:273px;object-fit:cover">
    <div style="padding:12px 14px;border-top:1px solid #2f3336"><div style="color:#71767b;font-size:13px">domdimabot.com</div><div>DomDimaBot — A Twitch chatbot that grows with you</div></div></div>`;
  const page = await browser.newPage({viewport: {width: 1680, height: 420}});
  await page.setContent(`<body style="margin:0;background:#15202b;padding:24px;display:flex;gap:28px">${Object.keys(VARIANTS).map(card).join('')}</body>`);
  await page.waitForTimeout(100);
  await page.screenshot({path: resolve(OUT, `og-preview-${lang}.png`), fullPage: true});
  await page.close();
}
await browser.close();
console.log(made.join('\n'));
