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

async function installMocks(context, language = 'en') {
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
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') {
      return route.abort();
    }

    let data = {};
    if (url.pathname.startsWith('/goals/')) {
      if (failNext) { failNext = false; return route.fulfill({status: 503, json: {error:true, code:'internal'}}); }
      const request = route.request(), method = request.method();
      const twitchRule = url.pathname.match(/^\/goals\/[^/]+\/twitch\/([a-z_]+)$/);
      if (twitchRule && method === 'PUT') {
        puts.push({ type: twitchRule[1], body: request.postDataJSON(), revision: request.headers()['if-match'] });
        if (conflictNext) { conflictNext = false; return route.fulfill({ status: 409, json: { error: true, status: 409, code: 'conflict', message: 'Goals changed' } }); }
        const { actions } = request.postDataJSON(), rules = goalsState.twitch.rules.filter(rule => rule.type !== twitchRule[1]);
        if (actions.completion || actions.failure) rules.push({ type: twitchRule[1], ...actions });
        goalsState = { ...goalsState, revision: goalsState.revision + 1, twitch: { ...goalsState.twitch, rules } };
        return route.fulfill({ status: 200, json: envelope(goalsState) });
      }
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



let goalsState, failNext = false, conflictNext = false, puts = [];
const twitchGoals = () => ({ access: 'ok', actionTypes: ['follow', 'subscription_count', 'new_subscription_count', 'subscription', 'new_subscription'], rules: [], goals: [
  { id: 'tw-follow', type: 'follow', description: 'Road to 500', current: 420, target: 500, percent: 84, status: 'active', achieved: null, startedAt: Date.now() - 3600000, endedAt: null },
  { id: 'tw-bits', type: 'new_bit', description: '', current: 900, target: 1000, percent: 90, status: 'active', achieved: null, startedAt: Date.now() - 7200000, endedAt: null }] });
const {default: AxeBuilder} = await import(require.resolve('@axe-core/playwright'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const screenshots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/twitch-goals-shots';
const {mkdirSync} = await import('node:fs'); mkdirSync(screenshots,{recursive:true});
const until = async (check, label) => { for (let i = 0; i < 80; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + label); };
async function open(width, theme, language = 'en') {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await installMocks(context, language);
  await context.addInitScript(theme => { localStorage.setItem('theme', theme); }, theme);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/test/dashboard');
  await page.waitForSelector('app-channel-goals', { state: 'attached' });
  // Dashboard → Goals is a folded section (open it when it starts closed, e.g. on phones).
  await page.locator('details#goals').waitFor({ state: 'attached' });
  if (!(await page.locator('details#goals').evaluate(details => details.open))) await page.locator('details#goals > summary').click();
  await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
  return { context, page, errors, panel: page.locator('app-channel-goals'), section: page.locator('[data-twitch-goals]') };
}
const axe = async (page, include) => {
  const result = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ') + ': ' + n.failureSummary) })), []);
};
try {
  for (const width of [320, 390, 1280]) for (const theme of ['dark', 'light']) {
    puts = [];
    goalsState = { plan: 'free', limit: 2, metrics: ['follows', 'subs'], revision: 3, canManage: true, goals: [], twitch: twitchGoals() };
    const { context, page, errors, panel, section } = await open(width, theme);
    // Twitch goals: free, outside the quota, each with what it counts.
    await section.getByRole('heading', { name: 'On Twitch' }).waitFor();
    await section.getByText("Free · doesn't use a goal slot").waitFor();
    await panel.getByText('0 of 2 goals').waitFor();
    await panel.getByRole('heading', { name: 'Your goals here' }).waitFor();
    const follow = section.locator('[data-twitch-goal="follow"]'), bits = section.locator('[data-twitch-goal="new_bit"]');
    await follow.getByRole('heading', { name: 'Road to 500' }).waitFor();
    assert.match(await follow.textContent(), /Follower goal · Counts all your followers/);
    assert.match(await follow.textContent(), /420\s*\/ 500/);
    assert.match(await follow.textContent(), /84%/);
    assert.equal(await follow.getByRole('progressbar').getAttribute('aria-valuetext'), '420 of 500');
    await bits.getByRole('heading', { name: 'Bits goal' }).waitFor(); // no description: the type, not doubled
    assert.match(await bits.textContent(), /Bits used on your channel/);
    assert.match(await follow.locator('[data-twitch-rule-summary]').textContent(), /Reached: nothing · Ends unreached: nothing/);
    assert.equal(new URL(await section.locator('[data-twitch-manager]').getAttribute('href')).href, 'https://dashboard.twitch.tv/u/test/stream-manager');
    await panel.screenshot({ path: `${screenshots}/goals-twitch-${width}-${theme}.png` });
    await axe(page, 'app-channel-goals');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow');
    // Actions for every Twitch follower goal: validation, a conflict keeps the text, then saved with the revision.
    await follow.getByRole('button', { name: 'Actions for Road to 500' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Actions for Follower goals' }).waitFor();
    await dialog.getByLabel("When it's reached", { exact: true }).selectOption('message');
    await dialog.getByRole('button', { name: 'Save actions' }).click();
    await dialog.getByText('Enter action text within the character limit.').waitFor();
    await dialog.getByLabel('Message', { exact: true }).fill('We hit {{500}} followers!');
    await dialog.getByLabel('When it ends without being reached', { exact: true }).selectOption('ast');
    await dialog.getByLabel('AST source', { exact: true }).fill('$(chat.send So close)');
    await dialog.screenshot({ path: `${screenshots}/goals-twitch-editor-${width}-${theme}.png` });
    await axe(page, 'app-twitch-goals dialog');
    conflictNext = true;
    await dialog.getByRole('button', { name: 'Save actions' }).click();
    await dialog.getByText('Goals changed elsewhere. Check the refreshed list, then save again.').waitFor();
    assert.equal(await dialog.getByLabel('Message', { exact: true }).inputValue(), 'We hit {{500}} followers!');
    await dialog.getByRole('button', { name: 'Save actions' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(puts.at(-1), { type: 'follow', revision: '3', body: { actions: { completion: { type: 'message', text: 'We hit {{500}} followers!' }, failure: { type: 'ast', text: '$(chat.send So close)' } } } });
    await until(async () => /Reached: chat message · Ends unreached: AST/.test(await follow.locator('[data-twitch-rule-summary]').textContent()), 'rule summary');
    // Bits goal actions need Premium on Free: said plainly, nothing to save, link to plans.
    await bits.getByRole('button', { name: 'Actions for Bits goal' }).click();
    await dialog.locator('[data-twitch-locked]').getByText('Actions on Twitch Bits and cheerer goals need Premium. The goals themselves are free.').waitFor();
    assert.equal(await dialog.locator('[data-twitch-locked] a').getAttribute('href'), '/pricing');
    assert(await dialog.getByLabel("When it's reached", { exact: true }).isDisabled());
    assert.equal(await dialog.getByRole('button', { name: 'Save actions' }).count(), 0);
    await axe(page, 'app-twitch-goals dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'hidden' });
    // Every type in one list (for goals made later).
    await section.locator('[data-twitch-rules] summary').click();
    await section.getByText('Actions for Twitch goals · 1 set').waitFor();
    assert.equal(await section.locator('[data-twitch-rule]').count(), 7);
    await section.getByRole('button', { name: 'Actions for New sub goals' }).click();
    await dialog.getByRole('heading', { name: 'Actions for New sub goals' }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'hidden' });
    await axe(page, 'app-channel-goals');
    // No Twitch goals; then no permission.
    goalsState = { ...goalsState, twitch: { ...goalsState.twitch, goals: [] } };
    await section.locator('[data-twitch-empty]').waitFor({ timeout: 10000 });
    goalsState = { ...goalsState, twitch: { ...goalsState.twitch, access: 'permission' } };
    const reconnect = section.getByRole('link', { name: 'Reconnect Twitch' });
    await reconnect.waitFor({ timeout: 10000 });
    const href = new URL(await reconnect.getAttribute('href'));
    assert.deepEqual([href.pathname, href.searchParams.get('state'), href.searchParams.get('action')], ['/auth/authorize', 'test', 'reauthenticate']);
    await panel.screenshot({ path: `${screenshots}/goals-twitch-permission-${width}-${theme}.png` });
    await axe(page, 'app-channel-goals');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px ${theme}: Twitch goals free and outside the quota, counting notes, actions per type (validation, conflict keeps text, revision), Premium lock for Bits, all-types list, empty and reconnect states, axe, no overflow`);
  }
  // Spanish (es-MX) and a view-only admin.
  goalsState = { plan: 'premium', limit: 3, metrics: ['follows', 'subs', 'bits', 'currency'], revision: 1, canManage: false, goals: [],
    twitch: { ...twitchGoals(), actionTypes: ['follow', 'new_bit'], rules: [{ type: 'follow', completion: { type: 'message', text: 'x' } }] } };
  const { context, page, errors, section } = await open(390, 'dark', 'es');
  await section.getByRole('heading', { name: 'En Twitch' }).waitFor();
  await section.getByText('Gratis · no usa un espacio de meta').waitFor();
  assert.match(await section.locator('[data-twitch-goal="follow"] [data-twitch-rule-summary]').textContent(), /Cumplida: mensaje en el chat · Termina sin cumplirse: nada/);
  assert.equal(await section.getByRole('button', { name: /Acciones/ }).count(), 0, 'view-only admins see no action buttons');
  assert.equal(await section.locator('[data-twitch-rules]').count(), 0);
  await axe(page, 'app-channel-goals');
  assert.deepEqual(errors, []);
  await page.locator('app-channel-goals').screenshot({ path: `${screenshots}/goals-twitch-es-390-dark.png` });
  await context.close();
  console.log('PASS Spanish (es-MX) and view-only admin: no action buttons or rules list.');
} finally { await browser.close(); }
