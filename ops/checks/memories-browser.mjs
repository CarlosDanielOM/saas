import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991401', login: 'memory_owner', display_name: 'Memory_Owner' };
const app = { name: 'Memory_Owner', email: 'mem@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const mem = (id, status, type, summary, extra = {}) => ({ _id: id, channelID: user.id, channel: user.login, type, status, risk: 'low', confidence: 0.91,
  subject: { scope: 'channel', username: '', userID: '' }, content: summary + ' (details)', summary, fingerprint: id, sourceEvidence: [], createdBy: { source: 'system', username: '', userID: '' },
  reviewReason: '', useCount: 0, createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z', ...extra });
const seed = () => [
  mem('m1', 'pending_review', 'running_joke', 'Chat calls every boss "Kevin"'),
  mem('m2', 'candidate', 'known_user_fact', 'luna_v is learning Spanish', { subject: { scope: 'user', username: 'luna_v', userID: '5' }, risk: 'medium' }),
  mem('m3', 'confirmed', 'preference', 'Streamer prefers dark mode everywhere', { useCount: 5 }),
  mem('m4', 'confirmed', 'boundary', 'Never mention the streamer\'s hometown', { risk: 'high', useCount: 1 }),
  mem('m5', 'archived', 'channel_lore', 'Friday streams start with a coffee toast')
];
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open({ theme = 'dark', width = 1280, manage = true } = {}) {
  let store = seed(); const writes = [];
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/memory_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    if (url.pathname.startsWith('/auth/access/')) {
      const allowed = url.searchParams.get('permission') === 'memories:manage' ? manage : true;
      return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed } } });
    }
    const one = url.pathname.match(new RegExp(`^/memories/${user.id}/(m\\d+)(/status)?$`));
    if (url.pathname === `/memories/${user.id}` && method === 'GET') {
      const pick = key => url.searchParams.get(key)?.split(',');
      const statuses = pick('status'), types = pick('type'), risks = pick('risk');
      const items = store.filter(m => (!statuses || statuses.includes(m.status)) && (!types || types.includes(m.type)) && (!risks || risks.includes(m.risk)));
      const limit = Number(url.searchParams.get('limit') || 50);
      return ok({ items: items.slice(0, limit), total: items.length });
    }
    if (one) {
      writes.push({ method, id: one[1], body: method === 'DELETE' ? null : request.postDataJSON() });
      if (method === 'DELETE') { store = store.filter(m => m._id !== one[1]); return ok({}); }
      const target = store.find(m => m._id === one[1]);
      Object.assign(target, one[2] ? { status: request.postDataJSON().status } : request.postDataJSON());
      return ok(target);
    }
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'pro' });
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/memory_owner/modules/memories');
  await page.locator('.lf-mem').first().waitFor();
  return { context, page, writes, store: () => store };
}
const settle = page => page.waitForTimeout(150);
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-memories-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  {
    const { context, page, writes, store } = await open();
    const head = page.locator('.lf-head');
    await head.getByText('2 need review').waitFor();
    assert.match(await head.innerText(), /2 active/);
    await page.getByText('2 memories are waiting for you').waitFor();
    assert.equal(await page.getByText(/91%|confidence|Low Risk/i).count(), 0, 'no confidence %/risk jargon');
    const row = text => page.locator('.lf-mem').filter({ hasText: text });
    assert.match(await row('luna_v').innerText(), /Viewer fact[\s\S]*Handle with care[\s\S]*Needs review[\s\S]*About @luna_v/);
    assert.match(await row('hometown').innerText(), /Boundary[\s\S]*Sensitive[\s\S]*Active[\s\S]*Used once/);
    // Review banner jumps to the review queue; approve and deny are one tap.
    await page.getByRole('button', { name: 'Review now' }).click();
    await settle(page);
    assert.equal(await page.locator('.lf-mem').count(), 2);
    await row('Kevin').getByRole('button', { name: 'Approve' }).click();
    await page.getByText('1 need review').waitFor();
    assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'm1', body: { status: 'confirmed' } });
    assert.equal(await row('Kevin').count(), 0, 'approved memory leaves the review queue');
    await row('luna_v').getByRole('button', { name: 'Deny' }).click();
    await page.getByText('No memories match these filters').waitFor();
    assert.equal(store().find(m => m._id === 'm2').status, 'rejected');
    assert.equal(await page.getByText(/waiting for you/).count(), 0, 'banner gone once queue is empty');
    // Denied memories can be made active again.
    await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Denied' }).click();
    await row('luna_v').getByRole('button', { name: 'Make active again' }).click();
    await page.getByText('No memories match these filters').waitFor();
    assert.equal(store().find(m => m._id === 'm2').status, 'confirmed');
    // Type chips filter server-side.
    await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'All' }).click();
    await page.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'Boundary' }).click();
    await settle(page); await page.waitForFunction(() => document.querySelectorAll('.lf-mem').length === 1);
    await page.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'All kinds' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lf-mem').length === 5);
    // Edit: empty text is caught inline; saving sends the new text and care level.
    await row('dark mode').getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit memory' });
    await dialog.getByRole('textbox', { name: 'What the bot remembers' }).fill('');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByText('Write what the bot should remember.').waitFor();
    assert.equal(writes.filter(w => w.method === 'PATCH' && !w.body.status).length, 0, 'invalid edit not sent');
    await dialog.getByRole('textbox', { name: 'What the bot remembers' }).fill('Streamer uses dark mode in every app');
    await dialog.getByRole('radio', { name: 'Handle with care' }).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(writes.at(-1).body.content, 'Streamer uses dark mode in every app');
    assert.equal(writes.at(-1).body.risk, 'medium');
    // Delete explains itself and offers archive; Escape cancels.
    await page.getByRole('button', { name: /^Delete memory: Streamer prefers dark mode/ }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete this memory?' });
    await confirm.getByText(/archive it instead/).waitFor();
    await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'detached' });
    assert.equal(writes.some(w => w.method === 'DELETE'), false);
    await page.getByRole('button', { name: /^Delete memory: Streamer prefers dark mode/ }).click();
    await confirm.getByRole('button', { name: 'Archive instead' }).click();
    await confirm.waitFor({ state: 'detached' }); await settle(page);
    assert.equal(store().find(m => m._id === 'm3').status, 'archived');
    await page.getByRole('button', { name: /^Delete memory: Friday streams/ }).click();
    await confirm.getByRole('button', { name: 'Delete for good' }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.lf-mem')].some(e => e.textContent.includes('Friday streams')));
    assert.equal(writes.at(-1).method, 'DELETE');
    await context.close();
  }
  {
    // Helpers with view-only access see no actions and are told why.
    const { context, page } = await open({ manage: false });
    await page.locator('.lf-head').getByText('View only').waitFor();
    assert.equal(await page.locator('.lf-mem__actions').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Review now' }).count(), 0);
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open({ theme, width });
    await page.locator('.lf-head').getByText('2 need review').waitFor();
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await axe(page, `axe ${theme} ${width}`);
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/memories-${theme}-${width}.png`, fullPage: true }); }
    if (width === 390 && theme === 'light') {
      await page.locator('.lf-mem').filter({ hasText: 'dark mode' }).getByRole('button', { name: 'Edit' }).click();
      await page.waitForTimeout(250);
      await axe(page, 'edit dialog axe');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (shots) await page.screenshot({ path: `${shots}/memories-edit-390.png` });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS AI memories: accurate review/active counts, review banner + queue, one-tap approve/deny, restore, server-side type filter, inline edit validation, care level, delete with archive-instead and Escape, view-only mode, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
