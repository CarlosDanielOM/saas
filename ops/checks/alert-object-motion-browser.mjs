// Per-object alert animation editing and actual browser animation playback.
// Every API and socket is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '990191', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
function initialState() {
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 5, widgets: [layer(k + '-art', 'animation', 50, 50, 120, 120), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 })] }])) };
  const widgets = [layer('tts-1', 'tts', 670, 60, 580, 160), layer('trigger-1', 'trigger', 80, 750, 500, 230), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets };
  main.published = { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: ['tts'], designs: [design] };
  const chat = { id: 'chat', name: 'Just chatting', revision: 0, publicId: 'b'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [layer('tts-2', 'tts', 100, 100, 580, 160)] };
  return { schemaVersion: 1, revision: 4, scenes: [main, chat], designs: [design] };
}
const wave=Buffer.alloc(44+16000*20);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function until(predicate, label, tries = 200) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
async function fixture({ width = 1280, height = 900, dark = false, touch = false, lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(({ user, app, dark, lang }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, { user, app: {...app,language:lang}, dark, lang });
  await context.routeWebSocket('**/*', ws => ws.close());
  const ctx = { state: initialState(), writes: 0, sources: 1, tests: [], conflict: false, recoveries: [], failRecovery: false };
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if(url.hostname==='fixture.invalid')return route.fulfill({contentType:'audio/wav',body:wave});
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.postDataJSON?.();
    if (url.pathname === '/auth/session') data = { twitch: user, app: {...app,language:lang} };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = body.texts.map(t => t.replaceAll('$(user)', body.user));
    else if (url.pathname.endsWith('/test')) {
      ctx.tests.push(body);
      data = body.destination === 'obs' ? {sent:true,clients:1} : { media:{type:body.kind==='clip'?'video':'audio',url:'https://fixture.invalid/sample.wav',title:'Actual speech preview',volume:1},triggerId:body.triggerIds?.[0] };
    }
    else if (url.pathname.endsWith('/publish')) { const scene=ctx.state.scenes.find(s=>s.id===url.pathname.split('/').at(-2));scene.published={width:scene.width,height:scene.height,widgets:structuredClone(scene.widgets),waitFor:scene.waitFor,designs:structuredClone(ctx.state.designs)};ctx.state.revision++;data=ctx.state; }
    else if (url.pathname.endsWith('/recover')) {
      ctx.recoveries.push(body);
      if(ctx.failRecovery)return route.fulfill({status:409,json:{error:true,message:'Not enough room for recovery copies'}});
      ctx.state = {...ctx.state,revision:ctx.state.revision+1,scenes:[...ctx.state.scenes,{...body.scenes[0],id:'recovered-main',name:'Recovered local',publicId:'c'.repeat(48),published:undefined}]};data=ctx.state;
    }
    else if (url.pathname.endsWith('/queue')) data = { state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] };
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: ctx.state.scenes.map(s => ({ id: s.id, published: !!s.published, revision: s.revision, width: 1920, height: 1080, receives: ['tts'], sources: s.id === 'main' ? Array.from({ length: ctx.sources }, () => ({ connected: true, connectedAt: Date.now(), disconnectedAt: null, lastReportAt: Date.now(), revision: s.revision, status: 'ready', issue: null, issueAt: null, activationFailed: false, stateFailed: false })) : [] })) };
    else if (url.pathname === `/overlay-studio/${user.id}`) {
      if (req.method() === 'PUT' && ctx.conflict) return route.fulfill({ status:409, json:{error:true,message:'conflict'} });
      if (req.method() === 'PUT') { ctx.writes++; const prev = ctx.state; ctx.state = { ...body, revision: prev.revision + 1, scenes: body.scenes.map(s => { const old = prev.scenes.find(p => p.id === s.id); return { ...s, publicId: old?.publicId || 'e'.repeat(48), revision: old?.revision ?? 0, published: old?.published }; }) }; }
      data = ctx.state;
    } else if (url.pathname.startsWith('/triggers/')) data = [];
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor();
  return { context, page, ctx };
}
async function axe(page, label) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
  assert.deepEqual(violations, [], 'axe ' + label);
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const exactValue = (page, key) => page.locator('.properties').getByLabel(key, { exact: true }).inputValue();
try {
 for(const options of [{width:1280},{width:390,dark:true,touch:true},{width:320,lang:'es',touch:true}]){
  const {context,page,ctx}=await fixture(options);const es=options.lang==='es';
  await page.locator('.design-row__actions button').first().click();
  const controls=page.locator('.object-motion');await controls.waitFor();
  if(options.width===1280){
    for(const preset of ['none','fade','slide-left','slide-right','slide-up','slide-down','zoom','bounce','flip','spin']){
      await controls.locator('select').nth(0).selectOption(preset);await controls.locator('select').nth(2).selectOption(preset);
      await page.evaluate(()=>window.presetMotion=document.getAnimations().filter(a=>a.id.startsWith('alert-object')));
      await controls.locator('button').click();
      await until(()=>page.evaluate(()=>window.presetMotion.every(a=>a.playState==='idle')),'new replay '+preset);
      const object=page.locator('.stage .widget[data-kind="text"] app-overlay-layer');
      await until(async()=>await object.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-object')).length)===(preset==='none'?1:2),'preset '+preset);
      const endOpacity=await object.evaluate(e=>{for(const animation of e.getAnimations({subtree:true})){animation.pause();animation.currentTime=animation.effect.getComputedTiming().endTime;}return getComputedStyle(e.querySelectorAll('.motion-shell')[1]).opacity;});
      if(preset!=='none')assert.equal(endOpacity,'0','completed exit '+preset);
    }
  }
  await controls.locator('select').nth(0).selectOption('bounce');
  await controls.locator('select').nth(1).selectOption('float');
  await controls.locator('select').nth(2).selectOption('flip');
  await controls.locator('summary').click();
  await controls.locator('input').nth(0).fill('0.6');await controls.locator('input').nth(0).press('Tab');
  await controls.locator('input').nth(1).fill('0.8');await controls.locator('input').nth(1).press('Tab');
  await controls.locator('input').nth(2).fill('1.5');await controls.locator('input').nth(2).press('Tab');
  await controls.locator('button').click();
  const layer=page.locator('.stage .widget[data-kind="text"] app-overlay-layer');
  await until(async()=>await layer.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-object')).length)===3,'three motion phases');
  const config=await layer.evaluate(e=>e.getAnimations({subtree:true}).map(a=>({id:a.id,timing:a.effect.getTiming(),frames:a.effect.getKeyframes()})));
  assert.equal(config.find(a=>a.id==='alert-object-enter').timing.delay,600);assert.equal(config.find(a=>a.id==='alert-object-enter').timing.duration,800);
  assert.equal(config.find(a=>a.id==='alert-object-loop').timing.duration,1500);
  assert(config.find(a=>a.id==='alert-object-exit').frames.some(f=>f.transform.includes('rotateY')));
  assert.equal(await layer.evaluate(e=>{const a=e.getAnimations({subtree:true}).find(a=>a.id==='alert-object-enter');a.pause();a.currentTime=100;return getComputedStyle(a.effect.target).opacity;}),'0','object remains hidden during its own delay');
  await page.evaluate(()=>window.previousMotion=document.getAnimations().filter(a=>a.id.startsWith('alert-object')));
  await controls.locator('button').click();
  await until(()=>page.evaluate(()=>window.previousMotion.every(a=>a.playState==='idle')),'replay cancels previous animations');
  // Per-object choices survive save/reload, while other objects and live snapshots stay unchanged.
  const published=structuredClone(ctx.state.scenes[0].published);
  await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save');
  const follow=ctx.state.designs[0].events.follow;assert.equal(follow.widgets[1].motion.enter,'bounce');assert.equal(follow.widgets[0].motion,undefined);assert.deepEqual(ctx.state.scenes[0].published,published);
  await page.reload();await page.locator('.stage').waitFor();await page.locator('.design-row__actions button').first().click();
  assert.equal(await controls.locator('select').nth(0).inputValue(),'bounce');
  // Give the decorative object a different animation.
  await page.locator('.stage .widget[data-kind="animation"]').click();
  await controls.locator('select').nth(0).selectOption('slide-right');await controls.locator('select').nth(1).selectOption('sway');
  await controls.locator('button').click();
  await until(async()=>await page.locator('.stage').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id==='alert-object-enter').length)===2,'independent object animations');
  assert.equal(await page.locator('.stage .spark').evaluate(e=>getComputedStyle(e).animationName),'none','custom motion replaces legacy sparkle loop');
  await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].events.follow.widgets[0].motion?.enter==='slide-right','published motion');
  assert.equal(ctx.state.scenes[0].published.designs[0].events.follow.widgets[1].motion.enter,'bounce');
  await axe(page,'object motion '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await controls.scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/alert-motion-${options.width}.png`,fullPage:true});}
  await context.close();
 }
 console.log('PASS independent editor animations, per-object timing, replay cancellation, legacy preservation, save/reload/publish, mobile/desktop EN/ES and axe');
 const publicId='d'.repeat(48), snapshot={width:1280,height:720,waitFor:['follow'],widgets:[{id:'alert',kind:'alert',designId:'motion',events:['follow'],x:0,y:0,width:800,height:240,visible:true,locked:false}],designs:[{id:'motion',width:800,height:240,events:{}}]};
 const motion={enter:'bounce',exit:'flip',loop:'float',delay:.5,enterDuration:.8,exitDuration:.7,loopDuration:1};
 const parts=['text','image','video','animation'].map((kind,i)=>({id:kind,kind,x:i*180,y:0,width:160,height:200,visible:true,locked:false,text:'Animated text',motion:{...motion,enter:['fade','slide-left','zoom','bounce'][i]}}));
 for(const reducedMotion of ['no-preference','reduce']){
  const context=await browser.newContext({viewport:{width:1280,height:720},reducedMotion});let socket;const ended=[];
  const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
  await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:{id:url.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{motion:{duration:4,widgets:parts}}}}});return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);await page.locator('.canvas').waitFor();
  send('overlay-event',{id:'motion-event',kind:'follow'});await page.locator('[data-event="follow"] app-overlay-layer').first().waitFor();
  await until(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.id.startsWith('alert-object')).length>0),'runtime animation');
  const result=await page.evaluate(()=>{const layers=[...document.querySelectorAll('[data-event="follow"] app-overlay-layer')];return layers.map(e=>e.getAnimations({subtree:true}).map(a=>({id:a.id,timing:a.effect.getComputedTiming(),frames:a.effect.getKeyframes()})));});
  assert.equal(result.length,4);assert(result.every(anims=>anims.some(a=>a.id==='alert-object-enter')));
  assert(result.every(anims=>anims.every(a=>a.timing.endTime<=4000.01)),'every phase fits within alert lifetime');
  if(reducedMotion==='reduce'){assert(result.every(anims=>!anims.some(a=>a.id==='alert-object-loop')));assert(result.every(anims=>anims.every(a=>a.frames.every(f=>!f.transform))));}
  else {assert.equal(new Set(result.map(anims=>JSON.stringify(anims.find(a=>a.id==='alert-object-enter').frames))).size,4);assert(result.every(anims=>anims.some(a=>a.id==='alert-object-loop')));}
  // Skip disposes all animation work and releases the queue slot.
  send('overlay-control',{id:'skip-motion',action:'skip',platform:'all',eventIds:['motion-event']});
  await until(()=>page.evaluate(()=>document.querySelectorAll('[data-event="follow"]').length===0),'skip');
  assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.id.startsWith('alert-object')).length),0);assert(ended.includes('motion-event'));
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS OBS renderer: all object types, independent real keyframes, bounded timing, reduced-motion support and skip cleanup');
} finally {await browser.close();}
