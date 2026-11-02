import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback preview');
const origin = new URL(base).origin;

const CHANNEL_ID = '123456789';
const TWITCH = {
  id: CHANNEL_ID,
  login: 'test',
  display_name: 'Test Streamer',
  profile_image_url: ''
};

const UNUSED_CHART_CHIPS = [
  { label: 'Engagement', dots: 3 },
  { label: 'Hours', dots: 1 },
  { label: 'Bits', dots: 1 },
  { label: 'Donations', dots: 1 }
];

function buildHistory() {
  const out = [];
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 29; i >= 0; i--) {
    const day = new Date(cursor);
    day.setUTCDate(cursor.getUTCDate() - i);
    out.push({
      date: day.toISOString(),
      viewers: Math.round(20 + Math.random() * 200),
      hours: Number((1 + Math.random() * 5).toFixed(1)),
      bits: Math.round(Math.random() * 900),
      donations: Number((Math.random() * 40).toFixed(2)),
      follows: Math.round(Math.random() * 60),
      subs: Math.round(Math.random() * 10)
    });
  }
  return out;
}

function bootstrapData() {
  const history = buildHistory();
  return {
    role: 'owner',
    channel: { id: CHANNEL_ID, name: 'Test Streamer', chatEnabled: true },
    isLive: false,
    liveStream: null,
    liveSession: null,
    kpis: {
      activeViewers: 0,
      averageViewers: 120,
      monthlyAverageViewers: 110,
      averageHoursPerStream: 3.2,
      totalBits: 4200,
      totalStreams: 18,
      totalDonations: 210.5,
      activeFollows: 55,
      activeSubs: 9,
      monthlyGoalSubs: 100,
      subsProgressPct: 9
    },
    trend: history.map((point) => ({ date: point.date, viewers: point.viewers, hours: point.hours })),
    streamHistory: history,
    totalFollowers: 5400,
    totalSubs: 320,
    monthlyGoals: { followersGoal: 6000, followersCurrent: 5400, subsGoal: 500, subsCurrent: 320 }
  };
}

function envelope(data) {
  return { error: false, status: 200, message: 'ok', data };
}

async function installMocks(context, language) {
  const twitch = TWITCH;
  const app = {
    name: 'Test Streamer',
    email: 'test@example.invalid',
    language,
    plan_tier: 'premium',
    actived: true,
    chat_enabled: true,
    twitch_user_id: CHANNEL_ID,
    has_permissions: true,
    up_to_date_permissions: true,
    administrating: []
  };
  await context.addInitScript(({ twitch, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2,
      token: 'test-only',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: twitch,
      appUser: app,
      permissions: {}
    }));
  }, { twitch, app });

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      return ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort();
    }
    if (url.hostname !== 'api.domdimabot.com') {
      return route.abort();
    }

    let data = {};
    if (url.pathname.startsWith('/goals/')) {
      const request = route.request(), method = request.method();
      if (method !== 'GET') {
        const body = request.postDataJSON(), id = url.pathname.split('/')[3];
        mutations.push({method,body,revision:request.headers()['if-match']});
        if (failNextMutation) { failNextMutation=false; return route.fulfill({status:503,json:{error:true,code:'internal'}}); }
        if (method === 'POST') {
          const goal = {...body, id: crypto.randomUUID(), current:0, percent:0, status:'active', startsAt:body.startsAt ? Date.parse(body.startsAt) : Date.now(), endsAt:body.endsAt ? Date.parse(body.endsAt) : undefined, ...(body.mode==='monthly'?{period:monthPeriod(body.timeZone)}:{})};
          goalsState.goals.push(goal);
        }
        if (method === 'PATCH') goalsState.goals = goalsState.goals.map(goal => goal.id === id ? {...goal,...body} : goal);
        if (method === 'DELETE') goalsState.goals = goalsState.goals.filter(goal => goal.id !== id);
        goalsState.revision++;
      }
      return route.fulfill({status:200,json:envelope(goalsState)});
    }
    if (url.pathname === '/auth/session') {
      data = { twitch, app };
    } else if (url.pathname.startsWith('/auth/access/')) {
      data = { allowed: true, role: 'owner' };
    } else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(url.pathname)) {
      data = bootstrapData();
    } else if (/^\/dashboard\/[^/]+\/access$/.test(url.pathname)) {
      data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'Test Streamer', planTier: 'premium' };
    } else if (/^\/dashboard\/[^/]+\/live-status$/.test(url.pathname)) {
      data = { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    } else if (url.pathname === '/users') {
      data = { id: CHANNEL_ID, username: 'test', profile_image_url: '' };
    }
    return route.fulfill({ status: 200, json: envelope(data) });
  });
}


// All API mutations and all non-local sockets are intercepted before navigation.
let goalsState, mutations = [], failNextMutation = false;
function monthPeriod(zone = 'America/New_York') {
  const bounds = zone === 'Europe/Madrid' ? ['2026-10-31T23:00:00Z','2026-11-30T23:00:00Z'] : zone === 'UTC' ? ['2026-11-01T00:00:00Z','2026-12-01T00:00:00Z'] : ['2026-11-01T04:00:00Z','2026-12-01T05:00:00Z'];
  return {key:'2026-11',startsAt:Date.parse(bounds[0]),endsAt:Date.parse(bounds[1])};
}
function initialGoals() {
  return {plan:'premium',limit:3,metrics:['follows','subs','bits','currency'],revision:0,canManage:true,serverTime:Date.now(),goals:[
    {id:'money',name:'Monthly support',metric:'currency',mode:'monthly',target:25000,current:775,percent:3.1,status:'active',startsAt:Date.parse('2026-11-02T00:00:00Z'),timeZone:'America/New_York',period:monthPeriod(),currency:{code:'USD',bitValue:1,subscriptionValue:175,items:[{key:'streamloots_chest',label:'Chests',unitAmount:250,feeBasisPoints:1000}]}},
    {id:'count',name:'Follower count',metric:'follows',mode:'total',target:100,current:12,percent:12,status:'active',startsAt:Date.now()-1000}
  ]};
}
const {default:AxeBuilder} = await import(require.resolve('@axe-core/playwright'));
const {mkdirSync} = await import('node:fs');
const screenshots = process.env.SAAS_CURRENCY_SHOTS || '/tmp/currency-goals-shots';
mkdirSync(screenshots,{recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const cases = [320,390,1280].flatMap(width => ['dark','light'].map(theme => ({width,theme,language:'en'})));
cases.push({width:390,theme:'dark',language:'es'});
const shape = violations => violations.map(v => ({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)}));
async function assertNoOverflow(page, dialog) {
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');
  if (await dialog.isVisible()) assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog overflow');
}
try {
 for (const {width,theme,language} of cases) {
  goalsState=initialGoals(); mutations=[]; failNextMutation=false;
  const context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/New_York',locale:language==='es'?'es-ES':'en-US'});
  await installMocks(context,language);
  await context.routeWebSocket('**/*', ws => {
    if(new URL(ws.url()).host===new URL(origin).host) ws.connectToServer(); else ws.close();
  });
  await context.addInitScript(({theme,language})=>{localStorage.setItem('theme',theme);localStorage.setItem('userLanguage',language);},{theme,language});
  const page=await context.newPage(),errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  await page.goto(base+'/test/dashboard');
  const panel=page.locator('app-channel-goals'); await panel.waitFor({state:'attached'});
  const fold=page.locator('details.fold').filter({has:panel});
  if(await fold.count() && await fold.getAttribute('open')===null) await fold.locator('summary').first().click();
  await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
  const money=panel.locator('section.goal').filter({has:page.getByRole('heading',{name:'Monthly support',exact:true})});
  const count=panel.locator('section.goal').filter({has:page.getByRole('heading',{name:'Follower count',exact:true})});
  const decimal=language==='es'?'7,75':'7.75',targetDecimal=language==='es'?'250,00':'250.00';
  await money.locator('.numbers').filter({hasText:decimal}).waitFor();
  assert((await money.locator('.numbers').innerText()).includes(targetDecimal));
  assert.equal(await money.getByRole('progressbar').getAttribute('aria-valuenow'),'7.75');
  assert((await money.getByRole('progressbar').getAttribute('aria-valuetext')).includes(decimal));
  assert((await money.innerText()).includes('America/New_York'));
  assert.equal(await count.getByRole('progressbar').getAttribute('aria-valuenow'),'12');
  assert((await count.locator('.numbers').innerText()).includes('100'));
  await money.locator('summary').click();
  assert((await money.locator('code').innerText()).includes('$(goal.add streamloots_chest 3)'));
  await panel.screenshot({path:`${screenshots}/goals-${width}-${theme}-${language}.png`});
  let axe=await new AxeBuilder({page}).include('app-channel-goals').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(shape(axe.violations),[]);
  const newGoal=panel.locator('.head > button.primary');
  await newGoal.click();
  const dialog=page.getByRole('dialog'), save=dialog.locator('button[type=submit]');
  const cancel=dialog.locator('footer button[type=button]');
  const invalidSave=async()=>{const before=mutations.length;await save.click();await page.waitForTimeout(200);assert.equal(mutations.length,before,'invalid form sent a mutation');assert(await dialog.isVisible());};
  await dialog.locator('#goal-name').fill('Currency demonstration');
  await dialog.locator('#goal-mode').selectOption('current');
  await dialog.locator('#goal-metric').selectOption('currency');
  assert.equal(await dialog.locator('#goal-mode').inputValue(),'total');
  assert.equal(await dialog.locator('#goal-mode option[value=current]').count(),0);
  await dialog.locator('#goal-target').fill('250.00');
  assert.equal(await dialog.locator('#goal-bit-value').inputValue(),'0.01');
  assert.equal(await dialog.locator('#goal-sub-value').inputValue(),'1.75');
  await dialog.getByRole('button',{name:language==='es'?'Añadir artículo':'Add item',exact:true}).click();
  await dialog.locator('#goal-item-key-0').fill('streamloots_chest');
  await dialog.locator('#goal-item-price-0').fill('2.50');
  await dialog.locator('#goal-item-fee-0').fill('10');
  assert((await dialog.locator('.item-preview').innerText()).includes(language==='es'?'6,75':'6.75'));
  await dialog.locator('#goal-target').fill('1.005'); await invalidSave();
  await dialog.locator('#goal-target').fill('0'); await invalidSave();
  await dialog.locator('#goal-target').fill('250.00');
  await dialog.locator('#goal-item-fee-0').fill('100.01'); await invalidSave();
  await dialog.locator('#goal-item-fee-0').fill('10');
  await dialog.getByRole('button',{name:language==='es'?'Añadir artículo':'Add item',exact:true}).click();
  await dialog.locator('#goal-item-key-1').fill('streamloots_chest'); await invalidSave();
  await dialog.locator('.custom-item').last().getByRole('button').click();
  await dialog.locator('#goal-mode').selectOption('monthly');
  assert.equal(await dialog.locator('#goal-time-zone').inputValue(),'America/New_York');
  await dialog.locator('#goal-time-zone').fill('Mars/Olympus'); await invalidSave();
  await dialog.locator('#goal-time-zone').fill('Europe/Madrid');
  await dialog.evaluate(el=>{el.scrollTop=0;});
  await dialog.screenshot({path:`${screenshots}/editor-top-${width}-${theme}-${language}.png`});
  await dialog.locator('#goal-time-zone').scrollIntoViewIfNeeded();
  await dialog.screenshot({path:`${screenshots}/editor-period-${width}-${theme}-${language}.png`});
  await assertNoOverflow(page,dialog);
  axe=await new AxeBuilder({page}).include('app-channel-goals dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(shape(axe.violations),[]);
  failNextMutation=true; await save.click(); await dialog.locator('[role=alert]').waitFor();
  assert.equal(await dialog.locator('#goal-target').inputValue(),'250.00');
  assert.equal(await dialog.locator('#goal-item-key-0').inputValue(),'streamloots_chest');
  await save.click(); await dialog.waitFor({state:'hidden'});
  const posted=mutations.filter(r=>r.method==='POST').at(-1).body;
  assert.equal(posted.target,25000); assert.equal(posted.metric,'currency'); assert.equal(posted.mode,'monthly');assert.equal(posted.timeZone,'Europe/Madrid');
  assert.deepEqual(posted.currency,{code:'USD',bitValue:1,subscriptionValue:175,items:[{key:'streamloots_chest',unitAmount:250,feeBasisPoints:1000}]});
  await money.locator('.actions button').first().click();
  assert.equal(await dialog.locator('#goal-target').inputValue(),'250.00');
  assert.equal(await dialog.locator('#goal-currency').count(),0);
  assert.equal(await dialog.locator('#goal-mode').count(),0);
  await dialog.locator('#goal-target').fill('260.00'); await save.click(); await dialog.waitFor({state:'hidden'});
  const patched=mutations.filter(r=>r.method==='PATCH').at(-1).body;
  assert.equal(patched.target,26000); assert.deepEqual(Object.keys(patched).sort(),['actions','name','target']);
  const created=panel.locator('section.goal').filter({has:page.getByRole('heading',{name:'Currency demonstration',exact:true})});
  await created.locator('.actions button').last().click(); await save.click(); await dialog.waitFor({state:'hidden'});
  await newGoal.click();
  await dialog.locator('#goal-name').fill('Custom fixed goal');
  await dialog.locator('#goal-metric').selectOption('currency');
  await dialog.locator('#goal-target').fill('50.00');
  await dialog.locator('#goal-bit-value').fill('0'); await dialog.locator('#goal-sub-value').fill('0');
  await invalidSave();
  await dialog.getByRole('button',{name:language==='es'?'Añadir artículo':'Add item',exact:true}).click();
  await dialog.locator('#goal-item-key-0').fill('streamloots_chest');
  await dialog.locator('#goal-item-price-0').fill('2.50');await dialog.locator('#goal-item-fee-0').fill('100');await invalidSave();
  await dialog.locator('#goal-item-fee-0').fill('20');
  assert((await dialog.locator('.item-preview').innerText()).includes(language==='es'?'6,00':'6.00'));
  await dialog.locator('#goal-mode').selectOption('fixed');
  const dates=await page.evaluate(()=>{const local=ms=>{const d=new Date(ms);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};return {start:local(Date.now()+60000),end:local(Date.now()+86400000)};});
  await dialog.locator('#goal-start').fill(dates.start);await dialog.locator('#goal-end').fill(dates.end);
  await save.click();await dialog.waitFor({state:'hidden'});
  const fixed=mutations.filter(r=>r.method==='POST').at(-1).body;
  assert.equal(fixed.mode,'fixed');assert.equal(fixed.target,5000);assert.equal(fixed.currency.bitValue,0);assert.equal(fixed.currency.subscriptionValue,0);assert.equal(fixed.currency.items[0].feeBasisPoints,2000);assert(Date.parse(fixed.endsAt)>Date.parse(fixed.startsAt));assert(!('timeZone' in fixed));
  const fixedCard=panel.locator('section.goal').filter({has:page.getByRole('heading',{name:'Custom fixed goal',exact:true})});
  await fixedCard.locator('.actions button').last().click();await save.click();await dialog.waitFor({state:'hidden'});
  if(width===390&&theme==='dark'&&language==='en') {
   await newGoal.click();await dialog.locator('#goal-metric').selectOption('currency');
   const add=dialog.getByRole('button',{name:'Add item',exact:true});
   for(let i=0;i<20;i++) { await add.click(); await dialog.locator('.custom-item').nth(i).waitFor({state:'attached'}); }
   assert.equal(await dialog.locator('.custom-item').count(),20);assert(await add.isDisabled());
   const remove=dialog.getByRole('button',{name:'Remove item 20',exact:true});
   await remove.scrollIntoViewIfNeeded();const box=await remove.boundingBox();assert(box&&box.height>=44);await remove.click();await dialog.locator('.custom-item').nth(19).waitFor({state:'detached'});assert.equal(await dialog.locator('.custom-item').count(),19);assert(!await add.isDisabled());
   await cancel.click();await dialog.waitFor({state:'hidden'});
  }
  await assertNoOverflow(page,dialog);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log(`PASS currency goals ${width}px ${theme} ${language}: cents, mixed/custom rates, fees, validation, monthly/fixed, immutable edits, ARIA, axe, no overflow; screenshots ${screenshots}`);
 }
} finally { await browser.close(); }
