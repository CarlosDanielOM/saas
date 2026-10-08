// All authenticated/provider API requests are intercepted. No live channel is modified.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(`${process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser'}/package.json`);
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base);
const catalog={...JSON.parse(readFileSync('dimabot/src/widgets/dbd.json','utf8')),packs:['killer','survivor'].flatMap(role=>['challenge','characters','perks'].map(mode=>({id:`dbd-${role}-${mode}`,game:'Dead by Daylight',role,mode})))};
const browser=await chromium.launch({args:['--no-sandbox']});
const shots=process.env.SAAS_SCREENSHOT_DIR; if(shots)mkdirSync(shots,{recursive:true});
const keys=(obj,p='')=>Object.entries(obj).flatMap(([k,v])=>v&&typeof v==='object'?keys(v,p+k+'.'):[p+k]);
const en=await(await fetch(base+'/assets/i18n/en.json')).json(),es=await(await fetch(base+'/assets/i18n/es.json')).json();assert.deepEqual(keys(en.widgets).sort(),keys(es.widgets).sort());
// Reuse real artwork within this check instead of refetching every pool for each viewport.
const portraitCache=new Map();
async function portrait(route){
 const url=route.request().url();
 if(!portraitCache.has(url))portraitCache.set(url,(async()=>{
  for(let attempt=0;attempt<2;attempt++){
   try{const response=await route.fetch({timeout:15000});if((response.status()===429||response.status()>=500)&&attempt===0)continue;return {status:response.status(),contentType:response.headers()['content-type']||'image/png',body:await response.body()};}
   catch(error){if(attempt===1)throw error;}
  }
 })());
 try{await route.fulfill(await portraitCache.get(url));}catch{await route.fulfill({status:404,body:''});}
}
async function fixture({width=1280,tier='pro',theme='dark',lang='en',owner=true}={}){
 const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});
 const user={id:'991801',login:'widgetfixture',display_name:'Widget Fixture'};
 const app={name:'Widget Fixture',email:'test@example.invalid',language:lang,plan_tier:tier,actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:owner?[]:[{channelID:'991802',channelName:'other'}]};
 await context.addInitScript(({user,app,theme,lang})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('dimasite.theme',theme);document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.toggle('dark',theme==='dark'));},{user,app,theme,lang});
 const state={revision:1,serverTime:Date.now(),packId:'dbd-killer-challenge',visible:false,config:{language:lang,characterDesign:'cards',spinSeconds:1,pollSeconds:15,channelPointsVoting:false,channelPointsPerVote:100,includeUnavailable:false,excludedIds:[]},phase:'idle',run:null,nextAt:null};
 const wireState=()=>({...state,phase:state.phase==='character-result'?'character-spin':state.phase==='perk-result'?'perk-spin':state.phase,resultPhase:['character-result','perk-result'].includes(state.phase)?state.phase:undefined});
 let writes=0,widgetReads=0,conflict=false,failRead=false,lostResponse=false,manualDraw=false,widgetSocket;
 const finish=()=>{
  if(manualDraw)return;
  if(state.run?.draw&&state.run.draw.endsAt<=Date.now()&&['character-spin','perk-spin'].includes(state.phase)){
   if(state.packId.endsWith('challenge')){state.phase=state.run.draw.kind==='character'?'character-result':'perk-result';state.nextAt=Date.now()+3000;if(state.run.draw.kind==='character')state.run.characterId=state.run.draw.itemId;else state.run.perkIds.push(state.run.draw.itemId);}
   else{state.phase='complete';state.run.perkIds=state.run.draw.kind==='perk'?[state.run.draw.itemId]:[];}state.revision++;
  }else if(state.phase==='character-result'&&state.nextAt<=Date.now()){state.phase='polling';state.run.pollId='poll-fixture';state.run.pollEndsAt=Date.now()+15000;state.nextAt=null;state.revision++;}
 };
 await context.routeWebSocket(/.*/,ws=>{
  if(ws.url().includes('api.domdimabot.com')){
   widgetSocket=ws;
   ws.send('0'+JSON.stringify({sid:'mock',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1e6}));
   ws.onMessage(message=>{const text=String(message);if(text.startsWith('40/overlays/widgets/')){const namespace='/overlays/widgets/991801';ws.send('40'+namespace+','+JSON.stringify({sid:'widgets-fixture'}));ws.send('42'+namespace+','+JSON.stringify(['widgets-catalog',catalog]));ws.send('42'+namespace+','+JSON.stringify(['widgets-state',wireState()]));}});
  }else ws.close();
 });
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();
  if(url.hostname==='assets.deadbydaylight.com'||url.hostname==='deadbydaylight.wiki.gg')return portrait(route);
  if(url.hostname!=='api.domdimabot.com')return route.abort();
  let data={};
  if(url.pathname==='/auth/session')data={twitch:user,app};
  else if(url.pathname.endsWith('/access'))data={allowed:true,role:owner?'owner':'moderator',planTier:tier};
  else if(url.pathname.startsWith('/auth/access/'))data={allowed:true};
  else if(url.pathname.includes('/live-status'))data={isLive:false,currentViewers:0};
  else if(url.pathname.startsWith('/widgets/')){
   widgetReads++;if(tier!=='pro')return route.fulfill({status:403,json:{error:true,code:'pro_required'}});
   if(failRead&&req.method()==='GET')return route.fulfill({status:503,json:{error:true}});
   finish();state.serverTime=Date.now();
   if(req.method()==='GET')data=url.pathname.endsWith('/catalog')?catalog:structuredClone(wireState());
   else{
    const body=req.postDataJSON()||{};
    if(url.pathname.endsWith('/overlay-token')){state.revision++;data={token:'a'.repeat(43)};}
    else{
     writes++;assert(req.headers()['idempotency-key']);assert(req.headers()['if-match']);
     if(conflict){conflict=false;return route.fulfill({status:409,json:{error:true,code:'revision_conflict'}});}
     const action=url.pathname.split('/').at(-1);
     if(action==='select'){state.packId=body.packId;state.run=null;state.phase='idle';}
     if(action==='configure')state.config=body;
     if(action==='hide')state.visible=false;if(action==='show')state.visible=true;
     if(action==='reset'){state.phase='idle';state.run=null;}
     if(action==='start'){
      const pack=catalog.packs.find(p=>p.id===state.packId),kind=pack.mode==='perks'?'perk':'character';
      const pool=catalog.entries.filter(e=>e.role===pack.role&&e.kind===kind&&e.available&&!state.config.excludedIds.includes(e.id));
      state.run={id:'run-fixture',characterId:null,perkIds:[],draw:{id:'draw-fixture',kind,design:kind==='perk'?'wheel':state.config.characterDesign,itemId:pool.at(-1).id,poolIds:pool.map(e=>e.id),startedAt:Date.now(),endsAt:Date.now()+1000},cards:[null,null,null,null,null],votes:[0,0,0,0,0],channelPointsVotes:[0,0,0,0,0],winningCard:null,perkCount:null,pollId:null,pollTitle:'fixture',pollEndsAt:null,error:null};state.phase=kind==='perk'?'perk-spin':'character-spin';state.visible=true;
     }
     state.revision++;data=structuredClone(wireState());
    }
   }
  }
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+`/${owner?'widgetfixture':'other'}/modules/widgets`);
 return {context,page,state,writes:()=>writes,reads:()=>widgetReads,errors,publish:()=>{manualDraw=true;state.serverTime=Date.now();state.revision++;widgetSocket.send('42/overlays/widgets/991801,'+JSON.stringify(['widgets-state',wireState()]));},setConflict:()=>conflict=true,setFail:v=>failRead=v};
}
const axeClean=async(page,include)=>{const result=await new AxeBuilder({page}).include(include).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);};
const overflow=async page=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
const rouletteFits=async page=>assert(await page.locator('app-roulette-display .display').evaluateAll(displays=>displays.every(display=>{const outer=display.getBoundingClientRect();return [...display.querySelectorAll('.top,.wheel svg,.cards,.reel,.royale')].every(el=>{const inner=el.getBoundingClientRect();return inner.x>=outer.x-1&&inner.right<=outer.right+1;});})),'shared roulette title and every design fit inside their display');
try{
 for(const width of process.env.SAAS_WIDGET_POLL_ONLY ? [] : [320,390,1280])for(const theme of ['light','dark']){
  const f=await fixture({width,theme});const {page}=f;await page.getByTestId('dbd-killer-perks').waitFor();
  assert.equal(await page.locator('.pack').count(),6);await overflow(page);await axeClean(page,'[data-testid="widgets-page"]');
  if(shots)await page.screenshot({path:`${shots}/gallery-${width}-${theme}.png`,fullPage:true});
  await page.getByTestId('dbd-killer-perks').click();await page.getByRole('button',{name:'Use this widget',exact:true}).click();await page.getByRole('button',{name:'Start widget',exact:true}).waitFor();
  const before=f.writes();await page.getByRole('button',{name:'Start widget',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(f.writes(),before,'no effect before confirm');
  await axeClean(page,'dialog');await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(f.writes(),before);
  await page.getByRole('button',{name:'Start widget',exact:true}).click();await page.getByRole('button',{name:'Start on stream',exact:true}).click();
  await page.getByText('Your result is ready',{exact:true}).waitFor({timeout:10000});assert.equal(f.state.run.perkIds.length,1);
  await page.locator('app-roulette-display .display[data-design="wheel"][data-state="done"]').waitFor();assert.equal(await page.locator('app-roulette-display .display').getAttribute('data-winner'),f.state.run.draw.itemId);assert.equal(await page.locator('app-roulette-display path.seg').count(),f.state.run.draw.poolIds.length);assert.equal(await page.locator('.wheel-wrap').count(),0);await rouletteFits(page);await axeClean(page,'[data-testid="widgets-page"]');
  if(shots)await page.screenshot({path:`${shots}/shared-wheel-${width}-${theme}.png`,fullPage:true});
  await page.getByRole('button',{name:'Create OBS link',exact:true}).click();await page.getByRole('button',{name:'Copy',exact:true}).waitFor();assert((await page.getByLabel('OBS browser source',{exact:true}).inputValue()).includes('#'+'a'.repeat(43)));
  await page.locator('.entry-picker summary').click();await page.getByPlaceholder('Search names in English or Spanish').fill('bond');
  await page.waitForFunction(()=>document.querySelectorAll('.entry').length===0);
  assert.equal(await page.locator('.entry').count(),0,'killer entries do not include survivor Bond');
  await page.getByPlaceholder('Search names in English or Spanish').fill('');await page.locator('.entry').first().locator('input').uncheck();await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByText('All changes saved',{exact:true}).waitFor();assert.equal(f.state.config.excludedIds.length,1);await overflow(page);
  assert.deepEqual(f.errors,[]);await f.context.close();
 }
 // Full challenge preview and reveal, Spanish labels, stale state and conflict recovery.
 const f=await fixture({width:390,lang:'es'});await f.page.getByTestId('dbd-survivor-challenge').click();await f.page.getByRole('button',{name:'Usar este widget',exact:true}).click();
 await f.page.getByLabel('Permitir votos extra con puntos del canal',{exact:true}).check();
 const cost=f.page.getByLabel('Puntos del canal por voto extra',{exact:true});
 for(const value of ['0','1.5','1000001']){await cost.fill(value);const before=f.writes();await f.page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();await f.page.getByText('Introduce un número entero entre 1 y 1.000.000.',{exact:true}).waitFor();assert.equal(f.writes(),before);}
 await cost.fill('250');await f.page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();await f.page.getByText('Cambios guardados',{exact:true}).waitFor();assert.equal(f.state.config.channelPointsVoting,true);assert.equal(f.state.config.channelPointsPerVote,250);
 assert.equal(await f.page.locator('a[href$="/modules/overlays"]').count(),0,'poll display does not require another overlay');
 await f.page.getByRole('button',{name:'Iniciar widget',exact:true}).click();await f.page.getByRole('dialog').getByText('Un voto gratis por espectador. Cada voto extra cuesta 250 puntos del canal. Vota en la encuesta de Twitch.',{exact:true}).waitFor();await f.page.getByRole('button',{name:'Iniciar en stream',exact:true}).click();
 await f.page.getByText('Personaje seleccionado',{exact:true}).waitFor({timeout:10000});await f.page.locator('app-roulette-display [data-state="done"]').waitFor();assert.equal(await f.page.getByTestId('widget-poll').count(),0,'character result remains visible before the poll');await f.page.waitForTimeout(2100);assert.equal(await f.page.locator('app-roulette-display').count(),1,'result is shown for at least two seconds');
 await f.page.locator('.mystery').first().waitFor({timeout:10000});assert.deepEqual(await f.page.locator('.mystery strong').allTextContents(),['?','?','?','?','?']);await axeClean(f.page,'[data-testid="widgets-page"]');
 Object.assign(f.state.run,{votes:[10,0,25,0,0],channelPointsVotes:[0,0,20,0,0]});f.state.revision++;
 await f.page.getByTestId('widget-poll').getByText('35 votos',{exact:true}).waitFor({timeout:10000});await f.page.getByText('5 normales · 20 con puntos',{exact:true}).waitFor();assert.deepEqual(await f.page.locator('.vote-percent').allTextContents(),['29%','0%','71%','0%','0%']);assert.deepEqual(await f.page.locator('.mystery strong').allTextContents(),['?','?','?','?','?']);await overflow(f.page);await axeClean(f.page,'[data-testid="widgets-page"]');
 if(shots)await f.page.screenshot({path:`${shots}/hidden-poll-390-es.png`,fullPage:true});
 Object.assign(f.state.run,{cards:[2,0,4,1,3],votes:[0,0,30,0,0],winningCard:2,perkCount:4});f.state.phase='reveal';f.state.revision++;
 await f.page.getByText('Carta 3 revelada: 4 ventajas',{exact:true}).waitFor({timeout:10000});assert.deepEqual(await f.page.locator('.mystery strong').allTextContents(),['2','0','4','1','3']);
 f.state.phase='complete';f.state.run.perkIds=catalog.entries.filter(e=>e.role==='survivor'&&e.kind==='perk').slice(0,4).map(e=>e.id);f.state.revision++;await f.page.waitForFunction(()=>document.querySelectorAll('.loadout-perks>div').length===4);await f.page.locator('.challenge-character').waitFor();
 await overflow(f.page);await f.page.getByLabel('Permitir votos extra con puntos del canal',{exact:true}).uncheck();await f.page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();await f.page.getByText('Cambios guardados',{exact:true}).waitFor();assert.equal(f.state.config.channelPointsVoting,false);assert.equal(await f.page.getByLabel('Puntos del canal por voto extra',{exact:true}).count(),0);await f.context.close();
 for(const tier of ['free','premium']){const g=await fixture({tier});await g.page.getByText('Widgets Alpha requires Pro',{exact:true}).waitFor();assert.equal(g.reads(),0);assert.equal(g.writes(),0);await axeClean(g.page,'[data-testid="widgets-page"]');await g.context.close();}
 const mod=await fixture({owner:false});await mod.page.waitForURL(url=>url.searchParams.get('permission')==='channel:owner');assert.equal(mod.reads(),0);await mod.context.close();
 const obs=await fixture({lang:'en'});obs.state.config.language='es';obs.state.config.channelPointsVoting=true;obs.state.config.channelPointsPerVote=250;obs.state.visible=true;obs.state.phase='polling';obs.state.run={id:'obs-poll',characterId:catalog.entries.find(e=>e.role==='killer'&&e.kind==='character').id,perkIds:[],draw:null,cards:[null,null,null,null,null],votes:[10,0,25,0,0],channelPointsVotes:[0,0,20,0,0],winningCard:null,perkCount:null,pollId:'obs-native-poll',pollTitle:'fixture',pollEndsAt:Date.now()+30000,error:null};await obs.page.goto(base+'/overlays/widgets/991801#'+'a'.repeat(43));await obs.page.getByRole('heading',{name:'Reto de asesino',exact:true}).waitFor();assert.equal(await obs.page.locator('app-widget-display').count(),1);await obs.page.getByTestId('widget-poll').getByText('35 votos',{exact:true}).waitFor();await obs.page.getByText('5 normales · 20 con puntos',{exact:true}).waitFor();await obs.page.getByText('Un voto gratis por espectador. Cada voto extra cuesta 250 puntos del canal. Vota en la encuesta de Twitch.',{exact:true}).waitFor();assert.equal(await obs.page.locator('app-overlay-interaction').count(),0);await overflow(obs.page);await axeClean(obs.page,'.stage');if(shots)await obs.page.screenshot({path:`${shots}/obs-poll-1280-es.png`,fullPage:true});assert.deepEqual(obs.errors,[]);await obs.context.close();
 // Exercise frozen native wheel inputs in OBS: full pools, custom order, repeated draws,
 // late joins, a one-entry pool, and reduced motion. The same renderer owns every animation.
 for(const role of ['killer','survivor'])for(const width of [320,1280]){
  const wheel=await fixture({width,lang:'en'});wheel.state.packId=`dbd-${role}-perks`;wheel.state.config.language='es';wheel.state.visible=true;
  const perks=catalog.entries.filter(e=>e.role===role&&e.kind==='perk'&&e.available).reverse();
  const ids=perks.map(e=>e.id), winner=perks[3], now=Date.now();
  wheel.state.phase='perk-spin';wheel.state.run={id:'wheel-run',characterId:null,perkIds:[],draw:{id:`frozen-${role}-${width}`,kind:'perk',itemId:winner.id,poolIds:ids,startedAt:now-1000,endsAt:now+1000},cards:[],votes:[],channelPointsVotes:[],winningCard:null,perkCount:null,pollId:null,pollTitle:'',pollEndsAt:null,error:null};
  // A change in the editable pool cannot replace the frozen draw's entries.
  wheel.state.config.excludedIds=[winner.id];
  await wheel.page.goto(base+'/overlays/widgets/991801#'+'a'.repeat(43));
  const display=wheel.page.locator('app-roulette-display .display');await display.locator('.wheel svg').waitFor();assert.equal(await display.locator('path.seg').count(),ids.length);assert.equal(await wheel.page.locator('.wheel-wrap').count(),0);
  await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor({timeout:5000});assert.equal(await display.getAttribute('data-winner'),winner.id);assert.equal(await display.locator('path.seg--win').count(),1);assert(await display.locator('path.seg').nth(3).evaluate(e=>e.classList.contains('seg--win')),'frozen pool order determines winner segment');await display.getByText('Ganador',{exact:true}).waitFor();
  await overflow(wheel.page);await rouletteFits(wheel.page);await axeClean(wheel.page,'.stage');if(shots)await wheel.page.screenshot({path:`${shots}/obs-shared-wheel-${role}-${width}.png`,fullPage:true});
  // A late-joining OBS source immediately displays the server-selected winner.
  await wheel.page.reload();await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor();assert.equal(await display.getAttribute('data-winner'),winner.id);
  wheel.state.packId=`dbd-${role}-challenge`;wheel.state.run.characterId=catalog.entries.find(e=>e.role===role&&e.kind==='character').id;wheel.state.run.perkCount=4;wheel.state.run.perkIds=[winner.id];
  const second=perks[4];wheel.state.run.draw={id:'next-perk',kind:'perk',itemId:second.id,poolIds:[perks[5].id,second.id,perks[6].id],startedAt:Date.now()-2000,endsAt:Date.now()-1000};wheel.publish();await display.locator(`.result-label`).getByText(second.spanish,{exact:true}).waitFor();assert.equal(await display.locator('path.seg').count(),3);assert.equal(await display.getAttribute('data-draw'),'next-perk');assert.equal(await display.getAttribute('data-winner'),second.id);
  await wheel.page.emulateMedia({reducedMotion:'reduce'});wheel.state.run.draw={id:'reduced-perk',kind:'perk',itemId:second.id,poolIds:[second.id],startedAt:Date.now(),endsAt:Date.now()+5000};wheel.publish();await wheel.page.locator('[data-draw="reduced-perk"][data-state="drawing"]').waitFor();assert.equal(await display.locator('svg>g').first().getAttribute('transform'),'rotate(0 200 200)');assert.equal(await display.locator('path.seg').count(),0);wheel.state.run.draw.endsAt=Date.now()-1;wheel.state.run.draw.startedAt=Date.now()-5000;wheel.publish();await display.locator('.result-label').getByText(second.spanish,{exact:true}).waitFor();await overflow(wheel.page);wheel.state.phase='perk-result';wheel.state.run.perkIds=[second.id];wheel.publish();await wheel.page.getByText('Ventaja seleccionada',{exact:true}).waitFor();await display.locator('.result-label').getByText(second.spanish,{exact:true}).waitFor();assert.equal(await display.locator('path.seg').count(),0);await wheel.page.reload();await display.locator('.result-label').getByText(second.spanish,{exact:true}).waitFor();wheel.state.phase='complete';wheel.state.run.perkIds=[winner,second,perks[5],perks[6]].map(e=>e.id);wheel.publish();await wheel.page.locator('.loadout-perks>div').nth(3).waitFor();assert.equal(await wheel.page.locator('app-roulette-display').count(),0,'completed challenge returns to its loadout');wheel.state.run.perkCount=0;wheel.state.run.perkIds=[];wheel.publish();await wheel.page.getByText('Sin ventajas en esta ronda',{exact:true}).waitFor();assert.equal(await wheel.page.locator('app-roulette-display').count(),0,'zero perks does not create a wheel');assert.deepEqual(wheel.errors,[]);await wheel.context.close();
 }
 // Streamer choice is saved, survives reload, and is frozen for each character draw.
 for(const role of ['killer','survivor']){
  const f=await fixture({width:390});await f.page.getByTestId(`dbd-${role}-characters`).click();await f.page.getByRole('button',{name:'Use this widget',exact:true}).click();
  const selector=f.page.getByLabel('Character roulette style',{exact:true});assert.equal(await selector.inputValue(),'cards');
  for(const design of ['reel','wheel','elimination','cards']){
   await selector.selectOption(design);await f.page.getByRole('button',{name:'Save settings',exact:true}).click();await f.page.getByText('All changes saved',{exact:true}).waitFor();assert.equal(f.state.config.characterDesign,design);await f.page.reload();assert.equal(await selector.inputValue(),design);
   await f.page.getByRole('button',{name:'Start widget',exact:true}).click();await f.page.getByRole('button',{name:'Start on stream',exact:true}).click();await f.page.getByText('Your result is ready',{exact:true}).waitFor({timeout:10000});
   const display=f.page.locator(`app-roulette-display .display[data-design="${design}"][data-state="done"]`);await display.waitFor();assert.equal(await display.getAttribute('data-winner'),f.state.run.draw.itemId);const winner=catalog.entries.find(e=>e.id===f.state.run.draw.itemId);await display.locator('.result-label').getByText(winner.english,{exact:true}).waitFor();assert.equal(await display.locator({cards:'.card.has-image',reel:'.reel-card.has-image',wheel:'path.seg',elimination:'.chip.has-image'}[design]).count(),design==='reel'?9:f.state.run.draw.poolIds.length);assert.equal(await f.page.locator('.character-cards,.character-card,.draw-result').count(),0);
   await overflow(f.page);await rouletteFits(f.page);await axeClean(f.page,'[data-testid="widgets-page"]');if(shots)await f.page.screenshot({path:`${shots}/character-${role}-${design}-390.png`,fullPage:true});
  }
  assert.deepEqual(f.errors,[]);await f.context.close();
 }
 // OBS displays the full frozen character pool using all four shared designs and saved portraits.
 for(const role of ['killer','survivor'])for(const design of ['cards','reel','wheel','elimination'])for(const width of [320,760]){
  const f=await fixture({width});f.state.packId=`dbd-${role}-characters`;f.state.config.language='es';f.state.config.characterDesign=design==='cards'?'reel':'cards';f.state.config.includeUnavailable=true;f.state.visible=true;
  const characters=catalog.entries.filter(e=>e.role===role&&e.kind==='character').reverse(),winner=characters[4],now=Date.now();
  f.state.phase='character-spin';f.state.run={id:'character-obs',characterId:null,perkIds:[],draw:{id:'character-draw',kind:'character',design,itemId:winner.id,poolIds:characters.map(e=>e.id),startedAt:now-2000,endsAt:now-1000},cards:[null,null,null,null,null],votes:[0,0,0,0,0],channelPointsVotes:[0,0,0,0,0],winningCard:null,perkCount:null,pollId:null,pollTitle:'',pollEndsAt:null,error:null};
  await f.page.goto(base+'/overlays/widgets/991801#'+'a'.repeat(43));const display=f.page.locator('app-roulette-display .display');await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor();assert.equal(await display.getAttribute('data-design'),design,'the draw design wins over changed settings');assert.equal(await display.getAttribute('data-winner'),winner.id);await display.getByText('Ganador',{exact:true}).waitFor();
  assert.equal(await display.locator({cards:'.card',reel:'.reel-card',wheel:'path.seg',elimination:'.chip'}[design]).count(),design==='reel'?9:characters.length);const winning=display.locator({cards:'.card.winner',reel:'.reel-card.winner',wheel:'.result',elimination:'.chip.winner'}[design]);await winning.getByText(winner.spanish,{exact:true}).waitFor();assert(await winning.locator('img').count(),'character winner receives its portrait');await winning.locator('img').evaluate(e=>{if(!e.src.startsWith('https://assets.deadbydaylight.com/')&&!e.src.startsWith('https://deadbydaylight.wiki.gg/'))throw Error('Wrong portrait source');});
  if(design==='elimination'){assert.equal(await display.locator('.chip.out').count(),characters.length-1);assert.equal(await display.locator('.chip:not(.out)').count(),1);}if(design==='wheel')assert.equal(await display.locator('svg image').count(),0);
  await rouletteFits(f.page);await overflow(f.page);await axeClean(f.page,'.stage');if(shots)await f.page.screenshot({path:`${shots}/obs-character-${role}-${design}-${width}.png`,fullPage:true});if(width===760)assert(await f.page.locator('.stage').evaluate(e=>e.getBoundingClientRect().bottom<=900),'full character pool fits recommended 760x900 OBS source');
  if(role==='killer'&&design==='cards'&&width===320){await f.context.route(winner.image_url,route=>route.fulfill({status:404,body:''}));await f.page.reload();await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor();await winning.locator('img').waitFor({state:'detached'});assert.equal(await display.getAttribute('data-winner'),winner.id,'failed portraits preserve the character result');}
  await f.page.reload();await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor();assert.equal(await display.getAttribute('data-winner'),winner.id);
  // A result stage keeps the same frozen roulette across reconnects before the poll.
  f.state.packId=`dbd-${role}-challenge`;f.state.phase='character-result';f.state.run.characterId=winner.id;f.state.nextAt=Date.now()+3000;f.publish();await f.page.getByText('Personaje seleccionado',{exact:true}).waitFor();assert.equal(await f.page.getByTestId('widget-poll').count(),0);await f.page.reload();await display.locator('.result-label').getByText(winner.spanish,{exact:true}).waitFor();assert.equal(await display.getAttribute('data-design'),design);if(width===760)assert(await f.page.locator('.stage').evaluate(e=>e.getBoundingClientRect().bottom<=900),'result stage fits the recommended OBS source');
  // The same OBS source moves from the shared character roulette to its native poll.
  f.state.packId=`dbd-${role}-challenge`;f.state.phase='polling';f.state.run.characterId=winner.id;f.state.run.pollEndsAt=Date.now()+15000;f.publish();await f.page.getByTestId('widget-poll').waitFor();assert.equal(await f.page.locator('app-roulette-display').count(),0);await f.page.locator('.selected-character').getByText(winner.spanish,{exact:true}).waitFor();assert.deepEqual(await f.page.locator('.mystery strong').allTextContents(),['?','?','?','?','?']);assert.deepEqual(f.errors,[]);await f.context.close();
 }
 const failed=await fixture();await failed.page.getByTestId('dbd-killer-characters').waitFor();failed.setFail(true);await failed.page.getByRole('alert').waitFor({timeout:10000});assert.equal(await failed.page.locator('.pack').count(),6);failed.setFail(false);await failed.page.getByRole('button',{name:'Retry',exact:true}).click();await failed.context.close();
 console.log(process.env.SAAS_WIDGET_POLL_ONLY ? 'PASS widget polls and shared roulettes: paid-vote settings, validation, live counts, hidden-card reveal, OBS poll, Pro/owner gates, Spanish labels, axe and overflow checks' : 'PASS widget gallery: mobile/desktop light/dark, six presets, all four character styles, three-second result stages and portrait draws, frozen character pools and design, shared wheel frozen pools, winner alignment, OBS late joins, repeated draws and reduced motion, confirmation, OBS link, custom pools, embedded poll in dashboard and OBS, paid-vote settings and validation, live percentages and regular/Channel Points votes, Spanish hidden/revealed cards, owner/Pro gates, stale-data recovery, axe and overflow checks');
}finally{await browser.close();}
