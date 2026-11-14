/**
 * Overlay Studio UX touches in the browser. Every API is mocked in the browser (in-memory overlay, Bits rules);
 * nothing reaches production (any origin other than the preview and the mocked API is aborted; websockets closed).
 * Covers:
 *  1. Alert design + Test on desktop (1280, 1920): Test replaces the timeline in the dock, the stage keeps a usable
 *     size and zoom, the floating toolbar stays off the event tabs, closing Test brings the timeline back.
 *  2. Timeline playback never runs hidden: opening Test stops it (a), and so does resizing from the phone layout
 *     back to desktop while Test is open (b).
 *  3. Canvas hint: short desktop text, touch text on phones (one line), Spanish strings, and the hint box never
 *     overlaps the toolbar, event tabs, canvas size label or off-canvas pill (960–1920, overlay and design).
 *  4. Phone save bar (390, 320): one row, status kept for screen readers, every phone tab's last control reachable
 *     above the bar; desktop shows the status next to the buttons.
 *  5. Overlay tab: Live overlay controls lead; the recovery note sits inside "Platform & chat command".
 *  6. "Used in 1 overlay" (singular) vs "Used in 2 overlays", in the design header chip and the Alert designs list.
 *  7. Alert layer note "These choices apply to this layer only."
 *  8. Bits looks in the desktop sidebar: no sideways scrolling, no overlapping buttons, amounts visible, give a look.
 *  9. No horizontal document overflow at 320, 390, 960, 1280, 1920 in overlay mode and in a design.
 * 10. axe (wcag2a/2aa/21aa) on app-overlay-editor: desktop design with Test open (dark, light), phone overlay (dark).
 */
import { openStudio, studioToggle } from '/root/saas/ops/checks/overlay-studio-ui-helpers.mjs';
import assert from 'node:assert/strict';
const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || `${tools}/node_modules/playwright/index.mjs`);
const axePath = process.env.AXE_PATH || `${tools}/node_modules/axe-core/axe.min.js`;
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL is required');
const api = 'https://api.domdimabot.com';
const user = { id: '990777', login: 'cheer_owner', display_name: 'Cheer_Owner' };
const app = { name: 'Cheer_Owner', email: 'cheers@example.invalid', language: 'en', plan_tier: 'free', actived: true, chat_enabled: true,
  twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };

const HINT_EN = 'Drag to move. Pull the corner to resize.';
const HINT_TOUCH_EN = 'Tap a layer, then drag it. Pull the corner to resize.';
const HINT_ES = 'Arrastra para mover. Jala la esquina para cambiar el tamaño.';
const HINT_TOUCH_ES = 'Toca una capa y arrástrala. Jala la esquina para cambiar el tamaño.';
const LONG_NAME = 'Mega cheer for the whole community tonight'; // 42 characters

const layer = (id, kind, x, y, width, height, extra = {}) => ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
const rulesFixture = [
  { id: 'r-1', name: '', enabled: true, min: 1, max: 99, chat: { mode: 'default', message: '' }, alert: true },
  { id: 'r-nice', name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'Nice' }, alert: true },
  { id: 'r-100', name: 'Hype', enabled: true, min: 100, max: 499, chat: { mode: 'default', message: '' }, alert: true },
  { id: 'r-500', name: LONG_NAME, enabled: true, min: 500, max: 999, chat: { mode: 'default', message: '' }, alert: true },
  { id: 'r-big', name: 'Big cheer legend', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true },
  { id: 'r-silent', name: 'Quiet', enabled: false, min: 5000, max: null, chat: { mode: 'silent', message: '' }, alert: false }
];
/** Two designs; "starter" is used by one overlay (or by both when usedTwice). Two Bits rules have their own look. */
function overlayState({ usedTwice = false } = {}) {
  const lay = k => ({ duration: 5, widgets: [layer(k + '-art', 'animation', 50, 50, 120, 120), layer(k + '-text', 'text', 190, 65, 530, 90, { text: '$(user)', fontSize: 48 })] });
  const design = { id: 'starter', name: 'Aurora alerts', revision: 2, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(k => [k, lay(k)])),
    variants: {
      bits: [{ id: 'v1', name: 'Nice', enabled: true, ruleId: 'r-nice', layout: lay('bits') }, { id: 'v3', name: 'Big', enabled: true, ruleId: 'r-big', layout: lay('bits') }],
      sub: [{ id: 's1', name: 'Tier 2 subs', enabled: true, tier: '2000', layout: lay('sub') }],
      raid: [{ id: 'ra1', name: 'Big raid', enabled: true, min: 50, layout: lay('raid') }] } };
  const design2 = { ...structuredClone(design), id: 'neon', name: 'Neon minimal', variants: {} };
  const alert = layer('alert-1', 'alert', 640, 450, 640, 192, { designId: 'starter', events: ['sub', 'bits', 'follow', 'raid'] });
  const widgets = [
    layer('tts-1', 'tts', 670, 62, 580, 160), layer('trigger-1', 'trigger', 75, 755, 510, 230), layer('clip-1', 'clip', 1410, 775, 430, 250),
    layer('text-1', 'text', 80, 60, 420, 80, { text: 'Follow goal: 120', fontSize: 40, name: 'Goal title' }),
    layer('shape-1', 'shape', 60, 40, 460, 120, { color: '#7c3aed', opacity: 0.4 }), alert];
  const main = { id: 'main', name: 'Gameplay', revision: 1, publicId: 'a'.repeat(48), width: 1920, height: 1080, waitFor: [], widgets,
    published: { width: 1920, height: 1080, widgets: structuredClone(widgets), waitFor: [], designs: [structuredClone(design)] } };
  const secondWidgets = usedTwice ? [...structuredClone(widgets.slice(0, 2)), { ...structuredClone(alert), id: 'alert-2' }] : structuredClone(widgets.slice(0, 2));
  const second = { ...structuredClone(main), id: 'chat', name: 'Just chatting', publicId: 'b'.repeat(48), widgets: secondWidgets };
  return { schemaVersion: 1, revision: 4, scenes: [main, second], designs: [design, design2] };
}

const errors = [];
const started = Date.now();
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.SAAS_CHROMIUM_PATH || undefined });

async function open({ theme = 'dark', width = 1280, height = 800, touch = width < 640, usedTwice = false } = {}) {
  const ctx = { rules: structuredClone(rulesFixture), revision: 3, nextId: 1, overlay: overlayState({ usedTwice }) };
  const view = () => {
    const looks = {};
    for (const d of ctx.overlay.designs) for (const v of d.variants?.bits ?? []) looks[v.ruleId] = (looks[v.ruleId] ?? 0) + 1;
    return { revision: ctx.revision, rules: ctx.rules, maxRules: 50, canManage: true, looks, chat: { subscribed: true, enabled: true, defaultMessage: 'Thanks $(user) for $(cheer.amount) Bits!' } };
  };
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: touch });
  await context.addInitScript(({ user, app, theme }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); sessionStorage.clear();
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.origin !== api) return route.abort();
    const ok = (data, status = 200) => route.fulfill({ status, json: { error: false, status, message: 'OK', data } });
    const body = ['POST', 'PATCH', 'PUT'].includes(method) && request.postData() ? request.postDataJSON() : undefined;
    if (p === '/auth/session') return ok({ twitch: user, app });
    if (p.startsWith('/auth/access/')) return ok({ allowed: true, role: 'owner', planTier: 'free' });
    if (p.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'free' });
    if (p === '/site/events') return ok([]);
    if (p.startsWith(`/bits-rules/${user.id}`)) {
      if (method === 'GET') return ok(view());
      ctx.revision++;
      if (method === 'POST') { const id = `rule-${ctx.nextId++}`; ctx.rules.push({ id, ...body }); return ok({ ...view(), created: id }, 201); }
      const id = decodeURIComponent(p.split('/').at(-1)), index = ctx.rules.findIndex(r => r.id === id);
      if (method === 'PATCH' && index >= 0) ctx.rules[index] = { ...ctx.rules[index], ...body };
      if (method === 'DELETE' && index >= 0) ctx.rules.splice(index, 1);
      return ok(view());
    }
    if (p === `/overlay-studio/${user.id}`) { if (method === 'PUT') ctx.overlay = { ...body, revision: ctx.overlay.revision + 1 }; return ok(ctx.overlay); }
    if (p.endsWith('/queue')) return ok({ state: { revision: 0, all: false, platforms: {} }, connected: 1, needsRefresh: 0, events: [] });
    if (p.endsWith('/connections')) return ok({ checkedAt: Date.now(), pollingFailed: false, scenes: [] });
    if (p.endsWith('/twitch-events')) return ok({ poll: { ready: true }, prediction: { ready: true } });
    if (p.endsWith('/preview')) return ok((body?.texts ?? []).map(t => t.replaceAll('$(user)', body.user).replaceAll('$(cheer.amount)', body.amount)));
    if (p.startsWith(`/asset-library/${user.id}`)) return ok({ assets: [], usedBytes: 0, quotaBytes: 1e9, maxFileBytes: 5e7, planTier: 'free' });
    if (p.startsWith('/triggers')) return ok([]);
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(`${width}: ${e.message}`));
  page.on('console', msg => { if (msg.type() === 'error' && /TypeError|NG0/.test(msg.text())) errors.push(`${width}: ${msg.text()}`); });
  await page.goto(`${base}/${user.login}/modules/overlays`);
  await page.locator('app-overlay-editor .stage').waitFor();
  await until(async () => (await page.locator('.design-row').count()) === 2, 'studio loaded with two alert designs');
  await settle(page, 300);
  return { context, page, ctx };
}

const until = async (fn, label, ms = 6000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 60)); }
  assert.fail(`timed out: ${label}`);
};
/** Lets a resize or a click settle (zoneless: wait for frames, never assert right after an action). */
const settle = async (page, ms = 200) => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.waitForTimeout(ms); };
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
// Absent elements return null at once (no waiting for the locator timeout).
const rect = async (page, sel) => !(await page.locator(sel).count()) ? null : page.locator(sel).first().evaluate(e => { if (!e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }).catch(() => null);
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe ${label}`);
}
async function noOverflow(page, label) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  assert.ok(w.doc <= w.win + 1, `${label}: horizontal overflow ${w.doc} > ${w.win}`);
}
const isPhone = page => visible(page, '.studio-mtabs');
async function openDesign(page) {
  if (await isPhone(page)) await openStudio(page, 'designs');
  await page.locator('.design-row__actions button').first().click();
  await page.locator('.design-event-tabs').waitFor();
  await settle(page, 300);
}
const timelineOutput = page => page.locator('app-overlay-timeline output').innerText();
const timelineTime = async page => parseFloat((await timelineOutput(page)).trim());
const playButton = page => page.locator('app-overlay-timeline .transport button.primary');

/** The canvas hint stays clear of the toolbar, event tabs, canvas size label and off-canvas pill. */
async function hintClear(page, label) {
  const hint = await rect(page, '.studio__hint');
  assert.ok(hint && hint.width > 0, `${label}: canvas hint rendered`);
  for (const sel of ['.studio-toolbar', '.design-event-tabs', '.studio__size', '.off-canvas']) {
    const other = await rect(page, sel);
    assert.ok(!overlaps(hint, other), `${label}: .studio__hint ${JSON.stringify(hint)} overlaps ${sel} ${JSON.stringify(other)}`);
  }
}
async function hintText(page) { return (await page.locator('.studio__hint').innerText()).trim(); }

/** Phone save bar: one row, status kept for screen readers. */
async function phoneSaveBar(page, label) {
  const info = await page.evaluate(() => {
    const bar = document.querySelector('.lf-save-bar'), status = bar.querySelector('.lf-save-bar__status');
    const buttons = [...bar.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect().top);
    const cs = getComputedStyle(status);
    return { height: bar.getBoundingClientRect().height, buttons, live: status.getAttribute('aria-live'), text: status.textContent.trim(), display: cs.display, visibility: cs.visibility };
  });
  assert.equal(info.buttons.length, 2, `${label}: two save bar buttons (${JSON.stringify(info)})`);
  assert.ok(Math.abs(info.buttons[0] - info.buttons[1]) <= 2, `${label}: save bar buttons on one row (tops ${info.buttons})`);
  assert.ok(info.height <= 76, `${label}: save bar height ${info.height} <= 76`);
  assert.ok(info.live, `${label}: save status keeps aria-live`);
  assert.ok(info.text.length > 0, `${label}: save status has text`);
  assert.ok(info.display !== 'none' && info.visibility !== 'hidden', `${label}: save status not hidden from screen readers (${info.display}/${info.visibility})`);
}
/** Each phone tab: after scrolling to the bottom, the active pane's last visible control ends above the save bar. */
async function phoneReach(page, label) {
  for (const tab of ['layers', 'add', 'edit', 'test', 'more']) {
    await page.locator(`.studio-mtabs [data-tab="${tab}"]`).click();
    await until(() => page.locator(`.studio-mtabs [data-tab="${tab}"]`).getAttribute('aria-pressed').then(v => v === 'true'), `${label}: ${tab} tab active`);
    await settle(page, 150);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(page, 200);
    const info = await page.evaluate(() => {
      const bar = document.querySelector('.lf-save-bar').getBoundingClientRect();
      const ctrls = [...document.querySelectorAll('app-overlay-editor .studio-pane.m-on :is(button, input, select, textarea, summary, a)')]// checkVisibility skips controls inside a closed <details> (they keep client rects in Chromium).
        .filter(e => e.getClientRects().length && e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }));
      const last = ctrls.at(-1), r = last?.getBoundingClientRect();
      return { barTop: Math.round(bar.top), last: last ? (last.textContent || last.getAttribute('aria-label') || last.tagName).trim().slice(0, 40) : null, lastBottom: r ? Math.round(r.bottom) : null, ok: r ? r.bottom <= bar.top + 0.5 : true };
    });
    assert.ok(info.last, `${label}: ${tab} tab has controls`);
    assert.ok(info.ok, `${label}: ${tab} tab's last control "${info.last}" ends at ${info.lastBottom}, under the save bar top ${info.barTop}`);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.locator('.studio-mtabs [data-tab="layers"]').click(); await settle(page, 100);
}

try {
  // A. Desktop 1280 and 1920, dark: alert design + Test, hint, overflow; 1280 adds the overlay tab, layer note,
  //    singular usage, desktop save status, Bits looks, playback (a) and axe.
  for (const [width, height] of [[1280, 800], [1920, 1000]]) {
    const L = `${width}`;
    const { context, page } = await open({ width, height });

    // Overlay mode.
    assert.equal(await hintText(page), HINT_EN, `${L} overlay: desktop canvas hint`);
    await hintClear(page, `${L} overlay`);
    await noOverflow(page, `${L} overlay`);
    if (width === 1280) {
      const status = await rect(page, '.lf-save-bar__status');
      assert.ok(status && status.width > 40, `${L}: desktop save status visible next to the buttons (box ${JSON.stringify(status)})`);
      assert.ok((await page.locator('.lf-save-bar__status').innerText()).trim().length > 0, `${L}: desktop save status text`);

      // 6. Singular usage in the Alert designs list.
      const row = page.locator('.design-row').filter({ hasText: 'Aurora alerts' }).locator('.design-row__body .lf-note');
      assert.equal((await row.innerText()).trim(), 'Used in 1 overlay', `${L}: designs list row says "Used in 1 overlay"`);

      // 7. Alert layer note.
      await page.locator('.layer').filter({ hasText: /Alert/ }).first().click();
      await until(() => page.locator('.selected-card[data-kind="alert"]').isVisible(), 'alert layer selected');
      const note = page.locator('.studio-pane.properties .pill-group .lf-note');
      await until(() => note.isVisible(), `${L}: alert layer note visible`);
      const noteText = (await note.innerText()).trim();
      assert.ok(noteText.startsWith('These choices apply to this layer only.'), `${L}: alert layer note reads "${noteText}"`);

      // 5. Overlay tab: Live overlay controls lead; recovery note inside the options.
      await openStudio(page, 'overlay');
      const queue = page.locator('app-overlay-queue');
      await queue.locator('h2').waitFor();
      await settle(page);
      const first = await queue.evaluate(host => {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          if ([...range.getClientRects()].some(r => r.width > 0 && r.height > 0) && getComputedStyle(n.parentElement).visibility !== 'hidden') return { text: n.textContent.trim(), tag: n.parentElement.tagName };
        }
        return null;
      });
      assert.deepEqual(first, { text: 'Live overlay controls', tag: 'H2' }, `${L}: first visible text in app-overlay-queue`);
      const recovery = queue.locator('.hint').filter({ hasText: /^Recovery keeps/ });
      assert.equal(await recovery.count(), 1, `${L}: one recovery note in app-overlay-queue`);
      assert.equal(await recovery.isVisible(), false, `${L}: recovery note hidden until the options open`);
      await queue.locator('details.options > summary').filter({ hasText: 'Platform & chat command' }).click();
      await until(() => recovery.isVisible(), `${L}: recovery note visible once "Platform & chat command" opens`);
      await openStudio(page, 'layer');
    }

    // 1. Alert design + Test.
    await openDesign(page);
    if (width === 1280) {
      const chip = page.locator('.studio-top__chips .lf-chip').filter({ hasText: /^Used in/ });
      assert.equal((await chip.innerText()).trim(), 'Used in 1 overlay', `${L}: design header chip says "Used in 1 overlay"`);
    }
    assert.equal(await hintText(page), HINT_EN, `${L} design: desktop canvas hint`);
    await hintClear(page, `${L} design`);
    await noOverflow(page, `${L} design`);
    await until(() => visible(page, '.studio__timeline'), `${L}: timeline visible in a design`);
    await page.locator('.tb--test').click();
    await until(() => visible(page, '.tester'), `${L}: Test drawer opens`);
    await settle(page, 300);
    assert.equal(await visible(page, '.studio__timeline'), false, `${L}: timeline hidden while Test is open`);
    const stage = await page.locator('app-overlay-editor .stage').boundingBox();
    assert.ok(stage && stage.height >= 120, `${L}: stage height with Test open ${stage?.height} >= 120`);
    const pct = parseInt(await page.locator('.tb--pct').innerText(), 10);
    assert.ok(pct >= 30, `${L}: zoom with Test open ${pct}% >= 30%`);
    const tb = await rect(page, '.studio-toolbar'), tabs = await rect(page, '.design-event-tabs');
    assert.ok(!overlaps(tb, tabs), `${L}: toolbar ${JSON.stringify(tb)} overlaps event tabs ${JSON.stringify(tabs)}`);
    await hintClear(page, `${L} design Test open`);
    if (width === 1280) await axe(page, `${L} design Test open dark`);
    await page.locator('.tester__close').click();
    await until(() => visible(page, '.studio__timeline'), `${L}: closing Test brings the timeline back`);
    assert.equal(await visible(page, '.tester'), false, `${L}: Test closed`);

    if (width === 1280) {
      // 2a. Opening Test stops timeline playback.
      await playButton(page).filter({ hasText: 'Play timeline' }).click();
      await until(async () => (await timelineTime(page)) > 0, `${L}: timeline plays (output > 0)`);
      await page.locator('.tb--test').click();
      await until(() => visible(page, '.tester'), `${L}: Test opens over playing timeline`);
      await settle(page, 300);
      await page.locator('.tb--test').click();
      await until(() => visible(page, '.studio__timeline'), `${L}: timeline back after Test`);
      await settle(page, 150);
      const out = (await timelineOutput(page)).trim();
      assert.ok(out.startsWith('0.00'), `${L}: timeline stopped when Test opened (output "${out}")`);
      assert.equal((await playButton(page).innerText()).trim(), 'Play timeline', `${L}: timeline play button after Test`);

      // 8. Bits looks in the desktop sidebar.
      await page.locator('.design-event-tabs button').nth(1).click(); // follow, bits, sub, raid
      const looks = page.locator('app-overlay-bits-looks');
      await looks.locator('.bl__list').waitFor();
      await until(() => looks.locator('.br-amount').count().then(n => n === rulesFixture.length), `${L}: all ${rulesFixture.length} rules listed`);
      await settle(page, 200);
      const sideways = await looks.evaluate(host => [host, ...host.querySelectorAll('*')].filter(el => {
        if (getComputedStyle(el).textOverflow === 'ellipsis' || el.classList.contains('br-switch')) return false;
        return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1;
      }).map(el => `${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`));
      assert.deepEqual(sideways, [], `${L}: nothing inside the Bits looks scrolls sideways`);
      const buttonHits = await looks.evaluate(host => {
        const boxes = [...host.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => ({ b, r: b.getBoundingClientRect() }));
        const hits = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, c = boxes[j].r;
          if (boxes[i].b.contains(boxes[j].b) || boxes[j].b.contains(boxes[i].b)) continue;
          if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) hits.push(`${boxes[i].b.textContent.trim().slice(0, 30)} × ${boxes[j].b.textContent.trim().slice(0, 30)}`);
        }
        return hits;
      });
      assert.deepEqual(buttonHits, [], `${L}: no two buttons in the Bits looks overlap`);
      const amounts = await looks.evaluate(host => {
        const box = host.getBoundingClientRect();
        return [...host.querySelectorAll('.br-amount')].map(el => {
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          const clipped = el.scrollWidth > el.clientWidth + 1 || r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.width === 0;
          let p = el.parentElement, cut = false;
          while (p && p !== host.parentElement) { const pr = p.getBoundingClientRect(), pcs = getComputedStyle(p); if (pcs.overflowX !== 'visible' && (r.left < pr.left - 0.5 || r.right > pr.right + 0.5)) cut = true; p = p.parentElement; }
          return { text: el.textContent.trim(), ok: !clipped && !cut && cs.visibility !== 'hidden' };
        });
      });
      assert.ok(amounts.length === rulesFixture.length && amounts.every(a => a.ok), `${L}: every rule amount visible without sideways scroll ${JSON.stringify(amounts)}`);
      const longRow = looks.locator('.bl__item').filter({ hasText: LONG_NAME });
      assert.equal(await longRow.count(), 1, `${L}: long-named rule listed`);
      await looks.getByRole('button', { name: 'Give Hype its own look' }).click();
      const hypeTab = looks.locator('.bl__tab').filter({ hasText: 'Hype' });
      await until(() => hypeTab.getAttribute('aria-pressed').then(v => v === 'true'), `${L}: Hype row pressed after "Give it its own look"`);
      await until(() => looks.getByRole('button', { name: 'Use the default look' }).isVisible(), `${L}: "Use the default look" shown`);
    }
    await context.close();
  }

  // B. Hint and overflow sweep across desktop widths (overlay mode, then a design).
  {
    const { context, page } = await open({ width: 1280, height: 800 });
    const sweep = [[960, 800], [1100, 800], [1280, 800], [1440, 900], [1920, 1000]];
    for (const mode of ['overlay', 'design']) {
      if (mode === 'design') { await page.setViewportSize({ width: 1280, height: 800 }); await settle(page); await openDesign(page); }
      for (const [width, height] of sweep) {
        await page.setViewportSize({ width, height }); await settle(page, 300);
        assert.equal(await hintText(page), HINT_EN, `${width} ${mode}: desktop canvas hint`);
        await hintClear(page, `${width} ${mode}`);
        await noOverflow(page, `${width} ${mode}`);
      }
    }
    await context.close();
  }

  // C. 2b: playback started in the phone layout stops when resizing back to desktop with Test open.
  {
    const { context, page } = await open({ width: 1280, height: 800 });
    await openDesign(page);
    await page.locator('.tb--test').click();
    await until(() => visible(page, '.tester'), '2b: Test open on desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await until(() => visible(page, '.studio-mtabs'), '2b: phone layout after resize');
    await page.locator('.studio-mtabs [data-tab="edit"]').click();
    await until(() => playButton(page).isVisible(), '2b: timeline on the Edit tab');
    await playButton(page).click();
    await until(async () => (await timelineTime(page)) > 0, '2b: timeline plays on the phone layout');
    await page.setViewportSize({ width: 1280, height: 800 });
    await until(async () => !(await visible(page, '.studio-mtabs')) && (await visible(page, '.tester')), '2b: desktop layout with Test shown');
    await settle(page, 200);
    assert.equal(await visible(page, '.studio__timeline'), false, '2b: timeline hidden with Test open after resize');
    await page.locator('.tb--test').click();
    await until(() => visible(page, '.studio__timeline'), '2b: timeline back after closing Test');
    await settle(page, 150);
    const out = (await timelineOutput(page)).trim();
    assert.ok(out.startsWith('0.00'), `2b: playback stopped while hidden after resize (output "${out}")`);
    assert.equal((await playButton(page).innerText()).trim(), 'Play timeline', '2b: play button after resize + Test');
    await context.close();
  }

  // D. Used twice (two overlays carry the design).
  {
    const { context, page } = await open({ width: 1280, height: 800, usedTwice: true });
    const row = page.locator('.design-row').filter({ hasText: 'Aurora alerts' }).locator('.design-row__body .lf-note');
    assert.equal((await row.innerText()).trim(), 'Used in 2 overlays', 'designs list row says "Used in 2 overlays"');
    await openDesign(page);
    const chip = page.locator('.studio-top__chips .lf-chip').filter({ hasText: /^Used in/ });
    assert.equal((await chip.innerText()).trim(), 'Used in 2 overlays', 'design header chip says "Used in 2 overlays"');
    // Spanish desktop hint.
    await studioToggle(page, 'lang');
    await until(async () => (await hintText(page)) === HINT_ES, `Spanish desktop hint "${HINT_ES}"`);
    await context.close();
  }

  // E. Light theme: axe on a design with Test open.
  {
    const { context, page } = await open({ width: 1280, height: 800, theme: 'light' });
    await openDesign(page);
    await openStudio(page, 'test'); await settle(page, 300);
    await axe(page, '1280 design Test open light');
    await context.close();
  }

  // F. Phones (touch): hint, save bar, reach per tab, overflow; axe at 390; Spanish touch hint.
  for (const [width, height] of [[390, 844], [320, 640]]) {
    const L = `phone ${width}`;
    const { context, page } = await open({ width, height, touch: true });
    await until(() => isPhone(page), `${L}: phone layout`);
    await settle(page, 300);
    assert.equal(await hintText(page), HINT_TOUCH_EN, `${L}: touch canvas hint`);
    if (width === 390) {
      const lines = await page.locator('.studio__hint').evaluate(el => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4; return { height: el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), lh }; });
      assert.ok(lines.height < 1.9 * lines.lh, `${L}: touch hint on one line (height ${lines.height}, line-height ${lines.lh})`);
      await axe(page, `${L} overlay dark`);
    }
    await noOverflow(page, `${L} overlay`);
    await phoneSaveBar(page, `${L} overlay`);
    await phoneReach(page, `${L} overlay`);
    await openDesign(page);
    await noOverflow(page, `${L} design`);
    await phoneSaveBar(page, `${L} design`);
    await phoneReach(page, `${L} design`);
    if (width === 390) {
      await studioToggle(page, 'lang');
      await until(async () => (await hintText(page)) === HINT_TOUCH_ES, `${L}: Spanish touch hint "${HINT_TOUCH_ES}"`);
    }
    await context.close();
  }

  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS Overlay Studio UX touches: Test replaces the timeline (1280/1920, stage + zoom kept, toolbar clear), playback stops when hidden (Test, resize), canvas hint text/placement 960–1920 + touch + Spanish, phone save bar one row + reach (390/320), Overlay tab order, singular usage, alert layer note, Bits looks fit the sidebar, no overflow, axe dark/light/phone (${Math.round((Date.now() - started) / 1000)} s)`);
} finally {
  await browser.close();
}
