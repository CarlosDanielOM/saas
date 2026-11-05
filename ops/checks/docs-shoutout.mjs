// saas-ops docs check; also accepts SAAS_DOCS_DEV=1 for the isolated Astro preview.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL');
const paths = ['commands/advanced/functions/', 'commands/overview/', 'commands/built-in/', 'clips/', 'ai-assistants/'];
for (const prefix of ['', 'es/']) {
  const text = await (await fetch(`${base}/${prefix}commands/advanced/functions/index.txt`)).text();
  for (const name of ['$(shoutout target)', '$(show.clip target)', '$(twitch.channel [target])', '$(twitch.login [target])', '$(twitch.game [target])']) assert.ok(text.includes(name), `${prefix} missing ${name}`);
  assert.ok(text.includes('$(announcement ...'), 'announcement alias exported');
  assert.match(text, /60 minut/);
  assert.match(text, /https:\/\/dev\.twitch\.tv\/docs\/api\/reference\/#send-a-shoutout/);
  const builtIn = await (await fetch(`${base}/${prefix}commands/built-in/index.txt`)).text();
  assert.doesNotMatch(builtIn, /^\|\s*`!so`\s*\|/m, '!so is not a reserved built-in row');
  const overview = await (await fetch(`${base}/${prefix}commands/overview/index.txt`)).text();
  assert.match(overview, /!ec so/);
  assert.match(overview, /450/);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
let count = 0;
try {
  for (const prefix of ['', 'es/']) for (const width of [320, 1280]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('starlight-theme', theme), theme);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/docs-assistant/**', route => route.abort());
    for (const path of paths) {
      const response = await page.goto(`${base}/${prefix}${path}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await page.locator('main .sl-markdown-content').waitFor();
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 500))]));
      assert.equal(await page.getAttribute('html', 'data-theme'), theme);
      assert.ok(await page.locator('main h1').innerText());
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${prefix}${path} ${width}/${theme}: ${overflow}px page overflow`);
      if (path === paths[0]) {
        const body = await page.locator('main').innerText();
        assert.ok(body.includes('$(shoutout target)') && body.includes('$(show.clip target)'));
      }
      if (process.env.SAAS_SCREENSHOT_DIR && !prefix && theme === 'dark' && path === paths[0]) {
        await page.getByText('$(shoutout target)', { exact: true }).first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.SAAS_SCREENSHOT_DIR}/shoutout-functions-${width}-dark.png` });
      }
      count++;
    }
    await context.close();
  }
} finally { await browser.close(); }
assert.deepEqual(errors, []);
console.log(`PASS ${count} bilingual docs page/theme/viewport checks, readable action reference, target syntax and current shoutout limits`);
if (process.env.SAAS_DOCS_DEV !== '1') execFileSync('python3', ['/root/saas/ops/checks/docs_visuals.py'], { stdio: 'inherit', env: process.env });
