// Behavior check for the docs redesign: homepage search hero, docs assistant
// placeholder (search fallback + chatbot hook), page leads, sidebar badges,
// mobile/desktop layout in both themes and languages, plus the llms exports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL');
const shots = process.env.SAAS_SCREENSHOT_DIR;

// Machine-readable exports must keep working (single --check, so run it here).
// verify copies this script alone, so reference the checked-in export check directly.
execFileSync('python3', [process.env.DOCS_LLMS_CHECK || '/root/saas/ops/checks/docs_llms.py'], { stdio: 'inherit', env: process.env });
const home = await (await fetch(base + '/index.txt')).text();
assert.match(home, /Find the guide you need/);
assert.doesNotMatch(home, /DocsHomeSearch|Coming soon|data-docs/, 'interactive homepage parts stay out of text export');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

async function open(path, { width = 1280, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript((t) => localStorage.setItem('starlight-theme', t), theme);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${path} ${width} ${theme}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${path} @${width} overflows by ${overflow}px`);
  if (shots) await page.screenshot({ path: `${shots}/docs-${path.replace(/\W+/g, '_') || 'home'}-${width}-${theme}.png`, fullPage: true });
  return { page, context };
}

const searchResults = (page) => page.locator('#starlight__search .pagefind-ui__result').first().waitFor({ timeout: 10000 });

for (const [lang, prefix, askLabel, guideTitle] of [['en', '', 'Ask the docs', 'Text to Speech'], ['es', '/es', 'Pregunta a la documentación', null]]) {
  for (const width of [390, 1280]) {
    for (const theme of ['dark', 'light']) {
      const { page, context } = await open(prefix + '/', { width, theme });

      // Hero search button opens the real search dialog.
      await page.click('.lf-search__box');
      await page.locator('site-search dialog[open]').waitFor();
      await page.keyboard.press('Escape');

      // Popular chip opens search pre-filled, with results.
      const chip = page.locator('.lf-search__popular .lf-chip--link').first();
      const query = await chip.getAttribute('data-docs-search');
      await chip.click();
      await searchResults(page);
      assert.equal(await page.locator('#starlight__search input').inputValue(), query);
      await page.keyboard.press('Escape');

      // Assistant launcher: reachable, ≥44px, opens the panel.
      const launcher = page.locator('.da-launcher');
      const box = await launcher.boundingBox();
      assert.ok(box && box.height >= 44, 'launcher touch target');
      if (width >= 800) assert.equal((await launcher.innerText()).trim(), askLabel);
      await launcher.click();
      const panel = page.locator('#docs-assistant-panel[open]');
      await panel.waitFor();
      const pbox = await panel.boundingBox();
      if (width < 800) assert.ok(Math.abs(pbox.width - width) <= 2, 'bottom sheet spans the phone width');
      else assert.ok(pbox.width <= 440, 'desktop side panel');

      // Without a chatbot, a suggestion falls back to search.
      await page.locator('.da-suggestion').first().click();
      await searchResults(page);
      assert.equal(await page.locator('#docs-assistant-panel[open]').count(), 0, 'assistant closes for the fallback');
      await page.keyboard.press('Escape');

      // Chatbot hook: a listener that handles the question keeps the panel and skips search.
      await page.evaluate(() => document.addEventListener('docs-assistant:ask', (e) => {
        e.preventDefault();
        window.__asked = { question: e.detail.question, lang: e.detail.page.lang, mount: !!e.detail.mount };
      }));
      await page.evaluate(() => window.DocsAssistant.open());
      await page.fill('#da-input', 'Where is my overlay URL?');
      await page.press('#da-input', 'Enter');
      assert.deepEqual(await page.evaluate(() => window.__asked), { question: 'Where is my overlay URL?', lang, mount: true });
      assert.equal(await page.locator('#docs-assistant-panel[open]').count(), 1);
      assert.equal(await page.locator('site-search dialog[open]').count(), 0);
      await page.keyboard.press('Escape');
      await context.close();
    }
  }

  // Guide page: description shown as lead, Alpha badge in sidebar, mobile menu hides launcher.
  for (const width of [390, 1280]) {
    const { page, context } = await open(prefix + '/tts/', { width, theme: 'dark' });
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    assert.equal((await page.locator('.docs-lead').innerText()).trim(), description.trim());
    if (guideTitle) assert.match(await page.locator('h1').innerText(), /speech/i);
    if (width < 800) {
      await page.click('starlight-menu-button button');
      assert.equal(await page.locator('.da-launcher').isVisible(), false, 'launcher hidden behind open menu');
    }
    assert.ok(await page.locator('.sidebar-content a[href$="/overlay-studio/"] .sl-badge').count() >= 1, 'Alpha badge');
    await context.close();
  }
}

await browser.close();
assert.deepEqual(errors, []);
console.log('docs redesign browser check passed');
