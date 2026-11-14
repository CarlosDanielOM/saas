// Admin channel workspace, Twitch events tab (/channels/:id/eventsubs): what each event says in chat and the
// owner editor for its chat settings and the channel's Bits rules. Every API call is mocked on both
// api.domdimabot.com and localhost:3000, so no write can reach production. The chat event catalog copies the real
// shapes (dimabot/src/utils/chat_event_catalog.ts plus the stored catalog controls for follows, go-live, ad breaks and
// Bits); the owner route mock answers like dimabot/src/server/routes/admin_site/channel_edit.route.ts and the Bits
// rules mock like dimabot/src/server/routes/bits-rules.route.ts (whole new state per write, same validation).
// Covers the "Says …" lines, the merge by the site's type name, the editor per control type, "All stored settings"
// (every stored field not shown by the catalog, typed, with its raw name), the exact owner PATCH bodies (quick switch,
// catalog fields, raid delay, todayFollows/temporalBanMessage, unused duplicates, turning off go-live which the site
// refuses), the 500-character warning that doesn't block, a 400 kept inline, the Bits rules section (list, add with an
// API error inline, edit, on/off, delete with the Studio looks warning, exact bodies), the removed locks/links, Escape
// (not while saving), the outgoing raid's test event, and layout + accessibility at 320/390/1280 in dark and light.
//
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4310), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (default /tmp/saas-admin-console-eventsub-editing).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------
// Fixtures (fictional names only)
// ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const channel = { channel: 'mossy_lantern', channelID: '8100001', email: 'mossy_lantern@example.test', plan_tier: 'pro', actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true, isLive: false, liveViewers: 0, commandsCount: 4, eventsubsActiveCount: 10, eventsubsDisabledCount: 1, created_at: '2026-05-02T10:00:00.000Z', reminder_sent_at: null };

const standardTypes = [
  { type: 'channel.chat.message', version: '1', condition: {}, config: null },
  { type: 'channel.follow', version: '2', condition: {}, config: null },
  { type: 'stream.online', version: '1', condition: {}, config: null },
  { type: 'channel.raid', version: '1', condition: {}, config: null },
  { type: 'channel.raid.outgoing', version: '1', condition: {}, config: null },
  { type: 'channel.ad_break.begin', version: '1', condition: {}, config: null },
  { type: 'channel.bits.use', version: '1', condition: {}, config: null },
  { type: 'channel.chat.notification', version: '1', condition: {}, config: null },
  { type: 'channel.subscribe', version: '1', condition: {}, config: null },
];

// GET /site/events: the catalog the site's Chat events page renders (labels as the API sends them, EN/ES).
const catalog = [
  { name: 'Follow', type: 'channel.follow', version: '2', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Thank new followers', ES: 'Agradece a los nuevos seguidores' },
    config: [{ id: 'followMessage', dbId: 'message', label: { EN: 'Follow message', ES: 'Mensaje de follow' }, type: 'text', value: 'Thanks $(user) for following!', canDisable: true }] },
  { name: 'Stream Online', type: 'stream.online', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Announce when the stream starts', ES: 'Anuncia cuando empieza el directo' },
    config: [{ id: 'streanStartedMessage', dbId: 'message', label: { EN: 'Stream started message', ES: 'Mensaje de inicio' }, type: 'text', value: '$(twitch.channel) is now live!', canDisable: true }] },
  { name: 'Ad Break', type: 'channel.ad_break.begin', version: '1', plan_tier: 'premium', releaseStage: 'stable', description: { EN: 'Warn chat about ad breaks', ES: 'Avisa al chat de los anuncios' },
    config: [
      { id: 'adBreakMessage', label: { EN: 'Ad break message', ES: 'Mensaje del anuncio' }, type: 'text', value: 'Ad break for $(ad.duration) seconds. Stay with us!', canDisable: true },
      { id: 'endEnabled', label: { EN: 'Send a message when the ad break ends', ES: 'Enviar un mensaje al terminar' }, type: 'checkbox', value: true, canDisable: true },
      { id: 'endMessage', label: { EN: 'End message', ES: 'Mensaje final' }, type: 'text', value: 'Ads are over, welcome back!', canDisable: true, showIf: { controlId: 'endEnabled', is: true } },
    ] },
  { name: 'Bits', type: 'channel.bits.use', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Thank cheers', ES: 'Agradece los bits' },
    config: [
      { id: 'defaultCheerMessage', dbId: 'message', label: { EN: 'Default message', ES: 'Mensaje por defecto' }, type: 'text', value: 'Thanks $(user) for the $(bits) bits!', canDisable: true },
      { id: 'cheerTiers', label: { EN: 'Bits rules', ES: 'Reglas de Bits' }, type: 'message-tiers', value: [], canDisable: true },
    ] },
  // Built-ins (chat_event_catalog.ts).
  { name: 'Chat Notifications', type: 'channel.chat.notification', version: '1', plan_tier: 'free', releaseStage: 'stable',
    description: { EN: 'Celebrate watch streaks and moderator anniversaries shared in chat.', ES: 'Celebra las rachas…' },
    config: [
      { id: 'watchStreakEnabled', label: { EN: 'Watch streak announcements', ES: 'Anuncios de rachas de visualización' }, type: 'checkbox', value: true, canDisable: true },
      { id: 'message', label: { EN: 'Streak message', ES: 'Mensaje de la racha' }, type: 'text', value: '$(user) is on a $(streak) stream watch streak!', canDisable: true },
      { id: 'modiversaryEnabled', label: { EN: 'Moderator anniversary announcements', ES: 'Anuncios de aniversarios de moderación' }, type: 'checkbox', value: true, canDisable: true },
      { id: 'modiversaryMessage', label: { EN: 'Moderator anniversary message', ES: 'Mensaje de aniversario de moderación' }, type: 'text', value: 'Happy $(years) year mod anniversary, $(user)!', canDisable: true },
    ] },
  { name: 'Shoutout Received', type: 'channel.shoutout.receive', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Thank another streamer when they send your channel a shoutout.', ES: 'Agradece…' },
    config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: '$(shoutout.channel) has sent a shoutout to $(twitch.channel)!', canDisable: true }] },
  { name: 'Incoming raid', type: 'channel.raid', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Incoming raid protection, announcements, clips and shoutouts.', ES: 'Protección…' },
    config: [
      { id: 'message', label: { EN: 'Announcement', ES: 'Anuncio' }, type: 'text', value: '$(raid.channel) is raiding with $(raid.viewers) viewers!', canDisable: true },
      { id: 'enableClip', dbId: 'clipEnabled', label: { EN: 'Show a clip', ES: 'Mostrar un clip' }, type: 'checkbox', value: true, canDisable: true },
      { id: 'minViewers', label: { EN: 'Minimum viewers for announcements', ES: 'Espectadores mínimos para anuncios' }, type: 'number', value: 2, canDisable: true },
    ] },
  { name: 'Outgoing raid', type: 'channel.raid.outgoing', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Track channels you raid for your dashboard.', ES: 'Registra…' },
    config: [{ id: 'message', label: { EN: 'Optional message · $(raid.channel), $(raid.login), $(raid.viewers)', ES: 'Mensaje opcional · $(raid.channel), $(raid.login), $(raid.viewers)' }, type: 'text', value: '', canDisable: true }] },
  { name: 'New subscriptions', type: 'channel.subscribe', version: '1', plan_tier: 'free', releaseStage: 'stable', description: { EN: 'Welcome new subscribers.', ES: 'Da la bienvenida…' },
    config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Thanks $(user) for subscribing at $(sub.tier)!', canDisable: true }] },
];

const settings = (overrides = {}) => ({ message: '', endMessage: '', endEnabled: false, minViewers: 2, clipEnabled: false, delay: 0, modiversaryMessage: '', modiversaryEnabled: true, watchStreakEnabled: true, temporalBanMessage: '', todayFollows: false, ...overrides });
// The owner route's field types (channel_rows.ts EVENTSUB_SETTING_TYPES) plus `enabled`.
const SETTING_TYPES = { message: 'string', endMessage: 'string', endEnabled: 'boolean', minViewers: 'number', clipEnabled: 'boolean', delay: 'number', modiversaryMessage: 'string', modiversaryEnabled: 'boolean', watchStreakEnabled: 'boolean', temporalBanMessage: 'string', todayFollows: 'boolean', enabled: 'boolean' };
const LONG_BITS = 'Thank you so much $(user) for the $(bits) bits! Every single one keeps the lantern glowing through the night, and the whole crew sees it.';

function newRows() {
  return [
    { id: 'es-chat', type: 'channel.chat.message', rawType: 'channel.chat.message', version: '1', status: 'enabled', enabled: true, settings: settings(), cheerTierCount: 0 },
    { id: 'es-follow', type: 'channel.follow', rawType: 'channel.follow', version: '2', status: 'enabled', enabled: true, settings: settings({ message: 'Thanks $(user) for following!' }), cheerTierCount: 0 },
    // A second follow row of the same type and version: the first one wins; this one is listed under Other as not used.
    { id: 'es-follow-dup', type: 'channel.follow', rawType: 'channel.follow', version: '2', status: 'enabled', enabled: true, settings: settings({ message: 'DUPLICATE FOLLOW ROW' }), cheerTierCount: 0 },
    { id: 'es-online', type: 'stream.online', rawType: 'stream.online', version: '1', status: 'enabled', enabled: true, settings: settings(), cheerTierCount: 0 },
    { id: 'es-raid', type: 'channel.raid', rawType: 'channel.raid', version: '1', status: 'enabled', enabled: true, settings: settings({ message: '$(raid.channel) is raiding with $(raid.viewers) viewers!', clipEnabled: true, minViewers: 2 }), cheerTierCount: 0 },
    { id: 'es-raid-out', type: 'channel.raid.outgoing', rawType: 'channel.raid', version: '1', status: 'enabled', enabled: true, settings: settings(), cheerTierCount: 0 },
    { id: 'es-ad', type: 'channel.ad_break.begin', rawType: 'channel.ad_break.begin', version: '1', status: 'enabled', enabled: false, settings: settings({ message: 'Ad break! Back in $(ad.duration) seconds.', endMessage: 'We are back!', endEnabled: false }), cheerTierCount: 0 },
    // An old channel.cheer row listed before the current Bits row: the bot reads channel.bits.use first, so that one wins.
    { id: 'es-cheer-old', type: 'channel.bits.use', rawType: 'channel.cheer', version: '1', status: 'enabled', enabled: true, settings: settings({ message: 'OLD CHEER ROW' }), cheerTierCount: 0 },
    { id: 'es-bits', type: 'channel.bits.use', rawType: 'channel.bits.use', version: '1', status: 'enabled', enabled: true, settings: settings({ message: LONG_BITS }), cheerTierCount: 3 },
    { id: 'es-notif', type: 'channel.chat.notification', rawType: 'channel.chat.notification', version: '1', status: 'enabled', enabled: true, settings: settings(), cheerTierCount: 0 },
    // Not in the standard list.
    { id: 'es-goal', type: 'channel.goal.begin', rawType: 'channel.goal.begin', version: '1', status: 'enabled', enabled: true, settings: settings(), cheerTierCount: 0 },
    { id: 'es-shoutout', type: 'channel.shoutout.receive', rawType: 'channel.shoutout.receive', version: '1', status: 'enabled', enabled: true, settings: settings({ message: '$(shoutout.channel) sent us a shoutout!' }), cheerTierCount: 0 },
  ].map((row) => ({ ...row, message: row.settings.message, endMessage: row.settings.endMessage, remoteMissingSince: null, created_at: '2026-08-10T12:00:00Z' }));
}

const eventsubActivity = {
  types: [
    { type: 'channel.follow', lastReceivedAt: ago(120), received7d: 14, lastAlert: { at: ago(120), outcome: 'ok', reason: null }, failedDeliveries: 0 },
    { type: 'channel.raid', lastReceivedAt: ago(2 * 1440), received7d: 2, lastAlert: { at: ago(2 * 1440), outcome: 'ok', reason: null }, failedDeliveries: 0 },
  ],
  revoked: [],
};

// GET /bits-rules/:channelID (bits-rules.route.ts view): rules in stored order, Studio looks per rule.
function newBitsRules() {
  return {
    revision: 4,
    rules: [
      { id: 'rule-big', name: 'Big cheer', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true },
      { id: 'rule-small', name: '', enabled: true, min: 100, max: 499, chat: { mode: 'custom', message: 'Thanks $(user) for the $(bits) bits!' }, alert: true },
      { id: 'rule-nice', name: 'Nice', enabled: false, min: 69, max: 69, chat: { mode: 'silent', message: '' }, alert: false },
    ],
    maxRules: 50,
    canManage: true,
    looks: { 'rule-big': 2 },
    chat: { subscribed: true, enabled: true, defaultMessage: LONG_BITS },
  };
}

function newState() {
  return { rows: newRows(), bits: newBitsRules(), patchFail: null, patchDelay: 0, catalogFail: false, bitsFail: null, nextRule: 1 };
}

/** The Bits rules API's validation (dimabot/src/bits_rules/model.ts parseRule), merged onto `previous` on update. */
function parseRule(body, id, previous) {
  const allowed = new Set(['name', 'enabled', 'min', 'max', 'chat', 'alert']);
  if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !allowed.has(key))) throw new Error('Unknown rule field');
  const pick = (key) => (key in body ? body[key] : previous?.[key]);
  const amount = (value, field) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${field} must be a whole number of Bits from 1 to 1,000,000`);
    return value;
  };
  const name = pick('name') ?? '';
  if (typeof name !== 'string' || name.length > 60) throw new Error('Names can be up to 60 characters');
  const min = amount(pick('min'), 'The amount');
  const rawMax = pick('max');
  const max = rawMax === null || rawMax === undefined ? null : amount(rawMax, 'The highest amount');
  if (max !== null && max < min) throw new Error('The highest amount must be at least the lowest amount');
  const chat = pick('chat') ?? { mode: 'default', message: '' };
  if (!['default', 'custom', 'silent'].includes(chat.mode)) throw new Error('Invalid chat action');
  if (chat.mode === 'custom' && !String(chat.message ?? '').trim()) throw new Error('Write the chat message, or choose the default message');
  return { id, name: name.trim(), enabled: pick('enabled') ?? true, min, max, chat: { mode: chat.mode, message: chat.message ?? '' }, alert: pick('alert') ?? true };
}

const escapeRe = (value) => value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const ok = (data) => ({ status: 200, body: { error: false, message: 'ok', status: 200, data } });

function makeApi(state) {
  return (method, path, url, body) => {
    const params = url.searchParams;
    let m;
    if (method === 'GET' && path === '/admin-site/users') {
      const search = params.get('search') || '';
      const rows = [channel].filter((row) => !search || row.channelID === search || row.channel.includes(search));
      return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 }, summary: {} });
    }
    if (method === 'GET' && path === '/admin-site/feed') return ok({ items: [], nextCursor: null, partial: [] });
    if (method === 'GET' && path === '/admin-site/feed/summary') return ok({ from: ago(1440), to: ago(0), partial: [], kinds: [] });
    if ((m = path.match(/^\/admin-site\/users\/(\d+)\/(.+)$/))) {
      const [, id, rest] = m;
      if (method === 'GET' && rest === 'eventsubs') {
        const rows = id === '8100001' ? state.rows : [];
        return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 } });
      }
      if (method === 'GET' && rest === 'eventsub-activity') return ok(id === '8100001' ? eventsubActivity : { types: [], revoked: [] });
      // The owner route (channel_edit.route.ts): any stored setting + enabled, typed; no plan gate, no
      // "can't be disabled", no raid field list. Answers the saved row.
      if (method === 'PATCH' && id === '8100001' && (m = rest.match(/^eventsubs\/([\w-]+)$/))) {
        if (state.patchFail) {
          const failure = state.patchFail;
          state.patchFail = null;
          return { status: failure.status, body: { error: true, message: failure.message, status: failure.status } };
        }
        const row = state.rows.find((candidate) => candidate.id === m[1]);
        if (!row) return { status: 404, body: { error: true, message: 'Subscription not found', status: 404 } };
        for (const [key, value] of Object.entries(body ?? {})) {
          if (!SETTING_TYPES[key]) return { status: 400, body: { error: true, message: `Not an editable setting: ${key}`, status: 400 } };
          if (typeof value !== SETTING_TYPES[key] || (typeof value === 'number' && (!Number.isInteger(value) || value < 0 || value > 1_000_000))) {
            return { status: 400, body: { error: true, message: `Invalid ${key}`, status: 400 } };
          }
        }
        if (!Object.keys(body ?? {}).length) return { status: 400, body: { error: true, message: 'Nothing to change', status: 400 } };
        for (const [key, value] of Object.entries(body)) {
          if (key === 'enabled') row.enabled = value;
          else row.settings[key] = value;
        }
        row.message = row.settings.message;
        row.endMessage = row.settings.endMessage;
        return { status: 200, body: { error: false, message: 'Saved', status: 200, data: row } };
      }
    }
    if (method === 'GET' && path === '/eventsubs/standard') return ok({ standardTypes });
    if (method === 'GET' && path === '/site/events') return state.catalogFail ? { status: 500, body: { error: true, message: 'Internal server error', status: 500 } } : { status: 200, body: { error: false, data: catalog } };
    // Bits rules (bits-rules.route.ts): each write answers the whole new state.
    if ((m = path.match(/^\/bits-rules\/8100001(?:\/rules(?:\/([\w-]+))?)?$/))) {
      const bitsState = state.bits;
      if (method === 'GET' && !path.includes('/rules')) return ok(bitsState);
      if (state.bitsFail) {
        const failure = state.bitsFail;
        state.bitsFail = null;
        return { status: failure.status, body: { error: true, status: failure.status, message: failure.message } };
      }
      try {
        if (method === 'POST' && path.endsWith('/rules')) {
          if (bitsState.rules.length >= 50) return { status: 409, body: { error: true, status: 409, message: 'You can have up to 50 Bits rules' } };
          const id = `rule-new${state.nextRule}`;
          bitsState.rules.push(parseRule(body, id));
          state.nextRule += 1;
          bitsState.revision += 1;
          return { status: 201, body: { error: false, status: 201, message: 'OK', data: { ...bitsState, created: id } } };
        }
        const index = bitsState.rules.findIndex((rule) => rule.id === m[1]);
        if (method === 'PATCH' && m[1]) {
          if (index < 0) return { status: 404, body: { error: true, status: 404, message: 'This rule was deleted. Reload to see the current rules.' } };
          bitsState.rules[index] = parseRule(body, m[1], bitsState.rules[index]);
          bitsState.revision += 1;
          return ok(bitsState);
        }
        if (method === 'DELETE' && m[1]) {
          if (index < 0) return { status: 404, body: { error: true, status: 404, message: 'This rule was already deleted.' } };
          bitsState.rules.splice(index, 1);
          delete bitsState.looks[m[1]];
          bitsState.revision += 1;
          return ok(bitsState);
        }
      } catch (error) {
        return { status: 400, body: { error: true, status: 400, message: error.message } };
      }
    }
    if (method === 'POST' && path === '/eventsubs/8100001/test') {
      state.lastTest = body;
      return ok({});
    }
    if (method === 'GET' && path === '/users') return { status: 200, body: { data: {} } };
    return null;
  };
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4310';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-eventsub-editing';
fs.mkdirSync(artifacts, { recursive: true });

const state = newState();
const api = makeApi(state);
const requests = [];
const unexpected = [];
const pageErrors = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');
const count = (pred) => requests.filter(pred).length;
// Owner writes of a subscription; the site's own PATCH /eventsubs/:channel/:id must never be used again.
const patches = () => requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/admin-site/users/8100001/eventsubs/'));
const sitePatches = () => count((r) => r.method === 'PATCH' && r.path.startsWith('/eventsubs/'));
const bitsWrites = () => requests.filter((r) => r.path.startsWith('/bits-rules/') && r.method !== 'GET');
const ownerPath = (id) => `/admin-site/users/8100001/eventsubs/${id}`;
const listLoads = () => count((r) => r.method === 'GET' && r.path === '/admin-site/users/8100001/eventsubs');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({
      version: 2, token: 'disposable-eventsub-fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' },
    }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = request.postDataJSON(); } catch { /* no body */ }
    requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, body });
    if (request.method() === 'PATCH' && state.patchDelay) await new Promise((resolve) => setTimeout(resolve, state.patchDelay));
    const result = api(request.method(), url.pathname, url, body);
    if (!result) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: true, message: 'Not mocked' }) });
    }
    return route.fulfill({ status: result.status, headers: cors, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) pageErrors.push(message.text()); });

  const until = async (check, label, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png` });
  const h1 = page.locator('main h1');
  const settle = () => page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
  const goto = async (path) => { await page.goto(`${base}${path}`); await h1.first().waitFor(); await settle(); };
  // A row by its type line; unused duplicates (listed under Other subscriptions) are left out unless asked for.
  const esRow = (typeAndVersion, { duplicate = false } = {}) => page.locator(duplicate ? '.es-row:has([data-duplicate])' : '.es-row:not(:has([data-duplicate]))',
    { has: page.locator('.es-type', { hasText: new RegExp(`^${typeAndVersion.replace(/\./g, '\\.')}$`) }) });
  const group = (name) => page.locator('.sub-group', { hasText: name }).locator('xpath=following-sibling::ul[1]');
  const dialog = page.locator('dialog.ed-dialog');
  const openEditor = async (name, dialogName = name) => {
    await page.getByRole('button', { name: `Edit ${name} chat settings`, exact: true }).click();
    await dialog.waitFor();
    await settle();
    await page.getByRole('dialog', { name: `${dialogName} in chat` }).waitFor();
  };
  const fields = () => dialog.locator('.ed-fields');
  const stored = () => dialog.locator('details.ed-more');
  const openStored = async () => {
    if (!(await stored().evaluate((el) => el.open))) await stored().locator('summary').click();
    await until(async () => stored().evaluate((el) => el.open), 'All stored settings open');
  };
  const bits = () => dialog.locator('app-bits-rules-editor');
  const ruleItem = (title) => bits().locator('.br-item', { has: page.locator('.br-name', { hasText: new RegExp(`^${escapeRe(title)}$`) }) });
  /** Texts of the old locks and links that must be gone from every dialog. */
  const noLocks = async (label) => {
    const body = await text(dialog);
    for (const gone of ['Also set on the site', 'edit on domdimabot.com', 'Change on domdimabot.com', 'Bits rules ·']) assert.ok(!body.includes(gone), `${label}: "${gone}" is gone`);
    assert.equal(await dialog.locator('a[href*="domdimabot.com"]').count(), 0, `${label}: no link to the site`);
  };
  const closed = () => dialog.waitFor({ state: 'detached' });
  const save = () => dialog.getByRole('button', { name: 'Save', exact: true });
  const isDisabled = (locator) => locator.evaluate((el) => el.disabled);
  const loadList = async () => {
    await goto('/channels/8100001/eventsubs');
    await page.locator('.es-summary').waitFor();
    await until(async () => (await page.locator('.es-says').count()) > 0, 'catalog loaded');
  };

  // ---------------------------------------------------------------- List: merge, groups, "Says" lines
  await loadList();
  await page.getByText('2 of 9 events need attention').waitFor();
  assert.equal(await page.locator('.es-row').count(), 13, '9 standard rows + 2 other subscriptions + 2 unused duplicates');
  // The outgoing raid (stored as channel.raid) matches its standard entry instead of showing Missing.
  const outgoing = esRow('channel.raid.outgoing v1');
  assert.equal(await outgoing.count(), 1);
  assert.match(await text(outgoing), /^Outgoing raids On/);
  assert.equal(await outgoing.getByRole('button', { name: /^Connect/ }).count(), 0, 'outgoing raid is not missing');
  assert.ok((await text(outgoing)).includes('Posts nothing in chat'));
  assert.equal(await page.getByRole('button', { name: /^Connect/ }).count(), 1, 'only New subs is missing');
  await page.getByRole('button', { name: 'Connect New subs' }).waitFor();
  // Says lines.
  assert.ok((await text(esRow('channel.follow v2'))).includes('Says “Thanks $(user) for following!”'), await text(esRow('channel.follow v2')));
  assert.ok(!(await text(esRow('channel.follow v2'))).includes('DUPLICATE FOLLOW ROW'), 'the first stored row of a type wins');
  const followDup = esRow('channel.follow v2', { duplicate: true });
  assert.equal(await text(followDup.locator('[data-duplicate]')), 'Not used: the bot reads the other Follows subscription');
  // Unused duplicates can be edited too, with their own labels (never two buttons named alike).
  assert.equal(await followDup.getByRole('button', { name: 'Edit unused Follows chat settings', exact: true }).count(), 1, 'Edit on the unused duplicate');
  assert.equal(await followDup.getByRole('switch', { name: 'unused Follows on', exact: true }).count(), 1);
  assert.equal(await followDup.getByRole('button', { name: 'Test unused Follows', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Edit Follows chat settings', exact: true }).count(), 1, 'one Edit per label');
  // Bits: the current channel.bits.use row wins over an older channel.cheer row listed first (as the bot reads them).
  assert.ok((await text(esRow('channel.bits.use v1'))).includes(LONG_BITS.slice(0, 20)), 'the canonical Bits row is the one shown');
  assert.ok(!(await text(esRow('channel.bits.use v1'))).includes('OLD CHEER ROW'));
  const cheerDup = esRow('channel.cheer v1', { duplicate: true });
  assert.equal(await cheerDup.count(), 1, 'the old cheer row is listed by its stored type, marked not used');
  assert.equal(await cheerDup.getByRole('button', { name: 'Edit unused Bits chat settings', exact: true }).count(), 1);
  assert.ok((await text(esRow('stream.online v1'))).includes('Posts nothing in chat'));
  assert.ok((await text(esRow('channel.chat.notification v1'))).includes('Uses the default message'));
  assert.ok((await text(esRow('channel.raid v1'))).includes('Says “$(raid.channel) is raiding with $(raid.viewers) viewers!”'));
  assert.equal(await esRow('channel.chat.message v1').locator('.es-says').count(), 0, 'no chat settings, no Says line');
  assert.equal(await esRow('channel.chat.message v1').getByRole('button', { name: 'Edit Chat messages chat settings', exact: true }).count(), 1, 'every stored row has Edit, chat settings or not');
  assert.equal(await esRow('channel.subscribe v1').locator('.es-says').count(), 0, 'missing events have no Says line');
  assert.equal(await esRow('channel.subscribe v1').getByRole('button', { name: /^Edit/ }).count(), 0, 'missing events have no Edit');
  // The off ad break sits in Needs attention with its message muted.
  const adSays = esRow('channel.ad_break.begin v1').locator('.es-says');
  assert.ok((await text(adSays)).includes('Says “Ad break! Back in $(ad.duration) seconds.”'));
  assert.equal(await adSays.evaluate((el) => el.classList.contains('es-says--off')), true, 'off events are muted');
  assert.equal(await page.locator('.es-says.es-says--off').count(), 1);
  assert.ok((await text(group('Needs attention'))).includes('Ad breaks'));
  // The long Bits message is clamped to one line.
  const bitsSays = esRow('channel.bits.use v1').locator('.es-says');
  const bitsBox = await bitsSays.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || 20 }));
  assert.ok(bitsBox.height < bitsBox.line * 1.6, `one-line clamp (${JSON.stringify(bitsBox)})`);
  // Other subscriptions: same row template, no Connect, Edit on every stored row.
  const others = group('Other subscriptions');
  assert.equal(await others.locator('.es-row').count(), 4, 'goal + shoutout + the two unused duplicates');
  const goal = esRow('channel.goal.begin v1');
  assert.ok((await text(goal)).includes('On'));
  assert.equal(await goal.getByRole('button', { name: /^Connect/ }).count(), 0);
  assert.equal(await goal.getByRole('button', { name: 'Edit channel.goal.begin chat settings', exact: true }).count(), 1, 'Edit without a catalog entry too');
  assert.equal(await goal.getByRole('switch').count(), 1);
  assert.equal(await others.locator('.es-type', { hasText: 'channel.goal.begin v1' }).count(), 1, 'the goal subscription is under Other subscriptions');
  assert.equal(await esRow('channel.shoutout.receive v1').getByRole('button', { name: 'Edit Shoutouts received chat settings' }).count(), 1);
  assert.ok((await text(esRow('channel.shoutout.receive v1'))).includes('Says “$(shoutout.channel) sent us a shoutout!”'));
  assert.equal(bitsWrites().length + count((r) => r.path.startsWith('/bits-rules/')), 0, 'the list never loads Bits rules');
  await shot('list-dark-390');

  // ---------------------------------------------------------------- Follow: text field, counter, long-message warning, exact body
  await openEditor('Follows');
  const followDialog = page.getByRole('dialog', { name: 'Follows in chat' });
  assert.ok((await text(followDialog.locator('.lf-dialog__body p').first())).startsWith("Changes apply to mossy_lantern's chat right away. mossy_lantern isn't notified."));
  const followMessage = followDialog.getByLabel('Follow message');
  assert.equal(await followMessage.evaluate((el) => el.tagName), 'TEXTAREA');
  assert.equal(await followMessage.inputValue(), 'Thanks $(user) for following!');
  assert.ok((await text(followDialog)).includes('Leave it empty to post nothing in chat.'));
  assert.ok((await text(followDialog)).includes('29/500'));
  assert.equal(await isDisabled(save()), true, 'Save is disabled until something changes');
  await noLocks('follow');
  // All stored settings: closed at first; every stored field the catalog doesn't show, typed, with its raw name.
  assert.equal(await stored().evaluate((el) => el.open), false, 'All stored settings starts closed');
  assert.equal(await text(stored().locator('summary')), 'All stored settings');
  await openStored();
  assert.deepEqual(await stored().locator('.ed-key').allTextContents(),
    ['endMessage', 'endEnabled', 'minViewers', 'clipEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled', 'watchStreakEnabled', 'temporalBanMessage', 'todayFollows'],
    'every stored field except the one the catalog shows (message)');
  assert.equal(await stored().getByLabel('End message', { exact: true }).evaluate((el) => el.tagName), 'TEXTAREA', 'text → textarea');
  assert.equal(await stored().getByLabel('Delay (seconds)').getAttribute('type'), 'number', 'number → number input');
  assert.equal(await stored().getByLabel('Delay (seconds)').inputValue(), '0');
  assert.equal(await stored().getByRole('switch', { name: "Today's follows", exact: true }).isChecked(), false, 'boolean → switch');
  assert.equal(await stored().getByRole('switch', { name: 'Watch streaks on', exact: true }).isChecked(), true);
  assert.equal(await stored().getByLabel('Minimum viewers').inputValue(), '2');
  await shot('editor-follow-stored-dark-390');
  await followMessage.fill('Welcome aboard, $(user)!');
  await until(async () => !(await isDisabled(save())), 'save enabled');
  assert.ok((await text(followDialog)).includes('24/500'), 'counter follows the text');
  // Over Twitch's 500 characters: a warning, not a block.
  await followMessage.fill('x'.repeat(520));
  await followDialog.getByText("Twitch doesn't post chat messages over 500 characters.").waitFor();
  assert.ok((await text(followDialog)).includes('520/500'));
  assert.equal(await followMessage.inputValue(), 'x'.repeat(520), 'not cut at 500');
  assert.equal(await isDisabled(save()), false, 'a long message can still be saved');
  await followMessage.fill('Thanks $(user) for following!');
  await until(async () => isDisabled(save()), 'back to the stored text disables Save');
  assert.equal(await followDialog.getByText("Twitch doesn't post chat messages over 500 characters.").count(), 0);
  // Cancel sends nothing.
  await followMessage.fill('Not saved');
  await followDialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();
  assert.equal(patches().length, 0, 'cancel never saves');
  // Save sends exactly the changed message, to the owner route.
  await openEditor('Follows');
  const loadsBefore = listLoads();
  await dialog.getByLabel('Follow message').fill('Welcome aboard, $(user)!');
  await save().click();
  await closed();
  await until(async () => patches().length === 1, 'follow patch');
  assert.equal(patches()[0].path, ownerPath('es-follow'));
  assert.deepEqual(patches()[0].body, { message: 'Welcome aboard, $(user)!' });
  await page.getByText('Follows saved').waitFor();
  await until(async () => listLoads() > loadsBefore, 'list reloads');
  await until(async () => (await text(esRow('channel.follow v2'))).includes('Says “Welcome aboard, $(user)!”'), 'new Says line');
  // Focus returns to the Edit button.
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Edit Follows chat settings'), 'focus back on Edit');

  // ---------------------------------------------------------------- Follow: stored settings the site never showed
  await openEditor('Follows');
  await openStored();
  await stored().getByRole('switch', { name: "Today's follows", exact: true }).click();
  await stored().getByLabel('Timeout message').fill('$(user) took a short break.');
  await stored().locator('summary .ed-more__changed', { hasText: 'Changed' }).waitFor();
  let loads = listLoads();
  await save().click();
  await closed();
  await until(async () => patches().length === 2, 'stored settings patch');
  assert.equal(patches()[1].path, ownerPath('es-follow'));
  assert.deepEqual(patches()[1].body, { todayFollows: true, temporalBanMessage: '$(user) took a short break.' });
  await until(async () => listLoads() > loads, 'reloaded after the stored save');
  await page.waitForTimeout(300);
  await openEditor('Follows');
  await openStored();
  assert.equal(await stored().getByRole('switch', { name: "Today's follows", exact: true }).isChecked(), true, 'the saved value comes back');
  assert.equal(await stored().getByLabel('Timeout message').inputValue(), '$(user) took a short break.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- Ad break: switch + showIf
  await openEditor('Ad breaks');
  assert.ok((await text(dialog)).includes("This event is turned off, so nothing is posted until it's on."));
  const endSwitch = dialog.getByRole('switch', { name: 'Send a message when the ad break ends' });
  assert.equal(await endSwitch.isChecked(), false);
  assert.equal(await dialog.getByLabel('End message').count(), 0, 'the end message is hidden while its switch is off');
  assert.deepEqual(await fields().locator('.lf-label, .ed-toggle__label').allInnerTexts(), ['Ad break message', 'Send a message when the ad break ends'], 'catalog order');
  // The catalog's own fields (even a hidden one) never repeat under All stored settings.
  const adStored = await stored().locator('.ed-key').allTextContents();
  assert.deepEqual(adStored, ['minViewers', 'clipEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled', 'watchStreakEnabled', 'temporalBanMessage', 'todayFollows'], adStored.join(','));
  await endSwitch.click();
  await dialog.getByLabel('End message').waitFor();
  assert.equal(await dialog.getByLabel('End message').inputValue(), 'We are back!');
  await dialog.getByLabel('End message').fill('Back in a moment!');
  await shot('editor-adbreak-dark-390');
  loads = listLoads();
  await save().click();
  await closed();
  await until(async () => patches().length === 3, 'ad break patch');
  assert.equal(patches()[2].path, ownerPath('es-ad'));
  assert.deepEqual(patches()[2].body, { endEnabled: true, endMessage: 'Back in a moment!' });
  await page.getByText('Ad breaks saved').waitFor();
  // Turning it off again sends only the switch, never the hidden end message.
  await until(async () => listLoads() > loads, 'reloaded after save');
  await page.waitForTimeout(300);
  await openEditor('Ad breaks');
  assert.equal(await dialog.getByRole('switch', { name: 'Send a message when the ad break ends' }).isChecked(), true);
  await dialog.getByLabel('End message').fill('Edited while on');
  await dialog.getByRole('switch', { name: 'Send a message when the ad break ends' }).click();
  await dialog.getByLabel('End message').waitFor({ state: 'detached' });
  await save().click();
  await closed();
  await until(async () => patches().length === 4, 'ad break off patch');
  assert.deepEqual(patches()[3].body, { endEnabled: false });

  // ---------------------------------------------------------------- Raid: no field limit (delay under All stored settings)
  await openEditor('Raids');
  await noLocks('raid');
  const clip = dialog.getByRole('switch', { name: 'Show a clip' });
  assert.equal(await clip.isChecked(), true);
  const minViewers = dialog.getByLabel('Minimum viewers for announcements');
  assert.equal(await minViewers.getAttribute('type'), 'number');
  assert.equal(await minViewers.inputValue(), '2');
  const raidStored = await stored().locator('.ed-key').allTextContents();
  assert.deepEqual(raidStored, ['endMessage', 'endEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled', 'watchStreakEnabled', 'temporalBanMessage', 'todayFollows']);
  await clip.click();
  await minViewers.fill('');
  await openStored();
  const delay = stored().getByLabel('Delay (seconds)');
  await delay.fill('30');
  await save().click();
  await dialog.getByText('Enter a whole number from 0 to 1,000,000.').waitFor();
  assert.equal(await minViewers.getAttribute('aria-invalid'), 'true');
  assert.equal(patches().length, 4, 'an invalid number is never sent');
  await minViewers.fill('10');
  await shot('editor-raid-stored-dark-390');
  await save().click();
  await closed();
  await until(async () => patches().length === 5, 'raid patch');
  assert.equal(patches()[4].path, ownerPath('es-raid'));
  assert.deepEqual(patches()[4].body, { clipEnabled: false, minViewers: 10, delay: 30 });
  assert.equal(Object.keys(patches()[4].body).includes('enableClip'), false);

  // ---------------------------------------------------------------- Outgoing raid: one optional message; Escape closes
  await openEditor('Outgoing raids');
  assert.equal(await fields().locator('textarea').count(), 1);
  await dialog.getByLabel('Optional message · $(raid.channel), $(raid.login), $(raid.viewers)').waitFor();
  await page.keyboard.press('Escape');
  await closed();
  // Its test event is a channel.raid sent by this channel (the raiding side), not a made-up type.
  await page.getByRole('button', { name: 'Test Outgoing raids' }).click();
  await page.getByRole('button', { name: 'Send test event' }).click();
  await page.locator('.payload-editor').waitFor({ state: 'hidden' });
  await until(async () => !!state.lastTest, 'outgoing raid test sent');
  assert.equal(state.lastTest.subscription.type, 'channel.raid');
  assert.deepEqual(state.lastTest.subscription.condition, { from_broadcaster_user_id: '8100001' });
  assert.equal(state.lastTest.event.from_broadcaster_user_id, '8100001');

  // ---------------------------------------------------------------- Chat notifications: empty = default message
  await openEditor('Chat notifications');
  const notifText = await text(fields());
  assert.equal(notifText.split("Leave it empty to use the default message in mossy_lantern's language.").length - 1, 2, 'both messages explain the default');
  assert.ok(!notifText.includes('Leave it empty to post nothing in chat.'));
  assert.equal(await dialog.getByRole('switch', { name: 'Watch streak announcements' }).isChecked(), true);
  assert.equal(await dialog.getByRole('switch', { name: 'Moderator anniversary announcements' }).isChecked(), true);
  await dialog.getByLabel('Streak message').waitFor();
  await dialog.getByLabel('Moderator anniversary message').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- Unused duplicates: editable, and say they're not used
  await openEditor('unused Follows', 'Follows');
  assert.ok((await text(dialog.locator('.ed-lead'))).includes("Not used: the bot reads the other Follows subscription, so changes here don't show in chat."));
  assert.equal(await dialog.getByLabel('Follow message').inputValue(), 'DUPLICATE FOLLOW ROW');
  await dialog.getByLabel('Follow message').fill('Old row text');
  await save().click();
  await closed();
  await until(async () => patches().length === 6, 'duplicate patch');
  assert.equal(patches()[5].path, ownerPath('es-follow-dup'));
  assert.deepEqual(patches()[5].body, { message: 'Old row text' });
  await openEditor('unused Bits', 'Bits');
  assert.equal(await text(dialog.locator('.ed-type')), 'channel.cheer v1');
  assert.equal(await bits().count(), 0, 'the Bits rules live on the Bits subscription the bot reads');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- No catalog entry: its stored fields, open from the start
  await openEditor('channel.goal.begin');
  assert.equal(await text(dialog.locator('.ed-stored-note')), 'No chat settings on the site for this event. These are its stored fields.');
  assert.equal(await stored().evaluate((el) => el.open), true, 'All stored settings is open by default');
  assert.equal(await fields().count(), 0, 'no catalog controls');
  assert.deepEqual(await stored().locator('.ed-key').allTextContents(), ['message', 'endMessage', 'endEnabled', 'minViewers', 'clipEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled', 'watchStreakEnabled', 'temporalBanMessage', 'todayFollows']);
  assert.equal(await isDisabled(save()), true);
  await noLocks('goal');
  await shot('editor-goal-dark-390');
  let goalPatches = patches().length;
  await stored().getByLabel('Chat message', { exact: true }).fill('A new goal just started!');
  await save().click();
  await closed();
  await until(async () => patches().length === goalPatches + 1, 'goal stored patch');
  assert.equal(patches().at(-1).path, ownerPath('es-goal'));
  assert.deepEqual(patches().at(-1).body, { message: 'A new goal just started!' }, 'only the changed field');
  await page.getByText('channel.goal.begin saved').waitFor();

  // ---------------------------------------------------------------- Bits: the shared rules section, no site link
  await openEditor('Bits');
  await noLocks('bits');
  await bits().locator('.br-list').waitFor();
  assert.equal(count((r) => r.method === 'GET' && r.path === '/bits-rules/8100001'), 1, 'rules load when the Bits dialog opens');
  assert.equal((await text(dialog)).split('Shared with Overlay Studio: changes apply to chat and alerts.').length - 1, 1, 'said once');
  assert.equal(await text(bits().locator('.br-count')), '3');
  assert.deepEqual(await bits().locator('.br-name').allInnerTexts(), ['Nice', '100–499 bits', 'Big cheer'], 'lowest amount first');
  const nice = await text(ruleItem('Nice'));
  assert.ok(nice.includes('69 bits') && nice.includes('No chat message') && nice.includes('No alert'), nice);
  assert.equal(await ruleItem('Nice').evaluate((el) => el.classList.contains('br-item--off')), true);
  assert.equal(await bits().getByRole('switch', { name: 'Bits rule Nice on' }).isChecked(), false);
  const small = await text(ruleItem('100–499 bits'));
  assert.ok(small.includes('Says “Thanks $(user) for the $(bits) bits!”') && small.includes('Alert'), small);
  const big = await text(ruleItem('Big cheer'));
  assert.ok(big.includes('1,000+ bits') && big.includes('Default message') && big.includes('Alert · 2 Studio looks'), big);
  await shot('editor-bits-rules-dark-390');
  const ownerPatchesBefore = patches().length;

  // Add: the API's error shows inline in the form, then the exact body.
  await bits().getByRole('button', { name: 'Add rule' }).click();
  const ruleForm = bits().locator('.br-form');
  await ruleForm.waitFor();
  assert.equal(await isDisabled(bits().getByRole('button', { name: 'Edit Bits rule Big cheer' })), true, 'one form at a time');
  await ruleForm.getByLabel('From (bits)').fill('500');
  await ruleForm.getByLabel('To (bits)').fill('999');
  await ruleForm.getByLabel('In chat').selectOption('custom');
  await ruleForm.getByLabel('Message', { exact: true }).waitFor();
  await ruleForm.getByRole('button', { name: 'Add rule' }).click();
  await ruleForm.locator('[role="alert"]', { hasText: 'Write the chat message, or choose the default message' }).waitFor();
  assert.equal(bitsWrites().length, 1);
  assert.equal(bitsWrites()[0].method, 'POST');
  assert.equal(bitsWrites()[0].path, '/bits-rules/8100001/rules');
  assert.deepEqual(bitsWrites()[0].body, { name: '', enabled: true, min: 500, max: 999, chat: { mode: 'custom', message: '' }, alert: true });
  await shot('bits-add-error-dark-390');
  await ruleForm.getByLabel('Message', { exact: true }).fill('Big thanks $(user)!');
  await ruleForm.getByRole('button', { name: 'Add rule' }).click();
  await ruleForm.waitFor({ state: 'detached' });
  assert.deepEqual(bitsWrites()[1].body, { name: '', enabled: true, min: 500, max: 999, chat: { mode: 'custom', message: 'Big thanks $(user)!' }, alert: true });
  await ruleItem('500–999 bits').waitFor();
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Edit Bits rule 500–999 bits'), 'focus on the new rule');
  assert.equal(await text(bits().locator('.br-count')), '4', 'the list is the state the API answered');
  assert.equal(await bits().locator('p[role="status"]').innerText(), 'Rule added.');

  // Edit: only the changed fields.
  await bits().getByRole('button', { name: 'Edit Bits rule 100–499 bits' }).click();
  const editForm = bits().locator('.br-form');
  await editForm.waitFor();
  assert.equal(await editForm.getByLabel('From (bits)').inputValue(), '100');
  assert.equal(await editForm.getByLabel('To (bits)').inputValue(), '499');
  assert.equal(await editForm.getByLabel('In chat').inputValue(), 'custom');
  assert.equal(await editForm.getByLabel('Message', { exact: true }).inputValue(), 'Thanks $(user) for the $(bits) bits!');
  assert.equal(await editForm.getByRole('switch', { name: 'Play the overlay alert' }).isChecked(), true);
  await editForm.getByLabel('Name').fill('Small cheer');
  await editForm.getByRole('switch', { name: 'Play the overlay alert' }).click();
  await editForm.getByRole('button', { name: 'Save rule' }).click();
  await editForm.waitFor({ state: 'detached' });
  assert.equal(bitsWrites()[2].method, 'PATCH');
  assert.equal(bitsWrites()[2].path, '/bits-rules/8100001/rules/rule-small');
  assert.deepEqual(bitsWrites()[2].body, { name: 'Small cheer', alert: false });
  const smallAfter = await text(ruleItem('Small cheer'));
  assert.ok(smallAfter.includes('100–499 bits') && smallAfter.includes('No alert'), smallAfter);

  // On/off from the row; a failed one goes back and says so.
  await bits().getByRole('switch', { name: 'Bits rule Nice on' }).click();
  await until(async () => bitsWrites().length === 4, 'rule on');
  assert.equal(bitsWrites()[3].path, '/bits-rules/8100001/rules/rule-nice');
  assert.deepEqual(bitsWrites()[3].body, { enabled: true });
  await until(async () => !(await ruleItem('Nice').evaluate((el) => el.classList.contains('br-item--off'))), 'rule shown on');
  state.bitsFail = { status: 500, message: 'Bits rules are temporarily unavailable' };
  await bits().getByRole('switch', { name: 'Bits rule Nice on' }).click();
  await bits().locator('[role="alert"]', { hasText: "Couldn't turn Nice off." }).waitFor();
  assert.deepEqual(bitsWrites()[4].body, { enabled: false });
  await until(async () => bits().getByRole('switch', { name: 'Bits rule Nice on' }).isChecked(), 'switch goes back on');

  // Delete: confirm first, and say which Overlay Studio looks use the rule.
  await bits().getByRole('button', { name: 'Edit Bits rule Big cheer' }).click();
  const deleteForm = bits().locator('.br-form');
  await deleteForm.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = deleteForm.locator('.br-confirm');
  await until(async () => page.evaluate(() => document.activeElement?.textContent?.trim() === 'Keep it'), 'focus moves into the delete question');
  assert.equal(await text(confirm), 'Delete “Big cheer”? These cheers go back to the default message and alert. 2 Studio looks in Overlay Studio use this rule and will stop playing. Keep it Delete rule');
  await shot('bits-delete-confirm-dark-390');
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(bitsWrites().length, 5, 'Keep it sends nothing');
  await deleteForm.getByRole('button', { name: 'Delete', exact: true }).click();
  await deleteForm.getByRole('button', { name: 'Delete rule' }).click();
  await deleteForm.waitFor({ state: 'detached' });
  assert.equal(bitsWrites()[5].method, 'DELETE');
  assert.equal(bitsWrites()[5].path, '/bits-rules/8100001/rules/rule-big');
  assert.equal(bitsWrites()[5].body, null);
  await until(async () => (await ruleItem('Big cheer').count()) === 0, 'rule gone');
  assert.deepEqual(state.bits.rules.map((rule) => rule.id), ['rule-small', 'rule-nice', 'rule-new1']);
  assert.equal(patches().length, ownerPatchesBefore, 'rule changes never save the subscription');

  // The event's own message still saves through the owner route, never with cheerTiers.
  assert.equal(await dialog.getByLabel('Default message').inputValue(), LONG_BITS);
  await dialog.getByLabel('Default message').fill('Thanks $(user) for $(bits) bits!');
  await save().click();
  await closed();
  await until(async () => patches().length === ownerPatchesBefore + 1, 'bits patch');
  assert.equal(patches().at(-1).path, ownerPath('es-bits'));
  assert.deepEqual(patches().at(-1).body, { message: 'Thanks $(user) for $(bits) bits!' });

  // ---------------------------------------------------------------- Escape closes the topmost layer first
  await page.waitForTimeout(300);
  await openEditor('Bits');
  await bits().locator('.br-list').waitFor();
  const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() || '');
  const writesBeforeEscape = bitsWrites().length;
  await bits().getByRole('button', { name: 'Edit Bits rule Small cheer' }).click();
  const escForm = bits().locator('.br-form');
  await escForm.waitFor();
  await escForm.getByRole('button', { name: 'Delete', exact: true }).click();
  await escForm.locator('.br-confirm').waitFor();
  await page.keyboard.press('Escape');
  await escForm.locator('.br-confirm').waitFor({ state: 'detached' });
  assert.equal(await escForm.count(), 1, 'the delete question closes, the form stays');
  assert.equal(await dialog.isVisible(), true);
  await until(async () => (await activeLabel()) === 'Delete', 'focus back on Delete');
  await page.keyboard.press('Escape');
  await escForm.waitFor({ state: 'detached' });
  assert.equal(await dialog.isVisible(), true, 'the form closes, the dialog stays');
  await until(async () => (await activeLabel()) === 'Edit Bits rule Small cheer', 'focus back on the rule');
  await bits().getByRole('button', { name: 'Add rule' }).click();
  await escForm.waitFor();
  await escForm.getByLabel('From (bits)').fill('5');
  await page.keyboard.press('Escape');
  await escForm.waitFor({ state: 'detached' });
  assert.equal(await dialog.isVisible(), true);
  await until(async () => (await activeLabel()) === 'Add rule', 'focus back on Add rule');
  assert.equal(bitsWrites().length, writesBeforeEscape, 'Escape never saves a rule');
  // With no layer open, the next Escape closes the dialog.
  const patchesBeforeClose = patches().length;
  await page.keyboard.press('Escape');
  await closed();
  await page.waitForTimeout(150);
  assert.equal(patches().length, patchesBeforeClose, 'closing sends nothing');

  // ---------------------------------------------------------------- A 400 stays in the dialog; Escape waits while saving
  await openEditor('Stream goes live');
  await dialog.getByLabel('Stream started message').fill('$(twitch.channel) is live!');
  state.patchFail = { status: 400, message: 'Invalid message' };
  await save().click();
  await dialog.locator('.lf-warning', { hasText: 'Invalid message' }).waitFor();
  assert.equal(await dialog.isVisible(), true, 'the dialog stays open');
  assert.equal(await dialog.getByLabel('Stream started message').inputValue(), '$(twitch.channel) is live!', 'the edit is kept');
  assert.equal(await isDisabled(save()), false, 'Save can be tried again');
  assert.equal(await page.getByText('Stream goes live saved').count(), 0);
  await shot('editor-400-dark-390');
  state.patchDelay = 1200;
  await save().click();
  await dialog.getByText('Saving…').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await dialog.isVisible(), true, 'Escape does nothing while saving');
  await closed();
  state.patchDelay = 0;
  assert.deepEqual(patches().at(-1).body, { message: '$(twitch.channel) is live!' });
  await page.getByText('Stream goes live saved').waitFor();

  // ---------------------------------------------------------------- Quick switches: owner route, go-live can be turned off
  let patchCount = patches().length;
  await esRow('stream.online v1').getByRole('switch', { name: 'Stream goes live on', exact: true }).click();
  await until(async () => patches().length === patchCount + 1, 'go-live switch');
  assert.equal(patches().at(-1).path, ownerPath('es-online'));
  assert.deepEqual(patches().at(-1).body, { enabled: false });
  await page.getByText('Stream goes live turned off').waitFor();
  await page.getByText('3 of 9 events need attention').waitFor();
  assert.equal(state.rows.find((row) => row.id === 'es-online').enabled, false, 'the site refuses this; the owner route saves it');
  patchCount = patches().length;
  await goal.getByRole('switch').click();
  await until(async () => patches().length === patchCount + 1, 'goal switch');
  assert.equal(patches().at(-1).path, ownerPath('es-goal'));
  assert.deepEqual(patches().at(-1).body, { enabled: false });
  assert.equal(sitePatches(), 0, "the site's own PATCH is never used");

  // ---------------------------------------------------------------- Catalog failure: the list still works
  state.catalogFail = true;
  await goto('/channels/8100001/eventsubs');
  await page.locator('.es-summary').waitFor();
  await page.getByText("Couldn't load the chat settings", { exact: false }).waitFor();
  assert.equal(await page.locator('.es-says').count(), 0);
  // Edit still opens: the stored fields, open, with a note saying why.
  await until(async () => (await page.getByRole('button', { name: /^Edit / }).count()) > 0, 'Edit without the catalog');
  await openEditor('Follows');
  assert.equal(await text(dialog.locator('.ed-stored-note')), "The site's chat settings didn't load, so these are its stored fields.");
  assert.equal(await stored().evaluate((el) => el.open), true);
  assert.deepEqual(await stored().locator('.ed-key').allTextContents(), ['message', 'endMessage', 'endEnabled', 'minViewers', 'clipEnabled', 'delay', 'modiversaryMessage', 'modiversaryEnabled', 'watchStreakEnabled', 'temporalBanMessage', 'todayFollows']);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await closed();
  state.catalogFail = false;
  await page.getByRole('button', { name: 'Retry loading the chat settings' }).click();
  await until(async () => (await page.locator('.es-says').count()) > 0, 'catalog retry');

  // ---------------------------------------------------------------- Layout + accessibility
  const touchTargets = async (label) => {
    for (const target of await page.locator('dialog.ed-dialog .lf-btn, dialog.ed-dialog .ed-toggle, dialog.ed-dialog .br-toggle, dialog.ed-dialog details.ed-more > summary, dialog.ed-dialog textarea, dialog.ed-dialog select, dialog.ed-dialog input:not([type="checkbox"]), .es-row .lf-btn').all()) {
      if (!(await target.isVisible())) continue;
      const box = await target.boundingBox();
      assert.ok(box.height >= 43.5, `${label}: 44px touch target for ${await target.evaluate((el) => el.className || el.tagName)} (${box.height})`);
    }
    for (const field of await page.locator('dialog.ed-dialog textarea, dialog.ed-dialog input:not([type="checkbox"]), dialog.ed-dialog select').all()) {
      const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(size >= 16, `${label}: input font ${size}px`);
    }
  };
  const noOverflow = async (label) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${label}: horizontal overflow`);
    const dialogOverflow = await page.evaluate(() => {
      const el = document.querySelector('dialog.ed-dialog .lf-dialog__body');
      return el ? el.scrollWidth > el.clientWidth + 1 : false;
    });
    assert.equal(dialogOverflow, false, `${label}: dialog overflow`);
  };
  const axe = async (label) => {
    const result = await new AxeBuilder({ page }).include('app-channel-shell').include('app-navbar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${label}: axe`);
  };
  for (const mode of ['dark', 'light']) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      const label = `${mode} ${width}`;
      await loadList();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label}: theme`);
      await noOverflow(`${label} list`);
      if (width < 960) await touchTargets(`${label} list`);
      await axe(`${label} list`);
      await shot(`list-${mode}-${width}`);
      // Ad breaks with its dependent field shown and All stored settings open.
      await openEditor('Ad breaks');
      await dialog.getByRole('switch', { name: 'Send a message when the ad break ends' }).click();
      await dialog.getByLabel('End message').waitFor();
      await openStored();
      const box = await dialog.boundingBox();
      if (width < 640) {
        assert.ok(Math.abs(box.width - width) <= 1 && Math.abs(box.y + box.height - (await page.evaluate(() => window.innerHeight))) <= 1, `${label}: bottom sheet (${JSON.stringify(box)})`);
        await touchTargets(`${label} dialog`);
      } else {
        assert.ok(box.width <= 577 && box.x > 100, `${label}: centred card (${JSON.stringify(box)})`);
      }
      await noOverflow(`${label} dialog`);
      await axe(`${label} dialog`);
      await shot(`editor-${mode}-${width}`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await closed();
      // The Bits dialog with its rules and the add form open, in every layout too.
      await openEditor('Bits');
      await bits().locator('.br-list').waitFor();
      await bits().getByRole('button', { name: 'Add rule' }).click();
      await bits().locator('.br-form').waitFor();
      await bits().getByLabel('In chat').selectOption('custom');
      await bits().getByLabel('Message', { exact: true }).waitFor();
      await noOverflow(`${label} bits dialog`);
      if (width < 640) await touchTargets(`${label} bits dialog`);
      await axe(`${label} bits dialog`);
      await shot(`editor-bits-${mode}-${width}`);
      await dialog.locator('.lf-dialog__foot').getByRole('button', { name: 'Cancel', exact: true }).click();
      await closed();
      // A type without catalog controls: All stored settings open.
      await openEditor('channel.goal.begin');
      await noOverflow(`${label} goal dialog`);
      if (width < 640) await touchTargets(`${label} goal dialog`);
      await axe(`${label} goal dialog`);
      if (width !== 320) await shot(`editor-goal-${mode}-${width}`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await closed();
    }
  }
  assert.equal(sitePatches(), 0, "the site's own PATCH is never used");

  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin Twitch events editing (owner route, no locks): Says lines (message / posts nothing / default message / muted when off / one-line clamp), outgoing raid matched by the site's type name, first stored row wins and the canonical Bits row beats an old cheer row (duplicates listed as not used, editable with their own labels), Other subscriptions (switch), Edit on every stored row (no catalog entry → All stored settings open + note, catalog failure → stored fields), editor text + counter + empty hints, 500-character warning that doesn't block, All stored settings (every other stored field, typed, raw names, todayFollows/temporalBanMessage saved and read back), number validation, switches, showIf hidden + not sent, exact owner PATCH bodies (follow message, stored fields, ad break end, raid clipEnabled/minViewers/delay, unused duplicate, Bits message without cheerTiers, quick switches incl. turning off go-live), Bits rules (list, add with API error inline, edit only changed fields, on/off + failed rollback, delete with Studio looks warning + confirm, exact bodies), Escape closes the delete question → rule form → dialog with focus back, no site links or "Also set on the site", 400 inline + dialog kept, Escape (not while saving), outgoing raid test payload, catalog failure + retry, 320/390/1280 dark+light overflow/axe/touch targets/16px inputs/bottom sheet. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
