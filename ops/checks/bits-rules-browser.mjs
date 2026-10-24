/**
 * Shared Bits rules in the browser (Chat events → Cheers, and Overlay Studio → Bits tab).
 * Every API is mocked in the browser (in-memory rules, eventsubs and overlay state); nothing reaches production.
 * Chat events: empty state + example presets, stepped dialog (amount kinds, inline validation, variable chips),
 *   amount tester, on/off switch with rollback, delete confirmation, default-message save without cheerTiers,
 *   owner-only Overlay Studio link, read-only view for channel admins without manage.
 * Overlay Studio: rules listed with their look state, "Give it its own look" saves a ruleId look (no amounts),
 *   sample-amount matches, "Use the default look" + undo, a rule created here gets a look, turning alerts on.
 * Phones and desktop, dark and light, Spanish; axe (wcag2a/2aa/21aa) and no horizontal overflow.
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
const user = { id: '990777', login: 'cheer_owner', display_name: 'Cheer_Owner' };
const app = { name: 'Cheer_Owner', email: 'cheers@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
  twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };

const cheersEvent = {
  _id: 'evt-bits', name: 'Cheers', type: 'channel.bits.use', version: '1', condition: { broadcaster_user_id: 'user' }, icon: 'Heart',
  color: 'bg-pink-500', textColor: 'text-white', releaseStage: 'stable', enabled: false, plan_tier: 'free',
  description: { EN: 'Message to show when a viewer cheers', ES: 'Mensaje que se enviará cuando un espectador apoye' },
  config: [
    { id: 'defaultCheerMessage', dbId: 'message', label: { EN: 'Default Cheer Message', ES: 'Mensaje de Apoyo por Defecto' }, type: 'text', value: '$(user) cheered $(cheer.amount)', canDisable: true },
    { id: 'cheerTiers', dbId: 'cheerTiers', label: { EN: 'Cheer Tiers Messages', ES: 'Mensajes de Tiers de Apoyo' }, type: 'message-tiers', value: [], canDisable: true }
  ],
  tierLimits: { premium: 2, free: 0, pro: 5 }
};
const followEvent = { ...cheersEvent, _id: 'evt-follow', name: 'Follow', type: 'channel.follow', version: '2', icon: 'UserPlus',
  description: { EN: 'Thank new followers', ES: 'Agradece a los nuevos seguidores' },
  config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Thanks $(user)!', canDisable: true }] };
const subscription = (type, extra = {}) => ({ _id: `sub-${type}`, id: `tw-${type}`, status: 'enabled', type, version: '1', enabled: true,
  condition: { broadcaster_user_id: user.id }, transport: { method: 'webhook', callback: 'https://example.invalid' }, created_at: new Date().toISOString(),
  cost: 0, channelID: user.id, channel: user.login, message: '', cheerTiers: [], ...extra });

const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
function overlayState() {
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k,
    { duration: 5, widgets: [layer(k + '-art', 'animation', 50, 50, 120, 120), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 })] }])) };
  const widgets = [layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] })];
  const main = { id: 'main', name: 'Gameplay', revision: 1, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets,
    published: { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: [], designs: [structuredClone(design)] } };
  return { schemaVersion: 1, revision: 4, scenes: [main], designs: [design] };
}

const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });

async function open(path, { theme = 'light', width = 1280, language = 'en', rules = [], canManage = true, chatEnabled = true } = {}) {
  const ctx = {
    calls: [], failNext: false, eventsubPatches: [],
    rules: structuredClone(rules), revision: rules.length ? 3 : 0, nextId: 1,
    subs: [subscription('channel.bits.use', { enabled: chatEnabled, message: 'Thanks $(user) for $(cheer.amount) Bits!' })],
    overlay: overlayState(), overlayWrites: 0
  };
  const view = () => {
    const looks = {};
    for (const d of ctx.overlay.designs) for (const v of d.variants?.bits ?? []) looks[v.ruleId] = (looks[v.ruleId] ?? 0) + 1;
    const sub = ctx.subs[0];
    return { revision: ctx.revision, rules: ctx.rules, maxRules: 50, canManage, looks, chat: { subscribed: true, enabled: sub.enabled, defaultMessage: sub.message } };
  };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce', hasTouch: width < 640 });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language); sessionStorage.clear();
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app: { ...app, language }, theme, language });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    const ok = (data, status = 200) => route.fulfill({ status, json: { error: false, status, message: 'OK', data } });
    const fail = (status, message) => route.fulfill({ status, json: { error: true, status, message } });
    const body = ['POST', 'PATCH', 'PUT'].includes(method) && request.postData() ? request.postDataJSON() : undefined;
    if (p === '/auth/session') return ok({ twitch: user, app: { ...app, language } });
    if (p.startsWith('/auth/access/')) {
      const permission = url.searchParams.get('permission') || '';
      return ok({ allowed: canManage || !permission.endsWith(':manage'), role: canManage ? 'owner' : 'admin', planTier: 'free' });
    }
    if (p.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'free' });
    if (p === '/site/events') return ok([cheersEvent, followEvent]);
    if (p === `/eventsubs/${user.id}` && method === 'GET') return ok(ctx.subs);
    if (p.startsWith(`/eventsubs/${user.id}/`) && method === 'PATCH') {
      ctx.eventsubPatches.push(body); Object.assign(ctx.subs[0], body?.config ?? body ?? {});
      return ok(ctx.subs[0]);
    }
    const rulesBase = `/bits-rules/${user.id}`;
    if (p.startsWith(rulesBase)) {
      ctx.calls.push({ method, path: p.slice(rulesBase.length), body });
      if (method === 'GET') return ok(view());
      if (!canManage) return fail(403, 'You can view these Bits rules but not change them');
      if (ctx.failNext) { ctx.failNext = false; return fail(500, 'Bits rules are temporarily unavailable'); }
      ctx.revision++;
      if (method === 'POST') { const id = `rule-${ctx.nextId++}`; ctx.rules.push({ id, ...body }); return ok({ ...view(), created: id }, 201); }
      const id = decodeURIComponent(p.split('/').at(-1));
      const index = ctx.rules.findIndex(r => r.id === id);
      if (index < 0) return fail(404, 'This rule was deleted. Reload to see the current rules.');
      if (method === 'PATCH') ctx.rules[index] = { ...ctx.rules[index], ...body };
      if (method === 'DELETE') ctx.rules.splice(index, 1);
      return ok(view());
    }
    if (p === `/overlay-studio/${user.id}`) {
      if (method === 'PUT') { ctx.overlayWrites++; ctx.overlay = { ...body, revision: ctx.overlay.revision + 1, scenes: body.scenes.map(s => ({ ...s, publicId: 'a'.repeat(48), revision: 1, published: ctx.overlay.scenes[0].published })) }; }
      return ok(ctx.overlay);
    }
    if (p.endsWith('/queue')) return ok({ state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] });
    if (p.endsWith('/connections')) return ok({ checkedAt: Date.now(), pollingFailed: false, scenes: [] });
    if (p.endsWith('/twitch-events')) return ok({ poll: { ready: true }, prediction: { ready: true } });
    if (p.endsWith('/preview')) return ok(body.texts.map(t => t.replaceAll('$(user)', body.user).replaceAll('$(cheer.amount)', body.amount)));
    if (p.startsWith(`/asset-library/${user.id}`)) return ok({ assets: [], usedBytes: 0, quotaBytes: 1e9, maxFileBytes: 5e7, planTier: 'free' });
    if (p.startsWith('/triggers')) return ok([]);
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /TypeError|NG0/.test(msg.text())) errors.push(msg.text()); });
  await page.goto(`${base}/${user.login}/modules/${path}`);
  return { context, page, ctx };
}

const until = async (fn, label, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); }
  assert.fail(`timed out: ${label}`);
};
async function axe(page, label, selector) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(sel => window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }), selector);
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe ${label}`);
}
async function noOverflow(page, label) {
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  assert.ok(widths.doc <= widths.win + 1, `${label}: horizontal overflow ${widths.doc} > ${widths.win}`);
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false }); };

async function openCheers(page, es = false) {
  const card = page.locator('app-event-card').filter({ has: page.getByRole('heading', { name: /Cheers/ }) });
  await card.waitFor();
  await card.locator('.lf-ev__actions .lf-btn').first().click();
  const panel = card.locator('app-bits-rules-panel'); await panel.waitFor();
  await panel.getByRole('heading', { name: es ? 'Reglas de Bits' : 'Bits rules' }).waitFor();
  return { card, panel };
}
const dialog = page => page.getByRole('dialog');
const rule = (panel, text) => panel.locator('.br-row').filter({ hasText: text });

try {
  // 1. Chat events: full create / test / toggle / delete flow (desktop, light).
  {
    const { context, page, ctx } = await open('chat-events');
    const { card, panel } = await openCheers(page);
    await panel.getByText('No Bits rules yet.').waitFor();
    assert.equal(await card.locator('.lf-chip[data-tone=alpha]').count(), 0, 'no alpha chip once stable');
    const link = panel.getByRole('link', { name: 'Choose alert looks in Overlay Studio' });
    assert.equal(await link.getAttribute('href'), `/${user.login}/modules/overlays`);
    await shot(page, 'chat-empty-1280-light');

    // Example preset → dialog prefilled as "1,000 or more".
    await panel.getByRole('button', { name: '1,000+ Bits' }).click();
    const d = dialog(page); await d.waitFor();
    assert.equal(await d.getByRole('radio', { name: 'Or more' }).getAttribute('aria-checked'), 'true');
    assert.equal(await d.getByLabel('At least').inputValue(), '1000');
    await d.getByText('Cheers of 1,000 Bits or more').waitFor();
    await d.getByText('“Thanks $(user) for $(cheer.amount) Bits!”').waitFor();
    await d.getByRole('button', { name: 'Add rule' }).click();
    await until(() => ctx.rules.length === 1, 'preset rule created');
    assert.deepEqual(ctx.calls.at(-1).body, { name: '', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true });
    await until(() => dialog(page).count().then(n => n === 0), 'dialog closes');
    await rule(panel, '1,000+').waitFor();
    assert.equal(await rule(panel, '1,000+').locator('.br-row__name').count(), 0, 'unnamed rule shows its amount once');

    // New rule: exact 69 with its own message; validation first.
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await dialog(page).getByRole('radio', { name: 'Exactly' }).click();
    await dialog(page).getByLabel('Amount', { exact: true }).fill('69');
    await dialog(page).getByText('Its own message').click();
    await dialog(page).getByRole('button', { name: 'Add rule' }).click();
    const message = dialog(page).getByLabel('Message', { exact: true });
    await until(() => message.getAttribute('aria-invalid').then(v => v === 'true'), 'empty message flagged');
    await dialog(page).getByText('Write the message, or pick another option.').waitFor();
    assert.equal(ctx.calls.filter(c => c.method === 'POST').length, 1, 'invalid rule not sent');
    await message.fill('Nice ');
    await dialog(page).getByRole('button', { name: 'Bits amount' }).click();
    await until(() => message.inputValue().then(v => v === 'Nice $(cheer.amount)'), 'variable inserted');
    await dialog(page).getByLabel(/^Name/).fill('Nice');
    await shot(page, 'chat-dialog-1280-light');
    await dialog(page).getByRole('button', { name: 'Add rule' }).click();
    await until(() => ctx.rules.length === 2, 'exact rule created');
    assert.deepEqual(ctx.calls.at(-1).body, { name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'Nice $(cheer.amount)' }, alert: true });

    // Rows read like a ladder: 69 before 1,000+.
    await until(() => panel.locator('.br-row .br-row__amount').allTextContents().then(t => t.map(x => x.trim()).join('|') === '69 Bits|1,000+ Bits'), 'sorted rows');

    // Tester.
    const tryInput = panel.getByLabel('Try an amount');
    const result = panel.locator('.br-try__result');
    await tryInput.fill('69');
    await until(() => result.innerText().then(t => t.includes('69 Bits → “Nice”') && t.includes('Sends its own chat message') && t.includes('Plays the default alert')), 'tester exact');
    await until(() => rule(panel, 'Nice').evaluate(e => e.classList.contains('br-row--hit')), 'matched row highlighted');
    await tryInput.fill('70');
    await until(() => result.innerText().then(t => t.includes('no rule') && t.includes('Sends the default message')), 'tester no rule');
    await tryInput.fill('1500');
    await until(() => result.innerText().then(t => t.includes('“1,000+ Bits”')), 'tester or more');

    // Switch off, then a failed switch rolls back.
    const niceSwitch = panel.getByRole('switch', { name: 'Nice on' });
    await niceSwitch.click();
    await until(() => ctx.rules[1].enabled === false, 'switch saved');
    assert.deepEqual(ctx.calls.at(-1), { method: 'PATCH', path: `/rules/${ctx.rules[1].id}`, body: { enabled: false } });
    await until(() => niceSwitch.getAttribute('aria-checked').then(v => v === 'false'), 'switch off');
    await tryInput.fill('69');
    await until(() => result.innerText().then(t => t.includes('no rule')), 'off rule ignored');
    ctx.failNext = true;
    await niceSwitch.click();
    await page.getByText("Couldn't change the rule").waitFor();
    await until(() => niceSwitch.getAttribute('aria-checked').then(v => v === 'false'), 'rolled back');

    // Edit → delete needs a confirmation.
    await panel.getByRole('button', { name: 'Edit Nice' }).click();
    assert.equal(await dialog(page).getByLabel('Amount', { exact: true }).inputValue(), '69');
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.getByRole('alertdialog'); await confirm.getByText('Delete “Nice”?').waitFor();
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await until(() => page.getByRole('alertdialog').count().then(n => n === 0), 'keep closes the confirmation');
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete rule' }).click();
    await until(() => ctx.rules.length === 1, 'deleted');
    assert.equal(ctx.calls.at(-1).method, 'DELETE');

    // Escape closes the dialog; the default message Save no longer sends cheer tiers.
    await panel.getByRole('button', { name: 'Add rule' }).click(); await dialog(page).waitFor();
    await page.keyboard.press('Escape');
    await until(() => dialog(page).count().then(n => n === 0), 'escape closes');
    await card.getByRole('textbox', { name: 'Default Cheer Message' }).fill('Gracias $(user)!');
    await card.getByRole('button', { name: 'Save changes' }).click();
    await until(() => ctx.eventsubPatches.length > 0, 'default message saved');
    const saved = JSON.stringify(ctx.eventsubPatches.at(-1));
    assert.ok(saved.includes('Gracias $(user)!') && !saved.includes('cheerTiers'), `default save payload: ${saved}`);

    await axe(page, 'chat 1280 light', 'app-chat-events-page'); await noOverflow(page, 'chat 1280');
    await shot(page, 'chat-rules-1280-light');
    await context.close();
  }

  // 2. Chat events on phones: dark English and Spanish 320, dialog as a bottom sheet.
  for (const opts of [{ width: 390, theme: 'dark' }, { width: 320, theme: 'light', language: 'es' }, { width: 1280, theme: 'dark' }]) {
    const es = opts.language === 'es';
    const seeded = [
      { id: 'r-big', name: 'Big cheer', enabled: true, min: 1000, max: null, chat: { mode: 'custom', message: 'WOW $(user) sent $(cheer.amount) Bits!!' }, alert: true },
      { id: 'r-quiet', name: '', enabled: false, min: 1, max: 99, chat: { mode: 'silent', message: '' }, alert: false }
    ];
    const { context, page } = await open('chat-events', { ...opts, rules: seeded });
    const { panel } = await openCheers(page, es);
    await rule(panel, '1–99').waitFor();
    await noOverflow(page, `chat ${opts.width}`);
    await axe(page, `chat ${opts.width} ${opts.theme}`, 'app-chat-events-page');
    await panel.locator('.br-panel').scrollIntoViewIfNeeded();
    await shot(page, `chat-rules-${opts.width}-${opts.theme}${es ? '-es' : ''}`);
    await panel.getByRole('button', { name: es ? 'Editar Big cheer' : 'Edit Big cheer' }).click();
    await dialog(page).waitFor();
    const box = await dialog(page).boundingBox();
    if (opts.width < 640) assert.ok(Math.abs(box.y + box.height - 844) < 2, 'bottom sheet on phones');
    await dialog(page).getByRole('radio', { name: es ? 'Entre' : 'Between' }).click();
    assert.equal(await dialog(page).getByLabel(es ? 'Hasta (incluida)' : 'To (included)').inputValue(), '4999', 'range end suggested');
    await noOverflow(page, `dialog ${opts.width}`);
    await axe(page, `dialog ${opts.width} ${opts.theme}`, 'app-bits-rule-dialog');
    await shot(page, `chat-dialog-${opts.width}-${opts.theme}${es ? '-es' : ''}`);
    await context.close();
  }

  // 3. Channel admin without manage: read-only rows, no editing controls.
  {
    const { context, page, ctx } = await open('chat-events', { width: 390, rules: [{ id: 'r-big', name: 'Big cheer', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true }], canManage: false });
    const { panel } = await openCheers(page);
    await rule(panel, 'Big cheer').getByText('On', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('switch').count(), 0);
    assert.equal(await panel.getByRole('button', { name: /Add|Edit/ }).count(), 0);
    assert.ok(ctx.calls.every(c => c.method === 'GET'));
    await context.close();
  }

  // 4. Overlay Studio: Bits looks follow the shared rules.
  for (const opts of [{ width: 1280, theme: 'light' }, { width: 390, theme: 'dark' }]) {
    const seeded = [
      { id: 'r-big', name: 'Big cheer', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true },
      { id: 'r-nice', name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'Nice' }, alert: false }
    ];
    const { context, page, ctx } = await open('overlays', { ...opts, rules: seeded });
    await page.locator('app-overlay-editor .stage').waitFor();
    await page.locator('.design-row__actions button').first().click();
    await page.locator('.design-event-tabs button').nth(1).click();
    const looks = page.locator('app-overlay-bits-looks'); await looks.waitFor();
    await looks.getByText('2 rules · 0 with their own look').waitFor();
    assert.equal(await looks.locator('.bl__tab').count(), 1, 'only the default tab');
    await looks.getByText('Rules using the default look (2)').waitFor();

    // Sample amounts explain what plays.
    const sample = page.getByLabel('Sample amount', { exact: true });
    const match = page.locator('.variant-match');
    await sample.fill('69'); await until(() => match.innerText().then(t => t.includes('This sample plays: Nice, no alert')), 'no alert match');
    await sample.fill('5'); await until(() => match.innerText().then(t => t.includes('no rule, default look')), 'no rule');
    await sample.fill('1500'); await until(() => match.innerText().then(t => t.includes('Big cheer, default look')), 'rule default look');

    // Give Big cheer its own look; edit it; save.
    await looks.getByRole('button', { name: 'Give Big cheer its own look' }).click();
    const bigTab = looks.locator('.bl__tab').filter({ hasText: 'Big cheer' });
    await until(() => bigTab.getAttribute('aria-pressed').then(v => v === 'true'), 'look tab selected');
    await until(() => match.innerText().then(t => t.includes('This sample plays: Big cheer') && !t.includes('default look')), 'own look match');
    await page.locator('.properties textarea').fill('BIG $(user)');
    await page.locator('.save-button').click();
    await until(() => ctx.overlay.designs[0].variants?.bits?.length === 1, 'look saved');
    const look = ctx.overlay.designs[0].variants.bits[0];
    assert.equal(look.ruleId, 'r-big'); assert.equal(look.min, undefined); assert.equal(look.max, undefined);
    assert.equal(look.layout.widgets[1].text, 'BIG $(user)'); assert.equal(ctx.overlay.designs[0].events.bits.widgets[1].text, '$(user)', 'default look untouched');

    // Use the default look, then undo.
    await looks.getByRole('button', { name: 'Use the default look' }).click();
    await until(() => looks.locator('.bl__tab').count().then(n => n === 1), 'look removed');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await until(() => looks.locator('.bl__tab').count().then(n => n === 2), 'undo restores look');

    // Nice has alerts off: turning them on is a shared rule change.
    await looks.locator('details.bl__more').evaluate(d => { d.open = true; });
    await looks.getByRole('button', { name: 'Turn the alert on for Nice' }).click();
    await until(() => ctx.rules.find(r => r.id === 'r-nice').alert === true, 'alert turned on');
    await looks.getByRole('button', { name: 'Give Nice its own look' }).waitFor();

    // A rule created here gets its own look right away.
    await looks.getByRole('button', { name: 'New rule' }).click();
    await dialog(page).getByText('Plays your Bits alert. After saving, you can give this rule its own look here.').waitFor();
    await dialog(page).getByRole('radio', { name: 'Exactly' }).click();
    await dialog(page).getByLabel('Amount', { exact: true }).fill('500');
    await dialog(page).getByRole('button', { name: 'Add rule' }).click();
    await until(() => ctx.rules.length === 3, 'rule created from overlay');
    const created = ctx.rules[2].id;
    await until(() => looks.locator('.bl__tab[aria-pressed=true]').innerText().then(t => t.includes('500 Bits')), 'new look selected');
    await page.locator('.save-button').click();
    await until(() => ctx.overlay.designs[0].variants.bits.some(v => v.ruleId === created), 'new look saved');

    await noOverflow(page, `overlay ${opts.width}`);
    await axe(page, `overlay ${opts.width} ${opts.theme}`, 'app-overlay-bits-looks');
    await looks.scrollIntoViewIfNeeded();
    await shot(page, `overlay-looks-${opts.width}-${opts.theme}`);
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log('PASS Bits rules: chat events presets/dialog/validation/tester/switch rollback/delete/default save; read-only admins; overlay looks follow shared rules (give/use default/undo/new rule/alert on); phones, dark/light, Spanish, axe, overflow');
} finally {
  await browser.close();
}
