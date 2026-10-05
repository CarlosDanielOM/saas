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
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, { duration: 1, sound:{assetId:'sound',volume:0,delay:0,fadeIn:0,fadeOut:0}, widgets: [layer(k + '-art', 'image', 50, 50, 120, 120, {assetId:k, motion:{enter:'fade',exit:'fade',loop:'none',delay:0,enterDuration:.2,exitDuration:.2,loopDuration:1}}), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48, motion:{enter:'fade',exit:'fade',loop:'none',delay:0,enterDuration:.2,exitDuration:.2,loopDuration:1} })] }])) };
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
  const ctx = { images: [], state: initialState(), writes: 0, sources: 1, tests: [], conflict: false, recoveries: [], failRecovery: false };
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if(url.hostname==='fixture.invalid')return route.fulfill({contentType:'audio/wav',body:wave});
    if (url.origin !== api) return route.abort();
    let data = {}; const body = req.postDataJSON?.();
    if(url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access')) return route.fulfill({json:{data:{path:'/asset-library/content/'+url.pathname.split('/').at(-2)}}});
    if(url.pathname.startsWith('/asset-library/content/')) { if(url.pathname.endsWith('/sound')) return route.fulfill({contentType:'audio/wav',body:wave}); ctx.images.push({id:url.pathname.split('/').at(-1),route}); return; }
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

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const motions=page=>page.locator('.stage').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-object')).length);
async function release(ctx,id) { const matches=ctx.images.filter(i=>i.id===id); assert(matches.length); for(const item of matches) await item.route.fulfill({contentType:'image/png',body:png}); ctx.images=ctx.images.filter(i=>i.id!==id); }
try {
 for(const width of [390,1280]) {
  // Scene event uses a different layout from the idle thumbnail; inspect the newly mounted image.
  let f=await fixture({width});
  await f.page.locator('.test-btn').filter({hasText:'Follow'}).click();
  await until(()=>f.ctx.images.some(i=>i.id==='follow'),'follow image requested');
  await sleep(200); assert.equal(await motions(f.page),0,'animation must not start while image downloads'); await sleep(1000);
  assert.equal(await f.page.locator('.stage .is-preview').count(),0,'scene timer and animation must wait');
  assert.equal(await motions(f.page),0,'no scene motion before image');
  assert.equal(await f.page.locator('app-overlay-sound').count(),0,'no sound before image');
  await release(f.ctx,'follow');
  await f.page.locator('.stage .is-preview').waitFor();
  assert(await motions(f.page)>0); await sleep(450);
  assert.equal(await f.page.locator('.stage .is-preview').count(),1,'full duration starts after readiness');
  await until(async()=>await f.page.locator('.stage .is-preview').count()===0,'scene completes');
  await f.context.close();
  // Design editor replay must wait for the existing displayed image, not a second download.
  f=await fixture({width});
  await f.page.locator('.design-row__actions button').first().click();
  const preview=f.page.getByRole('button',{name:'Preview Follows',exact:true});
  await preview.click(); await until(()=>f.ctx.images.some(i=>i.id==='follow'),'design image requested');
  await sleep(200); assert.equal(await motions(f.page),0,'animation must not start while image downloads'); await sleep(1000); assert.equal(await motions(f.page),0,'design animation waits');
  assert.equal(await f.page.locator('app-overlay-sound').count(),0,'design sound waits');
  await release(f.ctx,'follow'); await until(async()=>await motions(f.page)>0,'design starts after image');
  assert.equal(await f.page.locator('.stage [data-kind=image] img').getAttribute('loading'),'eager');
  await f.page.screenshot({path:`/tmp/studio-image-ready-${width}.png`});
  await until(async()=>await f.page.locator('.stage .is-preview').count()===0,'design duration completes');
  await f.context.close();
  f=await fixture({width});
  await f.page.locator('.design-row__actions button').first().click();
  await f.page.getByRole('button',{name:'Preview Follows',exact:true}).click();
  await until(()=>f.ctx.images.some(i=>i.id==='follow'),'pending image before cancellation');
  await f.page.locator('.design-event-tabs').getByRole('button',{name:'Subscriptions',exact:true}).click();
  await release(f.ctx,'follow'); await sleep(200);
  assert.equal(await motions(f.page),0,'switching event cancels pending preview');
  assert.equal(await f.page.locator('.stage .is-preview').count(),0,'old preview never starts');
  await f.context.close();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS Studio scene and design preview: delayed signed image holds animation, sound and full duration; eager displayed images at mobile/desktop sizes');
} finally { await browser.close(); }
