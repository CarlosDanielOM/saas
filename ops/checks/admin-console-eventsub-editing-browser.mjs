// Admin channel workspace, Twitch events tab (/channels/:id/eventsubs): what each event says in chat and the
// editor for its chat settings. Every API call is mocked on both api.domdimabot.com and localhost:3000, so no
// PATCH can reach production. The chat event catalog copies the real shapes (dimabot/src/utils/chat_event_catalog.ts
// plus the stored catalog controls for follows, go-live, ad breaks and Bits).
// Covers the "Says …" lines (message, posts nothing, default message, muted when off), the merge by the site's type
// name (outgoing raid matches its standard entry, first stored row wins, "Other subscriptions"), the editor per
// control type (text + counter + empty hint, number, switch, showIf, Bits rules note), the exact PATCH bodies
// (only changed catalog fields: never cheerTiers, never hidden dependent fields), inline validation, 403 kept in
// the dialog, Escape (not while saving), the outgoing raid's test event, and layout + accessibility at
// 320/390/1280 in dark and light.
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

const settings = (overrides = {}) => ({ message: '', endMessage: '', endEnabled: false, minViewers: 2, clipEnabled: false, delay: 0, modiversaryMessage: '', modiversaryEnabled: true, watchStreakEnabled: true, ...overrides });
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

function newState() {
  return { rows: newRows(), patchFail: null, patchDelay: 0, catalogFail: false };
}

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
    }
    if (method === 'GET' && path === '/eventsubs/standard') return ok({ standardTypes });
    if (method === 'GET' && path === '/site/events') return state.catalogFail ? { status: 500, body: { error: true, message: 'Internal server error', status: 500 } } : { status: 200, body: { error: false, data: catalog } };
    if (method === 'PATCH' && (m = path.match(/^\/eventsubs\/8100001\/([\w-]+)$/))) {
      if (state.patchFail) {
        const failure = state.patchFail;
        state.patchFail = null;
        return { status: failure.status, body: { error: true, message: failure.message, status: failure.status } };
      }
      const row = state.rows.find((candidate) => candidate.id === m[1]);
      if (!row) return { status: 404, body: { error: 'Not Found', message: 'Eventsub not found', status: 404 } };
      for (const [key, value] of Object.entries(body ?? {})) {
        if (key === 'enabled') row.enabled = value;
        else row.settings[key] = value;
      }
      row.message = row.settings.message;
      row.endMessage = row.settings.endMessage;
      return { status: 200, body: { error: false, message: 'Eventsub updated', status: 200, data: { _id: row.id } } };
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
const patches = () => requests.filter((r) => r.method === 'PATCH');
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
  const openEditor = async (name) => {
    await page.getByRole('button', { name: `Edit ${name} chat settings` }).click();
    await dialog.waitFor();
    await settle();
    await page.getByRole('dialog', { name: `${name} in chat` }).waitFor();
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
  assert.equal(await followDup.getByRole('button', { name: /^Edit/ }).count(), 0, 'no Edit on a row the bot never reads');
  // Bits: the current channel.bits.use row wins over an older channel.cheer row listed first (as the bot reads them).
  assert.ok((await text(esRow('channel.bits.use v1'))).includes(LONG_BITS.slice(0, 20)), 'the canonical Bits row is the one shown');
  assert.ok(!(await text(esRow('channel.bits.use v1'))).includes('OLD CHEER ROW'));
  assert.equal(await esRow('channel.cheer v1', { duplicate: true }).count(), 1, 'the old cheer row is listed by its stored type, marked not used');
  assert.ok((await text(esRow('stream.online v1'))).includes('Posts nothing in chat'));
  assert.ok((await text(esRow('channel.chat.notification v1'))).includes('Uses the default message'));
  assert.ok((await text(esRow('channel.raid v1'))).includes('Says “$(raid.channel) is raiding with $(raid.viewers) viewers!”'));
  assert.equal(await esRow('channel.chat.message v1').locator('.es-says').count(), 0, 'no chat settings, no Says line');
  assert.equal(await esRow('channel.chat.message v1').getByRole('button', { name: /^Edit/ }).count(), 0, 'no chat settings, no Edit');
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
  // Other subscriptions: same row template, no Connect, Edit only where the catalog has chat settings.
  const others = group('Other subscriptions');
  assert.equal(await others.locator('.es-row').count(), 4, 'goal + shoutout + the two unused duplicates');
  const goal = esRow('channel.goal.begin v1');
  assert.ok((await text(goal)).includes('On'));
  assert.equal(await goal.getByRole('button', { name: /^Connect/ }).count(), 0);
  assert.equal(await goal.getByRole('button', { name: /^Edit/ }).count(), 0);
  assert.equal(await goal.getByRole('switch').count(), 1);
  assert.equal(await others.locator('.es-type', { hasText: 'channel.goal.begin v1' }).count(), 1, 'the goal subscription is under Other subscriptions');
  assert.equal(await esRow('channel.shoutout.receive v1').getByRole('button', { name: 'Edit Shoutouts received chat settings' }).count(), 1);
  assert.ok((await text(esRow('channel.shoutout.receive v1'))).includes('Says “$(shoutout.channel) sent us a shoutout!”'));
  await shot('list-dark-390');

  // ---------------------------------------------------------------- Follow: text field, counter, exact body
  await openEditor('Follows');
  const followDialog = page.getByRole('dialog', { name: 'Follows in chat' });
  assert.ok((await text(followDialog.locator('.lf-dialog__body p').first())).startsWith("Changes apply to mossy_lantern's chat right away. mossy_lantern isn't notified."));
  const followMessage = followDialog.getByLabel('Follow message');
  assert.equal(await followMessage.evaluate((el) => el.tagName), 'TEXTAREA');
  assert.equal(await followMessage.inputValue(), 'Thanks $(user) for following!');
  assert.ok((await text(followDialog)).includes('Leave it empty to post nothing in chat.'));
  assert.ok((await text(followDialog)).includes('29/500'));
  assert.equal(await isDisabled(save()), true, 'Save is disabled until something changes');
  await followMessage.fill('Welcome aboard, $(user)!');
  await until(async () => !(await isDisabled(save())), 'save enabled');
  assert.ok((await text(followDialog)).includes('24/500'), 'counter follows the text');
  await followMessage.fill('Thanks $(user) for following!');
  await until(async () => isDisabled(save()), 'back to the stored text disables Save');
  // Cancel sends nothing.
  await followMessage.fill('Not saved');
  await followDialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();
  assert.equal(patches().length, 0, 'cancel never saves');
  // Save sends exactly the changed message.
  await openEditor('Follows');
  const loadsBefore = listLoads();
  await dialog.getByLabel('Follow message').fill('Welcome aboard, $(user)!');
  await save().click();
  await closed();
  await until(async () => patches().length === 1, 'follow patch');
  assert.equal(patches()[0].path, '/eventsubs/8100001/es-follow');
  assert.deepEqual(patches()[0].body, { message: 'Welcome aboard, $(user)!' });
  await page.getByText('Follows saved').waitFor();
  await until(async () => listLoads() > loadsBefore, 'list reloads');
  await until(async () => (await text(esRow('channel.follow v2'))).includes('Says “Welcome aboard, $(user)!”'), 'new Says line');
  // Focus returns to the Edit button.
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Edit Follows chat settings'), 'focus back on Edit');

  // ---------------------------------------------------------------- Ad break: switch + showIf
  await openEditor('Ad breaks');
  assert.ok((await text(dialog)).includes("This event is turned off, so nothing is posted until it's on."));
  const endSwitch = dialog.getByRole('switch', { name: 'Send a message when the ad break ends' });
  assert.equal(await endSwitch.isChecked(), false);
  assert.equal(await dialog.getByLabel('End message').count(), 0, 'the end message is hidden while its switch is off');
  assert.deepEqual(await dialog.locator('.lf-label, .ed-toggle > span:first-child').allInnerTexts(), ['Ad break message', 'Send a message when the ad break ends'], 'catalog order');
  await endSwitch.click();
  await dialog.getByLabel('End message').waitFor();
  assert.equal(await dialog.getByLabel('End message').inputValue(), 'We are back!');
  await dialog.getByLabel('End message').fill('Back in a moment!');
  await shot('editor-adbreak-dark-390');
  let loads = listLoads();
  await save().click();
  await closed();
  await until(async () => patches().length === 2, 'ad break patch');
  assert.equal(patches()[1].path, '/eventsubs/8100001/es-ad');
  assert.deepEqual(patches()[1].body, { endEnabled: true, endMessage: 'Back in a moment!' });
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
  await until(async () => patches().length === 3, 'ad break off patch');
  assert.deepEqual(patches()[2].body, { endEnabled: false });

  // ---------------------------------------------------------------- Raid: number + switch saved under their stored names
  await openEditor('Raids');
  const clip = dialog.getByRole('switch', { name: 'Show a clip' });
  assert.equal(await clip.isChecked(), true);
  const minViewers = dialog.getByLabel('Minimum viewers for announcements');
  assert.equal(await minViewers.getAttribute('type'), 'number');
  assert.equal(await minViewers.inputValue(), '2');
  await clip.click();
  await minViewers.fill('');
  await save().click();
  await dialog.getByText('Enter a whole number of 0 or more.').waitFor();
  assert.equal(await minViewers.getAttribute('aria-invalid'), 'true');
  assert.equal(patches().length, 3, 'an invalid number is never sent');
  await minViewers.fill('10');
  await save().click();
  await closed();
  await until(async () => patches().length === 4, 'raid patch');
  assert.equal(patches()[3].path, '/eventsubs/8100001/es-raid');
  assert.deepEqual(patches()[3].body, { clipEnabled: false, minViewers: 10 });
  assert.equal(Object.keys(patches()[3].body).includes('enableClip'), false);

  // ---------------------------------------------------------------- Outgoing raid: one optional message; Escape closes
  await openEditor('Outgoing raids');
  assert.equal(await dialog.locator('textarea').count(), 1);
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
  const notifText = await text(dialog);
  assert.equal(notifText.split("Leave it empty to use the default message in mossy_lantern's language.").length - 1, 2, 'both messages explain the default');
  assert.ok(!notifText.includes('Leave it empty to post nothing in chat.'));
  assert.equal(await dialog.getByRole('switch', { name: 'Watch streak announcements' }).isChecked(), true);
  assert.equal(await dialog.getByRole('switch', { name: 'Moderator anniversary announcements' }).isChecked(), true);
  await dialog.getByLabel('Streak message').waitFor();
  await dialog.getByLabel('Moderator anniversary message').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- Bits: rules note, cheerTiers never sent
  await openEditor('Bits');
  const rules = dialog.locator('.ed-site', { hasText: 'Bits rules' });
  assert.match(await text(rules), /3 Bits rules · edit on domdimabot\.com/);
  const rulesLink = rules.getByRole('link', { name: /edit on domdimabot\.com/ });
  assert.equal(await rulesLink.getAttribute('href'), 'https://domdimabot.com/mossy_lantern/modules/chat-events');
  assert.equal(await rulesLink.getAttribute('target'), '_blank');
  assert.match(await rulesLink.getAttribute('rel'), /noopener/);
  assert.equal(await dialog.getByLabel('Default message').inputValue(), LONG_BITS);
  await dialog.getByLabel('Default message').fill('Thanks $(user) for $(bits) bits!');
  await save().click();
  await closed();
  await until(async () => patches().length === 5, 'bits patch');
  assert.equal(patches()[4].path, '/eventsubs/8100001/es-bits');
  assert.deepEqual(patches()[4].body, { message: 'Thanks $(user) for $(bits) bits!' });

  // ---------------------------------------------------------------- 403 stays in the dialog; Escape waits while saving
  await openEditor('Stream goes live');
  await dialog.getByLabel('Stream started message').fill('$(twitch.channel) is live!');
  state.patchFail = { status: 403, message: 'This event requires premium plan' };
  await save().click();
  await dialog.locator('.lf-warning', { hasText: 'This event requires premium plan' }).waitFor();
  assert.equal(await dialog.isVisible(), true, 'the dialog stays open');
  assert.equal(await dialog.getByLabel('Stream started message').inputValue(), '$(twitch.channel) is live!', 'the edit is kept');
  assert.equal(await isDisabled(save()), false, 'Save can be tried again');
  assert.equal(await page.getByText('Stream goes live saved').count(), 0);
  await shot('editor-403-dark-390');
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

  // ---------------------------------------------------------------- Other subscription: switch still works
  const patchCount = patches().length;
  await goal.getByRole('switch').click();
  await until(async () => patches().length === patchCount + 1, 'goal switch');
  assert.equal(patches().at(-1).path, '/eventsubs/8100001/es-goal');
  assert.deepEqual(patches().at(-1).body, { enabled: false });

  // ---------------------------------------------------------------- Catalog failure: the list still works
  state.catalogFail = true;
  await goto('/channels/8100001/eventsubs');
  await page.locator('.es-summary').waitFor();
  await page.getByText("Couldn't load the chat settings", { exact: false }).waitFor();
  assert.equal(await page.locator('.es-says').count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Edit / }).count(), 0);
  state.catalogFail = false;
  await page.getByRole('button', { name: 'Retry loading the chat settings' }).click();
  await until(async () => (await page.locator('.es-says').count()) > 0, 'catalog retry');

  // ---------------------------------------------------------------- Layout + accessibility
  const touchTargets = async (label) => {
    for (const target of await page.locator('dialog.ed-dialog .lf-btn, dialog.ed-dialog .ed-toggle, dialog.ed-dialog textarea, dialog.ed-dialog input:not([type="checkbox"]), dialog.ed-dialog .ed-site a, .es-row .lf-btn').all()) {
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
      await openEditor('Ad breaks');
      await dialog.getByRole('switch', { name: 'Send a message when the ad break ends' }).click();
      await dialog.getByLabel('End message').waitFor();
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
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await closed();
      // The Bits dialog (rules note + link) in every layout too.
      await openEditor('Bits');
      await noOverflow(`${label} bits dialog`);
      if (width < 640) await touchTargets(`${label} bits dialog`);
      await axe(`${label} bits dialog`);
      if (width !== 320) await shot(`editor-bits-${mode}-${width}`);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await closed();
    }
  }

  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin Twitch events editing: Says lines (message / posts nothing / default message / muted when off / one-line clamp), outgoing raid matched by the site's type name, first stored row wins and the canonical Bits row beats an old cheer row (duplicates listed as not used), Other subscriptions (switch, Edit only with chat settings), editor text + counter + empty hints, number validation, switches, showIf hidden + not sent, exact PATCH bodies (follow message, ad break end, raid clipEnabled/minViewers, Bits without cheerTiers), Bits rules link, 403 inline + dialog kept, Escape (not while saving), outgoing raid test payload, catalog failure + retry, 320/390/1280 dark+light overflow/axe/touch targets/16px inputs/bottom sheet. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
