// OAuth consent + connections pages (MCP v1) on the built site candidate, through the dev mock route:
// every key state on phone and desktop, dark first, light too; no overflow, no console errors, axe clean;
// channel choice + Allow, and the inline confirm for revoking a whole app. No network: the mock feeds fixture data.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const AXE = process.env.AXE_MODULE || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const base = process.env.SAAS_PREVIEW_URL; assert(base, 'SAAS_PREVIEW_URL required');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/root/.cache/lead-consent-shots';
await mkdir(shots, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];
async function open(state, { width = 390, height = 844, dark = true, lang = 'en', touch = width < 600 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, colorScheme: dark ? 'dark' : 'light' });
  await context.addInitScript(({ dark, lang }) => { localStorage.setItem('theme', dark ? 'dark' : 'light'); localStorage.setItem('userLanguage', lang); }, { dark, lang });
  await context.route(url => !url.href.startsWith(base), route => route.abort());
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(message.text())) problems.push(`${state}: ${message.text()}`); });
  page.on('pageerror', error => problems.push(`${state}: ${error.message}`));
  await page.goto(`${base}/mocks/dev/oauth-consent?state=${state}&chrome=0`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  return { page, context };
}
const text = page => page.evaluate(() => document.body.innerText);
async function noOverflow(page, label) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width + 1, `${label}: horizontal overflow ${scroll} > ${width}`);
}
async function axe(page, label) {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
    .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`));
  assert.deepEqual(result, [], `${label}: axe`);
}

const states = {
  'desktop': ['Connect Dima Desktop', 'Allow connection'],
  'cimd-recognized': ['Recognized app', 'Published by', 'After you choose, you return to', 'Which channel can it use?', 'AI credits', 'Only continue if you started this connection yourself.', "Don't see a channel you help manage?"],
  'cimd-unverified': ['Unverified app', 'anyone can give an app any name', 'Published by', 'After you choose, you return to', "Don't see a channel you help manage?"],
  'cimd-no-channels': ["You don't have a channel you can connect yet", 'turn on AI apps (MCP) for you in Settings → Team'],
  'error-channel-access': ["You can't connect apps to that channel anymore"],
  'error-blocked': ['Dima blocked this app'],
  'error-unsafe-redirect': ["return address didn't match"],
  'connections': ['Connected applications', 'Disconnect'],
  'connections-empty': ['No apps connected']
};
for (const [state, expected] of Object.entries(states)) {
  for (const view of [{ width: 360, height: 780, dark: true }, { width: 360, height: 780, dark: false }, { width: 1280, height: 900, dark: true }]) {
    const label = `${state} ${view.width}px ${view.dark ? 'dark' : 'light'}`;
    const { page, context } = await open(state, view);
    const body = await text(page);
    for (const phrase of expected) assert.ok(body.includes(phrase), `${label}: missing "${phrase}"`);
    await noOverflow(page, label);
    if (view.width === 360) await axe(page, label);
    await page.screenshot({ path: `${shots}/${state}-${view.width}-${view.dark ? 'dark' : 'light'}.png`, fullPage: true });
    await context.close();
  }
}

// The desktop flow has no channel picker, so no AI apps (MCP) hint.
{
  const { page, context } = await open('desktop');
  assert.doesNotMatch(await text(page), /AI apps \(MCP\)/, 'desktop: no channel-picker hint');
  await context.close();
}

// Spanish (es-MX) renders the same states without missing keys.
for (const state of ['cimd-recognized', 'connections']) {
  const { page, context } = await open(state, { lang: 'es' });
  const body = await text(page);
  assert.doesNotMatch(body, /\boauth\.[a-zA-Z.]+/, `${state} es: raw i18n key shown`);
  assert.match(body, /créditos|Desconectar|aplicaci/i, `${state} es: Spanish copy`);
  await page.screenshot({ path: `${shots}/${state}-es.png`, fullPage: true });
  await context.close();
}

// Channel choice: pick the second channel, Allow; the page confirms and names where it returns.
{
  const { page, context } = await open('cimd-recognized');
  const radios = page.getByRole('radio');
  assert.ok(await radios.count() >= 2, 'several channels to choose from');
  await radios.nth(1).check();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /^Allow/ }).click();
  await page.waitForTimeout(400);
  assert.match(await text(page), /Connection approved/, 'approval confirmation');
  await page.screenshot({ path: `${shots}/cimd-recognized-approved.png`, fullPage: true });
  await context.close();
}

// Revoke a whole app: inline confirm, then the confirmation line.
{
  const { page, context } = await open('connections', { width: 1280, height: 900 });
  await page.locator('[data-ask-grant]').first().click();
  await page.waitForTimeout(700);
  assert.match(await text(page), /stops working right away|signed out right away/, 'confirm explains the effect');
  await page.locator('[data-confirm-grant]').first().click();
  await page.waitForTimeout(400);
  assert.match(await text(page), /was disconnected from/, 'confirmation after revoke');
  await page.screenshot({ path: `${shots}/connections-revoked.png`, fullPage: true });
  await context.close();
}

await browser.close();
assert.deepEqual(problems, [], 'console/page errors');
console.log(`PASS OAuth consent + connections: ${Object.keys(states).length} states × phone/desktop × dark/light, es-MX, axe, channel choice, app revoke. Shots: ${shots}`);
