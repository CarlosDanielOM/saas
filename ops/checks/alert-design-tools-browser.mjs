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

try {
 for (const options of [{width:1280},{width:390,dark:true,touch:true},{width:320,lang:'es',touch:true}]) {
  const {context,page,ctx}=await fixture(options),es=options.lang==='es';
  await page.locator('.design-row__actions button').first().click();
  const appearance=page.locator('app-overlay-appearance');
  await appearance.getByRole('combobox',{name:es?'Fuente':'Font',exact:true}).selectOption('serif');
  await appearance.getByRole('combobox',{name:es?'Grosor':'Weight',exact:true}).selectOption('700');
  await appearance.getByLabel(es?'Cursiva':'Italic',{exact:true}).check();
  await appearance.getByRole('combobox',{name:es?'Alineación del texto':'Text alignment',exact:true}).selectOption('left');
  let text=page.locator('.stage .widget[data-kind=text] .layer-content span');
  await until(()=>text.evaluate(e=>getComputedStyle(e).fontWeight==='700' && getComputedStyle(e).fontStyle==='italic' && getComputedStyle(e).textAlign==='left' && getComputedStyle(e).fontFamily.includes('Georgia')),'text style');
  await appearance.locator('summary').first().click();
  await appearance.getByLabel(es?'Sombra':'Shadow',{exact:true}).check();
  await appearance.getByLabel(es?'Opacidad (%)':'Opacity (%)',{exact:true}).fill('75');await appearance.getByLabel(es?'Opacidad (%)':'Opacity (%)',{exact:true}).press('Tab');
  await until(()=>text.locator('..').evaluate(e=>getComputedStyle(e).opacity==='0.75' && getComputedStyle(e).filter.includes('drop-shadow')),'opacity/shadow');
  await page.locator('.palette-item[data-kind=shape]').click();
  await appearance.getByRole('combobox',{name:es?'Forma':'Shape',exact:true}).selectOption('ellipse');
  await appearance.getByLabel(es?'Ancho del borde':'Border width',{exact:true}).fill('4');await appearance.getByLabel(es?'Ancho del borde':'Border width',{exact:true}).press('Tab');
  await until(()=>page.locator('.stage .shape').evaluate(e=>getComputedStyle(e).borderRadius==='50%' && getComputedStyle(e).borderWidth==='4px'),'ellipse');
  await appearance.locator('summary').last().click();await appearance.getByRole('button',{name:es?'Derecha':'Right',exact:true}).click();
  await page.locator('.save-button').click();await until(()=>ctx.writes>0,'save styles');
  assert.equal(ctx.state.designs[0].events.follow.widgets.at(-1).x,500);
  await page.locator('.design-event-tabs button').nth(1).click();
  const variants=page.locator('app-overlay-variants');await variants.waitFor();
  await variants.getByRole('button',{name:es?'Añadir variante':'Add variant',exact:true}).click();
  await variants.getByLabel(es?'Nombre de variante':'Variant name').fill('Big cheers');await variants.getByLabel(es?'Nombre de variante':'Variant name').press('Tab');
  await variants.getByLabel(es?'Bits mínimos':'Minimum bits').fill('500');await variants.getByLabel(es?'Bits mínimos':'Minimum bits').press('Tab');
  await variants.getByLabel(es?'Máximo (incluido)':'Maximum (inclusive)',{exact:true}).fill('1000');await variants.getByLabel(es?'Máximo (incluido)':'Maximum (inclusive)',{exact:true}).press('Tab');
  await page.locator('.properties textarea').fill('BIG $(user)');
  const sound=page.locator('.alert-sound');await sound.getByRole('button',{name:es?'Elegir sonido':'Choose sound',exact:true}).click();
  const picker=page.locator('app-asset-library-dialog');await picker.locator('.asset').first().click();await picker.locator('.use').click();
  await sound.locator('input[type=range]').fill('35');
  const timeline=page.locator('app-overlay-timeline');
  await page.getByLabel(es?'Duración de la alerta (segundos)':'Alert length (seconds)',{exact:true}).fill('7');await page.getByLabel(es?'Duración de la alerta (segundos)':'Alert length (seconds)',{exact:true}).press('Tab');
  const timing=page.locator('details.motion-timing');await timing.evaluate(d=>{d.open=true;});await timing.locator('input').first().fill('0.7');await timing.locator('input').first().press('Tab');

  await page.locator('.palette-item[data-kind=shape]').click();
  await page.locator('.save-button').click();await until(()=>ctx.state.designs[0].variants?.bits?.[0]?.layout.widgets.length===3,'save variant');
  assert.equal(ctx.state.designs[0].events.bits.widgets.length,2,'base unaffected');
  const variant=ctx.state.designs[0].variants.bits[0];assert.equal(variant.min,500);assert.equal(variant.max,1000);assert.equal(variant.layout.sound.volume,.35);assert.equal(variant.layout.duration,7);assert.equal(variant.layout.widgets[1].motion.delay,.7);assert.equal(ctx.state.designs[0].events.bits.sound,undefined);assert.equal(variant.layout.widgets[1].text,'BIG $(user)');
  await variants.getByRole('button',{name:es?'Predeterminada':'Default',exact:true}).click();
  await until(()=>page.locator('.properties textarea').inputValue().then(v=>v==='$(user)'),'default content');
  await page.getByLabel(es?'Cantidad de ejemplo':'Sample amount',{exact:true}).fill('750');
  await page.getByRole('button',{name:es?'Cambiar a Big cheers y probar':'Switch to Big cheers & preview',exact:true}).click();
  await until(()=>variants.getByRole('button',{name:'Big cheers',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'rule preview');
  assert.equal(await page.locator('.variant-match button').count(),0,'no switch button when the match is already open');
  // Adding while a variant is open copies it (the old separate Duplicate button did the same thing).
  await variants.getByRole('button',{name:es?'Añadir variante':'Add variant',exact:true}).click();
  await until(()=>variants.locator('.tabs button').count().then(n=>n===4),'duplicate');
  await variants.getByLabel(es?'Nombre de variante':'Variant name').fill('Priority');await variants.getByLabel(es?'Nombre de variante':'Variant name').press('Tab');
  await variants.getByRole('button',{name:es?'Mover antes':'Move earlier',exact:true}).click();
  await page.locator('.save-button').click();await until(()=>ctx.state.designs[0].variants.bits[0].name==='Priority','order persisted');
  await variants.getByRole('button',{name:es?'Quitar variante':'Remove variant',exact:true}).click();
  await page.getByRole('button',{name:es?'Deshacer':'Undo',exact:true}).click();
  await until(()=>variants.getByRole('button',{name:'Priority',exact:true}).count().then(n=>n===1),'undo deletion');
  await variants.getByLabel(es?'Activada':'Enabled',{exact:true}).uncheck();
  await page.getByRole('button',{name:es?'Cambiar a Big cheers y probar':'Switch to Big cheers & preview',exact:true}).click();
  await until(()=>variants.getByRole('button',{name:'Big cheers',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'disabled priority skipped');
  await page.locator('.save-button').click();await until(()=>ctx.state.designs[0].variants.bits[0].enabled===false,'disabled saved');
  await axe(page,'designs '+options.width);assert.equal(await overflow(page),false);
  if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/designs-'+options.width+'.png',fullPage:true});}
  await page.reload();await page.locator('.design-row__actions button').first().click();await page.locator('.design-event-tabs button').nth(1).click();
  await variants.getByRole('button',{name:'Big cheers',exact:true}).click();await until(()=>page.locator('.properties textarea').inputValue().then(v=>v==='BIG $(user)'),'reload variant');

  if(options.width===1280){
    await page.locator('.properties textarea').fill('Recovered variant');
    await until(()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('domdimabot-overlay-draft:')).some(k=>JSON.parse(localStorage.getItem(k)).designDraft?.variants?.bits?.some(v=>v.layout.widgets.some(w=>w.text==='Recovered variant')))),'variant recovery copy');
    page.once('dialog',d=>d.accept());await page.reload();await page.getByRole('button',{name:'Restore local draft',exact:true}).click();
    await until(()=>page.locator('.properties textarea').inputValue().then(v=>v==='Recovered variant'),'restored selected variant');
    await page.locator('.design-event-tabs button').nth(0).click();await variants.getByRole('button',{name:'Add variant',exact:true}).click();
    await variants.getByRole('combobox',{name:'Subscription tier',exact:true}).selectOption('3000');
    await page.getByRole('combobox',{name:'Sample subscription tier',exact:true}).selectOption('3000');
    await until(()=>page.locator('.variant-match').innerText().then(t=>t.includes('This sample plays: New variant')),'tier sample');
    assert.equal(await page.locator('.variant-match button').count(),0,'matching variant already open');
    await page.locator('.design-event-tabs button').nth(3).click();await variants.getByRole('button',{name:'Add variant',exact:true}).click();
    await variants.getByLabel('Minimum raid viewers',{exact:true}).fill('50');await variants.getByLabel('Minimum raid viewers',{exact:true}).press('Tab');
    await page.getByLabel('Sample amount',{exact:true}).fill('49');await page.getByRole('button',{name:'Switch to Default & preview',exact:true}).click();
    await until(()=>variants.getByRole('button',{name:'Default',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'raid fallback');
    await page.locator('.publish-button').click();await until(()=>ctx.state.scenes[0].published.designs[0].variants?.raid?.[0]?.min===50,'published all variants');
    assert.equal(ctx.state.scenes[0].published.designs[0].variants.sub[0].tier,'3000');
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS typography, shadow, shapes, alignment, variant CRUD/order/fallback/disabled rules, preview, undo, save/reload, mobile and accessibility');
} finally {await browser.close();}
