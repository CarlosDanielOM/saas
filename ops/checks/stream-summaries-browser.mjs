import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991301', login: 'recap_owner', display_name: 'Recap_Owner' };
const app = { name: 'Recap_Owner', email: 'recap@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const day = 86_400_000, now = Date.now();
const summary = (n, extra) => ({ _id: 's' + n, channelID: user.id, channel: user.login, stream_session_id: 'x' + n, stream_id: 'y' + n,
  started_at: new Date(now - n * day - 3 * 3600_000).toISOString(), ended_at: new Date(now - n * day).toISOString(), duration_minutes: 185,
  average_viewers: 1280, peak_viewers: 2450, follows: 15, subs: 8, bits: 1500, donations: 50, headline: 'Beat the final boss on stream', recap: 'A long boss run with a hype chat.',
  highlights: ['Final boss down on the third try', 'Chat ran a prediction'], chat_messages_sampled: 420, snapshot_count: 36, proposed_actions: [], applied_actions: [],
  totals: { proposed: 0, applied: 0, skipped: 0, failed: 0 }, status: 'noop', error_message: '', source: 'stream_offline', created_at: '', updated_at: '', ...extra });
const items = [
  summary(1, { status: 'applied', totals: { proposed: 2, applied: 1, skipped: 1, failed: 0 },
    proposed_actions: [
      { action: 'create', type: 'fact', summary: 'Their speedrun personal best is 28:45', reason: 'Set a new PB during the stream.', evidence: ['PB at 28:45!!', 'GG new record'], confidence: 0.95, risk: 'low' },
      { action: 'edit', summary: 'Prefers the Rex voice for alerts', reason: 'Mentioned it once.', confidence: 0.4, risk: 'low' }],
    applied_actions: [{ action: 'create', status: 'applied', reason: 'created_memory' }, { action: 'edit', status: 'skipped', reason: 'edit_confidence_below_threshold' }] }),
  summary(2, { duration_minutes: 12, chat_messages_sampled: 9, headline: 'Stream summary for recap_owner', recap: 'Stream did not meet summary thresholds, so no memory actions were applied.', highlights: ['Duration: 12 minutes', 'Sampled chat messages: 9'] }),
  summary(3, { source: 'weekly_maintenance', headline: 'Weekly memory maintenance', recap: 'Reviewed memories; nothing to change.', highlights: [] }),
  summary(4, { status: 'failed', headline: '', recap: '', highlights: [], error_message: 'OpenRouter timeout' })
];
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open(mode, theme, width) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/recap_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: true } });
    let data = {};
    if (url.pathname === `/stream-summaries/${user.id}`) {
      if (mode === 'error') return route.fulfill({ status: 500, json: { error: true, message: 'Internal server error' } });
      data = mode === 'empty' ? { items: [], total: 0 } : { items, total: items.length };
    } else if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'premium' };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/recap_owner/modules/stream-summaries');
  return { context, page };
}
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-stream-summaries-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  // No summaries and failed loads must never show invented streams.
  for (const mode of ['empty', 'error']) {
    const { context, page } = await open(mode, 'dark', 390);
    await page.getByText(mode === 'empty' ? 'No summaries yet' : "We couldn't load your summaries", { exact: false }).waitFor();
    assert.equal(await page.getByText('Minecraft').count(), 0, `${mode}: no demo data`);
    assert.equal(await page.locator('.lf-session').count(), 0, `${mode}: no fake rows`);
    await axe(page, `${mode} axe`);
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/summaries-${mode}.png`, fullPage: true }); }
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open('data', theme, width);
    await page.locator('.lf-session').first().waitFor();
    const rows = await page.locator('.lf-session').allInnerTexts();
    assert.match(rows[0], /3h 5m[\s\S]*Beat the final boss[\s\S]*1 memory saved/, 'row: length, headline, plain outcome');
    assert.match(rows[1], /Stream too short to summarize[\s\S]*Too short/);
    assert.match(rows[2], /Weekly memory cleanup[\s\S]*No changes needed/);
    assert.match(rows[3], /Couldn't finish/);
    assert.equal(await page.getByText(/applied|noop/).count(), 0, 'no internal status words');
    if (width < 960) {
      assert.equal(await page.locator('.lf-detail').count() === 0 || !(await page.locator('.lf-detail').isVisible()), true, 'phones start on the list');
      await page.locator('.lf-session').first().click();
      await page.getByRole('button', { name: /Back/ }).waitFor();
    }
    const detail = page.locator('.lf-detail');
    assert.match(await detail.locator('.lf-facts').innerText(), /3h 5m[\s\S]*1,280[\s\S]*2,450[\s\S]*\+15[\s\S]*\+8[\s\S]*1,500[\s\S]*\$50\.00/);
    const learned = await detail.locator('.lf-learned').innerText();
    assert.match(learned, /New memory[\s\S]*Saved[\s\S]*speedrun personal best/);
    assert.match(learned, /Updated memory[\s\S]*Not saved: the bot was not sure enough/);
    assert.equal(/confidence|risk|0\.95|create_/.test(learned), false, 'no internal jargon in learned list');
    await detail.getByText('From chat (2)').click();
    await detail.getByText('PB at 28:45!!').waitFor();
    if (theme === 'dark' && width === 1280) {
      await page.locator('.lf-session').nth(1).click();
      await detail.getByText(/ran 12 min with 9 chat messages/).waitFor();
      assert.equal(await detail.getByText('Duration: 12 minutes').count(), 0, 'placeholder highlights hidden for short streams');
      await page.locator('.lf-session').nth(3).click();
      await detail.getByText(/Something went wrong while writing this recap/).waitFor();
      await page.locator('.lf-session').first().click();
    }
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await axe(page, `axe ${theme} ${width}`);
    if (shots && width !== 320) await page.screenshot({ path: `${shots}/summaries-${theme}-${width}.png`, fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS Stream summaries: no demo data on empty/error, plain outcomes (saved/too short/cleanup/failed), stream facts, what-the-bot-learned with save results and chat evidence, mobile list→detail, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
