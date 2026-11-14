// Alert sound editing and actual browser audio playback.
// Every API and socket is mocked; nothing reaches production.
import { openStudio, closeStudioMenus, switchStudioScene, studioSceneId, studioToggle } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
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
// Answers like the API: writer 2 = `sounds` authoritative; no writer = the old editor (its `sound` edit merges into `sounds`).
// Stored: `sounds` (non-empty) plus the legacy mirror `sound` = sounds[0] without its id.
function storeSounds(body){const fix=l=>{if(!l)return;let sounds;if(body.writer>=2)sounds=l.sounds??[];else if(l.sounds)sounds=l.sound?[{...l.sound,id:l.sounds[0]?.id??'sound'},...l.sounds.slice(1)]:l.sounds.slice(1);else sounds=l.sound?[{id:'sound',...l.sound}]:[];delete l.sounds;delete l.sound;if(sounds.length){l.sounds=sounds;const{id:_id,...first}=sounds[0];l.sound=first;}};for(const d of body.designs??[]){Object.values(d.events??{}).forEach(fix);Object.values(d.variants??{}).flat().forEach(v=>fix(v.layout));}const{writer:_w,...rest}=body;return rest;}
const wave=Buffer.alloc(44+16000*20);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
function waveResponse(route) {
 const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range && range[2]?Math.min(Number(range[2]),wave.length-1):wave.length-1;
 return route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${wave.length}`}:{})},body:wave.subarray(start,end+1)});
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function until(predicate, label, tries = 200) { for (let i = 0; i < tries; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out: ' + label); }
async function fixture({ width = 1280, height = 900, dark = false, touch = false, lang = 'en', state, draft } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(({ user, app, dark, lang }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('userLanguage', lang); localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, { user, app: {...app,language:lang}, dark, lang });
  // An unsaved recovery copy left by an earlier editor (once per test page).
  if (draft) await context.addInitScript(({ draft }) => { if (sessionStorage.getItem('fixture-draft')) return; sessionStorage.setItem('fixture-draft', '1'); localStorage.setItem('domdimabot-overlay-draft:' + draft.channelID + ':00000000-0000-4000-8000-000000000000', JSON.stringify(draft)); }, { draft });
  await context.routeWebSocket('**/*', ws => ws.close());
  const assets=[{id:'1'.repeat(24),name:'Chime.wav',kind:'audio',mime:'audio/wav',duration:20,bytes:wave.length,width:0,height:0},{id:'5'.repeat(24),name:'Second.wav',kind:'audio',mime:'audio/wav',duration:20,bytes:wave.length,width:0,height:0},{id:'2'.repeat(24),name:'Picture.png',kind:'image',mime:'image/png',bytes:100,width:10,height:10}];
  const ctx = { assets, uploads:0, bodies:[], state: state ?? initialState(), writes: 0, sources: 1, tests: [], conflict: false, recoveries: [], failRecovery: false };
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
      if (req.method() === 'PUT') { ctx.writes++; ctx.bodies.push(structuredClone(body)); const prev = ctx.state; ctx.state = { ...storeSounds(structuredClone(body)), revision: prev.revision + 1, scenes: body.scenes.map(s => { const old = prev.scenes.find(p => p.id === s.id); return { ...s, publicId: old?.publicId || 'e'.repeat(48), revision: old?.revision ?? 0, published: old?.published }; }) }; }
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
  const controls=page.locator('app-overlay-sounds');await controls.waitFor();
  assert.equal(await controls.locator('.sound').count(),0,'no sounds yet');
  await controls.getByText(es?'Aún no hay sonidos':'No sounds yet',{exact:false}).waitFor();
  const addSound=controls.getByRole('button',{name:es?'Agregar sonido':'Add sound',exact:true});
  await addSound.click();
  const dialog=page.locator('app-asset-library-dialog');await dialog.locator('.asset').first().waitFor();
  assert.equal(await dialog.locator('.asset').count(),2,'sound picker excludes pictures');
  await dialog.locator('.asset').first().click();
  await dialog.locator('audio').waitFor();assert.equal(await dialog.locator('audio').evaluate(a=>a.paused),true,'library preview does not autoplay');
  await dialog.locator('input[type=file]').setInputFiles({name:'Uploaded.wav',mimeType:'audio/wav',buffer:wave});
  await until(()=>ctx.uploads===1,'sound upload');await dialog.locator('.use').click();await dialog.waitFor({state:'detached'});
  const rows=controls.locator('.sound');await until(()=>rows.count().then(n=>n===1),'first sound added');
  const first=rows.nth(0);await first.locator('input[type=range]').waitFor();
  await first.locator('input[type=range]').fill('60');
  for(const [index,value] of ['.6','.5','1'].entries()){await first.locator('input[type=number]').nth(index).fill(value);await first.locator('input[type=number]').nth(index).press('Tab');}
  // A second sound with its own timing: it opens on its own and the first one closes.
  await addSound.click();await dialog.locator('.asset').filter({hasText:'Chime.wav'}).click();await dialog.locator('.use').click();await dialog.waitFor({state:'detached'});
  await until(()=>rows.count().then(n=>n===2),'second sound added');const second=rows.nth(1);
  await second.locator('input[type=number]').first().waitFor();assert.equal(await first.locator('input[type=number]').count(),0,'one sound open at a time');
  await second.locator('input[type=number]').first().fill('1.2');await second.locator('input[type=number]').first().press('Tab');
  assert.equal(await page.locator('app-overlay-timeline [data-track^="$sound:"]').count(),2,'one timeline row per sound');
  await openStudio(page,'test');
  const play=page.locator('.tester').getByRole('button',{name:es?'Previsualizar':'Preview',exact:false}).last();
  // When each player mounts and first plays, measured in the page (no polling delay).
  await page.evaluate(()=>{window.soundLog={};const seen=()=>{for(const a of document.querySelectorAll('app-overlay-sound audio'))if(!a.dataset.mounted){a.dataset.mounted=String(performance.now());a.addEventListener('playing',()=>{window.soundLog[[...document.querySelectorAll('app-overlay-sound audio')].indexOf(a)]??=performance.now()-Number(a.dataset.mounted);});}};new MutationObserver(seen).observe(document.body,{subtree:true,childList:true});});
  await play.click();const audios=page.locator('app-overlay-sound audio');await until(()=>audios.count().then(n=>n===2),'one player per sound');
  const audio=audios.nth(0),late=audios.nth(1);
  await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.7),'actual preview playback');
  assert(Math.abs(await audio.evaluate(a=>a.volume)-.6)<.03,'configured volume');
  await until(()=>late.evaluate(a=>!a.paused && a.currentTime>.1),'second sound plays from its own start');
  const startedAfter=await page.evaluate(()=>window.soundLog);
  assert(startedAfter[0]>=500 && startedAfter[0]<1100,'first sound waits for its 0.6 s start: '+startedAfter[0]);assert(startedAfter[1]>=1100 && startedAfter[1]<1800,'second sound waits for its 1.2 s start: '+startedAfter[1]);
  assert.equal(await audio.evaluate(a=>!a.paused),true,'both sounds play together');assert(Math.abs(await late.evaluate(a=>a.volume)-1)<.03,'second volume');
  await audio.evaluate(a=>window.oldSound=a);await late.evaluate(a=>window.oldLate=a);await play.click();
  await until(()=>page.evaluate(()=>window.oldSound.paused && !window.oldSound.getAttribute('src') && window.oldLate.paused && !window.oldLate.getAttribute('src')),'replay stops old audio');
  const published=structuredClone(ctx.state.scenes[0].published);await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save sound');
  const body=ctx.bodies[0];assert.equal(body.writer,2,'new editor marks its saves');assert.equal(JSON.stringify(body.designs).includes('"sound":'),false,'the legacy sound key is never sent');
  assert.deepEqual(body.designs[0].events.follow.sounds,[{id:'sound-1',assetId:'3'.repeat(24),name:'Uploaded.wav',volume:.6,delay:.6,fadeIn:.5,fadeOut:1},{id:'sound-2',assetId:'1'.repeat(24),name:'Chime.wav',volume:1,delay:1.2,fadeIn:0,fadeOut:0}]);
  assert.deepEqual(ctx.state.designs[0].events.follow.sound,{assetId:'3'.repeat(24),name:'Uploaded.wav',volume:.6,delay:.6,fadeIn:.5,fadeOut:1},'API mirror for old OBS pages');
  assert.equal(ctx.state.designs[0].events.sub.sounds,undefined);assert.deepEqual(ctx.state.scenes[0].published,published);
  await page.reload();await page.locator('.stage').waitFor();await page.locator('.design-row__actions button').first().click();
  await until(()=>rows.count().then(n=>n===2),'two sounds after reload (mirror ignored)');
  assert.equal(await first.locator('input[type=range]').inputValue(),'60');
  await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].events.follow.sounds?.[0]?.volume===.6,'publish sound');
  await axe(page,'sound '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await controls.scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/alert-sound-${options.width}.png`,fullPage:true});}
  // A new file for the second sound keeps its timing.
  await second.locator('.sound__main').click();await second.getByRole('button',{name:es?'Cambiar sonido':'Change sound',exact:true}).click();
  await dialog.locator('.asset').filter({hasText:'Uploaded.wav'}).click();await dialog.locator('.use').click();await dialog.waitFor({state:'detached'});
  await until(()=>second.locator('.sound__name').innerText().then(v=>v==='Uploaded.wav'),'replaced file');assert.equal(await second.locator('input[type=number]').first().inputValue(),'1.2','replacing keeps the timing');
  await controls.getByRole('button',{name:(es?'Quitar sonido':'Remove sound')+' · Uploaded.wav',exact:true}).first().click();await until(()=>rows.count().then(n=>n===1),'remove one sound');
  await controls.getByRole('button',{name:(es?'Quitar sonido':'Remove sound')+' · Uploaded.wav',exact:true}).click();await until(()=>rows.count().then(n=>n===0),'remove last sound');
  await controls.getByText(es?'Aún no hay sonidos':'No sounds yet',{exact:false}).waitFor();
  await context.close();
 }
 console.log('PASS sounds panel: picker/filter/upload, two sounds with own timings both playing in the replay, volume/delay/fades, writer 2 + sounds-only save, API mirror ignored on reload, publish, replace keeps timing, remove, mobile/desktop EN/ES and axe');
 // Ten sounds: Add is disabled with a reason.
 {
  // The first sound's id is `add`, a valid id: "Change sound" on it must replace it, never append.
  const state=initialState();state.designs[0].events.follow.sounds=Array.from({length:10},(_,i)=>({id:i?'s'+i:'add',assetId:'1'.repeat(24),name:'Chime '+i+'.wav',volume:1,delay:i*.2,fadeIn:0,fadeOut:0}));
  const {context,page}=await fixture({state,width:390,touch:true});await page.locator('.design-row__actions button').first().click();
  const controls=page.locator('app-overlay-sounds');await controls.locator('.sound').nth(9).waitFor();
  const add=controls.getByRole('button',{name:'Add sound',exact:true});assert.equal(await add.isDisabled(),true,'add disabled at 10');
  assert.equal(await add.getAttribute('aria-describedby'),'sounds-full');assert.match(await controls.locator('#sounds-full').innerText(),/Up to 10 sounds/);
  assert.equal(await page.locator('app-overlay-timeline [data-track^="$sound:"]').count(),10,'ten timeline rows');
  for(const box of await controls.locator('.sound__main, .sound__remove').evaluateAll(n=>n.map(e=>e.getBoundingClientRect().height)))assert(box>=44,'finger-sized rows '+box);
  const first=controls.locator('.sound').first();await first.getByRole('button',{name:'Change sound',exact:true}).click();
  const dialog=page.locator('app-asset-library-dialog');await dialog.locator('.asset').filter({hasText:'Second.wav'}).click();await dialog.locator('.use').click();await dialog.waitFor({state:'detached'});
  await until(()=>first.locator('.sound__name').innerText().then(v=>v==='Second.wav'),'sound with id add replaced');
  assert.equal(await controls.locator('.sound').count(),10,'replaced, not appended');assert.equal(await first.locator('input[type=number]').first().inputValue(),'0','timing kept');
  assert.equal(await overflow(page),false);await context.close();
 }
 console.log('PASS ten sounds: Add disabled with its reason, ten timeline rows, 44px rows on a phone; Change sound on a sound with id `add` replaces it');
 // A layout saved before several sounds existed (only `sound`) loads, plays and saves as `sounds`.
 {
  const state=initialState();state.designs[0].events.follow.sound={assetId:'1'.repeat(24),name:'Chime.wav',volume:.8,delay:.2,fadeIn:0,fadeOut:0};
  const {context,page,ctx}=await fixture({state});await page.locator('.design-row__actions button').first().click();
  const controls=page.locator('app-overlay-sounds');await until(()=>controls.locator('.sound').count().then(n=>n===1),'legacy sound listed');
  assert.equal(await controls.locator('.sound__name').innerText(),'Chime.wav');assert.equal(await page.locator('app-overlay-timeline [data-track="$sound:sound"]').count(),1,'legacy sound row');
  await controls.locator('input[type=range]').fill('50');
  await openStudio(page,'test');await page.locator('.tester').getByRole('button',{name:'Preview',exact:false}).last().click();
  const audio=page.locator('app-overlay-sound audio');await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.2),'legacy sound plays');assert(Math.abs(await audio.evaluate(a=>a.volume)-.5)<.03);
  await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save legacy');
  assert.deepEqual(ctx.bodies[0].designs[0].events.follow.sounds,[{id:'sound',assetId:'1'.repeat(24),name:'Chime.wav',volume:.5,delay:.2,fadeIn:0,fadeOut:0}]);
  assert.equal('sound' in ctx.bodies[0].designs[0].events.follow,false,'saved as sounds only');
  await context.close();
 }
 console.log('PASS legacy single sound: listed, timeline row $sound:sound, plays, saves as sounds with writer 2');
 // Recovery copies: one from the previous editor (no marker) merges its `sound` edits; this editor's own copies keep `sounds`.
 {
  const base0=initialState(),design=structuredClone(base0.designs[0]),sound=(id,asset,name,volume,delay)=>({...(id?{id}:{}),assetId:asset.repeat(24),name,volume,delay,fadeIn:0,fadeOut:0});
  design.events.follow.sounds=[sound('a','1','Chime.wav',1,0),sound('b','5','Second.wav',.4,1)];design.events.follow.sound=sound(null,'3','Uploaded.wav',.3,.5);
  design.events.bits.sounds=[sound('x','1','Chime.wav',1,0),sound('y','5','Second.wav',.7,.3)];
  design.events.sub.sound=sound(null,'1','Chime.wav',.9,0);
  const draft={schemaVersion:1,channelID:user.id,updatedAt:Date.now(),revision:4,sceneId:'main',designEvent:'follow',selectedId:'alert-1',variantId:null,designDraft:null,
   scenes:base0.scenes.map(({publicId:_p,published:_pub,revision:_r,...scene})=>scene),designs:[design]};
  const {context,page,ctx}=await fixture({draft});
  await page.getByRole('button',{name:'Restore local draft',exact:true}).first().click();
  await page.locator('.design-row__actions button').first().click();
  const controls=page.locator('app-overlay-sounds');await until(()=>controls.locator('.sound').count().then(n=>n===2),'merged follow sounds');
  assert.deepEqual(await controls.locator('.sound__name').allInnerTexts(),['Uploaded.wav','Second.wav'],'old editor edit replaced the first sound');
  await page.locator('.save-button').click();await until(()=>ctx.writes===1,'save restored draft');
  const events=ctx.bodies[0].designs[0].events;assert.equal(ctx.bodies[0].writer,2);
  assert.deepEqual(events.follow.sounds,[sound('a','3','Uploaded.wav',.3,.5),sound('b','5','Second.wav',.4,1)]);
  assert.deepEqual(events.bits.sounds,[sound('y','5','Second.wav',.7,.3)],'old editor removed its sound: first dropped');
  assert.deepEqual(events.sub.sounds,[sound('sound','1','Chime.wav',.9,0)]);assert.equal(JSON.stringify(events).includes('"sound":'),false);
  // This editor's copy: marked, sounds only, and restored as written (nothing dropped).
  await until(()=>controls.locator('input[type=range]').first().isEnabled(),'save finished');await controls.locator('input[type=range]').first().fill('20');
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('domdimabot-overlay-draft:') && !k.endsWith('00000000-0000-4000-8000-000000000000')));
  const copy=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('domdimabot-overlay-draft:') && !k.endsWith('00000000-0000-4000-8000-000000000000')))));
  assert.equal(copy.writer,2,'own copies are marked');assert.equal(copy.designDraft.events.follow.sounds.length,2);assert.equal('sound' in copy.designDraft.events.follow,false);
  await page.reload();await page.locator('.stage').waitFor();
  // The copy was written with the design open, so restoring reopens it.
  await page.getByRole('button',{name:'Restore local draft',exact:true}).first().click();
  await until(()=>controls.locator('.sound').count().then(n=>n===2),'own copy keeps both sounds');
  assert.equal(await controls.locator('.sound__text small').first().innerText(),'20% · starts at 0.5 s');
  await context.close();
 }
 console.log('PASS draft recovery: previous-editor copy merges sound edits (replace first, drop first, legacy only), own copies marked writer 2 and restored intact');
 // Sound end: it has stopped (fade-out finished) at `end`, in the timeline transport and in a design preview.
 {
  const withSound=sound=>{const state=initialState();state.designs[0].events.follow.sound={assetId:'1'.repeat(24),name:'Chime.wav',volume:.8,...sound};return state;};
  const {context,page}=await fixture({state:withSound({delay:.5,fadeIn:0,fadeOut:.6,end:2})});
  await page.locator('.design-row__actions button').first().click();
  const timeline=page.locator('app-overlay-timeline');await timeline.waitFor();const audio=page.locator('app-overlay-sound audio');
  const clock=async()=>parseFloat(await timeline.locator('output').innerText());
  // Start the timeline transport at 0 (as scrubbing does), then play it.
  await timeline.locator('input[type=range]').fill('0');await audio.waitFor({state:'attached'});await until(()=>audio.evaluate(a=>a.readyState>0),'timeline audio ready');
  await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused),'timeline plays the sound',400);
  await until(()=>clock().then(t=>t>=1.75),'timeline near the end',400);const fading=await audio.evaluate(a=>a.volume);
  assert(fading<.8*.6,'fade-out ramps toward the end: '+fading);
  await until(()=>audio.evaluate(a=>a.paused),'timeline sound stops at its end',400);const stoppedAt=await clock();
  assert(stoppedAt>=1.95 && stoppedAt<2.3,'timeline stops at end: '+stoppedAt);
  assert(await clock()<5,'alert still playing');await page.waitForTimeout(300);assert.equal(await audio.evaluate(a=>a.paused),true,'stays stopped after its end');
  await timeline.locator('.primary').click();
  // Scrubbing past the end and playing stays silent; before the end it plays again.
  await timeline.locator('input[type=range]').fill('2.5');await timeline.locator('.primary').click();await page.waitForTimeout(400);assert.equal(await audio.evaluate(a=>a.paused),true,'silent after its end');
  await timeline.locator('.primary').click();await timeline.locator('input[type=range]').fill('1');await timeline.locator('.primary').click();await until(()=>audio.evaluate(a=>!a.paused),'plays again before its end',400);
  await timeline.locator('.primary').click();await timeline.locator('.primary').waitFor();
  // Design preview (the same component OBS uses, without the timeline clock).
  await timeline.locator('button').filter({hasText:'Exit timeline preview'}).click().catch(()=>{});
  await openStudio(page,'test');const preview=page.locator('.tester').getByRole('button',{name:'Preview',exact:false}).last();
  await preview.click();await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.2),'design preview plays the sound',400);
  const began=Date.now()-await audio.evaluate(a=>a.currentTime*1000)-500;
  await until(()=>audio.evaluate(a=>a.paused),'design preview sound stops at its end',400);const live=(Date.now()-began)/1000;
  assert(live>1.8 && live<2.5,'design preview stops near its end: '+live);
  assert(await page.locator('.stage app-overlay-scene-renderer .placement[data-kind=text]').count()>0,'alert still showing');
  await context.close();
  // A sound whose start is at or after its end stays silent.
  const silent=await fixture({state:withSound({delay:1,fadeIn:0,fadeOut:0,end:1})});
  await silent.page.locator('.design-row__actions button').first().click();const t2=silent.page.locator('app-overlay-timeline');await t2.waitFor();
  await t2.locator('input[type=range]').fill('0');const a2=silent.page.locator('app-overlay-sound audio');await a2.waitFor({state:'attached'});await until(()=>a2.evaluate(a=>a.readyState>0),'silent audio ready');
  await t2.locator('.primary').click();await silent.page.waitForTimeout(1800);assert.equal(await a2.evaluate(a=>a.paused),true,'start at its end: silent');
  await silent.context.close();
 }
 console.log('PASS sound end: fade-out ramp, stops at end in the timeline transport (play, scrub past, replay before) and in a design preview while the alert plays; start at end is silent');
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
 await until(()=>audio.evaluate(a=>!a.paused && a.currentTime>.15),'runtime playback');assert.match(await audio.getAttribute('src'),/^blob:/,'runtime sound plays from prepared local bytes');
 const early=await audio.evaluate(a=>a.volume);assert(early<.8,'fade in');await until(()=>audio.evaluate(a=>a.currentTime>1),'full volume');assert(Math.abs(await audio.evaluate(a=>a.volume)-.8)<.1);
 await until(()=>audio.evaluate(a=>a.currentTime>2),'fade out');assert(await audio.evaluate(a=>a.volume)<.6);
 await audio.evaluate(a=>window.lastSound=a);await until(()=>ended.includes('sound-event'),'normal alert completes');assert.equal(await page.evaluate(()=>window.lastSound.paused && !window.lastSound.getAttribute('src')),true,'natural cleanup');
 send('overlay-event',{id:'skip-sound',kind:'follow'});await audio.waitFor({state:'attached'});await until(()=>audio.evaluate(a=>!a.paused),'second sound');await audio.evaluate(a=>window.lastSound=a);
 send('overlay-control',{id:'skip-command',action:'skip',platform:'all',eventIds:['skip-sound']});await until(()=>ended.includes('skip-sound'),'skip');assert.equal(await page.evaluate(()=>window.lastSound.paused && !window.lastSound.getAttribute('src')),true,'skip cancels audio');
 fail=true;send('overlay-event',{id:'missing-sound',kind:'follow'});await page.locator('[data-event=follow]').first().waitFor();await until(()=>ended.includes('missing-sound'),'missing sound does not block queue');
 await context.close();assert.deepEqual(errors,[]);console.log('PASS OBS audio (legacy `sound` layout): deduplicated placements, scoped assets, autoplay retry, real fades, duration bound, skip cleanup and failed audio queue completion');
 // OBS: two sounds with their own timings (the API's mirror `sound` is ignored when `sounds` is present).
 {
  const two={duration:3,widgets:[layer('text','text',0,0,600,150,{text:'Two sounds'})],sounds:[{id:'a',assetId:'1'.repeat(24),volume:.8,delay:.1,fadeIn:0,fadeOut:0},{id:'b',assetId:'5'.repeat(24),volume:.5,delay:1,fadeIn:0,fadeOut:0}],sound:{assetId:'1'.repeat(24),volume:.8,delay:.1,fadeIn:0,fadeOut:0}};
  const context=await browser.newContext({viewport:{width:1280,height:720}});let socket;const ended=[];const assetsAsked=new Set();
  const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
  await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:{id:url.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{sound:two}}}});if(url.pathname.includes('/assets/')){assetsAsked.add(url.pathname.split('/').at(-1));return waveResponse(route);}return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);await page.locator('.canvas').waitFor();
  send('overlay-event',{id:'two-sounds',kind:'follow'});const audios=page.locator('app-overlay-sound audio');await until(()=>audios.count().then(n=>n===2),'two players, mirror ignored');
  await until(()=>audios.nth(0).evaluate(a=>!a.paused && a.currentTime>.2),'first sound plays');assert.equal(await audios.nth(1).evaluate(a=>a.paused),true,'second waits for 1 s');
  await until(()=>audios.nth(1).evaluate(a=>!a.paused && a.currentTime>.1),'second sound plays');assert.equal(await audios.nth(0).evaluate(a=>!a.paused),true,'both together');
  assert(Math.abs(await audios.nth(1).evaluate(a=>a.volume)-.5)<.05,'second volume');assert.deepEqual([...assetsAsked].sort(),['1'.repeat(24),'5'.repeat(24)],'every sound asset prepared');
  assert.match(await audios.nth(1).getAttribute('src'),/^blob:/,'prepared local bytes');
  await until(()=>ended.includes('two-sounds'),'two-sound alert completes');await context.close();assert.deepEqual(errors,[]);
 }
 console.log('PASS OBS: two sounds with own start times both play from prepared bytes; the mirror sound is not played twice');
} finally {await browser.close();}
