// Mock-only browser verification. All external APIs are intercepted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/duel-astra-verified';
mkdirSync(shots, {recursive:true});
const browser = await chromium.launch({args:['--no-sandbox']});
const errors=[];
async function fixture(width=1280, theme='dark', language='en', reducedMotion='no-preference', query='?entry=astra') {
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion});
 await context.addInitScript(({theme,language})=>{localStorage.setItem('theme',theme);localStorage.setItem('userLanguage',language);},{theme,language});
 await context.route('**/api.domdimabot.com/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}));
 await context.route('**/tadd.domdimabot.com/**',r=>r.fulfill({status:200,body:'{}'}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base+'/mocks/dev/duel'+query);await page.getByTestId(query ? 'duel-svg-astra':'svg-original').waitFor();
 return {page,context};
}
async function seek(page,time) {
 await page.getByTestId('duel-scrub').evaluate((e,t)=>{e.value=String(t);e.dispatchEvent(new Event('input',{bubbles:true}));},time);
 await page.waitForFunction(t=>Number(document.querySelector('[data-testid=duel-svg-astra]')?.getAttribute('data-elapsed'))===t,time);
 await page.waitForTimeout(60);
}
const hp=page=>page.locator('[data-testid=duel-svg-astra] [role=progressbar]').evaluateAll(es=>es.map(e=>+e.getAttribute('aria-valuenow')));
const frame=page=>page.getByTestId('duel-svg-astra').evaluate(e=>[...e.getAnimations({subtree:true})].map(a=>({name:a.animationName,time:a.currentTime,state:a.playState,transform:getComputedStyle(a.effect.target).transform,opacity:getComputedStyle(a.effect.target).opacity})));
async function pause(page) {await page.getByRole('button',{name:'Pause',exact:true}).click();}
async function accessibility(page) {
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
 const results=await new AxeBuilder({page}).include('.duel-studio').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
}
try {
 const {page,context}=await fixture(1280,'dark','en','no-preference','');
 assert.equal(await page.getByTestId('svg-original').getAttribute('aria-pressed'),'true');
 for(const [entry,selector] of [['gpt','app-duel-svg-gpt-arena'],['claude','app-duel-claude-arena'],['astra','app-duel-astra-arena']]) {
  await page.getByTestId('svg-'+entry).click();await page.locator(selector).waitFor();
  assert.equal(await page.getByTestId('svg-'+entry).getAttribute('aria-pressed'),'true');
 }
 assert.equal(await page.locator('canvas').count(),0);
 await page.getByTestId('svg-combat').click();await pause(page);await seek(page,3400);
 await page.screenshot({path:shots+'/desktop-dark.png',fullPage:true});await accessibility(page);
 await seek(page,3800);const anticipation=await frame(page);
 await seek(page,3980);assert.deepEqual(await hp(page),[100,88]);const contact=await frame(page);
 assert.notDeepEqual(contact,anticipation);
 await page.locator('.stage-frame').screenshot({path:shots+'/contact.png'});
 await page.waitForTimeout(250);assert.deepEqual(await frame(page),contact,'paused animation clocks stay frozen');
 await seek(page,5830);assert.deepEqual(await hp(page),[78,88]);
 await seek(page,6200);assert.deepEqual(await hp(page),[78,96]);
 await seek(page,7950);assert.deepEqual(await hp(page),[78,100]);
 await seek(page,9400);assert.deepEqual(await hp(page),[78,65]);
 await seek(page,3980);assert.deepEqual(await frame(page),contact,'backward scrub reconstructs identical poses');
 console.log('PASS slot selection, hit, block, heal, guard break, pause and backward scrub');
 for(const character of ['knight','mage','ronin']) {
  await page.getByTestId('svg-ultimate-'+character).click();await pause(page);
  for(const [time,beat] of [[6600,'awaken'],[8200,'charge'],[9070,'release'],[9200,'impact'],[9950,'aftermath']]) {
   await seek(page,time);assert.equal(await page.locator('.ultimate-stage').getAttribute('data-beat'),beat);
   assert.equal(await page.locator('.ultimate-stage').getAttribute('data-character'),character);
   if(time===8200||time===9200)await page.locator('.stage-frame').screenshot({path:shots+'/'+character+'-'+beat+'.png'});
  }
  assert.deepEqual(await hp(page),[78,0]);
  await page.getByTestId('svg-mirror').click();await seek(page,8200);
  assert.equal(await page.locator('.ultimate-stage').getAttribute('data-attacker'),'right');
  await page.locator('.stage-frame').screenshot({path:shots+'/'+character+'-mirrored.png'});
  await seek(page,11000);assert.equal(await page.getByTestId('duel-svg-astra').getAttribute('data-phase'),'winner');
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  assert.equal(await page.locator('.ultimate-stage').count(),0);
  console.log('PASS '+character+' Ultimate stages, mirrored attacker, winner and reset');
 }
 // Every move fixture and class produces a visible, finite vector rig.
 for(const character of ['knight','mage','ronin']) {
  await page.getByTestId('svg-class-'+character).click();
  for(const move of ['normal','heavy','special','heal','defend','break']) {
   await page.getByTestId('svg-move-'+move).click();await pause(page);await seek(page,5800);
   assert.equal(await page.locator('.fighter-motion app-duel-astra-fighter').count(),2);
   assert((await frame(page)).every(a=>Number.isFinite(a.time)));
  }
 }
 await context.close();
 for(const width of [320,390,1280])for(const theme of ['dark','light']) {
  const {page,context}=await fixture(width,theme,'es');
  await accessibility(page);
  assert(await page.getByTestId('svg-astra-section').innerText().then(t=>t.includes('Edición celestial')));
  await page.screenshot({path:shots+'/'+width+'-'+theme+'.png',fullPage:true});await context.close();
 }
 const reduced=await fixture(390,'dark','en','reduce');
 await reduced.page.getByTestId('svg-ultimate-knight').click();await pause(reduced.page);await seek(reduced.page,8200);
 assert.equal((await frame(reduced.page)).length,0,'reduced motion disables movement');await accessibility(reduced.page);await reduced.context.close();
 const overlay=await fixture(1280,'dark','en','no-preference','?entry=astra&overlay=1');
 assert.equal(await overlay.page.locator('.arena.transparent').count(),1);
 assert.equal(await overlay.page.locator('.scenery').evaluate(e=>getComputedStyle(e).display),'none');
 await overlay.page.getByRole('button',{name:'Play duel',exact:true}).click();
 await overlay.page.waitForTimeout(150);assert(Number(await overlay.page.getByTestId('duel-svg-astra').getAttribute('data-elapsed'))>0);
 await overlay.context.close();assert.deepEqual(errors,[]);
 console.log('PASS all class moves, EN/ES, 320/390/1280 dark/light, AXE, reduced motion, transparent overlay, no runtime errors');
} finally {await browser.close();}
