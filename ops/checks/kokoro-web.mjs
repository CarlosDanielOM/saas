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
let role='owner'; let previewError=''; const previewRequests=[];
const wav=Buffer.alloc(44+1600);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
await context.addInitScript(()=>{
 window.revokedPreviewUrls=[];
 const revoke=URL.revokeObjectURL.bind(URL);
 URL.revokeObjectURL=url=>{window.revokedPreviewUrls.push(url);revoke(url);};
});
await context.routeWebSocket(/api\.domdimabot\.com|localhost:3000|127\.0\.0\.1:3000/, ws=>{
 ws.send('0'+JSON.stringify({sid:'fixture',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000}));
 ws.onMessage(message=>{
  const m=String(message);
  if(m.startsWith('40')){const ns=m.slice(2).split(',')[0];ws.send(`40${ns},${JSON.stringify({sid:'preview-fixture'})}`);}
  if(m.startsWith('42/speech-preview/')){
   const match=m.match(/^42([^,]+),(\d+)(.*)$/);const body=JSON.parse(match[3])[1];previewRequests.push(body);
   const response=previewError?{error:true,code:previewError}:{error:false,data:{...body,credits:body.provider==='piper'?1:2,text:'0123456789abcdef',mimeType:'audio/wav',audio:wav.toString('base64')}};
   setTimeout(()=>ws.send(`43${match[1]},${match[2]}${JSON.stringify([response])}`),600);
  }
 });
});
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
  data={role,settings,...(route.request().method()==='GET'?{kokoroVoices:voices}:{})};
 }else if(url.pathname==='/speech/preview-session/999991')data={ticket:'f'.repeat(64)};
 else if(url.pathname==='/speech/favorites/999991')data=[];
 else if(url.pathname.includes('/live-status'))data={isLive:false,currentViewers:0};
 return route.fulfill({json:{error:false,status:200,data}});
});
try{
 await page.goto(base+'/test/modules/tts');
 await page.locator('input[value="kokoro"]').waitFor();
 assert.equal(await page.locator('input[value="piper"]').isChecked(),true,'existing choice survives loading');
 assert.equal(saves,0,'loading does not change saved provider');
 assert.deepEqual(await page.locator('.lf-engines input').evaluateAll(inputs=>inputs.map(input=>input.value)),['piper','kokoro','fish']);
 await page.locator('.lf-engines').getByText('1 credit / 50 characters',{exact:true}).waitFor();
 const piperEnglish=page.locator('app-tts-voice-preview').nth(0);
 const piperSpanish=page.locator('app-tts-voice-preview').nth(1);
 await piperEnglish.getByRole('button').click();
 await piperEnglish.locator('audio').waitFor();
 assert.deepEqual(previewRequests.at(-1),{provider:'piper',voiceId:'en_US-ryan-medium',language:'en'});
 assert.match(await piperEnglish.innerText(),/1 credits used/);
 const piperUrl=await piperEnglish.locator('audio').getAttribute('src');
 await piperSpanish.getByRole('button').click();await piperSpanish.locator('audio').waitFor();
 assert.deepEqual(previewRequests.at(-1),{provider:'piper',voiceId:'es_MX-ald-medium',language:'es'});
 assert.equal(saves,0,'previewing never saves settings');
 await page.locator('input[value="kokoro"]').check();await page.locator('#kokoro-default-voice').waitFor();
 assert.equal(await page.evaluate(url=>window.revokedPreviewUrls.includes(url),piperUrl),true,'provider switch releases old audio');
 const kokoro=page.locator('app-tts-voice-preview');
 await page.locator('#kokoro-default-voice').selectOption('af_heart');
 await kokoro.getByRole('button').click();
 await page.waitForFunction(()=>document.querySelector('app-tts-voice-preview button')?.disabled);
 assert.equal(await kokoro.getByRole('button').isDisabled(),true,'prevent duplicate click while preparing');
 await kokoro.locator('audio').waitFor();
 assert.deepEqual(previewRequests.at(-1),{provider:'kokoro',voiceId:'af_heart',language:'es'});
 assert.match(await kokoro.innerText(),/2 credits used/);
 const count=previewRequests.length;
 await kokoro.locator('audio').evaluate(audio=>{audio.pause();audio.currentTime=0;return audio.play();});
 assert.equal(previewRequests.length,count,'replay never calls or bills provider');
 const kokoroUrl=await kokoro.locator('audio').getAttribute('src');
 await page.locator('#kokoro-default-voice').selectOption('em_alex');
 await kokoro.locator('audio').waitFor({state:'detached'});
 assert.equal(await page.evaluate(url=>window.revokedPreviewUrls.includes(url),kokoroUrl),true,'voice change clears/revokes sample');
 for(const code of ['insufficient_credits','preview_busy','synthesis_failed']){
  previewError=code;await kokoro.getByRole('button').click();await kokoro.getByRole('alert').waitFor();
  assert.equal(await kokoro.locator('audio').count(),0,'failure has no audio player');
  assert.doesNotMatch(await kokoro.getByRole('alert').innerText(),/Fish/,'error applies to selected provider');
 }
 previewError='';
 await kokoro.getByRole('button').click();
 await page.locator('#kokoro-default-voice').selectOption('am_michael');
 await page.waitForTimeout(800);
 assert.equal(await kokoro.locator('audio').count(),0,'changing voice cancels stale result');
 assert.equal(saves,0);
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:900});
  await page.locator('input[value="piper"]').check();
  const piper=page.locator('app-tts-voice-preview').first();
  await piper.getByRole('button').click();await piper.locator('audio').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Piper preview fits mobile');
  const piperAxe=await new AxeBuilder({page}).include('app-tts-page').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(piperAxe.violations.map(v=>v.id),[]);
  const piperShots=process.env.SAAS_KOKORO_SHOTS||'/tmp/saas-kokoro-shots';fs.mkdirSync(piperShots,{recursive:true});
  await page.screenshot({path:`${piperShots}/piper-${width}.png`,fullPage:true});
  await page.locator('input[value="kokoro"]').check();
  await page.locator('#kokoro-default-voice').selectOption('af_heart');
  assert.equal(await page.locator('#kokoro-default-voice').inputValue(),'af_heart');
  assert.match(await page.locator('.lf-engines').innerText(),/1 credit \/ 15 characters/);
  await kokoro.getByRole('button').click();await kokoro.locator('audio').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
  assert.ok((await page.locator('.lf-form-grid select').last().boundingBox()).height<60,'language selector stays compact beside preview');
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
 await page.locator('.lf-engines').getByText('1 crédito / 15 caracteres',{exact:true}).waitFor();
 assert.match(await page.locator('.lf-engines').innerText(),/1 crédito \/ 15 caracteres/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await kokoro.getByRole('button').click();await kokoro.locator('audio').waitFor();
 assert.match(await kokoro.innerText(),/2 créditos usados/);
 role='viewer';await page.reload();await page.locator('#kokoro-default-voice').waitFor();
 assert.equal(await page.locator('app-tts-voice-preview button').isDisabled(),true,'read-only users cannot request paid previews');
 assert.deepEqual(errors,[]);
 console.log('PASS TTS voice previews: provider order, English/Spanish metered Piper, paid Kokoro, replay, failure/busy states, stale result cancellation, read-only permissions; Kokoro settings: existing selection, manual switch, presets, save/reload, Fish/Piper controls, 320/390/1440 layouts and WCAG AA');
}finally{await browser.close();}
