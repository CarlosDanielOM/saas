import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), assetId = 'b'.repeat(24);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const user = { id:'990091', login:'fixture', display_name:'Fixture' };
const app = { name:'Fixture', language:'en', plan_tier:'pro', actived:true, twitch_user_id:user.id, has_permissions:true, up_to_date_permissions:true, administrating:[] };
const text = { id:'follow-text', kind:'text', x:270, y:60, width:230, height:150, visible:true, locked:false, text:'$(user) nos ha seguido, bienvenido!' };
const art = { id:'follow-art', kind:'image', x:80, y:50, width:190, height:160, visible:true, locked:false, assetId };
const design = { id:'starter', name:'My alerts', width:800, height:240, revision:1, events:Object.fromEntries(['follow','sub','bits','raid'].map(k=>[k,{duration:10,widgets:[art,text]}])) };
const scene = { id:'main', name:'My overlay', width:1920, height:1080, revision:1, publicId, waitFor:[], widgets:[{id:'alert-1',kind:'alert',x:110,y:800,width:640,height:192,visible:true,locked:false,designId:'starter',events:['sub','bits']}] };
scene.published = structuredClone({width:scene.width,height:scene.height,widgets:scene.widgets,waitFor:[],designs:[design]});
scene.published.designs[0].events.follow.widgets=[{...text,text:'$(user)'}];
let state = {schemaVersion:1,revision:1,designs:[design],scenes:[scene]}, tests=0;
const artwork = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1042" height="1024"><rect width="1042" height="1024" fill="#7c3aed"/></svg>');
try {
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  await context.addInitScript(({user,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,createdAt:new Date().toISOString(),token:'fixture-only',expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}})),{user,app});
  await context.routeWebSocket('**/*',ws=>ws.close());
  await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.origin===new URL(base).origin)return route.continue();
    if(u.origin!==api)return route.abort();
    let data={};
    if(u.pathname.startsWith('/asset-library/content/'))return route.fulfill({body:artwork,contentType:'image/svg+xml'});
    if(u.pathname.startsWith('/asset-library/') && u.pathname.endsWith('/access')) data={path:'/asset-library/content/'+assetId+'?ticket=fixture'};
    else if(u.pathname==='/auth/session')data={twitch:user,app};
    else if(u.pathname.includes('/access'))data={allowed:true,role:'owner',planTier:'pro'};
    else if(u.pathname.endsWith('/preview'))data=r.postDataJSON().texts.map(t=>t.replace('$(user)','Luna'));
    else if(u.pathname===`/overlay-studio/${user.id}`){
      if(r.method()==='PUT'){state=structuredClone(r.postDataJSON());state.revision++;state.designs.forEach(d=>d.revision++);}
      data=state;
    } else if(u.pathname.endsWith('/publish')){
      assert.equal(r.postDataJSON().revision,state.revision);
      const s=state.scenes[0];s.revision++;s.published=structuredClone({width:s.width,height:s.height,widgets:s.widgets,waitFor:s.waitFor,designs:state.designs});state.revision++;data=state;
    } else if(u.pathname.endsWith('/test-alert')){tests++;data={sent:true,clients:1};}
    else if(u.pathname.endsWith('/connections'))data={checkedAt:Date.now(),pollingFailed:false,scenes:[]};
    else if(u.pathname.endsWith('/queue'))data={state:{revision:0,all:false,platforms:{}},events:[],connected:0,needsRefresh:0};
    return route.fulfill({json:{data}});
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/fixture/modules/overlays');await page.locator('.stage').waitFor();
  await page.locator('.publish-status').waitFor();
  await page.locator('.publish-settings summary').click();
  await page.getByRole('button',{name:'Send test alert to OBS',exact:true}).click();
  await page.getByRole('alert').getByText('Publish this overlay’s changes before sending a test to OBS.',{exact:true}).waitFor();assert.equal(tests,0);
  await page.getByRole('button',{name:'Edit design',exact:true}).click();
  await page.locator('.event-disabled').getByText('Follows is not enabled for this design in “My overlay”. Editing the design does not enable the event.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.stage img')?.naturalWidth>0);
  await page.waitForFunction(()=>document.querySelector('.text-preview')?.textContent==='Luna nos ha seguido, bienvenido!');
  const metrics=async locator=>locator.evaluate(e=>{const span=e.querySelector('span'),r=span.getBoundingClientRect(),host=e.getBoundingClientRect();return {color:getComputedStyle(span).color,font:parseFloat(getComputedStyle(span).fontSize),scale:r.height/span.offsetHeight,hostWidth:host.width,textHeight:r.height,hostHeight:host.height};});
  const editorMetrics=await metrics(page.locator('.text-preview'));
  assert.equal(editorMetrics.font,40);assert.equal(editorMetrics.color,'rgb(255, 255, 255)');
  assert(Math.abs(editorMetrics.scale-editorMetrics.hostWidth/230)<.02,'text must scale with its design box');
  assert(editorMetrics.textHeight<=editorMetrics.hostHeight+1,'the follower text fits without clipping');
  const frozen=structuredClone(state.scenes[0].published);
  await page.getByLabel('Text template',{exact:true}).fill('$(user) welcome!');
  await page.getByRole('button',{name:'Save design',exact:true}).click();await page.getByRole('button',{name:'Saved',exact:true}).waitFor();
  assert.equal(state.designs[0].events.follow.widgets[1].text,'$(user) welcome!');assert.deepEqual(state.scenes[0].published,frozen);
  await page.reload();await page.locator('.stage').waitFor();await page.getByRole('button',{name:'Edit design',exact:true}).click();
  assert.equal(await page.getByLabel('Text template',{exact:true}).inputValue(),'$(user) welcome!');
  await page.getByRole('button',{name:'Enable Follows in this overlay',exact:true}).click();await page.locator('.event-disabled').waitFor({state:'detached'});
  await page.getByLabel('Text template',{exact:true}).fill('$(user) nos ha seguido, bienvenido!');
  await page.getByRole('button',{name:'Save & publish live',exact:true}).click();
  await page.getByText('Published. Connected browser sources are updating.',{exact:true}).waitFor();
  await page.locator('.publish-status').waitFor({state:'detached'});
  assert(state.scenes[0].published.widgets[0].events.includes('follow'));
  assert.equal(state.scenes[0].published.designs[0].events.follow.widgets[1].text,text.text);
  for(const width of [320,375,768,1440]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
    await page.waitForTimeout(100);
    const m=await metrics(page.locator('.text-preview'));assert(Math.abs(m.scale-m.hostWidth/230)<.02);
  }
  if(process.env.SAAS_SCREENSHOT_DIR){await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SAAS_SCREENSHOT_DIR+'/alerts-desktop.png',fullPage:true});await page.setViewportSize({width:375,height:1000});await page.screenshot({path:process.env.SAAS_SCREENSHOT_DIR+'/alerts-mobile.png',fullPage:true});}
  await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
  const axe=await page.evaluate(()=>window.axe.run(document.querySelector('app-overlay-editor'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(axe.violations.map(v=>v.id),[]);
  await page.getByRole('button',{name:'Save & back to overlay',exact:true}).click();
  await page.locator('.publish-settings summary').click();
  await page.getByRole('button',{name:'Send test alert to OBS',exact:true}).click();
  await page.getByText('Test alert sent to connected published overlays.',{exact:true}).waitFor();assert.equal(tests,1);
  await context.close();
  console.log('PASS draft persistence, disabled-event feedback, explicit enable + save/publish, OBS test guard, image loading, proportional text and mobile/desktop accessibility.');
  const runtime=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});let socket,broken=false;const ended=[];
  const snapshot=structuredClone(state.scenes[0].published);
  await runtime.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
  function send(name,value){socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);}
  await runtime.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===new URL(base).origin)return route.continue();if(u.pathname.includes('/assets/'))return route.fulfill(broken?{status:404,body:''}:{body:artwork,contentType:'image/svg+xml'});if(u.pathname.includes('/events/'))return route.fulfill({json:{data:{id:u.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{starter:{duration:10,widgets:[art,{...text,text:'CDOM201 nos ha seguido, bienvenido!'}]}}}}});return route.abort();});
  const source=await runtime.newPage();source.on('pageerror',e=>errors.push(e.message));await source.goto(base+'/overlays/'+publicId);await source.locator('.canvas').waitFor();
  send('overlay-event',{id:'follow-good',kind:'follow'});await source.waitForFunction(()=>document.querySelector('[data-event="follow"] img')?.naturalWidth>0);
  const imageBounds=await source.locator('[data-event="follow"] img').evaluate(e=>({image:e.getBoundingClientRect().height,box:e.closest('app-overlay-layer').getBoundingClientRect().height}));
  assert(imageBounds.image<=imageBounds.box+1,'full-size images must fit the saved box without cropping');
  const liveText=source.locator('[data-event="follow"] app-overlay-layer').filter({hasText:'CDOM201 nos ha seguido, bienvenido!'});
  const m=await metrics(liveText);assert(Math.abs(m.scale-.8)<.02);assert(m.textHeight<=m.hostHeight+1);
  assert.equal(m.color,editorMetrics.color);assert(m.font<=editorMetrics.font && m.font>=8,'long names shrink within the requested font size');
  broken=true;send('overlay-event',{id:'follow-broken',kind:'follow'});await source.waitForTimeout(500);
  assert.equal(await source.locator('[data-event="follow"]').count(),2,'a failed image must not remove the follower text or end the alert');assert(!ended.includes('follow-broken'));
  assert.deepEqual(errors,[]);await runtime.close();
  console.log('PASS OBS matches design text layout, loads scoped images, and retains text for the alert duration when an image fails.');
} finally {await browser.close();}
