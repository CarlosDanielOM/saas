// Widget hub cards: live status per widget, per-card failures, locked view on free plans.
// Every API is mocked. No live channel is read or changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require=createRequire((process.env.SAAS_BROWSER_TOOLS??'/tmp/saas-cooldown-browser')+'/package.json');
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base);const evidence=process.env.SAAS_SCREENSHOT_DIR??'/tmp/widgets-hub-evidence';mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
const rules={hp:100,damage:100,extraTurnChance:15,heavyChance:24,specialChance:8,critChance:10,defenseChance:15,healChance:20,healCharges:5,healMin:25,healMax:40,comboHealChance:35,streamerBoost:200,streamerUltimate:40,ultimate:2};
const sequence=()=>({character:true,fixedCharacterId:null,poll:true,perks:true,perkCount:4});
const dbdState=visible=>({wins:{killer:2,survivor:1},loadouts:{killer:{characterId:null,perkIds:[]},survivor:{characterId:null,perkIds:[]}},revision:1,serverTime:Date.now(),packId:'dbd-killer-challenge',visible,config:{language:'en',characterDesign:'cards',spinSeconds:1,pollSeconds:15,channelPointsVoting:false,channelPointsPerVote:100,includeUnavailable:false,excludedIds:[],perkTuning:{},subWheels:[],sequences:{killer:sequence(),survivor:sequence()},targets:{killer:3,survivor:4}},phase:'idle',run:null,nextAt:null});
async function fixture({theme='dark',width=1280,lang='en',tier='pro',connected=true,custom=false,leaderboard=true,visible=true,fail=[]}={}){
 const context=await browser.newContext({viewport:{width,height:900}});
 const user={id:'991801',login:'duelfixture',display_name:'Fixture'};
 const app={name:'Fixture',email:'fixture@example.invalid',language:lang,plan_tier:tier,actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
 await context.addInitScript(({user,app,theme,lang})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('theme',theme);},{user,app,theme,lang});
 const requests=[];
 await context.routeWebSocket(/.*/,ws=>ws.close());
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.hostname!=='api.domdimabot.com')return route.abort();requests.push(req.method()+' '+url.pathname);
  assert.equal(req.method(),'GET','the hub only reads');
  let data={};
  if(url.pathname==='/auth/session')data={twitch:user,app};else if(url.pathname.endsWith('/access'))data={allowed:true,role:'owner',planTier:tier};else if(url.pathname.startsWith('/auth/access/'))data={allowed:true};
  else if(url.pathname==='/widgets/991801/duel'){if(fail.includes('duel'))return route.fulfill({status:503,json:{error:true,status:503,message:'down'}});data={revision:3,serverTime:Date.now(),connected,settings:{enabled:true,timeoutEnabled:true,timeoutSeconds:60,language:lang,leaderboard,rivalries:true,rules:custom?{...rules,hp:200}:rules},challenge:null,run:null};}
  else if(url.pathname==='/widgets/991801/duel/leaderboard')data={players:[{login:'sharpshooter',kills:6,deaths:2,kd:3}],ranked:1,duels:154,status:!leaderboard?'off':custom?'paused':'live'};
  else if(url.pathname==='/widgets/991801'){if(fail.includes('dbd'))return route.fulfill({status:503,json:{error:true,status:503,message:'down'}});data=dbdState(visible);}
  return route.fulfill({json:{error:false,status:200,data}});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/duelfixture/modules/widgets');
 return {context,page,errors,requests};
}
const clean=async page=>{const a=await new AxeBuilder({page}).include('app-widgets-hub').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');};
const until=async(check,message,ms=5000)=>{const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw new Error(message);await new Promise(r=>setTimeout(r,100));}};
try{
 for(const theme of ['dark','light'])for(const width of [320,390,1280]){
  const f=await fixture({theme,width});const duel=f.page.getByTestId('widget-duel'),dbd=f.page.getByTestId('widget-dbd');
  await duel.getByText('In OBS',{exact:true}).waitFor();await dbd.getByText('2 / 3 wins',{exact:true}).waitFor();
  await f.page.getByTestId('hub-live').getByText('2 of 2 live on stream').waitFor();
  await f.page.waitForTimeout(400);await clean(f.page);await f.page.screenshot({path:`${evidence}/hub-${theme}-${width}.png`,fullPage:true});assert.deepEqual(f.errors,[]);await f.context.close();
 }
 // Answers on the duel card: fights, top fighter by K/D, rules, mode.
 let f=await fixture();const duel=f.page.getByTestId('widget-duel');
 await duel.getByText('154',{exact:true}).waitFor();await duel.getByText('sharpshooter').waitFor();await duel.getByText('Balanced',{exact:true}).waitFor();
 assert.equal(await duel.locator('app-duel-fighter').count(),2,'two fighters on the card');
 assert.equal(await f.page.getByTestId('widget-dbd').locator('app-widget-streak').count(),2,'killer and survivor emblems');
 await duel.click();await f.page.waitForURL(/\/modules\/widgets\/duel$/);await f.context.close();
 f=await fixture();await f.page.getByTestId('widget-dbd').click();await f.page.waitForURL(/\/modules\/widgets\/dbd$/);await f.context.close();
 // Custom rules, leaderboard off, overlay offline, DBD hidden.
 f=await fixture({custom:true,leaderboard:false,connected:false,visible:false});let card=f.page.getByTestId('widget-duel');
 await card.getByText('Chat only',{exact:true}).waitFor();await card.getByText('Custom',{exact:true}).waitFor();await card.getByText('Leaderboard off',{exact:true}).waitFor();
 await f.page.getByTestId('widget-dbd').getByText('Hidden',{exact:true}).waitFor();await f.page.getByTestId('hub-live').getByText('0 of 2 live on stream').waitFor();await clean(f.page);await f.context.close();
 // One API failing never hides the other card.
 f=await fixture({fail:['duel']});await f.page.getByTestId('widget-duel').getByText('Could not load the status',{exact:false}).waitFor();await f.page.getByTestId('widget-dbd').getByText('2 / 3 wins').waitFor();
 assert.equal(await f.page.getByTestId('widget-duel').getAttribute('href'),'/duelfixture/modules/widgets/duel','the card still opens the widget');await f.context.close();
 // Spanish.
 f=await fixture({lang:'es'});await f.page.getByTestId('widget-duel').getByText('En OBS',{exact:true}).waitFor();await f.page.getByTestId('widget-dbd').getByText('2 / 3 victorias').waitFor();await clean(f.page);await f.page.screenshot({path:`${evidence}/hub-es.png`,fullPage:true});await f.context.close();
 // Free plan: the cards are a locked showcase and no widget API is called.
 f=await fixture({tier:'free'});await f.page.getByRole('heading',{name:'Widgets Alpha requires Premium'}).waitFor();await f.page.waitForTimeout(500);
 assert(!f.requests.some(r=>r.includes('/widgets/')),'no widget reads on free plans');assert.equal(await f.page.getByTestId('widget-duel').getAttribute('href'),null,'locked cards are not links');
 await clean(f.page);await f.page.screenshot({path:`${evidence}/hub-free.png`,fullPage:true});await f.context.close();
 console.log('widgets hub browser check passed');
}finally{await browser.close();}
