// Design tools and variants: editing, sound/timing, rules, recovery and publication.
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
  const widgets = [layer('tts-1', 'tts', 670, 60, 580, 160), layer('trigger-1', 'trigger', 80, 750, 500, 230), layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 3, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: ['tts'], widgets };
  main.published = { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: ['tts'], designs: [design] };
  const chat = { id: 'chat', name: 'Just chatting', revision: 0, publicId: 'b'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets: [layer('tts-2', 'tts', 100, 100, 580, 160)] };
  return { schemaVersion: 1, revision: 4, scenes: [main, chat], designs: [design] };
}
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
    if(url.hostname==='fixture.invalid')return url.pathname.endsWith('.mp4')?waveResponse(route):waveResponse(route);
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined;
    if(url.pathname.startsWith('/asset-library/content/'))return url.pathname.endsWith('4'.repeat(24))?waveResponse(route):waveResponse(route);
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
const ids={enter:['dissolve','rise','settle','glide-left','glide-right','bloom','land','spring','bounce-land','swing-in','arc-in','whip-in','twirl-in','hero-pop'],loop:['float','breathe','drift','sway','glimmer','heartbeat','jelly','hop','figure-eight','rock','pulse','orbit'],exit:['fade-away','sink','lift-away','drift-left','drift-right','shrink','expand-away','anticipate-out','swing-out','pop-away','whip-out','twirl-out']};
try {
 for(const options of [{width:1280},{width:390,height:844,dark:true,touch:true},{width:320,height:640,lang:'es',touch:true}]){
  const {context,page,ctx}=await fixture(options),es=options.lang==='es';
  await page.locator('.design-row__actions button').first().click();
  const editor=page.locator('app-overlay-keyframe-editor'),catalog=page.locator('app-overlay-motion-catalog');await editor.waitFor();
  const save=async()=>{const before=ctx.writes;await page.locator('.save-button').click();await until(()=>ctx.writes>before,'save');await until(()=>page.locator('.save-button').isDisabled().then(v=>!v),'save response');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
  const widget=()=>ctx.state.designs[0].events.follow.widgets[1];
  const open=async()=>{await editor.locator('header button').click();await catalog.locator('.preset').first().waitFor();};
  const use=async(phase,id,combine=false)=>{await open();await catalog.locator('.phases button').nth(['enter','loop','exit'].indexOf(phase)).click();await catalog.locator(`[data-preset="${id}"]`).click();await catalog.locator('footer button').nth(combine?1:-1).click();await catalog.waitFor({state:'detached'});};
  await open();assert.equal(await catalog.locator('.preset').count(),14);
  await catalog.locator('input[type=search]').fill(es?'Resorte':'Spring');await until(()=>catalog.locator('.preset').count().then(n=>n===1),'search');await catalog.locator('input[type=search]').fill('');
  await catalog.locator('.moods button').nth(3).click();await until(()=>catalog.locator('.preset').count().then(n=>n===3),'style filter');await catalog.locator('.moods button').first().click();
  if(options.width===1280){
   for(const [phase,presets] of Object.entries(ids)){
    await catalog.locator('.phases button').nth(['enter','loop','exit'].indexOf(phase)).click();await until(()=>catalog.locator('.preset').count().then(n=>n===presets.length),'phase catalog');
    for(const id of presets){await catalog.locator(`[data-preset="${id}"]`).click();await until(()=>catalog.locator('.preview-stage app-overlay-layer').evaluate((e,phase)=>e.getAnimations({subtree:true}).some(a=>a.id.startsWith('alert-keyframe-'+phase+'-')),phase),'preset plays '+id);
     const frames=await catalog.locator('.preview-stage app-overlay-layer').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).map(a=>({id:a.id,frames:a.effect.getKeyframes(),timing:a.effect.getTiming()})));
     for(const a of frames){assert(a.timing.duration>0);assert(a.frames.length>=2);assert(a.frames.every(f=>Number.isFinite(f.offset)));if(phase==='loop'){assert(Number.isInteger(a.timing.iterations));for(const property of ['transform','opacity'])if(a.frames[0][property])assert.equal(a.frames[0][property],a.frames.at(-1)[property]);}}
    }
   }
  }
  if(options.width===1280){
   await catalog.locator('.phases button').first().click();await catalog.locator('[data-preset=rise]').click();await until(()=>catalog.locator('.settings input').first().inputValue().then(v=>Number(v)===.85),'rise settings');
   await catalog.locator('.settings input').first().fill('1.2');await catalog.locator('.settings input').first().press('Tab');await until(()=>catalog.locator('.preview-stage app-overlay-layer').evaluate(e=>e.getAnimations({subtree:true}).some(a=>a.id==='alert-keyframe-enter-y' && a.effect.getTiming().duration===1200)),'preview duration');await catalog.locator('.settings input').last().fill('150');await catalog.locator('.settings input').last().press('Tab');
   await until(()=>catalog.locator('.preview-stage app-overlay-layer').evaluate(e=>{const a=e.getAnimations({subtree:true}).find(a=>a.id==='alert-keyframe-enter-y');return a && a.effect.getTiming().duration===1200 && a.effect.getKeyframes()[0].transform==='translateY(36%)';}),'catalog timing and movement strength');
  }
  assert(await catalog.locator('.preset').evaluateAll(items=>items.every(e=>e.querySelector('small').getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom+1)),'catalog labels stay inside cards');await axe(page,'catalog '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/catalog-'+options.width+'.png'});}
  await page.keyboard.press('Escape');await catalog.waitFor({state:'detached'});assert.equal(await editor.locator('header button').evaluate(e=>e===document.activeElement),true,'focus restored');assert.equal(ctx.writes,0);
  await use('enter','spring');await save();assert.equal(widget().motion.enter,'none');assert.deepEqual(widget().keyframes.enter.tracks.map(t=>t.property),['scale','opacity']);
  await use('loop','float');await use('loop','breathe',true);await save();assert.deepEqual(widget().keyframes.loop.tracks.map(t=>t.property),['y','scale']);assert.equal(widget().motion.loopDuration,3,'combine keeps current timing');
  await use('exit','twirl-out');await save();assert.equal(widget().keyframes.exit.tracks.length,3);
  const beforeModal=structuredClone(widget().keyframes);await open();assert.equal(await catalog.locator('dialog').getAttribute('role'),'dialog');await catalog.locator('.preset').first().focus();assert(await page.evaluate(()=>!!document.activeElement.closest('dialog[role=dialog]')));await page.keyboard.press('Control+z');await page.keyboard.press('Escape');await catalog.waitFor({state:'detached'});await save();assert.deepEqual(widget().keyframes,beforeModal,'modal keyboard shortcuts cannot undo the underlying design');
  await editor.locator('.phases button').nth(1).click();await editor.locator('[data-property=y]').click();await until(()=>editor.locator('.frame').count().then(n=>n===3),'three frames');
  await editor.locator('.frame').nth(1).click();await until(()=>editor.locator('[data-field=value]').inputValue().then(v=>v==='-7'),'selected frame value');await editor.locator('[data-field=value]').fill('-12');await editor.locator('[data-field=value]').press('Tab');await save();assert.equal(widget().keyframes.loop.tracks[0].points[1].value,-12);assert.equal(await editor.locator('.phases button').nth(1).getAttribute('aria-pressed'),'true','editing keeps phase');
  await editor.locator('[data-field=easing]').selectOption('linear');await editor.getByRole('button',{name:es?'Añadir fotograma':'Add keyframe',exact:true}).click();await until(()=>editor.locator('.frame').count().then(n=>n===4),'added point');
  await until(()=>editor.locator('[data-field=offset]').isEnabled(),'inserted frame selected');await editor.locator('[data-field=offset]').fill('65');await editor.locator('[data-field=offset]').press('Tab');await editor.locator('.frame').nth(2).focus();await editor.locator('.frame').nth(2).press('ArrowRight');await save();assert.equal(widget().keyframes.loop.tracks[0].points[2].offset,.66);
  await editor.locator('.frame').first().click();await until(()=>editor.locator('[data-field=offset]').isDisabled(),'endpoint locked');assert(await editor.getByRole('button',{name:es?'Eliminar fotograma':'Remove keyframe',exact:true}).isDisabled());
  await editor.locator('[data-field=value]').fill('2');await editor.locator('[data-field=value]').press('Tab');await save();const points=widget().keyframes.loop.tracks[0].points;assert.equal(points[0].value,2);assert.equal(points.at(-1).value,2,'loop endpoints linked');
  await editor.locator('[data-field=value]').fill('0');await editor.locator('[data-field=value]').press('Tab');
  await editor.locator('.frame').nth(2).click();await until(()=>editor.locator('[data-field=offset]').isEnabled(),'interior selected');await editor.getByRole('button',{name:es?'Eliminar fotograma':'Remove keyframe',exact:true}).click();await until(()=>editor.locator('.frame').count().then(n=>n===3),'three frames');
  await editor.locator('.frame').nth(1).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await editor.locator('.frame').nth(1).click({trial:true});
  const box=await editor.locator('.frame-rail').boundingBox();assert(box);const start={x:box.x+box.width*.5,y:box.y+22},end={x:box.x+box.width*.6,y:box.y+22};
  if(options.touch){const cdp=await context.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[end]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
  else{await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:8});await page.mouse.up();}
  await save();assert(Math.abs(widget().keyframes.loop.tracks[0].points[1].offset-.6)<.015,'pointer keyframe move');
  await page.getByRole('button',{name:es?'Deshacer':'Undo',exact:true}).click();await save();assert.equal(widget().keyframes.loop.tracks[0].points[1].offset,.5,'one undo restores whole drag');
  await editor.getByRole('button',{name:es?'Copiar animación':'Copy animation',exact:true}).click();
  await page.locator('app-overlay-timeline .name').first().click();
  await editor.getByRole('button',{name:es?'Pegar animación':'Paste animation',exact:true}).click();await save();assert.deepEqual(ctx.state.designs[0].events.follow.widgets[0].keyframes,widget().keyframes);
  await editor.locator('.phases button').nth(1).click();await editor.locator('[data-property=rotation]').click();await save();assert.equal(ctx.state.designs[0].events.follow.widgets[0].keyframes.loop.tracks.length,3);assert.equal(widget().keyframes.loop.tracks.length,2,'independent object tracks');
  await axe(page,'keyframes '+options.width);assert.equal(await overflow(page),false);
  if(shots){await editor.scrollIntoViewIfNeeded();await page.screenshot({path:shots+'/keyframes-'+options.width+'.png'});}
  await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].events.follow.widgets[0].keyframes?.loop.tracks.length===3,'published keyframes');
  await page.reload();await page.locator('.design-row__actions button').first().click();await editor.locator('.phases button').nth(1).click();await editor.locator('summary').click();await until(()=>editor.locator('.frame').count().then(n=>n===3),'three frames');
  // Choosing an older preset removes only that custom phase, preserving the others.
  await page.locator('.object-motion select').nth(1).selectOption('pulse');await save();assert.equal(widget().keyframes.loop,undefined);assert(widget().keyframes.enter);assert(widget().keyframes.exit);
  if(options.width===1280){
    await editor.locator('.phases button').first().click();await editor.locator('[data-property=scale]').click();await until(()=>editor.locator('[data-field=value]').inputValue().then(v=>v==='35'),'entrance selected');
    await editor.locator('[data-field=value]').fill('60');await editor.locator('[data-field=value]').press('Tab');
    await until(()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('domdimabot-overlay-draft:')).some(k=>JSON.parse(localStorage.getItem(k)).designDraft?.events.follow.widgets[1].keyframes?.enter.tracks[0].points[0].value===.6)),'local keyframe recovery');
    page.once('dialog',d=>d.accept());await page.reload();await page.getByRole('button',{name:'Restore local draft',exact:true}).click();
    await editor.locator('summary').click();await until(()=>editor.locator('[data-field=value]').inputValue().then(v=>v==='60'),'recovered frame');
    await editor.locator('.frame').nth(1).click();
    await until(()=>page.locator('.stage .widget[data-kind=text] app-overlay-layer').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).every(a=>a.playState==='paused')),'timeline pauses keyframes');
    const clock=Number(await page.locator('app-overlay-timeline .scrubber input').inputValue());
    const times=await page.locator('.stage .widget[data-kind=text] app-overlay-layer').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).map(a=>a.currentTime));assert(times.length>0);assert(times.every(t=>Math.abs(t-clock*1000)<=5.01),'timeline and keyframes share playhead within the slider’s 10 ms step');
    await save();
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS 38 catalog previews; phase combinations; numeric/keyboard/mouse/touch keyframes; easing, loop closure, copy/paste, undo, independent objects, publication/reload; desktop/mobile EN/ES and accessibility');
}finally{await browser.close();}
