// Mock-only behavior check for the Claude 3D duel entry. Production API/telemetry requests are intercepted.
// SAAS_PREVIEW_URL=http://127.0.0.1:4251 node <this file>
// The release tool stops checks after 300 s, so it runs the core set. DUEL_CHECK=full adds every studio
// move, every beat screenshot and every layout; run it against the same candidate bundle served on loopback.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright'), AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-claude-3d-verified'; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [], CANVAS = '[data-testid=duel-claude-3d-canvas]';
// Heavy software-GL frames starve requestAnimationFrame, so every wait polls on an interval.
const poll = { timeout: 90000, polling: 200 };
const full = process.env.DUEL_CHECK === 'full';

async function fixture(width = 1280, theme = 'dark', language = 'en', reducedMotion = 'no-preference', query = '') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion });
  await context.addInitScript(({ theme, language }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language); }, { theme, language });
  await context.route('**/api.domdimabot.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
  await context.route('**/tadd.domdimabot.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/mocks/dev/duel' + query);
  if (!query.includes('overlay')) { await page.getByTestId('renderer-svg').waitFor(); await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme, poll); }
  return { page, context };
}
const data = (page, key) => page.$eval(CANVAS, (c, key) => c.dataset[key], key);
async function ready(page) { await page.locator(CANVAS).waitFor({ timeout: 90000 }); await page.waitForFunction(c => Number(document.querySelector(c)?.dataset.frames) > 0, CANVAS, poll); }
async function open3d(page) { await page.getByTestId('renderer-3d').click(); await page.getByTestId('entry-claude').click(); await ready(page); }
async function seek(page, time) {
  await page.getByTestId('duel-scrub').evaluate((input, time) => { input.value = String(time); input.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(([c, time]) => Number(document.querySelector(c)?.dataset.elapsed) === time, [CANVAS, time], poll);
}
/** HUD-only seek: waits for the DOM clock, not for a (slow, software-rendered) WebGL frame. */
async function seekHud(page, time) {
  await page.getByTestId('duel-scrub').evaluate((input, time) => { input.value = String(time); input.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(time => document.querySelector('.playback .time')?.textContent?.startsWith((time / 1000).toFixed(1)), time, poll);
}
async function pause(page) { const button = page.getByRole('button', { name: 'Pause', exact: true }); await button.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.playback button')].some(b => b.textContent.trim() === 'Pause' && !b.disabled), null, poll); await button.click(); await page.getByRole('button', { name: 'Resume', exact: true }).waitFor(); }
async function shot(page, name) { await page.evaluate(() => window.scrollTo(0, 0)); const box = await page.locator('.stage-frame').boundingBox(); await page.screenshot({ path: `${shots}/${name}.png`, clip: box, timeout: 120000 }); }
async function clean(page) {
  const result = await new AxeBuilder({ page }).include('.duel-studio').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
}
/** Mean brightness and share of near-black pixels of the arena canvas. */
async function frameStats(page) {
  const buffer = await page.screenshot({ clip: await page.locator(CANVAS).boundingBox(), timeout: 120000 });
  return page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0, black = 0;
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; if (l < 4) black++; }
    return { mean: sum / (d.length / 4), black: black / (d.length / 4) };
  }, buffer.toString('base64'));
}
const hp = (page, side) => page.locator(`app-duel-claude-3d-arena .fighter-hud[data-side=${side}] [role=progressbar]`).getAttribute('aria-valuenow');

const started = Date.now();
try {
  const { page, context } = await fixture(700);
  assert.equal(await page.locator('app-duel-claude-3d-arena').count(), 0, 'SVG stays the default renderer');
  await open3d(page);
  assert.equal(await data(page, 'renderer'), 'claude'); assert.equal(await data(page, 'fpsCap'), '30');
  assert.equal(await page.getByTestId('claude-3d-section').count(), 1, 'Claude has its own lab controls');
  const [w] = (await data(page, 'resolution')).split('×').map(Number), css = await page.$eval(CANVAS, c => c.clientWidth); assert(w >= css * 1.3, `supersampled canvas (${w}px for ${css} CSS px)`);
  await shot(page, 'arena-ready');
  const intervals = JSON.parse(await page.waitForFunction(c => document.querySelector(c)?.dataset.frameIntervals, CANVAS, poll).then(h => h.jsonValue()));
  assert(Math.min(...intervals) >= 32.9, `no burst frames above 30 FPS (${Math.min(...intervals)} ms)`);
  console.log(`PASS 30 FPS ceiling, shortest interval ${Math.min(...intervals).toFixed(1)} ms`);

  // Black-flash regression: a NaN pixel must not be smeared over the frame by bloom.
  await page.evaluate(() => window.scrollTo(0, 0));
  const baseline = await frameStats(page), probeFrames = Number(await data(page, 'frames'));
  await page.$eval(CANVAS, c => { c.dataset.nanProbe = '1'; });
  await page.waitForFunction(([c, f]) => Number(document.querySelector(c)?.dataset.frames) > f + 1, [CANVAS, probeFrames], poll);
  const probed = await frameStats(page); await page.$eval(CANVAS, c => { delete c.dataset.nanProbe; });
  assert(probed.black < baseline.black + .03 && probed.mean > baseline.mean * .85, `NaN pixel stays contained (${JSON.stringify({ baseline, probed })})`);
  console.log(`PASS NaN containment: mean ${baseline.mean.toFixed(1)} → ${probed.mean.toFixed(1)}, black ${(probed.black * 100).toFixed(1)}%`);

  // GPU lifecycle: switching entries destroys the renderer and stops its loop.
  const detached = await page.locator(CANVAS).elementHandle();
  await page.getByTestId('entry-gpt').click(); await page.getByTestId('duel-gpt-canvas').waitFor({ timeout: 90000 });
  assert.equal(await page.locator('app-duel-claude-3d-arena').count(), 0);
  const frozen = await detached.evaluate(c => c.dataset.frames); await page.waitForTimeout(300);
  assert.equal(await detached.evaluate(c => c.dataset.frames), frozen, 'destroyed renderer stops drawing');
  await page.getByTestId('entry-claude').click(); await ready(page);
  console.log('PASS entry switching releases the WebGL renderer');

  // Each finisher: charge beat, lethal contact, finisher-specific state, pause, winner and resume.
  const signatures = {
    knight: async () => { assert.equal(await data(page, 'visible'), '1,0', 'victim is evaporated'); await seek(page, 8300); assert.equal(await data(page, 'avatar'), '1', 'spectral avatar rises'); if (full) await shot(page, 'ultimate-knight-avatar'); await seek(page, 9470); },
    mage: async () => { await seek(page, 8650); assert(Number(await data(page, 'lens')) > .01, 'gravitational lensing is active'); await seek(page, 9470); },
    ronin: async () => { await seek(page, 8000); assert(Number(await data(page, 'ink')) > .5, 'blood moon ink grade'); assert.equal(await data(page, 'visible'), '0,1', 'ronin has vanished mid time-stop'); await seek(page, 9470); assert.equal(await data(page, 'halves'), '2', 'victim is sliced in two'); },
  };
  for (const character of ['knight', 'mage', 'ronin']) {
    await page.getByTestId('ultimate-' + character).click(); await pause(page);
    await seek(page, 8000); assert.equal(await data(page, 'ultimate'), character); if (full) await shot(page, `ultimate-${character}-charge`);
    assert.equal(await page.locator('.ultimate-caption').count(), 1, 'ultimate title card');
    await seek(page, 9470); assert.equal(await data(page, 'ultimate'), character); assert.equal(await hp(page, 'right'), '0');
    await signatures[character](); await shot(page, `ultimate-${character}-impact`);
    const frames = await data(page, 'frames'); await page.waitForTimeout(400); assert.equal(await data(page, 'frames'), frames, 'pause stops WebGL work');
    await seek(page, 11000); await page.locator('app-duel-claude-3d-arena .victory-cue').waitFor(); if (full) await shot(page, `ultimate-${character}-winner`);
    await seek(page, 8500); await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(c => Number(document.querySelector(c)?.dataset.elapsed) > 8550, CANVAS, poll);
    console.log(`PASS ${character}: charge, lethal impact, finisher state, pause, winner, scrub back and resume`);
  }

  // Ordinary combat: blade trail, hit numbers, dodge + combo heal, class heal, guard break and KO.
  await page.getByTestId('claude-combat').click(); await pause(page);
  await seek(page, 3960); assert.equal(await data(page, 'trail'), '1', 'blade smear follows the swing'); await shot(page, 'combat-slash');
  await seek(page, 4000); assert.equal(await page.locator('app-duel-claude-3d-arena .hit-number').textContent().then(t => t.trim()), '−12');
  await seek(page, 5900); assert(await page.locator('app-duel-claude-3d-arena .hit-number.block').count() === 1, 'defended hit shows the class defense');
  await seek(page, 6300); assert(await page.locator('app-duel-claude-3d-arena .hit-number.combo').count() === 1, 'combo heal');
  await seek(page, 8000); assert.equal(await page.locator('app-duel-claude-3d-arena .hit-number.heal').textContent().then(t => t.trim()), '+4');
  await seek(page, 9450); assert(await page.locator('app-duel-claude-3d-arena .badge').count() >= 1, 'guard break badge'); await shot(page, 'combat-guard-break');
  await seek(page, 12900); await page.locator('app-duel-claude-3d-arena .knockout-cue').waitFor(); await shot(page, 'combat-knockout');
  console.log('PASS combat: trail, damage, block, combo heal, heal, guard break, knockout');

  // Move studio: every move for every class plays with live contact feedback.
  for (const character of ['knight', 'mage', 'ronin']) {
    await page.getByTestId('claude-class-' + character).click();
    // Core: each class's special plus the knight's block. Full: all 18 moves.
    for (const move of full ? ['normal', 'heavy', 'special', 'heal', 'defend', 'break'] : character === 'knight' ? ['special', 'defend'] : ['special']) {
      await page.getByTestId('claude-move-' + move).click(); await pause(page);
      const hitAt = { normal: 5830, heavy: 6000, special: 6400, heal: 6450, defend: 6000, break: 6400 }[move];
      if (move === 'special' || full) { await seek(page, hitAt + 60); await shot(page, `move-${character}-${move}`); } else await seekHud(page, hitAt + 60);
      await page.locator('app-duel-claude-3d-arena .hit-number').first().waitFor({ timeout: 30000 });
      assert.equal(await page.locator('app-duel-claude-3d-arena .hit-number').count(), 1, `${character} ${move} lands`);
    }
    console.log(`PASS move studio: ${character}`);
  }
  const fighters = await data(page, 'fighters'); await page.getByTestId('claude-mirror').click();
  await page.waitForFunction(([c, f]) => document.querySelector(c)?.dataset.fighters === f.split(',').reverse().join(','), [CANVAS, fighters], poll);
  console.log('PASS mirror swaps the fighters');

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Transparent background', exact: true }).click(); await page.locator('.claude-arena.transparent').waitFor();
  await shot(page, 'transparent');
  await page.getByRole('button', { name: 'Transparent background', exact: true }).click();
  await clean(page); await context.close();

  // Fresh contexts for layout, overlay and reduced motion (the main run already covers 700px dark EN).
  for (const spec of full ? [[320, 'dark', 'en'], [390, 'dark', 'en'], [390, 'light', 'es'], [1280, 'dark', 'en'], [1280, 'light', 'en']] : [[390, 'light', 'es'], [1280, 'dark', 'en']]) {
    const [width, theme, language] = spec;
    const f = await fixture(width, theme, language); await open3d(f.page); await clean(f.page);
    await f.page.screenshot({ path: `${shots}/${width}-${theme}-${language}.png`, fullPage: true, timeout: 120000 });
    await f.context.close(); console.log(`PASS layout + AXE ${width}px ${theme} ${language}`);
  }
  {
    const overlay = await fixture(1280, 'dark', 'en', 'no-preference', '?renderer=3d&entry=claude&overlay=1');
    await ready(overlay.page); assert.equal(await overlay.page.getByTestId('renderer-3d').count(), 0, 'overlay mode hides the studio'); await overlay.context.close();
    console.log('PASS overlay-only mode');
  }
  {
    const reduced = await fixture(1280, 'dark', 'en', 'reduce'); await open3d(reduced.page);
    const rf = await data(reduced.page, 'frames'); await reduced.page.waitForTimeout(400); assert.equal(await data(reduced.page, 'frames'), rf, 'reduced motion stops idle animation');
    await reduced.page.emulateMedia({ reducedMotion: 'no-preference' });
    await reduced.page.waitForFunction(([c, before]) => Number(document.querySelector(c)?.dataset.frames) > Number(before), [CANVAS, rf], poll);
    await reduced.context.close(); console.log('PASS reduced motion');
  }
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log(`checked in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`PASS mock-only Claude 3D arena (${full ? 'full' : 'core'}): 30 FPS ceiling, NaN containment, GPU cleanup, three finishers, combat feedback, studio moves, mirror, transparency, overlay, responsive EN/ES themes, AXE, reduced motion`);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.log('FAILURE STATE', await page.evaluate(c => ({ canvas: { ...document.querySelector(c)?.dataset, frameIntervals: undefined }, slider: document.querySelector('[data-testid=duel-scrub]')?.value, error: document.querySelector('.webgl-error')?.textContent }), CANVAS));
    await page.screenshot({ path: shots + '/failure.png' }).catch(() => {});
  }
  console.log('errors', errors);
  throw error;
} finally { await browser.close(); }
