// Admin channel workspace, Commands tab: the owner edits a channel's chat commands with no locks, through the
// owner routes (`/admin-site/users/:channelID/commands[/:id]`). Every API call is mocked on both api.domdimabot.com
// and localhost:3000 (the old `/commands/...` site routes are not mocked, so any call there fails the check): no
// command change can reach production. Asserts the exact request bodies: an edit sends only the changed fields
// (a cooldown saved here is marked "Set by you");
// built-in trigger + reply + description edits; a block command saved as a plain reply (`authoring: 'text'`);
// blocks JSON edits (sent as the block root, invalid JSON blocked inline with no request, a server 400 shown above
// the footer); a level picked on a custom rule sends `permissionExpression: null` + the level; rule JSON edits;
// "Runs" changes; keyword match changes; switching the type sends `activation` (a keyword phrase switched to a
// command asks for a one-word trigger at once; the server's trigger refusal shows under the trigger); delete for every command, the
// built-in confirm says the bot may add it back; on/off sends `{ enabled }` (and rolls back on failure); create
// POSTs a plain reply (`func: 'custom'`); a taken trigger (409) shows under the trigger; the old lock notes are
// gone; Escape closes (but not while saving). Layout + accessibility: axe (wcag2a/2aa/21aa) with the dialog open
// at 320/390/1280 dark and light, no horizontal overflow, 44px touch targets on phones.
//
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4391), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright,
// default /tmp/saas-cooldown-browser), SAAS_SCREENSHOTS (default /tmp/saas-admin-command-editing).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------
// Fixtures (fictional names only)
// ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const LOGIN = 'mossy_lantern';
const BASE_PATH = '/admin-site/users/8100001/commands';
/** `meta.builtInActions`: function names whose built-in code runs instead of a reply. */
const BUILT_IN_ACTIONS = ['amor', 'commands', 'duel', 'followage', 'promo', 'title'];

const channel = { channel: LOGIN, channelID: '8100001', email: 'mossy_lantern@example.test', plan_tier: 'free', actived: true, chat_enabled: true, has_permissions: true, up_to_date_permissions: true, isLive: false, liveViewers: 0, commandsCount: 9, eventsubsActiveCount: 0, eventsubsDisabledCount: 0, created_at: '2026-05-02T10:00:00.000Z', reminder_sent_at: null };

const HYPE_ROOT = { id: 'r1', type: 'root', children: [{ id: 'b1', type: 'literal', value: 'Hype level: ' }, { id: 'b2', type: 'raw', source: '$(random 1 100)' }, { id: 'b3', type: 'literal', value: '%' }] };
const NEW_ROOT = { id: 'r1', type: 'root', children: [{ id: 'b1', type: 'literal', value: 'Hype: ' }, { id: 'b2', type: 'raw', source: '$(random 1 10)' }] };
const VIP_RULE = { or: [{ role: 'vip' }, { role: 'mod' }] };
const BROKEN_RULE = { role: 'royalty' };

const base = { enabled: true, cooldown: 10, userLevel: 1, userLevelName: 'everyone', activation: 'command', keywordMatch: null, reserved: false, authoring: 'text', permissionMode: 'level', runsBuiltIn: false, blocks: null, permissionExpression: null, description: '', channel: LOGIN, createdAt: '2026-08-01T10:00:00.000Z' };
const initialCommands = () => [
  { ...base, id: 'c1', name: 'Lurk', cmd: 'lurk', func: 'lurk', message: '$(user) is lurking with a warm cup of tea. Enjoy!', description: 'No description provided.' },
  { ...base, id: 'c2', name: 'Shoutout', cmd: 'so', func: 'shoutout', runsBuiltIn: true, message: 'Go follow $(touser), they were playing $(game)!', reserved: true, userLevel: 7, userLevelName: 'mod', cooldown: 30, description: 'Gives a shoutout' },
  // Rows carry the stored `{ v, root }` wrapper; the write takes the root.
  { ...base, id: 'c3', name: 'Hype', cmd: 'hype', func: 'custom', message: 'Hype level: $(random 1 100)%', authoring: 'blocks', blocks: { v: 1, root: HYPE_ROOT }, cooldown: 20 },
  { ...base, id: 'c4', name: 'VIP zone', cmd: 'vipzone', func: 'custom', message: 'Welcome to the VIP lantern room', permissionMode: 'tags', permissionExpression: VIP_RULE },
  { ...base, id: 'c5', name: 'Broken', cmd: 'oldrule', func: 'custom', message: 'This rule broke', permissionMode: 'invalid', permissionExpression: BROKEN_RULE },
  { ...base, id: 'c6', name: 'Socials', cmd: 'socials', func: 'socials', message: 'Find me everywhere: example.test/links', cooldown: 60 },
  { ...base, id: 'c7', name: 'Morning', cmd: 'good morning', func: 'custom', message: 'Good morning $(user)!', activation: 'keyword', keywordMatch: 'anywhere', cooldown: 30 },
  // Saved before the console knew about levels and activation: only the old fields, and a "!" in the trigger.
  { id: 'c8', name: 'Discord invite', cmd: '!discord', func: 'send_chat_message', message: 'Join the lantern crew: example.test/discord', enabled: false, cooldown: 120, userLevelName: 'Moderators' },
  // Not a built-in, but its function is a built-in action: chat runs that code and the reply isn't posted.
  { ...base, id: 'c9', name: 'Promo', cmd: 'promo', func: 'promo', runsBuiltIn: true, message: 'Check out my friend!' },
];
const commandStats = {
  from: ago(7 * 1440), to: ago(0), recordsSince: ago(9 * 1440),
  commands: [
    { name: '!lurk', runs: 12, ok: 12, skipped: 0, blocked: 0, failed: 0, lastAt: ago(4), lastOutcome: 'ok', lastReason: null, reasons: [] },
    { name: 'good morning', runs: 5, ok: 4, skipped: 1, blocked: 0, failed: 0, lastAt: ago(90), lastOutcome: 'ok', lastReason: null, reasons: [{ reason: 'cooldown', count: 1 }] },
  ],
};

const ok = (data, message = 'ok') => ({ status: 200, body: { error: false, message, status: 200, data } });
const fail = (status, message) => ({ status, body: { error: true, message, status } });
const bare = (value) => String(value ?? '').replace(/^!+/, '');
const FIELDS = ['name', 'cmd', 'func', 'message', 'authoring', 'blocks', 'activation', 'keywordSettings', 'cooldown', 'enabled', 'userLevel', 'userLevelName', 'permissionExpression', 'description', 'channel'];
/** The compiled text of a block root (literals and raw sources in order), like the server writes. */
const blocksText = (root) => root.children.map((block) => block.value ?? block.source ?? '').join('');

function newState() {
  return { commands: initialCommands(), next: null, delay: 0, created: 0 };
}

/** Applies an owner write to a row like the owner route does, and answers the row as the list shows it. */
function apply(cmd, body) {
  for (const key of ['name', 'cmd', 'func', 'message', 'cooldown', 'enabled', 'userLevel', 'userLevelName', 'description', 'channel']) {
    if (key in body) cmd[key] = body[key];
  }
  // The owner saved the cooldown: chat uses it as stored.
  if ('cooldown' in body) cmd.cooldownOverride = true;
  if ('activation' in body) {
    cmd.activation = body.activation;
    if (body.activation === 'command') cmd.keywordMatch = null;
  }
  if (cmd.activation === 'keyword') {
    cmd.func = 'custom';
    if (body.keywordSettings) cmd.keywordMatch = body.keywordSettings.matchMode;
  }
  if (body.authoring === 'blocks') {
    cmd.authoring = 'blocks';
    cmd.blocks = { v: 1, root: body.blocks };
    cmd.message = blocksText(body.blocks);
  } else if (body.authoring === 'text') {
    cmd.authoring = 'text';
    cmd.blocks = null;
  }
  if ('permissionExpression' in body) {
    cmd.permissionMode = body.permissionExpression === null ? 'level' : 'tags';
    cmd.permissionExpression = body.permissionExpression;
  }
  cmd.runsBuiltIn = cmd.activation !== 'keyword' && (BUILT_IN_ACTIONS.includes(cmd.func) || (cmd.func === 'shoutout' && cmd.reserved === true));
  return structuredClone(cmd);
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
    if (method === 'GET' && path === BASE_PATH) {
      const rows = structuredClone(state.commands);
      return ok({ rows, pagination: { page: 1, limit: Number(params.get('limit') || 25), total: rows.length, totalPages: 1 }, meta: { builtInActions: BUILT_IN_ACTIONS } });
    }
    if (method === 'GET' && path === '/admin-site/users/8100001/command-stats') return ok(commandStats);
    if (method !== 'GET' && (m = path.match(/^\/admin-site\/users\/8100001\/commands(?:\/([^/]+))?$/))) {
      const id = m[1];
      if (state.next) { const answer = state.next; state.next = null; return answer; }
      const unknown = Object.keys(body ?? {}).filter((key) => !FIELDS.includes(key));
      if (unknown.length) return fail(400, `Unknown command fields: ${unknown.join(', ')}`);
      const sameType = (item, activation) => (item.activation ?? 'command') === (activation ?? 'command');
      if (method === 'POST' && !id) {
        if (!body?.cmd) return fail(400, 'Missing trigger');
        if (state.commands.some((cmd) => sameType(cmd, body.activation) && bare(cmd.cmd) === body.cmd)) return fail(409, 'Command already exists');
        const created = { ...base, id: `new${++state.created}`, name: body.name || body.cmd, func: body.func || 'custom', message: body.message ?? '' };
        state.commands.push(created);
        return ok(apply(created, body), 'Command created');
      }
      const cmd = state.commands.find((item) => item.id === id);
      if (!cmd) return fail(404, 'Command not found');
      if (method === 'PUT') {
        if (!Object.keys(body ?? {}).length) return fail(400, 'Nothing to change');
        const activation = body.activation ?? cmd.activation;
        const trigger = body.cmd ?? bare(cmd.cmd);
        if (('cmd' in body || 'activation' in body) && state.commands.some((item) => item.id !== id && sameType(item, activation) && bare(item.cmd) === trigger)) {
          return fail(409, 'Activation already exists');
        }
        return ok(apply(cmd, body), 'Command saved');
      }
      if (method === 'DELETE') {
        state.commands = state.commands.filter((item) => item.id !== id);
        return ok({ id, cmd: cmd.cmd }, 'Command deleted');
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
  const note = (name) => dialog.locator(`[data-note="${name}"]`);
  const saveButton = dialog.locator('[data-save]');
  const toast = (message) => page.locator('.toast', { hasText: message }).last();
  const more = async () => {
    if (!(await dialog.locator('details.lf-more').evaluate((el) => el.open))) await dialog.locator('.lf-more > summary').click();
  };
  const openRow = async (trigger) => {
    const body = row(trigger).locator('[data-command-body]');
    if (!(await body.count())) await row(trigger).locator('summary').click();
    await body.waitFor();
    return body;
  };
  /** The old lock notes (and the "change it on the site" link) never come back. */
  const OLD_LOCKS = [/can't change/, /the bot writes this reply/, /Built with blocks on the site/, /Change the reply there/, /Open on domdimabot\.com/, /reply is never posted/, /made on the site/, /fix it on the site/];
  const noLocks = async (label) => {
    assert.equal(await dialog.locator('[data-lock], [data-locked]').count(), 0, `${label}: no lock notes`);
    const all = await text(dialog);
    for (const pattern of OLD_LOCKS) assert.doesNotMatch(all, pattern, `${label}: old lock text ${pattern}`);
    for (const name of ['trigger', 'reply', 'level', 'cooldown']) assert.equal(await field(name).isDisabled(), false, `${label}: ${name} usable`);
  };
  const openEditor = async (trigger) => {
    const body = await openRow(trigger);
    await body.locator('[data-action="edit"]').click();
    await dialog.waitFor();
    await settle();
    await noLocks(`editor ${trigger}`);
  };
  const closed = () => until(async () => (await dialog.count()) === 0, 'editor closed');
  const waitWrite = async (count, label) => until(async () => writes().length === count, label);
  const expectWrite = async (label, method, id, body) => {
    const count = writes().length + 1;
    await saveButton.click();
    await waitWrite(count, label);
    assert.equal(lastWrite().method, method, `${label}: method`);
    assert.equal(lastWrite().path, id ? `${BASE_PATH}/${id}` : BASE_PATH, `${label}: path`);
    assert.deepEqual(lastWrite().body, body, `${label}: body`);
  };
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
  const EDITOR_TARGETS = '.lf-btn, .lf-input, .lf-more > summary, .ced-switch';

  // ---------------------------------------------------------------- List: triggers, stats, actions (Delete on every row)
  await goto();
  assert.equal(await rows.count(), 9);
  for (const trigger of ['!lurk', '!so', '!hype', '!vipzone', '!oldrule', '!socials', 'good morning', '!discord', '!promo']) assert.equal(await row(trigger).count(), 1, `row ${trigger}`);
  assert.equal(requests.filter((r) => r.path.startsWith('/commands')).length, 0, 'never the site routes');
  assert.match(await text(row('!lurk').locator('.cmd-stat')), /^Ran 12×/);
  assert.match(await text(row('good morning')), /Keyword/);
  assert.match(await text(row('!so')), /Built-in/);
  assert.match(await text(row('!so').locator('.cmd-rules')), /^Moderators and up · 30s cooldown$/);
  assert.match(await text(row('!vipzone').locator('.cmd-rules')), /^Custom rule/);
  assert.match(await text(row('!discord').locator('.cmd-rules')), /^Moderators · 2m cooldown$/);
  assert.match(await text(page.locator('.cmd-answer')), /^9 commands\./);
  const newButton = page.locator('.cmd-tools').getByRole('button', { name: 'New command' });
  assert.equal(await newButton.isEnabled(), true);
  assert.equal(await page.locator('summary button, summary a, summary input').count(), 0, 'no controls inside <summary>');
  const lurkBody = await openRow('!lurk');
  assert.deepEqual((await lurkBody.locator('.cmd-actions button').allInnerTexts()).map((label) => label.trim()), ['Edit', 'Turn off', 'Delete']);
  const soRowBody = await openRow('!so');
  assert.deepEqual((await soRowBody.locator('.cmd-actions button').allInnerTexts()).map((label) => label.trim()), ['Edit', 'Turn off', 'Delete'], 'built-ins can be deleted too');
  await row('!so').locator('summary').click();
  assert.equal(await lurkBody.getByRole('link', { name: 'See its runs' }).count(), 1, 'See its runs kept');
  await touchTargets(lurkBody, '.cmd-actions .lf-btn, .cmd-runs', 'row actions 390');
  await touchTargets(page.locator('.cmd-tools'), '.cmd-new', 'new command 390');
  await noOverflow('list 390');
  await shot('list-open-dark-390');

  // ---------------------------------------------------------------- Edit: only the changed fields
  await lurkBody.locator('[data-action="edit"]').click();
  await dialog.waitFor();
  await settle();
  await noLocks('editor !lurk');
  assert.equal(await text(dialog.locator('h2')), 'Edit !lurk');
  assert.equal(await dialog.getAttribute('aria-labelledby'), await dialog.locator('h2').getAttribute('id'));
  assert.equal(await text(dialog.locator('.ced-intro')), `Changes go live in ${LOGIN}'s chat right away. ${LOGIN} isn't notified.`);
  assert.equal(await field('trigger').inputValue(), 'lurk');
  assert.equal(await text(dialog.locator('.ced-trigger__bang')), '!');
  assert.equal(await field('reply').inputValue(), '$(user) is lurking with a warm cup of tea. Enjoy!');
  assert.match(await text(dialog.locator('.ced-count')), /^49 \/ 10,000/);
  assert.equal(await field('level').inputValue(), '1');
  assert.equal(await field('cooldown').inputValue(), '10');
  assert.equal(await text(field('cooldown-hint')), "Wait between uses. 0 = no wait. Plan limits don't apply here.");
  assert.equal(await note('cooldown-set').count(), 0, 'no "Set by you" before the owner saved a cooldown');
  assert.equal(await dialog.getByRole('switch', { name: 'Turned on' }).isChecked(), true);
  // The old default description counts as empty; More options holds name, description, type, runs and the JSON fields.
  await more();
  assert.equal(await field('description').inputValue(), '');
  assert.equal(await field('name').inputValue(), 'Lurk');
  assert.equal(await field('type').inputValue(), 'command');
  assert.equal(await text(field('type-hint')), 'Changes how chat triggers it.');
  // "Runs": a plain reply, the stored function (not a built-in action) and the built-in actions.
  assert.equal(await field('func').inputValue(), 'lurk');
  assert.deepEqual(await field('func').locator('option').evaluateAll((els) => els.map((el) => [el.value, el.textContent.trim()])),
    [['custom', 'Plain reply'], ['lurk', 'lurk'], ...BUILT_IN_ACTIONS.map((name) => [name, name])]);
  assert.equal(await field('blocks').inputValue(), '');
  assert.equal(await field('rule').inputValue(), '');
  assert.equal(await field('level').locator('option[value="rule"]').count(), 0, 'no rule option without a rule');
  assert.equal(await saveButton.isDisabled(), true, 'Save waits for a change');
  await field('name').fill('Lurk!');
  await until(() => saveButton.isEnabled(), 'a change enables Save');
  await field('name').fill('Lurk');
  await until(() => saveButton.isDisabled(), 'undoing a change disables Save again');
  await shot('editor-edit-dark-390');
  await axe('editor 390 dark', 'dialog[data-command-editor]');
  await touchTargets(dialog, EDITOR_TARGETS, 'editor 390');
  await noOverflow('editor 390');
  await field('reply').fill('$(user) is lurking with cocoa. Enjoy!');
  await field('cooldown').fill('30');
  await expectWrite('edit PUT', 'PUT', 'c1', { message: '$(user) is lurking with cocoa. Enjoy!', cooldown: 30 });
  await closed();
  await toast('Saved !lurk').waitFor();
  // The row stays open and shows the saved row.
  assert.equal(await row('!lurk').locator('[data-command-body]').count(), 1, 'row kept open');
  assert.equal(await text(row('!lurk').locator('.lf-quote')), '$(user) is lurking with cocoa. Enjoy!');
  assert.match(await text(row('!lurk').locator('.cmd-rules')), /30s cooldown/);

  // ---------------------------------------------------------------- Validation, 409 under the trigger, rename
  await openEditor('!lurk');
  assert.equal(await text(note('cooldown-set')), 'Set by you', 'a cooldown saved here is marked');
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
  // Any whole number of seconds up to 24 h: no plan minimum.
  await field('cooldown').fill('3');
  await field('trigger').fill('!socials');
  await expectWrite('409 PUT', 'PUT', 'c1', { cmd: 'socials', cooldown: 3 });
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'Another command already uses !socials.');
  assert.equal(await dialog.locator('[data-server-error]').count(), 0, 'a taken trigger is not a general error');
  assert.equal(await dialog.isVisible(), true, 'dialog stays open on 409');
  await field('trigger').fill('chill');
  await until(async () => (await dialog.locator('[data-error="trigger"]').count()) === 0, 'typing clears the conflict');
  await expectWrite('rename PUT', 'PUT', 'c1', { cmd: 'chill', cooldown: 3 });
  await closed();
  await toast('Saved !chill').waitFor();
  assert.equal(await row('!chill').count(), 1);
  assert.equal(await row('!chill').locator('[data-command-body]').count(), 1, 'renamed row kept open');
  assert.match(await text(row('!chill').locator('.cmd-rules')), /3s cooldown/);

  // ---------------------------------------------------------------- On/off: optimistic, rolled back on error
  const chillBody = await openRow('!chill');
  await chillBody.locator('[data-action="toggle"]').click();
  await waitWrite(4, 'toggle PUT');
  assert.equal(lastWrite().method, 'PUT');
  assert.equal(lastWrite().path, `${BASE_PATH}/c1`);
  assert.deepEqual(lastWrite().body, { enabled: false });
  await toast('!chill turned off').waitFor();
  await until(async () => (await text(chillBody.locator('[data-action="toggle"]'))) === 'Turn on', 'toggle label');
  assert.match(await text(row('!chill').locator('summary')), /Off/);
  state.next = fail(500, 'Fixture failure');
  state.delay = 600;
  await chillBody.locator('[data-action="toggle"]').click();
  await until(async () => (await text(chillBody.locator('[data-action="toggle"]'))) === 'Turn off', 'optimistic on');
  assert.equal(await chillBody.locator('[data-action="toggle"]').isDisabled(), true, 'busy while saving');
  await waitWrite(5, 'failing toggle PUT');
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
  assert.equal(writes().length, 5, 'nothing deleted before confirming');
  await shot('delete-confirm-dark-390');
  await axe('delete confirm 390 dark', 'dialog.confirm[open]');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await until(async () => (await confirm.count()) === 0, 'confirm closed');
  assert.equal(writes().length, 5, 'Cancel deletes nothing');
  await socialsBody.locator('[data-action="delete"]').click();
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await waitWrite(6, 'DELETE');
  assert.equal(lastWrite().method, 'DELETE');
  assert.equal(lastWrite().path, `${BASE_PATH}/c6`);
  await toast('!socials deleted').waitFor();
  await until(async () => (await row('!socials').count()) === 0, 'row removed');
  assert.match(await text(page.locator('.cmd-answer')), /^8 commands\./);
  // A refused delete stays in the dialog.
  const discordBody = await openRow('!discord');
  await discordBody.locator('[data-action="delete"]').click();
  await confirm.waitFor();
  state.next = fail(500, 'Fixture failure');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await waitWrite(7, 'failing DELETE');
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
  await expectWrite('legacy PUT', 'PUT', 'c8', { message: 'Join the crew: example.test/discord' });
  await closed();

  // ---------------------------------------------------------------- Built-in: trigger, reply and description editable
  await openEditor('!so');
  assert.equal(await text(dialog.locator('h2')), 'Edit !so');
  assert.equal(await field('trigger').inputValue(), 'so');
  assert.equal(await field('reply').inputValue(), 'Go follow $(touser), they were playing $(game)!');
  assert.equal(await text(note('runs')), "Chat runs the built-in shoutout action; this reply isn't posted. Choose 'Plain reply' to post it.");
  assert.equal(await field('level').inputValue(), '7');
  await more();
  assert.equal(await field('description').inputValue(), 'Gives a shoutout');
  assert.equal(await field('func').inputValue(), 'shoutout');
  await field('trigger').fill('shout');
  await field('reply').fill('Go follow $(touser)!');
  await field('level').selectOption({ label: 'Broadcaster only' });
  await field('description').fill('Shoutout for a friend');
  await shot('editor-builtin-dark-390');
  await expectWrite('built-in PUT', 'PUT', 'c2', { cmd: 'shout', message: 'Go follow $(touser)!', userLevel: 10, userLevelName: 'broadcaster', description: 'Shoutout for a friend' });
  await closed();
  await toast('Saved !shout').waitFor();
  assert.match(await text(row('!shout').locator('.cmd-rules')), /^Broadcaster only/);
  assert.match(await text(row('!shout')), /Built-in/);

  // ---------------------------------------------------------------- "Runs": a built-in action's reply isn't posted until it's a plain reply
  await openEditor('!promo');
  assert.equal(await text(note('runs')), "Chat runs the built-in promo action; this reply isn't posted. Choose 'Plain reply' to post it.");
  assert.equal(await field('reply').inputValue(), 'Check out my friend!');
  await more();
  assert.equal(await field('func').inputValue(), 'promo');
  assert.equal(await field('func').locator('option[value="custom"]').count(), 1);
  await field('func').selectOption({ label: 'Plain reply' });
  await until(async () => (await note('runs').count()) === 0, 'runs note gone for a plain reply');
  await field('func').selectOption('duel');
  await until(async () => (await note('runs').count()) === 1, 'runs note for another built-in action');
  assert.match(await text(note('runs')), /built-in duel action/);
  await field('func').selectOption({ label: 'Plain reply' });
  await expectWrite('runs PUT', 'PUT', 'c9', { func: 'custom' });
  await closed();
  await toast('Saved !promo').waitFor();
  assert.match(await text(row('!promo').locator('[data-command-body]')), /Runs custom/);

  // ---------------------------------------------------------------- Blocks: JSON edits, invalid JSON inline, server 400 above the footer, back to text
  await openEditor('!hype');
  assert.equal(await text(note('blocks')), 'Built with blocks: this is the text they make. Edit it to save a plain reply, or edit the blocks (JSON) in More options.');
  assert.equal(await field('reply').inputValue(), 'Hype level: $(random 1 100)%');
  assert.equal(await field('trigger').count(), 1);
  await more();
  // Shown and sent as the block root, not the stored `{ v, root }` wrapper.
  assert.equal(await field('blocks').inputValue(), JSON.stringify(HYPE_ROOT, null, 2));
  assert.equal(await field('blocks').evaluate((el) => getComputedStyle(el).fontFamily.includes('monospace') || /Menlo|Consolas|SFMono/.test(getComputedStyle(el).fontFamily)), true, 'monospace');
  assert.equal(await saveButton.isDisabled(), true);
  // Invalid JSON: an inline error, nothing sent.
  const beforeInvalid = writes().length;
  await field('blocks').fill('{ "type": "root", ');
  await saveButton.click();
  await dialog.locator('[data-error="blocks"]').waitFor();
  assert.match(await text(dialog.locator('[data-error="blocks"]')), /^This isn't valid JSON: /);
  assert.equal(await field('blocks').getAttribute('aria-invalid'), 'true');
  await until(() => field('blocks').evaluate((el) => el === document.activeElement), 'invalid JSON focused');
  assert.equal(writes().length, beforeInvalid, 'invalid JSON is never sent');
  await shot('editor-blocks-invalid-dark-390');
  // Valid JSON the server refuses: its message above the footer, not a toast.
  await field('blocks').fill(JSON.stringify(NEW_ROOT, null, 2));
  await until(async () => (await dialog.locator('[data-error="blocks"]').count()) === 0, 'valid JSON clears the error');
  assert.equal(await text(note('uses-blocks')), 'Saving uses the blocks (JSON) from More options; the server writes the reply from them.');
  state.next = fail(400, 'Invalid blocks: This block would run differently than it looks. Try moving or retyping it.');
  await expectWrite('refused blocks PUT', 'PUT', 'c3', { authoring: 'blocks', blocks: NEW_ROOT });
  await dialog.locator('[data-server-error]').waitFor();
  assert.equal(await text(dialog.locator('[data-server-error]')), 'Invalid blocks: This block would run differently than it looks. Try moving or retyping it.');
  assert.equal(await toast('Invalid blocks').count(), 0, 'errors are not toasts');
  await shot('editor-server-error-dark-390');
  await axe('editor blocks 390 dark', 'dialog[data-command-editor]');
  await touchTargets(dialog, EDITOR_TARGETS, 'editor blocks 390');
  await noOverflow('editor blocks 390');
  await page.keyboard.press('Escape');
  await closed();
  assert.equal(writes().length, beforeInvalid + 1, 'Escape sends nothing');
  // A pasted stored wrapper is sent as its root; Escape waits while saving.
  await openEditor('!hype');
  await more();
  await field('blocks').fill(JSON.stringify({ v: 1, root: NEW_ROOT }));
  state.delay = 900;
  await saveButton.click();
  await dialog.locator('[data-save] .lf-spin').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await dialog.isVisible(), true, 'Escape waits while saving');
  await waitWrite(beforeInvalid + 2, 'blocks PUT');
  assert.equal(lastWrite().path, `${BASE_PATH}/c3`);
  assert.deepEqual(lastWrite().body, { authoring: 'blocks', blocks: NEW_ROOT });
  await closed();
  await toast('Saved !hype').waitFor();
  assert.equal(await text(row('!hype').locator('.lf-quote')), 'Hype: $(random 1 10)');
  // Edit the text: saved as a plain reply that replaces the blocks.
  await openEditor('!hype');
  assert.equal(await note('to-text').count(), 0);
  await field('reply').fill('Hype: 100%');
  assert.equal(await text(note('to-text')), 'Saving replaces the blocks with this plain reply.');
  await shot('editor-blocks-to-text-dark-390');
  await expectWrite('blocks to text PUT', 'PUT', 'c3', { authoring: 'text', message: 'Hype: 100%' });
  await closed();
  await toast('Saved !hype').waitFor();
  await openEditor('!hype');
  assert.equal(await note('blocks').count(), 0, 'a plain reply now');
  await more();
  assert.equal(await field('blocks').inputValue(), '');
  await page.keyboard.press('Escape');
  await closed();

  // ---------------------------------------------------------------- Custom rule: JSON edits; a level switches it to level mode
  await openEditor('!vipzone');
  assert.equal(await field('level').inputValue(), 'rule');
  assert.equal(await text(field('level').locator('option[value="rule"]')), 'Custom rule');
  assert.equal(await text(field('level-hint')), 'Set in More options › Custom rule (JSON).');
  await more();
  assert.equal(await field('rule').inputValue(), JSON.stringify(VIP_RULE, null, 2));
  await field('rule').fill('{"role":"vip"}');
  await expectWrite('rule PUT', 'PUT', 'c4', { permissionExpression: { role: 'vip' } });
  await closed();
  await toast('Saved !vipzone').waitFor();
  await openEditor('!vipzone');
  await more();
  assert.equal(await field('rule').inputValue(), JSON.stringify({ role: 'vip' }, null, 2));
  const beforeRule = writes().length;
  await field('rule').fill('{ role: vip }');
  await saveButton.click();
  await dialog.locator('[data-error="rule"]').waitFor();
  assert.match(await text(dialog.locator('[data-error="rule"]')), /^This isn't valid JSON: /);
  assert.equal(writes().length, beforeRule, 'invalid rule JSON is never sent');
  await field('level').selectOption({ label: 'Moderators and up' });
  assert.equal(await text(field('level-hint')), 'Saving drops the custom rule and uses this level.');
  await until(async () => (await dialog.locator('[data-error="rule"]').count()) === 0, 'a level makes the rule unused');
  assert.match(await text(field('rule-hint')), /^Not used: a level is picked/);
  await shot('editor-rule-to-level-dark-390');
  await expectWrite('rule to level PUT', 'PUT', 'c4', { permissionExpression: null, userLevel: 7, userLevelName: 'mod' });
  await closed();
  await toast('Saved !vipzone').waitFor();
  assert.match(await text(row('!vipzone').locator('.cmd-rules')), /^Moderators and up/);
  // A broken rule: shown, editable and replaceable by a level (nothing saved here).
  await openEditor('!oldrule');
  assert.equal(await text(field('level').locator('option[value="rule"]')), 'Custom rule (broken)');
  assert.match(await text(field('level-hint')), /^The stored rule is broken: chat blocks every use\./);
  await more();
  assert.equal(await field('rule').inputValue(), JSON.stringify(BROKEN_RULE, null, 2));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await closed();

  // ---------------------------------------------------------------- Keyword: the phrase and its match
  await openEditor('good morning');
  assert.equal(await text(dialog.locator('h2')), 'Edit keyword “good morning”');
  assert.equal(await dialog.locator('.ced-trigger__bang').count(), 0);
  assert.equal(await field('trigger').inputValue(), 'good morning');
  assert.equal(await field('match').inputValue(), 'anywhere');
  assert.deepEqual(await field('match').locator('option').allInnerTexts(), ['Starts with', 'Contains', 'Is exactly']);
  assert.equal(await text(field('match-hint')), 'A message matches when the keyword appears anywhere in it.');
  await more();
  assert.equal(await field('type').inputValue(), 'keyword');
  assert.equal(await text(field('type-hint')), 'Changes how chat triggers it. Keywords always post their reply.');
  assert.equal(await field('func').count(), 0, 'keywords always post their reply');
  await field('match').selectOption({ label: 'Is exactly' });
  await expectWrite('keyword match PUT', 'PUT', 'c7', { keywordSettings: { matchMode: 'exact' } });
  await closed();
  await toast('Saved keyword “good morning”').waitFor();
  // A phrase can't become a command as is: chat reads one word after "!". Switching asks for one right away.
  await openEditor('good morning');
  await more();
  await field('type').selectOption({ label: 'Command' });
  assert.equal(await dialog.locator('.ced-trigger__bang').count(), 1);
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'No spaces: a command is one word.', 'checked as soon as the type switches');
  const beforeType = writes().length;
  await saveButton.click();
  await page.waitForTimeout(200);
  assert.equal(writes().length, beforeType, 'a phrase is never sent as a command');
  await shot('editor-keyword-to-command-dark-390');
  await field('trigger').fill('goodmorning');
  await until(async () => (await dialog.locator('[data-error="trigger"]').count()) === 0, 'a one-word trigger clears the error');
  // The server's own trigger refusal shows under the trigger, not above the footer.
  const refusal = `"goodmorning" can't be typed as a chat command: use letters and numbers only (chat stops at the first space or symbol)`;
  state.next = fail(400, refusal);
  await expectWrite('refused keyword to command PUT', 'PUT', 'c7', { cmd: 'goodmorning', activation: 'command' });
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), refusal);
  assert.equal(await dialog.locator('[data-server-error]').count(), 0, 'a refused trigger is not a general error');
  await expectWrite('keyword to command PUT', 'PUT', 'c7', { cmd: 'goodmorning', activation: 'command' });
  await closed();
  await toast('Saved !goodmorning').waitFor();
  assert.equal(await row('!goodmorning').count(), 1);
  assert.doesNotMatch(await text(row('!goodmorning').locator('summary')), /Keyword/);

  // ---------------------------------------------------------------- Type: a command becomes a keyword
  await openEditor('!chill');
  await more();
  await field('type').selectOption({ label: 'Keyword' });
  assert.equal(await dialog.locator('.ced-trigger__bang').count(), 0);
  assert.match(await text(dialog.locator('.lf-step__label').first()), /Keyword/);
  assert.equal(await field('match').inputValue(), 'start');
  assert.equal(await field('func').count(), 0);
  await shot('editor-type-keyword-dark-390');
  await expectWrite('type PUT', 'PUT', 'c1', { activation: 'keyword', keywordSettings: { matchMode: 'start' } });
  await closed();
  await toast('Saved keyword “chill”').waitFor();
  assert.equal(await row('chill').count(), 1);
  assert.match(await text(row('chill')), /Keyword/);

  // ---------------------------------------------------------------- Built-in delete: confirmed, with the "may come back" note
  const shoutBody = await openRow('!shout');
  await shoutBody.locator('[data-action="delete"]').click();
  await confirm.waitFor();
  await settle();
  assert.equal(await text(confirm.locator('h2')), 'Delete !shout?');
  assert.equal(await text(confirm.locator('.confirm__message')),
    `It stops working in ${LOGIN}'s chat right away. There's no undo here, and ${LOGIN} isn't notified. It's a built-in command: the bot may add it back when the channel signs in again.`);
  const beforeDelete = writes().length;
  await shot('delete-builtin-dark-390');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await waitWrite(beforeDelete + 1, 'built-in DELETE');
  assert.equal(lastWrite().method, 'DELETE');
  assert.equal(lastWrite().path, `${BASE_PATH}/c2`);
  assert.equal(lastWrite().body, null);
  await toast('!shout deleted').waitFor();
  await until(async () => (await row('!shout').count()) === 0, 'built-in row removed');

  // ---------------------------------------------------------------- Create: a plain reply
  await newButton.click();
  await dialog.waitFor();
  await settle();
  await noLocks('new command');
  assert.equal(await text(dialog.locator('h2')), 'New command');
  assert.equal(await text(saveButton), 'Create command');
  await more();
  assert.equal(await field('func').inputValue(), 'custom', 'new commands default to a plain reply');
  await saveButton.click();
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="reply"]')), 'Type what the bot replies.');
  const beforeCreate = writes().length;
  await field('trigger').fill('promo');
  await field('reply').fill('Hi $(user)!');
  await field('level').selectOption({ label: 'VIPs and up' });
  await expectWrite('409 POST', 'POST', null, { name: 'promo', cmd: 'promo', func: 'custom', message: 'Hi $(user)!', channel: LOGIN, cooldown: 10, enabled: true, userLevel: 5, userLevelName: 'vip' });
  await dialog.locator('[data-error="trigger"]').waitFor();
  assert.equal(await text(dialog.locator('[data-error="trigger"]')), 'Another command already uses !promo.');
  await field('trigger').fill('!hello');
  await shot('editor-create-dark-390');
  // `func: 'custom'`: a text reply, never a built-in action named like the trigger.
  await expectWrite('create POST', 'POST', null, { name: 'hello', cmd: 'hello', func: 'custom', message: 'Hi $(user)!', channel: LOGIN, cooldown: 10, enabled: true, userLevel: 5, userLevelName: 'vip' });
  assert.equal(writes().length, beforeCreate + 2);
  await closed();
  await toast('!hello created').waitFor();
  await row('!hello').locator('[data-command-body]').waitFor();
  // Nine, less !socials and the built-in !shout, plus !hello.
  assert.match(await text(page.locator('.cmd-answer')), /^8 commands\./);

  // ---------------------------------------------------------------- Layout + accessibility matrix
  for (const [mode, width] of [['dark', 320], ['dark', 390], ['light', 1280], ['light', 390], ['dark', 1280], ['light', 320]]) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await goto();
    const label = `${mode} ${width}`;
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label}: theme`);
    // The top row: opening a lower one scrolls content under the see-through sticky navbar, which axe can't measure.
    await openRow('!discord');
    await noOverflow(`${label} list`);
    if (width < 960) await touchTargets(page.locator('app-channel-commands'), '.cmd-actions .lf-btn, .cmd-new', label);
    await axe(`${label} list`, 'app-channel-shell', 'app-navbar');
    await shot(`list-${mode}-${width}`);
    await openEditor('!oldrule');
    await more();
    // Show every note: a changed function and an edited rule.
    await field('func').selectOption('promo');
    await note('runs').waitFor();
    await noOverflow(`${label} editor`);
    const box = await dialog.boundingBox();
    if (width >= 640) assert.ok(box.x > 0 && box.y > 0, `${label}: centred card`);
    else assert.ok(Math.abs(box.y + box.height - (width === 1280 ? 900 : 844)) <= 1 && box.width === width, `${label}: bottom sheet`);
    if (width < 960) await touchTargets(dialog, EDITOR_TARGETS, `${label} editor`);
    await axe(`${label} editor`, 'dialog[data-command-editor]');
    await shot(`editor-${mode}-${width}`);
    await page.keyboard.press('Escape');
    await closed();
  }

  assert.equal(requests.filter((r) => r.path.startsWith('/commands')).length, 0, 'never the site routes');
  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin command editing (owner routes, no locks): list + Delete on every row, edit sends only changed fields, validation + 409 inline, optimistic on/off with rollback, confirmed delete (+ refused), legacy rows, built-in trigger/reply/description edit, "Runs" change + built-in action note, blocks JSON edit (root sent, invalid JSON inline, server 400 above the footer, Escape not while saving), block command → plain reply, custom rule JSON edit + level switch (permissionExpression null), broken rule shown, keyword match change, type switch (activation), built-in delete with "may come back" note, create as a plain reply (+ 409), old lock texts gone, 320/390/1280 dark+light overflow/axe/touch targets. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
