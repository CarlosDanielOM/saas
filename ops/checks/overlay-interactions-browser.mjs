import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL;assert(base);
const api='https://api.domdimabot.com',publicId='b'.repeat(48),errors=[];
const browser=await chromium.launch({args:['--no-sandbox']});
const screenshot=async(page,name)=>{if(process.env.SAAS_SCREENSHOT_DIR){await mkdir(process.env.SAAS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.SAAS_SCREENSHOT_DIR}/${name}.png`,fullPage:true});}};
const widget=(kind,design='card')=>({id:kind,kind,interactionDesign:design,x:kind==='poll'?30:650,y:40,width:560,height:460,visible:true,locked:false});
const sample=(kind,revision=1)=>({kind,id:kind+'-1',title:kind==='poll'?'Choose the next game':'Will we win?',phase:'active',choices:[{id:'a',title:'Adventure',votes:0,points:0,users:0,color:'blue'},{id:'b',title:'Racing',votes:0,points:0,users:0,color:'pink'}],startedAt:new Date().toISOString(),deadline:new Date(Date.now()+90000).toISOString(),endedAt:null,winnerId:null,occurredAt:new Date().toISOString(),receipt:'fixture-'+revision,revision});
try {
 const runtime=await browser.newContext({viewport:{width:1280,height:760},reducedMotion:'reduce'});
 let interactions={poll:sample('poll'),prediction:sample('prediction'),serverTime:Date.now()},snapshot={width:1280,height:720,widgets:[widget('poll'),widget('prediction','compact')],designs:[],waitFor:[]};
 const sockets=[];
 await runtime.routeWebSocket('**/*',ws=>{
  if(!ws.url().includes('/socket.io/'))return ws.close();sockets.push(ws);
  ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
  ws.onMessage(message=>{if(String(message).startsWith('40/overlay-studio/')){interactions.serverTime=Date.now();ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-state',{revision:1,snapshot,interactions}])}`);}});
 });
 await runtime.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 const page=await runtime.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);
 const poll=page.locator('[data-interaction="poll"]'),prediction=page.locator('[data-interaction="prediction"]');
 await poll.locator('.panel').waitFor();assert.deepEqual(await poll.locator('.choice-heading strong').allTextContents(),['0%','0%']);
 interactions.poll={...interactions.poll,revision:2,choices:interactions.poll.choices.map((c,i)=>({...c,votes:[70,30][i],channelPointsVotes:[20,10][i]}))};
 interactions.prediction={...interactions.prediction,revision:2,choices:interactions.prediction.choices.map((c,i)=>({...c,points:[3000,1000][i],users:[12,6][i]}))};
 const send=()=>{interactions.serverTime=Date.now();for(const ws of sockets)ws.send(`42/overlay-studio/${publicId},${JSON.stringify(['overlay-interactions',interactions])}`);};send();
 await page.waitForFunction(()=>document.querySelector('[data-interaction="poll"] .choice-heading strong')?.textContent==='70%');
 assert.deepEqual(await prediction.locator('.choice-heading strong').allTextContents(),['75%','25%']);
 assert.equal(await poll.locator('.panel').count(),1,'progress updates in place');
 assert.deepEqual(await poll.locator('.regular-detail').allTextContents(),['50 Regular votes','20 Regular votes']);assert.deepEqual(await poll.locator('.points-detail').allTextContents(),['20 Channel Points votes','10 Channel Points votes']);
 const colors=await poll.locator('.choice').first().evaluate(n=>[getComputedStyle(n.querySelector('.regular-votes')).backgroundColor,getComputedStyle(n.querySelector('.point-votes')).backgroundColor]);assert.notEqual(colors[0],colors[1]);
 const share=await poll.locator('.regular-votes').first().evaluate(n=>parseFloat(n.style.width));assert(Math.abs(share-50/70*100)<.001,'regular votes are total minus point votes');
 assert.equal(await prediction.locator('.regular-votes,.point-votes,.vote-legend').count(),0,'prediction rendering unchanged');await screenshot(page,'runtime-presets');
 const current=interactions.poll;interactions.poll={...sample('poll'),revision:1};send();await page.waitForTimeout(100);assert.deepEqual(await poll.locator('.choice-heading strong').allTextContents(),['70%','30%']);interactions.poll=current;
 interactions.prediction={...interactions.prediction,revision:3,phase:'locked',deadline:null};send();await prediction.locator('[data-phase="locked"]').waitFor();assert.match(await prediction.innerText(),/Waiting for result/);
 interactions.poll={...interactions.poll,revision:3,phase:'completed',deadline:null,endedAt:new Date().toISOString(),choices:interactions.poll.choices.map(c=>({...c,votes:50}))};send();await poll.locator('[data-phase="completed"]').waitFor();assert.equal(await poll.getByText('Tied',{exact:true}).count(),2);
 interactions.prediction={...interactions.prediction,revision:4,phase:'resolved',endedAt:new Date().toISOString(),winnerId:'b'};send();await prediction.getByText('Winner',{exact:true}).waitFor();
 assert.equal(await prediction.locator('.winner .choice-title').innerText(),'Racing','winner comes from Twitch, not highest point share');
 await page.reload();await prediction.locator('.winner').waitFor();assert.equal(await poll.getByText('Tied',{exact:true}).count(),2,'refresh hydrates current state');
 interactions.poll={...interactions.poll,revision:4,phase:'terminated',endedAt:new Date(Date.now()-13500).toISOString()};interactions.prediction={...interactions.prediction,revision:5,phase:'canceled',winnerId:null,endedAt:new Date(Date.now()-13500).toISOString()};send();
 await prediction.locator('[data-phase="canceled"]').waitFor();assert.equal(await prediction.locator('.winner').count(),0);
 await page.waitForTimeout(1800);assert.equal(await poll.locator('.panel').count(),0);assert.equal(await prediction.locator('.panel').count(),0);await page.reload();await page.locator('.canvas').waitFor();assert.equal(await page.locator('.panel').count(),0,'expired results stay hidden after refresh');
 assert.equal(await page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
 // Maximum supported outcome counts and long titles.
 interactions.prediction={...sample('prediction',6),id:'many',title:'A very long prediction question that still fits inside the preset',choices:Array.from({length:10},(_,i)=>({id:String(i),title:'Outcome '+i+' with a long label',votes:0,points:i*100,users:i,color:i%2?'pink':'blue'}))};interactions.poll=sample('poll',5);send();await prediction.locator('.choice').nth(9).waitFor();
 assert(await prediction.locator('footer').evaluate(n=>n.getBoundingClientRect().bottom<=n.closest('.panel').getBoundingClientRect().bottom+1));
 const clipping=await prediction.locator('.choices').evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight,classes:n.closest('.panel').className,font:getComputedStyle(n.querySelector('.choice-heading')).fontSize,gap:getComputedStyle(n).gap}));assert(clipping.scroll<=clipping.height+2,JSON.stringify(clipping));
 await screenshot(page,'runtime-ten-outcomes');
 // Five paid-vote choices fit the default poll dimensions in both presets.
 interactions.poll={...sample('poll',6),title:'A longer poll question that wraps to two lines at the default size',choices:Array.from({length:5},(_,i)=>({id:String(i),title:'Choice '+i,votes:100,channelPointsVotes:i===0?100:20,users:0,points:0}))};
 for(const design of ['card','compact']){snapshot.widgets[0]={...snapshot.widgets[0],height:360,interactionDesign:design};await page.reload();await poll.locator('.choice').nth(4).waitFor();await screenshot(page,'poll-paid-'+design);const box=await poll.locator('.choices').evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight,gap:getComputedStyle(n).gap,rows:[...n.children].map(c=>({height:c.clientHeight,scroll:c.scrollHeight,detail:getComputedStyle(c.querySelector('.choice-details')).fontSize})),header:n.closest('.panel').querySelector('header').clientHeight}));assert(box.scroll<=box.height+2,JSON.stringify(box));assert.equal(await poll.locator('.regular-detail').first().innerText(),'0 Regular votes');await screenshot(page,'poll-paid-'+design);}
 await page.evaluate(()=>localStorage.setItem('userLanguage','es'));await page.reload();await poll.locator('.points-detail').first().waitFor();assert.match(await poll.locator('.points-detail').first().innerText(),/Votos con puntos del canal/);await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});const pollAxe=await page.evaluate(async()=> (await axe.run('[data-interaction="poll"]',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>v.id));assert.deepEqual(pollAxe,[]);await page.evaluate(()=>localStorage.setItem('userLanguage','en'));await page.reload();await poll.locator('.points-detail').first().waitFor();
 interactions.poll={...sample('poll',7),choices:sample('poll').choices.map(c=>({...c,votes:10}))};send();await poll.locator('.vote-legend').waitFor({state:'hidden'});assert.equal(await poll.locator('.choice-details').first().innerText(),'10 votes','legacy totals work without the new field');
 await runtime.close();
 console.log('PASS runtime: both presets, mixed/point-only/legacy poll votes, five choices, zero/progress, stale revisions, lock, ties, authoritative winner, cancellation, refresh, absolute expiry, ten outcomes and transparency.');
 const user={id:'990701',login:'interactionfixture',display_name:'Fixture'},app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'free',actived:true,chat_enabled:false,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
 const layout={duration:5,widgets:[]};let state={schemaVersion:1,revision:0,designs:[{id:'default',name:'Alerts',revision:1,width:800,height:240,events:{sub:layout,bits:layout,follow:layout,raid:layout}}],scenes:[{id:'main',name:'Interaction fixture',publicId,width:1920,height:1080,revision:0,widgets:[],waitFor:[]}]};
 const ready=(status='missing')=>({poll:{state:status,events:[]},prediction:{state:status,events:[]}});let readiness=ready(),activations=[],checkFailed=false;
 const context=await browser.newContext({viewport:{width:1280,height:1100},reducedMotion:'reduce'});
 await context.addInitScript(({user,app})=>{const saved=JSON.parse(localStorage.getItem('dimasite.session.v1')||'null');if(saved)app.language=saved.appUser.language;localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture-only',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',localStorage.getItem('userLanguage')||'en');localStorage.setItem('theme',localStorage.getItem('theme')||'dark');},{user,app});
 await context.routeWebSocket('**/*',ws=>ws.close());
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.origin!==api)return route.abort();let data={};
  if(url.pathname==='/auth/session')data={twitch:user,app};
  else if(url.pathname.endsWith('/access')||url.pathname.startsWith('/auth/access/'))data={allowed:true,role:'owner',planTier:'free'};
  else if(url.pathname.endsWith('/connections'))data={checkedAt:Date.now(),scenes:[]};
  else if(url.pathname.endsWith('/twitch-events')){if(checkFailed)return route.fulfill({status:502,json:{error:true}});data=readiness;}
  else if(url.pathname.includes('/twitch-events/')){const kind=url.pathname.split('/').at(-1);activations.push(kind);readiness[kind]={state:'ready',events:[]};data=readiness;}
  else if(url.pathname===`/overlay-studio/${user.id}`){if(req.method()==='PUT'){state=structuredClone(req.postDataJSON());state.revision++;}data=structuredClone(state);}
  else if(url.pathname.endsWith('/publish')){state.scenes[0].revision++;state.revision++;state.scenes[0].published=structuredClone({width:1920,height:1080,widgets:state.scenes[0].widgets,designs:[],waitFor:[]});data=structuredClone(state);}
  return route.fulfill({json:{error:false,data}});
 });
 const editor=await context.newPage();editor.on('pageerror',e=>errors.push(e.message));await editor.goto(base+'/interactionfixture/modules/overlays');await editor.locator('.stage').waitFor();
 const setup=editor.locator('app-overlay-interaction-setup');await setup.getByText('Events needed',{exact:true}).first().waitFor();
 await setup.getByRole('button',{name:'Activate Twitch events',exact:true}).first().click();await setup.getByText('Ready',{exact:true}).waitFor();assert.deepEqual(activations,['poll']);
 await setup.getByRole('button',{name:'Activate Twitch events',exact:true}).nth(1).click();await editor.waitForTimeout(200);assert.deepEqual(activations,['poll','prediction']);
 await editor.locator('.palette-item[data-kind="poll"]').click();await editor.locator('.widget[data-kind="poll"] .panel').waitFor();
 await editor.getByLabel('Preset design',{exact:true}).selectOption('compact');await editor.getByLabel('Preview state',{exact:true}).selectOption('tie');assert.equal(await editor.locator('.widget[data-kind="poll"]').getByText('Tied',{exact:true}).count(),3);
 await editor.locator('.palette-item[data-kind="prediction"]').click();await editor.getByLabel('Preview state',{exact:true}).selectOption('locked');await editor.locator('.widget[data-kind="prediction"] [data-phase="locked"]').waitFor();
 await editor.getByRole('button',{name:'Save draft',exact:true}).click();await editor.getByRole('button',{name:'Saved',exact:true}).waitFor();assert.equal(state.scenes[0].widgets[0].interactionDesign,'compact');assert.equal(state.scenes[0].widgets[1].kind,'prediction');
 await editor.getByRole('button',{name:/Publish live/}).click();await editor.getByText('Published. Connected browser sources are updating.',{exact:true}).waitFor();assert.equal(state.scenes[0].published.widgets.length,2);
 readiness=ready('permission');await setup.getByRole('button',{name:'Refresh status',exact:true}).click();await setup.getByRole('link',{name:'Reconnect Twitch',exact:true}).first().waitFor();const href=await setup.getByRole('link',{name:'Reconnect Twitch',exact:true}).first().getAttribute('href');assert.match(href,/\/auth\/authorize\?/);assert.match(href,/state=interactionfixture/);
 checkFailed=true;await setup.getByRole('button',{name:'Refresh status',exact:true}).click();await setup.getByRole('alert').waitFor();checkFailed=false;readiness=ready('ready');await setup.getByRole('button',{name:'Refresh status',exact:true}).click();await setup.getByText('Ready',{exact:true}).first().waitFor();
 for(const theme of ['dark','light']){
  await editor.evaluate(theme=>localStorage.setItem('theme',theme),theme);await editor.reload();await editor.locator('.stage').waitFor();
  for(const width of [320,390,1280]){
   await editor.setViewportSize({width,height:1100});assert.equal(await editor.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${theme} ${width} overflow`);
   await setup.scrollIntoViewIfNeeded();await screenshot(editor,`editor-${theme}-${width}`);
   await editor.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
   const violations=await editor.evaluate(async()=> (await axe.run('app-overlay-interaction-setup',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));
   assert.deepEqual(violations,[],`${theme} ${width} accessibility`);
  }
 }
 app.language='es';await editor.evaluate(()=>{localStorage.setItem('userLanguage','es');const saved=JSON.parse(localStorage.getItem('dimasite.session.v1'));saved.appUser.language='es';localStorage.setItem('dimasite.session.v1',JSON.stringify(saved));});await editor.reload();await editor.locator('.stage').waitFor();await setup.getByText('Encuestas y predicciones',{exact:true}).waitFor();await editor.locator('.palette-item[data-kind="poll"]').getByText('Encuesta',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);await context.close();console.log('PASS editor: manual activation, readiness/error/reconnect, both layer kinds, presets, previews, draft/publish, 320/390/1280 light/dark, setup axe and Spanish.');
} finally {await browser.close();}
