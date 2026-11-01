// Capture current Commands UI for the docs site using the offline preview gateway.
// Fixture contracts and real interactions mirror ops/checks/commands-browser.mjs.
import assert from 'node:assert/strict';
import { mkdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const sharp = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dimadocs/package.json'))('sharp');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4204';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Capture gateway must be loopback-only');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dimadocs/public/guides/commands');

async function open(browser, lang, { width = 1280, height = 900, theme = 'dark', route = '/commands' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  // Only the isolated preview and static Google Fonts assets are allow-listed; APIs and unknown hosts fail closed.
  const allowedOrigins = new Set([new URL(base).origin, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  await context.route('**/*', route => allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/demostreamer${route}?capture=commands&lang=${lang}&theme=${theme}`);
  await page.waitForFunction(() => window.docsCapture?.lang && Array.isArray(window.docsCapture.unhandled));
  return { context, page, errors };
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const lang of ['en', 'es']) {
    const { context, page, errors } = await open(browser, lang);
    const root = page.locator('app-commands-page');
    await root.locator('.lf-cmd-row').first().waitFor();
    await root.getByRole('heading', { name: lang === 'en' ? 'Commands' : 'Comandos', level: 1 }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => window.docsCapture.errors), [], `${lang} fixture errors`);
    assert.deepEqual(await page.evaluate(() => window.docsCapture.unhandled), [], `${lang} API requests must have fixtures`);
    const prefix = lang === 'en' ? 'commands' : 'comandos';
    // Keep the useful list and filters in frame while excluding the local preview URL field.
    await page.evaluate(() => window.scrollTo(0, 340));
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(out, `${prefix}-list-dark.png`), animations: 'disabled' });

    await root.getByRole('button', { name: lang === 'en' ? 'New command' : 'Nuevo comando' }).click();
    const modal = page.locator('app-command-modal');
    await modal.locator('#command-type-tab[aria-selected="true"]').waitFor();
    await modal.locator('input[formControlName="name"]').fill('hello');
    await modal.locator('input[formControlName="cmd"]').fill('hello');
    await modal.locator('textarea[formControlName="message"]').fill(lang === 'en' ? 'Hello $(user)!' : '¡Hola $(user)!');
    await page.waitForTimeout(150);
    const fullPath = path.join(out, `${prefix}-create-full.png`);
    await page.screenshot({ path: fullPath, animations: 'disabled' });
    const box = await modal.locator('.lf-modal').boundingBox();
    assert.ok(box, `${lang} create dialog bounding box`);
    const left = Math.max(0, Math.floor(box.x - 16));
    const top = Math.max(0, Math.floor(box.y - 16));
    const right = Math.min(1280, Math.ceil(box.x + box.width + 16));
    const bottom = Math.min(900, Math.ceil(box.y + box.height + 16));
    await sharp(fullPath).extract({ left, top, width: right - left, height: bottom - top }).png({ compressionLevel: 9 }).toFile(path.join(out, `${prefix}-create-dark.png`));
    await unlink(fullPath);
    assert.deepEqual(await page.evaluate(() => window.docsCapture.errors), [], `${lang} fixture errors after opening dialog`);
    assert.deepEqual(await page.evaluate(() => window.docsCapture.unhandled), [], `${lang} API requests after opening dialog must have fixtures`);
    assert.deepEqual(errors, [], `${lang} page errors`);
    await context.close();
    console.log(`Captured ${lang} command list and create dialog.`);

    const dashboard = await open(browser, lang, { route: '/dashboard' });
    await dashboard.page.getByRole('heading', { name: 'DemoStreamer', level: 1 }).waitFor();
    const dismissName = lang === 'en' ? 'Dismiss referral banner' : 'Cerrar el aviso de referencias';
    const dismiss = dashboard.page.getByRole('button', { name: dismissName });
    if (await dismiss.count()) await dismiss.click();
    await dashboard.page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await dashboard.page.evaluate(() => window.docsCapture.errors), [], `${lang} dashboard fixture errors`);
    assert.deepEqual(await dashboard.page.evaluate(() => window.docsCapture.unhandled), [], `${lang} dashboard API requests must have fixtures`);
    assert.deepEqual(dashboard.errors, [], `${lang} dashboard page errors`);
    await dashboard.page.screenshot({ path: path.join(out, `dashboard-${lang}.png`), animations: 'disabled' });
    await dashboard.context.close();

    const modules = await open(browser, lang, { route: '/modules' });
    await modules.page.getByRole('heading', { name: lang === 'en' ? 'Modules' : 'Módulos', level: 1 }).waitFor();
    await modules.page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await modules.page.evaluate(() => window.docsCapture.errors), [], `${lang} modules fixture errors`);
    assert.deepEqual(await modules.page.evaluate(() => window.docsCapture.unhandled), [], `${lang} modules API requests must have fixtures`);
    assert.deepEqual(modules.errors, [], `${lang} modules page errors`);
    await modules.page.screenshot({ path: path.join(out, `modules-${lang}.png`), animations: 'disabled' });
    await modules.context.close();

    const events = await open(browser, lang, { route: '/modules/chat-events' });
    await events.page.getByRole('heading', { name: lang === 'en' ? 'Chat Events' : 'Eventos de Chat', level: 1 }).waitFor();
    await events.page.getByRole('button', { name: lang === 'en' ? 'Configure' : 'Configurar' }).first().click();
    await events.page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await events.page.evaluate(() => window.docsCapture.errors), [], `${lang} chat events fixture errors`);
    assert.deepEqual(await events.page.evaluate(() => window.docsCapture.unhandled), [], `${lang} chat events API requests must have fixtures`);
    assert.deepEqual(events.errors, [], `${lang} chat events page errors`);
    await events.page.screenshot({ path: path.join(out, `chat-events-${lang}.png`), animations: 'disabled' });
    await events.context.close();
    console.log(`Captured ${lang} dashboard, modules catalog, and chat event settings.`);
  }

  // Responsive and light-theme sanity with the same isolated fixtures.
  const mobile = await open(browser, 'en', { width: 390, height: 844, theme: 'light' });
  await mobile.page.locator('app-commands-page .lf-cmd-row').first().waitFor();
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'commands page must not overflow at 390px');
  assert.deepEqual(await mobile.page.evaluate(() => window.docsCapture.errors), [], 'mobile fixture errors');
  assert.deepEqual(await mobile.page.evaluate(() => window.docsCapture.unhandled), [], 'mobile API requests must have fixtures');
  assert.deepEqual(mobile.errors, [], 'mobile page errors');
  await mobile.context.close();
} finally {
  await browser.close();
}
