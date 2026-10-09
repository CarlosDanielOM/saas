// Run with SAAS_PREVIEW_URL; external Playwright/axe installations can be supplied
// through SAAS_PLAYWRIGHT_MODULE and SAAS_AXE_MODULE. No production APIs are called.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.SAAS_PLAYWRIGHT_MODULE || 'playwright');
const axeModule = await import(process.env.SAAS_AXE_MODULE || '@axe-core/playwright');
const AxeBuilder = axeModule.default.default || axeModule.default;
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL is required');
const evidence = process.env.SAAS_EVIDENCE_DIR || '/tmp/duel-overlay-evidence';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SAAS_CHROMIUM_PATH ? { executablePath: process.env.SAAS_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const errors = [];
  const apiRequests = [];
  // Fonts may load normally; all external API/analytics requests are blocked.
  await context.route(/https:\/\/.*domdimabot\.com\//, route => {
    if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue();
    // App-wide PostHog bootstrap also runs on existing mocks. Block its
    // telemetry without treating it as a duel backend dependency.
    if (new URL(route.request().url()).hostname !== 'tadd.domdimabot.com') apiRequests.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => { localStorage.setItem('theme', 'dark'); localStorage.setItem('userLanguage', 'en'); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const goto = async (path = '/mocks/dev/duel') => {
    await page.goto(base + path);
    await page.locator('.arena[data-phase="ready"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  await goto();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Light', exact: true }).click();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${evidence}/${theme}-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${theme} ${width}: horizontal overflow`);
      const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(accessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), [], `${theme} ${width}: accessibility`);
    }
  }
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByLabel('Challenger', { exact: true }).fill('VioletKnight');
  await page.getByLabel('Opponent', { exact: true }).fill('GoldenKnight');
  await page.evaluate(() => { Math.random = () => 0.05; });
  assert.equal(await page.locator('.winner-options input').count(), 1);
  await page.locator('.playback .primary').click();
  await page.locator('.arena[data-phase="entrance"]').waitFor();
  await page.locator('.arena[data-phase="countdown"]').waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const pausedTime = await page.locator('.time').innerText();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.time').innerText(), pausedTime, 'Paused timeline must stay frozen');
  assert.equal(await page.locator('app-duel-fighter').first().getAttribute('data-paused'), 'true');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.locator('.arena[data-phase="fight"]').waitFor();
  await page.locator('app-duel-fighter[data-action="attack"]').waitFor();
  await page.locator('.hit-spark').first().waitFor();
  // Math.random()=0.05 rolls Knight vs Ronin, left first, critical undefendable specials and an extra turn every time.
  assert.equal(await page.locator('app-duel-fighter[data-side="left"]').getAttribute('data-character'), 'knight');
  assert.equal(await page.locator('app-duel-fighter[data-side="right"]').getAttribute('data-character'), 'ronin');
  await page.locator('.move-callout', { hasText: 'Holy Smite' }).first().waitFor();
  await page.locator('.damage.crit', { hasText: /critical/i }).waitFor();
  await page.locator('.extra-turn', { hasText: 'Extra turn!' }).waitFor();
  await page.locator('.arena-footer', { hasText: /Turn \d+/ }).waitFor();
  await page.screenshot({ path: `${evidence}/fight.png`, fullPage: true });
  await page.locator('.arena[data-phase="knockout"]').waitFor({ timeout: 15000 });
  await page.locator('.winner-reveal').waitFor();
  assert.equal(await page.locator('.winner-reveal strong').innerText(), 'VioletKnight');
  assert.equal(await page.locator('.winner-reveal').getByText('wins the duel with 100 HP left').count(), 1);
  assert.equal(await page.locator('.health[data-side="right"] [role="progressbar"]').getAttribute('aria-valuenow'), '0');
  assert.equal(await page.locator('app-duel-fighter[data-side="right"]').getAttribute('data-action'), 'defeated');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${evidence}/victory.png`, fullPage: true });
  assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).isDisabled(), true);
  // mulberry32 seed 8 (70 rolls) lets the Knight's Shield Wall block a normal attack at 4.5s.
  // Only the battle's own rolls are seeded so other page code cannot shift the sequence.
  await page.evaluate(() => { let a = 8, n = 0; const original = Math.random; Math.random = () => { if (n++ >= 70) return original(); a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; });
  await page.locator('.playback .primary').click();
  await page.locator('.skill-callout', { hasText: 'Shield Wall' }).waitFor({ timeout: 15000 });
  await page.locator('app-duel-fighter[data-character="knight"][data-action="defend"]').waitFor();
  await page.locator('.damage.blocked', { hasText: 'Blocked!' }).waitFor();
  await page.screenshot({ path: `${evidence}/shield-wall.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { Math.random = () => 0.9; });
  await page.locator('.playback .primary').click();
  await page.locator('.arena[data-phase="entrance"]').waitFor();
  assert.equal(await page.locator('.health[data-side="right"] [role="progressbar"]').getAttribute('aria-valuenow'), '100');
  await page.locator('.winner-reveal').waitFor({ timeout: 25000 });
  assert.equal(await page.locator('.winner-reveal strong').innerText(), 'GoldenKnight');
  assert.equal(await page.locator('.health[data-side="left"] [role="progressbar"]').getAttribute('aria-valuenow'), '0');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${evidence}/mobile-victory.png`, fullPage: true });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.locator('.arena[data-phase="ready"]').waitFor();
  await page.getByRole('button', { name: 'Transparent background', exact: true }).click();
  assert.equal(await page.locator('.arena').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Change language', exact: true }).click();
  await page.getByRole('button', { name: 'Iniciar duelo', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Iniciar duelo', exact: true }).count(), 2);
  await page.screenshot({ path: `${evidence}/spanish.png`, fullPage: true });
  await page.getByRole('button', { name: 'Cambiar idioma', exact: true }).click();
  // Blank names have stable fixture fallbacks; reduced motion keeps the outcome.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Challenger', { exact: true }).fill('   ');
  await page.getByLabel('Opponent', { exact: true }).fill('');
  await page.locator('.playback .primary').click();
  await page.locator('.arena[data-phase="entrance"]').waitFor();
  assert.equal(await page.locator('.health[data-side="left"] strong').innerText(), 'Dima');
  assert.equal(await page.locator('app-duel-fighter svg .body').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.arena').getAttribute('data-phase'), 'ready', 'Reset cancels playback');
  await goto('/mocks/dev/duel?overlay=1');
  assert.equal(await page.locator('.lf-nav').count(), 0);
  assert.equal(await page.locator('.controls-tile').count(), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Play duel', exact: true }).click();
  await page.locator('.winner-reveal').waitFor({ timeout: 25000 });
  assert(['Dima', 'ChatChampion'].includes(await page.locator('.winner-reveal strong').innerText()), 'Random outcome must be one fighter');
  await page.screenshot({ path: `${evidence}/overlay-only.png`, omitBackground: true });
  await page.goto(base + '/mocks/dev');
  await page.getByRole('link', { name: /Duel · Fighting overlay/ }).waitFor();
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)', 'Navigation restores body background');
  assert.deepEqual(errors, [], 'No JavaScript runtime errors');
  assert.deepEqual(apiRequests, [], 'The mock must not request production APIs');
  console.log('PASS: turn-based RNG battles (characters, special callouts, crits, defense skills, extra turns, turn counter), both winners, combat effects, HP, pause/resume, replay/reset, transparent overlay, random result, English/Spanish, reduced motion, 320/390/1280 dark/light, zero axe violations or runtime errors.');
} finally { await browser.close(); }
