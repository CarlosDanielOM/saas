import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/mocks/dev/command-ast`);
  await page.getByRole('heading', { name: 'Build a command, block by block.' }).waitFor();
  assert.equal(await page.locator('.ast-canvas').isVisible(), true);
  assert.equal(await page.locator('.ast-palette').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Hello user' }).getAttribute('aria-pressed'), 'true');

  await page.getByRole('button', { name: '1 · Blocks' }).click();
  await page.locator('.ast-palette').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.ast-palette').isVisible(), true);
  assert.equal(await page.locator('.ast-canvas').isVisible(), false);
  await page.locator('.ast-palette').getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.ast-canvas').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.ast-canvas').isVisible(), true);
  assert.equal(await page.locator('.canvas__row').count(), 4);
  await page.locator('.intro').getByRole('button', { name: 'Run preview' }).click();
  await page.locator('.ast-out').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.ast-out').isVisible(), true);
  assert.match(await page.locator('.code--out').innerText(), /Hello PixelFan!/);

  await page.locator('#command-source').fill('Welcome $(user)!');
  await page.getByRole('button', { name: 'Make blocks' }).click();
  await page.locator('.ast-canvas').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.ast-canvas').isVisible(), true);
  assert.equal(await page.locator('.canvas__row').count(), 3);
  await page.locator('.canvas__row .blk').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.canvas__row .blk.is-on').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.canvas__row').length === 2);
  assert.equal(await page.locator('.canvas__row').count(), 2);

  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.getByRole('heading', { name: 'Start with a block' }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('heading', { name: 'Start with a block' }).isVisible(), true);
  await page.getByRole('button', { name: 'Browse blocks' }).click();
  await page.locator('.ast-palette').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.ast-palette').isVisible(), true);

  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`);
  }
  assert.equal(await page.locator('.ast-palette').isVisible(), true);
  assert.equal(await page.locator('.ast-canvas').isVisible(), true);
  assert.equal(await page.locator('.ast-out').isVisible(), true);

  await page.getByRole('button', { name: 'Ban target' }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((name) => {
      document.documentElement.classList.toggle('dark', name === 'dark');
      document.documentElement.setAttribute('data-theme', name);
    }, theme);
    await page.waitForTimeout(250);
    const axe = await new AxeBuilder({ page }).include('app-command-ast-mock')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(
      axe.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })),
      [], `${theme} AST mock accessibility`
    );
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await context.close();
  console.log('PASS AST blocks mobile panels, add/edit/run, keyboard selection, empty state, responsive widths, accessibility');
} finally {
  await browser.close();
}
