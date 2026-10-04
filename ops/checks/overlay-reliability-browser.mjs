// Overlay reliability: isolated playable previews, confirmed scene-scoped OBS tests,
// conflict recovery and retry, responsive EN/ES controls, and accessibility.
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
 for (const options of [{width:1280},{width:390,dark:true,touch:true},{width:320,lang:'es',touch:true}]) {
  const {context,page,ctx}=await fixture(options);
  const spanish=options.lang==='es';
  // Preview uses the private test endpoint. It never opens legacy clip/TTS namespaces.
  await page.locator('.event-tester__actions button').first().click();
  await until(()=>ctx.tests.length===1,'preview request');
  assert.equal(ctx.tests[0].kind,'tts');assert.equal(ctx.tests[0].destination,'preview');
  await page.locator('app-overlay-media video').first().waitFor();
  assert.equal(await page.locator('app-overlay-media video').first().getAttribute('src'),'https://fixture.invalid/sample.wav');
  await until(async()=>await page.locator('app-overlay-media video').first().evaluate(v=>!v.paused&&v.currentTime>0),'actual audio playback');
  // Explicit confirmation can cancel without sending anything; accepted test targets main.
  const test=page.locator('.obs-test button');
  page.once('dialog',d=>d.dismiss());await test.click();assert.equal(ctx.tests.length,1);
  page.once('dialog',async d=>{assert(d.message().includes('Gameplay'));await d.accept();});await test.click();
  await until(()=>ctx.tests.length===2,'OBS test');assert.equal(ctx.tests[1].sceneId,'main');assert.equal(ctx.tests[1].confirmed,true);assert.equal(ctx.tests[1].destination,'obs');
  // Retain edits on conflict and on a failed recovery. Retrying reuses the request identity.
  const name=page.locator('.name-field input');await name.fill('My local changes');ctx.conflict=true;
  await page.getByRole('button',{name:spanish?'Guardar borrador':'Save draft',exact:true}).click().catch(async e=>{await page.screenshot({path:'/tmp/overlay-mobile-failure.png',fullPage:true});console.log(await page.locator('.lf-dock,.lf-save-bar,.save-button,.lf-toast').evaluateAll(es=>es.map(e=>({class:e.className,rect:JSON.stringify(e.getBoundingClientRect()),position:getComputedStyle(e).position,text:e.innerText}))));throw e;});
  const recover=page.getByRole('button',{name:spanish?'Guardar copias recuperadas':'Save as recovered copies',exact:true});await recover.waitFor();
  assert.equal(await name.inputValue(),'My local changes');ctx.failRecovery=true;await recover.click();
  await until(()=>ctx.recoveries.length===1,'failed recovery');await until(async()=>await recover.isEnabled(),'recovery finished');
  assert.equal(await name.inputValue(),'My local changes');await page.getByText('Not enough room for recovery copies',{exact:true}).waitFor();
  await axe(page,'conflict recovery');assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:`${shots}/overlay-recovery-${options.width}.png`,fullPage:true});}
  ctx.failRecovery=false;ctx.conflict=false;await recover.click();await until(()=>ctx.recoveries.length===2,'retry');
  assert.equal(ctx.recoveries[0].recoveryId,ctx.recoveries[1].recoveryId);
  await until(async()=>await name.inputValue()==='Recovered local','copy selected');
  assert.equal(ctx.state.scenes[0].name,'Gameplay');assert(ctx.state.scenes[0].published);
  assert.equal(await recover.count(),0);await axe(page,'recovered');await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS isolated real-media preview, confirmed scene-targeted OBS tests, retained conflicting edits, retry-safe recovery, mobile/desktop EN/ES and axe');
} finally { await browser.close(); }
