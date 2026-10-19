import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
process.env.SAAS_DASHBOARD_FIXTURE_ONLY='true';
const {newPage,noOverflow}=await import(process.env.SAAS_DASHBOARD_FIXTURE||'/root/saas/ops/checks/dashboard-activity-site.mjs');
const require=createRequire((process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser')+'/package.json');
const {chromium}=require('playwright');const {default:AxeBuilder}=require('@axe-core/playwright');
const shots=process.env.SAAS_SCREENSHOT_DIR||'/tmp/dashboard-emote-shots';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 for(const theme of ['dark','light'])for(const width of [320,390,1280]){
  const {context,page,state,errors}=await newPage(browser,{width,height:1100},{chatEnabled:true,automodOn:true,theme});
  if(width<960)await page.getByRole('button',{name:'Your bot',exact:true}).click();
  const emotes=page.locator('[data-testid=dashboard-emotes]'),commands=page.locator('[data-testid=dashboard-commands]');
  await emotes.getByText('Your Twitch emotes used 30 times.',{exact:true}).waitFor();
  assert.equal(await emotes.getByRole('button',{name:'Your emotes',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await emotes.getByText('Kappa',{exact:true}).count(),0);await emotes.getByText('TestHype',{exact:true}).waitFor();
  await commands.getByText('100 recorded command runs.',{exact:true}).waitFor();assert.equal(await commands.locator('.usage-scope').count(),0);
  await emotes.getByRole('button',{name:'All emotes',exact:true}).click();await emotes.getByText('Native Twitch emotes used 90 times.',{exact:true}).waitFor();
  await emotes.getByText('Kappa',{exact:true}).waitFor();await emotes.getByText('TestHype',{exact:true}).waitFor();
  await emotes.getByLabel('Emote period').selectOption('30');await emotes.getByText('Native Twitch emotes used 270 times.',{exact:true}).waitFor();
  assert.equal(await commands.getByLabel('Command period').inputValue(),'7');
  await emotes.getByRole('button',{name:'Your emotes',exact:true}).click();await emotes.getByText('Your Twitch emotes used 90 times.',{exact:true}).waitFor();
  assert.ok(state.emoteScopes.includes('all')&&state.emoteScopes.includes('streamer'));await noOverflow(page,`${theme}-${width}`);
  const a=await new AxeBuilder({page}).include('app-dashboard-usage-card').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations,[]);assert.deepEqual(errors,[]);
  await emotes.scrollIntoViewIfNeeded();await emotes.screenshot({path:`${shots}/own-${theme}-${width}.png`});await context.close();
 }
 for(const scenario of [{ownershipUnavailable:true},{ownershipStale:true},{activityEmpty:true},{activityCold:true},{activityFail:true}]){
  const {context,page}=await newPage(browser,{width:320,height:1000},{chatEnabled:true,automodOn:true,theme:'dark',...scenario});await page.getByRole('button',{name:'Your bot',exact:true}).click();
  const emotes=page.locator('[data-testid=dashboard-emotes]');
  if(scenario.ownershipUnavailable){await emotes.getByText(/Could not check your channel emotes/).waitFor();assert.equal(await emotes.locator('.usage-state').count(),0,'outage is not a measured empty result');await emotes.getByRole('button',{name:'Show all emotes',exact:true}).click();await emotes.getByText('Native Twitch emotes used 90 times.',{exact:true}).waitFor();}
  if(scenario.ownershipStale)await emotes.getByText(/last available channel catalog/).waitFor();
  if(scenario.activityEmpty)await emotes.getByText(/None of your current channel emotes/).waitFor();
  if(scenario.activityCold)await emotes.getByText(/Preparing recorded activity/).waitFor();
  if(scenario.activityFail)await emotes.getByRole('button',{name:'Retry',exact:true}).waitFor();
  await noOverflow(page,JSON.stringify(scenario));await context.close();
 }
 const {context,page}=await newPage(browser,{width:390,height:1000},{chatEnabled:true,automodOn:true,theme:'dark',language:'es'});await page.getByRole('button',{name:'Tu bot',exact:true}).click();
 const emotes=page.locator('[data-testid=dashboard-emotes]');await emotes.getByText('Tus emotes de Twitch se usaron 30 veces.',{exact:true}).waitFor();
 await emotes.getByRole('button',{name:'Todos los emotes',exact:true}).click();await emotes.getByText('Emotes nativos de Twitch usados 90 veces.',{exact:true}).waitFor();await context.close();
 console.log('PASS EMOTE SCOPE SITE: streamer default, all toggle, independent 7/30 ranges, command regression, empty/outage/stale/processing/error, Spanish, 320/390/1280 dark/light, axe and overflow');
}finally{await browser.close();}
