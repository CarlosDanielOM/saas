// Drives /mocks/dev/demo in Chromium with a fake clock: one exact frame per step, piped out as PNG.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CACHE, DEMO_PATH} from './paths.mjs';
import {DEMO_FORMATS} from '../../../dimasite/src/app/features/demo-video/demo-scene.ts';

/** Fake wall clock start (fixed, so anything that prints a date prints the same one). */
const EPOCH = Date.UTC(2026, 10, 8, 20, 0, 0);
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** What the recorder lets the player load: the site itself, our media files and Google Fonts. Nothing else. */
export function requestKind(href, origin) {
  const url = new URL(href);
  if (url.origin === origin) return url.pathname.startsWith('/__demo/media/') ? 'media' : 'site';
  if (url.protocol === 'https:' && FONT_HOSTS.has(url.hostname)) return 'font';
  return 'blocked';
}

const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);

/** Runs in the page before any app code (and before the fake clock replaces the timers). */
function initPage({seed}) {
  window.__demoNative = {requestAnimationFrame: window.requestAnimationFrame.bind(window), setTimeout: window.setTimeout.bind(window)};
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Sound is mixed from cues afterwards; any page audio would be a bug (and silent anyway: Chromium runs muted).
  window.__demoPlays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!this.muted) window.__demoPlays.push(this.currentSrc || this.src || this.tagName);
    return play.call(this);
  };
}

/** Google Fonts responses cached on disk, so renders don't depend on the network after the first one. */
async function fontRoute(route) {
  const url = route.request().url(), dir = resolve(CACHE, 'fonts');
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  const body = resolve(dir, `${key}.bin`), meta = resolve(dir, `${key}.json`);
  if (existsSync(body) && existsSync(meta)) {
    const {status, type} = JSON.parse(readFileSync(meta, 'utf8'));
    return route.fulfill({status, headers: {'content-type': type, 'access-control-allow-origin': '*'}, body: readFileSync(body)});
  }
  const response = await route.fetch();
  const bytes = await response.body();
  if (response.ok()) {
    mkdirSync(dir, {recursive: true});
    writeFileSync(body, bytes);
    writeFileSync(meta, JSON.stringify({status: response.status(), type: response.headers()['content-type'] ?? 'application/octet-stream', url}));
  }
  return route.fulfill({response, body: bytes});
}

/**
 * Open the player. Only the site origin, Google Fonts and our own /__demo/media/ files load; everything else
 * (API, analytics, websockets) is blocked and reported.
 */
export async function openPlayer(browser, {baseUrl, format, lang, scale = 2, seed = 1, media = {}}) {
  const size = DEMO_FORMATS[format];
  const context = await browser.newContext({
    viewport: size, deviceScaleFactor: scale, reducedMotion: 'no-preference', colorScheme: 'dark',
    locale: lang === 'es' ? 'es-MX' : 'en-US', timezoneId: 'America/Mexico_City', serviceWorkers: 'block'
  });
  const origin = new URL(baseUrl).origin, blocked = [], pageErrors = [];
  const files = new Map(Object.values(media).map(m => [m.src, m.file]));
  await context.route('**/*', async route => {
    const href = route.request().url();
    switch (requestKind(href, origin)) {
      case 'site': return route.continue();
      case 'media': { const file = files.get(new URL(href).pathname); return file ? route.fulfill({path: file}) : route.fulfill({status: 404}); }
      case 'font': return fontRoute(route);
      default: blocked.push(href.slice(0, 160)); return route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket(/.*/, ws => { blocked.push(`websocket ${ws.url()}`); ws.close(); });
  await context.addInitScript(initPage, {seed});
  await context.clock.install({time: EPOCH});
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(baseUrl + DEMO_PATH, {waitUntil: 'load', timeout: 60000});
  await page.waitForFunction(() => window.__dimaDemo?.bootReady === true, null, {timeout: 30000, polling: 100});
  // Chrome's own capture: ~60 ms per 1080p frame, versus ~400 ms through page.screenshot (identical lossless PNG).
  // It ignores the emulated pixel ratio, so the clip carries the scale.
  const cdp = await context.newCDPSession(page);
  const clip = {x: 0, y: 0, width: size.width, height: size.height, scale};
  return {context, page, cdp, clip, blocked, pageErrors, close: () => context.close()};
}

/**
 * Load the player once and let it fetch every font, so the font cache on disk is complete before frame 0.
 * Text rendered while a font is still being downloaded can differ by a few pixels from text rendered from cache.
 */
export async function warmFonts(browser, {baseUrl, raw, format, lang}) {
  const player = await openPlayer(browser, {baseUrl, format, lang, scale: 1, seed: raw.seed ?? 1});
  try { await loadScene(player, raw, {format, lang}); } finally { await player.close(); }
}

/** Hand the scene to the player, wait for fonts/pictures/alerts, then freeze the clock at a clean start. */
export async function loadScene(player, raw, {format, lang, media = {}, look}) {
  const {page, context} = player;
  const actors = await page.evaluate(() => ({version: window.__dimaDemo.version, actors: window.__dimaDemo.actors}));
  const missing = [...new Set((raw.beats ?? []).map(b => b.do))].filter(kind => !actors.actors.includes(kind));
  if (missing.length) throw new Error(`the player at this address doesn't know ${missing.join(', ')} yet (deploy the site, or render a candidate with --bundle/--base-url)`);
  const options = {format, lang, ...(look ? {look} : {}), media: {tts: Object.fromEntries(Object.entries(media).map(([id, m]) => [id, {src: m.src, durationMs: m.durationMs}]))}};
  const info = await page.evaluate(([scene, opts]) => window.__dimaDemo.load(scene, opts), [raw, options]);
  if (!info.ok) throw new Error(`the player rejected the scene:\n  ${info.errors.join('\n  ')}`);
  const ready = await withTimeout(page.evaluate(() => window.__dimaDemo.ready()), 45000, 'waiting for fonts and pictures');
  if (!ready.ok) throw new Error(`not ready: ${ready.problems.join('; ')}`);
  const now = await page.evaluate(() => Date.now());
  await context.clock.pauseAt(now + 1000);
  // The settle step uses the real requestAnimationFrame; make sure it still runs with the clock paused.
  await withTimeout(page.evaluate(() => new Promise(r => window.__demoNative.requestAnimationFrame(() => r(true)))), 5000, 'a real animation frame');
  return info;
}

/**
 * Render frames [from, to) at `fps`. For each: advance the fake clock by exactly the frame step, let the player
 * render scene time t and settle, refuse animations that run on their own, screenshot.
 */
export async function captureFrames(player, {fps, durationMs, from = 0, to, onFrame}) {
  const {page, context, cdp, clip} = player;
  const total = Math.ceil((durationMs * fps) / 1000);
  const last = Math.min(total, to ?? total);
  let clockMs = 0;
  for (let index = 0; index < last; index++) {
    const t = (index * 1000) / fps, tMs = Math.round(t);
    if (tMs > clockMs) { await context.clock.runFor(tMs - clockMs); clockMs = tMs; }
    if (index < from) continue;
    // The first captured frame (start, or a jump into the middle of a scene) gets a second settle pass and a
    // throwaway capture: right after a large change, Chromium may still be re-rasterizing layers at their final
    // resolution, and the first capture after it could draw a few anti-aliased edges either of two ways.
    if (index === from) {
      await withTimeout(page.evaluate(time => window.__dimaDemo.frame(time), t), 30000, `frame ${index}`);
      await new Promise(r => setTimeout(r, 250)); // real time; the page clock stays paused
      await cdp.send('Page.captureScreenshot', {format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, clip});
    }
    const state = await withTimeout(page.evaluate(time => window.__dimaDemo.frame(time), t), 30000, `frame ${index}`);
    if (state.waiting) throw new Error(`frame ${index}: ${state.waiting} overlay item(s) still loading pictures`);
    if (state.running.length) throw new Error(`frame ${index} (${tMs} ms): animations running on their own clock, so frames would not be exact: ${state.running.slice(0, 6).join(', ')}`);
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, clip});
    const png = Buffer.from(data, 'base64');
    await onFrame(png, index, t);
  }
  const plays = await page.evaluate(() => window.__demoPlays);
  if (plays.length) throw new Error(`the page tried to play sound itself (${plays.slice(0, 3).join(', ')}); sound must come from cues`);
  return {total, rendered: last - from};
}
