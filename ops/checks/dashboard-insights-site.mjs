import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
process.env.SAAS_DASHBOARD_FIXTURE_ONLY='true';
const {newPage,noOverflow}=await import(process.env.SAAS_DASHBOARD_FIXTURE || '/root/saas/ops/checks/dashboard-activity-site.mjs');
const require=createRequire((process.env.SAAS_BROWSER_TOOLS||'/tmp/saas-cooldown-browser')+'/package.json');
const {chromium}=require('playwright');const {default:AxeBuilder}=require('@axe-core/playwright');
const shots=process.env.SAAS_SCREENSHOT_DIR||'/tmp/dashboard-insights-shots';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 for(const theme of ['dark','light'])for(const width of [320,390,1280]){
  const {context,page,errors,state}=await newPage(browser,{width,height:1100},{chatEnabled:true,automodOn:true,theme});
  const days=page.locator('[data-testid=dashboard-days]'),games=page.locator('[data-testid=dashboard-games]');
  await days.getByText('Tuesday leads for follower growth',{exact:true}).waitFor();
  await games.getByText('Celeste has the most watch time',{exact:true}).waitFor();
  assert.equal(await days.locator('.insight-chart li').count(),7);assert.equal(await games.locator('.insight-games li').count(),2);
  assert.equal(await days.getByRole('button',{name:'30 days',exact:true}).getAttribute('aria-pressed'),'true');
  await days.getByRole('button',{name:'7 days',exact:true}).click();await days.getByText('More history needed to compare days',{exact:true}).waitFor();
  assert.equal(await games.getByRole('button',{name:'30 days',exact:true}).getAttribute('aria-pressed'),'true');
  await days.getByLabel('Exclude recorded raids').uncheck();
  await page.waitForFunction(()=>!document.querySelector('[data-testid=dashboard-days]')?.textContent.includes('streams with recorded incoming raids left out'));
  assert.ok(state.insightRanges.some(row=>row.days==='7'&&row.raids==='include'));
  await days.getByRole('button',{name:'30 days',exact:true}).click();await days.getByText('Tuesday leads for follower growth',{exact:true}).waitFor();
  await days.getByText('View weekday details',{exact:true}).click();await days.getByText('Monday',{exact:true}).waitFor();
  await games.getByText('How this is calculated',{exact:true}).click();await games.getByText(/Multi-game streams are split/).waitFor();
  await noOverflow(page,`${width}-${theme}`);
  const a=await new AxeBuilder({page}).include('app-dashboard-insights-card').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations,[]);
  assert.deepEqual(errors,[]);
  // Keep screenshots focused on both report cards, with methodology collapsed.
  await days.getByText('View weekday details',{exact:true}).click();await games.getByText('How this is calculated',{exact:true}).click();
  for(const [name,card] of [['days',days],['games',games]]){await card.scrollIntoViewIfNeeded();await card.screenshot({path:`${shots}/${name}-${theme}-${width}.png`});}
  await context.close();
 }
 for(const scenario of [{insightEmpty:true},{insightCold:true},{insightStale:true},{insightFail:true},{insightLimited:true},{insightNoGames:true},{insightLong:true}]){
  const {context,page}=await newPage(browser,{width:320,height:1100},{chatEnabled:true,automodOn:true,theme:'dark',...scenario});
  const days=page.locator('[data-testid=dashboard-days]'),games=page.locator('[data-testid=dashboard-games]');
  if(scenario.insightEmpty)await days.getByText(/No completed streams match/).waitFor();
  if(scenario.insightCold)await days.getByText(/Preparing your report/).waitFor();
  if(scenario.insightStale)await days.getByText(/This report may be out of date/).waitFor();
  if(scenario.insightFail)await days.getByRole('button',{name:'Retry',exact:true}).click();
  if(scenario.insightLimited)await days.getByText(/This report reached a processing limit/).waitFor();
  if(scenario.insightNoGames)await games.getByText(/No usable game samples/).waitFor();
  if(scenario.insightLong)await games.getByText(/A very long game name.*most watch time/).waitFor();
  await noOverflow(page,JSON.stringify(scenario));await context.close();
 }
 const {context,page}=await newPage(browser,{width:390,height:1100},{chatEnabled:true,automodOn:true,theme:'dark',language:'es'});
 await page.locator('[data-testid=dashboard-days]').getByText('martes destaca en nuevos seguidores',{exact:true}).waitFor();
 await page.locator('[data-testid=dashboard-games]').getByText('Celeste acumula más tiempo de visualización',{exact:true}).waitFor();await context.close();
 console.log('PASS INSIGHTS SITE: independent 7/30 controls, raid filter, weekday details, game rankings, all report states, Spanish, 320/390/1280 dark/light, axe and overflow');
}finally{await browser.close();}
