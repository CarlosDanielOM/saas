import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL; assert(base);
const browser=await chromium.launch({args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
const api='https://api.domdimabot.com'; const publicId='a'.repeat(48); const errors=[];
const layer=(id,kind,x=10)=>({id,kind,x,y:10,width:400,height:160,visible:true,locked:false});
const design={id:'starter',name:'My alerts',revision:1,width:800,height:240,events:Object.fromEntries(['follow','bits','sub','raid'].map(kind=>[kind,{duration:5,widgets:[{...layer(kind+'-text','text'),text:'$(user)'}]}]))};
const scene={id:'main',name:'My overlay',revision:0,publicId,width:1920,height:1080,waitFor:['tts','bits','trigger'],widgets:[layer('tts-1','tts'),layer('trigger-1','trigger',500),layer('clip-1','clip',1000),{...layer('alert-1','alert',500),y:400,designId:'starter',events:['bits','sub','follow','raid']}]};
let state={schemaVersion:1,revision:0,scenes:[scene],designs:[design]};
const user={id:'990091',login:'fixture',display_name:'Fixture'},app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'pro',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
try {
const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
await context.addInitScript(({user,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture-only',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}})),{user,app});
let writes=0,conflict=false;const templates=[];
await context.routeWebSocket('**/*',ws=>ws.close());
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.origin!==api)return route.abort();
 let data={};const body=req.postDataJSON();
 if(url.pathname==='/auth/session')data={twitch:user,app};
 else if(url.pathname.endsWith('/access'))data={allowed:true,role:'owner',planTier:app.plan_tier};
 else if(url.pathname.startsWith('/auth/access/'))data={allowed:true};
 else if(url.pathname.endsWith('/preview')){templates.push(body);data=body.texts.map(t=>t==='$(user)'?body.user:t.replace('$(user)',body.user).replace('$(cheer.amount)',body.amount));}
 else if(url.pathname===`/overlay-studio/${user.id}`){
  if(req.method()==='PUT'){writes++;if(conflict)return route.fulfill({status:409,json:{error:true,message:'Conflict'}});state=structuredClone(body);state.revision++;state.scenes.forEach(s=>{if(!s.publicId)s.publicId='b'.repeat(48);});}
  data=structuredClone(state);
 }else if(url.pathname.includes('/scenes/')){
  const selected=state.scenes.find(s=>s.id===url.pathname.split('/')[4]);
  if(url.pathname.endsWith('/publish')){selected.revision++;selected.published=structuredClone({width:selected.width,height:selected.height,widgets:selected.widgets,waitFor:selected.waitFor,designs:state.designs});}else selected.publicId='c'.repeat(48);
  state.revision++;data=structuredClone(state);
 }else if(url.pathname.startsWith('/triggers/'))data=[];
 return route.fulfill({json:{error:false,status:200,data}});
});
const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'/fixture/modules/overlays');await page.locator('app-overlay-editor .stage').waitFor().catch(async e=>{console.log(page.url(),await page.locator('body').innerText(),errors);throw e;});
const click=name=>page.locator('app-overlay-editor').getByRole('button',{name,exact:true}).click();
const field=async(name,value)=>{const input=page.getByLabel(name,{exact:true});await input.fill(String(value));await input.blur();};
assert(await page.getByText('Alpha · Pro',{exact:true}).isVisible());
if(process.env.SAAS_SCREENSHOT_DIR){await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SAAS_SCREENSHOT_DIR+'/alpha-desktop.png',fullPage:true});}
const before=structuredClone(state.scenes[0].widgets);await field('Canvas width',800);await click('Save draft');await page.getByRole('button',{name:'Saved',exact:true}).waitFor();assert.deepEqual(state.scenes[0].widgets,before);
await field('Canvas width',1920);await page.getByRole('button',{name:/Publish live/}).click();await page.getByText('Published. Connected browser sources are updating.',{exact:true}).waitFor();
const frozen=structuredClone(state.scenes[0].published);
await page.locator('.layers').getByRole('button',{name:'Alerts',exact:true}).click();await click('Edit design');
await page.locator('.design-event-tabs').getByRole('button',{name:'Bits',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.design-event-tabs .active')?.textContent==='Bits');
await page.getByLabel('Text template',{exact:true}).fill('$(user) sent $(cheer.amount) bits').catch(async e=>{console.log(await page.locator('app-overlay-editor').innerText(),errors);throw e;});
await page.waitForFunction(()=>document.querySelector('.text-preview')?.textContent==='Luna sent 100 bits');
assert(templates.some(r=>r.texts.includes('$(user) sent $(cheer.amount) bits')&&r.kind==='bits'));
await click('Save design');await page.getByRole('button',{name:'Saved',exact:true}).waitFor();
await page.waitForFunction(()=>!document.querySelector('.editor-fields')?.disabled);
assert.deepEqual(state.scenes[0].published,frozen);
await click('← Save & back to overlay');await page.locator('.scene-picker').waitFor();
await click('+ New overlay');await page.locator('.palette-item[data-kind="alert"]').click();await click('Save draft');await page.getByRole('button',{name:'Saved',exact:true}).waitFor();assert.equal(state.scenes.length,2);assert.equal(state.scenes[1].widgets[0].designId,'starter');
await field('Overlay name','Changed draft');conflict=true;await click('Save draft');await page.getByText('This draft changed in another tab. Reload the saved draft before saving again.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Overlay name',{exact:true}).inputValue(),'Changed draft');conflict=false;
await click('Reload saved draft');await page.locator('.stage').waitFor();
await page.locator('summary').click();const old=await page.locator('.url-row code').innerText();await click('Replace overlay URL');assert.equal(await page.locator('.url-row code').innerText(),old);await click('Yes, invalidate the previous URL');await page.waitForFunction(()=>document.querySelector('.url-row code')?.textContent.includes('cccc'));
for(const width of [320,375,768,1440]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width}`);}
await page.setViewportSize({width:375,height:1000});await page.locator('.mobile-tabs').getByRole('button',{name:'Library',exact:true}).click();await page.locator('.palette-item[data-kind="image"]').click();await page.locator('.mobile-tabs').getByRole('button',{name:'Properties',exact:true}).click();await page.getByLabel('Media URL (HTTPS)',{exact:true}).fill('https://fixture.invalid/background.png');await page.getByLabel('Media URL (HTTPS)',{exact:true}).blur();await click('Save draft');await page.getByRole('button',{name:'Saved',exact:true}).waitFor();assert(state.scenes.some(s=>s.widgets.some(w=>w.mediaUrl==='https://fixture.invalid/background.png')));
assert((await page.getByRole('button',{name:'Send test alert to OBS',exact:true}).boundingBox()).height >= 44);
if(process.env.SAAS_SCREENSHOT_DIR){await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SAAS_SCREENSHOT_DIR+'/alpha-mobile.png',fullPage:true});}
await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});const axe=await page.evaluate(()=>window.axe.run(document.querySelector('app-overlay-editor'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
app.plan_tier='free';await page.reload();await page.getByText('Overlay Studio Alpha is available to Pro streamers.',{exact:true}).waitFor();assert.equal(await page.locator('app-overlay-editor .stage').count(),0);
await context.close();
console.log('PASS editor: authenticated owner/Pro gate, durable save API, conflict preservation, canvas dimensions, server AST preview, linked design reuse, immutable publish, URL confirmation, assets, mobile and axe.');
// Public source renderer: transparent, isolated FIFO, parallel categories, live publish, failures and native media.
const runtime=await browser.newContext({viewport:{width:1920,height:1080}});let socket;const ended=[];let snapshot=structuredClone(frozen);snapshot.widgets[3].events=['bits','follow'];snapshot.waitFor=['bits','tts'];
const runtimeEvents=new Map();let currentRevision=1;
const wav=Buffer.alloc(44+16000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
await runtime.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/')){ws.close();return;}socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(message=>{const m=String(message);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:currentRevision,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
function send(name,value){socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);}
await runtime.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/fixture.wav')return route.fulfill({contentType:'audio/wav',body:wav});if(url.pathname==='/broken.wav')return route.fulfill({status:404,body:''});if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:runtimeEvents.get(url.pathname.split('/').at(-1))}});if(url.pathname.startsWith('/overlay-studio/public/'))return route.fulfill({json:{data:{revision:currentRevision,snapshot}}});return route.abort();});
const source=await runtime.newPage();source.setDefaultTimeout(12000);source.on('pageerror',e=>errors.push(e.message));await source.goto(base+'/overlays/'+publicId);await source.locator('.canvas').waitFor();assert.equal(await source.evaluate(()=>document.body.style.background),'transparent');
const event=(id,kind,text)=>{const e={id,kind,layouts:{starter:{duration:1,widgets:[{...layer('text','text'),text}]}}};runtimeEvents.set(id,e);send('overlay-event',{id,kind});};
await source.clock.install();await source.clock.pauseAt(new Date());
async function textAppears(text){for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,10));await source.clock.runFor(32);if(await source.getByText(text,{exact:true}).count())return;}throw new Error('Missing runtime text: '+text);}
event('bits-0','bits','First');await textAppears('First');
for(let i=1;i<=100;i++)event('bits-'+i,'bits','Queued '+i);
event('parallel','follow','Independent');await textAppears('Independent');
const activeX=await source.locator('[data-event="bits"]').evaluate(e=>e.style.left);snapshot.widgets[3].x=900;currentRevision++;send('overlay-updated',{revision:currentRevision});await new Promise(r=>setTimeout(r,100));
assert.equal(await source.locator('[data-event="bits"]').evaluate(e=>e.style.left),activeX);
await source.clock.runFor(1100);await textAppears('Queued 1');assert.equal(await source.locator('[data-event="bits"]').evaluate(e=>e.style.left),'900px');
for(let i=1;i<=100;i++){await source.clock.runFor(1100);if(i<100)await textAppears('Queued '+(i+1));}
assert.equal(ended.filter(id=>id.startsWith('bits-')).length,101);assert(ended.includes('parallel'));
await source.clock.resume();
for(const [id,url] of [['audio','/fixture.wav'],['bad','/broken.wav']]){runtimeEvents.set(id,{id,kind:'tts',media:{type:'audio',url:api+url,title:'Speech',volume:1},text:'A real speech event'});send('overlay-event',{id,kind:'tts'});await source.waitForFunction(()=>!document.querySelector('[data-event="tts"]')).catch(()=>{});for(let n=0;n<80&&!ended.includes(id);n++)await new Promise(r=>setTimeout(r,50));assert(ended.includes(id));}
assert.equal(ended.filter(id=>id==='audio').length,1);send('overlay-event',{id:'audio',kind:'tts'});await new Promise(r=>setTimeout(r,100));assert.equal(await source.locator('[data-event="tts"]').count(),0);
send('overlay-revoked',{});await source.locator('.canvas').waitFor({state:'detached'});assert.deepEqual(errors,[]);await runtime.close();
console.log('PASS runtime: transparent source, 101-event FIFO, parallel alerts, publish preserving active event and pending queue, native speech media, failure release, duplicate delivery and revocation.');
}finally{await browser.close();}
