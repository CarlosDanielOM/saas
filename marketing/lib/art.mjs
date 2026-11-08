// Shared pieces for the procedural brand visuals (Twitter banner, profile picture, link preview).
// Everything renders through Playwright's Chromium; the install the ops browser checks use is reused.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export function loadChromium() {
  const require = createRequire('/tmp/saas-cooldown-browser/package.json');
  return require('playwright').chromium;
}

export const smooth = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
export const f1 = n => n.toFixed(1);

// Deterministic LCG so a given seed always produces the same specks.
export function makeRng(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return {rnd, range: (a, b) => a + (b - a) * rnd()};
}

// ---------- sound waves ----------
export function wavePath({x0, x1, yc, amp, period, phase, env, drift = 0, driftPeriod = 900}) {
  const k = 2 * Math.PI / period, kd = 2 * Math.PI / driftPeriod;
  const pts = [];
  for (let x = x0; x <= x1; x += 5) {
    const e = env(x);
    const beat = 0.55 + 0.45 * Math.sin(x * k * 0.31 + phase * 1.9);     // amplitude modulation, like audio
    const y = yc + drift * Math.sin(x * kd + phase) + amp * e * beat * Math.sin(x * k + phase);
    pts.push([x, y]);
  }
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += ` Q${f1(x)},${f1(y)} ${f1((x + nx) / 2)},${f1((y + ny) / 2)}`;
  }
  return d;
}

// A bundle of waves sharing one envelope/centre line; `stroke` is usually a gradient url.
export function waveBundle(specs, common, stroke) {
  return specs.map((s, i) => {
    const d = wavePath({...common, amp: s.amp, period: s.period, phase: i * 1.37 + 0.4});
    return (s.glow ? `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="7" opacity="0.20" filter="url(#blur6)"/>\n` : '')
      + `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${s.sw}" stroke-linecap="round" opacity="${s.op}"/>`;
  }).join('\n');
}

// ---------- chat bubbles ----------
export const TINT = {
  violet:  {stroke: '#cbb8ff', fill: 'rgba(139,92,246,0.16)', glow: '#8b5cf6'},
  cyan:    {stroke: '#a8f0fb', fill: 'rgba(34,211,238,0.11)',  glow: '#22d3ee'},
  neutral: {stroke: 'rgba(255,255,255,0.55)', fill: 'rgba(255,255,255,0.05)', glow: '#c4b5fd'},
};
export function bubblePath(x, y, w, h, tail) {
  const r = Math.min(h * 0.42, 15);
  if (tail === 'bl') {
    return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r + 7} L${x - 3},${y + h + 9} L${x},${y + h - 7} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
  }
  return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - 7} L${x + w + 3},${y + h + 9} L${x + w - r - 7},${y + h} H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
}
export function bubble({x, y, w, h, tail = 'bl', tint = 'violet', inner = 'dots', op = 0.5, glow = false, sw = 1.4}) {
  const t = TINT[tint];
  const d = bubblePath(x, y, w, h, tail);
  let s = '';
  if (glow) s += `<path d="${d}" fill="${t.glow}" opacity="0.26" filter="url(#blur10)"/>`;
  s += `<g opacity="${(op * 0.82).toFixed(2)}"><path d="${d}" fill="${t.fill}" stroke="${t.stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  const cy = y + h / 2;
  if (inner === 'dots') {
    const r = Math.max(1.6, h * 0.075), gap = r * 3.2, cx0 = x + w / 2 - gap;
    for (let i = 0; i < 3; i++) s += `<circle cx="${f1(cx0 + i * gap)}" cy="${f1(cy)}" r="${f1(r)}" fill="${t.stroke}" opacity="${0.55 + 0.2 * i}"/>`;
  } else if (inner === 'bars') {
    const bh = Math.max(2.2, h * 0.11), pad = h * 0.36;
    const w1 = (w - 2 * pad) * 0.78, w2 = (w - 2 * pad) * 0.5;
    s += `<rect x="${f1(x + pad)}" y="${f1(cy - bh - 1.5)}" width="${f1(w1)}" height="${f1(bh)}" rx="${f1(bh / 2)}" fill="${t.stroke}" opacity="0.7"/>`;
    s += `<rect x="${f1(x + pad)}" y="${f1(cy + 1.5)}" width="${f1(w2)}" height="${f1(bh)}" rx="${f1(bh / 2)}" fill="${t.stroke}" opacity="0.45"/>`;
  }
  return s + '</g>';
}

// ---------- light specks ----------
export function particles({rnd, range}, zones) {
  const out = [];
  for (const z of zones) for (let i = 0; i < z.n; i++) {
    const x = range(...z.x), y = range(...z.y), r = range(0.8, 2.3);
    const col = ['#ffffff', '#a8f0fb', '#cbb8ff'][Math.floor(rnd() * 3)];
    const op = range(0.25, 0.75);
    if (rnd() < 0.4) out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 3)}" fill="${col}" opacity="${f1(op * 0.3)}" filter="url(#blur6)"/>`);
    out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${col}" opacity="${f1(op)}"/>`);
  }
  return out;
}

// ---------- shared SVG defs ----------
export const FILTER_DEFS = `  <filter id="blur120" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="120"/></filter>
  <filter id="blur90" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="90"/></filter>
  <filter id="blur60" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="60"/></filter>
  <filter id="blur10" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>`;
export const glow = (cx, cy, rx, ry, fill, op, blur = 'blur120') =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="${op}" filter="url(#${blur})"/>`;

// ---------- type ----------
export const FONTS = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Space+Grotesk:wght@400;500;600;700&display=block';
export async function fontsReady(page, faces) {
  const ok = await page.evaluate(async faces => { await Promise.all(faces.map(f => document.fonts.load(f))); await document.fonts.ready; return faces.every(f => document.fonts.check(f)); }, faces);
  if (!ok) throw new Error('web fonts did not load');
}

// ---------- brand assets ----------
export function brandAssets(repo) {
  const brand = resolve(repo, 'dimasite/public/assets/brand');
  const png = n => `data:image/png;base64,${readFileSync(resolve(brand, n)).toString('base64')}`;
  // Vector trace of the mascot (same robot as the brand mark), recolored white; keeps every size sharp.
  const mascotSvg = readFileSync(resolve(repo, 'dimadocs/src/assets/mascot.svg'), 'utf8')
    .replace(/<title[\s\S]*?<\/title>/, '').replace(/<desc[\s\S]*?<\/desc>/, '')
    .replace(/ (width|height|role|aria-labelledby)="[^"]*"/g, '')
    .replace(/fill="#000000"/g, 'fill="#ffffff"');
  if (!mascotSvg.includes('fill="#ffffff"')) throw new Error('mascot.svg fill not found; recolor failed');
  // Place the mascot inside another SVG: nested <svg> keeps its own 236x256 viewBox.
  const mascotAt = (x, y, h, fill = '#ffffff') =>
    mascotSvg.replace('<svg', `<svg x="${x}" y="${y}" width="${f1(h * 236 / 256)}" height="${h}"`).replace(/fill="#ffffff"/g, `fill="${fill}"`);
  return {markPng: png('mark-on-dark.png'), wordmarkPng: png('wordmark-on-dark.png'), mascotSvg, mascotAt};
}
