// Browser check for the "Gift credits" flow on the dimasite credit store.
// Every API call and the Polar checkout are mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = (process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217').replace(/\/$/, '');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/credit-gifts-site';
mkdirSync(shots, { recursive: true });

const POLAR = 'https://sandbox.polar.example';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const buyer = { id: '999991', login: 'test', display_name: 'Test Streamer' };
const offer = { id: 'gift-sample-1', name: 'Sample gift pack', credits: 40_000, rollover: true, priceAmount: 100, priceCurrency: 'usd' };
const luna = { id: '777001', login: 'luna_tv', displayName: 'Luna_TV', avatarUrl: null };
const giftRecipient = { id: luna.id, login: luna.login, displayName: luna.displayName };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

const until = async (fn, message, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

async function newContext(browser, { language = 'en', checkoutFailures = 0, giftSequences = {}, administrating = [], checkoutOffer = offer } = {}) {
  const context = await browser.newContext();
  const app = {
    name: buyer.display_name, email: 'test@example.invalid', language, plan_tier: 'free',
    actived: true, chat_enabled: true, twitch_user_id: buyer.id, has_permissions: true,
    up_to_date_permissions: true, administrating
  };
  await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'test-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch,
    appUser: app, permissions: {}
  })), { twitch: buyer, app });

  const state = { checkouts: [], lookups: [], giftPolls: {}, failuresLeft: checkoutFailures };
  const ok = (route, data) => route.fulfill({ status: 200, json: { error: false, status: 200, data } });
  const fail = (route, status, message) => route.fulfill({ status, json: { error: true, status, message } });

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.origin === POLAR) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Polar mock</title><h1>POLAR MOCK CHECKOUT</h1>' });
    }
    if (url.hostname === 'static-cdn.example') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    if (url.hostname !== 'api.domdimabot.com') return route.abort();

    const path = url.pathname;
    if (path === '/auth/session') return ok(route, { twitch: buyer, app });
    if (path.includes('/access')) return ok(route, { allowed: true, role: 'owner', planTier: 'free' });
    if (path === '/billing/credit-packs') {
      return ok(route, {
        planTier: 'free', hasActivePaidSubscription: false, rechargeExpiresAt: null, rechargeExpiryDays: null,
        offers: [{ id: 'own-sample', kind: 'credits', size: 'sample', credits: 40_000, rollover: true, priceAmount: 100, priceCurrency: 'usd', name: 'sample credits', eligible: true, eligibilityReason: null }]
      });
    }
    if (path === '/billing/gift-packs') return ok(route, { offers: [offer] });
    if (path === '/billing/gift-packs/recipient') {
      const login = url.searchParams.get('login');
      state.lookups.push(login);
      if (login === 'luna_tv') return ok(route, luna);
      if (login === 'nova') return ok(route, { id: '777002', login: 'nova', displayName: 'Nova', avatarUrl: 'https://static-cdn.example/nova.png' });
      if (login === 'boom') return fail(route, 500, 'Internal error');
      return fail(route, 404, 'Recipient not found');
    }
    if (path === '/billing/gift-packs/checkout' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.checkouts.push(body);
      if (state.failuresLeft > 0) {
        state.failuresLeft--;
        return fail(route, 503, 'Polar is busy, try again.');
      }
      return ok(route, {
        giftId: 'gift_123', checkoutId: 'co_123', checkoutUrl: `${POLAR}/checkout/co_123`,
        offer: checkoutOffer, recipient: luna
      });
    }
    const giftMatch = path.match(/^\/billing\/gift-packs\/([^/]+)$/);
    if (giftMatch) {
      const id = decodeURIComponent(giftMatch[1]);
      const sequence = giftSequences[id];
      if (!sequence) return fail(route, 404, 'Gift not found');
      const count = state.giftPolls[id] = (state.giftPolls[id] ?? 0) + 1;
      const status = sequence[Math.min(count - 1, sequence.length - 1)];
      return ok(route, {
        id, status, recipient: giftRecipient, credits: 40_000,
        paidAt: status === 'awaiting_payment' ? null : '2026-10-06T20:00:00.000Z',
        deliveredAt: status === 'delivered' ? '2026-10-06T20:00:05.000Z' : null
      });
    }
    // Usage, analytics and everything else: a failed envelope the page treats as optional.
    return fail(route, 404, 'not mocked');
  });
  return { context, state };
}

async function setTheme(page, theme) {
  await page.evaluate(name => {
    document.documentElement.classList.toggle('dark', name === 'dark');
    document.documentElement.setAttribute('data-theme', name);
  }, theme);
}

async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow: ${label}`);
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page })
    .include('app-credit-packs-page')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  assert.deepEqual(
    result.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) })),
    [],
    `accessibility: ${label}`
  );
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // 1 · Find recipient, confirm, retry after a failed checkout, redirect to Polar.
  {
    const { context, state } = await newContext(browser, { checkoutFailures: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/test/credits`);
    const gift = page.locator('app-credit-gift');
    await gift.getByRole('heading', { name: 'Gift credits to another channel' }).waitFor();
    await gift.getByText('40,000', { exact: false }).first().waitFor();
    const review = gift.getByRole('button', { name: /Review gift/ });
    assert.equal(await review.isDisabled(), true, 'review must wait for a recipient');

    // Header shortcut reveals the section and focuses the channel field.
    await page.getByRole('button', { name: /Buying for someone else\? Gift credits/ }).click();
    await until(() => page.evaluate(() => document.activeElement?.id === 'gift-login'), 'header link focuses channel field');

    const input = gift.locator('#gift-login');
    const find = gift.getByRole('button', { name: 'Find', exact: true });
    await input.fill('not a login!');
    await find.click();
    await gift.getByText("That doesn't look like a Twitch channel name", { exact: false }).waitFor();
    assert.equal(state.lookups.length, 0, 'invalid input must not call the API');

    await input.fill('@Test');
    await find.click();
    await gift.getByText("That's your own channel.", { exact: false }).waitFor();
    assert.equal(state.lookups.length, 0, 'self gift is caught before the API');

    await input.fill('ghost');
    await find.click();
    await gift.getByText('No DomDimaBot channel has that exact name', { exact: false }).waitFor();

    await input.fill('boom');
    await find.click();
    await gift.getByText("We couldn't look up that channel right now", { exact: false }).waitFor();

    await input.fill('https://www.twitch.tv/Luna_TV/videos');
    await find.click();
    await gift.locator('.gift__person').getByText('Luna_TV', { exact: true }).waitFor();
    assert.equal(state.lookups.at(-1), 'luna_tv', 'Twitch URL normalised to exact login');
    await gift.getByText('@luna_tv · Uses DomDimaBot').waitFor();
    assert.equal(await gift.locator('input[type=radio]').isChecked(), true, 'the only pack is selected');
    await until(async () => !(await review.isDisabled()), 'review enabled once recipient + pack chosen');
    assert.match(await review.innerText(), /Review gift · \$1/);

    await page.screenshot({ path: `${shots}/gift-form-390-light.png`, fullPage: true });

    // Confirmation: exact recipient, credits, price, buyer, refund + recipient terms.
    await review.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.waitFor();
    await until(() => page.evaluate(() => document.activeElement?.id === 'gift-dialog-title'), 'dialog title focused on open');
    assert.equal(await dialog.getByTestId('gift-confirm-recipient').innerText(), 'Luna_TV');
    await dialog.getByText('@luna_tv', { exact: true }).waitFor();
    assert.equal(await dialog.getByTestId('gift-confirm-credits').innerText(), '40,000 AI credits');
    assert.equal(await dialog.getByTestId('gift-confirm-price').innerText(), '$1.00 USD');
    await dialog.getByText('@test · named in the chat thank-you').waitFor();
    await dialog.getByText("Only Luna_TV can receive these credits. The recipient can't be changed after checkout.").waitFor();
    await dialog.getByText("Gifts aren't refunded automatically. You can ask support, but refund requests may be declined.").waitFor();
    await dialog.getByText('naming you (@test) in @luna_tv', { exact: false }).waitFor();
    const pay = dialog.getByTestId('gift-pay');
    assert.equal(await pay.isDisabled(), true, 'pay waits for the acknowledgement');
    assert.equal(await dialog.getByTestId('gift-ack').isChecked(), false, 'acknowledgement is never pre-checked');

    // Tab stays inside the dialog.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), true, 'focus trapped in dialog');

    // Escape closes and returns focus to the review button.
    await page.keyboard.press('Escape');
    await until(async () => (await dialog.count()) === 0, 'Escape closes dialog');
    await until(() => page.evaluate(() => document.activeElement?.classList.contains('gift__review')), 'focus returns to review button');

    await review.click();
    await dialog.waitFor();
    await dialog.getByTestId('gift-ack').check();
    await until(async () => !(await pay.isDisabled()), 'pay enabled after acknowledgement');
    await noOverflow(page, 'dialog 390');
    await page.screenshot({ path: `${shots}/gift-confirm-390-light.png` });
    await axe(page, 'confirm dialog 390 light');

    await pay.click();
    await dialog.getByText('Polar is busy, try again.').waitFor();
    assert.equal(await dialog.isVisible(), true, 'failed checkout keeps the dialog open');
    await until(async () => !(await pay.isDisabled()), 'pay re-enabled after failure');
    await pay.click();
    await page.waitForURL(`${POLAR}/checkout/co_123`);
    await page.getByText('POLAR MOCK CHECKOUT').waitFor();

    assert.equal(state.checkouts.length, 2);
    const [first, second] = state.checkouts;
    assert.match(first.requestId, UUID, 'requestId is a UUID');
    assert.equal(second.requestId, first.requestId, 'retrying the same intent reuses the requestId');
    assert.deepEqual(
      { productId: first.productId, recipientId: first.recipientId, acknowledgeNoRefunds: first.acknowledgeNoRefunds },
      { productId: offer.id, recipientId: luna.id, acknowledgeNoRefunds: true }
    );
    assert.equal(first.successUrl, `${base}/test/credits?gift=return`);
    assert.equal(first.returnUrl, `${base}/test/credits`);
    assert.deepEqual(errors, [], 'browser errors during checkout flow');
    await context.close();
  }

  // 2 · Changing the recipient creates a new requestId; mismatched checkout response never redirects.
  {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/test/credits`);
    const gift = page.locator('app-credit-gift');
    await gift.locator('#gift-login').fill('nova');
    await gift.getByRole('button', { name: 'Find', exact: true }).click();
    await gift.locator('.gift__person').getByText('Nova', { exact: true }).waitFor();
    await until(() => gift.locator('.gift__person img').evaluate(img => img.complete && img.naturalWidth > 0), 'recipient avatar renders');
    await gift.getByRole('button', { name: /Review gift/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await dialog.getByText('different details than you confirmed', { exact: false }).waitFor();
    assert.equal(page.url().startsWith(base), true, 'mismatched recipient must not redirect');
    await page.keyboard.press('Escape');
    await gift.getByRole('button', { name: 'Change' }).click();
    await gift.locator('#gift-login').fill('luna_tv');
    await gift.getByRole('button', { name: 'Find', exact: true }).click();
    await gift.locator('.gift__person').getByText('Luna_TV', { exact: true }).waitFor();
    await gift.getByRole('button', { name: /Review gift/ }).click();
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await page.waitForURL(`${POLAR}/checkout/co_123`);
    assert.equal(state.checkouts.length, 2);
    assert.notEqual(state.checkouts[1].requestId, state.checkouts[0].requestId, 'new recipient means new requestId');
    await context.close();
  }

  // A provider price, currency, or grant change cannot bypass the reviewed offer.
  for (const changed of [{ priceAmount: 200 }, { priceCurrency: 'eur' }, { credits: 80_000 }, { rollover: false }]) {
    const { context } = await newContext(browser, { checkoutOffer: { ...offer, ...changed } });
    const page = await context.newPage();
    await page.goto(`${base}/test/credits`);
    const gift = page.locator('app-credit-gift');
    await gift.locator('#gift-login').fill('luna_tv');
    await gift.getByRole('button', { name: 'Find', exact: true }).click();
    await gift.locator('.gift__person').getByText('Luna_TV', { exact: true }).waitFor();
    await gift.getByRole('button', { name: /Review gift/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await dialog.getByText('different details than you confirmed', { exact: false }).waitFor();
    assert.equal(page.url().startsWith(base), true, `changed offer must not redirect: ${JSON.stringify(changed)}`);
    await context.close();
  }

  // 3 · Return page: pending first, delivered only when the server says so.
  {
    const { context, state } = await newContext(browser, {
      giftSequences: { gift_123: ['awaiting_payment', 'delivering', 'delivered'] }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/test/credits?gift=return&gift_id=gift_123&checkout_id=co_123`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Waiting for payment confirmation' }).waitFor();
    assert.equal(await status.getByText('Gift delivered').count(), 0, 'redirect alone never claims delivery');
    await page.screenshot({ path: `${shots}/gift-return-pending-390-light.png` });
    await status.getByRole('heading', { name: 'Payment received, delivering your gift' }).waitFor({ timeout: 6000 });
    await status.getByText("Adding 40,000 credits to Luna_TV's balance.").waitFor();
    await status.getByRole('heading', { name: 'Gift delivered' }).waitFor({ timeout: 8000 });
    await status.getByText('Luna_TV (@luna_tv) now has 40,000 more permanent credits.').waitFor();
    await status.getByText('naming you (@test) in @luna_tv', { exact: false }).waitFor();
    const polls = state.giftPolls.gift_123;
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(state.giftPolls.gift_123, polls, 'polling stops once delivered');
    await setTheme(page, 'dark');
    await page.screenshot({ path: `${shots}/gift-return-delivered-390-dark.png` });
    await axe(page, 'delivered banner 390 dark');
    await status.getByRole('button', { name: 'Dismiss gift status' }).click();
    await until(async () => !page.url().includes('gift='), 'dismiss clears gift params');
    assert.deepEqual(errors, [], 'browser errors on return page');
    await context.close();
  }

  // 4 · needs_support shows the reference and support link; unknown gift is not leaked.
  {
    const { context } = await newContext(browser, { giftSequences: { gift_sup: ['needs_support'] } });
    const page = await context.newPage();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${base}/test/credits?gift=return&gift_id=gift_sup`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Your gift needs help from support' }).waitFor();
    await status.getByText('Your payment went through', { exact: false }).waitFor();
    await status.getByText('gift_sup', { exact: true }).waitFor();
    assert.equal(await status.getByRole('link', { name: 'Contact support' }).getAttribute('href'), 'https://discord.gg/HdubYrkPXt');
    await noOverflow(page, 'support banner 320');
    await page.screenshot({ path: `${shots}/gift-return-support-320-light.png` });
    await axe(page, 'support banner 320');

    await page.goto(`${base}/test/credits?gift=return&gift_id=someone_elses`);
    await status.getByRole('heading', { name: "We can't show this gift" }).waitFor();
    await context.close();
  }

  // 5 · Bounded polling: after the schedule runs out, offer "Check again" instead of polling forever.
  {
    const { context, state } = await newContext(browser, { giftSequences: { gift_slow: ['awaiting_payment'] } });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${base}/test/credits?gift=return&gift_id=gift_slow`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Waiting for payment confirmation' }).waitFor();
    for (let i = 0; i < 12; i++) {
      await page.clock.runFor(31_000);
      await page.waitForTimeout(50);
    }
    await status.getByRole('button', { name: 'Check again' }).waitFor();
    await status.getByText('Still no confirmation from Polar', { exact: false }).waitFor();
    const polls = state.giftPolls.gift_slow;
    assert.ok(polls <= 10, `poll count bounded (${polls})`);
    await page.clock.runFor(120_000);
    await page.waitForTimeout(100);
    assert.equal(state.giftPolls.gift_slow, polls, 'no polling after the schedule ends');
    await context.close();
  }

  // 6 · Admin viewing another channel: suggestion prefilled, never auto-looked-up. Navbar link present.
  {
    const { context, state } = await newContext(browser, { administrating: [{ channelID: luna.id, channelName: luna.login }] });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/luna_tv/credits`);
    const gift = page.locator('app-credit-gift');
    await until(async () => (await gift.locator('#gift-login').inputValue()) === 'luna_tv', 'managed channel prefilled');
    assert.equal(state.lookups.length, 0, 'prefill must not auto-search');
    await page.getByRole('button', { name: 'Gift credits to @luna_tv instead' }).waitFor();
    await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn')?.click());
    const navLink = page.getByRole('menuitem', { name: 'Gift credits' });
    await navLink.waitFor();
    assert.equal(await navLink.getAttribute('href'), '/test/credits#gift', 'navbar Gift credits link targets own store');
    await navLink.click();
    await page.waitForURL(`${base}/test/credits#gift`);
    await until(() => page.evaluate(() => document.activeElement?.id === 'gift-login'), 'navbar link focuses the gift channel field');
    await context.close();
  }

  // 7 · Spanish copy + layouts in both themes with the dialog open.
  {
    const { context } = await newContext(browser, { language: 'es' });
    const page = await context.newPage();
    await page.goto(`${base}/test/credits`);
    const gift = page.locator('app-credit-gift');
    await gift.getByRole('heading', { name: 'Regala créditos a otro canal' }).waitFor();
    await gift.locator('#gift-login').fill('luna_tv');
    await gift.getByRole('button', { name: 'Buscar', exact: true }).click();
    await gift.locator('.gift__person').waitFor();
    for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'dark'], [1280, 900, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await setTheme(page, theme);
      await noOverflow(page, `es form ${width} ${theme}`);
      await gift.screenshot({ path: `${shots}/gift-form-es-${width}-${theme}.png` });
      await axe(page, `es form ${width} ${theme}`);
      await gift.getByRole('button', { name: /Revisar regalo/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirma tu regalo' });
      await dialog.waitFor();
      assert.equal(await dialog.getByTestId('gift-confirm-credits').innerText(), '40.000 créditos de IA');
      assert.match(await dialog.getByTestId('gift-confirm-price').innerText(), /^1,00\s\$\sUSD$/, 'es price shows the currency once');
      await noOverflow(page, `es dialog ${width} ${theme}`);
      await page.screenshot({ path: `${shots}/gift-confirm-es-${width}-${theme}.png` });
      await axe(page, `es dialog ${width} ${theme}`);
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await until(async () => (await dialog.count()) === 0, 'cancel closes dialog');
    }
    const text = await page.locator('body').innerText();
    assert.equal(text.includes('Paid Sample Gift Credit Pack'), false, 'fulfillment product name never shown');
    await context.close();
  }

  console.log(`PASS gift credits: lookup normalisation + errors, self-gift block, exact confirmation (recipient, credits, price, buyer, no-refund + fixed-recipient ack), focus trap/Escape, idempotent requestId retries, mismatch guard, Polar redirect, bounded return polling (pending → delivering → delivered, support, forbidden, stalled), admin prefill, navbar link, es copy, 320/390/1280 dark+light, axe. Screenshots: ${shots}`);
} finally {
  await browser.close();
}
