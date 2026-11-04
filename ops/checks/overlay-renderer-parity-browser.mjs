// Compare the editor's design preview with the actual OBS renderer. All API,
// socket and media requests are intercepted; no production data is touched.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const api = 'https://api.domdimabot.com', publicId = 'd'.repeat(48), assetId = 'b'.repeat(24);
const user = { id:'990091', login:'fixture', display_name:'Fixture' };
const app = { name:'Fixture', language:'en', plan_tier:'pro', actived:true, twitch_user_id:user.id, has_permissions:true, up_to_date_permissions:true, administrating:[] };
const point = (offset,value) => ({offset,value,easing:'linear'});
const track = (property,values) => ({property,points:values.map((v,i)=>point(i/(values.length-1),v))});
const motion = {enter:'none',loop:'none',exit:'none',delay:.2,enterDuration:1,loopDuration:1.7,exitDuration:1};
const keyframes = {enter:{tracks:[track('x',[-100,0]),track('opacity',[0,1])]},loop:{tracks:[track('y',[0,-20,0]),track('scale',[1,1.2,1])]},exit:{tracks:[track('x',[0,100]),track('opacity',[1,0])]}};
const layer = (id,kind,x,y,width,height,extra={}) => ({id,kind,x,y,width,height,visible:true,locked:false,...extra});
const parts = [layer('shape','shape',20,30,180,150,{shape:'rectangle',color:'#123456',radius:12,opacity:.65,motion,keyframes}),layer('image','image',220,30,160,150,{assetId}),layer('text','text',400,30,360,150,{text:'Parity fixture',color:'#fff',fontFamily:'serif',fontSize:42,fontWeight:700,italic:true})];
const layout = {duration:6,widgets:parts};
const design = {id:'starter',name:'Parity design',width:800,height:240,revision:1,events:Object.fromEntries(['follow','sub','bits','raid'].map(k=>[k,layout]))};
const box = layer('alert','alert',100,80,800,240,{designId:'starter',events:['follow']});
const tts = [layer('tts-a','tts',100,350,400,120,{showTtsText:true}),layer('tts-b','tts',600,350,400,120,{showTtsText:true})];
const snapshot = {width:1280,height:720,waitFor:[],widgets:[box,...tts],designs:[design]};
const scene = {id:'main',name:'Parity scene',revision:1,publicId,...snapshot,published:structuredClone(snapshot)};
const state = {schemaVersion:1,revision:1,designs:[design],scenes:[scene]};
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#7c3aed"/></svg>');
const wav=Buffer.alloc(44+16000*20);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
const speech={type:'audio',url:'https://fixture.invalid/speech.wav',title:'Private title',volume:.75};
const browser = await chromium.launch({args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
const errors = [];
async function until(fn,label) { for(let i=0;i<240;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));} throw Error('Timed out: '+label); }
async function setup(width, timing=false, theme='dark') {
 const timingDesign=(id,duration)=>({...design,id,events:Object.fromEntries(['follow','bits','sub','raid'].map(k=>[k,{duration,widgets:parts}]))});
 const short=timingDesign('short',1),long=timingDesign('long',3);
 const currentSnapshot=timing?{...snapshot,widgets:[{...box,id:'short-box',designId:'short',events:['follow','bits']},{...box,id:'long-box',designId:'long',x:1050,events:['follow']}],designs:[short,long]}:snapshot;
 const currentState=timing?{...state,designs:[short,long],scenes:[{...scene,...currentSnapshot,published:currentSnapshot}]}:state;
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'no-preference',colorScheme:theme}); let socket; const ended=[];
 const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
 await context.addInitScript(({user,app,theme})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture-only',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('dimasite.language','en');localStorage.setItem('theme',theme);},{user,app,theme});
 await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot:currentSnapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
 await context.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(u.origin===new URL(base).origin)return route.continue();if(u.hostname==='fixture.invalid')return route.fulfill({body:wav,contentType:'audio/wav'});if(u.origin!==api)return route.abort();let data={};
  if(u.pathname.includes('/assets/') || u.pathname.startsWith('/asset-library/content/'))return route.fulfill({body:image,contentType:'image/svg+xml'});
  if(u.pathname.startsWith('/asset-library/') && u.pathname.endsWith('/access'))data={path:'/asset-library/content/'+assetId+'?ticket=fixture'};
  else if(u.pathname==='/auth/session')data={twitch:user,app};
  else if(u.pathname.includes('/access'))data={allowed:true,role:'owner',planTier:'pro'};
  else if(u.pathname.endsWith('/preview'))data=r.postDataJSON().texts;
  else if(u.pathname===`/overlay-studio/${user.id}`)data=currentState;
  else if(u.pathname.endsWith('/test'))data={text:'Spoken fixture text',media:speech};
  else if(u.pathname.endsWith('/connections'))data={checkedAt:Date.now(),pollingFailed:false,scenes:[]};
  else if(u.pathname.endsWith('/queue'))data={state:{revision:0,all:false,platforms:{}},events:[],connected:0,needsRefresh:0};
  else if(u.pathname.includes('/events/')){const id=u.pathname.split('/').at(-1);data=id==='speech-event'?{id,kind:'tts',text:'Spoken fixture text',snapshot:currentSnapshot,media:speech}:timing?{id,kind:id==='bits-next'?'bits':'follow',snapshot:currentSnapshot,layouts:{short:short.events.follow,long:long.events.follow}}:{id,kind:'follow',snapshot:currentSnapshot,layouts:{starter:layout}};}
  else if(u.pathname.startsWith('/overlay-studio/public/'))data={revision:1,snapshot:currentSnapshot};
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const editor=await context.newPage();editor.on('pageerror',e=>errors.push(e.message));await editor.goto(base+'/fixture/modules/overlays');await editor.locator('.stage').waitFor();
 if(timing){const source=await context.newPage();source.on('pageerror',e=>errors.push(e.message));await source.goto(base+'/overlays/'+publicId);await source.locator('app-overlay-scene-renderer').waitFor({state:'attached'});await until(()=>!!socket,'OBS socket');return {context,editor,source,send,ended};}
 await editor.getByRole('button',{name:'Edit design',exact:true}).click();
 await editor.locator('app-overlay-scene-renderer').waitFor({state:'attached'});
 await editor.locator('.stage').scrollIntoViewIfNeeded();
 await editor.getByRole('button',{name:'Play timeline',exact:true}).click();
 await editor.getByRole('button',{name:'Pause timeline',exact:true}).click();
 await editor.locator('.stage').scrollIntoViewIfNeeded();
 const source=await context.newPage();source.on('pageerror',e=>errors.push(e.message));await source.goto(base+'/overlays/'+publicId);await source.locator('app-overlay-scene-renderer').waitFor({state:'attached'});
 await until(()=>!!socket,'OBS socket');send('overlay-event',{id:'parity-event',kind:'follow'});
 await source.locator('[data-event="follow"] [data-layer-id="shape"] app-overlay-layer').waitFor();
 return {context,editor,source,send,ended};
}
// Read browser-computed animation definitions and sample the same explicit
// playhead values, avoiding wall-clock and screenshot timing tolerances.
async function sample(page,selector,time) { return page.locator(selector).evaluate((root,time)=>{
 const anims=root.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-object') || a.id.startsWith('alert-keyframe'));
 for(const a of anims){a.pause();a.currentTime=time*1000;}
 return {animations:anims.filter(a=>a.effect.getComputedTiming().progress !== null).map(a=>({id:a.id,timing:a.effect.getTiming(),frames:a.effect.getKeyframes(),style:{opacity:getComputedStyle(a.effect.target).opacity,transform:getComputedStyle(a.effect.target).transform}})).sort((a,b)=>a.id.localeCompare(b.id)),text:root.textContent.trim(),content:[...root.querySelectorAll('.layer-content')].map(e=>({opacity:getComputedStyle(e).opacity,filter:getComputedStyle(e).filter})),font:[...root.querySelectorAll('.layer-content span:not(.spark)')].map(e=>{const s=getComputedStyle(e);return [s.color,s.fontFamily,s.fontSize,s.fontWeight,s.fontStyle];})};
 },time); }
try {
 for(const theme of ['dark','light']) for(const width of [320,390,1280]) {
  const {context,editor,source,send,ended}=await setup(width,false,theme);
  const e='app-overlay-scene-renderer [data-widget-id="shape"] app-overlay-layer', o='[data-event="follow"] [data-layer-id="shape"] app-overlay-layer';
  await until(async()=>await editor.locator(e).count()>0,'editor shape');
  await until(async()=>await editor.locator(e).evaluate(el=>el.getAnimations({subtree:true}).length>0),'editor animation');
  await until(async()=>await source.locator(o).evaluate(el=>el.getAnimations({subtree:true}).length>0),'OBS animation');
  await editor.bringToFront();await editor.waitForTimeout(200);
  for(const t of [0,.5,1.5,3,5.5,6]) {
   // Set editor through the real transport, then pin both renderers to exactly
   // the same time to compare keyframes and computed intermediate transforms.
   await editor.getByLabel('Preview position (seconds)').fill(String(t));
   await editor.locator('.stage').scrollIntoViewIfNeeded();
   await editor.bringToFront();await editor.waitForTimeout(100);const a=await sample(editor,e,t);await source.bringToFront();await source.waitForTimeout(100);const b=await sample(source,o,t);
   assert(a.animations.length>0,'fixture must produce motion');assert.deepEqual(a,b,`motion/style parity at ${t}s, viewport ${width}`);
  }
  await editor.bringToFront();
  for(const part of parts) {
   // Compare placement rectangles in design coordinates despite different
   // preview/OBS viewport scales. The nested OBS parent is the alert box.
   const read=(page,selector,parent)=>page.locator(selector).evaluate((el,parent)=>{const a=el.getBoundingClientRect(),b=el.closest(parent).getBoundingClientRect();return [a.left-b.left,a.top-b.top,a.width,a.height].map((v,i)=>v/(i%2?b.height:b.width));},parent);
   const a=await read(editor,`app-overlay-scene-renderer [data-widget-id="${part.id}"]`,'.canvas');
   await source.bringToFront();const b=await read(source,`[data-event="follow"] [data-layer-id="${part.id}"]`,'[data-event="follow"]');
   await editor.bringToFront();for(let i=0;i<4;i++)assert(Math.abs(a[i]-b[i])<.005,`${part.id} normalized geometry ${i}: ${a[i]} != ${b[i]}`);
  }
  const imageEditor=editor.locator('app-overlay-scene-renderer [data-widget-id="image"] img');
  const imageObs=source.locator('[data-event="follow"] [data-layer-id="image"] img');
  await until(async()=>await imageEditor.evaluate(el=>el.naturalWidth>0),'editor image');await until(async()=>await imageObs.evaluate(el=>el.naturalWidth>0),'OBS image');
  const textE=editor.locator('app-overlay-scene-renderer [data-widget-id="text"] app-overlay-layer');
  const textO=source.locator('[data-event="follow"] [data-layer-id="text"] app-overlay-layer');
  await editor.bringToFront();const te=await sample(editor,'app-overlay-scene-renderer [data-widget-id="text"] app-overlay-layer',0);await source.bringToFront();const to=await sample(source,'[data-event="follow"] [data-layer-id="text"] app-overlay-layer',0);assert.deepEqual({text:te.text,font:te.font,content:te.content},{text:to.text,font:to.font,content:to.content},'text and font parity');
  assert.equal((await textE.innerText()).trim(),'Parity fixture');assert.equal((await textO.innerText()).trim(),'Parity fixture');
  // Selecting another layer and changing viewport must not recreate playback.
  await editor.evaluate(()=>{window.__parityAnimations=[...document.querySelectorAll('app-overlay-scene-renderer')].flatMap(e=>e.getAnimations({subtree:true})).filter(a=>a.id.startsWith('alert-object')||a.id.startsWith('alert-keyframe'));});
  await editor.locator('.widget[data-kind="text"]').click();await editor.setViewportSize({width:width===1280?1000:320,height:900});
  assert(await editor.evaluate(()=>window.__parityAnimations.length>0 && window.__parityAnimations.every(a=>a.playState!=='idle')),'selection/resize must not restart animations');
  assert.equal(await editor.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
  if(process.env.SAAS_SCREENSHOT_DIR){await editor.getByLabel('Preview position (seconds)').fill('3');await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await editor.screenshot({path:`${process.env.SAAS_SCREENSHOT_DIR}/renderer-parity-${theme}-${width}.png`,fullPage:true});}
  send('overlay-control',{id:'skip',action:'skip',eventIds:['parity-event']});await until(()=>ended.includes('parity-event'),'OBS event completion');
  await editor.getByRole('button',{name:'Save & back to overlay',exact:true}).click();
  await editor.locator('.test-btn').filter({hasText:'Text to speech'}).click();
  await until(async()=>await editor.locator('app-overlay-scene-renderer .speech-text').count()===2,'editor TTS captions');
  send('overlay-event',{id:'speech-event',kind:'tts'});await until(async()=>await source.locator('[data-event="tts"] .speech-text').count()===2,'OBS TTS captions');
  for(const page of [editor,source]) {
   assert.deepEqual(await page.locator('.speech-text').allTextContents(),['Spoken fixture text','Spoken fixture text']);
   assert.equal(await page.locator('app-overlay-scene-renderer .audio-label,app-overlay-scene-renderer .media-title').count(),0,'private audio labels hidden');
   const muted=await page.locator('app-overlay-scene-renderer [data-event="tts"] video').evaluateAll(nodes=>nodes.map(n=>n.muted));
   assert.deepEqual(muted,[false,true],'exactly the first placement is audible');
  }
  send('overlay-control',{id:'skip-speech',action:'skip',eventIds:['speech-event']});
  await context.close();
 }
 // The same simulated event targets two differently timed designs. The short
 // placement must finish independently, and a second category targeting the
 // same box must wait until that box is released.
 {
  const {context,editor,source,send,ended}=await setup(1280,true);
  await editor.locator('.test-btn').filter({hasText:'Follows'}).click();
  await until(async()=>await editor.locator('app-overlay-scene-renderer [data-event="follow"]:not([data-idle])[data-widget-id="short-box"]').count()===1,'editor short alert');
  await editor.locator('.test-btn').filter({hasText:'Bits'}).click();
  assert.equal(await editor.locator('app-overlay-scene-renderer [data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count(),0,'editor queues a second event in the occupied box');
  await until(async()=>await editor.locator('app-overlay-scene-renderer [data-event="follow"]:not([data-idle])[data-widget-id="short-box"]').count()===0,'editor short placement expires');
  assert.equal(await editor.locator('app-overlay-scene-renderer [data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count(),0,'box stays reserved until the event completes');
  assert.equal(await editor.locator('app-overlay-scene-renderer [data-event="follow"]:not([data-idle])[data-widget-id="long-box"]').count(),1,'long placement remains active');
  await until(async()=>await editor.locator('app-overlay-scene-renderer [data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count()===1,'editor queued bits');
  send('overlay-event',{id:'follow-first',kind:'follow'});
  await until(async()=>await source.locator('[data-event="follow"]:not([data-idle])[data-widget-id="short-box"]').count()===1,'OBS short alert');
  send('overlay-event',{id:'bits-next',kind:'bits'});
  assert.equal(await source.locator('[data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count(),0,'OBS queues occupied box');
  await until(async()=>await source.locator('[data-event="follow"]:not([data-idle])[data-widget-id="short-box"]').count()===0,'OBS short placement expires');
  assert.equal(await source.locator('[data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count(),0,'OBS box stays reserved until event completes');
  assert.equal(await source.locator('[data-event="follow"]:not([data-idle])[data-widget-id="long-box"]').count(),1,'OBS long placement remains active');
  await until(async()=>await source.locator('[data-event="bits"]:not([data-idle])[data-widget-id="short-box"]').count()===1,'OBS queued bits');
  send('overlay-control',{id:'skip-timing',action:'skip',eventIds:['follow-first','bits-next']});
  await context.close();
 }
 assert.deepEqual(errors,[],'browser errors');console.log('PASS shared editor/OBS renderer: sampled motion, geometry, text/font/image, TTS captions and mute, selection/resize, per-placement expiry and whole-event box queue');
} finally {await browser.close();}
