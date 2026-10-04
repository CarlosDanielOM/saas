// Alert sound editing and actual browser audio playback.
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
function waveResponse(route) {
 const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range && range[2]?Math.min(Number(range[2]),wave.length-1):wave.length-1;
 return route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${wave.length}`}:{})},body:wave.subarray(start,end+1)});
}
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
  const assets=[{id:'1'.repeat(24),name:'Chime.wav',kind:'audio',mime:'audio/wav',duration:20,bytes:wave.length,width:0,height:0},{id:'2'.repeat(24),name:'Picture.png',kind:'image',mime:'image/png',bytes:100,width:10,height:10}];
  const ctx = { assets, uploads:0, state: initialState(), writes: 0, sources: 1, tests: [], conflict: false, recoveries: [], failRecovery: false };
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if(url.hostname==='fixture.invalid')return waveResponse(route);
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
    if(url.pathname.startsWith('/asset-library/content/'))return waveResponse(route);
    if(url.pathname===`/asset-library/${user.id}`){if(req.method()==='POST'){ctx.uploads++;const asset={...assets[0],id:'3'.repeat(24),name:'Uploaded.wav'};assets.push(asset);data=asset;}else data={assets,usedBytes:wave.length,quotaBytes:5000000000,maxFileBytes:50000000,planTier:'pro'};}
    else if(url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access'))data={path:'/asset-library/content/'+url.pathname.split('/').at(-2)};
    else if (url.pathname === '/auth/session') data = { twitch: user, app: {...app,language:lang} };
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
const exactValue = (page, key) => page.locator('.properties').getByLabel(key, { exact: true }).inputValue();try {
 for(const options of [{width:1280},{width:390,dark:true,touch:true},{width:320,lang:'es',touch:true}]){
  const {context,page,ctx}=await fixture(options),es=options.lang==='es';
  await page.locator('.design-row__actions button').first().click();
  const controls=page.locator('.alert-sound');await controls.waitFor();
  await controls.getByRole('button',{name:es?'Elegir sonido':'Choose sound',exact:true}).click();
  const dialog=page.locator('app-asset-library-dialog');await dialog.locator('.asset').first().waitFor();
  assert.equal(await dialog.locator('.asset').count(),1,'sound picker excludes pictures');
  await dialog.locator('.asset').click();
  await dialog.locator('audio').waitFor();assert.equal(await dialog.locator('audio').evaluate(a=>a.paused),true,'library preview does not autoplay');
  await dialog.locator('input[type=file]').setInputFiles({name:'Uploaded.wav',mimeType:'audio/wav',buffer:wave});
  await until(()=>ctx.uploads===1,'sound upload');await dialog.locator('.use').click();await dialog.waitFor({state:'detached'});
  await controls.locator('input[type=range]').fill('60');
  await controls.locator('summary').click();
  for(const [index,value] of ['.6','.5','1'].entries()){await controls.locator('input[type=number]').nth(index).fill(value);await controls.locator('input[type=number]').nth(index).press('Tab');}
  const play=page.locator('.tester').getByRole('button',{name:es?'Previsualizar':'Preview',exact:false}).last();
  await play.click();const audio=page.locator('app-overlay-sound audio');await audio.waitFor({state:'attached'});
  assert.equal(await audio.evaluate(a=>a.paused),true,'delay before playback');
  await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.7),'actual preview playback');
  assert(Math.abs(await audio.evaluate(a=>a.volume)-.6)<.03,'configured volume');
  await audio.evaluate(a=>window.oldSound=a);await play.click();
  await until(()=>page.evaluate(()=>window.oldSound.paused && !window.oldSound.getAttribute('src')),'replay stops old audio');
  const published=structuredClone(ctx.state.scenes[0].published);await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save sound');
  assert.deepEqual(ctx.state.designs[0].events.follow.sound,{assetId:'3'.repeat(24),name:'Uploaded.wav',volume:.6,delay:.6,fadeIn:.5,fadeOut:1});
  assert.equal(ctx.state.designs[0].events.sub.sound,undefined);assert.deepEqual(ctx.state.scenes[0].published,published);
  await page.reload();await page.locator('.stage').waitFor();await page.locator('.design-row__actions button').first().click();
  assert.equal(await controls.locator('input[type=range]').inputValue(),'60');
  await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].events.follow.sound?.volume===.6,'publish sound');
  await axe(page,'sound '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await controls.scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/alert-sound-${options.width}.png`,fullPage:true});}
  await controls.getByRole('button',{name:es?'Quitar sonido':'Remove sound',exact:true}).click();await controls.locator('input[type=range]').waitFor({state:'detached'});
  await context.close();
 }
 console.log('PASS sound picker/filter/upload, manual library preview, volume/delay, real preview playback and replay cleanup, save/reload/publish, per-event settings, mobile/desktop EN/ES and axe');
 const publicId='d'.repeat(48),sound={assetId:'1'.repeat(24),volume:.8,delay:.3,fadeIn:.8,fadeOut:1.5};
 const snapshot={width:1280,height:720,waitFor:['follow'],widgets:['one','duplicate'].map((id,i)=>layer(id,'alert',i*400,0,400,120,{designId:'sound',events:['follow']})),designs:[{id:'sound',width:800,height:240,events:{}}]};
 const context=await browser.newContext({viewport:{width:1280,height:720}});let socket;const ended=[],health=[];let fail=false;
 const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
 await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);if(m.includes('overlay-health'))health.push(m);});});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:{id:url.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{sound:{duration:3,widgets:[layer('text','text',0,0,600,150,{text:'Sound alert'})],sound}}}}});if(url.pathname.includes('/assets/'))return fail?route.fulfill({status:404,body:'missing'}):waveResponse(route);return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);await page.locator('.canvas').waitFor();
 // Explicitly exercise autoplay rejection without relying on host browser policy.
 await page.evaluate(()=>{const play=HTMLMediaElement.prototype.play;window.allowSound=false;HTMLMediaElement.prototype.play=function(){return window.allowSound?play.call(this):Promise.reject(new DOMException('blocked','NotAllowedError'));};});
 send('overlay-event',{id:'sound-event',kind:'follow'});const audio=page.locator('app-overlay-sound audio');await audio.waitFor({state:'attached'});assert.equal(await audio.count(),1,'duplicate placements play one sound');
 await page.getByRole('button',{name:'Enable sound',exact:true}).waitFor();await page.evaluate(()=>window.allowSound=true);await page.getByRole('button',{name:'Enable sound',exact:true}).click();
 await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.15),'runtime playback');assert.match(await audio.getAttribute('src'),new RegExp('/public/'+publicId+'/assets/'));
 const early=await audio.evaluate(a=>a.volume);assert(early<.8,'fade in');await until(()=>audio.evaluate(a=>a.currentTime>1),'full volume');assert(Math.abs(await audio.evaluate(a=>a.volume)-.8)<.1);
 await until(()=>audio.evaluate(a=>a.currentTime>2),'fade out');assert(await audio.evaluate(a=>a.volume)<.6);
 await audio.evaluate(a=>window.lastSound=a);await until(()=>ended.includes('sound-event'),'normal alert completes');assert.equal(await page.evaluate(()=>window.lastSound.paused && !window.lastSound.getAttribute('src')),true,'natural cleanup');
 send('overlay-event',{id:'skip-sound',kind:'follow'});await audio.waitFor({state:'attached'});await until(()=>audio.evaluate(a=>!a.paused),'second sound');await audio.evaluate(a=>window.lastSound=a);
 send('overlay-control',{id:'skip-command',action:'skip',platform:'all',eventIds:['skip-sound']});await until(()=>ended.includes('skip-sound'),'skip');assert.equal(await page.evaluate(()=>window.lastSound.paused && !window.lastSound.getAttribute('src')),true,'skip cancels audio');
 fail=true;send('overlay-event',{id:'missing-sound',kind:'follow'});await page.locator('[data-event=follow]').first().waitFor();await until(()=>ended.includes('missing-sound'),'missing sound does not block queue');
 await context.close();assert.deepEqual(errors,[]);console.log('PASS OBS audio: deduplicated placements, scoped assets, autoplay retry, real fades, duration bound, skip cleanup and failed audio queue completion');
} finally {await browser.close();}
