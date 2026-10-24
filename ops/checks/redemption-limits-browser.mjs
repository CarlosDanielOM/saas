/**
 * Browser check for Redemptions (stable): Twitch-side limits, live state and pause.
 * Every API call is mocked in the browser (in-memory DB + Twitch copies); nothing reaches production.
 * - Rows show cooldown / per-viewer / per-stream tags and live state (x/N this stream, sold out, ready in).
 * - Pause/resume one reward and "Pause all" / "Resume all" send isPaused only.
 * - Editor "Limits" step: loads Twitch values, presets, units, summary sentence, clash validation,
 *   saves maxPerStream / maxPerUserPerStream / cooldown seconds; create sends limits, never isPaused.
 * - If Twitch's copy fails to load, limits are locked and omitted from the save.
 * - Twitch duplicate-name error shows in plain words. Spanish strings. axe (dark + light),
 *   no horizontal overflow at 320/390, screenshots when SAAS_SCREENSHOT_DIR is set.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/node_modules/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/node_modules/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const api = 'https://api.domdimabot.com';
const user = { id: '991505', login: 'rewards_owner', display_name: 'Rewards_Owner' };
const app = { name: 'Rewards_Owner', email: 'rewards@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true,
  twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };

const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
function seed() {
  const twitch = (id, title, cost, extra = {}) => ({
    id, broadcaster_id: user.id, broadcaster_login: user.login, title, prompt: `${title} prompt`, cost, is_enabled: true,
    background_color: '#9146FF', is_user_input_required: false, is_paused: false, is_in_stock: true,
    should_redemptions_skip_request_queue: false, image: null, default_image: null,
    max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
    max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
    global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
    redemptions_redeemed_current_stream: null, cooldown_expires_at: null, ...extra });
  const db = (t) => ({ _id: `db-${t.id}`, eventsubID: `sub-${t.id}`, channelID: user.id, channel: user.login, rewardID: t.id, title: t.title,
    type: 'custom', prompt: t.prompt, cost: t.cost, originalCost: t.cost, isEnabled: t.is_enabled, message: '', costChange: 0,
    returnToOriginalCost: false, duration: 0, cooldown: t.global_cooldown_setting.is_enabled ? t.global_cooldown_setting.global_cooldown_seconds : 0 });
  const live = [
    twitch('r-hydrate', 'Hydrate', 500, {
      max_per_stream_setting: { is_enabled: true, max_per_stream: 10 },
      max_per_user_per_stream_setting: { is_enabled: true, max_per_user_per_stream: 2 },
      global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 300 },
      redemptions_redeemed_current_stream: 3 }),
    twitch('r-sold', 'Song request', 1000, { max_per_stream_setting: { is_enabled: true, max_per_stream: 5 }, redemptions_redeemed_current_stream: 5, is_in_stock: false }),
    twitch('r-cool', 'Jump scare', 2000, { global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 600 }, cooldown_expires_at: soon(130) }),
    twitch('r-plain', 'Posture check', 100),
  ];
  return { live, rows: live.map(db), twitchOnly: [twitch('t-native', 'Made on Twitch', 50)] };
}

function applyPatch(t, body) {
  if ('isPaused' in body) t.is_paused = body.isPaused;
  if ('isEnabled' in body) t.is_enabled = body.isEnabled;
  if ('maxPerStream' in body) t.max_per_stream_setting = { is_enabled: body.maxPerStream > 0, max_per_stream: body.maxPerStream || t.max_per_stream_setting.max_per_stream };
  if ('maxPerUserPerStream' in body) t.max_per_user_per_stream_setting = { is_enabled: body.maxPerUserPerStream > 0, max_per_user_per_stream: body.maxPerUserPerStream || t.max_per_user_per_stream_setting.max_per_user_per_stream };
  if ('cooldown' in body) t.global_cooldown_setting = { is_enabled: body.cooldown > 0, global_cooldown_seconds: body.cooldown };
  for (const key of ['title', 'prompt', 'cost', 'background_color']) if (key in body) t[key] = body[key];
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });

async function open({ theme = 'dark', width = 1280, language = 'en', twitchFails = false } = {}) {
  const state = seed();
  const calls = [];
  const localizedApp = { ...app, language };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    sessionStorage.clear();
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app: localizedApp, theme, language });
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith(`/${user.login}/`)) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = (data, extra = {}) => route.fulfill({ json: { error: false, status: 200, data, ...extra } });
    const path = url.pathname;
    if (path.startsWith('/auth/access/')) return route.fulfill({ json: { error: false, data: { allowed: true, role: 'owner', planTier: 'pro' } } });
    if (path === '/auth/session') return ok({ twitch: user, app: localizedApp });
    if (path.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'pro' });
    if (path === `/rewards/twitch/${user.id}`) {
      if (twitchFails) return route.fulfill({ status: 500, json: { error: true, message: 'Twitch down', status: 500 } });
      return ok([...state.live, ...state.twitchOnly]);
    }
    if (path === `/rewards/${user.id}` && method === 'GET') return ok(state.rows, { total: state.rows.length });
    if (path === `/rewards/${user.id}` && method === 'POST') {
      const body = request.postDataJSON(); calls.push({ method, body });
      if (state.live.some((t) => t.title.toLowerCase() === body.title.toLowerCase())) {
        return route.fulfill({ status: 400, json: { error: true, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD', status: 400 } });
      }
      const t = { ...seed().live[3], id: `r-new-${calls.length}`, title: body.title, cost: body.cost };
      applyPatch(t, body); state.live.push(t);
      const row = { ...state.rows[3], _id: `db-${t.id}`, rewardID: t.id, title: t.title, cost: t.cost, cooldown: body.cooldown || 0 };
      state.rows.push(row);
      return route.fulfill({ status: 201, json: { error: false, data: row } });
    }
    const m = path.match(new RegExp(`^/rewards/${user.id}/([^/]+)$`));
    if (m && method === 'PATCH') {
      const body = request.postDataJSON(); calls.push({ method, id: m[1], body });
      const t = state.live.find((r) => r.id === m[1]); const row = state.rows.find((r) => r.rewardID === m[1]);
      applyPatch(t, body);
      for (const key of ['title', 'prompt', 'cost', 'cooldown', 'message', 'isEnabled']) if (key in body) row[key] = body[key];
      return ok(row, { twitch: { ...t } });
    }
    if (path.startsWith('/triggers')) return ok([]);
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && /TypeError|NG0/.test(msg.text())) errors.push(msg.text()); });
  await page.goto(`${base}/${user.login}/modules/redemptions`);
  await page.locator('.lf-reward').first().waitFor();
  return { context, page, calls, state };
}

const until = async (fn, label, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 60)); }
  assert.fail(`timed out: ${label}`);
};
const row = (page, name) => page.locator('.lf-reward').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function axe(page, label, selector = 'app-redemptions-page') {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate((sel) => window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }), selector);
  assert.deepEqual(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), [], label);
}
async function noOverflow(page, label) {
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  assert.ok(widths.doc <= widths.win + 1, `${label}: horizontal overflow ${widths.doc} > ${widths.win}`);
}
const shot = async (page, name, opts = {}) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...opts }); };

try {
  // 1. Rows show limits and live Twitch state.
  {
    const { context, page, calls } = await open();
    const hydrate = await row(page, 'Hydrate').innerText();
    assert.match(hydrate, /5 min cooldown/);
    assert.match(hydrate, /2× per viewer/);
    assert.match(hydrate, /3\/10 this stream/);
    assert.match(await row(page, 'Song request').innerText(), /Sold out this stream[\s\S]*5\/5 this stream/);
    assert.match(await row(page, 'Jump scare').innerText(), /Ready in 2 min( \d+s)?[\s\S]*10 min cooldown/);
    assert.doesNotMatch(await row(page, 'Posture check').innerText(), /cooldown|per viewer|this stream/);
    console.log('PASS rows show cooldown, per-viewer, per-stream usage, sold out and ready-in');

    // 2. Pause one, then pause all / resume all.
    await row(page, 'Hydrate').getByRole('button', { name: 'Pause Hydrate' }).click();
    await until(async () => /Paused/.test(await row(page, 'Hydrate').innerText()), 'Hydrate paused chip');
    assert.deepEqual(calls.at(-1), { method: 'PATCH', id: 'r-hydrate', body: { isPaused: true } });
    assert.equal(await row(page, 'Hydrate').getByRole('button', { name: 'Pause Hydrate' }).getAttribute('aria-pressed'), 'true');
    await page.locator('.lf-head').getByText('1 paused').waitFor();
    await page.getByRole('button', { name: 'Pause all' }).click();
    await page.locator('.lf-head').getByText('4 paused').waitFor();
    const paused = calls.filter((c) => c.body.isPaused === true).map((c) => c.id).sort();
    assert.deepEqual(paused, ['r-cool', 'r-hydrate', 'r-plain', 'r-sold']);
    assert.ok(calls.every((c) => Object.keys(c.body).length === 1), 'pause sends only isPaused');
    await page.getByText(/Rewards made on Twitch keep working/).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pause all' }).count(), 0, 'nothing left to pause');
    await shot(page, 'redemptions-desktop-dark-paused');
    await page.getByRole('button', { name: 'Resume all' }).click();
    await until(async () => (await page.locator('.lf-head').getByText(/paused/).count()) === 0, 'all resumed');
    assert.equal(calls.filter((c) => c.body.isPaused === false).length, 4);
    console.log('PASS pause one, pause all (Twitch-made note), resume all');

    // 3. Editor limits step loads Twitch values and saves seconds + limits.
    await row(page, 'Hydrate').getByRole('button', { name: 'Edit Hydrate' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Limits' }).waitFor();
    const summary = dialog.locator('#reward-limits-summary');
    assert.equal(await summary.innerText(), 'Each viewer can redeem it up to 2× per stream. Up to 10 redeems per stream in total. After each redeem, everyone waits 5 min.');
    assert.equal(await dialog.getByRole('checkbox', { name: /Per viewer, each stream/ }).isChecked(), true);
    assert.equal(await dialog.getByRole('spinbutton', { name: 'Redeems per viewer each stream' }).inputValue(), '2');
    assert.equal(await dialog.getByRole('spinbutton', { name: 'Redeems per stream in total' }).inputValue(), '10');
    assert.equal(await dialog.getByRole('spinbutton', { name: 'Cooldown length' }).inputValue(), '5');
    assert.equal(await dialog.getByRole('combobox', { name: 'Cooldown unit' }).inputValue(), 'minutes');
    await dialog.getByText('3 redeemed so far this stream.').waitFor();
    await axe(page, 'editor dark', 'app-create-reward-modal');
    await shot(page, 'redemptions-editor-desktop-dark');

    // Clash: per viewer above the stream total blocks saving.
    await dialog.getByRole('spinbutton', { name: 'Redeems per viewer each stream' }).fill('20');
    await dialog.getByText(/A viewer can't redeem it more often than the whole stream allows \(10\)/).waitFor();
    const before = calls.length;
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForTimeout(200);
    assert.equal(calls.length, before, 'clash blocks the save');
    assert.equal(await page.getByRole('dialog').count(), 1, 'dialog stays open');

    // Presets + switches + units.
    const perViewer = dialog.locator('.lf-limit').filter({ hasText: 'Per viewer, each stream' });
    await perViewer.getByRole('button', { name: '3×' }).click();
    await dialog.getByRole('checkbox', { name: /Per stream, everyone together/ }).uncheck();
    const cooldown = dialog.locator('.lf-limit').filter({ hasText: 'Cooldown after each redeem' });
    await cooldown.getByRole('button', { name: '1 h', exact: true }).click();
    await until(async () => (await summary.innerText()) === 'Each viewer can redeem it up to 3× per stream. After each redeem, everyone waits 1 h.', 'summary follows edits');
    await dialog.getByRole('spinbutton', { name: 'Cooldown length' }).fill('30');
    await dialog.getByRole('combobox', { name: 'Cooldown unit' }).selectOption('seconds');
    await dialog.getByText(/Twitch only shows cooldowns of 1 minute or more/).waitFor();
    await dialog.getByRole('spinbutton', { name: 'Cooldown length' }).fill('8');
    await dialog.getByRole('combobox', { name: 'Cooldown unit' }).selectOption('days');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.getByText('Pick a cooldown from 1 second to 7 days.').waitFor();
    assert.equal(calls.length, before, 'over 7 days blocks the save');
    await dialog.getByRole('spinbutton', { name: 'Cooldown length' }).fill('2');
    await dialog.getByRole('combobox', { name: 'Cooldown unit' }).selectOption('hours');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await until(async () => calls.length > before, 'save sent');
    const saved = calls.at(-1).body;
    assert.equal(saved.maxPerUserPerStream, 3);
    assert.equal(saved.maxPerStream, 0);
    assert.equal(saved.cooldown, 7200);
    assert.equal('isPaused' in saved, false);
    await until(async () => /3× per viewer/.test(await row(page, 'Hydrate').innerText()), 'row shows saved per-viewer limit');
    assert.match(await row(page, 'Hydrate').innerText(), /2 h cooldown/);
    assert.doesNotMatch(await row(page, 'Hydrate').innerText(), /this stream/);
    console.log('PASS editor loads Twitch limits, validates clash and 7-day max, saves presets/units');

    // 4. Create with a per-viewer limit; duplicate name in plain words.
    await page.getByRole('button', { name: 'New reward' }).click();
    const create = page.getByRole('dialog');
    assert.equal(await create.locator('#reward-limits-summary').innerText(), 'No limits: anyone can redeem it whenever they have the points.');
    await create.getByRole('textbox', { name: 'Name' }).fill('Hydrate');
    await create.getByRole('checkbox', { name: /Per viewer, each stream/ }).check();
    await create.getByRole('button', { name: 'Create reward' }).click();
    await page.getByText('You already have a reward with this name on Twitch. Pick a different name.').waitFor();
    assert.equal(calls.at(-1).body.maxPerUserPerStream, 1);
    await page.getByRole('button', { name: 'New reward' }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: 'Name' }).fill('Stretch break');
    await page.getByRole('dialog').getByRole('checkbox', { name: /Per stream, everyone together/ }).check();
    await page.getByRole('dialog').locator('.lf-limit').filter({ hasText: 'Per stream, everyone together' }).getByRole('button', { name: '25×' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create reward' }).click();
    await until(async () => calls.at(-1).body.title === 'Stretch break', 'create sent');
    const created = calls.at(-1).body;
    assert.equal(created.maxPerStream, 25);
    assert.equal(created.maxPerUserPerStream, 0);
    assert.equal(created.cooldown, 0);
    assert.equal('isPaused' in created, false);
    await row(page, 'Stretch break').waitFor();
    console.log('PASS create sends limits; duplicate Twitch name explained');

    await axe(page, 'page dark');
    await context.close();
  }

  // 5. Twitch copy unavailable: limits locked and left out of the save.
  {
    const { context, page, calls } = await open({ twitchFails: true });
    await row(page, 'Hydrate').getByRole('button', { name: 'Edit Hydrate' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/Couldn't load this reward's current limits from Twitch/).waitFor();
    assert.equal(await dialog.getByRole('checkbox', { name: /Per viewer, each stream/ }).isDisabled(), true);
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Hydrate!');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await until(async () => calls.length === 1, 'save sent');
    for (const key of ['maxPerStream', 'maxPerUserPerStream', 'cooldown']) assert.equal(key in calls[0].body, false, `${key} omitted`);
    console.log('PASS limits locked and omitted when Twitch copy is missing');
    await context.close();
  }

  // 6. Light theme, phones, Spanish.
  for (const [theme, width] of [['light', 1280], ['dark', 390], ['light', 390], ['dark', 320]]) {
    const { context, page } = await open({ theme, width });
    await noOverflow(page, `${theme} ${width}`);
    await shot(page, `redemptions-${width}-${theme}`, { fullPage: width >= 640 });
    if (width === 1280 || width === 390) await axe(page, `page ${theme} ${width}`);
    await row(page, 'Hydrate').getByRole('button', { name: 'Edit Hydrate' }).click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Limits' }).scrollIntoViewIfNeeded();
    await noOverflow(page, `editor ${theme} ${width}`);
    if (width <= 390) {
      const box = await page.getByRole('dialog').locator('.lf-limit').first().getByRole('button', { name: '1×' }).boundingBox();
      assert.ok(box && box.height >= 44, 'preset chips are touch-sized on phones');
    }
    await page.getByRole('dialog').locator('.lf-limit').first().scrollIntoViewIfNeeded();
    await shot(page, `redemptions-editor-${width}-${theme}`);
    if (theme === 'light') await axe(page, `editor ${theme} ${width}`, 'app-create-reward-modal');
    await context.close();
  }
  {
    const { context, page } = await open({ language: 'es', width: 390 });
    assert.match(await row(page, 'Hydrate').innerText(), /Enfriamiento de 5 min[\s\S]*2× por espectador[\s\S]*3\/10 en este stream/);
    await row(page, 'Hydrate').getByRole('button', { name: 'Editar Hydrate' }).click().catch(async () => {
      await row(page, 'Hydrate').locator('.lf-item__actions .lf-btn').first().click();
    });
    await page.getByRole('dialog').getByRole('heading', { name: 'Límites' }).waitFor();
    assert.match(await page.locator('#reward-limits-summary').innerText(), /^Cada espectador puede canjearla hasta 2× por stream\./);
    await shot(page, 'redemptions-editor-390-dark-es');
    console.log('PASS Spanish strings');
    await context.close();
  }
  console.log('PASS axe (dark + light), no overflow at 320/390/1280, touch-sized presets');
  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
}
console.log('PASS redemption limits browser check');
