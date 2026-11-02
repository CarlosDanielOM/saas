// Fidelity-preserving Extreme duel regression check. Uses local showcase fixtures only;
// all external HTTP/WebSocket requests are blocked. No live channel/API is modified.
// SAAS_PREVIEW_URL=http://127.0.0.1:4264 node ops/checks/duel-extreme-efficiency.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const evidence = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-extreme-efficiency';
mkdirSync(evidence, { recursive: true });
const canvas = '[data-testid=duel-claude-3d-canvas]';
const poll = { timeout: 90000, polling: 100 };
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const errors = [], results = [];
async function fixture(width = 700, theme = 'dark') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript(theme => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); }, theme);
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/mocks/dev/duel?renderer=3d&entry=claude');
  await page.waitForFunction(c => Number(document.querySelector(c)?.dataset.frames) > 0, canvas, poll);
  return { page, context };
}
const data = page => page.$eval(canvas, c => ({ ...c.dataset, frameIntervals: undefined }));
async function seek(page, time) {
  await page.getByTestId('duel-scrub').evaluate((input, time) => { input.value = String(time); input.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(([c, t]) => Number(document.querySelector(c)?.dataset.elapsed) === t, [canvas, time], poll);
}
async function showcase(page, character) {
  const before = await data(page);
  await page.getByTestId('ultimate-' + character).evaluate(button => button.click());
  await page.getByRole('button', { name: 'Pause', exact: true }).evaluate(button => button.click());
  await page.waitForFunction(([c, before]) => Number(document.querySelector(c)?.dataset.preparationCount) > Number(before), [canvas, before.preparationCount], poll);
  return data(page);
}
async function shot(page, name) {
  await page.locator(canvas).screenshot({ path: `${evidence}/${name}.png`, animations: 'disabled', timeout: 90000 });
}
try {
  const { page, context } = await fixture();
  let snapshot = await data(page);
  assert.equal(snapshot.fpsCap, '30');
  assert.equal(snapshot.shaderPrep, 'compiled', 'ultimate shaders are submitted before combat');
  const dimensions = await page.$eval(canvas, c => ({ width: c.width, css: c.clientWidth }));
  assert(dimensions.width >= dimensions.css * 1.3, 'existing supersampling is preserved');
  for (const character of ['knight', 'mage', 'ronin']) {
    const previousBakes = Number(snapshot.halvesBakeCount);
    snapshot = await showcase(page, character);
    const bakes = Number(snapshot.halvesBakeCount), preparation = snapshot.preparationCount;
    assert.equal(bakes, previousBakes + (character === 'ronin' ? 1 : 0), `${character}: split geometry is prepared once before the ultimate`);
    assert.equal(snapshot.shaderPrep, 'compiled');
    if (character === 'ronin') {
      assert(Number(snapshot.halvesMaterialCount) > 0, 'split retains its materials');
      assert.equal(snapshot.halvesGroups, snapshot.halvesMaterialCount, 'one draw group per distinct material');
    }
    let impactCalls;
    for (const time of [7800, 8000, character === 'knight' ? 8300 : 8650, 9470, 10400, 7800, 9470]) {
      await seek(page, time);
      const frame = await data(page);
      assert.equal(frame.ultimate, character);
      assert.equal(frame.preparationCount, preparation, 'scrubbing and attacks reuse prepared geometry');
      assert.equal(Number(frame.halvesBakeCount), bakes, 'no split baking during ultimate playback');
      if (character === 'ronin' && time === 10400) assert(Number(frame.drawCalls) > impactCalls, 'transparent fade retains the original draw order');
      if (time === 9470) {
        if (impactCalls !== undefined) assert.equal(Number(frame.drawCalls), impactCalls, 'backward seeking restores opaque batching');
        impactCalls = Number(frame.drawCalls);
        assert.equal(await page.locator('app-duel-claude-3d-arena .fighter-hud[data-side=right] [role=progressbar]').getAttribute('aria-valuenow'), '0');
        if (character === 'ronin') assert.equal(frame.halves, '2', 'both detailed split halves render');
        results.push({ character, time, drawCalls: Number(frame.drawCalls), triangles: Number(frame.triangles), resolution: frame.resolution, preparationMs: Number(frame.preparationMs), halvesMaterials: Number(frame.halvesMaterialCount) });
      }
    }
    await shot(page, character + '-impact');
    await seek(page, 11000);
    await page.locator('app-duel-claude-3d-arena .victory-cue').waitFor();
    console.log('PASS', character, 'preparation, charge, impact, fade, scrubbing and winner');
  }
  // A mirrored ronin uses the same batching with the opposite stage transform.
  await page.getByTestId('claude-mirror').evaluate(button => button.click());
  await seek(page, 9470);
  await page.waitForFunction(c => document.querySelector(c)?.dataset.fighters === 'knight,ronin', canvas, poll);
  assert.equal((await data(page)).halves, '2');
  await shot(page, 'ronin-mirrored');
  const beforeTransparent = await data(page);
  await page.getByRole('button', { name: 'Transparent background', exact: true }).evaluate(button => button.click());
  await page.locator('.claude-arena.transparent').waitFor();
  await page.waitForFunction(([c, n]) => Number(document.querySelector(c)?.dataset.frames) > Number(n), [canvas, beforeTransparent.frames], poll);
  const transparent = await data(page);
  assert.equal(transparent.halvesBakeCount, beforeTransparent.halvesBakeCount, 'transparent rendering reuses split geometry');
  assert.equal(transparent.shaderPrep, 'compiled');
  await shot(page, 'ronin-transparent');
  const paused = transparent.frames;
  await page.waitForTimeout(180);
  assert.equal((await data(page)).frames, paused, 'paused/reduced-motion scene does not spin');
  await page.getByRole('button', { name: 'Resume', exact: true }).evaluate(button => button.click());
  await page.waitForFunction(c => Number(document.querySelector(c)?.dataset.elapsed) > 9500, canvas, poll);
  // Releasing the renderer also stops drawing into its detached canvas.
  const detached = await page.locator(canvas).elementHandle();
  await page.getByTestId('renderer-svg').evaluate(button => button.click());
  await page.locator('app-duel-claude-3d-arena').waitFor({ state: 'detached' });
  const stopped = await detached.evaluate(c => c.dataset.frames);
  await page.waitForTimeout(180);
  assert.equal(await detached.evaluate(c => c.dataset.frames), stopped);
  await context.close();
  console.log('PASS mirrored victim, transparency, pause/resume and renderer disposal');
  if (process.env.DUEL_LAYOUT === '1') {
    for (const [width, theme] of [[320, 'dark'], [390, 'dark'], [390, 'light'], [1280, 'dark'], [1280, 'light']]) {
      const f = await fixture(width, theme);
      assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await f.page.screenshot({ path: `${evidence}/layout-${width}-${theme}.png`, fullPage: true, timeout: 90000 });
      await f.context.close();
      console.log('PASS layout', width, theme);
    }
  }
  assert.deepEqual(errors, [], 'no browser exceptions');
  writeFileSync(evidence + '/metrics.json', JSON.stringify(results, null, 2));
  console.log('PASS Extreme duel efficiency without lowering resolution, geometry or effects');
} finally { await browser.close(); }
