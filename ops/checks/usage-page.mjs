/** Behavior check: AI credit usage page route, i18n, and built bundle markup. */
import assert from 'node:assert/strict';

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');

// 1. The usage route resolves to the CSR shell (not the prerendered landing).
const page = await fetch(`${base}/cdom201/usage`);
assert.equal(page.status, 200, 'usage route must resolve');
const shell = await page.text();
assert.match(shell, /<app-root/i, 'CSR shell must be served for /:streamer/usage');

// 2. i18n bundles expose the usage keys in both languages.
for (const lang of ['en', 'es']) {
  const res = await fetch(`${base}/assets/i18n/${lang}.json`);
  assert.equal(res.status, 200, `${lang}.json must be served`);
  const dict = await res.json();
  const usage = dict.usage ?? {};

  for (const key of ['kicker', 'title', 'subtitle', 'backToDashboard']) {
    assert.ok(usage[key], `${lang}: usage.${key} missing`);
  }
  for (const section of [
    'balance',
    'pacing',
    'period',
    'analytics',
    'transactions',
    'categories',
    'errors',
    'plans',
    'units',
    'status'
  ]) {
    assert.ok(usage[section] && typeof usage[section] === 'object', `${lang}: usage.${section} section missing`);
  }

  assert.ok(usage.balance?.remaining, `${lang}: usage.balance.remaining missing`);
  assert.ok(usage.balance?.unavailable, `${lang}: usage.balance.unavailable missing`);
  assert.ok(usage.pacing?.status?.within_pace, `${lang}: usage.pacing.status.within_pace missing`);
  assert.ok(usage.pacing?.status?.exhausted, `${lang}: usage.pacing.status.exhausted missing`);
  assert.ok(usage.period?.source?.free_monthly, `${lang}: usage.period.source.free_monthly missing`);
  assert.ok(usage.period?.source?.subscription, `${lang}: usage.period.source.subscription missing`);
  assert.ok(usage.analytics?.lockedCta, `${lang}: usage.analytics.lockedCta missing`);
  assert.ok(usage.transactions?.lockedCta, `${lang}: usage.transactions.lockedCta missing`);
  assert.ok(usage.transactions?.loadMore, `${lang}: usage.transactions.loadMore missing`);
  assert.ok(usage.categories?.tts, `${lang}: usage.categories.tts missing`);
  assert.ok(usage.categories?.ai_chat, `${lang}: usage.categories.ai_chat missing`);
  assert.ok(usage.errors?.loadFailed, `${lang}: usage.errors.loadFailed missing`);
  assert.ok(
    dict.dashboard?.kpis?.aiCreditsViewUsage,
    `${lang}: dashboard.kpis.aiCreditsViewUsage missing`
  );
}

// 3. The built chunks ship the usage page markup/logic and the dashboard entry link.
const mainMatch = shell.match(/src="([^"]*main-[^"]+\.js)"/);
assert.ok(mainMatch, 'main chunk must be referenced by the CSR shell');
const mainJs = await (await fetch(`${base}/${mainMatch[1].replace(/^\//, '')}`)).text();

const hasUsagePage = (body) =>
  body.includes('lf-balance') &&
  body.includes('lf-daily') &&
  body.includes('lf-locked') &&
  body.includes('lf-ledger') &&
  body.includes('usage.pacing.title') &&
  body.includes('usage.transactions.title') &&
  body.includes('usage.analytics.lockedTitle') &&
  body.includes('usage.balance.percentUsed');

const hasDashboardEntry = (body) =>
  body.includes('dashboard.kpis.aiCreditsViewUsage') && body.includes('lf-usage-link');

let foundUsage = hasUsagePage(mainJs);
let foundEntry = hasDashboardEntry(mainJs);
if (!foundUsage || !foundEntry) {
  const chunkNames = [...new Set([...mainJs.matchAll(/chunk-[A-Z0-9]+\.js/g)].map((m) => m[0]))];
  const concurrency = 8;
  for (let i = 0; i < chunkNames.length && (!foundUsage || !foundEntry); i += concurrency) {
    const batch = chunkNames.slice(i, i + concurrency);
    const bodies = await Promise.all(
      batch.map(async (name) => {
        const res = await fetch(`${base}/${name}`);
        return res.status === 200 ? res.text() : '';
      })
    );
    foundUsage = foundUsage || bodies.some(hasUsagePage);
    foundEntry = foundEntry || bodies.some(hasDashboardEntry);
  }
}

assert.ok(foundUsage, 'no served chunk contains the AI usage page markup/logic');
assert.ok(foundEntry, 'no served chunk contains the dashboard usage entry link');

console.log('AI usage page bundle checks passed');
