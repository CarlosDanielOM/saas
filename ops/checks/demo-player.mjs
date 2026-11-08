// Behaviour check for the demo-video player (/mocks/dev/demo), which marketing/video records frame by frame.
//   SAAS_PREVIEW_URL=<candidate or https://domdimabot.com> node ops/checks/demo-player.mjs
// Self-contained (saas-ops copies it before running it). Covers:
//   - the browser preview: plays, controls work, phone + desktop, dark + light, no overflow, axe on the controls;
//   - privacy: the page makes no API, analytics or websocket attempts;
//   - the recorder contract (window.__dimaDemo): load/validate, scene state at set times for every building block,
//     nothing animating on its own clock, no page audio, and byte-identical frames on two separate renders.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser/node_modules';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL?.replace(/\/$/, '');
assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const PATH = '/mocks/dev/demo';
const origin = new URL(base).origin;
const started = Date.now();

// Every building block, short. Times resolve to: intro 0-1200, m1 1400, a1 1600-4600 (+event, camera),
// del 3000, t1 4800-6800, r1 7000-11000 (spin 7600-10600), spam 11200, ban 11800 (+bot 12100), d1 12400-..., outro.
const SCENE = {
  id: 'check', v: 1, seed: 5,
  channel: { name: 'check_channel', title: 'Check stream', game: 'Chess', viewers: 3 },
  beats: [
    { do: 'intro', at: 0, dur: 1200, title: { en: 'Check *intro*', es: 'Intro de *prueba*' } },
    { do: 'chat', id: 'm1', at: '+200', user: 'viewer_one', badges: ['sub', 'mod'], text: { en: 'hello there', es: 'hola' } },
    { do: 'alert', id: 'a1', at: '+200', dur: 3000, event: 'sub', user: 'viewer_two', amount: 6, sound: { src: 'kit:chime', gain: 0.8, delay: 200, fadeIn: 100, fadeOut: 400 } },
    { do: 'camera', with: 'a1', at: '+0', focus: 'alert' },
    { do: 'event', with: 'a1', at: '+0', icon: 'sub', text: 'viewer_two subscribed' },
    { do: 'caption', id: 'cap', with: 'a1', at: '+300', dur: 2000, text: { en: 'An *alert*, live', es: 'Una *alerta*, en vivo' } },
    { do: 'delete', with: 'a1', at: '+1400', target: 'm1' },
    { do: 'camera', after: 'a1', at: '+0', dur: 200, focus: 'full' },
    { do: 'tts', id: 't1', with: 'a1', at: '+3200', dur: 2000, user: 'viewer_three', text: 'read this out loud' },
    { do: 'roulette', id: 'r1', after: 't1', at: '+200', title: 'Prize', items: ['Alpha', 'Beta', 'Gamma'], winner: 1, spin: 3000, dur: 4000 },
    { do: 'chat', id: 'spam', after: 'r1', at: '+200', user: 'promo_bot_9', first: true, text: 'cheap followers at spam.example', sfx: 'kit:pop' },
    { do: 'highlight', with: 'spam', at: '+100', dur: 500, target: 'spam', label: 'First message' },
    { do: 'ban', id: 'ban', with: 'spam', at: '+600', target: 'spam', sfx: { src: 'kit:thud', gain: 0.9 } },
    { do: 'bot', with: 'ban', at: '+300', text: '@promo_bot_9 Selected unwanted chat behavior' },
    { do: 'duel', id: 'd1', after: 'ban', at: '+600', left: 'viewer_one', right: 'viewer_two' },
    { do: 'outro', after: 'd1', at: '+100', dur: 1200, cta: 'domdimabot.com' }
  ]
};

const errors = [];
const attempts = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });

/** Same page set-up as the recorder: native timers saved first, seeded randomness, page-audio guard, fake clock. */
function initPage({ seed }) {
  window.__demoNative = { requestAnimationFrame: window.requestAnimationFrame.bind(window), setTimeout: window.setTimeout.bind(window) };
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__demoPlays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { if (!this.muted) window.__demoPlays.push(this.currentSrc || this.src); return play.call(this); };
}

async function context(options = {}, { record = false, label = '' } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...options });
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    attempts.push(`${label}: ${url.href.slice(0, 120)}`);
    return route.abort('blockedbyclient');
  });
  await ctx.routeWebSocket(/./, (ws) => { attempts.push(`${label}: websocket ${ws.url()}`); ws.close(); });
  if (record) {
    await ctx.addInitScript(initPage, { seed: 5 });
    await ctx.clock.install({ time: Date.UTC(2026, 10, 8, 20) });
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|NG0|ReferenceError/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  await page.goto(base + PATH);
  await page.waitForFunction(() => window.__dimaDemo?.bootReady === true, null, { polling: 100, timeout: 30000 });
  return { ctx, page };
}

async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ── 1. Browser preview ─────────────────────────────────────────────────
for (const { width, height, theme } of [{ width: 390, height: 844, theme: 'dark' }, { width: 320, height: 640, theme: 'light' }, { width: 1280, height: 800, theme: 'light' }, { width: 1280, height: 800, theme: 'dark' }]) {
  const label = `preview ${width} ${theme}`;
  const { ctx, page } = await context({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'no-preference' }, { label });
  await page.evaluate((theme) => localStorage.setItem('theme', theme), theme);
  await page.reload();
  await page.locator('.dp-head h1').waitFor();
  await page.locator('app-demo-frame .df').waitFor();
  const t0 = Number(await page.locator('.dp-range').inputValue());
  await until(async () => Number(await page.locator('.dp-range').inputValue()) > t0 + 300, `${label}: preview plays`);
  // Pause, scrub, switch format and language.
  await page.getByRole('button', { name: /^(Pause|Pausar)$/ }).click();
  await page.locator('.dp-range').fill('2600');
  await until(async () => (await page.locator('.dp-time').textContent())?.startsWith('2.6'), `${label}: scrub`);
  await page.getByRole('button', { name: /^(Landscape|Horizontal)$/ }).click();
  await until(async () => (await page.locator('app-demo-frame').getAttribute('data-format')) === 'landscape', `${label}: landscape`);
  await page.getByRole('button', { name: 'ES', exact: true }).click();
  await until(async () => (await page.locator('.dp-head h1').textContent())?.includes('Reproductor'), `${label}: Spanish`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: horizontal overflow ${overflow}px`);
  const box = await page.locator('app-demo-frame').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: the frame fits the screen`);
  await page.addScriptTag({ path: axePath });
  const axe = await page.evaluate(() => window.axe.run(document.querySelector('.dp-head'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 3) })), [], `${label}: axe`);
  if (shots) await page.screenshot({ path: `${shots}/demo-preview-${width}-${theme}.png` });
  await ctx.close();
}

// ── 2. Recorder contract ───────────────────────────────────────────────
async function recorder(format, lang) {
  const size = format === 'vertical' ? { width: 540, height: 960 } : { width: 960, height: 540 };
  const { ctx, page } = await context({ viewport: size, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'no-preference' }, { record: true, label: `record ${format} ${lang}` });
  const info = await page.evaluate(([scene, opts]) => window.__dimaDemo.load(scene, opts), [SCENE, { format, lang, media: {} }]);
  assert.ok(info.ok, `load: ${JSON.stringify(info.errors)}`);
  const ready = await page.evaluate(() => window.__dimaDemo.ready());
  assert.deepEqual(ready.problems, [], 'ready');
  const now = await page.evaluate(() => Date.now());
  await ctx.clock.pauseAt(now + 1000);
  const cdp = await ctx.newCDPSession(page);
  let clock = 0;
  const frame = async (t) => {
    if (t > clock) { await ctx.clock.runFor(t - clock); clock = t; }
    const state = await page.evaluate((time) => window.__dimaDemo.frame(time), t);
    assert.equal(state.waiting, 0, `${format} ${lang} @${t}: pictures still loading`);
    assert.deepEqual(state.running, [], `${format} ${lang} @${t}: animations on their own clock`);
    return state;
  };
  const shot = async () => createHash('sha256').update((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...size, scale: 1 } })).data).digest('hex');
  return { ctx, page, info, frame, shot };
}

{
  const { ctx, page, info, frame } = await recorder('vertical', 'en');
  const beat = Object.fromEntries(info.beats.map((b) => [b.id, b]));
  assert.equal(beat.a1.at, 1600); assert.equal(beat.a1.end, 4600); assert.equal(beat.t1.at, 4800); assert.equal(beat.r1.at, 7000);
  assert.equal(beat.spam.at, 11200); assert.equal(beat.ban.at, 11800);
  assert.ok(beat.d1.end - beat.d1.at > 4000, 'duel has its simulated length');
  assert.ok(info.durationMs >= beat.d1.end + 1300, 'the outro follows the duel');
  assert.deepEqual(info.cues.map((c) => [c.kind, c.src, c.at, c.end]), [['alert', 'kit:chime', 1800, 4600], ['sfx', 'kit:pop', 11200, null], ['sfx', 'kit:thud', 11800, null]], 'sound cues');
  const q = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
  const visible = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).visibility === 'visible'; }, sel);
  const scale = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.df-camera')).transform).a);

  await frame(600);
  assert.ok((await q('.df-card[data-kind="intro"]'))?.includes('Check intro'), 'intro card');
  assert.equal(await visible('app-demo-alert'), false, 'alert hidden before its time');
  await frame(1500);
  assert.match(await q('[data-line="m1"]'), /viewer_one: ?hello there/, 'chat line');
  await frame(2800);
  assert.equal(await visible('app-demo-alert'), true, 'alert on screen');
  assert.ok((await q('app-demo-alert'))?.includes('viewer_two'), 'alert shows the user');
  assert.ok((await q('app-demo-alert'))?.includes('subscribed for 6 months'), 'alert message with amount');
  assert.ok((await scale()) > 1.5, 'camera zoomed on the alert');
  assert.ok((await q('.df-caption'))?.includes('An alert, live'), 'caption');
  await frame(3200);
  assert.ok((await q('[data-line="m1"]'))?.includes('<message deleted>'), 'deleted message');
  await frame(5400);
  assert.equal(await visible('app-demo-alert'), false, 'alert gone after its time');
  assert.equal(await scale(), 1, 'camera back to the full stream');
  assert.ok((await q('.speech-text'))?.includes('read this out loud'), 'TTS card');
  await frame(9000);
  assert.equal(await visible('.df-roulette'), true, 'roulette on screen');
  await frame(11500);
  assert.ok((await page.locator('[data-line="spam"] .ln__first').count()) === 1, 'first-time chatter label');
  assert.ok((await page.locator('.ln__ring').count()) === 1, 'highlight ring');
  await frame(12200);
  assert.ok((await q('[data-line="spam"]'))?.includes('<message deleted>'), 'ban removes the message');
  assert.ok((await q('[data-line="ban"]'))?.includes('promo_bot_9 has been permanently banned.'), 'ban notice');
  await frame(beat.d1.at + 3000);
  assert.equal(await visible('.df-duel'), true, 'duel on screen');
  await frame(info.durationMs - 900); // the outro ends 500 ms before the video (tail)
  assert.ok((await q('.df-card[data-kind="outro"]'))?.includes('domdimabot.com'), 'outro card');
  assert.deepEqual(await page.evaluate(() => window.__demoPlays), [], 'no page audio');
  const bad = await page.evaluate(() => window.__dimaDemo.load({ id: 'x', v: 1, beats: [{ do: 'nope' }] }, { format: 'vertical', lang: 'en' }));
  assert.equal(bad.ok, false, 'invalid scenes are rejected');
  await ctx.close();
}

// Spanish copy + landscape layout.
{
  const { ctx, page, frame } = await recorder('landscape', 'es');
  await frame(12200);
  const notice = await page.evaluate(() => document.querySelector('[data-line="ban"]')?.textContent?.trim());
  assert.equal(notice, 'promo_bot_9 fue baneado permanentemente.', 'Spanish ban notice');
  assert.ok((await page.evaluate(() => document.querySelector('[data-line="m1"]')?.textContent))?.includes('<mensaje eliminado>'), 'Spanish deleted message');
  await ctx.close();
}

// Two separate renders give the same bytes (alert entrance, roulette spin, ban, duel).
const TIMES = [1700, 1733, 2000, 2400, 3300, 7700, 8500, 9900, 11833, 12900, 14000, 15500];
const digests = [];
for (let run = 0; run < 2; run++) {
  const { ctx, frame, shot } = await recorder('landscape', 'en');
  const list = [];
  for (const t of TIMES) { await frame(t); list.push(await shot()); }
  digests.push(list);
  await ctx.close();
}
TIMES.forEach((t, i) => assert.equal(digests[0][i], digests[1][i], `frame at ${t} ms differs between two renders`));
assert.equal(new Set(digests[0]).size, TIMES.length, 'frames change over time');

await browser.close();
assert.deepEqual(attempts, [], 'the player must not reach the API, analytics or websockets');
assert.deepEqual(errors, [], 'page errors');
if (shots) await writeFile(`${shots}/demo-player.json`, JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000) }));
console.log(`demo-player OK (${Math.round((Date.now() - started) / 1000)} s)`);
