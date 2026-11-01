// Behavior check for the docs redesign: homepage search hero, docs assistant
// (chat against a local fake API, error → search fallback, chatbot hook), page leads,
// sidebar badges, mobile/desktop layout in both themes and languages, plus the llms exports.
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

// Fake docs assistant API (same wire format as dimabot's /docs-assistant). No model calls.
import http from 'node:http';
const assistantCalls = [];
const fakeApi = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    assistantCalls.push({ path: req.url, body });
    if (req.url === '/docs-assistant/feedback') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"error":false,"data":{"recorded":true}}'); }
    const question = body.messages.at(-1).content;
    if (/overlay/i.test(question)) { // follow-up question → simulated busy assistant
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: true, status: 503, data: { code: 'busy' } }));
    }
    const es = body.page.lang === 'es';
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send('start', { id: '00000000-0000-4000-8000-00000000000' + assistantCalls.length % 10 });
    send('status', { phase: 'thinking' });
    const url = `https://docs.domdimabot.com/${es ? 'es/' : ''}tts/`;
    for (const delta of [`${es ? 'Abre' : 'Open'} **Modules → Text to speech**.\n\n`, '```text\n!cc -ul=everyone mivoz %(**voz $(user)) Voz guardada: &p1 — a long line that must scroll sideways on phones\n```\n\n', `[${es ? 'Texto a voz' : 'Text to Speech'}](${url})`]) send('text', { delta });
    send('done', { id: 'x', sources: [{ title: es ? 'Texto a voz' : 'Text to Speech', url }] });
    res.end();
  });
});
await new Promise((resolve) => fakeApi.listen(0, '127.0.0.1', resolve));
const fakeApiUrl = `http://127.0.0.1:${fakeApi.address().port}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

async function open(path, { width = 1280, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(([t, api]) => {
    localStorage.setItem('starlight-theme', t);
    localStorage.setItem('docs-assistant:api', api); // local-only override → fake API
  }, [theme, fakeApiUrl]);
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
      else assert.ok(pbox.width <= 500, 'desktop side panel');
      assert.equal(await page.locator('.da-soon, .lf-search__soon').count(), 0, 'no "Coming soon" labels');

      // A suggestion asks the assistant: streamed answer, same-site source chip, copy button, feedback.
      const suggestion = await page.locator('.da-suggestion').first().getAttribute('data-question');
      await page.locator('.da-suggestion').first().click();
      await page.locator('.da-sources').waitFor();
      assert.equal(await page.locator('.da-msg--user .da-bubble').innerText(), suggestion);
      assert.equal(await page.locator('.da-source').getAttribute('href'), `${prefix}/tts/`);
      assert.equal(await page.locator('.da-answer a').getAttribute('href'), `${prefix}/tts/`);
      assert.equal(await page.locator('.da-answer .da-code__bar .da-copy').count(), 1);
      // Copy sits in the bar above the code: never over the code, and it doesn't move when the code scrolls.
      const pre = page.locator('.da-answer .da-code pre');
      const copy = page.locator('.da-answer .da-copy');
      const before = await copy.boundingBox();
      const preBox = await pre.boundingBox();
      assert.ok(before.y + before.height <= preBox.y + 1, 'Copy button does not overlap the code');
      if (width < 800) {
        assert.ok(await pre.evaluate((el) => el.scrollWidth > el.clientWidth), 'long line scrolls on phones');
        await pre.evaluate((el) => { el.scrollLeft = 200; });
        const after = await copy.boundingBox();
        assert.equal(Math.round(after.x), Math.round(before.x), 'Copy button stays put while code scrolls');
      }
      assert.equal(await page.locator('.da-answer strong').first().innerText(), 'Modules → Text to speech');
      const asked = assistantCalls.filter((call) => call.path === '/docs-assistant/ask').at(-1).body;
      assert.equal(asked.page.lang, lang);
      assert.deepEqual(asked.messages, [{ role: 'user', content: suggestion }]);
      await page.locator('.da-feedback__btn').first().click();
      await page.locator('.da-feedback__thanks').waitFor();
      const overflow = await page.evaluate(() => document.querySelector('.da-body').scrollWidth - document.querySelector('.da-body').clientWidth);
      assert.ok(overflow <= 0, `assistant panel overflows by ${overflow}px`);
      if (shots) await page.screenshot({ path: `${shots}/docs-assistant-${lang}-${width}-${theme}.png` });

      // Follow-up sends the earlier exchange; an error offers Retry and the docs search (with results).
      await page.fill('#da-input', lang === 'es' ? '¿Overlay en OBS?' : 'Overlay in OBS?');
      await page.press('#da-input', 'Enter');
      await page.locator('.da-error').waitFor();
      const followUp = assistantCalls.filter((call) => call.path === '/docs-assistant/ask').at(-1).body;
      assert.deepEqual(followUp.messages.map((message) => message.role), ['user', 'assistant', 'user']);
      assert.equal(await page.locator('.da-error .da-pill').count(), 2);
      await page.locator('.da-error .da-pill').nth(1).click();
      await searchResults(page);
      assert.equal(await page.locator('#docs-assistant-panel[open]').count(), 0, 'assistant closes for the search fallback');
      await page.keyboard.press('Escape');

      // New chat clears the conversation.
      await page.evaluate(() => window.DocsAssistant.open());
      await page.click('[data-docs-assistant-new]');
      assert.equal(await page.locator('.da-msg').count(), 0);

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
fakeApi.close();
assert.ok(assistantCalls.some((call) => call.path === '/docs-assistant/feedback'), 'feedback sent');
assert.deepEqual(errors.filter((error) => !/503 \(Service Unavailable\)/.test(error)), []);
console.log('docs redesign browser check passed');
