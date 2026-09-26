/** Run with SAAS_PREVIEW_URL and an installed Playwright module in PLAYWRIGHT_MODULE. */
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  // This local mock needs no external services; never call production APIs.
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/mocks/dev/roulette-astra?design=reel`);
  await page.locator('.reel-cell').first().waitFor();
  await page.locator('.bulk-import summary').click();
  await page.locator('.replace-check input').check();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paste = async text => {
    await page.locator('#roulette-bulk').fill(text);
    await page.locator('.import-button').click();
    await settle();
  };
  const keys = () => page.locator('.reel-cell').evaluateAll(cells => cells.map(cell => cell.dataset.slotKey));
  const ticket = value => page.evaluate(value => { crypto.getRandomValues = array => { array.fill(0); array[1] = value; return array; }; }, value);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await paste('A\t10\t3\nB\t1\t1');
    assert.deepEqual((await page.locator('.reel-cell strong').allTextContents()).slice(0, 4), ['A', 'A', 'A', 'B']);
    const before = (await keys()).slice(0, 4);
    assert.equal(new Set(before).size, 4, 'each multiplier copy has its own identity');
    assert.match(await page.locator('.reel-cell').first().textContent(), /32[.,]26%/);
    const summary = await page.locator('.draw-summary').textContent();
    await ticket(0);
    await page.locator('.shuffle-button').click();
    await settle();
    const after = (await keys()).slice(0, 4);
    assert.notDeepEqual(after, before);
    assert.deepEqual([...after].sort(), [...before].sort());
    assert.equal(await page.locator('.draw-summary').textContent(), summary);
    // Force every ticket boundary, including the second and third copies.
    for (const value of [0, 10, 20, 21]) {
      await ticket(value);
      const expected = after[value < 10 ? 0 : value < 20 ? 1 : value === 20 ? 2 : 3];
      await page.locator('.reel-start:visible, .spin-cta:visible').first().click();
      await page.locator('.reel.is-revealed').waitFor();
      await settle();
      const centered = await page.locator('.reel').evaluate(reel => {
        const bounds = reel.getBoundingClientRect();
        const center = bounds.x + bounds.width / 2;
        const cell = [...reel.querySelectorAll('.reel-cell')].find(cell => {
          const rect = cell.getBoundingClientRect();
          return Math.abs(rect.x + rect.width / 2 - center) < 2;
        });
        return cell && { key: cell.dataset.slotKey, winner: cell.classList.contains('is-winner') };
      });
      assert.deepEqual(centered, { key: expected, winner: true });
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'viewport overflow');
    await paste('Solo\t1\t60');
    assert.equal(new Set(await keys()).size, 60);
    await paste('Solo\t1\t61');
    await page.locator('.reel-capacity-block').waitFor();
    assert.equal(await page.locator('.reel-cell').count(), 0);
    await paste('Solo\t100\t3');
    assert.equal(new Set(await keys()).size, 3, 'weight must not create extra cards');
    assert.equal(await page.locator('.shuffle-button').isDisabled(), false);
  }
  assert.deepEqual(errors, []);
  console.log('Reel copies, shuffle, exact winner landing, repeated spins, weight independence, capacity and mobile/desktop layout passed.');
} finally {
  await browser.close();
}
