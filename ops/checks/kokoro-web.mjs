import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const {chromium}=require('playwright');
const {default:AxeBuilder}=require('@axe-core/playwright');
const base=process.env.SAAS_PREVIEW_URL||'http://127.0.0.1:4216';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext();const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const user={id:'999991',login:'test',display_name:'Test'};
const app={name:'Test',email:'test@example.invalid',language:'en',plan_tier:'free',actived:true,chat_enabled:true,twitch_user_id:'999991',has_permissions:true,up_to_date_permissions:true,administrating:[]};
await context.addInitScript(({user,app})=>localStorage.setItem('dimasite.session.v1',JSON.stringify({version:2,token:'test-only',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),twitchUser:user,appUser:app,permissions:{}})),{user,app});
let settings={channelID:'999991',channel:'test',enabled:true,provider:'piper',defaultLanguage:'es',voices:{en:'en_US-ryan-medium',es:'es_MX-ald-medium',cloneDefault:'gojo',kokoroDefault:'ef_dora'},filters:{skipEmotes:true,stripLinks:true,normalizeWhitespace:true,maxLength:280,expressiveTags:{}},queue:{maxItems:5}};
const voices=['af_heart','am_michael','ef_dora','em_alex'];let saves=0;
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin===new URL(base).origin)return route.continue();
 if(!['api.domdimabot.com','localhost','127.0.0.1'].includes(url.hostname))return route.abort();
 let data={};
 if(url.pathname==='/users')data={id:'999991',username:'test'};
 else if(url.pathname==='/auth/session')data={twitch:user,app};
 else if(url.pathname.endsWith('/access')||url.pathname.startsWith('/auth/access/'))data={allowed:true,role:'owner'};
 else if(url.pathname==='/speech/settings/999991'){
  if(route.request().method()==='PUT'){settings=route.request().postDataJSON();saves++;}
  data={role:'owner',settings,...(route.request().method()==='GET'?{kokoroVoices:voices}:{})};
 }else if(url.pathname==='/speech/favorites/999991')data=[];
 else if(url.pathname.includes('/live-status'))data={isLive:false,currentViewers:0};
 return route.fulfill({json:{error:false,status:200,data}});
});
try{
 await page.goto(base+'/test/modules/tts');
 await page.locator('input[value="kokoro"]').waitFor();
 assert.equal(await page.locator('input[value="piper"]').isChecked(),true,'existing choice survives loading');
 assert.equal(saves,0,'loading does not change saved provider');
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:900});
  await page.locator('input[value="kokoro"]').check();
  await page.locator('#kokoro-default-voice').selectOption('af_heart');
  assert.equal(await page.locator('#kokoro-default-voice').inputValue(),'af_heart');
  assert.match(await page.locator('.lf-engines').innerText(),/1 credit \/ 15 characters/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
  const results=await new AxeBuilder({page}).include('app-tts-page').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.length})),[],'TTS page accessibility');
  const out=process.env.SAAS_KOKORO_SHOTS||'/tmp/saas-kokoro-shots';fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:`${out}/kokoro-${width}.png`,fullPage:true});
 }
 await page.getByRole('button',{name:/save tts settings/i}).click();
 await page.getByRole('button',{name:/save tts settings/i}).waitFor({state:'visible'});
 await page.waitForTimeout(300);
 assert.equal(await page.locator('#kokoro-default-voice option').count(),voices.length,'voice catalog survives the settings-save response');
 assert.equal(saves,1);assert.equal(settings.provider,'kokoro');assert.equal(settings.voices.kokoroDefault,'af_heart');
 await page.reload();await page.locator('#kokoro-default-voice').waitFor();
 assert.equal(await page.locator('input[value="kokoro"]').isChecked(),true);
 assert.equal(await page.locator('#kokoro-default-voice').inputValue(),'af_heart');
 await page.locator('input[value="fish"]').check();await page.locator('#fish-default-voice').waitFor();
 await page.locator('input[value="piper"]').check();assert.equal(await page.locator('#kokoro-default-voice').count(),0);
 app.language='es';
 await page.evaluate(()=>localStorage.setItem('userLanguage','es'));
 await page.reload();await page.locator('input[value="kokoro"]').waitFor();
 await page.locator('input[value="kokoro"]').check();
 await page.getByText('1 crédito / 15 caracteres',{exact:true}).waitFor();
 assert.match(await page.locator('.lf-engines').innerText(),/1 crédito \/ 15 caracteres/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log('PASS Kokoro settings: existing selection, manual switch, presets, save/reload, Fish/Piper controls, 320/390/1440 layouts and WCAG AA');
}finally{await browser.close();}
