// Checks the public EN/ES legal documents, navigation, text exports, and responsive reading experience.
// saas-ops supplies SAAS_PREVIEW_URL; set SAAS_LEGAL_HTTP_ONLY=1 for a read-only production smoke.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const base = process.env.SAAS_PREVIEW_URL?.replace(/\/$/, '');
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = 'https://docs.domdimabot.com';
const documents = [];
for (const [prefix, language] of [['', 'en'], ['/es', 'es']]) {
  for (const kind of ['terms', 'privacy']) {
    documents.push({
      path: `${prefix}/legal/dimafx-${kind}/`, prefix, language, kind,
      counterpart: `${prefix ? '' : '/es'}/legal/dimafx-${kind}/`,
      sibling: `${prefix}/legal/dimafx-${kind === 'terms' ? 'privacy' : 'terms'}/`,
      title: kind === 'terms'
        ? (prefix ? /Términos de servicio.*DimaFX/i : /DimaFX.*Terms of Service/i)
        : (prefix ? /Política de privacidad.*DimaFX/i : /DimaFX.*Privacy Policy/i),
    });
  }
}

async function get(path, mime) {
  const response = await fetch(base + path, { headers: { 'User-Agent': 'DomDimaBot-legal-check/1.0' } });
  assert.equal(response.status, 200, path);
  if (mime) assert.ok(response.headers.get('content-type')?.includes(mime), `${path}: ${mime}`);
  let body = await response.text();
  // Cloudflare rewrites public HTML mailto links; validate their actual decoded destination.
  if (mime === 'text/html') {
    body = body.replace(/href="\/cdn-cgi\/l\/email-protection#([a-f\d]+)"/gi, (_, value) => {
      const bytes = Buffer.from(value, 'hex');
      const address = String.fromCharCode(...bytes.subarray(1).map(byte => byte ^ bytes[0]));
      return `href="mailto:${address}"`;
    });
  }
  return body;
}

for (const document of documents) {
  const html = await get(document.path, 'text/html');
  assert.match(html, new RegExp(`<html[^>]+lang="${document.language}"`), document.path);
  assert.ok(html.includes(`href="${origin}${document.path}"`), `${document.path}: canonical URL`);
  for (const link of [document.counterpart, document.sibling, 'mailto:support@domdimabot.com']) {
    assert.ok(html.includes(`href="${link}"`), `${document.path}: ${link}`);
  }
  const text = await get(document.path + 'index.txt', 'text/plain');
  assert.match(text.split('\n')[0], document.title, document.path);
  for (const expected of ['Carlos D. Ordonez', 'CDOM Labs', 'Arizona', 'support@domdimabot.com']) {
    assert.ok(text.includes(expected), `${document.path}: ${expected}`);
  }
  assert.ok(text.includes(document.language === 'en' ? 'November 7, 2026' : '7 de noviembre de 2026'), 'effective date');
  assert.doesNotMatch(text, /\[(?:publication date|confirm|before publi|operator|fecha de publi)/i);
  assert.doesNotMatch(text, /\b(?:TODO|TBD)\b|implementation-gap/);
  if (document.kind === 'privacy') {
    for (const expected of ['365', 'Hetzner', 'HEL1', 'Piper']) assert.ok(text.includes(expected), `${document.path}: ${expected}`);
    for (const expected of document.language === 'en'
      ? ['transaction ID', 'product SKU', 'OpenRouter', 'OpenAI', 'zero data retention', 'Twitch display name', 'queue card']
      : ['ID de transacción', 'SKU del producto', 'OpenRouter', 'OpenAI', 'retención cero', 'nombre para mostrar', 'tarjeta de la cola']) {
      assert.ok(text.toLowerCase().includes(expected.toLowerCase()), `${document.path}: ${expected}`);
    }
    assert.ok(text.includes(document.language === 'en'
      ? 'use or share it for advertising or marketing'
      : 'no la usamos ni compartimos para publicidad o marketing'), `${document.path}: no advertising or marketing use`);
    assert.ok((document.language === 'en' ? /analytics/i : /an[aá]lisis|anal[ií]tica/i).test(text), `${document.path}: product analytics`);
    assert.ok((document.language === 'en' ? /playback/i : /reproducci[oó]n/i).test(text), `${document.path}: playback records`);
    assert.ok((document.language === 'en' ? /preferences/i : /preferencias/i).test(text), `${document.path}: saved preferences`);
  }
  const index = await get(document.prefix + '/llms.txt', 'text/plain');
  assert.ok(index.includes(origin + document.path + 'index.txt'), `${document.path}: text index discovery`);
  const guide = await get(document.prefix + '/dimafx/', 'text/html');
  assert.ok(guide.includes(`href="${document.path}"`), `${document.path}: guide discovery`);
  assert.ok(html.includes('aria-current="page"'), `${document.path}: active sidebar entry`);
  const home = await get(document.prefix + '/', 'text/html');
  assert.ok(home.includes(`href="${document.path}"`), `${document.path}: homepage footer discovery`);
}
console.log('PASS: four legal URLs, language/companion/contact links, policy facts, dates, and discovery');

// Sitemap output is generated only by the production build, not Astro's development server.
if (process.env.SAAS_LEGAL_DEV !== '1') {
  execFileSync('python3', [process.env.DOCS_LLMS_CHECK || '/root/saas/ops/checks/docs_llms.py'], { stdio: 'inherit', env: process.env });
}

if (process.env.SAAS_LEGAL_HTTP_ONLY !== '1') {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const shots = process.env.SAAS_SCREENSHOT_DIR;
  if (shots) await mkdir(shots, { recursive: true });
  const errors = [];
  try {
    for (const document of documents) {
      for (const width of [320, 390, 1280]) {
        for (const theme of ['dark', 'light']) {
          const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
          await context.addInitScript(t => localStorage.setItem('starlight-theme', t), theme);
          // Reading legal documents must not submit anything to the production assistant API.
          await context.route('https://api.domdimabot.com/**', route => route.abort());
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(`${document.path}: ${error.message}`));
          const response = await page.goto(base + document.path, { waitUntil: 'networkidle' });
          assert.equal(response.status(), 200);
          await assert.doesNotReject(() => page.locator('h1').filter({ hasText: document.title }).waitFor());
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${document.path} ${width} ${theme}: horizontal overflow`);
          const article = page.locator('.sl-markdown-content');
          assert.ok(await article.locator('h2').count() >= 7, `${document.path}: complete sections`);
          await page.addScriptTag({ path: process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
          const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target).slice(0, 3) })));
          assert.deepEqual(violations, [], `${document.path} ${width} ${theme}: accessibility`);
          if (shots && width !== 390) await page.screenshot({ path: `${shots}/${document.language}-${document.kind}-${width}-${theme}.png`, fullPage: true });
          // Follow the actual translation link, so a link to the other-language homepage fails.
          if (width === 390 && theme === 'dark') {
            await article.locator(`a[href="${document.counterpart}"]`).click();
            await page.waitForURL(base + document.counterpart);
            assert.equal(await page.locator('html').getAttribute('lang'), document.language === 'en' ? 'es' : 'en');
          }
          await context.close();
        }
      }
    }
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS: legal reading and translation navigation at 320/390/1280px, dark/light, zero axe violations');
  } finally {
    await browser.close();
  }
}
