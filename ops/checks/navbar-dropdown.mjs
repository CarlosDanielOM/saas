import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4213';

const EXPECTED_ICON = {
  'Profile Settings': 'auth-navbar__profile-icon',
  'Buy AI credits': 'auth-navbar__credits-icon',
  Upgrade: 'auth-navbar__upgrade-icon',
  'Upgrade to Pro': 'auth-navbar__upgrade-icon',
  Light: 'auth-navbar__theme-icon',
  Dark: 'auth-navbar__theme-icon',
  EN: 'auth-navbar__lang-icon',
  ES: 'auth-navbar__lang-icon',
  Logout: 'auth-navbar__logout-icon'
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const tier of ['free', 'premium']) {
    for (const [width, height, mode] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
      const context = await browser.newContext({ viewport: { width, height } });
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
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(base).origin) return route.continue();
        if (url.hostname !== 'api.domdimabot.com') return route.abort();
        let data = {};
        if (url.pathname === '/auth/session') data = { twitch, app };
        else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: tier };
        else if (url.pathname === '/billing/credit-packs') data = {
          planTier: tier, hasActivePaidSubscription: tier !== 'free',
          rechargeExpiresAt: null, rechargeExpiryDays: null, offers: []
        };
        return route.fulfill({ status: 200, json: { error: false, status: 200, data } });
      });

      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/test/credits`);

      const itemSelector = mode === 'desktop'
        ? '.auth-navbar__dropdown .auth-navbar__dropdown-item'
        : '.auth-navbar__mobile-panel > section:last-of-type .auth-navbar__mobile-link';

      if (mode === 'desktop') {
        await page.locator('.auth-navbar__avatar-btn').click();
        await page.locator('.auth-navbar__dropdown').waitFor();
      } else {
        await page.locator('.auth-navbar__mobile-toggle').click();
        await page.locator('.auth-navbar__mobile-panel').waitFor();
      }
      await page.waitForTimeout(300);

      const items = await page.locator(itemSelector).evaluateAll((nodes) => nodes.map((node) => {
        const svg = node.querySelector('svg');
        const label = node.querySelector('span');
        const svgRect = svg ? svg.getBoundingClientRect() : null;
        const hostRect = svg?.parentElement?.getBoundingClientRect() ?? null;
        const labelRect = label ? label.getBoundingClientRect() : null;
        const firstPath = svg?.querySelector('path');
        return {
          text: (label?.textContent ?? node.textContent ?? '').trim(),
          hasSvg: Boolean(svg),
          svgClasses: svg ? [...svg.classList] : [],
          svgWidth: svgRect ? +svgRect.width.toFixed(2) : null,
          svgHeight: svgRect ? +svgRect.height.toFixed(2) : null,
          hostWidth: hostRect ? +hostRect.width.toFixed(2) : null,
          hostHeight: hostRect ? +hostRect.height.toFixed(2) : null,
          centerDeltaY: svgRect && hostRect
            ? Math.abs((hostRect.top + hostRect.height / 2) - (svgRect.top + svgRect.height / 2))
            : null,
          labelLeft: labelRect ? +labelRect.left.toFixed(2) : null,
          pathD: firstPath?.getAttribute('d') ?? null
        };
      }));

      assert.ok(items.length >= 5, `${tier}/${mode}: expected account menu items, saw ${items.length}`);

      for (const item of items) {
        assert.ok(item.hasSvg, `${tier}/${mode}: "${item.text}" must render an icon`);
        const expected = EXPECTED_ICON[item.text];
        assert.ok(expected, `${tier}/${mode}: unknown menu item "${item.text}"`);
        assert.ok(
          item.svgClasses.includes(expected),
          `${tier}/${mode}: "${item.text}" icon class ${JSON.stringify(item.svgClasses)} missing ${expected}`
        );
        assert.ok(item.svgWidth >= 17 && item.svgWidth <= 19.5, `${tier}/${mode}: "${item.text}" icon width ${item.svgWidth}`);
        assert.ok(Math.abs(item.svgWidth - item.hostWidth) < 0.5, `${tier}/${mode}: "${item.text}" icon overflows its host`);
        assert.ok(item.centerDeltaY !== null && item.centerDeltaY < 0.75, `${tier}/${mode}: "${item.text}" icon not vertically centered`);
      }

      const credits = items.find(item => item.text === 'Buy AI credits');
      const upgrade = items.find(item => item.text === 'Upgrade' || item.text === 'Upgrade to Pro');
      assert.ok(credits, `${tier}/${mode}: buy credits item present`);
      assert.ok(!credits.svgClasses.includes('auth-navbar__upgrade-icon'), `${tier}/${mode}: buy credits must not reuse the upgrade icon`);
      if (upgrade) {
        assert.notEqual(credits.pathD, upgrade.pathD, `${tier}/${mode}: buy credits and upgrade must use distinct glyphs`);
      }

      const labelLefts = items.map(item => item.labelLeft);
      const spread = Math.max(...labelLefts) - Math.min(...labelLefts);
      assert.ok(spread < 0.75, `${tier}/${mode}: menu labels misaligned by ${spread.toFixed(2)}px`);

      await page.screenshot({ path: `/tmp/navbar-dropdown-${tier}-${mode}.png` });
      assert.deepEqual(errors, [], `${tier}/${mode}: browser errors`);
      await context.close();
    }
  }
  console.log('PASS profile dropdown icons, distinct credit-pack glyph, label alignment, and mobile panel parity');
} finally {
  await browser.close();
}
