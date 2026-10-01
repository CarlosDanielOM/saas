import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL;assert(base);const api='https://api.domdimabot.com', publicId='b'.repeat(48);
const browser=await chromium.launch({args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
const user={id:'990081',login:'fixture',display_name:'Fixture'},app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'pro',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
const text={id:'text',kind:'text',x:0,y:0,width:600,height:120,visible:true,locked:false,text:'$(user)',color:'#ffffff',fontSize:30};
const design={id:'starter',name:'Alerts',revision:1,width:800,height:240,events:Object.fromEntries(['follow','sub','bits','raid'].map(kind=>[kind,{duration:60,widgets:[text]}]))};
const widget={id:'alert',kind:'alert',x:0,y:0,width:800,height:240,visible:true,locked:false,designId:'starter',events:['follow','sub','bits','raid']};
const snapshot={width:900,height:600,waitFor:['follow','sub','bits','raid'],widgets:[widget],designs:[design]};
const studio={schemaVersion:1,revision:1,scenes:[{id:'main',name:'Main',publicId,revision:1,...snapshot,published:snapshot}],designs:[design]};
let queueState={revision:0,all:false,platforms:{}}, report={active:[],queued:[]}, socket, failQueue=false, failControl=false;
const events=new Map(), ended=[],acks=[],calls=[],errors=[],requests=[],deferred=new Map();let commandNumber=0;
const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
const matches=(scope,event)=>scope==='all'||event.platform===scope;
const queueStatus=()=>({state:queueState,connected:1,needsRefresh:0,events:[...report.active.map(id=>({...events.get(id),status:'playing'})),...report.queued.map(id=>({...events.get(id),status:'queued'}))]});
function command(action,platform,ids) {const cmd={id:'command-'+(++commandNumber),action,platform,eventIds:ids??[...events.values()].filter(e=>matches(platform,e)&&!ended.includes(e.id)).map(e=>e.id)};send('overlay-control',cmd);return cmd;}
function control(action,platform) {
 if(action==='pause'||action==='resume') {
  queueState={...queueState,revision:queueState.revision+1};
  if(platform==='all'){queueState.all=action==='pause';queueState.platforms={};}else queueState.platforms={...queueState.platforms,[platform]:action==='pause'};
  send('overlay-queue-state',queueState);
 }else return command(action,platform);
}
function emit(id,platform='twitch',kind='follow') {
 const event={id,platform,kind,snapshot:structuredClone(snapshot),layouts:{starter:{duration:60,widgets:[{...text,text:id}]}}};events.set(id,event);send('overlay-event',{id,kind,platform});
}
async function until(fn,message='condition') {for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error(message);}
try {
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 await context.addInitScript(({user,app})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('dimasite.language','en');},{user,app});
 await context.routeWebSocket('**/*',ws=>{
  if(!ws.url().includes('/socket.io/'))return ws.close();
  ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
  ws.onMessage(raw=>{const message=String(raw);if(message.startsWith('40/overlay-studio/')){socket=ws;ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot,controls:queueState,commands:[]});}
   else if(message.startsWith('42/overlay-studio/')){const [name,value]=JSON.parse(message.slice(message.indexOf(',')+1));if(name==='overlay-playback')report=value;if(name==='overlay-ended')ended.push(value);if(name==='overlay-control-ack')acks.push(value);}
  });
 });
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.origin!==api)return route.abort();
  let data={};
  if(url.pathname==='/auth/session')data={twitch:user,app};
  else if(url.pathname.includes('/access'))data={allowed:true,role:'owner',planTier:'pro'};
  else if(url.pathname.endsWith('/connections'))data={checkedAt:Date.now(),pollingFailed:false,scenes:[]};
  else if(url.pathname.endsWith('/queue')) {
   if(failQueue||req.method()==='POST'&&failControl)return route.fulfill({status:503,json:{error:true,message:'fixture failure'}});
   if(req.method()==='POST'){const body=req.postDataJSON();calls.push(body);control(body.action,body.platform);}
   data=queueStatus();
  }else if(url.pathname.includes('/events/')){
   const id=url.pathname.split('/').at(-1);requests.push(id);if(id==='loading'){await new Promise(resolve=>deferred.set(id,resolve));}data=events.get(id);
  }else if(url.pathname.startsWith('/overlay-studio/public/'))data={revision:1,snapshot,controls:queueState};
  else if(url.pathname===`/overlay-studio/${user.id}`)data=studio;
  else if(url.pathname.endsWith('/preview'))data=req.postDataJSON().texts.map(()=> 'Luna');
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const source=await context.newPage();source.on('pageerror',e=>errors.push(e.message));await source.goto(base+'/overlays/'+publicId);await source.locator('.canvas').waitFor();
 const editor=await context.newPage();editor.on('pageerror',e=>errors.push(e.message));await editor.goto(base+'/fixture/modules/overlays');const panel=editor.locator('app-overlay-queue');await panel.getByText('Queue is running',{exact:true}).waitFor();
 emit('tw-current');await until(()=>report.active.includes('tw-current'));
 emit('tw-wait');emit('kick-wait','kick');await until(()=>report.queued.length===2);
 await panel.getByLabel('Event platform').selectOption('twitch');await panel.getByRole('button',{name:'Pause queue',exact:true}).click();
 assert.deepEqual(calls.at(-1),{action:'pause',platform:'twitch'});assert.ok(report.active.includes('tw-current'),'pause keeps current playback');
 await panel.getByRole('button',{name:'Skip current',exact:true}).click();await until(()=>report.active.includes('kick-wait'));
 assert.ok(report.queued.includes('tw-wait'),'paused Twitch events stay queued while Kick advances');assert.ok(ended.includes('tw-current'));
 assert.equal(await source.locator('.placement[data-event]').getAttribute('data-platform'),'kick');
 emit('kick-next','kick');await until(()=>report.queued.includes('kick-next'));
 const skip=command('skip','twitch');await until(()=>acks.includes(skip.id));assert.ok(report.active.includes('kick-wait'),'Twitch skip leaves Kick playing');
 await panel.getByLabel('Event platform').selectOption('kick');await panel.getByRole('button',{name:'Clear waiting',exact:true}).click();await until(()=>ended.includes('kick-next'));assert.ok(report.active.includes('kick-wait'),'clear preserves current playback');
 await panel.getByLabel('Event platform').selectOption('all');await panel.getByRole('button',{name:'Pause queue',exact:true}).click();
 command('skip','kick');await until(()=>report.active.length===0);
 emit('kick-held','kick');await until(()=>report.queued.includes('kick-held'));
 await panel.getByLabel('Event platform').selectOption('twitch');await panel.getByRole('button',{name:'Resume queue',exact:true}).click();await until(()=>report.active.includes('tw-wait'));
 assert.ok(report.queued.includes('kick-held'),'resume Twitch overrides an all-platform pause only for Twitch');
 emit('tw-after');await until(()=>report.queued.includes('tw-after'));
 const clear=command('clear','twitch');await until(()=>ended.includes('tw-after'));assert.ok(report.active.includes('tw-wait'));
 emit('tw-new');send('overlay-control',clear);await until(()=>report.queued.includes('tw-new'));assert.equal(ended.includes('tw-new'),false,'duplicate clear cannot remove later arrivals');
 // Reconnect bootstrap applies missed controls before draining a resumed queue.
 const replay={id:'replayed-clear',action:'clear',platform:'twitch',eventIds:['tw-new']};
 queueState={revision:queueState.revision+1,all:false,platforms:{}};
 send('overlay-state',{revision:1,snapshot,controls:queueState,commands:[replay]});await until(()=>ended.includes('tw-new'));
 command('skip','all');await until(()=>report.active.includes('kick-held'));command('skip','all');await until(()=>report.active.length===0);
 // Skip an event while its HTTP payload is in flight; it must never mount later.
 emit('loading');await until(()=>deferred.has('loading'));command('skip','twitch');await until(()=>ended.includes('loading'));deferred.get('loading')();await source.waitForTimeout(120);assert.equal(await source.getByText('loading',{exact:true}).count(),0);
 emit('after-loading');await until(()=>report.active.includes('after-loading'));assert.equal(await source.getByText('after-loading',{exact:true}).count(),1);
 // Parallel events also respect platform pause and independent skip.
 command('skip','all');await until(()=>report.active.length===0);snapshot.waitFor=[];send('overlay-state',{revision:2,snapshot,controls:queueState,commands:[]});
 control('pause','twitch');emit('parallel-tw');emit('parallel-ki','kick');await until(()=>report.active.includes('parallel-ki')&&report.queued.includes('parallel-tw'));
 control('resume','twitch');await until(()=>report.active.length===2);command('skip','twitch');await until(()=>ended.includes('parallel-tw'));assert.ok(report.active.includes('parallel-ki'));
 console.log('PASS browser runtime: scoped pause/resume/skip/clear, platform labels, all-pause overrides, eligible-platform progress, parallel events, replay/dedupe, clear preserves active and late payload cancellation.');
 await until(async()=>!/[{][{]?count/.test(await panel.textContent()), 'queue counts must be interpolated');
 await panel.getByLabel('Event platform').selectOption('kick');await panel.getByText('$(overlay.skip.kick)',{exact:true}).waitFor();
 await panel.getByText('Playing: 1',{exact:true}).waitFor(); await panel.getByText('Waiting: 0',{exact:true}).waitFor();
 for(const width of [320,375,768,1440]) {
  await editor.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();assert.equal(await editor.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`mobile overflow ${width}`);
  if(process.env.SAAS_SCREENSHOT_DIR){await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await panel.screenshot({path:process.env.SAAS_SCREENSHOT_DIR+`/controls-${width}.png`});}
 }
 await editor.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
 const axe=async()=>{const result=await editor.evaluate(()=>window.axe.run(document.querySelector('app-overlay-queue'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);};await axe();
 failControl=true;await panel.getByRole('button',{name:'Pause queue',exact:true}).click();await panel.getByText('Control failed. Check the connection and try again.',{exact:true}).waitFor();failControl=false;
 failQueue=true;await panel.getByText('Could not load the live queue.',{exact:false}).waitFor();assert.equal(await panel.getByRole('button',{name:'Pause queue',exact:true}).isDisabled(),true);failQueue=false;await panel.getByRole('button',{name:'Retry',exact:true}).click();await until(async()=>!(await panel.getByRole('button',{name:'Pause queue',exact:true}).isDisabled()));
 await editor.locator('app-overlay-editor .topbar__actions button').first().click();await panel.getByText('Controles de la overlay en vivo',{exact:true}).waitFor();await axe();
 assert.deepEqual(errors,[]);await context.close();console.log('PASS Studio controls: same API actions, scoped AST example, visible platform labels, mobile/desktop, en/es, accessible controls, failure recovery and stale polling protection.');
} finally {await browser.close();}
