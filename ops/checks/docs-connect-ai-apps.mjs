// saas-ops docs check: the "Connect AI apps to Dima" (MCP) page in English and es-MX, its facts, the link from the
// AI assistants page, and a clean render on phone/desktop in dark and light.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL');
const facts = ['https://mcp.domdimabot.com/mcp', 'https://domdimabot.com/oauth/connections', 'undo_change', 'claude mcp add --transport http dima'];
for (const prefix of ['', 'es/']) {
  const response = await fetch(`${base}/${prefix}connect-ai-apps/`);
  assert.equal(response.status, 200, `${prefix}connect-ai-apps`);
  const html = await response.text();
  for (const fact of facts) assert.ok(html.includes(fact), `${prefix}connect-ai-apps: missing ${fact}`);
  assert.match(html, prefix ? /1 crédito/ : /1 AI credit/);
  // Admins need the owner's explicit AI apps (MCP) grant; the balance check is free.
  assert.match(html, prefix ? /Apps de IA \(MCP\)/ : /AI apps \(MCP\)/, `${prefix}connect-ai-apps: AI apps permission`);
  const dashboard = await (await fetch(`${base}/${prefix}dashboard/`)).text();
  assert.match(dashboard, prefix ? /Apps de IA \(MCP\)/ : /AI apps \(MCP\)/, `${prefix}dashboard: AI apps permission`);
  const assistants = await (await fetch(`${base}/${prefix}ai-assistants/`)).text();
  assert.ok(assistants.includes(`/${prefix}connect-ai-apps/`), `${prefix}ai-assistants links to the MCP page`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
try {
  for (const prefix of ['', 'es/']) for (const width of [320, 1280]) for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('starlight-theme', theme), theme);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/docs-assistant/**', route => route.abort());
    const response = await page.goto(`${base}/${prefix}connect-ai-apps/`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    await page.locator('main .sl-markdown-content').waitFor();
    assert.equal(await page.getAttribute('html', 'data-theme'), theme);
    assert.match(await page.locator('main h1').innerText(), prefix ? /IA|Dima/ : /Connect AI apps/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${prefix}connect-ai-apps ${width}/${theme}: ${overflow}px page overflow`);
    await context.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(errors, []);
console.log('PASS docs: Connect AI apps (EN + es-MX) facts, link from AI assistants, 320/1280 × dark/light without overflow or page errors');
