import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Profile → Subscription → "Manage subscription" opens the Polar customer portal.
// All API calls are mocked; the Polar portal is a local stub page.
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp';
const portalUrl = 'https://polar.sh/cdom-labs/portal?customer_session_token=test-only';

async function until(fn, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [tier, language] of [['free', 'en'], ['premium', 'en'], ['pro', 'es']]) {
    const context = await browser.newContext();
    const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
    const app = {
      name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: tier,
      plan_tier_until: tier === 'free' ? null : '2026-11-14T12:00:00.000Z',
      actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
      up_to_date_permissions: true, administrating: []
    };
    await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2, token: 'test-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch,
      appUser: app, permissions: {}
    })), { twitch, app });

    const portalRequests = [];
    let failNextPortal = true;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.href.startsWith('https://polar.sh/cdom-labs/portal')) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Polar portal stub</title><h1>Portal</h1>' });
      }
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      if (url.pathname === '/billing/portal') {
        assert.equal(request.method(), 'POST');
        portalRequests.push(request.postDataJSON());
        await new Promise(resolve => setTimeout(resolve, 400));
        if (failNextPortal) {
          failNextPortal = false;
          return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Internal server error' } });
        }
        return route.fulfill({
          status: 201,
          json: { error: false, status: 201, data: { sessionId: 'cs_test', url: portalUrl, expiresAt: '2026-10-14T13:00:00Z' } }
        });
      }
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
      return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/test/profile`);
    const tile = page.locator('app-profile-page section.lf-plan');
    await tile.waitFor();
    const en = language === 'en';
    const manage = tile.getByRole('button', { name: en ? 'Manage subscription' : 'Gestionar suscripción' });

    if (tier === 'free') {
      assert.equal(await manage.count(), 0, 'free plan must not offer subscription management');
      assert.equal(await tile.locator('.lf-plan__manage').count(), 0);
      await tile.getByRole('button', { name: 'Upgrade to Premium or Pro' }).waitFor();
    } else {
      await manage.waitFor();
      if (tier === 'premium') await tile.getByRole('button', { name: 'Upgrade to Pro' }).waitFor();
      else await tile.getByText('Estas en el plan mas alto', { exact: false }).waitFor();
      await tile.getByText(en ? 'update your payment method' : 'actualiza tu método de pago', { exact: false }).waitFor();
      const described = await manage.getAttribute('aria-describedby');
      assert.equal(await page.locator(`#${described}`).count(), 1, 'hint must describe the button');

      // Primary-style contrast: the button must have a visible background in both themes.
      for (const theme of ['dark', 'light']) {
        await page.evaluate(name => {
          document.documentElement.classList.toggle('dark', name === 'dark');
          document.documentElement.setAttribute('data-theme', name);
        }, theme);
        const bg = await manage.evaluate(el => getComputedStyle(el).backgroundColor);
        assert.notEqual(bg, 'rgba(0, 0, 0, 0)', `manage button background in ${theme}`);
      }
    }

    for (const [width, height, theme] of [[320, 700, 'dark'], [390, 844, 'light'], [1280, 900, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(name => {
        document.documentElement.classList.toggle('dark', name === 'dark');
        document.documentElement.setAttribute('data-theme', name);
      }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`);
      if (tier !== 'free') {
        const box = await manage.boundingBox();
        assert.ok(box && box.height >= 44, `touch target at ${width}px: ${JSON.stringify(box)}`);
      }
      await tile.screenshot({ path: `${shots}/profile-plan-${tier}-${width}-${theme}.png` });
      const axe = await new AxeBuilder({ page })
        .include('app-profile-page')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      assert.deepEqual(
        axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
        [],
        `${tier} profile accessibility at ${width}px ${theme}`
      );
    }

    if (tier !== 'free') {
      // 1st attempt: server error → plain-language alert, button usable again, user stays on the page.
      // The label changes while opening, so follow the button by position, not by name.
      const button = tile.locator('.lf-plan__manage button');
      await manage.click();
      await until(async () => await button.isDisabled(), 'button disables while opening');
      await tile.getByRole('button', { name: en ? 'Opening billing portal…' : 'Abriendo el portal de pagos…' }).waitFor();
      await button.click({ force: true, timeout: 1000 }).catch(() => {});
      const alert = tile.getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), en ? /couldn't open the billing portal/ : /No pudimos abrir el portal de pagos/);
      assert.equal(portalRequests.length, 1, 'double click while opening must not create a second session');
      await until(async () => !(await button.isDisabled()), 'button re-enables after an error');
      assert.ok(page.url().startsWith(`${base}/test/profile`));

      // Retry: redirects to the portal with the profile page as return URL.
      await Promise.all([page.waitForURL(url => url.href === portalUrl), button.click()]);
      assert.equal(portalRequests.length, 2);
      for (const body of portalRequests) assert.deepEqual(body, { returnUrl: `${base}/test/profile` });
    }
    assert.deepEqual(errors, [], `${tier} browser errors`);
    await context.close();
  }
  console.log('PASS profile manage-subscription: hidden on free, shown on premium/pro (en/es), opens Polar portal with profile return URL, error + retry, no duplicate sessions, 44px target, no overflow at 320/390/1280, axe clean dark/light');
} finally {
  await browser.close();
}
