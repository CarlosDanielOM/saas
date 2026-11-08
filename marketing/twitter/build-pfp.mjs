// DomDimaBot profile picture (square, designed for Twitter's circular crop).
// Mascot: dimadocs/src/assets/mascot.svg (vector trace of the brand mark) recolored white.
//
//   node marketing/twitter/build-pfp.mjs                 # pfp-{dark,violet}-{400,1024}.png here
//   DEBUG_SHEETS=1 node marketing/twitter/build-pfp.mjs  # also pfp-preview.png (circle crops at timeline sizes)
//
// Uses the Playwright install the ops browser checks use (/tmp/saas-cooldown-browser). No network needed.
import {createRequire} from 'node:module';
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const {chromium} = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || HERE);
const DEBUG = !!process.env.DEBUG_SHEETS;
mkdirSync(OUT, {recursive: true});

const S = 1000; // design space; exported at deviceScaleFactor = size / S
const mascot = readFileSync(resolve(REPO, 'dimadocs/src/assets/mascot.svg'), 'utf8')
  .replace(/<title[\s\S]*?<\/title>/, '').replace(/<desc[\s\S]*?<\/desc>/, '')
  .replace(/ (width|height|role|aria-labelledby)="[^"]*"/g, '')
  .replace(/fill="#000000"/g, 'fill="#ffffff"');
if (!mascot.includes('fill="#ffffff"')) throw new Error('mascot.svg fill not found; recolor failed');

const VARIANTS = {
  // Recommended: brand dark with the banner's purple/cyan light.
  dark: `
    background:
      radial-gradient(circle at 72% 22%, rgba(124,58,237,.55), rgba(124,58,237,0) 55%),
      radial-gradient(circle at 22% 84%, rgba(34,211,238,.30), rgba(34,211,238,0) 50%),
      radial-gradient(circle at 50% 50%, #1b1230 0%, #110b1f 55%, #0a0813 100%);`,
  // Alternative: solid violet for stronger presence in timelines.
  violet: `
    background:
      radial-gradient(circle at 70% 20%, rgba(255,255,255,.18), rgba(255,255,255,0) 55%),
      radial-gradient(circle at 25% 85%, rgba(34,211,238,.22), rgba(34,211,238,0) 50%),
      linear-gradient(160deg, #7c3aed 0%, #5b21b6 100%);`,
};

const grain = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" style="position:absolute;inset:0;mix-blend-mode:soft-light;opacity:.12">
  <filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
  <rect width="100%" height="100%" filter="url(#g)"/></svg>`;

const pageFor = variant => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
.stage{position:relative;width:${S}px;height:${S}px;overflow:hidden;${VARIANTS[variant]}}
.vig{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 58%, rgba(0,0,0,.35) 100%)}
.halo{position:absolute;left:50%;top:50%;width:720px;height:720px;transform:translate(-50%,-50%);border-radius:50%;
  background:radial-gradient(closest-side, rgba(167,139,250,${variant === 'dark' ? '.30' : '.16'}), rgba(167,139,250,.08) 55%, rgba(167,139,250,0))}
.mascot{position:absolute;left:50%;top:50%;width:${Math.round(S * 0.68 * 236 / 256)}px;height:${Math.round(S * 0.68)}px;transform:translate(-50%,-50%);
  filter:drop-shadow(0 0 22px rgba(196,181,253,.45)) drop-shadow(0 10px 30px rgba(0,0,0,.35))}
.mascot svg{width:100%;height:100%;display:block}
</style></head><body><div class="stage"><div class="vig"></div><div class="halo"></div><div class="mascot">${mascot}</div>${grain}</div></body></html>`;

const browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']});
const files = [];
for (const variant of Object.keys(VARIANTS)) for (const size of [400, 1024]) {
  const page = await browser.newPage({viewport: {width: S, height: S}, deviceScaleFactor: size / S});
  await page.setContent(pageFor(variant));
  await page.waitForTimeout(100);
  const name = `pfp-${variant}-${size}.png`;
  await page.screenshot({path: resolve(OUT, name), clip: {x: 0, y: 0, width: S, height: S}});
  files.push(name);
  await page.close();
}
if (DEBUG) { // how Twitter shows it: circle crops on dark and light UI at profile, card and timeline sizes
  const img = n => `data:image/png;base64,${readFileSync(resolve(OUT, n)).toString('base64')}`;
  const row = (variant, bg, fg) => `<div style="background:${bg};color:${fg};padding:24px;display:flex;gap:28px;align-items:center;font:13px system-ui">
    <div style="width:70px">${variant}</div>
    ${[200, 133, 64, 48].map(d => `<img src="${img(`pfp-${variant}-1024.png`)}" style="width:${d}px;height:${d}px;border-radius:50%">`).join('')}
    <div style="width:400px;height:200px;position:relative;overflow:hidden;border-radius:12px;background:${bg === '#000' ? '#16181c' : '#eef3f4'}">
      <div style="position:absolute;inset:0 0 40% 0;background:#2a2140"></div>
      <img src="${img(`pfp-${variant}-400.png`)}" style="position:absolute;left:16px;top:84px;width:100px;height:100px;border-radius:50%;border:4px solid ${bg}">
    </div></div>`;
  const page = await browser.newPage({viewport: {width: 1000, height: 1000}});
  await page.setContent(`<body style="margin:0">${row('dark', '#000', '#fff')}${row('violet', '#000', '#fff')}${row('dark', '#fff', '#000')}${row('violet', '#fff', '#000')}</body>`);
  await page.waitForTimeout(100);
  await page.screenshot({path: resolve(OUT, 'pfp-preview.png'), fullPage: true});
  await page.close();
}
await browser.close();
console.log('wrote', files.join(', '), 'to', OUT);
