// Run via saas-ops verify. Provider APIs are intercepted; every battle is local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright'), AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-svg-verified'; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
async function fixture(width = 1280, theme = 'dark', language = 'en', reducedMotion = 'no-preference', query = '') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion });
  await context.addInitScript(({theme,language}) => { localStorage.setItem('theme',theme); localStorage.setItem('userLanguage',language); }, {theme,language});
  await context.route('**/api.domdimabot.com/**', r => r.fulfill({ status:200,contentType:'application/json',body:'{"data":[]}' }));
  await context.route('**/tadd.domdimabot.com/**', r => r.fulfill({ status:200,body:'{}' }));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/mocks/dev/duel' + query);
  await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
  return { page, context };
}
async function seek(page, time) {
  await page.getByTestId('duel-scrub').evaluate((e,time) => { e.value=String(time); e.dispatchEvent(new Event('input',{bubbles:true})); }, time);
  await page.waitForFunction(time => Number(document.querySelector('[data-testid=duel-svg-gpt]')?.getAttribute('data-elapsed')) === time, time);
}
async function state(page) {
  return page.getByTestId('duel-svg-gpt').evaluate(e => ({
    art:e.querySelector('svg').innerHTML,
    hp:[...e.querySelectorAll('[role=progressbar]')].map(n => Number(n.getAttribute('aria-valuenow'))),
    poses:[...e.querySelectorAll('.fighter:not(.ghost)')].map(n => ({ side:n.getAttribute('data-side'),transform:n.getAttribute('transform'),opacity:n.getAttribute('opacity'),action:n.getAttribute('data-action') })),
  }));
}
async function clean(page) {
  const a = await new AxeBuilder({page}).include('.duel-studio').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(a.violations.map(v => ({id:v.id,nodes:v.nodes.map(n => n.target)})),[]);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'no horizontal overflow');
}
try {
  const { page, context } = await fixture();
  await page.getByTestId('svg-original').waitFor();
  assert.equal(await page.getByTestId('svg-original').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('app-duel-arena').count(),1,'existing SVG remains default');
  await page.getByTestId('svg-gpt').click(); await page.getByTestId('duel-svg-gpt').waitFor();
  assert.equal(await page.locator('canvas').count(),0,'GPT SVG has no WebGL renderer');
  assert.equal(await page.locator('g[duel-svg-fighter] path').first().evaluate(n => n.namespaceURI),'http://www.w3.org/2000/svg');
  assert(await page.locator('g[duel-svg-fighter] path').count() > 45,'original illustrated rigs render');
  await page.screenshot({path:shots+'/ready-desktop.png',fullPage:true});
  await page.getByTestId('svg-claude').click(); await page.getByTestId('svg-claude-slot').waitFor();
  assert.equal(await page.locator('app-duel-svg-gpt-arena').count(),0);
  await page.getByTestId('svg-gpt').click();
  await page.getByTestId('svg-combat').click(); await page.getByRole('button',{name:'Pause',exact:true}).click();
  await seek(page,3800); const anticipation = await state(page); assert.deepEqual(anticipation.hp,[100,100]);
  await seek(page,3980); const contact = await state(page); assert.deepEqual(contact.hp,[100,88]);
  assert.notEqual(contact.poses[0].transform,anticipation.poses[0].transform,'attacker advances into contact');
  await page.locator('.stage-frame').screenshot({path:shots+'/contact.png'});
  await seek(page,4120); const recoil = await state(page); assert.notEqual(contact.poses[1].transform,recoil.poses[1].transform,'defender recoils after contact');
  await seek(page,5830); assert.deepEqual((await state(page)).hp,[78,88]);
  assert.equal((await state(page)).poses[1].action,'guard','mage raises a ward before the blocked hit');
  await seek(page,6200); assert.deepEqual((await state(page)).hp,[78,96]);
  await seek(page,7950); assert.deepEqual((await state(page)).hp,[78,100]);
  await seek(page,9400); assert.deepEqual((await state(page)).hp,[78,65],'special breaks defense');
  await seek(page,3980); assert.deepEqual(await state(page),contact,'scrubbing reconstructs the same pose, effects and HP');
  await page.waitForTimeout(250); assert.deepEqual(await state(page),contact,'paused SVG has no independent animation clocks');
  assert.equal(await page.getByTestId('duel-svg-gpt').evaluate(e => e.getAnimations({subtree:true}).length),0);
  console.log('PASS contact, recoil, block, combo heal, heal, guard break, deterministic scrub and true pause');
  for (const character of ['knight','mage','ronin']) {
    await page.getByTestId('svg-ultimate-'+character).click(); await page.getByRole('button',{name:'Pause',exact:true}).click();
    for (const mirrored of [false,true]) {
      if (mirrored) await page.getByTestId('svg-mirror').click();
      await seek(page,8650); assert.equal(await page.getByTestId('duel-svg-gpt').getAttribute('data-ultimate'),character);
      await page.locator('.stage-frame').screenshot({path:`${shots}/${character}-${mirrored?'right':'left'}-charge.png`});
      const defender = mirrored ? 0 : 1;
      await seek(page,9149); assert.equal((await state(page)).hp[defender],74);
      await seek(page,9300); assert.equal((await state(page)).hp[defender],0);
      await page.locator('.stage-frame').screenshot({path:`${shots}/${character}-${mirrored?'right':'left'}-impact.png`});
      if (character === 'ronin') assert.equal(await page.locator('.fighter[data-action=defeated] g[clip-path]').count(),2);
      await seek(page,11000); await page.locator('.victory-cue').waitFor();
      await seek(page,8650); await page.getByRole('button',{name:'Resume',exact:true}).click();
      await page.waitForFunction(() => Number(document.querySelector('[data-testid=duel-svg-gpt]')?.getAttribute('data-elapsed'))>8700);
      await page.getByRole('button',{name:'Pause',exact:true}).click();
    }
    console.log(`PASS ${character}: both sides, charge, exact lethal hit, defeat, winner, seek back and resume`);
  }
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  await page.getByRole('button',{name:'Transparent background',exact:true}).click();
  await page.locator('app-duel-svg-gpt-arena .scenery').waitFor({state:'detached'});
  assert.equal(await page.locator('app-duel-svg-gpt-arena .scenery').count(),0);
  await page.getByRole('button',{name:'Transparent background',exact:true}).click();
  await page.getByTestId('renderer-3d').click();await page.getByTestId('duel-gpt-canvas').waitFor();
  await page.getByTestId('entry-claude').click();await page.getByTestId('claude-slot').waitFor();
  await page.getByTestId('renderer-svg').click();await page.getByTestId('duel-svg-gpt').waitFor();
  await context.close();
  for (const [width,theme,language] of [[320,'dark','en'],[390,'dark','en'],[390,'light','es'],[1280,'dark','en'],[1280,'light','en']]) {
    const f = await fixture(width,theme,language); await f.page.getByTestId('svg-gpt').click(); await clean(f.page);
    await f.page.screenshot({path:`${shots}/${width}-${theme}-${language}.png`,fullPage:true});
    await f.context.close(); console.log(`PASS layout + AXE ${width}px ${theme} ${language}`);
  }
  const f = await fixture(1280,'dark','en','reduce','?renderer=svg&entry=gpt');
  await f.page.getByTestId('svg-ultimate-mage').click();await f.page.getByRole('button',{name:'Pause',exact:true}).click();await seek(f.page,8650);
  assert.equal(await f.page.locator('.svg-arena.reduce').count(),1);assert.equal(await f.page.locator('.ultimate-effects').getAttribute('opacity'),'0');
  await f.page.emulateMedia({reducedMotion:'no-preference'});await f.page.locator('.svg-arena:not(.reduce)').waitFor();
  assert.equal(await f.page.locator('.ultimate-effects').getAttribute('opacity'),'1');await f.context.close();
  const overlay = await fixture(1280,'dark','en','no-preference','?renderer=svg&entry=gpt&overlay=1');
  await overlay.page.getByTestId('duel-svg-gpt').waitFor();assert.equal(await overlay.page.getByTestId('svg-gpt').count(),0);
  await overlay.page.getByRole('button',{name:'Play duel',exact:true}).click();
  await overlay.page.waitForFunction(() => Number(document.querySelector('[data-testid=duel-svg-gpt]')?.getAttribute('data-elapsed'))>1000);await overlay.context.close();
  assert.deepEqual(errors,[]);console.log('PASS isolated GPT SVG slot, original default, Claude slots, existing 3D, all choreography, responsive themes EN/ES, reduced motion, transparency and overlay-only playback');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({path:shots+'/failure.png',fullPage:true});
  throw error;
} finally { await browser.close(); }
