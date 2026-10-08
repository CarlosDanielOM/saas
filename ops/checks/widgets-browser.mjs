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
async function fixture({width=1280,tier='pro',theme='dark',lang='en',owner=true}={}){
 const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});
 const user={id:'991801',login:'widgetfixture',display_name:'Widget Fixture'};
 const app={name:'Widget Fixture',email:'test@example.invalid',language:lang,plan_tier:tier,actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:owner?[]:[{channelID:'991802',channelName:'other'}]};
 await context.addInitScript(({user,app,theme,lang})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('dimasite.theme',theme);document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.toggle('dark',theme==='dark'));},{user,app,theme,lang});
 const state={revision:1,serverTime:Date.now(),packId:'dbd-killer-challenge',visible:false,config:{language:lang,spinSeconds:1,pollSeconds:15,channelPointsVoting:false,channelPointsPerVote:100,includeUnavailable:false,excludedIds:[]},phase:'idle',run:null,nextAt:null};
 let writes=0,widgetReads=0,conflict=false,failRead=false,lostResponse=false;
 const finish=()=>{if(state.run?.draw&&state.run.draw.endsAt<=Date.now()&&['character-spin','perk-spin'].includes(state.phase)){if(state.packId.endsWith('challenge')){state.phase='polling';state.run.characterId=state.run.draw.itemId;state.run.pollId='poll-fixture';state.run.pollEndsAt=Date.now()+15000;}else{state.phase='complete';state.run.perkIds=state.run.draw.kind==='perk'?[state.run.draw.itemId]:[];}state.revision++;}};
 await context.routeWebSocket(/.*/,ws=>{
  if(ws.url().includes('api.domdimabot.com')){
   ws.send('0'+JSON.stringify({sid:'mock',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1e6}));
   ws.onMessage(message=>{const text=String(message);if(text.startsWith('40/overlays/widgets/')){const namespace='/overlays/widgets/991801';ws.send('40'+namespace+','+JSON.stringify({sid:'widgets-fixture'}));ws.send('42'+namespace+','+JSON.stringify(['widgets-catalog',catalog]));ws.send('42'+namespace+','+JSON.stringify(['widgets-state',state]));}});
  }else ws.close();
 });
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();
  if(url.hostname==='assets.deadbydaylight.com'||url.hostname==='deadbydaylight.wiki.gg')return route.continue();
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
   if(req.method()==='GET')data=url.pathname.endsWith('/catalog')?catalog:structuredClone(state);
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
      state.run={id:'run-fixture',characterId:null,perkIds:[],draw:{id:'draw-fixture',kind,itemId:pool.at(-1).id,poolIds:pool.map(e=>e.id),startedAt:Date.now(),endsAt:Date.now()+1000},cards:[null,null,null,null,null],votes:[0,0,0,0,0],channelPointsVotes:[0,0,0,0,0],winningCard:null,perkCount:null,pollId:null,pollTitle:'fixture',pollEndsAt:null,error:null};state.phase=kind==='perk'?'perk-spin':'character-spin';state.visible=true;
     }
     state.revision++;data=structuredClone(state);
    }
   }
  }
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+`/${owner?'widgetfixture':'other'}/modules/widgets`);
 return {context,page,state,writes:()=>writes,reads:()=>widgetReads,errors,setConflict:()=>conflict=true,setFail:v=>failRead=v};
}
const axeClean=async(page,include)=>{const result=await new AxeBuilder({page}).include(include).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);};
const overflow=async page=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
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
 const failed=await fixture();await failed.page.getByTestId('dbd-killer-characters').waitFor();failed.setFail(true);await failed.page.getByRole('alert').waitFor({timeout:10000});assert.equal(await failed.page.locator('.pack').count(),6);failed.setFail(false);await failed.page.getByRole('button',{name:'Retry',exact:true}).click();await failed.context.close();
 console.log(process.env.SAAS_WIDGET_POLL_ONLY ? 'PASS focused widget poll: paid-vote settings, validation, live counts, hidden-card reveal, OBS poll, Pro/owner gates, Spanish labels, axe and overflow checks' : 'PASS widget gallery: mobile/desktop light/dark, six presets, wheel draw, confirmation, OBS link, custom pools, embedded poll in dashboard and OBS, paid-vote settings and validation, live percentages and regular/Channel Points votes, Spanish hidden/revealed cards, owner/Pro gates, stale-data recovery, axe and overflow checks');
}finally{await browser.close();}
