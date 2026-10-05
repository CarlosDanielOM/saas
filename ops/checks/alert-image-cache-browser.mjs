// Isolated public renderer: no production events, assets or WebSockets.
import assert from 'node:assert/strict';
const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const publicId = 'c'.repeat(48);
const widget = { id: 'picture', kind: 'image', assetId: 'first', visible: true, locked: false, x: 0, y: 0, width: 160, height: 160 };
let layout = { duration: .7, widgets: [widget, { ...widget, id: 'text', kind: 'text', assetId: undefined, x: 160, text: 'Thanks for following!' }] };
let snapshot = { width: 640, height: 360, waitFor: ['follow'], widgets: [{ ...widget, id: 'alert', kind: 'alert', designId: 'design', events: ['follow'], width: 320 }], designs: [{ id: 'design', width: 320, height: 160, events: { follow: layout } }] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i=0;i<240;i++) { if(await fn()) return; await sleep(25); } throw Error(label); }
try {
 for (const width of [390, 1280]) {
  layout.widgets[0].assetId = 'first';
  const context = await browser.newContext({viewport:{width,height:720}});
  let socket; const ended=[], calls=[], held=new Map(), errors=[];
  const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
  await context.routeWebSocket('**/*', ws => {
   if (!ws.url().includes('/socket.io/')) return ws.close(); socket=ws;
   ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
   ws.onMessage(raw => { const m=String(raw); if(m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state',{revision:1,snapshot}); }
    if(m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]); });
  });
  await context.route('**/*', async route => {
   const u=new URL(route.request().url());
   if(u.origin===new URL(base).origin) return route.continue();
   if(u.pathname.includes('/assets/')) { const id=u.pathname.split('/').at(-1); calls.push(id); if(id==='broken') return route.fulfill({status:404}); held.set(id,route); return; }
   if(u.pathname.includes('/events/')) return route.fulfill({json:{data:{id:u.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{design:layout}}}});
   return route.abort();
  });
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/overlays/'+publicId);
  await until(()=>held.has('first'),'image must preload before a follow');
  send('overlay-event',{id:'cold',kind:'follow'});
  await sleep(200); assert.equal(await page.locator('[data-event=follow]').count(),0,'wait for image before animation/text');
  await held.get('first').fulfill({contentType:'image/png',body:png});
  const image=page.locator('[data-event=follow] img'); await image.waitFor();
  assert.equal(await image.getAttribute('loading'),'eager'); assert.match(await image.getAttribute('src'),/^blob:/);
  await until(()=>image.evaluate(e=>e.complete && e.naturalWidth===1),'decoded image');
  await until(()=>ended.includes('cold'),'first completes');
  send('overlay-event',{id:'warm',kind:'follow'}); await image.waitFor();
  assert.equal(calls.filter(x=>x==='first').length,1,'repeat alert uses local bytes');
  await page.screenshot({path:`/tmp/alert-image-cache-${width}.png`,omitBackground:true});
  await until(()=>ended.includes('warm'),'repeat completes');
  // A changed publication starts warming its new image. Skip while loading must stay skipped.
  layout.widgets[0].assetId='second'; send('overlay-state',{revision:2,snapshot});
  await until(()=>held.has('second'),'new published image warmed');
  send('overlay-event',{id:'skip-loading',kind:'follow'}); await sleep(150);
  send('overlay-control',{id:'skip',action:'skip',eventIds:['skip-loading']});
  await until(()=>ended.includes('skip-loading'),'skip acknowledged while preparing');
  await held.get('second').fulfill({contentType:'image/png',body:png}); await sleep(150);
  assert.equal(await image.count(),0,'skipped event does not reappear');
  send('overlay-event',{id:'new-picture',kind:'follow'}); await image.waitFor();
  assert.equal(calls.filter(x=>x==='second').length,1); await until(()=>ended.includes('new-picture'),'updated completes');
  layout.widgets[0].assetId='broken'; send('overlay-state',{revision:3,snapshot});
  send('overlay-event',{id:'failure',kind:'follow'});
  await page.locator('[data-event=follow]').waitFor(); await until(()=>ended.includes('failure'),'bad image does not block queue');
  send('overlay-revoked'); await until(async()=>await page.locator('.canvas').count()===0,'revoked renderer cleared');
  assert.deepEqual(errors,[]); await context.close();
 }
 console.log('PASS alert image prewarm, decoded/eager rendering, repeat reuse, publication refresh, skip during load, failure fallback and revocation at mobile/desktop sizes');
} finally { await browser.close(); }
