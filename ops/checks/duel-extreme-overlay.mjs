// Actual OBS overlay route with a disposable Socket.IO server fixture and controlled wall clock.
// No real APIs, sockets, channel state, chat, or moderation actions are used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const evidence = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-extreme-overlay';
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const canvas = '[data-testid=duel-claude-3d-canvas]', poll = { timeout: 90000, polling: 100 };
const epoch = 1793646000000, metrics = [];
let pingTimer, heartbeatPongs = 0;
const turns = [
  { at: 3700, hitAt: 3980, attacker: 'left', move: 'normal', damage: 12, bonus: false },
  { at: 4500, hitAt: 4950, attacker: 'right', move: 'heavy', damage: 22, bonus: false },
  { at: 5550, hitAt: 5830, attacker: 'left', move: 'normal', damage: 14, bonus: false },
  { at: 6350, hitAt: 9150, attacker: 'left', move: 'ultimate', damage: 74, bonus: false },
];
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, reducedMotion: 'reduce' });
  await context.addInitScript(epoch => { window.__duelFixtureNow = epoch; Date.now = () => window.__duelFixtureNow; localStorage.setItem('theme', 'dark'); }, epoch);
  await context.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
  const state = { revision: 1, serverTime: epoch, connected: true, settings: { enabled: true, timeoutEnabled: false, timeoutSeconds: 60, language: 'en', leaderboard: true, rivalries: true, quality: 'extreme' }, challenge: null, run: null };
  let socket, namespace;
  const connected = Promise.withResolvers();
  const publish = () => { state.revision++; socket.send('42' + namespace + ',' + JSON.stringify(['duel-state', state])); };
  await context.routeWebSocket(/.*/, ws => {
    if (!ws.url().includes('api.domdimabot.com')) return ws.close();
    socket = ws; ws.send('0' + JSON.stringify({ sid: 'local-fixture', upgrades: [], pingInterval: 25000, pingTimeout: 20000 }));
    // Match the real Engine.IO heartbeat; long GPU/software-rendering checks can exceed
    // the client's 45-second timeout even while the overlay itself is healthy.
    ws.onClose(() => clearInterval(pingTimer));
    ws.onMessage(message => {
      const text = String(message);
      if (text === '3') heartbeatPongs++;
      if (text.startsWith('40/overlays/duel/')) { namespace = text.slice(2, text.indexOf(',')); ws.send('40' + namespace + ',' + JSON.stringify({ sid: 'local-fixture' })); publish(); connected.resolve(); }
    });
    ws.send('2');
    pingTimer = setInterval(() => ws.send('2'), 10000); pingTimer.unref();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/overlays/duel/991801#' + 'a'.repeat(43));
  await page.waitForFunction(() => document.body.style.background === 'transparent');
  // Wait for the namespace handshake even though the empty overlay paints no arena.
  await Promise.race([connected.promise, new Promise((_, reject) => { setTimeout(() => reject(new Error('local overlay socket did not connect')), 30000).unref(); })]);
  const data = () => page.$eval(canvas, c => ({ ...c.dataset, frameIntervals: undefined }));
  async function seek(time) {
    await page.evaluate(now => { window.__duelFixtureNow = now; }, epoch + time);
    await page.waitForFunction(([c, t]) => Number(document.querySelector(c)?.dataset.elapsed) === t, [canvas, time], poll);
  }
  for (const victim of ['knight', 'mage', 'ronin']) {
    await page.evaluate(now => { window.__duelFixtureNow = now; }, epoch);
    state.run = { id: 'ronin-vs-' + victim, challenger: 'alice', opponent: 'bob', winner: 'left', fighters: { left: 'ronin', right: victim }, enraged: victim === 'mage' ? 'right' : null, turns, mode: 'overlay', startedAt: epoch, endsAt: epoch + 11000, completedAt: null, maxHp: 100, record: { left: 4, right: 2 } };
    publish();
    // Preparation is spread across frames (bakes, compile, warm-up draws); playback waits for the queue to drain.
    await page.waitForFunction(([c, f]) => { const d = document.querySelector(c)?.dataset; return d?.fighters === f && d.shaderPrep === 'compiled' && d.prepPending === '0' && Number(d.elapsed) < 1000; }, [canvas, 'ronin,' + victim], poll);
    const prepared = await data();
    assert.equal(prepared.halvesGroups, prepared.halvesMaterialCount);
    let impactCalls;
    for (const time of [7800, 8000, 9470, 10400, 9470]) {
      await seek(time);
      const d = await data();
      assert.equal(d.halvesBakeCount, prepared.halvesBakeCount, 'actual overlay never rebuilds split geometry during playback');
      assert.equal(d.preparationCount, prepared.preparationCount);
      if (time === 9470 || time === 10400) {
        assert.equal(d.halves, '2');
        assert.equal(await page.locator('app-duel-claude-3d-arena .fighter-hud[data-side=right] [role=progressbar]').getAttribute('aria-valuenow'), '0');
        if (time === 9470) { if (impactCalls !== undefined) assert.equal(Number(d.drawCalls), impactCalls); impactCalls = Number(d.drawCalls); }
        if (time === 10400) assert.equal(d.halves, '2', 'both halves keep rendering while they fade (baked fighters fade with their per-material groups)');
        metrics.push({ victim, time, calls: Number(d.drawCalls), triangles: Number(d.triangles), materials: Number(d.halvesMaterialCount), resolution: d.resolution });
      }
    }
    await page.screenshot({ path: `${evidence}/ronin-vs-${victim}.png`, omitBackground: true, timeout: 90000 });
    assert.equal(await page.locator('.arena-edition').count(), 0, 'no lab edition label in actual overlay');
    assert.equal(await page.locator('.arena-bottom b').count(), 0, 'no performance counters in actual overlay');
    console.log('PASS actual transparent OBS overlay: ronin vs', victim, '(preparation, impact, fade, backward seek)');
  }
  // Disconnect removes the renderer and the stream remains transparent.
  assert(heartbeatPongs > 0, 'fixture and browser exchange real protocol heartbeats');
  socket.close();
  await page.locator('app-duel-claude-3d-arena').waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(await page.evaluate(() => document.body.style.background), 'transparent');
  assert.deepEqual(errors, []);
  writeFileSync(evidence + '/metrics.json', JSON.stringify(metrics, null, 2));
  console.log('PASS overlay heartbeat and disconnect dispose the renderer without browser errors');
} finally { clearInterval(pingTimer); await browser.close(); }
