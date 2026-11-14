// Admin channel workspace, Commands tab: editing a channel's chat commands (owner access through the site's
// commands API). Every API call is mocked on both api.domdimabot.com and localhost:3000: no command change can
// reach production. Asserts the exact request bodies: an edit sends only the changed fields, on/off sends
// `{ enabled }` (and rolls back on failure), delete is confirmed first, create POSTs name/cmd/func/message/channel,
// a taken trigger (409) shows under the trigger and keeps the dialog open, other errors show above the footer,
// built-in / blocks / custom-rule / broken-rule locks are shown and their fields are never sent, Escape closes
// (but not while saving). Layout + accessibility: axe (wcag2a/2aa/21aa) with the dialog open at 390 dark and
// 1280 light, no horizontal overflow at 320/390/1280, 44px touch targets on phones.
//
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4391), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (default /tmp/saas-admin-command-editing).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------
// Fixtures (fictional names only)
// ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const LOGIN = 'mossy_lantern';

const channel = { channel: LOGIN, channelID: '8100001', email: 'mossy_lantern@example.test', plan_tier: 'pro', actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true, isLive: false, liveViewers: 0, commandsCount: 9, eventsubsActiveCount: 0, eventsubsDisabledCount: 0, created_at: '2026-05-02T10:00:00.000Z', reminder_sent_at: null };

const base = { enabled: true, cooldown: 10, userLevel: 1, userLevelName: 'everyone', activation: 'command', keywordMatch: null, reserved: false, authoring: 'text', permissionMode: 'level', description: '', channel: LOGIN, createdAt: '2026-08-01T10:00:00.000Z' };
const initialCommands = () => [
  { ...base, id: 'c1', name: 'Lurk', cmd: 'lurk', func: 'lurk', message: '$(user) is lurking with a warm cup of tea. Enjoy!', description: 'No description provided.' },
  { ...base, id: 'c2', name: 'Shoutout', cmd: 'so', func: 'shoutout', message: 'Go follow $(touser), they were playing $(game)!', reserved: true, userLevel: 7, userLevelName: 'mod', cooldown: 30, description: 'Gives a shoutout' },
  { ...base, id: 'c3', name: 'Hype', cmd: 'hype', func: 'hype', message: 'Hype level: $(random 1 100)%', authoring: 'blocks', cooldown: 20 },
  { ...base, id: 'c4', name: 'VIP zone', cmd: 'vipzone', func: 'vipzone', message: 'Welcome to the VIP lantern room', permissionMode: 'tags' },
  { ...base, id: 'c5', name: 'Broken', cmd: 'oldrule', func: 'oldrule', message: 'This rule broke', permissionMode: 'invalid' },
  { ...base, id: 'c6', name: 'Socials', cmd: 'socials', func: 'socials', message: 'Find me everywhere: example.test/links', cooldown: 60 },
  { ...base, id: 'c7', name: 'Morning', cmd: 'good morning', func: 'custom', message: 'Good morning $(user)!', activation: 'keyword', keywordMatch: 'anywhere', cooldown: 30 },
  // Saved before the console knew about levels and activation: only the old fields, and a "!" in the trigger.
  { id: 'c8', name: 'Discord invite', cmd: '!discord', func: 'send_chat_message', message: 'Join the lantern crew: example.test/discord', enabled: false, cooldown: 120, userLevelName: 'Moderators' },
];
const commandStats = {
  from: ago(7 * 1440), to: ago(0), recordsSince: ago(9 * 1440),
  commands: [
    { name: '!lurk', runs: 12, ok: 12, skipped: 0, blocked: 0, failed: 0, lastAt: ago(4), lastOutcome: 'ok', lastReason: null, reasons: [] },
    { name: 'good morning', runs: 5, ok: 4, skipped: 1, blocked: 0, failed: 0, lastAt: ago(90), lastOutcome: 'ok', lastReason: null, reasons: [{ reason: 'cooldown', count: 1 }] },
  ],
};

const ok = (data) => ({ status: 200, body: { error: false, message: 'ok', status: 200, data } });
const fail = (status, message, code) => ({ status, body: { error: true, ...(code ? { code } : {}), message, status } });
const present = (cmd) => {
  const { id, ...rest } = cmd;
  return { _id: id, ...rest, message: rest.authoring === 'blocks' ? '' : rest.message };
};
const bare = (value) => String(value ?? '').replace(/^!+/, '');

function newState() {
  return { commands: initialCommands(), next: null, delay: 0, created: 0 };
}

/** Answers one request. `state.next` (one-shot) overrides the next write's answer. */
function makeApi(state) {
  return (method, path, url, body) => {
    const params = url.searchParams;
    let m;
    if (method === 'GET' && path === '/admin-site/users') {
      const search = params.get('search') || '';
      const rows = !search || search === '8100001' || LOGIN.includes(search) ? [channel] : [];
      return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 }, summary: {} });
    }
    if (method === 'GET' && path === '/admin-site/feed') return ok({ items: [], nextCursor: null, partial: [] });
    if (method === 'GET' && path === '/admin-site/feed/summary') return ok({ from: ago(1440), to: ago(0), partial: [], kinds: [] });
    if (method === 'GET' && path === '/admin-site/users/8100001/commands') {
      const rows = state.commands;
      return ok({ rows, pagination: { page: 1, limit: Number(params.get('limit') || 25), total: rows.length, totalPages: 1 } });
    }
    if (method === 'GET' && path === '/admin-site/users/8100001/command-stats') return ok(commandStats);
    if ((m = path.match(/^\/commands\/8100001(?:\/([^/]+))?$/))) {
      const id = m[1];
      if (state.next && method !== 'GET') { const answer = state.next; state.next = null; return answer; }
      if (method === 'POST' && !id) {
        if (!body?.name || !body?.cmd || !body?.func || !body?.message || !body?.channel) return fail(400, 'Missing required fields');
        if (state.commands.some((cmd) => cmd.activation !== 'keyword' && bare(cmd.cmd) === body.cmd)) return fail(409, 'Command already exists');
        const created = { ...base, id: `new${++state.created}`, description: body.description ?? '', ...body };
        state.commands.push(created);
        return { status: 200, body: { error: false, message: 'Command created', command: present(created), status: 200 } };
      }
      const cmd = state.commands.find((item) => item.id === id);
      if (!cmd) return fail(404, 'Command not found for this channel');
      if (method === 'PUT') {
        if ('cmd' in body && state.commands.some((item) => item.id !== id && (item.activation ?? 'command') === (cmd.activation ?? 'command') && bare(item.cmd) === body.cmd)) {
          return fail(409, 'Activation already exists');
        }
        Object.assign(cmd, body);
        return { status: 200, body: { error: false, message: 'Command updated', command: present(cmd), status: 200 } };
      }
      if (method === 'DELETE') {
        if (cmd.reserved) return fail(403, 'You cannot delete a reserved command', 'reserved');
        state.commands = state.commands.filter((item) => item.id !== id);
        return { status: 200, body: { error: false, message: 'Command deleted', command: present(cmd), status: 200 } };
      }
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
const origin = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4391';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-command-editing';
fs.mkdirSync(artifacts, { recursive: true });

const state = newState();
const api = makeApi(state);
const requests = [];
const unexpected = [];
const pageErrors = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');
const writes = () => requests.filter((r) => r.method !== 'GET');
const lastWrite = () => writes().at(-1);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({
      version: 2, token: 'disposable-command-fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' },
    }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = request.postDataJSON(); } catch { /* no body */ }
    requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, body });
    if (request.method() !== 'GET' && state.delay) {
      const wait = state.delay;
      state.delay = 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const result = api(request.method(), url.pathname, url, body);
    if (!result) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: true, message: 'Not mocked' }) });
    }
    return route.fulfill({ status: result.status, headers: cors, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR|HttpErrorResponse|Http failure/.test(message.text())) pageErrors.push(message.text()); });

  const until = async (check, label, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png` });
  const settle = () => page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
  const rows = page.locator('li[data-command]');
  const row = (trigger) => page.locator(`li[data-command="${trigger}"]`);
  const goto = async () => {
    await page.goto(`${origin}/channels/8100001/commands`);
    await page.locator('main h1').first().waitFor();
    await rows.first().waitFor();
    await settle();
  };
  const dialog = page.locator('dialog[data-command-editor]');
  const field = (suffix) => dialog.locator(`[id$="-${suffix}"]`);
  const saveButton = dialog.locator('[data-save]');
  const toast = (message) => page.locator('.toast', { hasText: message });
  const openRow = async (trigger) => {
    const body = row(trigger).locator('[data-command-body]');
    if (!(await body.count())) await row(trigger).locator('summary').click();
    await body.waitFor();
    return body;
  };
  const openEditor = async (trigger) => {
    const body = await openRow(trigger);
    await body.locator('[data-action="edit"]').click();
    await dialog.waitFor();
    await settle();
  };
  const closed = () => until(async () => (await dialog.count()) === 0, 'editor closed');
  const waitWrite = async (count, label) => until(async () => writes().length === count, label);
  const noOverflow = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${label}: horizontal overflow`);
  const axe = async (label, ...include) => {
    let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
    for (const selector of include) builder = builder.include(selector);
    const result = await builder.analyze();
    assert.deepEqual(result.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${label}: axe`);
  };
  const touchTargets = async (scope, selector, label) => {
    for (const target of await scope.locator(selector).all()) {
      if (!(await target.isVisible())) continue;
      const box = await target.boundingBox();
      assert.ok(box.height >= 43.5, `${label}: 44px touch target for ${await target.evaluate((el) => el.outerHTML.slice(0, 80))} (${box.height})`);
    }
  };

  // ---------------------------------------------------------------- List: triggers, stats, actions
  await goto();
  assert.equal(await rows.count(), 8);
  // Stored triggers have no "!" (old ones may): rows show "!lurk" and match the run stats.
  for (const trigger of ['!lurk', '!so', '!hype', '!vipzone', '!oldrule', '!socials', 'good morning', '!discord']) assert.equal(await row(trigger).count(), 1, `row ${trigger}`);
  assert.match(await text(row('!lurk').locator('.cmd-stat')), /^Ran 12×/);
  assert.match(await text(row('good morning')), /Keyword/);
  assert.match(await text(row('!so')), /Built-in/);
  assert.match(await text(row('!so').locator('.cmd-rules')), /^Moderators and up · 30s cooldown$/);
  assert.match(await text(row('!vipzone').locator('.cmd-rules')), /^Custom rule/);
  assert.match(await text(row('!discord').locator('.cmd-rules')), /^Moderators · 2m cooldown$/);
  assert.match(await text(page.locator('.cmd-answer')), /^8 commands\./);
  const newButton = page.locator('.cmd-tools').getByRole('button', { name: 'New command' });
  assert.equal(await newButton.isEnabled(), true);
  assert.equal(await page.locator('summary button, summary a, summary input').count(), 0, 'no controls inside <summary>');
  const lurkBody = await openRow('!lurk');
  assert.deepEqual((await lurkBody.locator('.cmd-actions button').allInnerTexts()).map((label) => label.trim()), ['Edit', 'Turn off', 'Delete']);
  assert.equal(await lurkBody.getByRole('link', { name: 'See its runs' }).count(), 1, 'See its runs kept');
  await touchTargets(lurkBody, '.cmd-actions .lf-btn, .cmd-runs', 'row actions 390');
  await touchTargets(page.locator('.cmd-tools'), '.cmd-new', 'new command 390');
  await noOverflow('list 390');
  await shot('list-open-dark-390');

  // ---------------------------------------------------------------- Edit: only the changed fields
  await lurkBody.locator('[data-action="edit"]').click();
  await dialog.waitFor();
  await settle();
  assert.equal(await text(dialog.locator('h2')), 'Edit !lurk');
  assert.equal(await dialog.getAttribute('aria-labelledby'), await dialog.locator('h2').getAttribute('id'));
  assert.equal(await text(dialog.locator('.ced-intro')), `Changes go live in ${LOGIN}'s chat right away. ${LOGIN} isn't notified.`);
  assert.equal(await field('trigger').inputValue(), 'lurk');
  assert.equal(await text(dialog.locator('.ced-trigger__bang')), '!');
  assert.equal(await field('reply').inputValue(), '$(user) is lurking with a warm cup of tea. Enjoy!');
  assert.match(await text(dialog.locator('.ced-count')), /^49 \/ 10,000/);
  assert.equal(await field('level').inputValue(), '1');
  assert.equal(await field('cooldown').inputValue(), '10');
  assert.equal(await dialog.getByRole('switch', { name: 'Turned on' }).isChecked(), true);
  // The old default description counts as empty.
  await dialog.locator('.lf-more > summary').click();
  assert.equal(await field('description').inputValue(), '');
  assert.equal(await field('name').inputValue(), 'Lurk');
  assert.equal(await saveButton.isDisabled(), true, 'Save waits for a change');
  await field('name').fill('Lurk!');
  await until(() => saveButton.isEnabled(), 'a change enables Save');
  await field('name').fill('Lurk');
  await until(() => saveButton.isDisabled(), 'undoing a change disables Save again');
  await shot('editor-edit-dark-390');
  await axe('editor 390 dark', 'dialog[data-command-editor]');
  await touchTargets(dialog, '.lf-btn, .lf-input, .lf-more > summary, .ced-switch', 'editor 390');
  await noOverflow('editor 390');
  await field('reply').fill('$(user) is lurking with cocoa. Enjoy!');
  await field('cooldown').fill('30');
  await saveButton.click();
  await waitWrite(1, 'edit PUT');
  assert.equal(lastWrite().method, 'PUT');
  assert.equal(lastWrite().path, '/commands/8100001/c1');
  assert.deepEqual(lastWrite().body, { message: '$(user) is lurking with cocoa. Enjoy!', cooldown: 30 });
  await closed();
  await toast('Saved !lurk').waitFor();
  // The row stays open and shows the new reply and cooldown.
  assert.equal(await row('!lurk').locator('[data-command-body]').count(), 1, 'row kept open');
  assert.equal(await text(row('!lurk').locator('.lf-quote')), '$(user) is lurking with cocoa. Enjoy!');
  assert.match(await text(row('!lurk').locator('.cmd-rules')), /30s cooldown/);

  // ---------------------------------------------------------------- Validation, 409 under the trigger, rename
  await openEditor('!lurk');
  await field('trigger').fill('lu rk');
  await field('cooldown').fill('abc');
  await field('reply').fill('   ');
  await saveButton.click();
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'No spaces: a command is one word.');
  assert.equal(await text(dialog.locator('[data-error="reply"]')), 'Type what the bot replies.');
  assert.equal(await text(dialog.locator('[data-error="cooldown"]')), 'Use whole seconds from 0 to 86,400 (24 hours).');
  assert.equal(await field('trigger').getAttribute('aria-invalid'), 'true');
  assert.match(await field('trigger').getAttribute('aria-describedby'), /-trigger-error/);
  await until(() => field('trigger').evaluate((el) => el === document.activeElement), 'first invalid field focused');
  await field('cooldown').fill('86401');
  await field('trigger').fill('');
  await until(async () => (await text(dialog.locator('[data-error="trigger"]'))) === 'Type the trigger viewers use in chat.', 'empty trigger error');
  // Chat reads only letters and numbers after "!": "lu_rk" would run "!lu".
  await field('trigger').fill('lu_rk');
  await until(async () => (await text(dialog.locator('[data-error="trigger"]'))) === 'Letters and numbers only: chat stops reading the trigger at the first symbol.', 'symbol trigger error');
  assert.equal(await text(dialog.locator('[data-error="cooldown"]')), 'Use whole seconds from 0 to 86,400 (24 hours).');
  await shot('editor-errors-dark-390');
  assert.equal(writes().length, 1, 'nothing sent while invalid');
  await field('reply').fill('$(user) is lurking with cocoa. Enjoy!');
  await field('cooldown').fill('30');
  await field('trigger').fill('!socials');
  await saveButton.click();
  await waitWrite(2, '409 PUT');
  assert.deepEqual(lastWrite().body, { cmd: 'socials' }, 'leading "!" is never stored');
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'Another command already uses !socials.');
  assert.equal(await dialog.locator('[data-server-error]').count(), 0, 'a taken trigger is not a general error');
  assert.equal(await dialog.isVisible(), true, 'dialog stays open on 409');
  await field('trigger').fill('chill');
  await until(async () => (await dialog.locator('[data-error="trigger"]').count()) === 0, 'typing clears the conflict');
  await saveButton.click();
  await waitWrite(3, 'rename PUT');
  assert.deepEqual(lastWrite().body, { cmd: 'chill' });
  await closed();
  await toast('Saved !chill').waitFor();
  assert.equal(await row('!chill').count(), 1);
  assert.equal(await row('!chill').locator('[data-command-body]').count(), 1, 'renamed row kept open');

  // ---------------------------------------------------------------- Other server errors above the footer; Escape
  await openEditor('!chill');
  await field('cooldown').fill('3');
  state.next = fail(400, 'Command cooldown must be 0 or at least 5 seconds');
  await saveButton.click();
  await waitWrite(4, 'cooldown PUT');
  assert.deepEqual(lastWrite().body, { cooldown: 3 });
  await dialog.locator('[data-server-error]').waitFor();
  assert.equal(await text(dialog.locator('[data-server-error]')), 'Command cooldown must be 0 or at least 5 seconds');
  assert.equal(await toast('cooldown').count(), 0, 'errors are not toasts');
  await shot('editor-server-error-dark-390');
  await page.keyboard.press('Escape');
  await closed();
  assert.equal(writes().length, 4, 'Escape sends nothing');
  assert.match(await text(row('!chill').locator('.cmd-rules')), /30s cooldown/, 'a refused change is not shown');

  // ---------------------------------------------------------------- On/off: optimistic, rolled back on error
  let chillBody = await openRow('!chill');
  await chillBody.locator('[data-action="toggle"]').click();
  await waitWrite(5, 'toggle PUT');
  assert.equal(lastWrite().path, '/commands/8100001/c1');
  assert.deepEqual(lastWrite().body, { enabled: false });
  await toast('!chill turned off').waitFor();
  await until(async () => (await text(chillBody.locator('[data-action="toggle"]'))) === 'Turn on', 'toggle label');
  assert.match(await text(row('!chill').locator('summary')), /Off/);
  state.next = fail(500, 'Fixture failure');
  state.delay = 600;
  await chillBody.locator('[data-action="toggle"]').click();
  await until(async () => (await text(chillBody.locator('[data-action="toggle"]'))) === 'Turn off', 'optimistic on');
  assert.equal(await chillBody.locator('[data-action="toggle"]').isDisabled(), true, 'busy while saving');
  await waitWrite(6, 'failing toggle PUT');
  assert.deepEqual(lastWrite().body, { enabled: true });
  await toast("Couldn't turn !chill on. Try again.").waitFor();
  await until(async () => (await text(chillBody.locator('[data-action="toggle"]'))) === 'Turn on', 'rolled back');
  assert.match(await text(row('!chill').locator('summary')), /Off/);

  // ---------------------------------------------------------------- Delete: confirmed first
  const socialsBody = await openRow('!socials');
  await socialsBody.locator('[data-action="delete"]').click();
  const confirm = page.locator('dialog.confirm[open]');
  await confirm.waitFor();
  await settle();
  assert.equal(await text(confirm.locator('h2')), 'Delete !socials?');
  assert.equal(await text(confirm.locator('.confirm__message')), `It stops working in ${LOGIN}'s chat right away. There's no undo here, and ${LOGIN} isn't notified.`);
  assert.equal(writes().length, 6, 'nothing deleted before confirming');
  await shot('delete-confirm-dark-390');
  await axe('delete confirm 390 dark', 'dialog.confirm[open]');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await until(async () => (await confirm.count()) === 0, 'confirm closed');
  assert.equal(writes().length, 6, 'Cancel deletes nothing');
  await socialsBody.locator('[data-action="delete"]').click();
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await waitWrite(7, 'DELETE');
  assert.equal(lastWrite().method, 'DELETE');
  assert.equal(lastWrite().path, '/commands/8100001/c6');
  await toast('!socials deleted').waitFor();
  await until(async () => (await row('!socials').count()) === 0, 'row removed');
  assert.match(await text(page.locator('.cmd-answer')), /^7 commands\./);
  // A refused delete stays in the dialog.
  const discordBody = await openRow('!discord');
  await discordBody.locator('[data-action="delete"]').click();
  await confirm.waitFor();
  state.next = fail(500, 'Fixture failure');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await waitWrite(8, 'failing DELETE');
  await confirm.locator('.lf-warning').waitFor();
  assert.equal(await text(confirm.locator('.lf-warning')), "Couldn't delete !discord. Try again.");
  await page.keyboard.press('Escape');
  await until(async () => (await confirm.count()) === 0, 'confirm closed by Escape');
  assert.equal(await row('!discord').count(), 1);

  // ---------------------------------------------------------------- Legacy row: tolerates missing fields
  await openEditor('!discord');
  assert.equal(await text(dialog.locator('h2')), 'Edit !discord');
  assert.equal(await field('trigger').inputValue(), 'discord');
  assert.equal(await field('level').inputValue(), '7', 'old "Moderators" name maps to its level');
  assert.equal(await dialog.getByRole('switch', { name: 'Turned on' }).isChecked(), false);
  assert.equal(await saveButton.isDisabled(), true);
  await field('reply').fill('Join the crew: example.test/discord');
  await saveButton.click();
  await waitWrite(9, 'legacy PUT');
  assert.equal(lastWrite().path, '/commands/8100001/c8');
  assert.deepEqual(lastWrite().body, { message: 'Join the crew: example.test/discord' }, 'an old "!" in the trigger is not sent back');
  await closed();

  // ---------------------------------------------------------------- Built-in: trigger, reply and description locked
  const soBody = await openRow('!so');
  assert.equal(await soBody.locator('[data-action="delete"]').count(), 0, 'built-ins have no Delete');
  await soBody.locator('[data-action="edit"]').click();
  await dialog.waitFor();
  await settle();
  assert.equal(await text(dialog.locator('h2')), 'Edit !so');
  assert.equal(await text(dialog.locator('[data-locked="trigger"]')), '!so');
  assert.equal(await text(dialog.locator('[data-lock="trigger"]')), "Built-in command: its trigger can't change.");
  assert.equal(await text(dialog.locator('[data-lock="reply"]')), 'Built-in command: the bot writes this reply.');
  assert.equal(await field('trigger').count(), 0);
  assert.equal(await field('reply').count(), 0);
  assert.equal(await field('description').count(), 0);
  assert.equal(await field('level').inputValue(), '7');
  await field('level').selectOption({ label: 'Broadcaster only' });
  await dialog.locator('.lf-more > summary').click();
  await field('name').fill('Shout');
  await shot('editor-builtin-dark-390');
  await saveButton.click();
  await waitWrite(10, 'built-in PUT');
  assert.equal(lastWrite().path, '/commands/8100001/c2');
  assert.deepEqual(lastWrite().body, { userLevel: 10, userLevelName: 'broadcaster', name: 'Shout' });
  await closed();
  await toast('Saved !so').waitFor();
  assert.match(await text(row('!so').locator('.cmd-rules')), /^Broadcaster only/);

  // ---------------------------------------------------------------- Blocks: reply locked with a link; Escape waits while saving
  await openEditor('!hype');
  assert.equal(await text(dialog.locator('[data-lock="reply"]')), 'Built with blocks on the site. Change the reply there.');
  const site = dialog.getByRole('link', { name: 'Open on domdimabot.com' });
  assert.equal(await site.getAttribute('href'), `https://domdimabot.com/${LOGIN}/commands`);
  assert.equal(await site.getAttribute('target'), '_blank');
  assert.match(await site.getAttribute('rel'), /noopener/);
  assert.equal(await field('reply').count(), 0);
  assert.equal(await field('trigger').count(), 1, 'a blocks command keeps its trigger editable');
  await field('cooldown').fill('45');
  await shot('editor-blocks-dark-390');
  state.delay = 900;
  await saveButton.click();
  await dialog.locator('[data-save] .lf-spin').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await dialog.isVisible(), true, 'Escape waits while saving');
  await waitWrite(11, 'blocks PUT');
  assert.deepEqual(lastWrite().body, { cooldown: 45 }, 'no message for a blocks command');
  await closed();

  // ---------------------------------------------------------------- Custom rule and broken rule: level locked
  await openEditor('!vipzone');
  assert.equal(await text(dialog.locator('[data-lock="level"]')), 'Uses a custom rule made on the site.');
  assert.equal(await field('level').count(), 0);
  await dialog.locator('.ced-switch').click();
  assert.equal(await dialog.getByRole('switch', { name: 'Turned on' }).isChecked(), false);
  await saveButton.click();
  await waitWrite(12, 'tags PUT');
  assert.deepEqual(lastWrite().body, { enabled: false }, 'no level for a custom rule');
  await closed();
  await toast('Saved !vipzone').waitFor();
  await openEditor('!oldrule');
  assert.equal(await text(dialog.locator('[data-lock="level"]')), 'Its permission rule is broken; fix it on the site.');
  assert.equal(await field('level').count(), 0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- Keyword: the phrase, its match mode, no "!"
  await openEditor('good morning');
  assert.equal(await text(dialog.locator('h2')), 'Edit keyword “good morning”');
  assert.equal(await dialog.locator('.ced-trigger__bang').count(), 0);
  assert.equal(await field('trigger').inputValue(), 'good morning');
  assert.equal(await text(dialog.locator('[id$="-trigger-hint"]')), 'Keyword · matches when a message contains it');
  await page.keyboard.press('Escape');
  await closed();
  assert.equal(writes().length, 12);

  // ---------------------------------------------------------------- Create
  await newButton.click();
  await dialog.waitFor();
  await settle();
  assert.equal(await text(dialog.locator('h2')), 'New command');
  assert.equal(await text(saveButton), 'Create command');
  await saveButton.click();
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="reply"]')), 'Type what the bot replies.');
  assert.equal(writes().length, 12, 'nothing sent while empty');
  await field('trigger').fill('chill');
  await field('reply').fill('Hi $(user)!');
  await field('level').selectOption({ label: 'VIPs and up' });
  await saveButton.click();
  await waitWrite(13, '409 POST');
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'Another command already uses !chill.');
  await field('trigger').fill('!hello');
  await shot('editor-create-dark-390');
  await saveButton.click();
  await waitWrite(14, 'create POST');
  assert.equal(lastWrite().method, 'POST');
  assert.equal(lastWrite().path, '/commands/8100001');
  // `func: 'custom'`: a text reply, never a built-in action named like the trigger.
  assert.deepEqual(lastWrite().body, { name: 'hello', cmd: 'hello', func: 'custom', message: 'Hi $(user)!', channel: LOGIN, cooldown: 10, enabled: true, userLevel: 5, userLevelName: 'vip' });
  await closed();
  await toast('!hello created').waitFor();
  await row('!hello').locator('[data-command-body]').waitFor();
  assert.match(await text(page.locator('.cmd-answer')), /^8 commands\./);

  // ---------------------------------------------------------------- A command named after a built-in action: reply locked, never sent
  state.commands.find((cmd) => String(cmd.cmd).replace(/^!/, '') === 'hello').runsBuiltIn = true;
  await goto();
  await openEditor('!hello');
  assert.equal(await text(dialog.locator('[data-lock="reply"]')), 'The bot runs its own built-in action for this command, so this reply is never posted.');
  assert.equal(await field('reply').count(), 0, 'no reply field when the reply is never posted');
  await field('cooldown').fill('75');
  const beforeBuiltIn = writes().length;
  await saveButton.click();
  await waitWrite(beforeBuiltIn + 1, 'built-in action PUT');
  assert.deepEqual(lastWrite().body, { cooldown: 75 }, 'only the cooldown, never the reply');
  await closed();

  // ---------------------------------------------------------------- Layout + accessibility matrix
  for (const [mode, width] of [['dark', 320], ['dark', 390], ['light', 1280], ['light', 390], ['dark', 1280]]) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await goto();
    const label = `${mode} ${width}`;
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label}: theme`);
    await openRow('!chill');
    await noOverflow(`${label} list`);
    if (width < 960) await touchTargets(page.locator('app-channel-commands'), '.cmd-actions .lf-btn, .cmd-new', label);
    await axe(`${label} list`, 'app-channel-shell', 'app-navbar');
    await shot(`list-${mode}-${width}`);
    await openEditor('!chill');
    await dialog.locator('.lf-more > summary').click();
    await noOverflow(`${label} editor`);
    const box = await dialog.boundingBox();
    if (width >= 640) assert.ok(box.x > 0 && box.y > 0, `${label}: centred card`);
    else assert.ok(Math.abs(box.y + box.height - (width === 1280 ? 900 : 844)) <= 1 && box.width === width, `${label}: bottom sheet`);
    if (width < 960) await touchTargets(dialog, '.lf-btn, .lf-input, .lf-more > summary, .ced-switch', `${label} editor`);
    await axe(`${label} editor`, 'dialog[data-command-editor]');
    await shot(`editor-${mode}-${width}`);
    await page.keyboard.press('Escape');
    await closed();
  }

  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin command editing: list triggers/stats/actions, edit sends only changed fields, validation + 409 inline + other errors above the footer, Escape (not while saving), optimistic on/off with rollback, confirmed delete (+ refused), legacy rows, built-in/blocks/built-in-action/custom-rule/broken-rule locks never sent, symbol triggers refused, keyword hint, create as a text reply (+ 409), 320/390/1280 dark+light overflow/axe/touch targets. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
