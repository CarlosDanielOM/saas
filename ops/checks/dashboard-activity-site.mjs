/**
 * Real-app browser checks for cached commands/emotes in the existing bot section.
 * All authenticated APIs are fixtures. Covers 320/390/1280px, both themes, Spanish,
 * accessibility, empty/error/pending/stale states, silent messages and delete/re-add.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/dashboard-activity-shots';
mkdirSync(shots, { recursive: true });

const CHANNEL_ID = '123456789';
const DAY = 86_400_000;
const TWITCH = { id: CHANNEL_ID, login: 'test', display_name: 'Test Streamer', profile_image_url: '' };

/** Noon UTC, `days` ago. */
function daysAgo(days, hour = 12) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() - days * DAY).toISOString();
}

// This week: 3 streams, 9.5 h, 30 follows. Week before: 2 streams, 25 follows (+20%).
const HISTORY = [
  { d: 27, hours: 2, follows: 4 },
  { d: 20, hours: 3, follows: 6 },
  { d: 15, hours: 2.5, follows: 5 },
  { d: 10, hours: 3, follows: 10 },
  { d: 8, hours: 2, follows: 15 },
  { d: 5, hours: 4.5, follows: 8 },
  { d: 3, hours: 3, follows: 12 },
  { d: 1, hours: 2, follows: 10 }
].map((s, i) => ({
  date: daysAgo(s.d),
  viewers: 40 + i * 5,
  hours: s.hours,
  bits: 100 * (i + 1),
  donations: 2.5 * i,
  follows: s.follows,
  subs: i % 3
}));

// 5 automod actions this week (spam_bot ×3), 2 the week before.
const LOGS = [
  { u: 'spam_bot', rule: 'links', action: 'delete', d: 1 },
  { u: 'spam_bot', rule: 'links', action: 'timeout', d: 1.2 },
  { u: 'spam_bot', rule: 'links', action: 'ban', d: 2 },
  { u: 'loud_lu', rule: 'caps', action: 'delete', d: 3 },
  { u: 'rude_ray', rule: 'blacklist', action: 'warn', d: 4 },
  { u: 'old_one', rule: 'caps', action: 'delete', d: 9 },
  { u: 'old_two', rule: 'links', action: 'delete', d: 10 }
].map((l, i) => ({
  _id: `log${i}`,
  channelID: CHANNEL_ID,
  userID: `u${i}`,
  username: l.u,
  ruleID: `r-${l.rule}`,
  ruleType: l.rule,
  action: l.action,
  offenseNumber: 1 + (i % 3),
  reason: 'test',
  messageID: `m${i}`,
  messageExcerpt: 'x',
  success: true,
  errorMessage: null,
  createdAt: new Date(Date.now() - l.d * DAY).toISOString()
}));

function bootstrapData({ chatEnabled }) {
  return {
    role: 'owner',
    channel: { id: CHANNEL_ID, name: 'Test Streamer', chatEnabled },
    isLive: false,
    liveStream: null,
    liveSession: null,
    kpis: {
      activeViewers: 0, averageViewers: 60, monthlyAverageViewers: 60, averageHoursPerStream: 2.8,
      totalBits: 3600, totalStreams: HISTORY.length, totalDonations: 70, activeFollows: 70, activeSubs: 7,
      monthlyGoalSubs: 100, subsProgressPct: 7
    },
    trend: [],
    streamHistory: HISTORY,
    totalFollowers: 5400,
    totalSubs: 320,
    monthlyGoals: { followersGoal: 6000, followersCurrent: 5400, subsGoal: 500, subsCurrent: 320 }
  };
}

const LIVE_SESSION = {
  isLive: true, startedAt: new Date(Date.now() - 130 * 60_000).toISOString(), durationMinutes: 130,
  averageViewers: 80, peakViewers: 120, currentViewers: 87, follows: 6, subs: 2, bits: 500,
  donations: 5, messages: 1400, commands: 30
};

function usageSummary(overPace) {
  const endsAt = new Date(Date.now() + 11 * DAY).toISOString();
  return {
    planTier: 'premium',
    capabilities: { balance: true, pacing: true, dailySpend: true, categoryBreakdown: true, transactions: true },
    credits: { used: 600, limit: 1000, balance: 400, meterId: 'm', updatedAt: new Date().toISOString(), available: true },
    billingPeriod: {
      source: 'subscription', startsAt: daysAgo(19), endsAt, endExclusive: true,
      from: daysAgo(19), to: endsAt, totalDayCount: 30, elapsedDayCount: 19
    },
    pacing: overPace
      ? {
          status: 'over_pace', forecastBasis: 'current_billing_period', quotaUsedPercent: 60, averageDailyCredits: 95,
          projectedPeriodCredits: 1600, projectedQuotaUsedPercent: 160, projectedOverageCredits: 600,
          remainingPeriodDays: 11, dailyCreditsToLastPeriod: 36, expectedToExhaustWithinPeriod: true,
          estimatedDaysUntilExhaustion: 4.2, estimatedExhaustionAt: new Date(Date.now() + 4.2 * DAY).toISOString()
        }
      : {
          status: 'within_pace', forecastBasis: 'current_billing_period', quotaUsedPercent: 60, averageDailyCredits: 20,
          projectedPeriodCredits: 820, projectedQuotaUsedPercent: 82, projectedOverageCredits: 0,
          remainingPeriodDays: 11, dailyCreditsToLastPeriod: 36, expectedToExhaustWithinPeriod: false,
          estimatedDaysUntilExhaustion: null, estimatedExhaustionAt: null
        },
    analytics: null
  };
}

const SITE_EVENTS = [
 { name:'Incoming raid',type:'channel.raid',condition:{to_broadcaster_user_id:'user'} },
 { name:'Outgoing raid',type:'channel.raid.outgoing',condition:{from_broadcaster_user_id:'user'} }
].map(event=>({...event,version:'1',description:{en:'Raid fixture',es:'Raid fixture'},icon:'Users',color:'#7c3aed',textColor:'#fff',releaseStage:'stable',enabled:false,
 config:[{id:'message',type:'text',label:{en:'Optional message',es:'Mensaje opcional'},value:'',canDisable:true}]}));
function raidData(o,days=7){
 const totals=o.raidEmpty?[]:[{_id:'incoming',raids:4,viewers:106,biggest:40,followsAfter:o.raidUncounted?0:o.raidZero?0:64,evaluatedRaids:o.raidUncounted?0:4},{_id:'outgoing',raids:2,viewers:25,biggest:25,followsAfter:0,evaluatedRaids:0}];
 return {summary:o.raidPending?null:{days,from:daysAgo(days-1),to:new Date().toISOString(),totals,
 incoming:[
 {peerID:'p4',peerName:o.raidLong?'A_very_long_streamer_name_that_needs_to_wrap':'Arcadia88',peerLogin:'arcadia88',viewers:22,occurredAt:daysAgo(1),followsAfter:13,lastOutgoingAt:null},
 {peerID:'p3',peerName:'PixelPancho',peerLogin:'pixelpancho',viewers:40,occurredAt:daysAgo(2),followsAfter:24,lastOutgoingAt:null},
 {peerID:'p2',peerName:'MidnightMoth',peerLogin:'midnightmoth',viewers:26,occurredAt:daysAgo(3),followsAfter:16,lastOutgoingAt:daysAgo(4)},
 {peerID:'p1',peerName:'FriendlyRaider',peerLogin:'friendly',viewers:18,occurredAt:daysAgo(5),followsAfter:11,lastOutgoingAt:daysAgo(2)}
 ].map(row=>({...row,followsAfter:o.raidUncounted?null:o.raidZero?0:row.followsAfter})),
 outgoing:[{peerID:'p2',peerName:'DestinationStreamer',peerLogin:'destination',viewers:25,occurredAt:daysAgo(1),followsAfter:null}],
 topIncoming:[{_id:'p1',name:'FriendlyRaider',login:'friendly',count:1,viewers:18,lastAt:daysAgo(5)}],
 topOutgoing:[{_id:'p2',name:'DestinationStreamer',login:'destination',count:1,viewers:25,lastAt:daysAgo(1)}]},
 tracking:{incoming:true,outgoing:!o.trackingOff},pending:!!o.raidPending,stale:!!o.raidStale,updatedAt:new Date().toISOString()};
}

function envelope(data) {
  return { error: false, status: 200, message: 'ok', data };
}

/**
 * @param {object} o scenario: chatEnabled, live, automodOn, eventsFail, overPace, theme, language
 */
async function newPage(browser, viewport, o) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'UTC', colorScheme: o.theme });
  const state = { chatEnabled: o.chatEnabled, toggles: [], writes: [], avatarReads:[], activityRanges:[], stored:SITE_EVENTS.map((event,i)=>({_id:'raid-'+i,type:event.type,enabled:true,message:'',condition:event.type==='channel.raid'?{to_broadcaster_user_id:CHANNEL_ID}:{from_broadcaster_user_id:CHANNEL_ID}})) };
  const app = {
    name: 'Test Streamer', email: 'test@example.invalid', language: o.language ?? 'en', plan_tier: 'premium', actived: true,
    chat_enabled: o.chatEnabled, twitch_user_id: CHANNEL_ID, has_permissions: true, up_to_date_permissions: true, administrating: []
  };
  await context.addInitScript(({ twitch, app, theme, keepTopics }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
    }));
    localStorage.setItem('theme', theme);
    localStorage.setItem('dimasite.referral_promo.dismissed_at', String(Date.now()));
    // First load of each tab only, so reloads keep what the page saved.
    if (!sessionStorage.getItem('dash-check')) {
      sessionStorage.clear();
      localStorage.removeItem('dimasite.dashboard.topics');
      sessionStorage.setItem('dash-check', '1');
    }
  }, { twitch: TWITCH, app, theme: o.theme });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if(url.hostname==='static-cdn.jtvnw.net'){
      if(url.pathname.includes('/88/'))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#7c3aed"/></svg>'});
    }
    if(url.hostname==='avatars.test')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#7c3aed"/></svg>'});
    if (url.hostname !== 'api.domdimabot.com') return route.abort();

    const p = url.pathname;
    let data = {};
    if (p === '/auth/session') data = { twitch: TWITCH, app };
    else if (p.startsWith('/auth/access/')) data = { allowed: true, role: 'owner' };
    else if (p.endsWith('/activity')) {
      state.activityRanges.push(Number(url.searchParams.get('days')));
      if(o.activityFail)return route.fulfill({status:503,json:{error:true}});
      const multiplier=url.searchParams.get('days')==='30'?3:1;
      data={summary:o.activityCold?null:{days:7,commands:o.activityEmpty?[]:[{key:'hello',label:o.activityLong?'!averylongcommandname_that_has_to_wrap_on_a_phone':'!hello',count:60*multiplier},{key:'uptime',label:'!uptime',count:40*multiplier}],
       emotes:o.activityEmpty?[]:[{key:'twitch:25',label:'Kappa',count:60*multiplier},{key:'twitch:88',label:'PogChamp',count:30*multiplier}],
       commandRuns:100*multiplier,emoteUses:90*multiplier,coverageStartedAt:daysAgo(3),pending:!!o.activityPending},
       updatedAt:new Date().toISOString(),pending:!!o.activityCold,stale:!!o.activityStale};
    }
    else if (p.endsWith('/raids')) { if(o.raidFail)return route.fulfill({status:503,json:{error:true}}); data=raidData(o,Number(url.searchParams.get('days')||7)); }
    else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(p)) data = bootstrapData({ chatEnabled: state.chatEnabled });
    else if (/^\/dashboard\/[^/]+\/access$/.test(p)) data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'Test Streamer', planTier: 'premium' };
    else if (/^\/dashboard\/[^/]+\/live-status$/.test(p)) {
      data = o.live
        ? {
            isLive: true, checkedAt: new Date().toISOString(), liveSession: LIVE_SESSION,
            stream: { id: 's', user_id: CHANNEL_ID, user_login: 'test', user_name: 'Test Streamer', game_name: 'Celeste', title: 'Speedrun night',
              viewer_count: 87, started_at: LIVE_SESSION.startedAt, language: 'en', thumbnail_url: '', is_mature: false }
          }
        : { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    } else if (p === '/billing/ai-credits') data = { used: 600, limit: 1000, balance: 400, meterId: 'm', updatedAt: new Date().toISOString(), available: true };
    else if (p === '/billing/ai-usage/summary') data = usageSummary(o.overPace);
    else if (/^\/moderation\/[^/]+\/logs$/.test(p)) data = { logs: LOGS, total: LOGS.length, limit: 100, skip: 0 };
    else if (/^\/moderation\/[^/]+\/settings$/.test(p)) data = { channelID: CHANNEL_ID, channel: 'test', enabled: o.automodOn, offenseWindowSeconds: 600, rules: [], settingsVersion: 1 };
    else if (p === '/site/events') {
      if (o.eventsFail) return route.fulfill({ status: 500, json: { error: true, message: 'boom' } });
      data = SITE_EVENTS;
    } else if (p.startsWith('/eventsubs/')) {
      if(req.method()==='PATCH') { const payload=req.postDataJSON();const row=state.stored.find(row=>p.endsWith('/'+row._id));Object.assign(row,payload);state.writes.push({method:'PATCH',id:row._id,payload});data=row; }
      else if(req.method()==='DELETE') { const row=state.stored.find(row=>p.endsWith('/'+row._id));state.writes.push({method:'DELETE',id:row._id});state.stored=state.stored.filter(item=>item!==row);data={}; }
      else if(req.method()==='POST') { const body=req.postDataJSON();const row={_id:'new-out',type:body.type,enabled:true,message:body.config?.message||'',condition:body.condition};state.writes.push({method:'POST',payload:body});state.stored.push(row);data=row; }
      else data=state.stored;
    } else if (p.startsWith('/users/chat/') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      state.chatEnabled = !!body.enabled;
      state.toggles.push(body.enabled);
      data = { chatEnabled: state.chatEnabled };
    } else if (p.startsWith('/goals/')) {
      data = { plan: 'premium', limit: 3, metrics: ['follows'], revision: 1, goals: [], canManage: true };
    } else if (p === '/users') {
      const login=url.searchParams.get('username');
      state.avatarReads.push(login);
      if(login==='midnightmoth')return route.fulfill({status:404,json:{error:true}});
      data = { id: CHANNEL_ID, username: login||'test', profile_image_url:login==='friendly'?'https://avatars.test/friendly.svg':'' };
    }
    return route.fulfill({ status: 200, json: envelope(data) });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/test/dashboard`);
  await page.waitForSelector('.gh__title', { timeout: 20000 });
  return { context, page, errors, state };
}

async function until(fn, message, timeout = 5000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${message} (last: ${JSON.stringify(last)})`);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const visible = (page, sel) => page.locator(sel).first().isVisible();

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: page overflows horizontally by ${overflow}px`);
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).include('app-dashboard').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(
    bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`),
    [],
    `${label}: axe violations`
  );
}

async function primaryButtonsPainted(page, label) {
  const transparent = await page.evaluate(() =>
    [...document.querySelectorAll('app-dashboard .btn--primary, app-dashboard .bs__buy--primary, app-dashboard .hc__btn--primary')]
      .filter((el) => el.getClientRects().length)
      .filter((el) => ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(el).backgroundColor))
      .map((el) => el.textContent.trim())
  );
  assert.deepEqual(transparent, [], `${label}: primary buttons without a background`);
}

const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 for(const theme of ['dark','light'])for(const width of [320,390,1280]){
  const {context,page,errors,state}=await newPage(browser,{width,height:1000},{chatEnabled:true,automodOn:true,theme});
  if(width<960)await page.getByRole('button',{name:'Your bot',exact:true}).click();
  const commands=page.locator('[data-testid=dashboard-commands]'),emotes=page.locator('[data-testid=dashboard-emotes]');
  assert.equal(await page.locator('#dash-bot app-dashboard-usage-card').count(),2);
  assert.equal(await page.locator('#dash-channel app-dashboard-usage-card').count(),0);
  await commands.getByText('100 recorded command runs.',{exact:true}).waitFor();
  await emotes.getByText('Native Twitch emotes used 90 times.',{exact:true}).waitFor();
  await commands.getByText('!hello',{exact:true}).waitFor();await emotes.getByText('Kappa',{exact:true}).waitFor();
  assert.equal(await commands.locator('.usage-list li').count(),2);
  await commands.getByLabel('Command period').selectOption('30');await commands.getByText('300 recorded command runs.',{exact:true}).waitFor();
  assert.equal(await emotes.getByLabel('Emote period').inputValue(),'7');
  await emotes.getByText('Native Twitch emotes used 90 times.',{exact:true}).waitFor();
  await emotes.getByLabel('Emote period').selectOption('30');await emotes.getByText('Native Twitch emotes used 270 times.',{exact:true}).waitFor();
  assert.ok(state.activityRanges.includes(7)&&state.activityRanges.includes(30));
  await emotes.getByText('PogChamp',{exact:true}).waitFor();
  await page.waitForTimeout(150);assert.equal(await emotes.locator('.usage-emote img').count(),1,'broken emote keeps its label and fallback');
  await noOverflow(page,`${theme}-${width}`);
  const result=await new AxeBuilder({page}).include('app-dashboard-usage-card').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations,[]);
  assert.deepEqual(errors,[]);
  for(const [kind,card] of [['commands',commands],['emotes',emotes]]){
   const box=await card.boundingBox();await page.setViewportSize({width,height:Math.max(1000,Math.ceil(box.height)+250)});await card.scrollIntoViewIfNeeded();await page.evaluate(()=>window.scrollBy(0,-120));
   await card.screenshot({path:`${shots}/${kind}-${theme}-${width}.png`});
  }
  await context.close();
 }
 for(const scenario of [{activityEmpty:true},{activityCold:true},{activityPending:true},{activityStale:true},{activityFail:true},{activityLong:true}]){
  const {context,page}=await newPage(browser,{width:390,height:1000},{chatEnabled:true,automodOn:true,theme:'dark',...scenario});
  await page.getByRole('button',{name:'Your bot',exact:true}).click();
  const commands=page.locator('[data-testid=dashboard-commands]');
  if(scenario.activityEmpty)await commands.getByText('No command runs recorded in this period.').waitFor();
  if(scenario.activityCold||scenario.activityPending)await commands.getByText(/Preparing recorded activity/).waitFor();
  if(scenario.activityStale)await commands.getByText(/Showing the last saved summary/).waitFor();
  if(scenario.activityFail)await commands.getByRole('button',{name:'Retry',exact:true}).waitFor();
  if(scenario.activityLong){await commands.getByText('!averylongcommandname_that_has_to_wrap_on_a_phone',{exact:true}).waitFor();await noOverflow(page,'long command label');}
  await context.close();
 }
 const {context,page}=await newPage(browser,{width:390,height:1000},{chatEnabled:true,automodOn:true,theme:'dark',language:'es'});
 await page.getByRole('button',{name:'Tu bot',exact:true}).click();
 await page.locator('[data-testid=dashboard-commands]').getByText('100 ejecuciones de comandos registradas.').waitFor();
 await page.locator('[data-testid=dashboard-emotes]').getByText('Emotes nativos de Twitch usados 90 veces.').waitFor();await context.close();
 console.log('PASS DASHBOARD ACTIVITY SITE: bot-section cards, independent 7/30-day ranges, native emote images/fallbacks, ranked commands, loading/pending/empty/stale/error, Spanish, 320/390/1280 dark/light accessibility and overflow');
}finally{await browser.close();}
