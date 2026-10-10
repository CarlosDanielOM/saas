// Run via saas-ops verify. Provider APIs are intercepted; every battle is local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright'), AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-svg-claude-verified'; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const arena = '[data-testid=duel-svg-claude]';
async function fixture(width = 1280, theme = 'dark', language = 'en', reducedMotion = 'no-preference', query = '?renderer=svg&entry=claude') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion });
  await context.addInitScript(({ theme, language }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language); }, { theme, language });
  await context.route('**/api.domdimabot.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
  await context.route('**/tadd.domdimabot.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/mocks/dev/duel' + query);
  await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
  return { page, context };
}
const pause = page => page.getByRole('button', { name: 'Pause', exact: true }).click();
async function seek(page, time) {
  await page.getByTestId('duel-scrub').evaluate((e, time) => { e.value = String(time); e.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(({ arena, time }) => Number(document.querySelector(arena)?.getAttribute('data-elapsed')) === time, { arena, time });
}
const hp = page => page.locator(`${arena} [role=progressbar]`).evaluateAll(bars => bars.map(n => Number(n.getAttribute('aria-valuenow'))));
/** Clocks of the battle-driven layers (the ambient scenery loops on its own): identical lists mean an identical frame. */
const clocks = page => page.locator(arena).evaluate(e => [...e.querySelectorAll(':scope > .camera, :scope > .cinema, :scope > .center-cue')].flatMap(n => n.getAnimations({ subtree: true })).map(a => `${a.animationName}@${Math.round(Number(a.currentTime))}`).sort());
const sync = (page, side) => page.locator(`${arena} .fighter-slot[data-side=${side}] .fighter-motion`).evaluate(e => e.style.getPropertyValue('--sync'));
const action = (page, side) => page.locator(`${arena} app-duel-claude-fighter`).nth(side === 'left' ? 0 : 1).getAttribute('data-action');
async function clean(page) {
  const a = await new AxeBuilder({ page }).include('.duel-studio').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(a.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
}
try {
  const { page, context } = await fixture(1280, 'dark', 'en', 'no-preference', '');
  await page.getByTestId('svg-original').waitFor();
  assert.equal(await page.getByTestId('svg-original').getAttribute('aria-pressed'), 'true', 'original SVG stays the default');
  assert.equal(await page.locator('app-duel-arena').count(), 1);
  await page.getByTestId('svg-gpt').click(); await page.getByTestId('duel-svg-gpt').waitFor();
  await page.getByTestId('svg-claude').click(); await page.locator(arena).waitFor();
  assert.equal(await page.locator('app-duel-svg-gpt-arena, app-duel-arena, canvas').count(), 0, 'Claude entry replaces the other arenas and uses no WebGL');
  assert.equal(await page.getByTestId('svg-claude-section').count(), 1, 'Claude entry has its own lab panel');
  assert(await page.locator(`${arena} app-duel-claude-fighter path`).count() > 60, 'detailed vector rigs render');
  const ids = await page.locator(`${arena} app-duel-claude-fighter linearGradient`).evaluateAll(n => n.map(g => g.id));
  assert.equal(new Set(ids).size, ids.length, 'gradient ids are unique per fighter');
  await page.locator('.stage-frame').screenshot({ path: shots + '/ready.png' });

  // Combat fixture: exact contact timing, HP, block, combo heal, heal and guard break.
  await page.getByTestId('svg-combat').click(); await pause(page);
  await seek(page, 3800); assert.deepEqual(await hp(page), [100, 100]);
  assert.equal(await action(page, 'left'), 'attack');
  await seek(page, 3980); assert.deepEqual(await hp(page), [100, 88]);
  assert.equal(await sync(page, 'left'), '280ms', 'the attack pose starts 280 ms into its timeline');
  assert.equal(await action(page, 'right'), 'hit');
  assert.equal(await page.locator(`${arena} .impact-fx .burst`).count(), 1, 'contact burst');
  assert.equal(await page.locator('.center-cue .fight-cue').count(), 0, 'FIGHT! is gone before the first contact');
  const contact = await clocks(page);
  assert(contact.length > 20, 'contact frame is driven by CSS animations');
  await page.waitForTimeout(300); assert.deepEqual(await clocks(page), contact, 'paused frame does not move');
  await seek(page, 5000); await seek(page, 3980); assert.deepEqual(await clocks(page), contact, 'seeking back rebuilds the identical frame');
  await page.locator('.stage-frame').screenshot({ path: shots + '/contact.png' });
  await seek(page, 5830); assert.deepEqual(await hp(page), [78, 88]);
  assert.equal(await action(page, 'right'), 'defend', 'the mage raises a ward before the blocked hit');
  await seek(page, 6200); assert.deepEqual(await hp(page), [78, 96], 'combo heal');
  await seek(page, 7950); assert.deepEqual(await hp(page), [78, 100], 'heal');
  await seek(page, 9400); assert.deepEqual(await hp(page), [78, 65], 'special breaks the ward');
  assert.equal(await page.locator(`${arena} .shatter i`).count(), 12);
  console.log('PASS contact, block, combo heal, heal, guard break, exact pause and seek');

  // Move studio: every class, every move, both directions.
  for (const character of ['knight', 'mage', 'ronin']) {
    await page.getByTestId('svg-class-' + character).click();
    for (const move of ['normal', 'heavy', 'special', 'heal', 'defend', 'break']) {
      await page.getByTestId('svg-move-' + move).click(); await pause(page);
      const hit = 5550 + ({ normal: 280, heavy: 450, special: 850, heal: 900, defend: 450, break: 850 })[move];
      for (const mirrored of [false, true]) {
        if (mirrored) await page.getByTestId('svg-mirror').click();
        await seek(page, hit - 40);
        assert.deepEqual(await hp(page), mirrored ? [78, 72] : [72, 78]);
        const self = mirrored ? 'right' : 'left';
        if (move === 'defend' || move === 'break') assert.equal(await action(page, self), 'defend', `${character} defends`);
        else assert.equal(await action(page, self), move === 'heal' ? 'heal' : 'attack');
        if (character === 'mage' && ['normal', 'heavy'].includes(move)) assert.equal(await page.locator(`${arena} .bolt`).count(), move === 'heavy' ? 3 : 1);
        if (character === 'mage' && move === 'special') assert.equal(await page.locator(`${arena} .meteor`).count(), 1);
        if (character === 'knight' && move === 'special') assert.equal(await page.locator(`${arena} .pillar`).count(), 1);
        if (character === 'ronin' && move === 'special') assert.equal(await page.locator(`${arena} .crescent`).count(), 1);
        await seek(page, hit + 90);
        const expected = move === 'heal' ? [100, 78] : move === 'defend' ? [67, 78] : move === 'break' ? [36, 78] : [72, 78 - ({ normal: 14, heavy: 26, special: 36 })[move]];
        assert.deepEqual(await hp(page), mirrored ? [...expected].reverse() : expected);
        if (move === 'heal') assert.equal(await page.locator(`${arena} .heal-fx`).getAttribute('data-character'), character);
        if (move === 'break') assert.equal(await page.locator(`${arena} .broken-label`).count(), 1);
        const frame = await clocks(page); await page.waitForTimeout(80); assert.deepEqual(await clocks(page), frame, 'move frame holds while paused');
        if (!mirrored) await page.locator('.stage-frame').screenshot({ path: `${shots}/${character}-${move}.png` });
        if (move === 'defend') { await seek(page, hit + 400); assert.deepEqual(await hp(page), mirrored ? [78, 81] : [81, 78], 'combo heal after the block'); }
      }
    }
    console.log(`PASS ${character}: six moves, both directions, effects, HP and paused frames`);
  }

  // Ultimates: both sides, cinematic layers, exact lethal hit, defeat, winner.
  const layers = { knight: ['.colossus', '.holy-sword', '.sigil'], mage: ['.black-hole:not(.front-layer)', '.black-hole.front-layer', '.warp'], ronin: ['.blood-moon', '.cuts', '.eye-glint'] };
  for (const character of ['knight', 'mage', 'ronin']) {
    await page.getByTestId('svg-ultimate-' + character).click(); await pause(page);
    for (const mirrored of [false, true]) {
      if (mirrored) await page.getByTestId('svg-mirror').click();
      const defender = mirrored ? 0 : 1;
      await seek(page, 7000);
      assert.equal(await page.locator(arena).getAttribute('data-ultimate'), character);
      assert.equal(await page.locator(`${arena} .cut-in`).count(), 1, 'cut-in band');
      for (const layer of layers[character]) assert.equal(await page.locator(`${arena} .ultimate-stage.world ${layer}`).count(), 1, `${character} ${layer}`);
      if (character === 'ronin') assert.equal(await page.locator(`${arena} .cuts svg`).count(), 12);
      await seek(page, 8650); await page.locator('.stage-frame').screenshot({ path: `${shots}/${character}-${mirrored ? 'right' : 'left'}-charge.png` });
      assert(Number(await page.locator(`${arena} .hud`).evaluate(e => getComputedStyle(e).opacity)) < .3, 'HUD steps back for the cinematic');
      await seek(page, 9149); assert.equal((await hp(page))[defender], 74);
      await seek(page, 9300); assert.equal((await hp(page))[defender], 0);
      assert.equal(await page.locator('.center-cue .ko').count(), 0, 'ultimates show their own result instead of K.O.');
      assert.equal(await page.locator(`${arena} .ult-result`).count(), 1);
      if (character === 'ronin') assert.equal(await page.locator(`${arena} .half`).count(), 2, 'the target is cut in two');
      await seek(page, 9700); await page.locator('.stage-frame').screenshot({ path: `${shots}/${character}-${mirrored ? 'right' : 'left'}-impact.png` });
      await seek(page, 10900); await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.locator(`${arena} .winner-reveal`).waitFor();
      await page.waitForFunction(arena => Number(getComputedStyle(document.querySelector(arena + ' .winner-reveal')).opacity) > .99, arena);
      await seek(page, 8650); await pause(page);
    }
    console.log(`PASS ${character} ultimate: both sides, cinematic layers, lethal hit, result and winner`);
  }
  // A normal final blow still shows K.O.
  await page.getByTestId('svg-class-knight').click(); await page.getByTestId('svg-move-normal').click(); await pause(page);
  await page.getByTestId('duel-scrub').evaluate(e => { e.value = String(Number(e.max) - 1500); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('.center-cue .ko').waitFor();
  console.log('PASS K.O. cue on a regular final blow');

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Transparent background', exact: true }).click();
  await page.locator(`${arena} .scenery`).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Transparent background', exact: true }).click();
  await page.getByTestId('renderer-3d').click(); await page.getByTestId('duel-gpt-canvas').waitFor();
  await page.getByTestId('renderer-svg').click(); await page.locator(arena).waitFor();
  await context.close();

  for (const [width, theme, language] of [[320, 'dark', 'en'], [390, 'dark', 'en'], [390, 'light', 'es'], [1280, 'dark', 'en'], [1280, 'light', 'en'], [1280, 'dark', 'es']]) {
    const f = await fixture(width, theme, language); await f.page.locator(arena).waitFor(); await clean(f.page);
    await f.page.screenshot({ path: `${shots}/${width}-${theme}-${language}.png`, fullPage: true });
    await f.context.close(); console.log(`PASS layout + AXE ${width}px ${theme} ${language}`);
  }
  const reduced = await fixture(1280, 'dark', 'en', 'reduce');
  await reduced.page.getByTestId('svg-ultimate-mage').click(); await pause(reduced.page); await seek(reduced.page, 8650);
  assert.equal(await reduced.page.locator(`${arena}.reduce`).count(), 1);
  assert.equal(await reduced.page.locator(arena).evaluate(e => e.getAnimations({ subtree: true }).length), 0, 'reduced motion runs no animations');
  assert.equal(await reduced.page.locator(`${arena} .black-hole`).first().evaluate(e => getComputedStyle(e).display), 'none');
  assert.equal(await reduced.page.locator(`${arena} .camera`).evaluate(e => e.style.transform), 'none');
  await reduced.context.close();
  const overlay = await fixture(1280, 'dark', 'en', 'no-preference', '?renderer=svg&entry=claude&overlay=1');
  await overlay.page.locator(arena).waitFor(); assert.equal(await overlay.page.getByTestId('svg-claude').count(), 0);
  await overlay.page.getByRole('button', { name: 'Play duel', exact: true }).click();
  await overlay.page.waitForFunction(arena => Number(document.querySelector(arena)?.getAttribute('data-elapsed')) > 1000, arena);
  await overlay.context.close();
  assert.deepEqual(errors, []);
  console.log('PASS Claude SVG entry: original default, all choreography, ultimates, responsive themes EN/ES, reduced motion, transparency and overlay-only playback');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: shots + '/failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
