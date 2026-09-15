import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const url = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4276';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});
page.setDefaultTimeout(10000);
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const twitch={id:'533538623',login:'fixture',display_name:'Fixture'};
const app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'pro',actived:true,chat_enabled:true,twitch_user_id:'533538623',has_permissions:true,up_to_date_permissions:true,administrating:[]};
await page.addInitScript(({twitch,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:twitch,appUser:app,permissions:{}})),{twitch,app});
const settings={channelID:twitch.id,channel:'fixture',enabled:true,silentModeEnabled:true,protectionModeEnabled:true,attackModeEnabled:true,resetAttackOnNewRaid:true,silentThresholdX:10,silentWindowYSeconds:5,protectionThresholdB:100,attackThreshold:500,silentDurationSeconds:60,baselineFollowsPerHour:null,language:'en',settingsVersion:1};
const sessions=[{id:'b'.repeat(64),raiderLogin:'raiderb',raiderName:'Raider B',viewers:7000,startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+72*3600000).toISOString(),retentionHours:72,totalFollows:2000,collecting:true,banning:false,canIncludeFuture:true,outcomes:{}},{id:'a'.repeat(64),raiderLogin:'raidera',raiderName:'Raider A',viewers:8000,startedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+72*3600000-60000).toISOString(),retentionHours:72,totalFollows:3000,collecting:false,banning:false,canIncludeFuture:false,outcomes:{succeeded:120,pending:2880}}];
const submitted=[];let failBan=false;let followerRequests=[];let settingsSaved;
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.origin===new URL(url).origin && !u.pathname.startsWith('/api/')) return route.continue();
 if(u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com') return route.abort();
 if(u.hostname==='api.domdimabot.com'||u.port==='3000'){
  const path=u.pathname;let data={};
  if(path==='/auth/session') data={twitch,app};
  else if(path.includes('/access')) data={allowed:true};
  else if(path.endsWith('/settings')) { if(route.request().method()==='PATCH') {settingsSaved=route.request().postDataJSON();Object.assign(settings,settingsSaved);} data=settings; }
  else if(path.endsWith('/status')) data={mode:'attack',channelID:twitch.id,modeStartedAt:Date.now(),expiresAt:Date.now()+60000,triggeredBy:'manual',trackedCount:2000,raid:{expiresAt:Date.now()+300000,raidViewers:7000,raiderChannelName:'Raider B'}};
  else if(path.endsWith('/raid-sessions')) data={sessions,total:2,page:1,limit:20,canBan:true,planTier:app.plan_tier,canBanSession:app.plan_tier!=='free',canBanIndividual:app.plan_tier==='pro'};
  else if(path.endsWith('/followers')) {const n=Number(u.searchParams.get('page')||1);followerRequests.push(n);data={followers:Array.from({length:50},(_,i)=>({id:`f${n}-${i}`,userID:String(n*100+i),login:`viewer${n*100+i}`,name:`Viewer ${n*100+i}`,followedAt:new Date().toISOString(),banStatus:'unrequested'})),total:2000,page:n,limit:50};}
  else if(path.endsWith('/bans')) {submitted.push(route.request().postDataJSON()); if(failBan) {failBan=false;return route.fulfill({status:503,json:{error:true}});} data={status:'pending',requestID:'accepted'};}
  else if(path.endsWith('/attacks')) data={logs:[],total:0,page:1,limit:10};
  else if(path.endsWith('/hate-raids')) data={sources:[],total:0,page:1,limit:10};
  return route.fulfill({status:200,json:{error:false,data}});
 }
 return route.abort();
});
try {
 await page.goto(`${url}/fixture/modules/follow-defense`);
 const section=page.locator('app-raid-sessions');
 await section.getByRole('heading',{name:'Raid sessions',exact:true}).waitFor();
 await section.getByText('Raider B',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 const cards=section.locator('article.session');assert.equal(await cards.count(),2);
 await cards.first().getByRole('button',{name:'Show followers',exact:true}).click();
 await section.getByText('Viewer 100',{exact:true}).waitFor();
 await section.getByRole('button',{name:'Next',exact:true}).click();
 await section.getByText('Viewer 200',{exact:true}).waitFor(); assert.ok(followerRequests.includes(2));
 // Individual confirmation is keyboard dismissible and never sends before confirmation.
 const individual=section.getByRole('button',{name:'Ban Viewer 200',exact:true});
 await individual.click();
 const dialog=section.getByRole('dialog');await dialog.getByRole('heading').waitFor();
 await dialog.getByRole('heading').waitFor();
 assert.match(await dialog.innerText(),/already recorded at confirmation/);
 await page.keyboard.press('Escape');assert.equal(submitted.length,0);
 assert.equal(await individual.evaluate(el=>el===document.activeElement),true);
 // Failed submissions can retry with the same identity; duplicate clicks cannot double-submit.
 await individual.click();failBan=true;await dialog.getByRole('button',{name:'Confirm ban',exact:true}).click();
 await dialog.getByRole('alert').waitFor();
 await dialog.getByRole('button',{name:'Confirm ban',exact:true}).click();
 await dialog.waitFor({state:'hidden'});assert.equal(submitted.length,2);assert.equal(submitted[0].requestID,submitted[1].requestID);assert.equal(submitted[1].userID,'200');assert.equal(submitted[1].includeFuture,false);
 await cards.first().getByRole('button',{name:'Ban whole session',exact:true}).click();
 await dialog.getByRole('heading').waitFor();
 assert.match(await dialog.innerText(),/include new followers while the mode remains active/);
 await dialog.getByRole('button',{name:'Confirm ban',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(submitted.at(-1).includeFuture,true);
 await cards.nth(1).getByRole('button',{name:'Ban whole session',exact:true}).click();
 await dialog.getByRole('heading').waitFor();
 assert.match(await dialog.innerText(),/already recorded at confirmation/);await page.keyboard.press('Escape');
 // New raid protection defaults on and can be saved off.
 const toggle=page.getByRole('checkbox',{name:'Switch attack mode to protection on a new raid',exact:true});assert.equal(await toggle.isChecked(),true);await toggle.uncheck();
 const save=page.locator('.lf-save-bar button');await save.click();await page.waitForTimeout(300);assert.equal(settingsSaved.resetAttackOnNewRaid,false);
 await cards.first().getByRole('button',{name:'Hide followers',exact:true}).click();
 for(const width of [320,390,1440]) {
  await page.setViewportSize({width,height:900});await section.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
  await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
  for(const dark of [false,true]) {await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   const axe=await page.evaluate(async()=>await window.axe.run(document.querySelector('app-raid-sessions')));assert.deepEqual(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);}
  await page.screenshot({path:`/tmp/raid-sessions-${width}.png`,fullPage:true});
 }
 for(const tier of ['free','premium','pro']) {
  app.plan_tier=tier;await page.reload();await section.getByText('Raider B',{exact:true}).waitFor();
  assert.equal(await section.getByRole('button',{name:'Ban whole session',exact:true}).count(),tier==='free'?0:2);
  await section.screenshot({path:`/tmp/raid-tier-${tier}.png`});
  await section.getByRole('button',{name:'Show followers',exact:true}).first().click();await section.getByText('Viewer 100',{exact:true}).waitFor();
  assert.equal(await section.getByRole('button',{name:'Ban Viewer 100',exact:true}).count(),tier==='pro'?1:0);
 }
 await page.setViewportSize({width:390,height:844});app.language='es';await page.reload();
 await section.getByRole('heading',{name:'Sesiones de raid',exact:true}).waitFor();
 await section.getByRole('button',{name:'Banear toda la sesión',exact:true}).first().click();
 await dialog.getByRole('heading').waitFor();
 assert.match(await dialog.innerText(),/Raider B/);assert.doesNotMatch(await dialog.innerText(),/\{[a-z]+\}/);
 await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
 assert.deepEqual((await page.evaluate(async()=>await window.axe.run(document.querySelector('dialog[open]')))).violations.map(v=>v.id),[]);
 await page.screenshot({path:'/tmp/raid-confirmation-es.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS SITE: Free/Premium/Pro controls and 72-hour history, A/B counts, follower pagination, individual/session confirmation scopes, Escape/focus, retry identity, default/new-raid setting save, 320/390/1440 layouts, no runtime errors');
} catch(error) {console.error('URL',page.url(),'errors',errors);console.error(await page.locator('app-raid-sessions').evaluate(el=>({selection:window.ng?.getComponent(el).selection(),dialog:el.querySelector('dialog')?.outerHTML})));  console.error((await page.locator('body').innerText()).slice(0,3500)); throw error;} finally {await browser.close();}
