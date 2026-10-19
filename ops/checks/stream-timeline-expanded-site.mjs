import assert from 'node:assert/strict';
const {chromium}=await import(process.env.SAAS_PLAYWRIGHT_MODULE||'/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const url=process.env.SAAS_PREVIEW_URL||'http://127.0.0.1:4287';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},colorScheme:'dark'});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const twitch={id:'533538623',login:'fixture',display_name:'Fixture'};
const app={name:'Fixture',email:'fixture@example.invalid',language:'en',plan_tier:'free',actived:true,chat_enabled:true,twitch_user_id:twitch.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
await page.addInitScript(({twitch,app})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:twitch,appUser:app,permissions:{}}));localStorage.setItem('theme','dark');},{twitch,app});
const id='a'.repeat(24),id2='b'.repeat(24),startedAt='2026-10-12T18:00:00.000Z';
const sessions=[{id,startedAt,endedAt:'2026-10-12T20:00:00.000Z',status:'offline'},{id:id2,startedAt:'2026-10-11T18:00:00.000Z',endedAt:'2026-10-11T20:00:00.000Z',status:'offline'}];
const data={session:{...sessions[0],durationSeconds:7200},asOf:'2026-10-12T20:01:00.000Z',canAnnotate:true,coverage:{retentionDays:90,chatterTrackingStartedAt:startedAt,truncated:false},points:Array.from({length:25},(_,i)=>({offsetSeconds:i*300,viewers:Math.round(30+i*2+15*Math.sin(i/2)),messagesPerMinute:Math.round(5+i%7*2),gap:i===15,game:i<12?'Music':'Chess',title:i<12?'Community night':'One more match'})),chatters:Array.from({length:24},(_,i)=>({offsetSeconds:i*300,count:i===0?null:5+i%9})),events:[{id:'raid-1',kind:'raid',label:'FriendlyRaider',offsetSeconds:1500,value:100},{id:'reward-1',kind:'redemption',label:'Hydrate',offsetSeconds:2100},{id:'game-1',kind:'game',label:'Chess',offsetSeconds:3600},{id:'title-1',kind:'title',label:'One more match',offsetSeconds:3600}]};
data.activity={totals:{messages:500,commands:120,emotes:450,emoteMessages:200,redemptions:10,follows:5,subs:3,bits:100,raids:1},commands:[{key:'hello',label:'!hello',count:120,errors:2}],emotes:[{key:'twitch:25',label:'Kappa',count:450,messages:200}],series:Array.from({length:24},(_,i)=>({offsetSeconds:i*300,commands:i%8,emotes:10+i,messages:20,chatters:5})),coverageStartedAt:startedAt,chatterStartedAt:startedAt,updatedAt:startedAt,pending:false,truncated:false,planTier:'pro',capabilities:{trends:true,comparison:true,users:true}};
data.points.forEach(p=>p.commandsPerMinute=2);data.canSeeCredits=true;
data.markerPage={hasMore:true,cursor:startedAt+'|'+ 'c'.repeat(24)};
let fail=false,empty=false,failMarker=false,canAnnotate=true;const saves=[];
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.origin===new URL(url).origin&&!u.pathname.startsWith('/api/'))return route.continue();
 if(u.hostname==='api.domdimabot.com'||u.port==='3000'){
  const path=u.pathname;let response={};
  if(path==='/auth/session')response={twitch,app};
  else if(path.includes('/access'))response={allowed:true};
  else if(path.endsWith('/people'))response={items:[{id:'viewer-1',label:'ChatViewer',count:12,errors:1}],cursor:null};
  else if(path.endsWith('/credits'))response={items:[{id:'credit-1',offsetSeconds:1800,category:'tts',operation:'synthesize',provider:'piper',model:null,credits:12,entryKind:'usage'}],truncated:false};
  else if(path.endsWith('/moments'))response={events:[{id:'follow-new',kind:'follow',label:'NewFollower',offsetSeconds:2500,value:1}],cursor:null};
  else if(path.includes('/compare/'))response={...data,session:{...sessions[1],durationSeconds:7200},canAnnotate:false,points:data.points.map(p=>({...p,viewers:p.viewers+10}))};
  else if(path.includes('/markers/')){
   if(route.request().method()==='PUT'){saves.push({key:path.split('/').at(-1),...route.request().postDataJSON()});if(failMarker){failMarker=false;return route.fulfill({status:503,json:{error:true}});}const saved=saves.at(-1);if(!data.events.some(e=>e.id==='c'.repeat(24)))data.events.push({id:'c'.repeat(24),kind:'note',label:saved.label,offsetSeconds:saved.offsetSeconds});}
   else data.events=data.events.filter(e=>e.id!==path.split('/').at(-1));
  }
  else if(path.endsWith(`/analytics/streams/${twitch.id}`))response={streams:empty?[]:sessions,page:1,hasMore:false};
  else if(path.includes('/analytics/streams/')){if(fail)return route.fulfill({status:503,json:{error:true}});response={...data,canAnnotate,...(path.endsWith(id2)?{session:{...sessions[1],durationSeconds:7200},points:[],chatters:[],events:[],activity:undefined,canSeeCredits:false,coverage:{...data.coverage,chatterTrackingStartedAt:null}}:{})};}
  return route.fulfill({status:200,json:{error:false,data:response}});
 }
 return route.abort();
});
const section=page.locator('app-stream-timeline-page');
const ready=()=>section.getByRole('heading',{name:'Audience & chat',exact:true}).waitFor();
try{
 await page.goto(`${url}/fixture/modules/analytics`);
 await page.getByRole('link',{name:'Open stream timeline',exact:true}).click();await ready();
 assert.equal(await section.locator('svg[role=img]').count(),5);
 assert.deepEqual(errors,[]);
 await section.getByLabel('From minute',{exact:true}).fill('30');
 await section.getByLabel('To minute',{exact:true}).fill('60');
 await section.getByRole('button',{name:'Apply range',exact:true}).click();
 assert.ok(new URL(page.url()).searchParams.get('from')==='1800');
 await section.locator('.axis').filter({hasText:'00:45:00'}).waitFor();
 assert.equal(await section.locator('.axis').innerText(),'00:30:00\n00:45:00\n01:00:00');
 await section.getByRole('button',{name:'Full stream',exact:true}).click();
 await section.getByRole('button',{name:'View users',exact:true}).first().click();
 await section.getByText('ChatViewer',{exact:true}).waitFor();
 await section.getByLabel('Compare with another stream',{exact:true}).selectOption(id2);
 await section.getByText(/Dashed gold: comparison activity/).waitFor();
 assert.equal(await section.locator('.comparison-series').count(),5);
 await section.getByRole('button',{name:'Show credit activity',exact:true}).click();
 await section.getByText('12 credits',{exact:true}).waitFor();
 await section.getByRole('button',{name:'Load moments in range',exact:true}).click();
 await section.getByText('NewFollower',{exact:true}).waitFor();
 await section.getByLabel('Search loaded moments',{exact:true}).fill('Hydrate');
 assert.equal(await section.locator('.events li').count(),1);
 await section.getByLabel('Search loaded moments',{exact:true}).fill('');
 await section.getByRole('button',{name:/00:25:00.*FriendlyRaider/}).click();
 await section.locator('.readout > strong').filter({hasText:'00:25:00'}).waitFor();
 await section.getByLabel('Inspect sample',{exact:true}).selectOption('4500');
 await section.getByText(/There is a recording gap/).waitFor();
 await section.getByLabel('Show moments',{exact:true}).selectOption('redemption');
 await section.getByText('FriendlyRaider',{exact:true}).waitFor({state:'hidden'});assert.equal(await section.locator('.events li').count(),1);await section.getByText('Hydrate',{exact:true}).waitFor();
 await section.getByLabel('Show moments',{exact:true}).selectOption('all');
 await section.getByRole('button',{name:'Add marker',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Save marker',exact:true}).click();
 await dialog.getByText(/Enter a note/).waitFor();
 await dialog.getByLabel('What happened?',{exact:true}).fill('Break');await dialog.getByLabel('Minutes after stream start',{exact:true}).fill('30');
 failMarker=true;await dialog.getByRole('button',{name:'Save marker',exact:true}).click();await dialog.getByRole('alert').waitFor();
 assert.equal(await dialog.getByLabel('What happened?',{exact:true}).inputValue(),'Break');
 await dialog.getByRole('button',{name:'Save marker',exact:true}).click();await dialog.waitFor({state:'hidden'});await ready();
 assert.equal(saves.length,2);assert.equal(saves[0].key,saves[1].key);
 await section.getByRole('button',{name:'Remove marker: Break',exact:true}).click();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.ok(data.events.some(e=>e.kind==='note'));
 await section.getByRole('button',{name:'Remove marker: Break',exact:true}).click();await dialog.getByRole('button',{name:'Remove marker',exact:true}).click();await dialog.waitFor({state:'hidden'});await ready();assert.equal(data.events.some(e=>e.kind==='note'),false);
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:1000});
  for(const dark of [true,false]){
   await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${width}`);
   await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
   const violations=await page.evaluate(async()=> (await window.axe.run(document.querySelector('app-stream-timeline-page'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));
   assert.deepEqual(violations,[],`axe ${width} ${dark}`);
   await section.screenshot({path:`/tmp/stream-timeline-${width}-${dark?'dark':'light'}.png`});
  }
 }
 await page.setViewportSize({width:390,height:844});await section.getByRole('button',{name:'Add marker',exact:true}).click();
 await page.addScriptTag({path:'/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js'});
 assert.deepEqual((await page.evaluate(async()=> (await window.axe.run(document.querySelector('dialog[open]'))).violations.map(v=>v.id))),[]);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 assert.equal(await section.getByRole('button',{name:'Add marker',exact:true}).evaluate(el=>el===document.activeElement),true);
 await section.getByRole('combobox',{name:'Choose a stream',exact:true}).selectOption(id2);await ready();await section.getByText('No viewer samples recorded for this stream yet.',{exact:true}).first().waitFor();assert.equal(await section.locator('svg[role=img]').count(),0);
 await section.getByRole('combobox',{name:'Choose a stream',exact:true}).selectOption(id);await ready();
 fail=true;await section.getByRole('button',{name:'Refresh',exact:true}).click();await section.getByRole('heading',{name:'This timeline could not be loaded',exact:true}).waitFor();
 fail=false;await section.getByRole('button',{name:'Retry',exact:true}).click();await ready();
 canAnnotate=false;await section.getByRole('button',{name:'Refresh',exact:true}).click();await section.getByRole('button',{name:'Add marker',exact:true}).waitFor({state:'hidden'});await ready();assert.equal(await section.getByRole('button',{name:'Add marker',exact:true}).count(),0);
 empty=true;await page.goto(`${url}/fixture/modules/analytics/timeline`);await section.getByRole('heading',{name:'Your next stream starts the story',exact:true}).waitFor();
 empty=false;app.language='es';await page.evaluate(()=>localStorage.setItem('userLanguage','es'));await page.reload();
 await section.getByRole('heading',{name:'Audiencia y chat',exact:true}).waitFor();assert.doesNotMatch(await section.innerText(),/streamTimeline\.|\{\{/);
 assert.deepEqual(errors,[]);
 console.log('PASS EXPANDED SITE: paid trends, URL ranges, zoom, comparison, Pro actors, credit permission UI, range moments, loaded search, plus hub route, free access, aligned charts, event/sample selection, filters, marker validation and retry identity, deletion confirmation, keyboard focus, historical/empty/error states, read-only access, Spanish, 320/390/1280 dark/light axe and overflow');
}catch(error){console.error('PAGE',page.url(),errors);console.error(await section.locator('select').evaluateAll(els=>els.map(e=>e.outerHTML.slice(0,350))));console.error((await page.locator('body').innerText()).slice(-7000));throw error;}finally{await browser.close();}
