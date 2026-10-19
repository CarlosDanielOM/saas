// Stream timeline UX: recap answer, likely causes, per-game split, phone density and
// owner-only upgrade offers, using a realistic 3-hour stream fixture. All APIs mocked.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const { mockApi } = await import(process.env.SAAS_TIMELINE_FIXTURE || '/root/saas/ops/checks/timeline-fixtures/site-fixture.mjs');
const url = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4287';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const open = async (plan, width = 390) => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: 'dark' }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const state = await mockApi(page, url, { plan });
  const until = async (fn, msg) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await page.waitForTimeout(100); } throw new Error('timeout: ' + msg); };
  const section = page.locator('app-stream-timeline-page');
  const go = async () => { await page.goto(`${url}/fixture/modules/analytics/timeline`); await section.getByRole('heading', { name: 'Audience & chat', exact: true }).waitFor(); };
  return { page, errors, state, until, section, go, readout: () => section.locator('.readout__time').innerText() };
};
const scrolls = loc => loc.evaluate(el => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight + 4);
let current;
try {
  // ── Pro owner on a phone ──
  current = await open('pro');
  const { page, errors, until, section, go, readout } = current;
  await go();
  assert.equal(await section.locator('#recap-heading').innerText(), 'You peaked at 77 viewers and averaged 58.');
  // The cursor starts at the peak, so the first thing on the chart is the best moment.
  assert.equal(await readout(), '1:00:00');
  const swings = section.locator('.swing');
  assert.equal(await swings.count(), 2);
  assert.match(await swings.nth(0).innerText(), /\+47 viewers between 0:40:00 and 0:55:00[\s\S]*Around then: FriendlyRaider raided with 46 viewers\./);
  assert.match(await swings.nth(1).innerText(), /−22 viewers between 1:25:00 and 1:40:00[\s\S]*Around then: your marker “Break”\./);
  const games = await section.locator('.games li').allInnerTexts();
  assert.deepEqual(games.map(g => g.replace(/\s+/g, ' ').trim()), ['Elden Ring 1h 30m avg 65 viewers', 'Just Chatting 1h 00m avg 38 viewers', 'Chess 30m avg 71 viewers']);
  assert.equal((await section.locator('.totals').innerText()).replace(/\s+/g, ' ').trim(), 'New follows 9 Subs 1 Bits 500 Raids 1 Rewards redeemed 2');
  assert.equal(await section.locator('.band__seg').count(), 3);
  // Tapping a cause jumps to it and brings the chart into view on phones.
  await page.evaluate(() => scrollTo(0, 0));
  await swings.nth(0).click();
  await until(async () => await readout() === '0:49:10', 'swing jumps to the raid');
  await until(async () => { const top = await section.locator('.chart-card').evaluate(el => el.getBoundingClientRect().top); const nav = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('nav, header')].filter(e => getComputedStyle(e).position === 'sticky' || getComputedStyle(e).position === 'fixed').map(e => e.getBoundingClientRect().bottom))); return top >= nav && top < nav + 40; }, 'chart revealed below the navbar');
  await section.locator('.readout__events').getByText('FriendlyRaider', { exact: true }).waitFor();
  // Phones list 6 moments before "Show all".
  assert.equal(await section.locator('.events li').count(), 6);
  await section.getByRole('button', { name: 'Show all 20 moments', exact: true }).click();
  await until(async () => await section.locator('.events li').count() === 20, 'all moments');
  // Expanded lists scroll inside their own box instead of stretching the page.
  assert.ok(await scrolls(section.locator('.events')), 'moments scroll box');
  assert.ok(await section.locator('.events').evaluate(el => el.getBoundingClientRect().height) <= 28 * 16 + 4, 'moments box capped');
  const lastMoment = section.getByRole('button', { name: /Chess.*2:30:00/ });
  await lastMoment.click(); await until(async () => await readout() === '2:30:00', 'moment from expanded list');
  // Each moment shows the audience at that time.
  assert.match(await lastMoment.innerText(), /\d+ viewers/);
  // Rankings start at the top 5.
  const commands = section.locator('.rankings > div').first();
  assert.equal(await commands.locator('.rank-list > li').count(), 5);
  await commands.getByRole('button', { name: 'Show all 6', exact: true }).click();
  await until(async () => await commands.locator('.rank-list > li').count() === 6, 'all commands');
  assert.equal(await commands.locator('.rank-list').evaluate(el => [el.classList.contains('scroll-box'), getComputedStyle(el).overflowY, el.tabIndex].join()), 'true,auto,0');
  await commands.getByRole('button', { name: 'Show top 5', exact: true }).click();
  // Zoom keeps the cursor in view and only offers sizes shorter than the stream.
  await section.getByRole('button', { name: '1 hour', exact: true }).click();
  await until(() => new URL(page.url()).searchParams.get('from') === '7200', 'zoom 1h centred and clamped');
  await until(async () => await section.getByRole('button', { name: '1 hour', exact: true }).getAttribute('aria-pressed') === 'true', '1 hour pressed');
  await section.getByRole('button', { name: 'Full stream', exact: true }).click();
  // Credits: 40 receipts stay in a capped scroll box.
  const before = await page.evaluate(() => document.documentElement.scrollHeight);
  await section.getByText('Show credit activity', { exact: true }).click();
  const credits = section.locator('.credit-list');
  await until(async () => await credits.locator('li').count() === 40, 'credits loaded');
  assert.ok(await scrolls(credits), 'credits scroll box');
  const boxHeight = await credits.evaluate(el => el.getBoundingClientRect().height), grew = await page.evaluate(() => document.documentElement.scrollHeight) - before;
  assert.ok(boxHeight <= 20 * 16 + 4, `credits box ${boxHeight}px`);
  assert.ok(grew < 700, `credits grew page by ${grew}px`); // 40 rows unboxed would be ~2000px
  await credits.focus(); await page.keyboard.press('End');
  await until(async () => await credits.evaluate(el => el.scrollTop > 0), 'credits keyboard scroll');
  // Pro has no upgrade offers.
  assert.equal(await section.locator('.upsell, .metric--locked').count(), 0);
  // Phone touch targets for primary controls.
  for (const sel of ['.stream-chip', '.kind-chips button', '.event-button', '.readout__head .icon-btn', '.swing']) {
    const h = await section.locator(sel).first().evaluate(el => el.getBoundingClientRect().height);
    assert.ok(h >= 40, `${sel} height ${h}`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone overflow');
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document.querySelector('app-stream-timeline-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => v.id)), [], 'axe with expanded lists');
  assert.deepEqual(errors, []);
  await page.close();

  // ── Free owner: locked trends open the upgrade prompt, one upsell block ──
  current = await open('free', 1280);
  await current.go();
  assert.equal(await current.section.locator('.metric--locked').count(), 2);
  assert.equal(await current.section.locator('.upsell').count(), 1);
  await current.section.getByRole('button', { name: /^Commands \/ min/ }).click();
  await current.page.getByText(/Premium/).filter({ hasNot: current.section }).first().waitFor();
  assert.equal(await current.section.locator('.plot-row').getAttribute('class'), 'plot-row series-viewers');
  assert.deepEqual(current.errors, []);
  await current.page.close();

  // ── Live stream: the answer talks about now ──
  current = await open('pro', 1280);
  current.state.data.session.status = 'live'; current.state.data.session.endedAt = null;
  await current.go();
  assert.match(await current.section.locator('#recap-heading').innerText(), /^You're live with \d+ viewers\. Peak so far: 77\.$/);
  await current.section.locator('.chip--live .pulse').waitFor();
  assert.deepEqual(current.errors, []);
  console.log('PASS TIMELINE UX: recap answer, rise/drop causes, per-game split, totals, game band, cause tap reveals chart, phone moment cap + show all, viewers per moment, ranking top 5 toggle, scroll boxes for expanded moments/rankings/credits (keyboard + axe), clamped zoom, owner-only upsell + upgrade prompt, live answer, touch targets, phone overflow');
} catch (error) {
  if (current) { console.error('PAGE', current.page.url(), current.errors); console.error((await current.page.locator('body').innerText().catch(() => '')).slice(-5000)); }
  throw error;
} finally { await browser.close(); }
