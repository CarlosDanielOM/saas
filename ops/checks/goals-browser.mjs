import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
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

async function installMocks(context) {
  const twitch = TWITCH;
  const app = {
    name: 'Test Streamer',
    email: 'test@example.invalid',
    language: 'en',
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
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') {
      return route.abort();
    }

    let data = {};
    if (url.pathname.startsWith('/goals/')) {
      if (failNext) { failNext = false; return route.fulfill({status: 503, json: {error:true, code:'internal'}}); }
      const request = route.request(), method = request.method();
      if (method !== 'GET') {
        const body = request.postDataJSON(), id = url.pathname.split('/')[3];
        if (method === 'POST') {
          const goal = {...body, id: crypto.randomUUID(), current:0, percent:0, status:'active', startsAt:body.startsAt ? Date.parse(body.startsAt) : Date.now(), endsAt:body.endsAt ? Date.parse(body.endsAt) : undefined};
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


let goalsState, failNext = false;
const {default: AxeBuilder} = await import(require.resolve('@axe-core/playwright'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const screenshots = '/tmp/goals-shots';
const {mkdirSync} = await import('node:fs'); mkdirSync(screenshots,{recursive:true});
try {
 for (const width of [320,390,1280]) for (const theme of ['dark','light']) {
  goalsState = {plan:'free',limit:2,metrics:['follows','subs'],revision:0,canManage:true,goals:[]};
  const context = await browser.newContext({viewport:{width,height:900}});
  await installMocks(context);
  await context.addInitScript(theme => {localStorage.setItem('theme',theme); localStorage.setItem('userLanguage','en');},theme);
  const page = await context.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/test/dashboard');
  await page.waitForSelector('app-channel-goals', {state:'attached'});
  if(width<768) await page.getByRole('button',{name:'Goals',exact:true}).click();
  await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
  const panel=page.locator('app-channel-goals');
  await panel.getByText('0 of 2 goals').waitFor();
  await panel.getByRole('button',{name:'New goal',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();
  await dialog.getByText('Enter a name of 1–80 characters.').waitFor();
  assert(await dialog.locator('option[value="bits"]').isDisabled());
  await dialog.getByLabel('Goal name',{exact:true}).fill('Community follows');
  await dialog.getByLabel('Target amount').fill('100');
  await dialog.getByLabel('Counting mode').selectOption('current');
  await dialog.getByText('Use the current active follower or subscriber total shown on your dashboard, including people counted before this goal. Progress can decrease after unfollows or subscriptions end.').waitFor();
  failNext=true;
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();
  await dialog.getByText('Could not save. Your input has been kept. Try again.').waitFor();
  assert.equal(await dialog.getByLabel('Goal name',{exact:true}).inputValue(),'Community follows');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert.equal(goalsState.goals[0].mode,'current');
  await panel.getByText('Current total',{exact:false}).first().waitFor();
  await panel.getByRole('button',{name:'New goal',exact:true}).click();
  await dialog.getByLabel('Goal name',{exact:true}).fill('Weekend subs');
  await dialog.getByLabel('Count',{exact:true}).selectOption('subs');
  await dialog.getByLabel('Counting mode').selectOption('fixed');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();
  await dialog.getByText('Choose a current or future start and an end after the start.').waitFor();
  const local=value=>{const d=new Date(value);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};
  await dialog.getByLabel('Starts at').fill(local(Date.now()+60000));
  await dialog.getByLabel('Ends at').fill(local(Date.now()+86400000));
  await dialog.screenshot({path:screenshots+`/editor-${width}-${theme}.png`});
  let axe=await new AxeBuilder({page}).include('app-channel-goals dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)})),[]);
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert(await panel.getByRole('button',{name:'New goal',exact:true}).isDisabled());
  await panel.getByRole('button',{name:'Edit Community follows',exact:true}).click();
  await dialog.getByLabel('Counting mode').waitFor({state:'detached'});
  await dialog.getByLabel('Target amount').fill('200');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await panel.getByRole('button',{name:'Delete Weekend subs',exact:true}).click();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click(); assert.equal(goalsState.goals.length,2);
  await panel.getByRole('button',{name:'Delete Weekend subs',exact:true}).click();
  await dialog.getByRole('button',{name:'Delete',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await panel.getByRole('button',{name:'New goal',exact:true}).click();
  await dialog.getByLabel('Goal name',{exact:true}).fill('Subs this hour');
  await dialog.getByLabel('Count',{exact:true}).selectOption('subs');
  await dialog.getByLabel('Counting mode').selectOption('rolling');
  await dialog.getByLabel('Look back').fill('1');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  assert.equal(goalsState.goals[1].windowSeconds,3600);
  goalsState={...goalsState,plan:'premium',limit:3,metrics:['follows','subs','bits']};
  await panel.getByText('2 of 3 goals').waitFor({timeout:10000});
  await panel.getByRole('button',{name:'New goal',exact:true}).click();
  await dialog.getByLabel('Goal name',{exact:true}).fill('Bits celebration');
  await dialog.getByLabel('Counting mode').selectOption('current');
  await dialog.getByLabel('Count',{exact:true}).selectOption('bits');
  await dialog.locator('option[value="current"]').waitFor({state:'detached'});
  assert.equal(await dialog.getByLabel('Counting mode').inputValue(),'total','Bits falls back to since creation');
  await dialog.getByRole('button',{name:'Save goal',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  assert(await panel.getByRole('button',{name:'New goal',exact:true}).isDisabled());
  goalsState.goals[0]={...goalsState.goals[0],current:125,percent:62.5};
  await panel.getByText('125',{exact:false}).first().waitFor({timeout:10000});
  await panel.screenshot({path:screenshots+`/goals-${width}-${theme}.png`});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');
  axe=await new AxeBuilder({page}).include('app-channel-goals').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)})),[]);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log(`PASS ${width}px ${theme}: current/since-creation/fixed/rolling, Bits excludes current totals, free and premium limits, Bits gating, errors preserve drafts, edit/delete, progress, axe, no overflow`);
 }
} finally {await browser.close();}
