import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire((process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser')+'/package.json');
const {chromium}=require('playwright');
const {default:AxeBuilder}=require('@axe-core/playwright');
const base=process.env.SAAS_PREVIEW_URL||'http://127.0.0.1:4217';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 for(const [tier,minimum] of [['free',5],['premium',3],['pro',1]]) {
  const context=await browser.newContext();
  const user={id:'999991',login:'test',display_name:'Test'};
  const app={name:'Test',email:'test@example.invalid',language:'en',plan_tier:tier,actived:true,chat_enabled:true,twitch_user_id:user.id,has_permissions:true,up_to_date_permissions:true,administrating:[]};
  await context.addInitScript(({user,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'test-only',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}})),{user,app});
  const commands=[{_id:'speech',name:'Speech Chat',cmd:'s',func:'speach',message:'$(tts $(user) dice: &t)',cooldown:0,userLevel:0,userLevelName:'everyone',enabled:true,reserved:false,channelID:user.id,channel:'test',createdAt:new Date().toISOString()}];
  const writes=[];
  await context.routeWebSocket(/api\.domdimabot\.com/,ws=>ws.close());
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===new URL(base).origin) {
    if(process.env.SAAS_PREVIEW_URL&&url.pathname.startsWith('/test/')) return route.fulfill({response:await route.fetch({url:base+'/index.csr.html'})});
    return route.continue();
   }
   if(url.hostname!=='api.domdimabot.com') return route.abort();
   let data={};
   if(url.pathname==='/users')data={id:user.id,username:'test'};
   else if(url.pathname==='/auth/session')data={twitch:user,app};
   else if(url.pathname.endsWith('/access')||url.pathname.startsWith('/auth/access/'))data={allowed:true,role:'owner'};
   else if(url.pathname.startsWith('/commands/')) {
    if(['POST','PUT'].includes(request.method())) {
     const body=request.postDataJSON();writes.push(body);
     const id=request.method()==='PUT'?url.pathname.split('/').at(-1):'second';
     const index=commands.findIndex(c=>c._id===id);
     const command={...(index>=0?commands[index]:{}),...body,_id:id,channelID:user.id,reserved:false};
     if(index>=0)commands[index]=command;else commands.push(command);
     data={command};
    } else data={commands};
   } else if(url.pathname.startsWith('/speech/settings/')) data={role:'owner',settings:{channelID:user.id,channel:'test',enabled:true,provider:'piper',defaultLanguage:'en',voices:{en:'en_US-ryan-medium',es:'es_MX-ald-medium',cloneDefault:'gojo'},filters:{skipEmotes:true,stripLinks:true,normalizeWhitespace:true,maxLength:280,expressiveTags:{}},queue:{maxItems:5}}};
   else if(url.pathname.startsWith('/speech/favorites/')||url.pathname.startsWith('/timers/'))data=[];
   else if(url.pathname.includes('/live-status'))data={isLive:false,currentViewers:0};
   return route.fulfill({json:{error:false,status:200,data}});
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/test/modules/tts');
  await page.getByRole('button',{name:'Edit TTS command',exact:true}).click();
  const modal=page.locator('app-command-modal');
  const cooldown=modal.locator('[formControlName="cooldown"]');
  const message=modal.locator('[formControlName="message"]');
  assert.equal(await cooldown.inputValue(),'0');
  assert.equal(await message.inputValue(),'$(tts $(user) dice: &t)');
  assert.equal(await modal.locator('[formControlName="timerEnabled"]').count(),0);
  for(const width of [320,390,1280]) {
   await page.setViewportSize({width,height:width<640?740:950});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await modal.locator('.lf-form__body').evaluate(el=>el.scrollWidth>el.clientWidth),false);
   await modal.getByRole('dialog').screenshot({path:`/tmp/modular-tts-${tier}-${width}.png`});
  }
  const axe=await new AxeBuilder({page}).include('app-command-modal').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  if(axe.violations.length) console.log(JSON.stringify(axe.violations,null,2));
  assert.deepEqual(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);
  await message.fill('$(tts $(user) says: &t)');
  await modal.locator('[formControlName="cmd"]').fill('say');
  await modal.locator('button[type="submit"]').click();
  await modal.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(writes.at(-1).cooldown,0);assert.equal(commands[0].func,'speach');
  await page.locator('[data-testid="tts-command"]').getByText('$(tts $(user) says: &t)',{exact:true}).waitFor();
  await page.goto(base+'/test/commands');
  await page.getByRole('button',{name:'Edit',exact:true}).first().click();
  assert.equal(await message.inputValue(),'$(tts $(user) says: &t)');
  assert.equal(await cooldown.inputValue(),'0');
  await message.fill('$(tts Listen to $(user): &t)');
  await modal.locator('button[type="submit"]').click();
  await modal.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:/add command/i}).first().click();
  await modal.locator('[formControlName="name"]').fill('Second');await modal.locator('[formControlName="cmd"]').fill('second');await message.fill('Hello');
  await cooldown.fill('0');assert.equal(await modal.locator('button[type="submit"]').isDisabled(),true,'second zero blocked');
  await cooldown.fill(String(minimum));assert.equal(await modal.locator('button[type="submit"]').isEnabled(),true);
  await modal.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).first().click();await cooldown.fill(String(minimum));await modal.locator('button[type="submit"]').click();await modal.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:/add command/i}).first().click();
  await modal.locator('[formControlName="name"]').fill('Second');await modal.locator('[formControlName="cmd"]').fill('second');await message.fill('Hello');await cooldown.fill('0');
  await modal.locator('button[type="submit"]').click();await modal.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(writes.at(-1).cooldown,0,'create preserves zero');
  await page.goto(base+'/test/modules/tts');
  await page.locator('[data-testid="tts-command"]').getByText('$(tts Listen to $(user): &t)',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit TTS command',exact:true}).click();await cooldown.fill('0');assert.equal(await modal.locator('button[type="submit"]').isDisabled(),true,'module also enforces occupied slot');
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${tier}: shared TTS/commands saves, rename, zero cooldown slot, mobile/desktop, accessibility`);
 }
}finally{await browser.close();}
