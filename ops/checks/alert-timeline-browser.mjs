// Visual timeline timing edits, scrub, transport and persistent publication.
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
  design.events.follow.widgets[1].motion={enter:'fade',exit:'fade',loop:'float',delay:1,enterDuration:1,exitDuration:.5,loopDuration:1};
  design.events.follow.sound={assetId:'1'.repeat(24),name:'Chime.wav',volume:.6,delay:.5,fadeIn:.2,fadeOut:.5};
  design.events.follow.widgets.push(layer('video-private','video',0,0,100,80,{assetId:'4'.repeat(24)}),layer('video-url','video',110,0,100,80,{mediaUrl:'https://fixture.invalid/sample.mp4'}));
  const widgets = [layer('tts-1', 'tts', 670, 60, 580, 160), layer('trigger-1', 'trigger', 80, 750, 500, 230), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets };
  main.published = { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: ['tts'], designs: [design] };
  const chat = { id: 'chat', name: 'Just chatting', revision: 0, publicId: 'b'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [layer('tts-2', 'tts', 100, 100, 580, 160)] };
  return { schemaVersion: 1, revision: 4, scenes: [main, chat], designs: [design] };
}
const mp4 = Buffer.from('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', 'base64');
const wave=Buffer.alloc(44+16000*20);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
function waveResponse(route,bytes=wave,mime='audio/wav') {
 const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range && range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
 return route.fulfill({status:range?206:200,contentType:mime,headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
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
    if(url.hostname==='fixture.invalid')return url.pathname.endsWith('.mp4')?waveResponse(route,mp4,'video/mp4'):waveResponse(route);
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
    if(url.pathname.startsWith('/asset-library/content/'))return url.pathname.endsWith('4'.repeat(24))?waveResponse(route,mp4,'video/mp4'):waveResponse(route);
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

try {
 for(const options of [{width:1280},{width:390,dark:true,touch:true},{width:320,lang:'es',touch:true}]){
  const {context,page,ctx}=await fixture(options),es=options.lang==='es';
  await page.locator('.design-row__actions button').first().click();
  const timeline=page.locator('app-overlay-timeline');await timeline.waitFor();
  const scrub=timeline.locator('input[type=range]'),text=page.locator('.stage .widget[data-kind=text] app-overlay-layer'),audio=page.locator('app-overlay-sound audio');
  await scrub.fill('0.5');await until(()=>text.evaluate(e=>e.getAnimations({subtree:true}).some(a=>a.currentTime===500)),'scrub seeks real animation');
  assert.equal(await text.locator('.motion-shell').first().evaluate(e=>getComputedStyle(e).opacity),'0','object hidden before entrance');
  await audio.waitFor({state:'attached'});await until(()=>audio.evaluate(a=>a.readyState>0),'audio ready');assert.equal(await audio.evaluate(a=>a.paused),true,'scrub is silent');
  await scrub.fill('1.5');await until(()=>text.evaluate(e=>e.getAnimations({subtree:true}).some(a=>a.currentTime===1500)),'mid entrance');
  const opacity=Number(await text.locator('.motion-shell').first().evaluate(e=>getComputedStyle(e).opacity));assert(opacity>0 && opacity<1,'partial entrance');
  await until(()=>audio.evaluate(a=>Math.abs(a.currentTime-1)<.1),'audio seeks with playhead');
  await until(()=>page.locator('.stage video').evaluateAll(videos=>videos.length===2 && videos.every(v=>v.paused && Number.isFinite(v.duration) && Math.abs(v.currentTime - 1.5%v.duration)<.1)),'private and URL video scrub');
  assert.equal(ctx.writes,0,'scrub does not save');assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false,'scrub does not dirty draft');
  await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>1.2),'play from playhead');
  await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>a.paused),'pause sound');
  await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused),'resume before hidden tab');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await until(()=>audio.evaluate(a=>a.paused),'background tab stops audio');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  const frozen=await text.evaluate(e=>e.getAnimations({subtree:true})[0].currentTime);await page.waitForTimeout(150);assert.equal(await text.evaluate(e=>e.getAnimations({subtree:true})[0].currentTime),frozen,'pause freezes animations');
  await scrub.fill('4.8');await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>a.paused),'end of alert');await until(()=>timeline.locator('output').innerText().then(v=>v.startsWith('5.00')),'bounded playhead');
  await scrub.fill('1.5');await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused),'replay after natural end');await timeline.locator('.primary').click();
  const handle=timeline.locator('[data-track=follow-text] .handle');await handle.focus();await handle.press('ArrowRight');
  await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='1.1'),'keyboard timing edit');
  await until(()=>page.locator('.stage video').evaluateAll(videos=>videos.every(v=>!v.paused)),'exit timeline resumes videos');
  await page.getByRole('button',{name:es?'Deshacer':'Undo',exact:true}).click();await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='1'),'undo timing');
  await page.getByRole('button',{name:es?'Rehacer':'Redo',exact:true}).click();await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='1.1'),'redo timing');
  await timeline.locator('[data-track=follow-text] .name').click();
  await timeline.locator('.timing input').nth(0).fill('2');await timeline.locator('.timing input').nth(0).press('Tab');
  await timeline.locator('.timing input').nth(1).fill('.7');await timeline.locator('.timing input').nth(1).press('Tab');
  await timeline.locator('[data-track="$sound"] .name').click();
  await until(()=>timeline.locator('.timing input').first().inputValue().then(v=>v==='0.5'),'sound field selected');
  await timeline.locator('.timing input').nth(0).fill('1');await timeline.locator('.timing input').nth(0).press('Tab');
  await timeline.locator('.timing input').nth(2).fill('.8');await timeline.locator('.timing input').nth(2).press('Tab');
  // Pointer drag commits one undo step on mouse and touch screens.
  {
    await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='2'),'numeric delay before drag');await handle.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await handle.click({trial:true});const box=await handle.boundingBox(),track=await handle.locator('..').boundingBox();
    if(options.touch){const cdp=await context.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+22,y:box.y+22}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+22+track.width*.2,y:box.y+22}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else{await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(box.x+22+track.width*.2,box.y+22,{steps:8});await page.mouse.up();}
    await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='3'),'drag start');
    await page.getByRole('button',{name:es?'Deshacer':'Undo',exact:true}).click();await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='2'),'one-step drag undo');
  }
  const published=structuredClone(ctx.state.scenes[0].published);await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save timeline');
  assert.equal(ctx.state.designs[0].events.follow.widgets[1].motion.delay,2);assert.equal(ctx.state.designs[0].events.follow.widgets[1].motion.enterDuration,.7);assert.equal(ctx.state.designs[0].events.follow.sound.delay,1);assert.equal(ctx.state.designs[0].events.follow.sound.fadeOut,.8);assert.deepEqual(ctx.state.scenes[0].published,published);
  await page.reload();await page.locator('.stage').waitFor();await page.locator('.design-row__actions button').first().click();await until(()=>handle.getAttribute('aria-valuenow').then(v=>v==='2'),'reload timing');
  await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].events.follow.widgets[1].motion.delay===2,'publish timeline');
  await scrub.fill('2.5');await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused),'event switch playback');await audio.evaluate(a=>window.previousSound=a);
  await page.locator('.design-event-tabs button').first().click();await until(()=>page.evaluate(()=>window.previousSound.paused && !window.previousSound.getAttribute('src')),'event switch stops playback');
  await page.locator('.design-event-tabs button').nth(2).click();
  await axe(page,'timeline '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await timeline.scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/timeline-${options.width}.png`,fullPage:true});}
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS visual timeline: real animation/audio seeking, silent scrub, pause/resume/end/replay, keyboard/pointer timing, grouped undo/redo, per-event save/reload/publish, switch cleanup, EN/ES responsive layouts and axe');
} finally {await browser.close();}
