// Chat sound: the OBS page (fake Socket.IO server, WebAudio instrumented) and the settings page (mocked API).
// Every API and socket is mocked. No live channel is read or changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require=createRequire((process.env.SAAS_BROWSER_TOOLS??'/tmp/saas-cooldown-browser')+'/package.json');
const {chromium}=require('playwright'),AxeBuilder=require('@axe-core/playwright').default;
const base=process.env.SAAS_PREVIEW_URL;assert(base,'SAAS_PREVIEW_URL');
const evidence=process.env.SAAS_SCREENSHOT_DIR??'/tmp/chat-sound-evidence';mkdirSync(evidence,{recursive:true});
// One Socket.IO namespace for every channel (the page URL still names the channel).
const channel='991801',token='a'.repeat(43),ns='/overlays/chat-sound',pagePath=`/overlays/chat-sound/${channel}`;
const launch=args=>chromium.launch({executablePath:process.env.SAAS_CHROMIUM_PATH||chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage',...args]});
const until=async(check,message,ms=6000)=>{const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw new Error(message);await new Promise(r=>setTimeout(r,60));}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// The demo-video pop (marketing/video/lib/sfx.mjs KIT.pop): the page must synthesize exactly this.
const popSample=t=>0.5*Math.sin(2*Math.PI*(480+820*Math.exp(-t*36))*t)*Math.exp(-t*26);
/** Records every sound the page starts: its gain, length and a few samples. */
const audioProbe=()=>{
  window.__pops=[];let lastGain=null;
  const createGain=AudioContext.prototype.createGain;AudioContext.prototype.createGain=function(){const g=createGain.call(this);lastGain=g;return g;};
  const start=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(...args){const data=this.buffer.getChannelData(0);
    window.__pops.push({gain:lastGain?Math.round(lastGain.gain.value*100)/100:null,duration:Math.round(this.buffer.duration*1000)/1000,rate:this.buffer.sampleRate,samples:[100,1000,4000].map(i=>data[i]),state:this.context.state});
    return start.apply(this,args);};
};
/** Chrome's autoplay rule for a normal tab (headless Chromium ignores it for WebAudio): audio stays suspended until a click. */
// (navigator.userActivation is already true in Playwright pages, so a trusted pointer/key event marks the click.)
const needsClick=()=>{let clicked=false;for(const type of ['pointerdown','keydown'])window.addEventListener(type,e=>{if(e.isTrusted)clicked=true;},true);
  const Base=window.AudioContext;window.AudioContext=class extends Base{get state(){return clicked?super.state:'suspended';}resume(){return clicked?super.resume():Promise.resolve();}};};
const pops=page=>page.evaluate(()=>window.__pops.length);
const lastPop=page=>page.evaluate(()=>window.__pops.at(-1));

/** A fake Socket.IO server for the chat sound namespace. */
async function obsPage(browser,{obs=true,pageToken=token,accept=true,blocked=false}={}){
  const context=await browser.newContext({viewport:{width:800,height:450}});
  await context.addInitScript(audioProbe);
  if(obs)await context.addInitScript(()=>{window.obsstudio={pluginVersion:'2.21.0'};});
  if(blocked)await context.addInitScript(needsClick);
  const fake={ws:null,ready:[],auth:[]};
  fake.send=(event,data)=>fake.ws.send(`42${ns},${JSON.stringify([event,data])}`);
  await context.routeWebSocket('**/*',ws=>{
    if(!ws.url().includes('/socket.io/'))return ws.close();
    fake.ws=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000,"maxPayload":1000000}');
    ws.onMessage(raw=>{const m=String(raw);
      if(m.startsWith(`40${ns},`)){const auth=JSON.parse(m.slice(m.indexOf(',')+1));fake.auth.push(auth);
        if(!accept||auth.token!==token||auth.channel!==channel)return ws.send(`44${ns},{"message":"Invalid chat sound link"}`);
        ws.send(`40${ns},{"sid":"fixture-ns"}`);fake.send('chat-sound-settings',{v:1,revision:1,enabled:true,volume:70});}
      else if(m.startsWith(`42${ns},`)){const [event,data]=JSON.parse(m.slice(m.indexOf(',')+1));if(event==='chat-sound-ready')fake.ready.push(data);}
    });
  });
  await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}${pagePath}#${pageToken}`);
  return {context,page,errors,fake};
}

let browser=await launch(['--autoplay-policy=no-user-gesture-required']);
try{
  // 1. In OBS: invisible, plays each pop the server sends at the saved volume, reports that audio runs.
  {
    const {context,page,errors,fake}=await obsPage(browser);
    await until(()=>fake.ready.some(r=>r.audio==='running'),'OBS page reports running audio');
    assert.deepEqual(fake.auth,[{channel,token}],'the channel from the path and the token from the fragment authenticate');
    const report=fake.ready.at(-1);assert.equal(report.v,1);assert.equal(report.obs,true);
    assert.equal(await page.getByTestId('chat-sound-tab').count(),0,'nothing shows in OBS');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)','transparent page');
    assert.equal(await page.evaluate(()=>document.body.innerText.trim()),'','no text in OBS');
    fake.send('chat-sound-pop',{id:'p1',at:Date.now()});
    await until(async()=>await pops(page)===1,'a chat pop plays');
    const first=await lastPop(page);
    assert.equal(first.gain,0.7,'saved volume');assert.equal(first.duration,0.18,'0.18 s pop');assert.equal(first.state,'running');
    first.samples.forEach((value,n)=>assert(Math.abs(value-popSample([100,1000,4000][n]/first.rate))<1e-6,'same waveform as the demo-video pop'));
    // Two pops close together both play (the server owns the cooldown); each is its own source.
    fake.send('chat-sound-pop',{id:'p2',at:Date.now()});fake.send('chat-sound-pop',{id:'p3',at:Date.now()});
    await until(async()=>await pops(page)===3,'overlapping pops play');
    // Turned off: normal pops stay silent, a Studio test still plays at its own volume.
    fake.send('chat-sound-settings',{v:1,revision:2,enabled:false,volume:70});
    fake.send('chat-sound-pop',{id:'p4',at:Date.now()});await sleep(300);assert.equal(await pops(page),3,'off = silent');
    fake.send('chat-sound-pop',{id:'t1',at:Date.now(),test:true,volume:30});
    await until(async()=>await pops(page)===4,'a test pop plays even when off');assert.equal((await lastPop(page)).gain,0.3,'test uses the draft volume');
    fake.send('chat-sound-settings',{v:1,revision:3,enabled:true,volume:45});
    fake.send('chat-sound-pop',{id:'p5',at:Date.now()});await until(async()=>await pops(page)===5,'new settings apply');assert.equal((await lastPop(page)).gain,0.45);
    // Heartbeat keeps the settings page's "in OBS" status fresh.
    const before=fake.ready.length;await until(()=>fake.ready.length>before,'ready heartbeat within 5 s',7000);
    assert.deepEqual(errors,[]);await context.close();
  }
  // 2. A wrong token never connects and stays silent.
  {
    const {context,page,errors,fake}=await obsPage(browser,{obs:false,pageToken:'b'.repeat(43)});
    await page.getByTestId('chat-sound-tab').waitFor();
    await until(()=>page.getByTestId('chat-sound-tab').getAttribute('data-link').then(v=>v==='invalid'),'invalid link shown');
    await page.getByText('This link no longer works',{exact:false}).waitFor();
    assert.equal(fake.ready.length,0);assert.deepEqual(errors,[]);await context.close();
  }
  // 3. A link without a token never opens a socket.
  {
    const {context,page,fake}=await obsPage(browser,{obs:false,pageToken:''});
    await until(()=>page.getByTestId('chat-sound-tab').getAttribute('data-link').then(v=>v==='invalid'),'missing token = invalid');
    assert.equal(fake.ws,null,'no socket without a token');await context.close();
  }
}finally{await browser.close();}

// 4. A normal browser tab needs a click before audio: pops are dropped (not queued) until then.
browser=await launch([]);
try{
  const {context,page,errors,fake}=await obsPage(browser,{obs:false,blocked:true});
  const tab=page.getByTestId('chat-sound-tab');await tab.waitFor();
  await until(()=>fake.ready.length>0,'tab reports its state');assert.equal(fake.ready.at(-1).audio,'suspended');assert.equal(fake.ready.at(-1).obs,false);
  await page.getByRole('button',{name:'Allow sound'}).waitFor();
  fake.send('chat-sound-pop',{id:'early',at:Date.now()});await sleep(400);assert.equal(await pops(page),0,'no pop before the click');
  await page.screenshot({path:`${evidence}/tab-blocked.png`});
  await page.getByRole('button',{name:'Allow sound'}).click();
  await until(async()=>await pops(page)===1,'the click plays one check pop');
  await until(()=>tab.getAttribute('data-audio').then(v=>v==='running'),'audio running after the click');
  await until(()=>fake.ready.some(r=>r.audio==='running'),'running reported to the server');
  await page.getByText('On: a pop plays when someone chats.').waitFor();
  fake.send('chat-sound-pop',{id:'later',at:Date.now()});await until(async()=>await pops(page)===2,'chat pops after the click');
  assert.equal(await page.evaluate(()=>window.__pops.filter(p=>p.state!=='running').length),0,'nothing queued from before the click');
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(v=>v.id),[]);
  await page.screenshot({path:`${evidence}/tab-running.png`});
  assert.deepEqual(errors,[]);await context.close();
}finally{await browser.close();}

// 5. Settings page.
const defaults={enabled:true,volume:70,ignoreBots:true,ignoreSelf:true,ignoreCommands:false,ignoreSharedChat:false,cooldownSeconds:1,quietMinutes:0};
const none={sources:0,ready:0,obsPlaying:0,tabPlaying:0,obsSilent:0,tabSilent:0,outdated:0};
const playingObs={...none,sources:1,ready:1,obsPlaying:1};
async function settingsPage(browser,{theme='dark',width=1280,lang='en',status=none,settings=defaults,conflict=false}={}){
  const context=await browser.newContext({viewport:{width,height:900}});
  const user={id:channel,login:'duelfixture',display_name:'Fixture'};
  const app={name:'Fixture',email:'fixture@example.invalid',language:lang,plan_tier:'free',actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
  await context.addInitScript(({user,app,theme,lang})=>{localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'fixture',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3e6).toISOString(),twitchUser:user,appUser:app,permissions:{}}));localStorage.setItem('userLanguage',lang);localStorage.setItem('theme',theme);},{user,app,theme,lang});
  await context.addInitScript(audioProbe);
  await context.routeWebSocket(/.*/,ws=>ws.close());
  const api={state:{revision:3,settings:{...settings},linked:true,status:{...status}},puts:[],tests:[],tokenPosts:[],gets:0};
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
    if(url.origin===new URL(base).origin)return route.continue();if(url.hostname!=='api.domdimabot.com')return route.abort();
    const json=data=>route.fulfill({json:{error:false,status:200,message:'OK',data}});
    if(url.pathname===`/chat-sound/${channel}`){api.gets++;return json(api.state);}
    if(url.pathname===`/chat-sound/${channel}/settings`){assert.equal(req.method(),'PUT');const body=req.postDataJSON();api.puts.push({body,ifMatch:req.headers()['if-match']});
      if(conflict){api.state={...api.state,revision:api.state.revision+1};return route.fulfill({status:409,json:{error:true,status:409,code:'revision_conflict',message:'changed'}});}
      api.state={...api.state,revision:api.state.revision+1,settings:body};return json(api.state);}
    if(url.pathname===`/chat-sound/${channel}/test`){api.tests.push(req.postDataJSON());return json({sent:api.state.status.sources,status:api.state.status});}
    if(url.pathname===`/chat-sound/${channel}/overlay-token`){if(req.method()==='POST')api.tokenPosts.push(req.postDataJSON());return json({token,exists:true,version:'v1'});}
    if(url.pathname==='/auth/session')return json({twitch:user,app});
    if(url.pathname.endsWith('/access'))return json({allowed:true,role:'owner',planTier:'free'});
    if(url.pathname.startsWith('/auth/access/'))return json({allowed:true});
    if(req.method()!=='GET')return route.fulfill({status:500,json:{error:true}});
    return json({});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/duelfixture/modules/chat-sound`);await page.getByTestId('chat-sound-page').waitFor();await page.getByTestId('chat-sound-settings').waitFor();
  return {context,page,errors,api};
}
const clean=async page=>{const a=await new AxeBuilder({page}).include('app-chat-sound-page').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');};
const health=page=>page.getByTestId('health-chip').getAttribute('data-health');

browser=await launch(['--autoplay-policy=no-user-gesture-required']);
try{
  // Layout, contrast and overflow in both themes at phone and desktop widths, with each status.
  const looks=[['missing',none],['playing',playingObs],['silent',{...none,sources:2,ready:2,obsSilent:2,outdated:1}]];
  for(const theme of ['dark','light'])for(const width of [320,390,1280])for(const [name,status] of (width===390?looks:[looks[0]])){
    const f=await settingsPage(browser,{theme,width,status});
    await until(()=>health(f.page).then(v=>v===name),`health ${name}`);
    await f.page.locator('app-overlay-link input[readonly]').first().waitFor();
    await f.page.locator('details[data-testid=chat-sound-filters]').evaluate(d=>{d.open=true;});
    await f.page.waitForTimeout(300);await clean(f.page);
    await f.page.screenshot({path:`${evidence}/settings-${name}-${theme}-${width}.png`,fullPage:true});
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // The OBS link, plain answers, both tests and a full save.
  {
    const f=await settingsPage(browser,{status:playingObs});const page=f.page;
    assert.equal(await page.locator('app-overlay-link input[readonly]').first().inputValue(),`${new URL(base).origin}/overlays/chat-sound/${channel}#${token}`,'private OBS link');
    assert.equal(await page.getByTestId('chat-sound-open-tab').getAttribute('href'),`${new URL(base).origin}/overlays/chat-sound/${channel}#${token}`);
    await page.getByText("It's working: chat messages make a pop in OBS.").waitFor();
    await page.getByText('Free on every plan').waitFor();
    assert.equal(await page.getByTestId('save-button').isDisabled(),true,'nothing to save yet');
    // Volume: the label follows the slider, "Hear it here" plays at the draft volume.
    await page.getByTestId('volume-slider').fill('40');await until(()=>page.getByTestId('volume-value').textContent().then(t=>t.trim()==='40%'),'volume label');
    await page.getByTestId('hear-button').click();await until(async()=>await pops(page)===1,'local preview plays');assert.equal((await lastPop(page)).gain,0.4);
    await page.getByTestId('test-obs-button').click();await until(()=>f.api.tests.length===1,'test sent');assert.deepEqual(f.api.tests[0],{volume:40},'OBS test uses the draft volume');
    await page.getByTestId('test-notice').getByText('Sent a pop to 1 open source.',{exact:false}).waitFor();
    // Double click guard: a second click within 1 s sends nothing.
    await sleep(1100);await page.getByTestId('test-obs-button').dblclick();await sleep(300);assert.equal(f.api.tests.length,2,'double-click sends one test');
    // Mode: quiet chat shows minutes instead of the gap; switching back restores the gap select.
    assert.equal(await page.getByTestId('cooldown-select').inputValue(),'1');
    await page.getByTestId('cooldown-select').selectOption('0.25');
    await page.getByTestId('mode-quiet').check();await page.getByTestId('quiet-select').waitFor();assert.equal(await page.getByTestId('cooldown-select').count(),0);
    assert.equal(await page.getByTestId('quiet-select').inputValue(),'5');await page.getByTestId('quiet-select').selectOption('10');
    // Filters live in a closed section whose summary says what is skipped.
    const filters=page.getByTestId('chat-sound-filters');assert.equal(await filters.evaluate(d=>d.open),false);
    await filters.getByText('Skipping: bots, your messages').waitFor();
    await filters.locator('summary').click();await page.getByTestId('filter-ignoreCommands').check();await page.getByTestId('filter-ignoreSelf').uncheck();
    await filters.getByText('Skipping: bots, commands').waitFor();
    await page.getByTestId('save-bar').getByText('Unsaved changes').waitFor();
    await page.getByTestId('save-button').click();await until(()=>f.api.puts.length===1,'saved');
    assert.deepEqual(f.api.puts[0],{ifMatch:'3',body:{...defaults,volume:40,cooldownSeconds:0.25,quietMinutes:10,ignoreCommands:true,ignoreSelf:false}});
    await page.getByTestId('save-bar').getByText('Saved. Open sources use it right away.').waitFor();
    assert.equal(await page.getByTestId('save-button').isDisabled(),true,'saved = nothing pending');
    // Back to every message: the gap select returns with the saved gap.
    await page.getByTestId('mode-every').check();assert.equal(await page.getByTestId('cooldown-select').inputValue(),'0.25');
    await page.getByRole('button',{name:'Discard'}).click();await page.getByTestId('quiet-select').waitFor();assert.equal(await page.getByTestId('quiet-select').inputValue(),'10');
    assert.equal(f.api.tokenPosts.length,0,'loading the page never creates or replaces a link');
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // Status mixes: a silent OBS source is the problem to show even while a browser tab plays; a tab alone says so.
  for(const [status,expect] of [[{...none,sources:2,ready:2,obsSilent:1,tabPlaying:1},'silent'],[{...none,sources:1,ready:1,tabPlaying:1},'tab'],[{...none,sources:2,ready:2,obsPlaying:1,tabSilent:1},'playing']]){
    const f=await settingsPage(browser,{status,width:390});await until(()=>health(f.page).then(v=>v===expect),`health ${expect} for ${JSON.stringify(status)}`);
    if(status.sources>1)await f.page.getByTestId('copies-hint').waitFor();
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // Someone else saves while this tab has unsaved edits: the poll brings their change in under the edited fields,
  // and the save sends the merged settings with the newer revision (never their change undone).
  {
    const f=await settingsPage(browser);const page=f.page;
    await page.getByTestId('volume-slider').fill('40');await until(()=>page.getByTestId('volume-value').textContent().then(t=>t.trim()==='40%'),'draft volume');
    const before=f.api.gets;f.api.state={...f.api.state,revision:4,settings:{...f.api.state.settings,enabled:false,cooldownSeconds:5}};
    await until(()=>f.api.gets>before,'next poll',7000);
    await until(()=>page.getByTestId('enabled-switch').isChecked().then(v=>v===false),'their change arrives in the draft');
    assert.equal(await page.getByTestId('volume-value').textContent().then(t=>t.trim()),'40%','my edit stays on top');
    assert.equal(await page.getByTestId('cooldown-select').inputValue(),'5');
    await page.getByTestId('save-bar').getByText('Someone changed these settings somewhere else.',{exact:false}).waitFor();
    await page.getByTestId('save-button').click();await until(()=>f.api.puts.length===1,'saved');
    assert.deepEqual(f.api.puts[0],{ifMatch:'4',body:{...defaults,volume:40,enabled:false,cooldownSeconds:5}});
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // Turned off, no source: plain answers; testing with nothing open says so.
  {
    const f=await settingsPage(browser,{settings:{...defaults,enabled:false}});
    await until(()=>health(f.page).then(v=>v==='off'),'off');await f.page.getByText('Chat sound is off, so nothing plays.',{exact:false}).waitFor();
    await f.page.getByTestId('test-obs-button').click();await f.page.getByText('No source is open.',{exact:false}).waitFor();
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // Someone else saved first: the draft stays and the streamer is told.
  {
    const f=await settingsPage(browser,{conflict:true});
    await f.page.getByTestId('enabled-switch').uncheck();await f.page.getByTestId('save-button').click();
    await f.page.getByRole('alert').getByText('Someone else saved chat sound settings just now.',{exact:false}).waitFor();
    assert.equal(await f.page.getByTestId('enabled-switch').isChecked(),false,'draft kept');assert.equal(await f.page.getByTestId('save-button').isDisabled(),false);
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
  // Spanish (es-MX).
  {
    const f=await settingsPage(browser,{lang:'es',width:390});
    await f.page.getByRole('heading',{name:'Sonido del chat',level:1}).waitFor();
    await f.page.getByTestId('cooldown-select').locator('option',{hasText:'0.25 segundos'}).count().then(n=>assert.equal(n,1,'es-MX decimal point'));
    await f.page.getByText('Controlar audio vía OBS',{exact:false}).waitFor();
    await f.page.waitForTimeout(300);await clean(f.page);await f.page.screenshot({path:`${evidence}/settings-es-390.png`,fullPage:true});
    assert.deepEqual(f.errors,[]);await f.context.close();
  }
}finally{await browser.close();}
console.log('chat sound browser check passed');
