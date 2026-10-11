// Mock every external request. Only preview/candidate assets are fetched from the web server.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
const require=createRequire(`${process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser'}/package.json`);
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base);
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
const shots=process.env.SAAS_SCREENSHOT_DIR||'/tmp/overlay-link-evidence';mkdirSync(shots,{recursive:true});
const root=process.env.SAAS_OVERLAY_REPO||process.cwd();
const catalog={...JSON.parse(readFileSync(root+'/dimabot/src/widgets/dbd.json','utf8')),packs:['killer','survivor'].flatMap(role=>['challenge','characters','perks'].map(mode=>({id:`dbd-${role}-${mode}`,game:'Dead by Daylight',role,mode})))};
const sequence=()=>({character:true,fixedCharacterId:null,poll:true,perks:true,perkCount:4});
const widgets={wins:{killer:0,survivor:0},loadouts:{killer:{characterId:null,perkIds:[]},survivor:{characterId:null,perkIds:[]}},revision:1,packId:'dbd-killer-challenge',visible:false,config:{language:'en',characterDesign:'cards',spinSeconds:4,pollSeconds:30,channelPointsVoting:false,channelPointsPerVote:100,jokerChance:0,jokerPointsPerVote:100,includeUnavailable:false,excludedIds:[],perkTuning:{},sequences:{killer:sequence(),survivor:sequence()},layout:{cameraCorner:'bottom-right',cameraWidth:512,cameraHeight:288,loadoutMode:'detailed',autoCompact:true,progressStyle:'badges',showActive:true,showInfo:true,showProgress:true,hideActiveDuringGameplay:true},targets:{killer:3,survivor:4}},phase:'idle',run:null,nextAt:null};
const duel={revision:1,connected:false,settings:{enabled:true,timeoutEnabled:true,timeoutSeconds:60,language:'en',leaderboard:true,rivalries:true,quality:'low'},challenge:null,run:null};
const roulette={revision:1,roulettes:[{id:'r',name:'Prizes',alias:'prizes',design:'wheel',cardSize:'medium',durationSeconds:5,colors:['#cbbaff','#f4c968'],items:[{id:'prize',label:'A prize',weight:1,multiplier:1,copies:['copy']}],order:['copy'],settings:{insertion:'append',duplicate:'separate',shuffleBeforeDraw:false,showOnStart:true,hideAfterSeconds:null,winnerAction:'keep'}}],activeId:'r',visible:false,draw:null,history:[],hideAt:null};
const states={widgets,duel,roulette},routes={widgets:'/modules/widgets/dbd',duel:'/modules/widgets/duel',roulette:'/modules/roulette'};
const apiPath=kind=>kind==='roulette'?'/roulettes/991801':`/widgets/991801${kind==='duel'?'/duel':''}`;
const strings={en:(await(await fetch(base+'/assets/i18n/en.json')).json()).overlayLinks,es:(await(await fetch(base+'/assets/i18n/es.json')).json()).overlayLinks};assert.deepEqual(Object.keys(strings.en).sort(),Object.keys(strings.es).sort());
async function fixture(kind,store,{width=1280,theme='dark',admin=false,lang='en',cached=false}={}){
 const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});
 const user={id:admin?'991802':'991801',login:admin?'adminfixture':'linkfixture',display_name:'Fixture'};
 const app={name:'Fixture',email:'fixture@example.invalid',language:lang,plan_tier:admin?'free':'pro',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:admin?[{channelID:'991801',channelName:'linkfixture'}]:[]};
 await context.addInitScript(({user,app,theme,lang,kind,cached})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('theme',theme);if(cached){const url=location.origin+'/overlays/'+kind+'/991801#'+'l'.repeat(43);if(kind==='roulette')localStorage.setItem('roulette.overlay.991801',url);else sessionStorage.setItem(kind+'-overlay-991801',url);}}, {user,app,theme,lang,kind,cached});
 const writes=[],requests=[],errors=[];let failGet=false,conflict=false,lost=false;
 await context.routeWebSocket(/.*/,ws=>ws.close());
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.hostname!=='api.domdimabot.com')return route.abort();requests.push(url.pathname);
  let data={};if(url.pathname==='/auth/session')data={twitch:user,app};else if(url.pathname.endsWith('/access'))data={allowed:true,role:admin?'admin':'owner',planTier:'pro'};else if(url.pathname.startsWith('/auth/access/'))data={allowed:true};else if(url.pathname.includes('/live-status'))data={isLive:false,currentViewers:0};else if(url.pathname.startsWith('/widgets/')||url.pathname.startsWith('/roulettes/')){
   assert(url.pathname.startsWith(apiPath(kind)),'Admin must use the selected streamer channel, not their own');
   if(url.pathname.endsWith('/overlay-token')){
    if(req.method()==='GET'){if(failGet)return route.fulfill({status:503,json:{error:true}});data={token:store.recoverable?store.token:null,exists:!!store.token,version:store.version};}
    else{const body=req.postDataJSON()||{};writes.push(body);if(body.rotate){if(conflict){conflict=false;store.token='c'.repeat(43);store.version='c'.repeat(64);store.recoverable=true;return route.fulfill({status:409,json:{error:true,code:'overlay_link_conflict'}});}assert.equal(body.version,store.version);const letter=store.token==='b'.repeat(43)?'d':'b';store.token=letter.repeat(43);store.version=letter.repeat(64);store.recoverable=true;}
     else if(body.token){if(body.token!==store.token)return route.fulfill({status:409,json:{error:true,code:'overlay_link_invalid'}});store.recoverable=true;}
     else if(!store.token){store.token='a'.repeat(43);store.version='a'.repeat(64);store.recoverable=true;}
     data={token:store.recoverable?store.token:null,exists:!!store.token,version:store.version};if(lost){lost=false;return route.abort();}
    }
   }else if(url.pathname.endsWith('/catalog'))data=catalog;else if(url.pathname.endsWith('/events'))data={settings:{enabled:false,active:false,activeSince:null,allowTestEvents:false,rules:[]}};else if(url.pathname.endsWith('/leaderboard'))data={players:[],ranked:0,duels:0,status:'live'};else data={...states[kind],serverTime:Date.now()};
  }
  await route.fulfill({json:{error:false,status:200,data}});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/linkfixture'+routes[kind]);
 await page.waitForFunction(value=>document.documentElement.getAttribute('data-theme')===value,theme);
 const link=page.locator('app-overlay-link');await link.waitFor();await link.getByText(strings[lang].loading,{exact:true}).waitFor({state:'hidden'});
 return {page,context,link,writes,requests,errors,fail:value=>failGet=value,conflict:()=>conflict=true,lost:()=>lost=true};
}
async function clean(f){const result=await new AxeBuilder({page:f.page}).include('app-overlay-link').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),[]);assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow');assert.deepEqual(f.errors,[]);}
try{
 for(const kind of ['duel','widgets','roulette']){
  const store={token:null,version:null,recoverable:false};const first=await fixture(kind,store,{admin:true});
  await first.link.getByRole('button',{name:strings.en.create,exact:true}).click();await first.link.getByLabel(strings.en.privateLink,{exact:true}).waitFor();
  const initial=await first.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue();assert(initial.endsWith('/overlays/'+kind+'/991801#'+'a'.repeat(43)));assert.deepEqual(first.writes,[{}]);
  if(kind==='duel'){assert((await first.link.getByLabel(strings.en.leaderboardLink,{exact:true}).inputValue()).endsWith('/leaderboard#'+'a'.repeat(43)));await first.link.getByRole('button',{name:strings.en.copyLeaderboard,exact:true}).click();assert.equal(await first.page.evaluate(()=>navigator.clipboard.readText()),await first.link.getByLabel(strings.en.leaderboardLink,{exact:true}).inputValue());}
  const owner=await fixture(kind,store);assert.equal(await owner.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue(),initial);assert.equal(owner.writes.length,0,'Streamer visit never recreates link');
  await owner.page.reload();await owner.link.getByLabel(strings.en.privateLink,{exact:true}).waitFor();assert.equal(await owner.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue(),initial);assert.equal(owner.writes.length,0,'Reload keeps server-saved link');
  const next=await fixture(kind,store,{admin:true});assert.equal(await next.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue(),initial);assert.equal(next.writes.length,0,'Another admin uses same link');
  await next.link.getByRole('button',{name:strings.en.replace,exact:true}).click();await next.link.getByRole('dialog').waitFor();await next.link.getByRole('dialog').getByText(strings.en[kind==='duel'?'replaceDuelWarning':'replaceWarning'].replace('{{streamer}}','linkfixture'),{exact:true}).waitFor();await clean(next);assert.equal(next.writes.length,0,'Replacement requires confirmation');await next.link.getByRole('button',{name:strings.en.cancel,exact:true}).click();assert.equal(next.writes.length,0);
  next.conflict();await next.link.getByRole('button',{name:strings.en.replace,exact:true}).click();await next.link.getByRole('button',{name:strings.en.confirmReplace,exact:true}).click();await next.link.getByText(strings.en.conflict,{exact:true}).waitFor();assert((await next.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue()).endsWith('#'+'c'.repeat(43)));await next.link.getByRole('button',{name:strings.en.retry,exact:true}).click();await next.link.getByRole('button',{name:strings.en.replace,exact:true}).waitFor();
  await next.link.getByRole('button',{name:strings.en.replace,exact:true}).click();await next.link.getByRole('button',{name:strings.en.confirmReplace,exact:true}).click();await next.link.getByText(strings.en.saved,{exact:true}).waitFor();assert.deepEqual(next.writes.at(-1),{rotate:true,version:'c'.repeat(64)});assert((await next.link.getByLabel(strings.en.privateLink,{exact:true}).inputValue()).endsWith('#'+'b'.repeat(43)));
  next.lost();await next.link.getByRole('button',{name:strings.en.replace,exact:true}).click();await next.link.getByRole('button',{name:strings.en.confirmReplace,exact:true}).click();await next.link.getByText(strings.en.saveError,{exact:true}).waitFor();assert.equal(await next.link.getByRole('dialog').count(),0,'Lost replacement response closes dialog so Retry is reachable');await next.link.getByRole('button',{name:strings.en.retry,exact:true}).click();await next.page.waitForFunction(()=>document.querySelector('app-overlay-link input[readonly]')?.value.endsWith('#'+'d'.repeat(43)));assert.equal(next.writes.length,3,'Retry reads accepted replacement without rotating again');
  for(const f of [first,owner,next])await f.context.close();
  for(const theme of ['dark','light'])for(const width of [320,390,1280]){
   const f=await fixture(kind,store,{theme,width,admin:true});await f.link.getByLabel(strings.en.privateLink,{exact:true}).waitFor();await clean(f);if(kind==='roulette'&&width<640){const box=await f.page.locator('.lf-setup__copy').boundingBox();assert(box.width>=160&&box.x+box.width<=width,'Roulette setup text remains readable on phones');}await f.link.screenshot({path:`${shots}/${kind}-${theme}-${width}.png`});
   await f.link.getByRole('button',{name:strings.en.replace,exact:true}).click();await f.link.getByRole('dialog').waitFor();await clean(f);await f.page.screenshot({path:`${shots}/${kind}-confirm-${theme}-${width}.png`});await f.context.close();
  }
  const legacy={token:'l'.repeat(43),version:'l'.repeat(64),recoverable:false};const old=await fixture(kind,legacy,{width:320,lang:'es'});
  assert.equal(await old.link.getByRole('button',{name:strings.es.create,exact:true}).count(),0,'Legacy links never offer Create');
  await old.link.getByLabel(strings.es.existingLink,{exact:true}).fill(base+'/overlays/'+kind+'/991802#'+'l'.repeat(43));await old.link.getByRole('button',{name:strings.es.saveExisting,exact:true}).click();await old.link.getByText(strings.es.invalidLink,{exact:true}).waitFor();assert.equal(old.writes.length,0,'Reject a different channel before sending');
  await old.link.getByLabel(strings.es.existingLink,{exact:true}).fill(base+'/overlays/'+kind+'/991801'+(kind==='duel'?'/leaderboard':'')+'#'+'l'.repeat(43));await old.link.getByRole('button',{name:strings.es.saveExisting,exact:true}).click();await old.link.getByLabel(strings.es.privateLink,{exact:true}).waitFor();assert.deepEqual(old.writes,[{token:'l'.repeat(43)}]);await clean(old);await old.context.close();
  legacy.recoverable=false;const cached=await fixture(kind,legacy,{cached:true});await cached.link.getByLabel(strings.en.privateLink,{exact:true}).waitFor();assert.deepEqual(cached.writes,[{token:'l'.repeat(43)}],'Old browser cache saves the same OBS URL');await cached.context.close();
  const outage=await fixture(kind,{token:null,version:null,recoverable:false});outage.fail(true);await outage.page.reload();await outage.link.getByText(strings.en.loadError,{exact:true}).waitFor();assert.equal(await outage.link.getByRole('button',{name:strings.en.create,exact:true}).count(),0);assert.equal(outage.writes.length,0);outage.fail(false);await outage.link.getByRole('button',{name:strings.en.retry,exact:true}).click();await outage.link.getByRole('button',{name:strings.en.create,exact:true}).waitFor();outage.lost();await outage.link.getByRole('button',{name:strings.en.create,exact:true}).click();await outage.link.getByText(strings.en.saveError,{exact:true}).waitFor();await outage.link.getByRole('button',{name:strings.en.retry,exact:true}).click();await outage.link.getByLabel(strings.en.privateLink,{exact:true}).waitFor();assert.equal(outage.writes.length,1,'Lost response retrieves saved link without recreating');await outage.context.close();
  console.log('PASS '+kind+' browser: admins/owner, reload, confirmation/conflict, legacy/cache, errors, 320/390/1280 dark/light + accessibility');
 }
}finally{await browser.close();}
