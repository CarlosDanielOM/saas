/** Read-only admin Pet UI check. Every external/API request is intercepted. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base);
const artifacts = process.env.SAAS_UI_ARTIFACTS || '/tmp/admin-pet-diagnostics-browser';
await mkdir(artifacts,{recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.SAAS_CHROMIUM_PATH||undefined});
const context = await browser.newContext({reducedMotion:'reduce',serviceWorkers:'block'});
const unexpected=[];
const row={channelID:'9001',channel:'petfixture',email:'fixture@example.test',plan_tier:'premium',actived:true,chat_enabled:true,has_permissions:true,up_to_date_permissions:true,isLive:false,liveViewers:0,commandsCount:0,eventsubsActiveCount:0,eventsubsDisabledCount:0};
const session={name:'My streaming computer with a long name',authorization:'valid',lastUsedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),idleExpiresAt:new Date(Date.now()+86400000).toISOString()};
const computer={selectedSessionId:'0123456789abcdef01234567',session,connected:false,reportedReady:false,ready:false};
const initial={observedAt:new Date().toISOString(),configured:true,enabled:true,appearance:'vts',playbackTarget:'desktop',vts:{...computer,projection:{status:'missing',lastValidatedAt:null,expiresAt:null}},audio:{...computer},failures:[{requestId:'one',status:'cancelled',errorCode:'player_disconnected',createdAt:new Date().toISOString()}]};
let data=structuredClone(initial), fail=false, requests=0, delayResolve;
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url()),p=url.pathname;
 if(url.origin===new URL(base).origin)return route.continue();
 if(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname))return route.abort();
 if(url.hostname!=='api.domdimabot.com'){unexpected.push(`${req.method()} ${url.origin}${p}`);return route.abort();}
 assert.equal(req.method(),'GET','diagnostics never mutates');
 if(p.endsWith('/pet-diagnostics')){requests++;if(delayResolve)await new Promise(resolve=>{delayResolve=resolve;});return json(route,fail?{error:true}: {data},fail?503:200);}
 if(p==='/admin-site/users')return json(route,{data:{rows:[row],pagination:{page:1,limit:100,total:1,totalPages:1}}});
 if(p==='/users')return json(route,{data:{profile_image_url:`${base}/favicon.png`}});
 if(p.endsWith('/commands')||p.endsWith('/eventsubs'))return json(route,{data:{rows:[],pagination:{total:0,page:1,totalPages:1}}});
 if(p.endsWith('/ai-credits'))return json(route,{data:{available:false,used:0,limit:0,balance:0}});
 if(p.startsWith('/rewards/'))return json(route,{data:{rewards:[]}});
 if(p.startsWith('/triggers/'))return json(route,{data:{triggers:[],files:[]}});
 if(p.startsWith('/timers/'))return json(route,{data:{timers:[]}});
 if(p.startsWith('/files/'))return json(route,{data:{files:[]}});
 if(p.startsWith('/memories/'))return json(route,{data:{memories:[]}});
 unexpected.push(`${req.method()} ${p}`);return route.abort();
});
await context.addInitScript(()=>{
 localStorage.setItem('dima-admin.session.v1',JSON.stringify({version:2,token:'disposable-pet-ui-token',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:{id:'533538623',login:'admin_fixture',display_name:'Alex'},appUser:{twitch_user_id:'533538623',name:'admin_fixture',plan_tier:'free'}}));
});
const page=await context.newPage();
try {
 for(const theme of ['dark','light'])for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:900});
  await page.goto(`${base}/channels/9001`);
  await page.evaluate(mode=>{localStorage.setItem('dima-admin.mode.v1',mode);document.documentElement.classList.toggle('dark',mode==='dark');document.documentElement.dataset.theme=mode;document.documentElement.style.colorScheme=mode;},theme);
  const tile=page.locator('app-pet-diagnostics');
  await tile.getByText('The selected VTube Studio computer is disconnected',{exact:true}).waitFor();
  await tile.getByText('No readiness record',{exact:true}).waitFor();
  assert.equal(await tile.getByRole('button',{name:'Refresh',exact:true}).count(),1);
  await tile.locator('summary').click();
  assert.ok(await tile.getByText('0123456789abcdef01234567',{exact:true}).count()>=1);
  await tile.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width} ${theme}`);
  await page.addScriptTag({path:process.env.AXE_PATH||'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
  const violations=await page.evaluate(async()=> (await axe.run(document.querySelector('app-pet-diagnostics'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations);
  assert.deepEqual(violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`${theme} ${width} accessibility`);
  await tile.screenshot({path:`${artifacts}/pet-${theme}-${width}.png`});
 }
 const tile=page.locator('app-pet-diagnostics');
 const refresh=async()=>{await tile.getByRole('button',{name:/^(Refresh|Retry)$/}).click();await tile.getByRole('button',{name:'Refresh',exact:true}).waitFor();};
 data.vts.connected=true; data.vts.reportedReady=true; data.vts.ready=true;data.vts.projection={status:'fresh',lastValidatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString()};data.audio.connected=true;data.audio.ready=true;
 await refresh();await tile.getByText('VTube Studio is ready',{exact:true}).waitFor();
 data.vts.ready=false;data.vts.projection.status='stale';await refresh();await tile.getByText('Stale or no longer matches settings',{exact:true}).waitFor();
 data.vts.session.authorization='revoked';await refresh();await tile.getByText('Revoked — sign in again',{exact:true}).first().waitFor();
 data.vts.session=null;await refresh();await tile.getByText('The saved VTube Studio computer is unavailable',{exact:true}).waitFor();
 data.vts.selectedSessionId=null;await refresh();await tile.getByText('Choose a VTube Studio computer',{exact:true}).waitFor();
 fail=true;await tile.getByRole('button',{name:'Refresh',exact:true}).click();await tile.getByRole('alert').waitFor();
 assert.match(await tile.getByRole('alert').innerText(),/previous snapshot; it may be stale/);
 fail=false;data=structuredClone(initial);data.configured=false;data.failures=[];await refresh();await tile.getByText('Pet has not been set up',{exact:true}).waitFor();
 await tile.getByText('No retained playback failures.',{exact:false}).waitFor();
 data.configured=true;data.appearance='png';await refresh();await tile.getByText('Pet uses images; VTube Studio is not required',{exact:true}).waitFor();
 data.enabled=false;await refresh();await tile.getByText('Pet is switched off',{exact:true}).waitFor();
 fail=true;await page.reload();await tile.getByRole('alert').waitFor();assert.equal(await tile.getByText('Pet is switched off',{exact:true}).count(),0);
 fail=false;await refresh();await tile.getByText('Pet is switched off',{exact:true}).waitFor();
 assert.ok(requests<30,'one observation per load/refresh, no reactive request loop');
 assert.deepEqual(unexpected,[]);
 console.log('PASS Pet diagnostics UI: mobile/desktop both themes, axe/overflow, details, missing/ready/stale/revoked/foreign/no-selection/PNG/disabled, refresh failure/stale snapshot/retry and initial failure');
}finally{await context.close();await browser.close();}
