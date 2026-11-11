// Site agent panel (dimasite assistant): chat, live turn events, steer/queue/stop/retry, approvals, UI blocks,
// navigation, Changes tab with undo, chat list, daily limit. Desktop 1280 (side panel) and phone 375 (bottom
// sheet + peek bar), dark and light, English and Spanish; axe on the panel; no horizontal overflow.
//
// Every API call is mocked with Playwright routes; the turn event stream (fetch + SSE) is replaced in the page by a
// fake whose frames this script pushes one by one, so each streaming state can be checked. Nothing leaves the
// browser. SAAS_PREVIEW_URL = served dimasite bundle; SAAS_BROWSER_TOOLS = Playwright + @axe-core/playwright;
// SAAS_SCREENSHOT_DIR (optional). SITE_AGENT_UI_FRAME=stub when the bundle stubs the sandboxed UI frame.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
if (shots) mkdirSync(shots, { recursive: true });
const UI_FRAME = process.env.SITE_AGENT_UI_FRAME === 'stub' ? 'stub' : 'real';

const CHANNEL_ID = '424242';
const LOGIN = 'dimatest';
const TWITCH = { id: CHANNEL_ID, login: LOGIN, display_name: 'DimaTest', profile_image_url: '' };
const AGENT = `/agent/${CHANNEL_ID}`;
const MIN = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 8000) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label}${last ? ` (${last.message})` : ''}`);
    await sleep(80);
  }
}
const envelope = (data, status = 200) => ({ error: false, status, message: 'ok', data });
const nextUtcMidnight = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

// ---------------------------------------------------------------------------
// In-page fake for the turn event stream (fetch → ReadableStream we feed)
// ---------------------------------------------------------------------------

function sseFake() {
  if (window.top !== window) return;
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  const state = { requests: [], open: {}, backlog: {} };
  window.__sse = {
    requests: state.requests,
    send(turnId, text) {
      const live = (state.open[turnId] || []).filter((entry) => !entry.closed);
      const entry = live[live.length - 1];
      if (!entry) {
        (state.backlog[turnId] ||= []).push(text);
        return false;
      }
      entry.controller.enqueue(encoder.encode(text));
      return true;
    },
    close(turnId) {
      for (const entry of state.open[turnId] || []) {
        if (entry.closed) continue;
        entry.closed = true;
        try { entry.controller.close(); } catch { /* already closed */ }
      }
    },
    openCount(turnId) {
      return (state.open[turnId] || []).filter((entry) => !entry.closed).length;
    },
  };
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /\/agent\/[^/]+\/turns\/([^/?]+)\/events(?:\?after=([^&]+))?/.exec(url);
    if (!match) return realFetch(input, init);
    const turnId = decodeURIComponent(match[1]);
    const headers = new Headers(init?.headers || {});
    state.requests.push({ turnId, after: match[2] ? decodeURIComponent(match[2]) : null, auth: headers.get('authorization'), accept: headers.get('accept') });
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const entry = { controller, closed: false };
    (state.open[turnId] ||= []).push(entry);
    init?.signal?.addEventListener('abort', () => {
      if (entry.closed) return;
      entry.closed = true;
      try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ }
    });
    for (const chunk of state.backlog[turnId] || []) controller.enqueue(encoder.encode(chunk));
    delete state.backlog[turnId];
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  };
}

// ---------------------------------------------------------------------------
// Fake agent API (node side keeps the "server" transcript so snapshots match the stream)
// ---------------------------------------------------------------------------

function createAgent(o = {}) {
  const now = Date.now();
  const agent = {
    status: {
      enabled: o.enabled ?? true,
      role: o.role ?? 'owner',
      limits: { plan: o.plan ?? 'free', used: o.used ?? 3, limit: 20, resetsAt: nextUtcMidnight() },
      contextLimit: 100_000,
    },
    sessions: new Map(),
    posts: [],
    gets: [],
    deletes: [],
    seq: 0,
    turnCount: 0,
    failSend: null,
    nextLimits: null,
    changes: [
      {
        id: 'c1', actor: { id: CHANNEL_ID, login: LOGIN, displayName: 'DimaTest', role: 'owner' }, request: 'Make a dice command',
        title: 'Create command !dice', area: 'commands', target: { type: 'command', id: 'cmd-1', label: '!dice' },
        before: null, after: { name: 'dice', response: '$(user) rolled $(random 1 20)', cooldown: 10 }, effects: ['Posts a chat message'],
        at: now - 5 * MIN, undone: null, canUndo: true,
      },
      {
        id: 'c2', actor: { id: '777777', login: 'helper', displayName: 'Helper', role: 'admin' }, request: 'Slow down the discord timer',
        title: 'Change timer !discord', area: 'timers', target: { type: 'timer', id: 'tm-1', label: '!discord' },
        before: { interval: 10, enabled: true }, after: { interval: 20, enabled: true }, effects: [], at: now - 60 * MIN, undone: null, canUndo: true,
      },
      {
        id: 'c3', actor: { id: CHANNEL_ID, login: LOGIN, displayName: 'DimaTest', role: 'owner' }, request: 'Turn on TTS',
        title: 'Turn on Text to speech', area: 'tts', target: { type: 'settings', id: null, label: 'TTS' },
        before: { enabled: false }, after: { enabled: true }, effects: [], at: now - 26 * 60 * MIN,
        undone: { at: now - 25 * 60 * MIN, by: { id: CHANNEL_ID, login: LOGIN } }, canUndo: false,
      },
    ],
  };
  const meta = (id, title, updatedAt) => ({ id, channelId: CHANNEL_ID, userId: CHANNEL_ID, title, createdAt: updatedAt - 10 * MIN, updatedAt, activeTurnId: null, contextTokens: 1200, contextLimit: 100_000 });
  agent.sessions.set('s-old', { session: meta('s-old', 'Old chat about timers', now - 2 * 60 * MIN), items: o.oldItems ?? [], activeTurn: null });
  agent.meta = meta;
  return agent;
}

function applyServer(agent, sessionId, event) {
  const snap = agent.sessions.get(sessionId);
  if (!snap) return;
  snap.session.updatedAt = Date.now();
  if (event.type === 'item' || event.type === 'update') {
    const index = snap.items.findIndex((item) => item.id === event.item.id);
    if (index === -1) snap.items.push(event.item);
    else snap.items[index] = event.item;
  } else if (event.type === 'text') {
    const item = snap.items.find((entry) => entry.id === event.itemId);
    if (item) item.text += event.delta;
  } else if (event.type === 'turn') {
    snap.activeTurn = { turnId: event.turnId, sessionId, status: event.status, inputRevision: event.inputRevision, cursor: String(agent.seq) };
    snap.session.activeTurnId = event.turnId;
  } else if (event.type === 'done') {
    const queued = agent.queued?.shift();
    snap.activeTurn = queued ? { turnId: queued, sessionId, status: 'queued', inputRevision: 0, cursor: '' } : null;
    snap.session.activeTurnId = queued ?? null;
  } else if (event.type === 'limits') {
    agent.status.limits = event.limits;
  }
}

async function emit(page, agent, sessionId, turnId, event) {
  applyServer(agent, sessionId, event);
  const id = `${++agent.seq}-0`;
  const frame = `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  await page.evaluate(([turn, text]) => window.__sse.send(turn, text), [turnId, frame]);
  await sleep(30);
  return id;
}

async function installRoutes(context, agent, o) {
  const app = {
    name: 'DimaTest', email: 'dimatest@example.invalid', language: o.language ?? 'en', plan_tier: 'free', actived: true, chat_enabled: true,
    twitch_user_id: CHANNEL_ID, has_permissions: true, up_to_date_permissions: true, administrating: [],
  };
  await context.addInitScript(({ twitch, app, theme, remember }) => {
    if (window.top !== window) return; // not inside the sandboxed UI frames
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {},
    }));
    localStorage.setItem('theme', theme);
    localStorage.setItem('dimasite.referral_promo.dismissed_at', String(Date.now()));
    localStorage.setItem('dimasite.assistant.mascotSeen', '1');
    if (remember) sessionStorage.setItem(`dimasite.assistant.session.v1:${twitch.id}:${twitch.id}`, remember);
  }, { twitch: TWITCH, app, theme: o.theme ?? 'dark', remember: o.remember ?? null });
  await context.addInitScript(sseFake);
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__clickLog = [];
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, a, summary, textarea') : null;
      window.__clickLog.push(`${Math.round(performance.now())} ${target ? target.outerHTML.replace(/_ngcontent-[^=]+=""/g, '').slice(0, 90) : event.target?.nodeName}`);
    }, true);
  });
  await context.routeWebSocket(/.*/, (ws) => ws.close());

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const p = url.pathname;
    const method = req.method();
    const body = (() => { try { return JSON.parse(req.postData() || 'null'); } catch { return null; } })();

    if (p.startsWith(AGENT)) return agentRoute(route, agent, method, p.slice(AGENT.length), body, url);
    if (p.startsWith('/agent/')) return route.fulfill({ status: 403, json: { error: true, status: 403, message: 'forbidden' } });

    let data = {};
    if (p === '/auth/session') data = { twitch: TWITCH, app };
    else if (p.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', permissions: {} };
    else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(p)) {
      data = {
        role: 'owner', channel: { id: CHANNEL_ID, name: 'DimaTest', chatEnabled: true }, isLive: false, liveStream: null, liveSession: null,
        kpis: { activeViewers: 0, averageViewers: 0, monthlyAverageViewers: 0, averageHoursPerStream: 0, totalBits: 0, totalStreams: 0, totalDonations: 0, activeFollows: 0, activeSubs: 0, monthlyGoalSubs: 0, subsProgressPct: 0 },
        trend: [], streamHistory: [], totalFollowers: 0, totalSubs: 0,
        monthlyGoals: { followersGoal: 1000, followersCurrent: 0, subsGoal: 1000, subsCurrent: 0 },
      };
    } else if (/^\/dashboard\/[^/]+\/access$/.test(p)) data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'DimaTest', planTier: 'free' };
    else if (/^\/dashboard\/[^/]+\/live-status$/.test(p)) data = { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    else if (p.endsWith('/activity')) data = { summary: { commands: [], emotes: [], commandRuns: 0, emoteUses: 0, pending: false, coverageStartedAt: null }, pending: false, stale: false, updatedAt: new Date().toISOString() };
    else if (p === '/billing/ai-credits') data = { used: 0, limit: 100, balance: 100, meterId: 'm', updatedAt: new Date().toISOString(), available: true };
    else if (/^\/moderation\/[^/]+\/logs$/.test(p)) data = { logs: [], total: 0, limit: 100, skip: 0 };
    else if (/^\/moderation\/[^/]+\/settings$/.test(p)) data = { channelID: CHANNEL_ID, channel: LOGIN, enabled: true, offenseWindowSeconds: 600, rules: [], settingsVersion: 1 };
    else if (p === '/site/events' || p.startsWith('/eventsubs/') || p.startsWith('/timers/')) data = [];
    else if (p.startsWith('/goals/')) data = { plan: 'free', limit: 1, metrics: ['follows'], revision: 1, goals: [], canManage: true };
    else if (p === '/users') data = { id: CHANNEL_ID, username: LOGIN, profile_image_url: '' };
    else if (p === `/users/${CHANNEL_ID}`) return route.fulfill({ status: 200, json: { error: false, streamer: { id: CHANNEL_ID, name: LOGIN, actived: 'true', chat_enabled: 'true' } } });
    else if (p === '/config/commands/reserved') data = { commands: [] };
    else if (p.startsWith(`/commands/${CHANNEL_ID}`) && method === 'GET') {
      return route.fulfill({ status: 200, json: { error: false, status: 200, message: 'ok', commands: [], total: 0, fullAccess: true } });
    }
    if (method !== 'GET') agent.otherWrites = [...(agent.otherWrites ?? []), `${method} ${p}`];
    return route.fulfill({ status: 200, json: envelope(data) });
  });
}

/** The real runner stores decisions on the item too; snapshots must agree. */
function setServerItem(agent, match, patch) {
  for (const snap of agent.sessions.values()) {
    for (const entry of snap.items) if (match(entry)) Object.assign(entry, patch);
  }
}

function agentRoute(route, agent, method, path, body, url) {
  const ok = (data, status = 200) => route.fulfill({ status, json: envelope(data, status) });
  const fail = (status, code, message = code, data = null) => route.fulfill({ status, json: { error: true, status, code, message, data } });
  if (method === 'GET') agent.gets.push(path + url.search);
  else if (method === 'DELETE') agent.deletes.push(path);
  else agent.posts.push({ method, path, body });

  if (path === '/status') return ok(agent.status);
  if (path === '/sessions' && method === 'GET') {
    return ok({ sessions: [...agent.sessions.values()].map((snap) => snap.session).sort((a, b) => b.updatedAt - a.updatedAt) });
  }
  let match = /^\/sessions\/([^/]+)$/.exec(path);
  if (match) {
    const snap = agent.sessions.get(match[1]);
    if (!snap) return fail(404, 'not_found');
    if (method === 'DELETE') {
      agent.sessions.delete(match[1]);
      return ok({ deleted: true });
    }
    return ok(JSON.parse(JSON.stringify(snap)));
  }
  if (path === '/messages' && method === 'POST') {
    if (agent.failSend) {
      const { status, code } = agent.failSend;
      return fail(status, code);
    }
    let sessionId = body.sessionId;
    if (!sessionId) {
      sessionId = 's-new';
      agent.sessions.set(sessionId, { session: agent.meta(sessionId, body.text.slice(0, 40), Date.now()), items: [], activeTurn: null });
    }
    const snap = agent.sessions.get(sessionId);
    const active = snap.activeTurn?.turnId;
    let turnId = active;
    if (body.mode === 'send') turnId = agent.forceTurnId ?? `t${++agent.turnCount}`;
    if (body.mode === 'queue') {
      turnId = `q${++agent.turnCount}`;
      agent.queued = [...(agent.queued ?? []), turnId];
    }
    if (body.mode === 'send') snap.activeTurn = { turnId, sessionId, status: 'queued', inputRevision: 0, cursor: '' };
    agent.lastTurnId = turnId;
    agent.status.limits = agent.nextLimits ?? { ...agent.status.limits, used: agent.status.limits.used + 1 };
    agent.nextLimits = null;
    return ok({ sessionId, turnId, limits: agent.status.limits }, 202);
  }
  match = /^\/turns\/([^/]+)\/(stop|retry|feedback)$/.exec(path);
  if (match) {
    if (match[2] === 'stop') return ok({ status: 'cancelled' });
    if (match[2] === 'retry') return ok({ turnId: `${match[1]}-retry` }, 202);
    return ok({ recorded: true });
  }
  match = /^\/turns\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
  if (match) {
    const state = body.decision === 'apply' ? 'applied' : 'skipped';
    setServerItem(agent, (entry) => entry.kind === 'approval' && entry.callId === match[2], { state });
    return ok({ state });
  }
  match = /^\/turns\/([^/]+)\/ui\/([^/]+)$/.exec(path);
  if (match) {
    setServerItem(agent, (entry) => entry.kind === 'ui' && entry.callId === match[2], { state: 'submitted' });
    return ok({ state: 'submitted' });
  }
  match = /^\/turns\/([^/]+)$/.exec(path);
  if (match) {
    for (const snap of agent.sessions.values()) {
      if (snap.activeTurn?.turnId === match[1]) return ok(snap.activeTurn);
    }
    return ok({ turnId: match[1], sessionId: 's-new', status: 'completed', inputRevision: 1, cursor: String(agent.seq) });
  }
  if (path === '/changes') return ok({ changes: agent.changes, next: null });
  match = /^\/changes\/([^/]+)\/undo$/.exec(path);
  if (match) {
    const change = agent.changes.find((entry) => entry.id === match[1]);
    if (!change) return fail(404, 'not_found');
    if (change.id === 'c2') return fail(409, 'undo_conflict', 'Changed since', { code: 'undo_conflict', current: { interval: 30, enabled: true } });
    Object.assign(change, { undone: { at: Date.now(), by: { id: CHANNEL_ID, login: LOGIN } }, canUndo: false });
    return ok({ change });
  }
  return fail(404, 'not_found');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentPage = null;

async function openPage(browser, o) {
  const viewport = o.viewport ?? { width: 1280, height: 860 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'UTC', locale: o.language === 'es' ? 'es-MX' : 'en-US', colorScheme: o.theme ?? 'dark' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const agent = createAgent(o);
  await installRoutes(context, agent, o);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  currentPage = page;
  await page.goto(`${base}${o.path ?? `/${LOGIN}/dashboard`}`);
  await page.locator('app-assistant-mascot button.am-trigger').waitFor({ state: 'visible', timeout: 20000 });
  return { context, page, agent, errors };
}

async function openPanel(page) {
  await page.locator('app-assistant-mascot button.am-trigger').click();
  await until(() => page.locator('[data-assistant-panel]').isVisible(), 'panel visible');
  await sleep(250);
}

async function shot(page, name) {
  if (!shots) return;
  const path = `${shots}/${name}.png`;
  await page.screenshot({ path });
  console.log(`  screenshot ${path}`);
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).include('[data-assistant-panel]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  for (const violation of bad) console.log(`  axe ${label}: ${violation.id} ${violation.help}`, violation.nodes.slice(0, 3).map((node) => node.target.join(' ')));
  assert.equal(bad.length, 0, `axe serious/critical violations (${label})`);
  console.log(`  axe ${label}: ok (${result.violations.length} minor)`);
}

async function noOverflow(page, label) {
  const result = await page.evaluate(() => {
    const panel = document.querySelector('[data-assistant-panel]');
    const wide = [];
    if (panel) {
      for (const element of panel.querySelectorAll('*')) {
        const rect = element.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        if (rect.width && (rect.right > box.right + 1 || rect.left < box.left - 1) && !element.closest('pre, .am-table, .ad-block')) wide.push(element.className || element.tagName);
      }
    }
    return { page: document.documentElement.scrollWidth - window.innerWidth, wide: wide.slice(0, 5) };
  });
  assert.ok(result.page <= 1, `page overflows horizontally by ${result.page}px (${label})`);
  assert.equal(result.wide.length, 0, `panel children overflow (${label}): ${result.wide.join(', ')}`);
}

const mood = (page) => page.locator('app-assistant-mascot .am-dock').getAttribute('data-am-state');
const lastPost = (agent, suffix) => [...agent.posts].reverse().find((post) => post.path.endsWith(suffix));
const sseRequests = (page) => page.evaluate(() => window.__sse.requests.slice());
const text = (locator) => locator.innerText();

const at = Date.now();
const item = {
  user: (id, turnId, textValue, mode = 'send') => ({ kind: 'user', id, turnId, text: textValue, mode, at }),
  assistant: (id, turnId, textValue = '', final = false) => ({ kind: 'assistant', id, turnId, text: textValue, at, final }),
  tool: (id, turnId, name, label, state, summary) => ({ kind: 'tool', id, turnId, callId: `call-${id}`, name, label, state, ...(summary ? { summary } : {}), at }),
};

const FINAL_MD = [
  '## Your new command',
  '',
  'I made **!dice**. Viewers type `!dice` and get a number from *1 to 20*.',
  '',
  '- Cooldown: 10 s',
  '- Everyone can use it',
  '',
  '```text',
  '$(user) rolled $(random 1 20)',
  '```',
  '',
  '| Setting | Value |',
  '|---|---|',
  '| Cooldown | 10 s |',
  '',
  'More in the [commands guide](https://docs.domdimabot.com/guides/commands/) and [functions](/reference/functions/). Bad [link](javascript:alert(1)) <script>alert(1)</script>',
].join('\n');

// ---------------------------------------------------------------------------
// 1. Desktop 1280, dark: the full conversation flow
// ---------------------------------------------------------------------------

async function desktopFlow(browser) {
  console.log('desktop 1280 dark: conversation flow');
  const { context, page, agent, errors } = await openPage(browser, { theme: 'dark' });
  await openPanel(page);
  const panel = page.locator('[data-assistant-panel]');

  // Side panel under the navbar; the page beside it stays usable.
  const box = await panel.boundingBox();
  assert.ok(box && Math.abs(box.x + box.width - 1280) <= 1 && box.width >= 400 && box.width <= 430, `side panel at the right edge (${JSON.stringify(box)})`);
  const navBottom = await page.evaluate(() => document.querySelector('.auth-navbar')?.getBoundingClientRect().bottom ?? 0);
  assert.ok(Math.abs(box.y - navBottom) <= 2, `panel starts under the navbar (${box.y} vs ${navBottom})`);
  const pageUsable = await page.evaluate(() => !document.elementFromPoint(200, 400)?.closest('[data-assistant-panel], .ap-backdrop'));
  assert.ok(pageUsable, 'page beside the panel takes clicks');
  await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'assistant-input', 'composer focused on desktop');

  // Empty state + messages left.
  await until(() => page.locator('[data-assistant-empty]').isVisible(), 'empty state');
  assert.equal(await page.locator('.at-example').count(), 4, 'four example prompts');
  assert.match(await text(page.locator('[data-assistant-left]')), /17 of 20 messages left today · resets/);
  await noOverflow(page, 'desktop empty');
  await shot(page, 'desktop-dark-empty');

  // Send → POST /messages → stream from the start with the Bearer token.
  await page.evaluate(() => { window.__noReload = 42; });
  await page.locator('#assistant-input').fill('Make a dice command');
  await page.locator('#assistant-input').press('Enter');
  const send = await until(() => lastPost(agent, '/messages'), 'POST /messages');
  assert.equal(send.body.text, 'Make a dice command');
  assert.equal(send.body.mode, 'send');
  assert.equal(send.body.sessionId, undefined, 'new chat has no sessionId');
  assert.ok(send.body.clientRequestId && send.body.clientRequestId.length >= 16, 'clientRequestId');
  assert.deepEqual({ route: send.body.page.route, path: send.body.page.path }, { route: 'dashboard', path: `/${LOGIN}/dashboard` });
  assert.ok(typeof send.body.page.title === 'string', 'page title sent');
  assert.equal(await page.locator('#assistant-input').inputValue(), '', 'composer cleared');
  await until(() => page.locator('.at-user--pending').isVisible(), 'pending bubble');
  const [first] = await until(async () => { const list = await sseRequests(page); return list.length ? list : null; }, 'event stream opened');
  assert.deepEqual(first, { turnId: 't1', after: null, auth: 'Bearer test-only', accept: 'text/event-stream' });

  const S = 's-new';
  const T = 't1';
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'running', inputRevision: 1 });
  await emit(page, agent, S, T, { type: 'item', item: item.user('u1', T, 'Make a dice command') });
  await until(async () => (await page.locator('.at-user--pending').count()) === 0, 'pending bubble replaced by the real one');
  assert.equal(await page.locator('[data-kind="user"] .at-bubble').count(), 1);
  await emit(page, agent, S, T, { type: 'status', phase: 'thinking' });
  await until(async () => (await text(page.locator('[data-assistant-status]'))) === 'Thinking…', 'status line Thinking…');
  await until(async () => (await mood(page)) === 'thinking', 'mascot thinking');
  assert.equal(await page.locator('[data-assistant-status]').getAttribute('aria-live'), 'polite');
  assert.match(await text(page.locator('[data-assistant-send]')), /Steer/, 'primary button is Steer while running');
  assert.ok(await page.locator('[data-assistant-stop]').isVisible(), 'Stop visible while running');

  // Tool rows grouped.
  await emit(page, agent, S, T, { type: 'status', phase: 'tool', label: 'Searching the docs…' });
  await emit(page, agent, S, T, { type: 'item', item: item.tool('k1', T, 'search_docs', 'Searching the docs…', 'running') });
  await until(async () => /Searching the docs/.test(await text(page.locator('app-assistant-tool-group').first())), 'running tool row');
  await until(async () => (await mood(page)) === 'reading', 'mascot reading during a docs tool');
  await emit(page, agent, S, T, { type: 'update', item: item.tool('k1', T, 'search_docs', 'Searched the docs', 'done', '3 results') });
  await emit(page, agent, S, T, { type: 'item', item: item.tool('k2', T, 'read_docs', 'Read “Commands”', 'done') });
  await emit(page, agent, S, T, { type: 'item', item: item.tool('k3', T, 'read_docs', 'Read “Functions”', 'done') });
  await until(async () => /Checked 2 docs pages/.test(await text(page.locator('app-assistant-tool-group').first())), 'grouped tool summary');
  assert.equal(await page.locator('app-assistant-tool-group').count(), 1, 'one row for consecutive tools');
  await page.locator('app-assistant-tool-group summary').first().click();
  await until(async () => (await page.locator('.tg-row').count()) === 3, 'expanded tool rows');
  assert.match(await text(page.locator('.tg-row').first()), /3 results/);

  // Streaming text, then it becomes a muted progress note once more work follows.
  await emit(page, agent, S, T, { type: 'item', item: item.assistant('a1', T) });
  await emit(page, agent, S, T, { type: 'text', itemId: 'a1', delta: 'Let me check the ', offset: 0 });
  await until(async () => (await page.locator('[data-assistant-status]').innerText()) === '', 'status line hides while text streams');
  await emit(page, agent, S, T, { type: 'text', itemId: 'a1', delta: '**random** function.', offset: 17 });
  await until(async () => (await mood(page)) === 'speaking', 'mascot speaking while text streams');
  await until(async () => (await page.locator('[data-kind="answer"] strong').innerText().catch(() => '')) === 'random', 'streamed markdown');
  // A delta replayed after a reconnect (same offset) is not applied twice.
  await page.evaluate(([turn, text]) => window.__sse.send(turn, text), [T, `id: ${++agent.seq}-0\nevent: text\ndata: ${JSON.stringify({ type: 'text', itemId: 'a1', delta: '**random** function.', offset: 17 })}\n\n`]);
  await sleep(150);
  assert.equal(await page.locator('[data-kind="answer"] strong').count(), 1, 'replayed text is not duplicated');
  await emit(page, agent, S, T, { type: 'item', item: item.tool('k4', T, 'search_ast_functions', 'Looking up functions…', 'running') });
  await until(async () => /Let me check the random function/.test(await text(page.locator('[data-kind="note"]').first())), 'progress note muted');
  await emit(page, agent, S, T, { type: 'update', item: item.tool('k4', T, 'search_ast_functions', 'Looked up functions', 'done') });

  // Steer while running.
  await page.locator('#assistant-input').fill('Use 1 to 20 instead');
  await page.locator('[data-assistant-send]').click();
  const steer = await until(() => agent.posts.filter((post) => post.path === '/messages')[1], 'POST steer');
  assert.equal(steer.body.mode, 'steer');
  assert.equal(steer.body.sessionId, S);
  await until(async () => /next step/.test(await text(page.locator('.at-user--pending'))), 'steer pending note');
  await emit(page, agent, S, T, { type: 'item', item: item.user('u2', T, 'Use 1 to 20 instead', 'steer') });
  await until(async () => /Added while it worked/.test(await text(page.locator('[data-kind="user"]').nth(1))), 'steer bubble tag');

  // Queue for after.
  await page.locator('#assistant-input').fill('Also add a 10 s cooldown');
  await page.locator('[data-assistant-queue]').click();
  await until(async () => (await page.locator('[data-assistant-queue]').getAttribute('aria-pressed')) === 'true', 'queue toggle on');
  assert.match(await text(page.locator('[data-assistant-send]')), /Queue/);
  await page.waitForTimeout(1100); // the send button's 1 s click guard
  await page.locator('[data-assistant-send]').click();
  const queue = await until(() => agent.posts.filter((post) => post.path === '/messages')[2], 'POST queue');
  assert.equal(queue.body.mode, 'queue');
  const Q = agent.queued[0];
  await until(async () => /Queued/.test(await text(page.locator('.at-user--pending'))), 'queued pending note');

  // Approval card: Apply.
  await emit(page, agent, S, T, {
    type: 'item',
    item: {
      kind: 'approval', id: 'ap1', turnId: T, callId: 'call-ap1', state: 'pending', expiresAt: Date.now() + 15 * MIN, at,
      proposal: {
        tool: 'create_command', title: 'Create command !dice', area: 'commands', target: { type: 'command', id: null, label: '!dice' },
        before: null, after: { name: 'dice', response: '$(user) rolled $(random 1 20)', cooldown: 10, enabled: true },
        effects: ['Posts a message in chat'], warnings: ['Viewers can use it right away'],
      },
    },
  });
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'awaiting_approval', inputRevision: 2 });
  const card = page.locator('[data-assistant-approval]');
  await until(() => card.isVisible(), 'approval card');
  const cardText = await text(card);
  assert.match(cardText, /Create command !dice/);
  assert.match(cardText, /What this can do on stream/);
  assert.match(cardText, /Viewers can use it right away/);
  assert.match(cardText, /1[45]:\d\d/, 'expiry countdown');
  assert.equal(await card.locator('pre').first().innerText(), '$(user) rolled $(random 1 20)', 'command body in monospace');
  await until(async () => (await text(page.locator('[data-assistant-status]'))) === 'Waiting for you', 'status waiting');
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'desktop-dark-approval');
  await axe(page, 'desktop dark approval');
  await card.locator('[data-assistant-apply]').click();
  const decision = await until(() => lastPost(agent, '/approvals/call-ap1'), 'POST approval');
  assert.equal(decision.path, `/turns/${T}/approvals/call-ap1`);
  assert.equal(decision.body.decision, 'apply');
  await until(async () => /Applied/.test(await text(card)), 'card applied');
  assert.equal(await card.locator('[data-assistant-apply]').count(), 0, 'no buttons after applying');
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'running', inputRevision: 2 });

  // UI block → submitted values.
  await emit(page, agent, S, T, {
    type: 'item',
    item: {
      kind: 'ui', id: 'ui1', turnId: T, callId: 'call-ui1', state: 'open', at,
      block: {
        title: 'Pick a range', waitForInput: true, height: 120,
        html: '<button id="pick" type="button">1 to 20</button>',
        js: "document.getElementById('pick').addEventListener('click', () => dima.submit({ range: '1-20' }));",
      },
    },
  });
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'awaiting_input', inputRevision: 2 });
  await until(() => page.locator('[data-assistant-ui] app-assistant-ui-frame').isVisible(), 'UI block');
  if (UI_FRAME === 'stub') {
    await page.locator('[data-stub-submit]').click();
  } else {
    // The sandboxed card may sit inside a relay frame: find the frame that holds the block's button.
    const pick = await until(async () => {
      for (const frame of page.frames()) {
        if (await frame.locator('#pick').count().catch(() => 0)) return frame.locator('#pick');
      }
      return null;
    }, 'UI block button inside the sandboxed frame', 10000);
    await pick.click();
  }
  const ui = await until(() => lastPost(agent, '/ui/call-ui1'), 'POST ui values');
  assert.equal(ui.path, `/turns/${T}/ui/call-ui1`);
  assert.deepEqual(ui.body.values, UI_FRAME === 'stub' ? { choice: 'a' } : { range: '1-20' });
  await emit(page, agent, S, T, { type: 'update', item: { ...agent.sessions.get(S).items.find((entry) => entry.id === 'ui1'), state: 'submitted' } });
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'running', inputRevision: 2 });

  // Navigate "go": SPA navigation (no reload), card stays; "offer": a button.
  await emit(page, agent, S, T, { type: 'item', item: { kind: 'navigate', id: 'nav1', turnId: T, callId: 'call-nav1', at, action: { mode: 'go', route: 'commands', label: 'Commands', anchor: 'commands.create' } } });
  await until(() => new URL(page.url()).pathname === `/${LOGIN}/commands`, 'navigated to commands');
  assert.equal(await page.evaluate(() => window.__noReload), 42, 'no full page load');
  assert.ok(await panel.isVisible(), 'desktop panel stays open after navigating');
  await until(async () => /Opened Commands/.test(await text(page.locator('[data-assistant-navigate]').first())), 'navigate card');
  await emit(page, agent, S, T, { type: 'item', item: { kind: 'navigate', id: 'nav2', turnId: T, callId: 'call-nav2', at, action: { mode: 'offer', route: 'settings', label: 'Settings' } } });
  await emit(page, agent, S, T, { type: 'item', item: { kind: 'navigate', id: 'nav3', turnId: T, callId: 'call-nav3', at, action: { mode: 'go', route: 'not-a-route', label: 'Nowhere' } } });
  await until(() => page.getByRole('button', { name: 'Open Settings' }).isVisible(), 'offer button');
  assert.equal(new URL(page.url()).pathname, `/${LOGIN}/commands`, 'unknown route key ignored');
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await until(() => new URL(page.url()).pathname === `/${LOGIN}/settings`, 'offer navigates');
  assert.equal(await page.evaluate(() => window.__noReload), 42, 'offer: no full page load');

  // Final answer: streamed, then final markdown.
  await emit(page, agent, S, T, { type: 'item', item: item.assistant('a2', T) });
  let streamed = 0;
  for (const part of FINAL_MD.match(/[\s\S]{1,40}/g)) {
    await emit(page, agent, S, T, { type: 'text', itemId: 'a2', delta: part, offset: streamed });
    streamed += part.length;
  }
  await emit(page, agent, S, T, { type: 'update', item: item.assistant('a2', T, FINAL_MD, true) });
  await emit(page, agent, S, T, { type: 'limits', limits: { ...agent.status.limits, used: 6 } });
  await emit(page, agent, S, T, { type: 'done', turnId: T, status: 'completed' });
  await until(async () => (await mood(page)) === 'happy', 'mascot happy after the answer', 2000);
  const answer = page.locator('[data-assistant-answer][data-final="true"]').last();
  await until(() => answer.isVisible(), 'final answer');
  assert.equal(await answer.locator('h4').innerText(), 'Your new command');
  assert.equal(await answer.locator('li').count(), 2);
  assert.equal(await answer.locator('table td').first().innerText(), 'Cooldown');
  assert.equal(await answer.locator('pre code').innerText(), '$(user) rolled $(random 1 20)');
  const links = await answer.locator('a').evaluateAll((list) => list.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  assert.deepEqual(links, [
    { href: 'https://docs.domdimabot.com/guides/commands/', target: '_blank', rel: 'noopener noreferrer' },
    { href: 'https://docs.domdimabot.com/reference/functions/', target: '_blank', rel: 'noopener noreferrer' },
  ]);
  assert.equal(await answer.locator('script').count(), 0, 'no script element');
  assert.match(await answer.innerText(), /<script>alert\(1\)<\/script>/, 'html shown as text');
  await answer.locator('.am-copy').click();
  await until(async () => (await answer.locator('.am-copy').innerText()) === 'Copied', 'copy button');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '$(user) rolled $(random 1 20)');
  await until(async () => /14 of 20/.test(await text(page.locator('[data-assistant-left]'))), 'limits event updates messages left');

  // Queued message starts its own turn after done.
  const queuedStream = await until(async () => (await sseRequests(page)).find((request) => request.turnId === Q), 'follows the queued turn');
  assert.ok(!queuedStream.after, 'queued turn streams from its start');
  await emit(page, agent, S, Q, { type: 'turn', turnId: Q, sessionId: S, status: 'running', inputRevision: 1 });
  await emit(page, agent, S, Q, { type: 'item', item: item.user('u3', Q, 'Also add a 10 s cooldown', 'queue') });
  await until(async () => (await page.locator('.at-user--pending').count()) === 0, 'queued bubble becomes real');
  await emit(page, agent, S, Q, { type: 'item', item: item.assistant('a3', Q, 'Done: the cooldown is 10 s.', true) });
  await emit(page, agent, S, Q, { type: 'done', turnId: Q, status: 'completed' });
  await until(async () => !(await page.locator('[data-assistant-stop]').isVisible()), 'idle after queued turn');

  // Feedback: thumbs on the latest answer only.
  const older = page.locator('[data-kind="answer"]').filter({ hasText: 'Your new command' });
  assert.equal(await older.getByRole('button', { name: 'Helpful', exact: true }).count(), 0, 'no thumbs on older answers');
  const thumbs = page.locator('[data-kind="answer"]').filter({ hasText: 'the cooldown is 10 s' }).getByRole('button', { name: 'Helpful', exact: true });
  await thumbs.click();
  const feedback = await until(() => lastPost(agent, '/feedback'), 'POST feedback');
  assert.equal(feedback.path, `/turns/${Q}/feedback`);
  assert.equal(feedback.body.helpful, true);
  await shot(page, 'desktop-dark-answer');
  await axe(page, 'desktop dark answer');
  await noOverflow(page, 'desktop answer');

  // Stop, then Retry.
  await page.locator('#assistant-input').fill('Explain follow defense');
  await page.locator('#assistant-input').press('Enter');
  await until(() => agent.posts.filter((post) => post.path === '/messages').length === 4, 'POST for t2');
  const T2 = agent.lastTurnId;
  await until(async () => (await sseRequests(page)).find((request) => request.turnId === T2), 'stream for t4');
  await emit(page, agent, S, T2, { type: 'turn', turnId: T2, sessionId: S, status: 'running', inputRevision: 1 });
  await emit(page, agent, S, T2, { type: 'item', item: item.user('u4', T2, 'Explain follow defense') });
  await emit(page, agent, S, T2, { type: 'item', item: item.assistant('a4', T2, 'Follow defense watches') });
  await page.locator('[data-assistant-stop]').click();
  const stop = await until(() => lastPost(agent, '/stop'), 'POST stop');
  assert.equal(stop.path, `/turns/${T2}/stop`);
  await until(async () => (await text(page.locator('[data-assistant-status]'))) === 'Stopping…', 'stopping status');
  await emit(page, agent, S, T2, { type: 'item', item: { kind: 'notice', id: 'n1', turnId: T2, code: 'stopped', at } });
  await emit(page, agent, S, T2, { type: 'done', turnId: T2, status: 'cancelled' });
  const retry = page.locator('[data-assistant-retry]');
  await until(() => retry.isVisible(), 'Retry after stop');
  assert.match(await text(page.locator('[data-code="stopped"]')), /Stopped/);
  await retry.click();
  const retried = await until(() => lastPost(agent, '/retry'), 'POST retry');
  assert.equal(retried.path, `/turns/${T2}/retry`);
  assert.ok(retried.body.clientRequestId, 'retry clientRequestId');
  const T3 = `${T2}-retry`;
  await until(async () => (await sseRequests(page)).find((request) => request.turnId === T3), 'stream for the retried turn');

  // Reconnect with the last cursor when the stream drops; resync reloads the chat.
  await emit(page, agent, S, T3, { type: 'turn', turnId: T3, sessionId: S, status: 'running', inputRevision: 1 });
  const cursor = await emit(page, agent, S, T3, { type: 'status', phase: 'thinking' });
  await page.evaluate((turn) => window.__sse.close(turn), T3);
  const reconnect = await until(async () => (await sseRequests(page)).filter((request) => request.turnId === T3)[1], 'reconnect', 6000);
  assert.equal(reconnect.after, cursor, 'reconnect resumes after the last cursor');
  const snapshotsBefore = agent.gets.filter((path) => path === `/sessions/${S}`).length;
  await page.evaluate((turn) => window.__sse.send(turn, 'event: resync\ndata: {}\n\n'), T3);
  await until(() => agent.gets.filter((path) => path === `/sessions/${S}`).length > snapshotsBefore, 'resync reloads the chat');
  const afterResync = await until(async () => (await sseRequests(page)).filter((request) => request.turnId === T3)[2], 'follows again after resync');
  assert.equal(afterResync.after, agent.sessions.get(S).activeTurn.cursor, 'resync follows from the snapshot cursor');
  // Text missing before a delta (a gap) also reloads the chat and follows from the snapshot cursor.
  const beforeGap = agent.gets.filter((path) => path === `/sessions/${S}`).length;
  await page.evaluate(([turn, text]) => window.__sse.send(turn, text), [T3, `id: ${++agent.seq}-0\nevent: text\ndata: ${JSON.stringify({ type: 'text', itemId: 'gap-item', delta: 'x', offset: 500 })}\n\n`]);
  await until(() => agent.gets.filter((path) => path === `/sessions/${S}`).length > beforeGap, 'a text gap reloads the chat');
  await until(async () => (await sseRequests(page)).filter((request) => request.turnId === T3).length >= 4, 'follows again after the gap');
  await emit(page, agent, S, T3, { type: 'item', item: item.assistant('a5', T3, 'Follow defense slows down follow bots.', true) });
  await emit(page, agent, S, T3, { type: 'done', turnId: T3, status: 'completed' });
  await until(async () => !(await retry.isVisible()), 'Retry gone after success');

  // Changes tab: undo with confirm; 409 conflict.
  await page.locator('[data-assistant-changes-tab]').click();
  await until(async () => (await page.locator('[data-assistant-change]').count()) === 3, 'changes list');
  const c1 = page.locator('[data-assistant-change]').nth(0);
  assert.match(await text(c1), /You: .?Make a dice command/);
  assert.equal(await c1.locator("q").innerText(), "Make a dice command");
  assert.match(await text(page.locator('[data-assistant-change]').nth(2)), /Undone/);
  await c1.locator('summary').click();
  assert.match(await text(c1), /\$\(random 1 20\)/);
  await c1.locator('[data-assistant-undo]').click();
  await c1.locator('[data-assistant-undo-confirm]').click();
  await until(() => lastPost(agent, '/changes/c1/undo'), 'POST undo');
  await until(async () => /Undone/.test(await text(c1)), 'undone state');
  const c2 = page.locator('[data-assistant-change]').nth(1);
  assert.match(await text(c2), /Helper/);
  await c2.locator('[data-assistant-undo]').click();
  await c2.locator('[data-assistant-undo-confirm]').click();
  await until(async () => /Can't undo/.test(await text(c2)), 'undo conflict message');
  assert.match(await text(c2), /30/, 'conflict shows the current value');
  await shot(page, 'desktop-dark-changes');
  await axe(page, 'desktop dark changes');

  // Chat list: kept 3 days, delete with confirm.
  await page.locator('[data-assistant-chats-btn]').click();
  const list = page.locator('app-assistant-sessions');
  await until(() => list.isVisible(), 'chat list');
  assert.match(await text(list), /kept for 3 days/);
  await list.getByRole('button', { name: 'Delete chat Old chat about timers' }).click();
  await list.getByRole('button', { name: 'Delete', exact: true }).click();
  await until(() => agent.deletes.includes('/sessions/s-old'), 'DELETE session');
  await until(async () => (await list.locator('.as-row').count()) === 1, 'deleted chat removed');
  await shot(page, 'desktop-dark-chats');
  await page.keyboard.press('Escape');
  await until(async () => !(await list.isVisible()), 'Escape closes the chat list first');
  assert.ok(await panel.isVisible(), 'panel still open');

  // Daily limit reached: composer disabled with a note.
  await page.locator('#assistant-tab-chat').click();
  agent.nextLimits = { ...agent.status.limits, used: 20 };
  await page.locator('#assistant-input').fill('One more');
  await page.locator('#assistant-input').press('Enter');
  await until(() => page.locator('[data-assistant-limit]').isVisible(), 'limit note');
  const T5 = agent.lastTurnId;
  assert.ok(await page.locator('#assistant-input').isDisabled(), 'composer disabled at the limit');
  assert.match(await text(page.locator('[data-assistant-limit]')), /all 20 messages/);
  assert.match(await text(page.locator('[data-assistant-limit]')), /Premium gives 80 a day/);
  await until(async () => (await sseRequests(page)).some((request) => request.turnId === T5), 'last stream');
  await emit(page, agent, S, T5, { type: 'item', item: item.user('u6', T5, 'One more') });
  await emit(page, agent, S, T5, { type: 'item', item: item.assistant('a6', T5, 'Sure.', true) });
  // Closed while it works: the finished answer shows as unread on the mascot.
  await page.locator('[data-assistant-close]').click();
  await until(async () => !(await panel.isVisible()), 'panel closed');
  assert.equal(await page.locator('app-assistant-mascot .am-unread').count(), 0, 'nothing unread yet');
  await emit(page, agent, S, T5, { type: 'done', turnId: T5, status: 'completed' });
  await until(() => page.locator('app-assistant-mascot .am-unread').isVisible(), 'unread dot after the answer finished while closed');
  assert.match(await page.locator('app-assistant-mascot button.am-trigger').getAttribute('aria-label'), /new answer/i);
  await openPanel(page);
  await until(async () => (await page.locator('app-assistant-mascot .am-unread').count()) === 0, 'unread cleared on open');
  await until(async () => !(await page.locator('[data-assistant-stop]').isVisible()), 'idle at limit');
  await shot(page, 'desktop-dark-limit');

  // Escape closes the panel and gives focus back to the mascot.
  await page.locator('#assistant-panel-title').focus();
  await page.keyboard.press('Escape');
  await until(async () => !(await panel.isVisible()), 'Escape closes the panel');
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('am-trigger')), 'focus back on the mascot');

  assert.deepEqual(agent.otherWrites ?? [], [], 'no writes outside the assistant API');
  const ours = errors.filter((message) => /assistant|Assistant/.test(message));
  assert.deepEqual(ours, [], 'no assistant page errors');
  if (errors.length) console.log('  other page errors (not assistant):', errors.slice(0, 3));
  await context.close();
}

// ---------------------------------------------------------------------------
// 2. Phone 375, light: bottom sheet, peek after navigating, drag handle
// ---------------------------------------------------------------------------

async function phoneFlow(browser) {
  console.log('phone 375 light: bottom sheet');
  const { context, page, agent, errors } = await openPage(browser, { theme: 'light', viewport: { width: 375, height: 740 } });
  await openPanel(page);
  const panel = page.locator('[data-assistant-panel]');
  const box = await panel.boundingBox();
  assert.ok(box && Math.abs(box.y + box.height - 740) <= 1 && box.height >= 0.9 * 740 - 2 && box.width === 375, `bottom sheet (${JSON.stringify(box)})`);
  assert.ok(await page.locator('.ap-backdrop').isVisible(), 'backdrop behind the sheet');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'assistant-panel-title', 'phone: focus on the title, keyboard stays down');
  await noOverflow(page, 'phone empty');
  await shot(page, 'phone-light-empty');
  await axe(page, 'phone light empty');

  // An example prompt fills the box (it doesn't spend a message until the person sends it).
  const postsBefore = agent.posts.filter((post) => post.path.endsWith('/messages')).length;
  await page.locator('.at-example').first().click();
  await until(async () => /!dice/.test(await page.locator('#assistant-panel textarea').inputValue()), 'example in the box');
  assert.equal(agent.posts.filter((post) => post.path.endsWith('/messages')).length, postsBefore, 'nothing sent by the example itself');
  await page.locator('#assistant-panel textarea').press('Enter');
  const send = await until(() => agent.posts.filter((post) => post.path.endsWith('/messages')).length > postsBefore && lastPost(agent, '/messages'), 'example sent');
  assert.match(send.body.text, /!dice/);
  const S = 's-new';
  const T = 't1';
  await until(async () => (await sseRequests(page)).length, 'stream');
  await emit(page, agent, S, T, { type: 'turn', turnId: T, sessionId: S, status: 'running', inputRevision: 1 });
  await emit(page, agent, S, T, { type: 'item', item: item.user('u1', T, send.body.text) });
  await emit(page, agent, S, T, { type: 'item', item: item.tool('k1', T, 'read_docs', 'Read “Commands”', 'done') });
  await emit(page, agent, S, T, { type: 'item', item: item.assistant('a1', T, 'Here is how commands work. **Open Commands** and tap *New command*.') });
  await emit(page, agent, S, T, {
    type: 'item',
    item: {
      kind: 'approval', id: 'ap1', turnId: T, callId: 'call-ap1', state: 'pending', expiresAt: Date.now() + 15 * MIN, at,
      proposal: { tool: 'update_command', title: 'Change command !dice', area: 'commands', target: { type: 'command', id: 'c', label: '!dice' }, before: { cooldown: 5, response: 'rolled $(random 1 6)' }, after: { cooldown: 10, response: 'rolled $(random 1 20)' }, effects: [] },
    },
  });
  const card = page.locator('[data-assistant-approval]');
  await until(() => card.isVisible(), 'approval card on phone');
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'phone-light-approval');
  await axe(page, 'phone light approval');
  await card.getByRole('button', { name: 'Skip' }).click();
  const skip = await until(() => lastPost(agent, '/approvals/call-ap1'), 'POST skip');
  assert.equal(skip.body.decision, 'skip');
  await until(async () => /Skipped/.test(await text(card)), 'card skipped');

  // Navigate go → the sheet shrinks to the peek bar and the page shows.
  await page.evaluate(() => { window.__noReload = 7; });
  await emit(page, agent, S, T, { type: 'item', item: { kind: 'navigate', id: 'nav1', turnId: T, callId: 'call-nav1', at, action: { mode: 'go', route: 'commands', label: 'Commands', anchor: 'commands.create' } } });
  await until(() => new URL(page.url()).pathname === `/${LOGIN}/commands`, 'navigated');
  assert.equal(await page.evaluate(() => window.__noReload), 7, 'no full page load');
  await until(() => page.locator('[data-assistant-peek]').isVisible(), 'peek bar');
  const peekBox = await panel.boundingBox();
  assert.ok(peekBox.height < 120, `peek bar is short (${peekBox.height})`);
  assert.equal(await page.locator('.ap-backdrop').count(), 0, 'no backdrop in peek mode');
  await shot(page, 'phone-light-peek');
  await axe(page, 'phone light peek');
  await page.locator('.ap-peek__open').click();
  await until(async () => (await panel.boundingBox()).height > 600, 'peek → full sheet');

  // Drag the handle down → peek; drag up → full.
  const handle = await page.locator('.ap-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80, { steps: 4 });
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 220, { steps: 4 });
  await page.mouse.up();
  await until(() => page.locator('[data-assistant-peek]').isVisible(), 'drag down → peek');
  await sleep(400); // the sheet settles (transform transition)
  const peekHandle = await page.locator('.ap-handle').boundingBox();
  await page.mouse.move(peekHandle.x + peekHandle.width / 2, peekHandle.y + 8);
  await page.mouse.down();
  await page.mouse.move(peekHandle.x + peekHandle.width / 2, peekHandle.y - 60, { steps: 4 });
  await page.mouse.move(peekHandle.x + peekHandle.width / 2, peekHandle.y - 160, { steps: 4 });
  await page.mouse.up();
  await until(async () => (await panel.boundingBox()).height > 600, 'drag up → full sheet');

  await emit(page, agent, S, T, { type: 'update', item: item.assistant('a1', T, 'Here is how commands work. **Open Commands** and tap *New command*.', true) });
  await emit(page, agent, S, T, { type: 'done', turnId: T, status: 'completed' });
  await until(async () => !(await page.locator('[data-assistant-stop]').isVisible()), 'idle');
  await until(() => agent.gets.filter((path) => path === `/sessions/${S}`).length > 0, 'chat reloaded after the answer');
  await sleep(300);
  assert.match(await text(card), /Skipped/, 'skipped card stays skipped after the reload');
  await noOverflow(page, 'phone conversation');
  await shot(page, 'phone-light-answer');

  // Backdrop tap closes.
  await page.mouse.click(180, 20);
  await until(async () => !(await panel.isVisible()), 'backdrop closes the sheet');
  const ours = errors.filter((message) => /assistant|Assistant/.test(message));
  assert.deepEqual(ours, [], 'no assistant page errors');
  await context.close();
}

// ---------------------------------------------------------------------------
// 3. Desktop 1280, light: a saved chat reopens; 409 turn_active keeps the draft
// ---------------------------------------------------------------------------

async function restoredChat(browser) {
  console.log('desktop 1280 light: restored chat');
  const T = 't-old';
  const oldItems = [
    item.user('u1', T, 'Make my timers slower'),
    item.tool('k1', T, 'list_timers', 'Looked at your timers', 'done', '2 timers'),
    { kind: 'notice', id: 'n0', turnId: T, code: 'compacted', at },
    {
      kind: 'approval', id: 'ap1', turnId: T, callId: 'call-1', state: 'applied', changeId: 'c2', expiresAt: at - MIN, at,
      proposal: { tool: 'update_timer', title: 'Change timer !discord', area: 'timers', target: { type: 'timer', id: 'tm-1', label: '!discord' }, before: { interval: 10, enabled: true }, after: { interval: 20, enabled: true }, effects: [] },
    },
    {
      kind: 'approval', id: 'ap2', turnId: T, callId: 'call-2', state: 'expired', expiresAt: at - MIN, at,
      proposal: { tool: 'update_timer', title: 'Change timer !socials', area: 'timers', target: { type: 'timer', id: 'tm-2', label: '!socials' }, before: { interval: 10 }, after: { interval: 25 }, effects: [] },
    },
    {
      kind: 'approval', id: 'ap3', turnId: T, callId: 'call-3', state: 'failed', error: 'The timer was changed by someone else.', expiresAt: at - MIN, at,
      proposal: { tool: 'update_timer', title: 'Change timer !prime', area: 'timers', target: { type: 'timer', id: 'tm-3', label: '!prime' }, before: { interval: 15 }, after: { interval: 30 }, effects: ['Posts a message in chat every 30 minutes'] },
    },
    item.assistant('a1', T, 'I slowed down **!discord**. The other two were not changed.', true),
  ];
  const { context, page, agent, errors } = await openPage(browser, { theme: 'light', remember: 's-old', oldItems });
  await openPanel(page);
  await until(async () => (await page.locator('[data-assistant-approval]').count()) === 3, 'saved chat restored');
  assert.equal(await page.locator('.ap-sub').innerText(), 'Old chat about timers');
  assert.match(await text(page.locator('[data-assistant-approval]').nth(0)), /Applied/);
  assert.match(await text(page.locator('[data-assistant-approval]').nth(1)), /Expired/);
  assert.match(await text(page.locator('[data-assistant-approval]').nth(2)), /changed by someone else/);
  assert.match(await text(page.locator('[data-code="compacted"]')), /summarized/);
  assert.equal((await sseRequests(page)).length, 0, 'no stream for a finished chat');
  await shot(page, 'desktop-light-restored');
  await axe(page, 'desktop light restored');

  agent.failSend = { status: 409, code: 'turn_active' };
  await page.locator('#assistant-input').fill('And the third one?');
  await page.locator('#assistant-input').press('Enter');
  await until(() => page.locator('[data-assistant-send-error]').isVisible(), '409 turn_active message');
  assert.match(await text(page.locator('[data-assistant-send-error]')), /still working/);
  assert.equal(await page.locator('#assistant-input').inputValue(), 'And the third one?', 'draft kept');
  const ours = errors.filter((message) => /assistant|Assistant/.test(message));
  assert.deepEqual(ours, [], 'no assistant page errors');
  await context.close();
}

// ---------------------------------------------------------------------------
// 4. Phone 375, dark, Spanish; and an admin sees their own changes
// ---------------------------------------------------------------------------

async function phoneSpanish(browser) {
  console.log('phone 375 dark es: Spanish copy, admin changes');
  const { context, page, errors } = await openPage(browser, { theme: 'dark', language: 'es', role: 'admin', viewport: { width: 375, height: 740 } });
  await openPanel(page);
  await until(async () => /Te quedan 17 de 20 mensajes hoy/.test(await text(page.locator('[data-assistant-left]'))), 'Spanish messages left');
  assert.equal(await page.locator('#assistant-panel-title').innerText(), 'Asistente');
  assert.match(await text(page.locator('[data-assistant-empty]')), /Solo cambio algo cuando tú lo apruebas/);
  await shot(page, 'phone-dark-es-empty');
  await axe(page, 'phone dark es');
  await page.locator('[data-assistant-changes-tab]').click();
  await until(async () => (await page.locator('[data-assistant-change]').count()) === 3, 'changes (es)');
  assert.match(await text(page.locator('app-assistant-changes')), /Los cambios que el asistente hizo por ti/);
  await shot(page, 'phone-dark-es-changes');
  await axe(page, 'phone dark es changes');
  await noOverflow(page, 'phone es changes');
  const ours = errors.filter((message) => /assistant|Assistant/.test(message));
  assert.deepEqual(ours, [], 'no assistant page errors');
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. Assistant off for the channel: nothing renders
// ---------------------------------------------------------------------------

async function disabled(browser) {
  console.log('assistant disabled: hidden');
  const { context, page } = await openPage(browser, { enabled: false }).catch(async () => ({}));
  if (page) {
    await sleep(800);
    assert.equal(await page.locator('[data-assistant-panel]').count(), 0, 'no panel when disabled');
    await context.close();
    return;
  }
  // The mascot never shows when disabled (openPage waits for it): open the page without waiting.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const agent = createAgent({ enabled: false });
  await installRoutes(ctx, agent, {});
  const p = await ctx.newPage();
  await p.goto(`${base}/${LOGIN}/dashboard`);
  await until(() => agent.gets.includes('/status'), 'status requested');
  await sleep(800);
  assert.equal(await p.locator('app-assistant-mascot button.am-trigger').count(), 0, 'no mascot when disabled');
  assert.equal(await p.locator('[data-assistant-panel]').count(), 0, 'no panel when disabled');
  assert.equal(agent.gets.filter((path) => path === '/sessions').length, 0, 'no chat list loaded when disabled');
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await desktopFlow(browser);
  await phoneFlow(browser);
  await restoredChat(browser);
  await phoneSpanish(browser);
  await disabled(browser);
  console.log('site-agent-panel: all checks passed');
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    if (shots) await currentPage.screenshot({ path: `${shots}/failure.png` }).catch(() => undefined);
    const state = await currentPage.evaluate(() => ({
      url: location.href,
      composer: document.querySelector('[data-assistant-composer]')?.innerText,
      send: document.querySelector('[data-assistant-send]')?.outerHTML.slice(0, 300),
      status: document.querySelector('[data-assistant-status]')?.innerText,
      input: document.querySelector('#assistant-input')?.value,
      clicks: window.__clickLog?.slice(-14),
      peek: !!document.querySelector('[data-assistant-peek]'),
      ui: document.querySelector('[data-assistant-ui]')?.outerHTML.replace(/_ngcontent-[^=]+=""/g, '').replace(/srcdoc="[^"]*"/, 'srcdoc=…').slice(0, 900),
      sheet: document.querySelector('[data-assistant-panel]')?.getAttribute('style'),
    })).catch(() => null);
    console.log('failure state:', JSON.stringify(state, null, 2));
  }
  throw error;
} finally {
  await browser.close();
}
