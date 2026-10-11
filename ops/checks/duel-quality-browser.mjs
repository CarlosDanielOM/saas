// Duel overlay quality tiers. Every external API/socket is mocked; no live channel is changed.
// SAAS_PREVIEW_URL=http://127.0.0.1:4251 node ops/checks/duel-quality-browser.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require=createRequire('/tmp/saas-cooldown-browser/package.json');
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base,'SAAS_PREVIEW_URL is required');
const evidence=process.env.SAAS_SCREENSHOT_DIR||'/tmp/duel-quality-evidence';mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
// Software WebGL frames starve requestAnimationFrame: poll on an interval.
const poll={timeout:90000,polling:200};
const ARENAS={low:'app-duel-arena',medium:'app-duel-claude-arena',high:'app-duel-astra-arena',extreme:'app-duel-claude-3d-arena'};
const CANVAS='[data-testid=duel-claude-3d-canvas]';

async function fixture({theme='dark',width=1280,height=1000,lang='en',overlay=false,quality,noWebgl=false}={}){
 const context=await browser.newContext({viewport:{width,height}});
 const user={id:'991801',login:'duelfixture',display_name:'Fixture'};
 const app={name:'Fixture',email:'fixture@example.invalid',language:lang,plan_tier:'pro',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
 await context.addInitScript(({user,app,theme,lang,noWebgl})=>{
  localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('theme',theme);
  // OBS with hardware acceleration off: no WebGL context at all.
  if(noWebgl){const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...rest){return /webgl/.test(type)?null:get.call(this,type,...rest);};}
 },{user,app,theme,lang,noWebgl});
 const settings={enabled:true,timeoutEnabled:true,timeoutSeconds:60,language:lang,leaderboard:true,rivalries:true};if(quality)settings.quality=quality;
 const state={revision:1,serverTime:Date.now(),connected:true,settings,challenge:null,run:null};
 let socket,namespace;const writes=[];
 const publish=()=>{state.serverTime=Date.now();state.revision++;socket.send('42'+namespace+','+JSON.stringify(['duel-state',state]));};
 await context.routeWebSocket(/.*/,ws=>{if(!ws.url().includes('api.domdimabot.com'))return ws.close();socket=ws;ws.send('0'+JSON.stringify({sid:'fixture',upgrades:[],pingInterval:25000,pingTimeout:20000}));ws.onMessage(message=>{const text=String(message);if(text.startsWith('40/overlays/duel/')){namespace=text.slice(2,text.indexOf(','));ws.send('40'+namespace+','+JSON.stringify({sid:'fixture'}));publish();}});});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin===new URL(base).origin)return route.continue();if(url.hostname!=='api.domdimabot.com')return route.abort();
  let data={};if(url.pathname==='/auth/session')data={twitch:user,app};else if(url.pathname.endsWith('/access'))data={allowed:true,role:'owner',planTier:'pro'};else if(url.pathname.startsWith('/auth/access/'))data={allowed:true};
  else if(url.pathname.includes('/widgets/')){if(req.method()==='GET'&&url.pathname.endsWith('/duel/leaderboard'))data={players:[],ranked:0,duels:0};else if(req.method()==='GET')data={...state,serverTime:Date.now()};else{const body=req.postDataJSON();writes.push(body);state.settings=body;state.revision++;data=state;}}
  return route.fulfill({json:{error:false,status:200,data}});});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+(overlay?'/overlays/duel/991801#'+'a'.repeat(43):'/duelfixture/modules/widgets/duel'));
 return {context,page,state,writes,errors,publish};
}
const clean=async page=>{const a=await new AxeBuilder({page}).include('app-duel-page').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);};
const frames=page=>page.waitForFunction(c=>Number(document.querySelector(c)?.dataset.frames)>0,CANVAS,poll);
// A tracked overlay fight: head-to-head 4–2, mage (enraged streamer) vs ronin.
const turns=[{at:3700,hitAt:3980,attacker:'left',move:'normal',damage:12,bonus:false},{at:4500,hitAt:5350,attacker:'right',move:'special',damage:40,bonus:false},{at:6100,hitAt:6550,attacker:'right',move:'heavy',damage:26,bonus:true},{at:7400,hitAt:8250,attacker:'right',move:'special',damage:30,bonus:false}];
const run=(startedAgo,endsIn=13150-startedAgo)=>({id:'q'+startedAgo,challenger:'alice',opponent:'bob',winner:'right',fighters:{left:'mage',right:'ronin'},enraged:'right',turns,mode:'overlay',startedAt:Date.now()-startedAgo,endsAt:Date.now()+endsIn,completedAt:null,record:{left:4,right:2}});
const started=Date.now();
try{
 // Dashboard: four tiers, the original by default, the preview follows the choice, and it saves.
 const d=await fixture({width:1280});const p=d.page;await p.getByTestId('quality-picker').waitFor({timeout:90000});
 assert.equal(await p.getByTestId('quality-low').isChecked(),true,'older channels read as Low');
 assert.equal(await p.locator('.preview app-duel-stage '+ARENAS.low).count(),1);
 for(const level of ['medium','high','extreme']){await p.getByTestId('quality-'+level).check();await p.locator('.preview app-duel-stage '+ARENAS[level]).waitFor({timeout:90000});for(const other of Object.keys(ARENAS).filter(k=>k!==level))assert.equal(await p.locator('.preview '+ARENAS[other]).count(),0);}
 await frames(p);await p.getByTestId('quality-gpu-note').waitFor();await clean(p);await p.screenshot({path:evidence+'/page-extreme-1280.png',fullPage:true});
 await p.getByRole('button',{name:'Save settings',exact:true}).click();await p.getByText('Duel settings saved.',{exact:true}).waitFor();assert.equal(d.writes.at(-1).quality,'extreme');
 await p.reload();await p.getByTestId('quality-picker').waitFor({timeout:90000});await p.waitForFunction(()=>document.querySelector('[data-testid=quality-extreme]')?.checked,null,poll);
 await p.getByTestId('quality-high').check();await p.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await p.getByTestId('quality-extreme').isChecked(),true,'discard restores the saved look');
 assert.deepEqual(d.errors,[]);await d.context.close();console.log(`${Math.round((Date.now()-started)/1000)}s PASS dashboard picker: default Low, live preview per tier, save, reload, discard`);
 for(const [width,theme,lang] of [[390,'dark','en'],[390,'light','es']]){const f=await fixture({width,theme,lang,quality:'medium'});await f.page.getByTestId('quality-picker').waitFor({timeout:90000});await f.page.locator('.preview '+ARENAS.medium).waitFor();await clean(f.page);await f.page.getByTestId('quality-picker').screenshot({path:`${evidence}/picker-${width}-${theme}-${lang}.png`});assert.deepEqual(f.errors,[]);await f.context.close();console.log(`${Math.round((Date.now()-started)/1000)}s PASS picker layout + AXE ${width}px ${theme} ${lang}`);}

 // OBS overlay: each tier renders its own arena on a transparent page, with the head-to-head.
 for(const quality of ['low','medium','high','extreme']){
  const o=await fixture({overlay:true,quality,width:1280,height:720});await o.page.waitForFunction(()=>document.body.style.background==='transparent');
  o.state.run=run(200);o.publish();await o.page.locator('app-duel-stage '+ARENAS[quality]).waitFor({timeout:90000});
  for(const other of Object.keys(ARENAS).filter(k=>k!==quality))assert.equal(await o.page.locator(ARENAS[other]).count(),0,`${quality} renders only its arena`);
  // The 3D chunk loads on demand: restart the fight once it draws so the entrance is on screen.
  if(quality==='extreme'){await frames(o.page);o.state.run=run(200);o.publish();}
  await o.page.locator('.rivalry[data-stage="intro"]').waitFor({timeout:30000});assert.equal(await o.page.locator('.rivalry').first().getAttribute('aria-label'),'Head-to-head: alice 4, bob 2');
  if(quality==='extreme'){
   await frames(o.page);assert.equal(await o.page.locator(CANVAS).getAttribute('data-renderer'),'claude');
   assert.equal(await o.page.locator('.arena-edition').count(),0,'no lab badge in production');assert.equal(await o.page.locator('.arena-bottom b').count(),0,'no FPS counter in production');
   // Transparent: the stream shows through away from the fighters; the arena itself paints nothing.
   // Transparent: most of the frame must let the stream through (the fighters and HUD paint the rest).
   const shot=await o.page.screenshot({path:`${evidence}/obs-extreme-alpha.png`,omitBackground:true});
   const clear=await o.page.evaluate(async b64=>{const i=new Image();i.src='data:image/png;base64,'+b64;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);const d=g.getImageData(0,0,c.width,c.height).data;let n=0;for(let k=3;k<d.length;k+=4)if(d[k]<10)n++;return n/(d.length/4);},shot.toString('base64'));
   assert(clear>.35,`transparent background (${(clear*100).toFixed(0)}% clear)`);
  }
  if(quality!=='low')assert.equal(await o.page.getByText('ASTRA / 04').count(),0,'no lab label in production');
  await o.page.waitForTimeout(quality==='extreme'?2500:600);await o.page.screenshot({path:`${evidence}/obs-${quality}-intro.png`});
  o.state.run=run(9000);o.publish();await o.page.waitForTimeout(quality==='extreme'?4000:1200);await o.page.screenshot({path:`${evidence}/obs-${quality}-fight.png`});
  o.state.run=run(13700,-550);o.publish();await o.page.locator('.rivalry-line',{hasText:'alice still leads the rivalry 4–3'}).waitFor({timeout:30000});
  await o.page.screenshot({path:`${evidence}/obs-${quality}-winner.png`});
  assert.deepEqual(o.errors,[]);await o.context.close();console.log(`${Math.round((Date.now()-started)/1000)}s PASS OBS ${quality}: own arena, transparent, rivalry intro and winner line`);
 }
 // Hardware acceleration off: Extreme falls back to High instead of an error card.
 const fb=await fixture({overlay:true,quality:'extreme',noWebgl:true,width:1280,height:720});await fb.page.waitForFunction(()=>document.body.style.background==='transparent');
 fb.state.run=run(200);fb.publish();await fb.page.locator('app-duel-stage '+ARENAS.high).waitFor({timeout:90000});assert.equal(await fb.page.locator(ARENAS.extreme).count(),0);assert.equal(await fb.page.locator('.webgl-error').count(),0);
 await fb.context.close();console.log(`${Math.round((Date.now()-started)/1000)}s PASS no WebGL: Extreme falls back to High`);
 console.log('PASS duel quality: dashboard picker (default, preview, save, reload, discard, AXE, mobile EN/ES), OBS overlay per tier (arena, transparency, rivalry, no lab labels), WebGL fallback');
}finally{await browser.close();}
