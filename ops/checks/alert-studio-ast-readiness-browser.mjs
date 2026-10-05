// Mocked Studio accounts/events: prove delayed AST values are ready on the first playing frame.
import assert from 'node:assert/strict';
const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL; assert(base);
const api='https://api.domdimabot.com';
const user={id:'990191',login:'fixture',display_name:'Fixture'};
const app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'pro',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
const text={id:'amount',kind:'text',text:'$(cheer.amount)',fontSize:48,x:0,y:0,width:800,height:240,visible:true,locked:false,motion:{enter:'fade',exit:'fade',loop:'none',delay:0,enterDuration:.2,exitDuration:.2,loopDuration:1}};
const design={id:'design',name:'Bits alert',revision:1,width:800,height:240,events:Object.fromEntries(['follow','bits','sub','raid'].map(k=>[k,{duration:2,widgets:[{...text}]}]))};
const widget={id:'alert',kind:'alert',designId:'design',events:['follow','bits','sub','raid'],x:0,y:0,width:800,height:240,visible:true,locked:false};
const state={schemaVersion:1,revision:1,designs:[design],scenes:[{id:'main',name:'Main',publicId:'d'.repeat(48),revision:1,width:1280,height:720,waitFor:['bits'],widgets:[widget]}]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<240;i++){if(await fn())return;await sleep(25);}throw Error(label);}
const browser=await chromium.launch({args:['--no-sandbox']});
async function fixture(width){
 const context=await browser.newContext({viewport:{width,height:900}}); const errors=[];
 await context.addInitScript(({user,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}})),{user,app});
 await context.routeWebSocket('**/*',ws=>ws.close());
 const held=[]; let hold=true;
 const respond=(route,body)=>route.fulfill({json:{data:body.texts.map(t=>t.replaceAll('$(cheer.amount)',body.kind==='bits'?body.amount:'0'))}});
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin===new URL(base).origin)return route.continue();
  if(url.origin!==api)return route.abort();
  let data={};
  if(url.pathname==='/auth/session')data={twitch:user,app};
  else if((url.pathname.endsWith('/access')||url.pathname.startsWith('/auth/access/')))data={allowed:true,role:'owner',planTier:'pro'};
  else if(url.pathname.endsWith('/preview')){const body=req.postDataJSON();if(hold&&body.kind==='bits'){held.push({route,body});return;}return respond(route,body);}
  else if(url.pathname.endsWith('/connections'))data={checkedAt:Date.now(),pollingFailed:false,scenes:[]};
  else if(url.pathname.endsWith('/queue'))data={state:{revision:0,all:false,platforms:{}},connected:0,events:[]};
  else if(url.pathname==='/overlay-studio/'+user.id)data=state;
  else if(url.pathname.startsWith('/triggers/'))data=[];
  return route.fulfill({json:{data}});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/fixture/modules/overlays');await page.locator('.stage').waitFor({timeout:10000}).catch(async e=>{console.error('fixture failed',errors,await page.locator('body').innerText());throw e;});
 await until(async()=>await page.locator('.stage .layer-content span').textContent()==='0','idle AST result');
 await page.evaluate(()=>{window.firstPlayingText=[];new MutationObserver(()=>{if(document.querySelector('.stage .is-preview'))window.firstPlayingText.push(document.querySelector('.stage .layer-content span')?.textContent);}).observe(document.querySelector('.stage'),{subtree:true,attributes:true,childList:true,characterData:true});});
 return {context,page,errors,held,respond,release:async(status=200)=>{hold=false;for(const h of held.splice(0))await (status===200?respond(h.route,h.body):h.route.fulfill({status,json:{error:true,message:'AST fixture failure'}}));}};
}
try {
 for(const width of [390,1280]) {
  for(const mode of ['scene','design']) {
   const f=await fixture(width),{page}=f;
   if(mode==='scene')await page.locator('.test-btn').filter({hasText:'Bits'}).click();
   else {await page.locator('.design-row__actions button').first().click();await page.locator('.design-event-tabs').getByRole('button',{name:'Bits',exact:true}).click();await page.getByRole('button',{name:'Preview Bits',exact:true}).click();}
   await until(()=>f.held.length>0,'AST request held'); await sleep(350);
   assert.equal(await page.locator('.stage .is-preview').count(),0,'playback must wait for parsed amount');
   assert.deepEqual(await page.evaluate(()=>window.firstPlayingText),[]);
   await f.release();await page.locator('.stage .is-preview').waitFor();
   assert.equal(await page.locator('.stage .layer-content span').textContent(),'100');
   assert.equal((await page.evaluate(()=>window.firstPlayingText))[0],'100','first playing frame has actual value');
   if(mode==='design') {await page.screenshot({path:`/tmp/studio-ast-${width}.png`});await page.locator('.event-tester input').nth(1).fill('250');await sleep(450);assert.equal(await page.locator('.stage .layer-content span').textContent(),'100','background parse cannot rewrite running alert');}
   assert.deepEqual(f.errors,[]);await f.context.close();
  }
 }
 // A response from a canceled design preview cannot start it later.
 const f=await fixture(1280);
 await f.page.locator('.design-row__actions button').first().click();
 await f.page.locator('.design-event-tabs').getByRole('button',{name:'Bits',exact:true}).click();
 await f.page.getByRole('button',{name:'Preview Bits',exact:true}).click();await until(()=>f.held.length>0,'pending AST');
 await f.page.locator('.design-event-tabs').getByRole('button',{name:'Follows',exact:true}).click();
 await f.release();await sleep(250);assert.equal(await f.page.locator('.stage .is-preview').count(),0);assert.deepEqual(f.errors,[]);await f.context.close();
 const failed=await fixture(1280);
 await failed.page.locator('.design-row__actions button').first().click();
 await failed.page.locator('.design-event-tabs').getByRole('button',{name:'Bits',exact:true}).click();
 await failed.page.getByRole('button',{name:'Preview Bits',exact:true}).click();await until(()=>failed.held.length>0,'AST failure request');await sleep(300);
 await failed.release(400);await failed.page.getByText('AST fixture failure',{exact:true}).waitFor();
 assert.equal(await failed.page.locator('.stage .is-preview').count(),0,'failed parse never plays stale text');
 await failed.page.getByRole('button',{name:'Preview Bits',exact:true}).click();await failed.page.locator('.stage .is-preview').waitFor();
 assert.equal(await failed.page.locator('.stage .layer-content span').textContent(),'100');
 assert.equal(await failed.page.getByText('AST fixture failure',{exact:true}).count(),0,'retry clears parse error');
 assert.deepEqual(failed.errors,[]);await failed.context.close();
 console.log('PASS delayed AST gates Studio scene/design playback; first frame shows 100, running text stays fixed during sample edits, canceled responses cannot start playback, parse errors block playback and retry recovers; mobile/desktop');
}finally{await browser.close();}
