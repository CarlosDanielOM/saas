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
 const sequence=()=>({character:true,fixedCharacterId:null,poll:true,perks:true,perkCount:4});
 const layout={cameraCorner:'bottom-right',cameraWidth:512,cameraHeight:288,loadoutMode:'detailed',autoCompact:true,progressStyle:'badges',showActive:true,showInfo:true,showProgress:true,hideActiveDuringGameplay:true};
 const state={wins:{killer:2,survivor:0},loadouts:{killer:{characterId:null,perkIds:[]},survivor:{characterId:null,perkIds:[]}},revision:1,serverTime:Date.now(),packId:'dbd-killer-challenge',visible:false,config:{language:lang,characterDesign:'cards',spinSeconds:1,pollSeconds:15,channelPointsVoting:false,channelPointsPerVote:100,includeUnavailable:false,excludedIds:[],sequences:{killer:sequence(),survivor:sequence()},layout,targets:{killer:3,survivor:4}},phase:'idle',run:null,nextAt:null};
 const wireState=()=>({...state,phase:state.phase==='character-result'?'character-spin':state.phase==='perk-result'?'perk-spin':state.phase,resultPhase:['character-result','perk-result'].includes(state.phase)?state.phase:undefined});
 const actionLog=[],receipts=new Map();
 let writes=0,widgetReads=0,conflict=false,failRead=false,lostResponse=false,manualDraw=false,widgetSocket;
 const role=()=>state.packId.includes('-survivor-')?'survivor':'killer';
 const draw=(kind)=>{
  const pool=catalog.entries.filter(e=>e.role===role()&&e.kind===kind&&e.available&&!state.config.excludedIds.includes(e.id)&&!state.run.perkIds.includes(e.id));
  state.run.draw={id:crypto.randomUUID(),kind,design:kind==='perk'?'wheel':state.config.characterDesign,itemId:pool.at(-1).id,poolIds:pool.map(e=>e.id),startedAt:Date.now(),endsAt:Date.now()+1000};
  state.phase=kind==='perk'?'perk-spin':'character-spin';state.nextAt=state.run.draw.endsAt;
 };
 const afterCharacter=()=>{
  if(state.run.operation==='characters'){state.phase='complete';state.nextAt=null;}
  else if(state.run.operation==='poll'||state.run.sequence.poll){state.phase='polling';state.run.pollId='poll-fixture';state.run.pollEndsAt=Date.now()+15000;state.nextAt=null;}
  else if(state.run.sequence.perks&&state.run.perkCount>0)draw('perk');else {state.phase='complete';state.nextAt=null;}
 };
 const finish=()=>{
  if(manualDraw)return;
  if(state.nextAt&&state.nextAt<=Date.now()&&['character-spin','perk-spin'].includes(state.phase)){
   if(state.run.draw.kind==='character'){state.run.characterId=state.run.draw.itemId;state.loadouts[role()].characterId=state.run.characterId;}
   else{state.run.perkIds.push(state.run.draw.itemId);state.loadouts[role()].perkIds=[...state.run.perkIds];}
   state.phase=state.run.operation==='challenge'?(state.run.draw.kind==='character'?'character-result':'perk-result'):'complete';state.nextAt=state.phase==='complete'?null:Date.now()+3000;state.revision++;
  }else if(state.phase==='character-result'&&state.nextAt<=Date.now()){afterCharacter();state.revision++;}
  else if(state.phase==='perk-result'&&state.nextAt<=Date.now()){if(state.run.perkIds.length<state.run.perkCount)draw('perk');else{state.phase='complete';state.nextAt=null;}state.revision++;}
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
     const key=req.headers()['idempotency-key'];
     actionLog.push({action,body,key,revision:req.headers()['if-match']});
     if(receipts.has(key))return route.fulfill({json:{error:false,status:200,data:structuredClone(wireState())}});
     receipts.set(key,true);
     if(action==='role'){state.packId=`dbd-${body.role}-challenge`;state.run=null;state.phase='idle';}
     if(action==='configure')state.config=body;
     if(action==='layout')state.config.layout=body;
     if(action==='progress')state.wins[body.role]=Math.max(0,Math.min(state.config.targets[body.role],state.wins[body.role]+body.delta));
     if(action==='hide')state.visible=false;if(action==='show')state.visible=true;
     if(action==='reset'){state.phase='idle';state.run=null;}
     if(action==='start'){
      const mode=body.mode||'challenge',r=role(),seq=structuredClone(state.config.sequences[r]),previous=state.loadouts[r];
      state.packId=`dbd-${r}-${mode==='poll'?'challenge':mode}`;
      state.run={operation:mode,sequence:seq,id:crypto.randomUUID(),characterId:mode==='challenge'&&!seq.character?seq.fixedCharacterId:mode==='characters'||mode==='challenge'?null:previous.characterId,perkIds:mode==='challenge'?[]:[...previous.perkIds],draw:null,cards:[null,null,null,null,null],votes:[0,0,0,0,0],channelPointsVotes:[0,0,0,0,0],winningCard:null,perkCount:mode==='challenge'&&!seq.poll?seq.perkCount:null,pollId:null,pollTitle:'fixture',pollEndsAt:null,error:null};
      if(mode==='challenge')state.loadouts[r]={characterId:state.run.characterId,perkIds:[]};
      state.visible=true;
      if(mode==='characters'||mode==='challenge'&&seq.character)draw('character');else if(mode==='perks')draw('perk');else afterCharacter();
     }
     state.revision++;data=structuredClone(wireState());if(lostResponse){lostResponse=false;return route.abort();}
    }
   }
  }
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+`/${owner?'widgetfixture':'other'}/modules/widgets`);
 return {context,page,state,writes:()=>writes,reads:()=>widgetReads,errors,actions:actionLog,setLost:()=>lostResponse=true,publish:()=>{manualDraw=true;state.serverTime=Date.now();state.revision++;widgetSocket.send('42/overlays/widgets/991801,'+JSON.stringify(['widgets-state',wireState()]));},setConflict:()=>conflict=true,setFail:v=>failRead=v};
}
const axeClean=async(page,include)=>{const result=await new AxeBuilder({page}).include(include).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);};
const overflow=async page=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
const wait=async(page)=>page.waitForTimeout(1750);
const canvasGeometry=async page=>page.getByTestId('widget-canvas').evaluate(frame=>{
 const outer=frame.getBoundingClientRect(),scale=outer.width/1920;
 const rect=selector=>{const r=frame.querySelector(selector)?.getBoundingClientRect();return r?{x:(r.x-outer.x)/scale,y:(r.y-outer.y)/scale,width:r.width/scale,height:r.height/scale,right:(r.right-outer.x)/scale,bottom:(r.bottom-outer.y)/scale}:null;};
 return {active:rect('[data-testid=widget-active]'),info:rect('[data-testid=widget-info]'),camera:rect('[data-testid=widget-camera]'),progress:rect('[data-testid=widget-progress]')};
});
const close=(a,b)=>assert(Math.abs(a-b)<2,`${a} ≈ ${b}`);
const cornerNames={'top-left':'Top left','top-right':'Top right','bottom-left':'Bottom left','bottom-right':'Bottom right'};
const until=async(check,message,timeout=4000)=>{const end=Date.now()+timeout;while(!(await check())){if(Date.now()>end)throw new Error(message);await new Promise(r=>setTimeout(r,50));}};
const icons=(page,scope,role,state)=>page.locator(`${scope} app-widget-streak.${role} [data-state=${state}]`).count();
try{
 for(const width of [320,390,1280])for(const theme of ['light','dark']){
  const f=await fixture({width,theme}),{page}=f;await page.getByTestId('start-sequence').waitFor();
  assert.equal(await page.getByTestId('dbd-challenge').count(),1);assert.equal(await page.locator('.pack').count(),0);
  await overflow(page);await axeClean(page,'[data-testid="widgets-page"]');
  await page.getByTestId('role-survivor').click();await page.waitForFunction(()=>document.querySelector('[data-testid=role-survivor]')?.getAttribute('aria-pressed')==='true');
  const survivor=page.locator('.sequence-card').nth(1);
  await survivor.getByLabel('Draw a random character').uncheck();
  const fixed=catalog.entries.find(e=>e.role==='survivor'&&e.kind==='character'&&e.available);
  await page.getByTestId('fixed-survivor').selectOption(fixed.id);
  await survivor.getByLabel('Vote for the perk count on Twitch').uncheck();await survivor.getByLabel('Fixed perk count (0–4)').fill('2');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByText('Widget updated.',{exact:true}).waitFor();
  assert.equal(f.state.config.sequences.survivor.character,false);assert.equal(f.state.config.sequences.killer.character,true);
  await page.getByTestId('start-sequence').click();await page.locator('app-roulette-display .display[data-design=wheel]').waitFor();assert.equal(f.state.run.characterId,fixed.id);assert.equal(f.state.phase,'perk-spin');
  await page.locator('app-roulette-display .display[data-state=done]').waitFor({timeout:7000});await page.waitForTimeout(1600);assert.equal(f.state.phase,'perk-result');
  assert.equal(await page.getByTestId('widget-poll').count(),0);
  if(shots)await page.screenshot({path:`${shots}/control-${width}-${theme}.png`,fullPage:true});
  await overflow(page);assert.deepEqual(f.errors,[]);await f.context.close();console.log(`PASS control center ${width}px ${theme}`);
 }
 const f=await fixture(),{page}=f;await page.getByTestId('start-sequence').waitFor();
 // Standalone uses all existing renderer styles and preserves saved loadouts/progress.
 for(const design of ['cards','reel','wheel','elimination']){
  await page.getByLabel('Character roulette style',{exact:true}).selectOption(design);await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByTestId('draw-character').waitFor({state:'visible'});await page.waitForTimeout(250);
  await page.getByTestId('draw-character').click();await page.locator(`app-roulette-display .display[data-design=${design}]`).waitFor();
  await page.locator(`app-roulette-display .display[data-design=${design}][data-state=done]`).waitFor({timeout:7000});
  assert.equal(await page.locator('app-roulette-display .display').getAttribute('data-winner'),f.state.run.draw.itemId);
 }
 // Layout moves around every corner; compact keeps the detailed panel's anchor.
 for(const corner of ['top-left','top-right','bottom-left','bottom-right'])for(const [width,height] of [[512,288],[384,600],[800,640],[320,180]]){
  await page.getByRole('radio',{name:cornerNames[corner],exact:true}).check();await page.getByLabel('Camera width (320–800 px)').fill(String(width));await page.getByLabel('Camera height (180–640 px)').fill(String(height));
  await page.getByRole('radio',{name:'Detailed',exact:true}).check();await page.waitForTimeout(60);const detailed=await canvasGeometry(page);
  await page.getByRole('radio',{name:'Compact',exact:true}).check();await page.waitForTimeout(60);const compact=await canvasGeometry(page);
  close(compact.info.x,detailed.info.x);close(compact.info.y,detailed.info.y);close(compact.camera.width,width);close(compact.camera.height,height);
  close(compact.active.x,corner.endsWith('left')?96+width:64);close(compact.info.y,corner.startsWith('top')?96+height:64);
  for(const r of Object.values(compact)){assert(r.x>=0&&r.y>=0&&r.right<=1921&&r.bottom<=1081,'canvas contains every region');}
  const overlaps=(a,b)=>a.x<b.right-1&&a.right>b.x+1&&a.y<b.bottom-1&&a.bottom>b.y+1;
  assert(!overlaps(compact.info,compact.camera));assert(!overlaps(compact.active,compact.camera));assert(!overlaps(compact.progress,compact.camera));
 }
 await page.getByRole('button',{name:'Save layout',exact:true}).click();await page.waitForTimeout(250);
 const oldWidth=f.state.config.layout.cameraWidth;
 await page.getByRole('button',{name:'Resize camera width',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.getByRole('button',{name:'Save layout',exact:true}).click();await page.waitForTimeout(250);assert.equal(f.state.config.layout.cameraWidth,oldWidth+16);
 await page.getByRole('button',{name:'Resize camera height',exact:true}).scrollIntoViewIfNeeded();const handle=await page.getByRole('button',{name:'Resize camera height',exact:true}).boundingBox(),canvas=await page.getByTestId('widget-canvas').boundingBox(),oldHeight=f.state.config.layout.cameraHeight;
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2-60*canvas.width/1920);await page.mouse.up();await page.getByRole('button',{name:'Save layout',exact:true}).click();await page.waitForTimeout(250);close(f.state.config.layout.cameraHeight,oldHeight+60);
 await page.getByRole('radio',{name:'Bar',exact:true}).check();await page.waitForTimeout(60);let g=await canvasGeometry(page);close(g.progress.width,g.active.width);close(g.progress.x,g.active.x);
 await page.locator('details.more').evaluate(d=>{d.open=true;});await page.getByLabel('Show active area',{exact:true}).uncheck();await page.getByTestId('widget-active').waitFor({state:'hidden'});assert.equal(await page.getByTestId('widget-active').count(),0);await page.getByLabel('Show active area',{exact:true}).check();
 // Win streak: no animation on load; a recorded win forges a skull (and the goal flare) in the tile and the preview.
 assert.equal(await page.locator('app-widget-streak [data-state=fresh],app-widget-streak [data-state=lost]').count(),0);
 await page.getByTestId('win-killer').click();await wait(page);assert.equal(f.state.wins.killer,3);
 for(const scope of ['.wins','[data-testid=widget-progress]']){await until(async()=>await icons(page,scope,'killer','fresh')===1,`fresh skull in ${scope}`);assert.equal(await page.locator(`${scope} app-widget-streak.killer [data-state=fresh] .fire`).count(),1);}
 assert(await page.locator('.wins app-widget-streak.killer').evaluate(e=>e.classList.contains('complete')&&e.classList.contains('finale')));
 assert.equal(await page.locator('.wins app-widget-streak.killer [data-state=flare]').count(),2);
 await page.locator('.win-row[data-role=killer]').getByRole('button',{name:'Undo win',exact:true}).click();await wait(page);assert.equal(f.state.wins.killer,2);
 await until(async()=>await icons(page,'.wins','killer','lost')===1,'crumbling skull after undo');assert.equal(await page.locator('.wins app-widget-streak.killer [data-state=lost] .smoke').count(),1);
 await page.getByTestId('win-killer').click();await wait(page);assert.equal(f.state.wins.killer,3);
 // Preview plays the survivor hatch locally, records nothing, then closes it again.
 const quiet=f.writes();await page.getByRole('button',{name:'Preview the Survivor win animation',exact:true}).click();
 for(const scope of ['.wins','[data-testid=widget-progress]'])await until(async()=>await page.locator(`${scope} app-widget-streak.survivor [data-state=fresh] .light`).count()===1,`hatch preview in ${scope}`);
 assert.equal(f.writes(),quiet);assert.equal(f.state.wins.survivor,0);
 await until(async()=>await icons(page,'.wins','survivor','lost')===1&&await icons(page,'.wins','survivor','fresh')===0,'preview hatch closes',5000);assert.equal(f.writes(),quiet);
 await page.getByRole('button',{name:'Create OBS link',exact:true}).click();await page.getByRole('button',{name:'Copy',exact:true}).waitFor();
 const link=await page.getByLabel('OBS browser source',{exact:true}).inputValue();assert(link.includes('/overlays/widgets/991801#'));
 await page.getByTestId('role-survivor').click();await wait(page);assert.equal(await page.getByLabel('OBS browser source',{exact:true}).inputValue(),link);assert.equal(f.state.wins.killer,3);
 // Native poll requires confirmation and stays inside this same preview.
 const before=f.writes();await page.getByTestId('start-poll').click();await page.getByRole('dialog').waitFor();assert.equal(f.writes(),before);await axeClean(page,'dialog');await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(f.writes(),before);
 await page.getByTestId('start-poll').click();await page.getByRole('button',{name:'Start on stream',exact:true}).click();await page.getByTestId('widget-poll').waitFor();assert.equal(f.state.run.operation,'poll');assert.equal(await page.locator('.mystery strong').allTextContents().then(v=>v.every(x=>x==='?')),true);
 assert.deepEqual(f.errors,[]);
 // An accepted draw with a lost HTTP response retries the original key and mode.
 f.state.phase='complete';f.state.nextAt=null;await wait(page);f.setLost();await page.getByTestId('draw-perk').click();await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'});const retry=f.actions.slice(-2);assert.equal(retry[0].key,retry[1].key);assert.deepEqual(retry[0].body,{mode:'perks'});
 // OBS source uses the whole canvas, has no camera guides, and follows visibility.
 await page.goto(base+'/overlays/widgets/991801#'+'a'.repeat(43));await page.getByTestId('widget-canvas').waitFor();assert.equal(await page.getByTestId('widget-camera').count(),0);
 assert.equal(await page.locator('app-widget-streak [data-state=fresh],app-widget-streak [data-state=lost]').count(),0,'a freshly loaded OBS source does not replay old wins');
 f.state.wins.survivor=1;f.publish();await until(async()=>await page.locator('[data-testid=widget-progress] app-widget-streak.survivor [data-state=fresh] .hatch').count()===1,'OBS opens a hatch for a new survivor win');
 await page.emulateMedia({reducedMotion:'reduce'});f.state.wins.survivor=2;f.publish();await until(async()=>await icons(page,'[data-testid=widget-progress]','survivor','fresh')===1&&await page.locator('[data-testid=widget-progress] app-widget-streak.survivor').getAttribute('data-wins')==='2','reduced-motion win');
 assert.deepEqual(await page.locator('[data-testid=widget-progress] app-widget-streak.survivor [data-state=fresh]').evaluate(e=>[getComputedStyle(e.querySelector('.light')).display,getComputedStyle(e.querySelector('.lid')).animationName]),['none','none']);await page.emulateMedia({reducedMotion:'no-preference'});const frame=await page.getByTestId('widget-canvas').boundingBox();close(frame.width,1280);close(frame.height,720);
 f.state.visible=false;f.publish();await page.getByTestId('widget-canvas').waitFor({state:'hidden'});f.state.visible=true;f.publish();await page.getByTestId('widget-canvas').waitFor();
 if(shots)await page.screenshot({path:`${shots}/obs-source.png`,fullPage:true});assert.deepEqual(f.errors,[]);await f.context.close();
 for(const tier of ['free','premium']){const gated=await fixture({tier});await gated.page.getByText('Widgets Alpha requires Pro',{exact:true}).waitFor();assert.equal(gated.reads(),0);await gated.context.close();}
 const spanish=await fixture({lang:'es',width:390});await spanish.page.getByRole('button',{name:'Iniciar ronda',exact:true}).waitFor();await overflow(spanish.page);await axeClean(spanish.page,'[data-testid="widgets-page"]');assert.deepEqual(spanish.errors,[]);await spanish.context.close();
 console.log('PASS unified DBD browser: plain-language round status and step track, skull/hatch win animations (control, preview, OBS, undo, local preview, reduced motion), one control center, per-role fixed character/skip settings, standalone actions, four existing roulette styles, result holds, every camera corner/size, compact alignment, progress, single OBS link, hidden cards, poll confirmation, uncertain-response replay, visibility, Pro gate, EN/ES, light/dark, mobile/desktop, AXE');
}finally{await browser.close();}
