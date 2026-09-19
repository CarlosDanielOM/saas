import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const definitions = [
  ['45c32959-3fa2-41a6-855c-bbeafcf9ce3c', 'credits', 'sample', 40_000, 100],
  ['2f446a84-69a9-42f6-96ed-6be2b31fdf0c', 'credits', 'starter', 250_000, 500],
  ['4315e89b-bf47-4ddd-a889-e6be6056853d', 'credits', 'medium', 550_000, 1_000],
  ['44d391d1-8952-408d-ad51-06200404d3ad', 'recharge', 'small', 110_000, 200],
  ['44a6baba-e057-4af7-82c4-ec8ddd528913', 'recharge', 'starter', 325_000, 500],
  ['ac85860a-dee1-4399-9c32-932229d112c1', 'recharge', 'medium', 699_984, 1_000]
];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const tier of ['free', 'premium']) {
    const context = await browser.newContext();
    const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
    const app = {
      name: 'Test Streamer', email: 'test@example.invalid', language: 'en', plan_tier: tier,
      actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
      up_to_date_permissions: true, administrating: []
    };
    await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch,
      appUser: app, permissions: {}
    })), { twitch, app });

    const offers = definitions.map(([id, kind, size, credits, priceAmount]) => ({
      id, kind, size, credits, priceAmount, priceCurrency: 'usd', name: `${size} ${kind}`,
      rollover: kind === 'credits',
      eligible: kind === 'credits' || tier !== 'free',
      eligibilityReason: kind === 'recharge' && tier === 'free' ? 'paid_plan_required' : null
    }));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
      else if (url.pathname === '/billing/credit-packs') {
        data = { planTier: tier, hasActivePaidSubscription: tier !== 'free', offers };
      }
      return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/test/credits`);
    const store = page.locator('app-credit-packs-page');
    await store.getByRole('heading', { name: 'Credit packs', exact: true }).waitFor();
    assert.equal(await store.locator('.lf-pack-card--credit').count(), 3);
    assert.equal(await store.locator('.lf-pack-card--recharge').count(), 3);
    await store.getByText('Unused credits roll over and do not expire.', { exact: false }).waitFor();
    await store.getByText('Unused credits expire when the subscription renews or ends.', { exact: false }).waitFor();

    const rechargeButtons = store.locator('.lf-pack-card--recharge button');
    if (tier === 'free') {
      assert.equal(await store.getByText('Premium or Pro only', { exact: true }).count(), 1);
      assert.equal(await rechargeButtons.evaluateAll(buttons => buttons.every(button => button.disabled)), true);
    } else {
      assert.equal(await store.getByText('Unlocked for your plan', { exact: true }).count(), 1);
      assert.equal(await rechargeButtons.evaluateAll(buttons => buttons.every(button => !button.disabled)), true);
    }

    for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(themeName => {
        document.documentElement.classList.toggle('dark', themeName === 'dark');
        document.documentElement.setAttribute('data-theme', themeName);
      }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`);
      await page.screenshot({ path: `/tmp/credit-packs-${tier}-${width}-${theme}.png`, fullPage: true });
    }

    const axe = await new AxeBuilder({ page })
      .include('app-credit-packs-page')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    assert.deepEqual(
      axe.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) })),
      [],
      `${tier} store accessibility`
    );
    assert.deepEqual(errors, [], `${tier} store browser errors`);
    await context.close();
  }
  console.log('PASS credit store distinction, free/paid recharge states, 320/390/1280 layouts, dark mode, accessibility, and browser runtime');
} finally {
  await browser.close();
}
