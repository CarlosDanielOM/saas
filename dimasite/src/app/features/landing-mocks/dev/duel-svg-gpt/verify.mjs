// Run via saas-ops verify. Provider APIs are intercepted; every battle is local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright'), AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-svg-combat-verified'; mkdirSync(shots, { recursive: true });
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
  await page.getByTestId('svg-claude').click(); await page.getByTestId('duel-svg-claude').waitFor();
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
    await page.getByTestId('svg-class-'+character).click();
    for (const move of ['normal','heavy','special','heal','defend','break']) {
      await page.getByTestId('svg-move-'+move).click();
      await page.getByRole('button',{name:'Pause',exact:true}).click();
      const hit = 5550 + ({normal:280,heavy:450,special:850,heal:900,defend:450,break:850})[move];
      for (const mirrored of [false,true]) {
        if (mirrored) await page.getByTestId('svg-mirror').click();
        await seek(page,hit-40);
        const before = await state(page); assert.deepEqual(before.hp,mirrored?[78,72]:[72,78]);
        if (move==='defend' || move==='break') {
          const defense = character==='ronin' ? '[data-effect=ronin-evade]' : '[data-effect=defense]';
          assert.equal(await page.locator(defense).count(),1,character+' prepares defense');
        }
        if (character==='mage' && ['normal','heavy','special'].includes(move)) {
          const projectile=page.locator('[data-effect=mage-projectile]');
          assert.equal(await projectile.locator('path').first().evaluate(e=>e.namespaceURI),'http://www.w3.org/2000/svg');
          assert(Number(await projectile.getAttribute('opacity'))>0,'spell is visible before contact');
        }
        await seek(page,hit+90);
        const expected = move==='heal'?[100,78]:move==='defend'?[67,78]:move==='break'?[36,78]:[72,78-({normal:14,heavy:26,special:36})[move]];
        assert.deepEqual((await state(page)).hp,mirrored?[...expected].reverse():expected);
        if (move==='heal') {
          assert.equal(await page.locator('[data-effect=healing]').getAttribute('data-class'),character);
          if (character==='ronin') assert.equal(await page.getByTestId('ronin-potion').count(),1);
        }
        if (move==='break') assert.equal(await page.locator('[data-effect=guard-break]').count(),1);
        if (move==='special' && character!=='ronin') assert.equal(await page.locator('[data-effect=ground-impact]').count(),1);
        const key=await state(page);await page.waitForTimeout(100);assert.deepEqual(await state(page),key,'new effects use the paused battle clock');
        await seek(page,hit+220);if(move==='break')assert.equal(await page.locator('[data-effect=defense]').count(),0,'broken guard disappears');
        if (!mirrored) await page.locator('.stage-frame').screenshot({path:`${shots}/${character}-${move}.png`});
        if (move==='defend') { await seek(page,hit+400); assert.deepEqual((await state(page)).hp,mirrored?[78,81]:[81,78],'class-specific combo renewal restores health'); }
        await seek(page,hit+90);assert.deepEqual(await state(page),key,'each sample reconstructs after seeking');
      }
    }
    console.log(`PASS ${character}: six move previews, both directions, spell travel, contact HP, healing, defense, guard break and pause`);
  }
  await page.getByTestId('svg-move-normal').click();
  const cadence = await page.getByTestId('duel-svg-gpt').evaluate(element => new Promise(resolve => {
    const times=[], started=performance.now();
    const observer=new MutationObserver(() => times.push(performance.now()));
    observer.observe(element,{attributes:true,attributeFilter:['data-elapsed']});
    setTimeout(() => { observer.disconnect(); resolve({frames:times.length,duration:performance.now()-started}); },2200);
  }));
  assert(cadence.frames>20,'real playback advances');
  assert(cadence.frames<=Math.ceil(cadence.duration/1000*30)+1,'render updates stay within the 30 FPS cap');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  console.log(`PASS live playback frame cap: ${cadence.frames} updates in ${Math.round(cadence.duration)} ms`);
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
  await page.getByTestId('entry-claude').click();await page.getByTestId('duel-claude-3d-canvas').waitFor();
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
