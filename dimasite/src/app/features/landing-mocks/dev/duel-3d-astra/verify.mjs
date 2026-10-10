// Mock-only behavior check. All production API/telemetry requests are intercepted.
// SAAS_PREVIEW_URL=http://127.0.0.1:4213 node <this file>
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require=createRequire(`${process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser'}/package.json`);
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base,'SAAS_PREVIEW_URL is required');
const shots=process.env.SAAS_SCREENSHOT_DIR||'/tmp/duel-astra-3d-verified';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({args:['--no-sandbox','--enable-unsafe-swiftshader']});
const errors=[];
async function fixture(width=1280,theme='dark',language='en',reducedMotion='no-preference') {
  const context=await browser.newContext({viewport:{width,height:1100},reducedMotion});
  await context.addInitScript(({theme,language})=>{localStorage.setItem('theme',theme);localStorage.setItem('userLanguage',language);},{theme,language});
  await context.route('**/api.domdimabot.com/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}));
  await context.route('**/tadd.domdimabot.com/**',r=>r.fulfill({status:200,body:'{}'}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/mocks/dev/duel');await page.getByTestId('renderer-svg').waitFor();
  await page.waitForFunction(theme=>document.documentElement.getAttribute('data-theme')===theme,theme);
  return {page,context};
}
async function ready(page) {await page.getByTestId('duel-astra-3d-canvas').waitFor();await page.waitForFunction(()=>Number(document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset.frames)>0,null,{timeout:60000});}
async function seek(page,time) {
  await page.getByTestId('duel-scrub').evaluate((input,time)=>{input.value=String(time);input.dispatchEvent(new Event('input',{bubbles:true}));},time);
  await page.waitForFunction(time=>Math.abs(Number(document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset.elapsed)-time)<40,time,{timeout:30000});
}
async function clean(page) {
  const result=await new AxeBuilder({page}).include('.duel-studio').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal overflow');
}
try {
  const {page,context}=await fixture();
  assert.equal(await page.locator('app-duel-astra-3d-arena').count(),0,'SVG defaults without a 3D renderer');
  assert.equal(await page.getByTestId('renderer-svg').getAttribute('aria-pressed'),'true');
  await page.getByTestId('renderer-3d').click();await page.getByTestId('entry-astra').click();await ready(page);
  const canvas=page.getByTestId('duel-astra-3d-canvas');assert.equal(await canvas.getAttribute('data-fps-cap'),'60');
  await canvas.screenshot({path:shots+'/arena-ready.png'});
  const startFrames=Number(await canvas.getAttribute('data-frames')),startTime=performance.now();
  await page.waitForTimeout(2500);
  const frames=Number(await canvas.getAttribute('data-frames'))-startFrames,seconds=(performance.now()-startTime)/1000;
  assert(frames/seconds<=60.5,`WebGL draws are capped: ${frames/seconds} FPS`);
  const intervals=JSON.parse(await canvas.getAttribute('data-frame-intervals')||'[]');
  assert(intervals.length>0);assert(Math.min(...intervals)>=16,`no burst/catch-up frames: ${Math.min(...intervals)} ms`);
  console.log(`PASS frame ceiling: ${(frames/seconds).toFixed(1)} FPS in software browser, shortest interval ${Math.min(...intervals).toFixed(2)} ms`);
  // Same battle survives switches; old GPU contexts are released on unmount.
  const detached=await canvas.elementHandle();
  for(let i=0;i<3;i++) {
    await page.getByTestId('renderer-svg').click();await page.locator('app-duel-astra-3d-arena').waitFor({state:'detached'});
    await page.getByTestId('renderer-3d').click();await page.getByTestId('entry-astra').click();await ready(page);
    assert.equal(await page.locator('app-duel-astra-3d-arena canvas').count(),1);
  }
  assert.equal(await detached.evaluate(c=>c.isConnected),false);
  const oldFrames=await detached.evaluate(c=>c.dataset.frames);await page.waitForTimeout(120);
  assert.equal(await detached.evaluate(c=>c.dataset.frames),oldFrames,'destroyed renderer stops drawing');
  await page.getByTestId('entry-claude').click();await page.getByTestId('claude-slot').waitFor();
  assert.equal(await page.locator('app-duel-astra-3d-arena').count(),0,'Claude slot remains independent');
  await page.getByTestId('entry-gpt').click();await page.getByTestId('duel-gpt-canvas').waitFor();
  await page.getByTestId('entry-astra').click();await ready(page);
  for(const character of ['knight','mage','ronin']) {
    await page.getByTestId('ultimate-'+character).click();await page.getByRole('button',{name:'Pause',exact:true}).click();
    await seek(page,8650);assert.equal(await canvas.getAttribute('data-ultimate'),character);
    await page.locator('.stage-frame').screenshot({path:`${shots}/ultimate-${character}-charge.png`});
    await seek(page,9470);assert.equal(await canvas.getAttribute('data-ultimate'),character);
    const hp=await page.locator('.fighter-hud[data-side=right] [role=progressbar]').getAttribute('aria-valuenow');assert.equal(hp,'0');
    await page.locator('.stage-frame').screenshot({path:`${shots}/ultimate-${character}-impact.png`});
    const frozen=await canvas.getAttribute('data-frames');await page.waitForTimeout(160);assert.equal(await canvas.getAttribute('data-frames'),frozen,'pause stops WebGL work');
    await seek(page,11000);await page.locator('.victory-cue').waitFor();
    await seek(page,8500);await page.getByRole('button',{name:'Resume',exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset.elapsed)>8550,null,{timeout:10000});
    console.log(`PASS ${character}: charge, lethal impact, pause, winner, scrub back and resume`);
  }
  // Verify both attack directions and the non-ultimate fixture against the shared battle model.
  await page.getByTestId('ultimate-mage').click();await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByTestId('astra-mirror').click();await seek(page,9470);
  assert.equal(await page.locator('.fighter-hud[data-side=left] [role=progressbar]').getAttribute('aria-valuenow'),'0');
  await page.locator('.stage-frame').screenshot({path:shots+'/mirrored-mage.png'});
  await page.getByTestId('astra-combat').click();await page.getByRole('button',{name:'Pause',exact:true}).click();
  for(const time of [3900,5000,5900,8000,9500,12500,14000])await seek(page,time);
  assert.equal(await page.locator('.fighter-hud[data-side=right] [role=progressbar]').getAttribute('aria-valuenow'),'0');
  await page.getByRole('button',{name:'Reset',exact:true}).click();await ready(page);
  await page.getByRole('button',{name:'Transparent background',exact:true}).click();
  await page.locator('.astra-arena.transparent').waitFor();
  await page.locator('.stage-frame').screenshot({path:shots+'/transparent.png'});
  await page.getByRole('button',{name:'Transparent background',exact:true}).click();
  await clean(page);await context.close();
  for(const [width,theme,language] of [[320,'dark','en'],[390,'dark','en'],[390,'light','es'],[1280,'dark','en'],[1280,'light','en']]) {
    const f=await fixture(width,theme,language);await f.page.getByTestId('renderer-3d').click();await f.page.getByTestId('entry-astra').click();await ready(f.page);await clean(f.page);
    await f.page.screenshot({path:`${shots}/${width}-${theme}-${language}.png`,fullPage:true});
    await f.context.close();console.log(`PASS layout + AXE ${width}px ${theme} ${language}`);
  }
  const reduced=await fixture(1280,'dark','en','reduce');await reduced.page.getByTestId('renderer-3d').click();await reduced.page.getByTestId('entry-astra').click();await ready(reduced.page);
  const rc=reduced.page.getByTestId('duel-astra-3d-canvas'),rf=await rc.getAttribute('data-frames');
  await reduced.page.waitForTimeout(150);assert.equal(await rc.getAttribute('data-frames'),rf,'reduced motion stops idle scene animation');
  // Changing the OS preference live restarts/re-stops motion.
  await reduced.page.emulateMedia({reducedMotion:'no-preference'});
  await reduced.page.waitForFunction(before=>Number(document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset.frames)>Number(before),rf,{timeout:15000});
  const beforeReduce=await rc.getAttribute('data-frames');
  await reduced.page.emulateMedia({reducedMotion:'reduce'});
  // The media-query event intentionally requests one final static redraw. Wait for
  // that draw, rather than assuming a software GPU has finished within 400 ms.
  await reduced.page.waitForFunction(before=>matchMedia('(prefers-reduced-motion: reduce)').matches&&Number(document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset.frames)>Number(before),beforeReduce,{timeout:15000});
  const stopped=await rc.getAttribute('data-frames');await reduced.page.waitForTimeout(1000);assert.equal(await rc.getAttribute('data-frames'),stopped,'reduced motion remains static after its final redraw');
  await reduced.context.close();
  const deep=await browser.newContext();await deep.route('**/api.domdimabot.com/**',r=>r.fulfill({status:200,body:'{"data":[]}'}));
  await deep.route('**/tadd.domdimabot.com/**',r=>r.fulfill({status:200,body:'{}'}));
  const dp=await deep.newPage();dp.on('pageerror',e=>errors.push(String(e)));
  await dp.goto(base+'/mocks/dev/duel?renderer=3d&entry=astra&overlay=1');await ready(dp);
  assert.equal(await dp.locator('.astra-arena.transparent').count(),1,'direct overlay link selects Astra and transparency');
  await dp.evaluate(()=>document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
  await dp.locator('.webgl-error').waitFor();await deep.close();
  assert.deepEqual(errors,[],'no browser exceptions');
  console.log('PASS mock-only Astra arena: default SVG, optional 3D, Claude placeholder, 60 FPS ceiling, all ultimate classes, GPU cleanup, pause/resume/scrub, transparency, responsive EN/ES, themes, reduced motion');
} catch(error) {
  console.error('ORIGINAL FAILURE',error);
  for(const context of browser.contexts())for(const page of context.pages()) {
    try { console.log('FAILURE STATE',await page.evaluate(()=>({canvas:document.querySelector('[data-testid=duel-astra-3d-canvas]')?.dataset,slider:document.querySelector('[data-testid=duel-scrub]')?.value,buttons:[...document.querySelectorAll('.playback button')].map(b=>b.textContent),error:document.querySelector('.webgl-error')?.textContent})));
    await page.screenshot({path:shots+'/failure.png'}); } catch {}
  }
  throw error;
} finally {await browser.close();}
