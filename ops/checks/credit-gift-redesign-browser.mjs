// Browser check for the redesigned credit store purchase modes ("For me" / "Gift someone").
// Every API call, avatar and the hosted checkout page are mocked in-browser; any other
// remote request is aborted and reported. Nothing reaches production or a payment provider.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = (process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4245').replace(/\/$/, '');
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/credit-gift-redesign';
mkdirSync(shots, { recursive: true });

const POLAR = 'https://sandbox.polar.example';
const API = 'api.domdimabot.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const buyer = { id: '999991', login: 'test', display_name: 'Test Streamer' };
// Same shape and amounts as the live catalog; served out of price order on purpose.
const offers = [
  { id: 'gift-10', name: 'Sample gift pack', credits: 550_000, rollover: true, priceAmount: 1000, priceCurrency: 'usd' },
  { id: 'gift-1', name: 'Sample gift pack', credits: 40_000, rollover: true, priceAmount: 100, priceCurrency: 'usd' },
  { id: 'gift-5', name: 'Sample gift pack', credits: 250_000, rollover: true, priceAmount: 500, priceCurrency: 'usd' }
];
const byId = Object.fromEntries(offers.map(offer => [offer.id, offer]));
const luna = { id: '64f000000000000000000001', login: 'luna_tv', displayName: 'Luna_TV', avatarUrl: null };
const lunar = { id: '64f000000000000000000004', login: 'lunar', displayName: 'Lunar', avatarUrl: null };
const nova = { id: '64f000000000000000000002', login: 'nova', displayName: 'Nova', avatarUrl: 'https://static-cdn.example/nova.svg' };
const slow = { id: '64f000000000000000000003', login: 'slowpoke', displayName: 'Slowpoke', avatarUrl: null };
const GIFT_ID = 'a'.repeat(56) + 'b1c2d3e4';
const avatarSvg = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue},70%,55%)"/><circle cx="48" cy="38" r="18" fill="#fff" opacity=".9"/><rect x="18" y="62" width="60" height="34" rx="17" fill="#fff" opacity=".9"/></svg>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, message, timeout = 8000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await sleep(80);
  }
};

async function newContext(browser, options = {}) {
  const {
    language = 'en', administrating = [], checkoutFailures = [], checkoutDelayMs = 0,
    checkoutRecipient = null, checkoutOffer = null, giftSequences = {}, giftCatalogDown = false,
    giftOffers = offers, recipientViewer = false,
    viewport = { width: 390, height: 844 }
  } = options;
  const context = await browser.newContext({ viewport });
  await context.routeWebSocket('**/*', socket => socket.close({ code: 1000, reason: 'Isolated gift UI check' }));
  const twitch = recipientViewer ? { id: '777001', login: luna.login, display_name: luna.displayName } : buyer;
  const app = {
    name: twitch.display_name, email: 'test@example.invalid', language, plan_tier: 'free',
    actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
    up_to_date_permissions: true, administrating
  };
  await context.addInitScript(({ twitch, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'test-only', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch,
    appUser: app, permissions: {}
  })), { twitch, app });

  const state = {
    checkouts: [], ownCheckouts: [], lookups: [], searches: [], profiles: [], giftPolls: {}, blocked: [], polarVisits: [],
    failures: [...checkoutFailures], catalogDown: giftCatalogDown, catalogRequests: 0
  };
  const ok = (route, data, status = 200) => route.fulfill({ status, json: { error: false, status, data } });
  const fail = (route, status, message) => route.fulfill({ status, json: { error: true, status, message } });

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.origin === POLAR) {
      state.polarVisits.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Checkout mock</title><h1>MOCK HOSTED CHECKOUT</h1>' });
    }
    if (url.hostname === 'static-cdn.example') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: avatarSvg(url.pathname.includes('nova') ? 200 : 300) });
    }
    if (url.hostname !== API) {
      state.blocked.push(url.origin);
      return route.abort();
    }

    const path = url.pathname;
    if (path === '/auth/session') return ok(route, { twitch, app });
    if (path.includes('/access')) return ok(route, { allowed: true, role: 'owner', planTier: 'free' });
    if (path === '/users') {
      const login = url.searchParams.get('username');
      state.profiles.push(login);
      return ok(route, { id: '1', username: login, display_name: login, profile_image_url: `https://static-cdn.example/${login}.svg` });
    }
    if (path === '/billing/credit-packs') {
      return ok(route, {
        planTier: 'free', hasActivePaidSubscription: false, rechargeExpiresAt: null, rechargeExpiryDays: null,
        offers: [
          { id: 'own-1', kind: 'credits', size: 'sample', credits: 40_000, rollover: true, priceAmount: 100, priceCurrency: 'usd', name: 'x', eligible: true, eligibilityReason: null },
          { id: 'own-5', kind: 'credits', size: 'small', credits: 220_000, rollover: true, priceAmount: 500, priceCurrency: 'usd', name: 'x', eligible: true, eligibilityReason: null }
        ]
      });
    }
    if (path === '/billing/credit-packs/checkout' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.ownCheckouts.push(body);
      return ok(route, { checkoutId: 'own_co', checkoutUrl: `${POLAR}/checkout/own_co`, offer: {} }, 201);
    }
    if (path === '/billing/gift-packs') {
      state.catalogRequests++;
      if (state.catalogDown) return fail(route, 502, 'Gifting is temporarily unavailable.');
      return ok(route, { offers: giftOffers });
    }
    if (path === '/billing/gift-packs/recipients') {
      const query = url.searchParams.get('query');
      state.searches.push(query);
      if (query === 'slow') {
        await sleep(1500);
        return ok(route, [slow]);
      }
      if (query === 'boom') return fail(route, 502, 'Unavailable');
      return ok(route, [luna, lunar, nova].filter(person => person.login.includes(query)));
    }
    if (path === '/billing/gift-packs/recipient') {
      const login = url.searchParams.get('login');
      state.lookups.push(login);
      if (login === 'luna_tv') return ok(route, luna);
      if (login === 'nova') return ok(route, nova);
      if (login === 'slowpoke') {
        await sleep(1500);
        return ok(route, slow);
      }
      if (login === 'boom') return fail(route, 500, 'Internal error');
      return fail(route, 404, 'This channel does not have a bot account');
    }
    if (path === '/billing/gift-packs/checkout' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.checkouts.push(body);
      if (checkoutDelayMs) await sleep(checkoutDelayMs);
      const failure = state.failures.shift();
      if (failure) return fail(route, failure, 'Polar is busy, raw provider text that must not be shown.');
      const recipient = checkoutRecipient ?? (body.recipientId === nova.id ? nova : luna);
      const offer = { ...byId[body.productId], ...(checkoutOffer ?? {}) };
      return ok(route, { giftId: GIFT_ID, checkoutId: 'co_123', checkoutUrl: `${POLAR}/checkout/co_123`, offer, recipient }, 201);
    }
    const giftMatch = path.match(/^\/billing\/gift-packs\/([^/]+)$/);
    if (giftMatch) {
      const id = decodeURIComponent(giftMatch[1]);
      const sequence = giftSequences[id];
      if (!sequence) return fail(route, 404, 'Gift not found');
      const count = state.giftPolls[id] = (state.giftPolls[id] ?? 0) + 1;
      const status = sequence[Math.min(count - 1, sequence.length - 1)];
      return ok(route, {
        id, status, recipient: { id: luna.id, login: luna.login, displayName: luna.displayName }, credits: 250_000,
        paidAt: status === 'awaiting_payment' ? null : '2026-10-06T20:00:00.000Z',
        deliveredAt: status === 'delivered' ? '2026-10-06T20:00:05.000Z' : null
      });
    }
    return fail(route, 404, 'not mocked');
  });
  return { context, state };
}

async function setTheme(page, theme) {
  await page.evaluate(name => {
    document.documentElement.classList.toggle('dark', name === 'dark');
    document.documentElement.setAttribute('data-theme', name);
  }, theme);
  await page.waitForTimeout(250); // let colour transitions settle before screenshots/axe
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

// Full-page captures from the top, so the sticky navbar/summary sit where a visitor sees them.
async function fullShot(page, path) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

const focusedId = page => page.evaluate(() => document.activeElement?.id ?? '');
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) });

async function findRecipient(gift, login, label = 'Find') {
  await gift.locator('#gift-login').fill(login);
  await gift.getByRole('button', { name: label, exact: true }).click();
}

async function openGift(page, path = '/test/credits#gift') {
  await page.goto(`${base}${path}`);
  const gift = page.locator('app-credit-gift');
  await gift.locator('[data-testid=gift-pack]').first().waitFor();
  return gift;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
const blockedOrigins = [];
const pass = name => { results.push(name); console.log(`ok - ${name}`); };
try {
  // Gift recipient autocomplete uses the existing store styling and requires an explicit selection.
  {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    const gift = await openGift(page);
    await setTheme(page, 'light');
    const input = gift.locator('#gift-login');
    const option = gift.getByRole('option', { name: '@luna_tv', exact: true });
    await input.fill('lu');
    await sleep(450);
    assert.deepEqual(state.searches, [], 'short queries never search');
    await input.fill('l');
    await input.fill('lun');
    await option.waitFor();
    assert.equal(await gift.getByRole('option').count(), 2, 'partial query returns possible channels');
    assert.deepEqual(state.searches, ['lun'], 'typing is debounced');
    assert.equal(await gift.getByTestId('gift-review').isDisabled(), true, 'search does not confirm a recipient');
    assert.equal(await input.inputValue(), 'lun');
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    await axe(page, 'gift suggestions 390 light');
    await noOverflow(page, 'gift suggestions 390 light');
    await fullShot(page, `${shots}/gift-search-390-light.png`);

    await input.press('ArrowDown');
    await until(async () => (await option.getAttribute('aria-selected')) === 'true', 'ArrowDown selects a match');
    await input.press('ArrowUp');
    await until(async () => (await gift.getByRole('option', { name: '@lunar', exact: true }).getAttribute('aria-selected')) === 'true', 'ArrowUp wraps to the last match');
    await input.press('ArrowDown');
    await until(async () => (await option.getAttribute('aria-selected')) === 'true', 'ArrowDown wraps to the first match');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'gift-match-0');
    await input.press('Enter');
    await gift.locator('.gwho__name').getByText('Luna_TV', { exact: true }).waitFor();
    assert.deepEqual(state.lookups, ['luna_tv'], 'selection revalidates the full name');
    await gift.getByRole('button', { name: 'Change', exact: true }).click();

    await input.fill('slow');
    await until(() => state.searches.includes('slow'), 'slow search starts');
    await input.fill('@LUN');
    await option.waitFor();
    await sleep(1600);
    assert.equal(await gift.getByRole('option', { name: '@slowpoke' }).count(), 0, 'stale response ignored');
    await input.press('Escape');
    await until(async () => (await gift.getByRole('option').count()) === 0, 'Escape dismisses suggestions');

    await input.fill('zzz');
    await gift.getByText('No matching DomDimaBot channels.', { exact: false }).waitFor();
    await input.fill('boom');
    await gift.getByText("We couldn't look up that channel right now.").waitFor();
    await gift.getByRole('button', { name: 'Try again', exact: true }).click();
    await until(() => state.searches.filter(query => query === 'boom').length === 2, 'retry repeats search');
    await input.fill('slow');
    await until(() => state.searches.filter(query => query === 'slow').length === 2, 'second slow search starts');
    await input.fill('lu');
    await sleep(1600);
    assert.equal(await gift.getByRole('option').count(), 0, 'shortening the query ignores an outstanding response');

    await page.setViewportSize({ width: 1280, height: 900 });
    await setTheme(page, 'dark');
    await input.fill('lun');
    await option.waitFor();
    await axe(page, 'gift suggestions 1280 dark');
    await noOverflow(page, 'gift suggestions 1280 dark');
    await fullShot(page, `${shots}/gift-search-1280-dark.png`);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme);
        await axe(page, `gift suggestions ${width} ${theme}`);
        await noOverflow(page, `gift suggestions ${width} ${theme}`);
      }
    }
    await option.click();
    await gift.locator('.gwho__name').getByText('Luna_TV', { exact: true }).waitFor();
    assert.equal(state.checkouts.length, 0, 'autocomplete never purchases a gift');
    await context.close();
    pass('gift recipient autocomplete: minimum, debounce, keyboard/click selection, stale responses, empty/error/retry, existing styles');
  }

  if (process.env.SAAS_GIFT_SEARCH_ONLY !== '1') {
  // 1 · Purchase mode tabs near the header; legacy own store stays the default and keeps working.
  {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/test/credits`);
    const store = page.locator('app-credit-packs-page');
    await store.getByRole('heading', { level: 1, name: 'Credit Store' }).waitFor();
    assert.equal(await tab(page, 'For me').getAttribute('aria-selected'), 'true');
    await tab(page, 'For me').getByText('Credits for @test').waitFor();
    await tab(page, 'Gift someone').getByText('Send credits to a streamer').waitFor();
    assert.equal(await page.locator('#purchase-panel-gift').isHidden(), true, 'gift panel hidden in For me mode');
    assert.equal(await store.getByText('Credits go to @test').count(), 0, 'tab hint already names the account; no duplicate note');
    assert.equal(await store.locator('.lf-pack').count(), 2, 'own packs render');

    // Own purchase still goes straight to checkout for the signed-in account.
    await store.getByRole('button', { name: /Buy for \$1/ }).click();
    await page.waitForURL(`${POLAR}/checkout/own_co`);
    assert.deepEqual(state.ownCheckouts.map(body => body.productId), ['own-1']);
    assert.equal(state.checkouts.length, 0, 'own purchase never touches gift checkout');

    await page.goto(`${base}/test/credits?credits=success`);
    await store.getByText('Payment received', { exact: false }).or(store.locator('.lf-banner--ok')).first().waitFor();
    assert.equal(await tab(page, 'For me').getAttribute('aria-selected'), 'true', 'own success return stays on For me');

    // Tabs: click, then arrow keys; URL mirrors the mode, focus stays on the tab.
    await tab(page, 'Gift someone').click();
    await store.getByRole('heading', { level: 1, name: 'Gift AI credits' }).waitFor();
    await until(() => page.url().endsWith('#gift'), 'gift tab writes #gift');
    assert.equal(await focusedId(page), 'purchase-tab-gift', 'tab click keeps focus on the tab');
    assert.equal(await page.locator('#purchase-panel-self').isHidden(), true);
    await page.keyboard.press('ArrowLeft');
    await until(async () => (await tab(page, 'For me').getAttribute('aria-selected')) === 'true', 'ArrowLeft selects For me');
    assert.equal(await focusedId(page), 'purchase-tab-self');
    await until(() => !page.url().includes('#gift'), 'For me clears #gift');
    await page.keyboard.press('End');
    await until(async () => (await tab(page, 'Gift someone').getAttribute('aria-selected')) === 'true', 'End selects Gift someone');
    assert.equal(await tab(page, 'For me').getAttribute('tabindex'), '-1', 'roving tabindex');
    assert.deepEqual(errors, [], 'browser errors on store');
    await context.close();
    pass('mode tabs + legacy own store checkout + own success return');
  }

  // 2 · Gift browsing: packs from the API, sorted, labelled by quantity, honest maths, no default.
  {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const gift = await openGift(page);
    await until(async () => (await focusedId(page)) === 'gift-login', '#gift deep link focuses the channel field');
    assert.equal(await tab(page, 'Gift someone').getAttribute('aria-selected'), 'true', '#gift opens the gift side');

    const packs = gift.locator('[data-testid=gift-pack]');
    assert.equal(await packs.count(), 3);
    const texts = await packs.allInnerTexts();
    assert.match(texts[0], /40,000[\s\S]*\$1(?!\d)/);
    assert.match(texts[1], /250,000[\s\S]*\$5/);
    assert.match(texts[2], /550,000[\s\S]*\$10/);
    assert.match(texts[0], /40,000 credits per \$1/);
    assert.match(texts[1], /50,000 credits per \$1/);
    assert.match(texts[2], /55,000 credits per \$1/);
    assert.equal(/% more/.test(texts[0]), false, 'smallest pack makes no value claim');
    assert.match(texts[1], /\+25% more per \$1/);
    assert.match(texts[2], /\+37% more per \$1/, 'derived (floored) from 55k vs 40k per $1');
    const giftText = await gift.innerText();
    for (const banned of [/sample/i, /best value/i, /popular/i, /only \d+ left/i, /% off/i, /save \$/i]) {
      assert.equal(banned.test(giftText), false, `no internal names or invented badges: ${banned}`);
    }
    assert.equal(await gift.locator('input[type=radio]:checked').count(), 0, 'no pack pre-selected');
    const review = gift.getByTestId('gift-review');
    assert.equal(await review.isDisabled(), true);
    await gift.getByText("Choose who it's for and pick a gift.").waitFor();

    // Keyboard choice: arrows move between the radio cards.
    await gift.locator('input[value="gift-1"]').focus();
    await page.keyboard.press('ArrowDown');
    await until(() => gift.locator('input[value="gift-5"]').isChecked(), 'ArrowDown selects $5 pack');
    await until(() => packs.nth(1).evaluate(el => el.classList.contains('gpack--on')), 'selected style on $5 tile');
    await gift.getByText("250,000 AI credits picked. Now choose who it's for.").waitFor();
    await packs.nth(2).click();
    await until(() => gift.locator('input[value="gift-10"]').isChecked(), 'click selects $10 pack');

    // Recipient lookups.
    const find = gift.getByRole('button', { name: 'Find', exact: true });
    await findRecipient(gift, 'not a login!');
    await gift.getByText("That doesn't look like a Twitch channel name", { exact: false }).waitFor();
    assert.equal(await gift.locator('#gift-login').getAttribute('aria-invalid'), 'true');
    await findRecipient(gift, '@Test');
    await gift.getByText("That's your own channel.", { exact: false }).waitFor();
    assert.equal(state.lookups.length, 0, 'invalid + self never call the API');
    await gift.getByRole('button', { name: 'Buy credits for me instead' }).click();
    await until(async () => (await tab(page, 'For me').getAttribute('aria-selected')) === 'true', 'self → For me');
    await until(async () => (await focusedId(page)) === 'purchase-tab-self', 'focus on For me tab');
    await tab(page, 'Gift someone').click();
    assert.equal(await gift.locator('input[value="gift-10"]').isChecked(), true, 'gift draft survives a mode switch');

    await findRecipient(gift, 'ghost');
    await gift.getByText('No DomDimaBot channel has that exact name', { exact: false }).waitFor();
    await findRecipient(gift, 'boom');
    await gift.getByText("We couldn't look up that channel right now.").waitFor();
    const before = state.lookups.length;
    await gift.getByRole('button', { name: 'Try again' }).click();
    await until(() => state.lookups.length === before + 1, 'Try again re-runs the lookup');

    // Stale response: a slow lookup answered after the buyer moved on must be ignored.
    await findRecipient(gift, 'slowpoke');
    await gift.getByRole('button', { name: /Finding/ }).waitFor();
    await gift.locator('#gift-login').fill('luna_tv');
    await find.click();
    await gift.locator('.gwho').getByText('Luna_TV', { exact: true }).waitFor();
    await sleep(1800);
    assert.equal(await gift.locator('.gwho__name').innerText(), 'Luna_TV', 'late slowpoke answer ignored');
    assert.equal(state.lookups.at(-1), 'luna_tv');

    // Real avatar from the Twitch profile lookup (recipient API has none).
    await until(() => gift.locator('.gwho img').evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'recipient avatar loads');
    assert.deepEqual(state.profiles, ['luna_tv']);
    await gift.getByText('Luna_TV gets 550,000 permanent AI credits from you.').waitFor();
    await until(async () => !(await review.isDisabled()), 'review enabled');
    assert.match(await review.innerText(), /Review gift · \$10/);
    await noOverflow(page, 'gift ready 390');
    await fullShot(page, `${shots}/after-gift-ready-390-light.png`);
    await axe(page, 'gift ready 390 light');
    // Everything off-preview is aborted; billing must only ever go through the mocked API host.
    assert.equal(state.blocked.some(origin => /polar|stripe|checkout/i.test(origin)), false, 'no real payment host contacted');
    blockedOrigins.push(...state.blocked);
    assert.deepEqual(errors, [], 'browser errors during gift browsing');
    await context.close();
    pass('gift packs (sorted, quantity labels, derived rates, no default) + lookups (invalid/self/not_found/error+retry/stale) + avatar');
  }

  // 3 · Confirmation sheet, acknowledgement, idempotent retry and submit lock ($10 pack).
  {
    const { context, state } = await newContext(browser, { checkoutFailures: [503], checkoutDelayMs: 700 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const gift = await openGift(page);
    await gift.locator('[data-testid=gift-pack]').nth(2).click();
    await findRecipient(gift, 'https://www.twitch.tv/Luna_TV/videos');
    await gift.locator('.gwho').waitFor();
    assert.equal(state.lookups.at(-1), 'luna_tv', 'Twitch link normalised');
    const review = gift.getByTestId('gift-review');
    await review.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.waitFor();
    await until(async () => (await focusedId(page)) === 'gift-dialog-title', 'dialog title focused');
    assert.equal(await dialog.getByTestId('gift-confirm-recipient').innerText(), 'Luna_TV');
    await dialog.getByText('@luna_tv · Uses DomDimaBot').waitFor();
    assert.equal(await dialog.getByTestId('gift-confirm-credits').innerText(), '550,000 AI credits');
    assert.equal(await dialog.getByTestId('gift-confirm-price').innerText(), '$10.00 USD');
    await dialog.getByText('Any tax is added at checkout', { exact: false }).waitFor();
    assert.equal(await dialog.getByTestId('gift-confirm-buyer').innerText(), 'Test Streamer');
    await dialog.getByText('@test · named in the public thank-you').waitFor();
    await dialog.getByText("Gifts aren't refunded automatically.", { exact: false }).waitFor();
    await dialog.getByText('refund requests may be declined', { exact: false }).waitFor();
    await dialog.getByText("public thank-you from you (@test) in @luna_tv's Twitch chat", { exact: false }).waitFor();
    const ack = dialog.getByTestId('gift-ack');
    const pay = dialog.getByTestId('gift-pay');
    assert.equal(await ack.isChecked(), false, 'acknowledgement never pre-checked');
    assert.equal(await pay.isDisabled(), true, 'pay waits for acknowledgement');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), true, 'Shift+Tab from initial title stays inside');
    await dialog.locator('#gift-dialog-title').focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), true, 'focus trapped');
    await page.keyboard.press('Escape');
    await until(async () => (await dialog.count()) === 0, 'Escape closes');
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'gift-review'), 'focus back on review');

    await review.click();
    await dialog.waitFor();
    assert.equal(await ack.isChecked(), false, 'reopening resets the acknowledgement');
    await ack.check();
    await until(async () => !(await pay.isDisabled()), 'pay enabled after acknowledgement');
    // Every confirmation row must be laid out inside the ticket, never clipped away.
    const clipped = await dialog.locator('.gticket').evaluate(ticket => {
      const box = ticket.getBoundingClientRect();
      return [...ticket.querySelectorAll('dd')].filter(dd => {
        const rect = dd.getBoundingClientRect();
        return rect.height === 0 || rect.bottom > box.bottom + 1;
      }).length;
    });
    assert.equal(clipped, 0, 'no clipped confirmation rows');
    await noOverflow(page, 'confirm 390');
    await page.screenshot({ path: `${shots}/after-confirm-390-light.png` });
    await axe(page, 'confirm 390 light');

    await pay.click();
    await dialog.getByRole('button', { name: 'Opening checkout…' }).waitFor();
    assert.equal(await ack.isDisabled(), true, 'ack locked while submitting');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), true, 'focus stays inside while all controls are disabled');
    await dialog.getByTestId('gift-pay-error').waitFor();
    const errorText = await dialog.getByTestId('gift-pay-error').innerText();
    assert.match(errorText, /Checkout couldn't open\. Please try again with the same gift details\./);
    assert.equal(errorText.includes('Nothing was charged'), false, 'no unverified account-history claim');
    assert.equal(errorText.includes('Polar is busy'), false, 'raw server text never shown');
    await page.screenshot({ path: `${shots}/after-confirm-error-390-light.png` });

    // Double-click while the retry is in flight: exactly one more request.
    await pay.dblclick();
    await page.waitForURL(`${POLAR}/checkout/co_123`);
    assert.equal(state.checkouts.length, 2, 'submit locked: one request per attempt');
    const [first, second] = state.checkouts;
    assert.match(first.requestId, UUID);
    assert.equal(second.requestId, first.requestId, 'retry reuses requestId');
    assert.deepEqual(
      { productId: first.productId, recipientId: first.recipientId, acknowledgeNoRefunds: first.acknowledgeNoRefunds },
      { productId: 'gift-10', recipientId: luna.id, acknowledgeNoRefunds: true }
    );
    assert.equal(first.successUrl, `${base}/test/credits?gift=return`);
    assert.equal(first.returnUrl, `${base}/test/credits`);
    assert.deepEqual(state.polarVisits, ['/checkout/co_123'], 'hosted checkout intercepted (mock page)');
    assert.deepEqual(errors, []);
    await context.close();
    pass('confirm sheet ($10): recipient/credits/price+tax/buyer/refund/public announcement, ack unchecked, focus trap, retry same requestId, submit lock');
  }

  // 4 · $5 pack with nova; mismatch never redirects; changing recipient re-confirms with a new requestId.
  {
    const { context, state } = await newContext(browser, { viewport: { width: 1280, height: 900 }, checkoutRecipient: luna });
    const page = await context.newPage();
    const gift = await openGift(page);
    await gift.locator('[data-testid=gift-pack]').nth(1).click();
    await findRecipient(gift, 'nova');
    await gift.locator('.gwho').getByText('Nova', { exact: true }).waitFor();
    await until(() => gift.locator('.gwho img').evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false), 'provided avatar loads');
    assert.deepEqual(state.profiles, [], 'API avatar used without an extra profile lookup');
    await gift.getByText('Nova gets 250,000 permanent AI credits from you.').waitFor();
    await fullShot(page, `${shots}/after-gift-ready-1280-light.png`);
    await axe(page, 'gift ready 1280 light');
    await gift.getByTestId('gift-review').click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    assert.equal(await dialog.getByTestId('gift-confirm-credits').innerText(), '250,000 AI credits');
    assert.equal(await dialog.getByTestId('gift-confirm-price').innerText(), '$5.00 USD');
    await page.screenshot({ path: `${shots}/after-confirm-1280-light.png` });
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await dialog.getByText('different details from your confirmation', { exact: false }).waitFor();
    assert.equal(page.url().startsWith(base), true, 'mismatch never redirects');
    await dialog.getByRole('button', { name: 'Back' }).click();
    await gift.getByRole('button', { name: 'Change' }).click();
    await until(async () => (await focusedId(page)) === 'gift-login', 'Change focuses the field');
    assert.equal(await gift.getByTestId('gift-review').isDisabled(), true, 'review needs the recipient again');
    await findRecipient(gift, 'luna_tv');
    await gift.locator('.gwho').getByText('Luna_TV', { exact: true }).waitFor();
    await gift.getByTestId('gift-review').click();
    assert.equal(await dialog.getByTestId('gift-confirm-recipient').innerText(), 'Luna_TV', 'review shows the new recipient');
    assert.equal(await dialog.getByTestId('gift-ack').isChecked(), false, 'new recipient needs a fresh acknowledgement');
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await page.waitForURL(`${POLAR}/checkout/co_123`);
    assert.equal(state.checkouts.length, 2);
    assert.notEqual(state.checkouts[1].requestId, state.checkouts[0].requestId, 'new recipient → new requestId');
    assert.equal(state.checkouts[1].productId, 'gift-5');
    await context.close();
    pass('$5 pack, provided avatar, mismatch guard, change recipient → reconfirm + new requestId');
  }

  // 5 · Changed price/currency/credits/rollover never redirect; API errors are localized and plain.
  for (const changed of [{ priceAmount: 600 }, { priceCurrency: 'eur' }, { credits: 999_000 }, { rollover: false }]) {
    const { context } = await newContext(browser, { checkoutOffer: changed });
    const page = await context.newPage();
    const gift = await openGift(page);
    await gift.locator('[data-testid=gift-pack]').nth(1).click();
    await findRecipient(gift, 'luna_tv');
    await gift.locator('.gwho').waitFor();
    await gift.getByTestId('gift-review').click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await dialog.getByText('different details from your confirmation', { exact: false }).waitFor();
    assert.equal(page.url().startsWith(base), true, `changed offer must not redirect: ${JSON.stringify(changed)}`);
    await context.close();
  }
  for (const [status, text] of [[404, "This channel can't receive gifts right now."], [409, "If you've already paid"], [400, "This gift couldn't be opened for payment."]]) {
    const { context } = await newContext(browser, { checkoutFailures: [status] });
    const page = await context.newPage();
    const gift = await openGift(page);
    await gift.locator('[data-testid=gift-pack]').first().click();
    await findRecipient(gift, 'luna_tv');
    await gift.locator('.gwho').waitFor();
    await gift.getByTestId('gift-review').click();
    const dialog = page.getByRole('dialog', { name: 'Confirm your gift' });
    await dialog.getByTestId('gift-ack').check();
    await dialog.getByTestId('gift-pay').click();
    await dialog.getByTestId('gift-pay-error').getByText(text, { exact: false }).waitFor();
    assert.equal((await dialog.innerText()).includes('raw provider text'), false);
    await context.close();
  }
  pass('offer mismatch guard (price/currency/credits/rollover) + localized 404/409/400 errors');

  // 6 · Gift catalog load failure → retry; admin managed channel suggestion stays an unverified draft.
  {
    const { context, state } = await newContext(browser, {
      viewport: { width: 1280, height: 900 }, giftCatalogDown: true,
      administrating: [{ channelID: '777001', channelName: 'luna_tv' }]
    });
    const page = await context.newPage();
    await page.goto(`${base}/luna_tv/credits`);
    const store = page.locator('app-credit-packs-page');
    assert.equal(await tab(page, 'For me').getAttribute('aria-selected'), 'true', 'managed channel opens on For me');
    await store.getByText('This purchase will not add credits to that channel', { exact: false }).waitFor();
    await tab(page, 'Gift someone').getByText('Send credits to @luna_tv').waitFor();
    await tab(page, 'Gift someone').click();
    const gift = page.locator('app-credit-gift');
    await gift.getByText("Gift packs couldn't load.").waitFor();
    await page.screenshot({ path: `${shots}/after-catalog-error-1280-light.png` });
    state.catalogDown = false;
    const catalogRequests = state.catalogRequests;
    await gift.getByRole('button', { name: 'Try again' }).click();
    await until(() => state.catalogRequests > catalogRequests, 'Try again reloads the catalog');
    await gift.locator('[data-testid=gift-pack]').first().waitFor();
    await until(async () => (await gift.locator('#gift-login').inputValue()) === 'luna_tv', 'suggestion prefilled');
    await gift.getByText('Filled in from the channel you\'re viewing. Press Find to confirm', { exact: false }).waitFor();
    assert.equal(state.lookups.length, 0, 'suggestion never auto-searched');
    assert.equal(await gift.getByTestId('gift-review').isDisabled(), true, 'unverified suggestion cannot be reviewed');

    // Navbar entry → own store #gift with focus in the channel field.
    await page.evaluate(() => document.querySelector('.auth-navbar__avatar-btn')?.click());
    const navLink = page.getByRole('menuitem', { name: 'Gift credits' });
    await navLink.waitFor();
    assert.equal(await navLink.getAttribute('href'), '/test/credits#gift');
    await navLink.click();
    await page.waitForURL(`${base}/test/credits#gift`);
    await until(async () => (await focusedId(page)) === 'gift-login', 'navbar link focuses the channel field');
    assert.equal(await tab(page, 'Gift someone').getAttribute('aria-selected'), 'true');
    await context.close();
    pass('catalog error + retry, managed-channel draft suggestion (no auto lookup), navbar #gift entry');
  }

  // 7 · Return receipt: pending → delivering → delivered, never claims the chat message was sent.
  {
    const { context, state } = await newContext(browser, {
      giftSequences: { [GIFT_ID]: ['awaiting_payment', 'delivering', 'delivered'] }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/test/credits?gift=return&gift_id=${GIFT_ID}&checkout_id=co_123`);
    assert.equal(await tab(page, 'Gift someone').getAttribute('aria-selected'), 'true', 'return opens the gift side');
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Waiting for payment confirmation' }).waitFor();
    assert.equal(await status.getByText('Gift delivered').count(), 0);
    await page.screenshot({ path: `${shots}/after-return-pending-390-light.png` });
    await status.getByRole('heading', { name: 'Payment received, delivering your gift' }).waitFor({ timeout: 6000 });
    await status.getByRole('heading', { name: 'Gift delivered' }).waitFor({ timeout: 8000 });
    const receipt = await status.locator('.gs__receipt').innerText();
    assert.match(receipt, /Luna_TV/);
    assert.match(receipt, /250,000 AI credits/);
    assert.equal(receipt.includes('@test'), false, 'receipt uses server-confirmed facts; sender is not supplied by this API');
    const text = await status.innerText();
    assert.match(text, /After delivery, we send a public thank-you in @luna_tv's Twitch chat\./);
    assert.equal(/\b(posted|sent|announced)\b/i.test(text), false, 'no claim that the chat message was sent');
    const polls = state.giftPolls[GIFT_ID];
    await sleep(2500);
    assert.equal(state.giftPolls[GIFT_ID], polls, 'polling stops once delivered');
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.screenshot({ path: `${shots}/after-return-delivered-390-${theme}.png` });
      await axe(page, `delivered receipt 390 ${theme}`);
    }
    await status.getByRole('button', { name: 'Send another gift' }).click();
    await until(() => !page.url().includes('gift=') && page.url().endsWith('#gift'), 'send another clears params and opens #gift');
    await until(async () => (await focusedId(page)) === 'gift-login', 'send another focuses channel field');
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { context } = await newContext(browser, { giftSequences: { [GIFT_ID]: ['needs_support'] }, viewport: { width: 320, height: 720 } });
    const page = await context.newPage();
    await page.goto(`${base}/test/credits?gift=return&gift_id=${GIFT_ID}`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Your gift needs help from support' }).waitFor();
    await status.getByText('AAAAAAAA…D3E4').waitFor();
    assert.equal((await status.innerText()).includes(GIFT_ID), false, 'full reference not printed');
    assert.equal(await status.getByRole('link', { name: 'Contact support' }).getAttribute('href'), 'https://discord.gg/HdubYrkPXt');
    await noOverflow(page, 'support 320');
    await page.screenshot({ path: `${shots}/after-return-support-320-light.png` });
    await axe(page, 'support 320');
    await page.goto(`${base}/test/credits?gift=return&gift_id=${'f'.repeat(64)}`);
    await status.getByRole('heading', { name: "We can't show this gift" }).waitFor();
    await context.close();
  }
  {
    const { context, state } = await newContext(browser, { giftSequences: { [GIFT_ID]: ['awaiting_payment'] } });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${base}/test/credits?gift=return&gift_id=${GIFT_ID}`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Waiting for payment confirmation' }).waitFor();
    for (let i = 0; i < 12; i++) {
      await page.clock.runFor(31_000);
      await page.waitForTimeout(50);
    }
    await status.getByRole('button', { name: 'Check again' }).waitFor();
    const polls = state.giftPolls[GIFT_ID];
    assert.ok(polls <= 10, `bounded polling (${polls})`);
    await page.clock.runFor(120_000);
    await page.waitForTimeout(100);
    assert.equal(state.giftPolls[GIFT_ID], polls, 'no polling after the schedule ends');
    await context.close();
  }
  pass('return receipt: pending → delivering → delivered (no claimed chat completion), support ref, forbidden, bounded polling, send another');

  // A shared receipt can also be opened by its recipient; their identity is not the sender.
  {
    const { context } = await newContext(browser, { recipientViewer: true, giftSequences: { [GIFT_ID]: ['delivered'] } });
    const page = await context.newPage();
    await page.goto(`${base}/luna_tv/credits?gift=return&gift_id=${GIFT_ID}`);
    const status = page.locator('app-gift-status');
    await status.getByRole('heading', { name: 'Gift delivered' }).waitFor();
    assert.equal(/\bFrom\b/i.test(await status.locator('.gs__receipt').innerText()), false, 'recipient is not named as sender');
    assert.equal((await status.innerText()).includes('your public thank-you'), false, 'receipt copy does not assign recipient the buyer role');
    await context.close();
  }
  pass('recipient receipt preserves sender identity');

  // A lone paid offer still requires deliberate selection.
  {
    const { context } = await newContext(browser, { giftOffers: [byId['gift-5']] });
    const page = await context.newPage();
    const gift = await openGift(page);
    await findRecipient(gift, 'luna_tv');
    await gift.locator('.gwho').waitFor();
    assert.equal(await gift.locator('input[type=radio]:checked').count(), 0);
    assert.equal(await gift.getByTestId('gift-review').isDisabled(), true);
    await gift.getByTestId('gift-pack').click();
    await until(async()=>!(await gift.getByTestId('gift-review').isDisabled()), 'one-pack catalog requires an explicit choice');
    await context.close();
  }
  pass('one-pack catalog has no preselected paid choice');

  // 8 · Spanish + layout matrix: 320/390/1280 × light/dark, no overflow, axe clean.
  {
    const { context } = await newContext(browser, { language: 'es' });
    const page = await context.newPage();
    const gift = await openGift(page);
    const store = page.locator('app-credit-packs-page');
    await store.getByRole('heading', { level: 1, name: 'Regala créditos de IA' }).waitFor();
    await tab(page, 'Para mí').waitFor();
    await gift.getByText('+25 % más por 1', { exact: false }).first().waitFor();
    await gift.locator('[data-testid=gift-pack]').nth(2).click();
    await findRecipient(gift, 'luna_tv', 'Buscar');
    await gift.locator('.gwho').waitFor();
    await gift.getByText('Luna_TV recibe 550.000 créditos de IA permanentes de tu parte.').waitFor();
    for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'dark'], [1280, 900, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await setTheme(page, theme);
      await noOverflow(page, `es gift ${width} ${theme}`);
      await fullShot(page, `${shots}/after-gift-es-${width}-${theme}.png`);
      await axe(page, `es gift ${width} ${theme}`);
      await gift.getByRole('button', { name: /Revisar regalo/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirma tu regalo' });
      await dialog.waitFor();
      assert.equal(await dialog.getByTestId('gift-confirm-credits').innerText(), '550.000 créditos de IA');
      assert.match(await dialog.getByTestId('gift-confirm-price').innerText(), /^10,00\s\$\sUSD$/);
      await dialog.getByText('Los regalos no se reembolsan automáticamente.', { exact: false }).waitFor();
      await noOverflow(page, `es dialog ${width} ${theme}`);
      await page.screenshot({ path: `${shots}/after-confirm-es-${width}-${theme}.png` });
      await axe(page, `es dialog ${width} ${theme}`);
      await dialog.getByRole('button', { name: 'Volver' }).click();
      await until(async () => (await dialog.count()) === 0, 'Volver closes');
    }
    await context.close();
  }
  {
    const { context } = await newContext(browser);
    const page = await context.newPage();
    for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'dark'], [1280, 900, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/test/credits`);
      await page.locator('app-credit-packs-page .lf-pack').first().waitFor();
      await setTheme(page, theme);
      await noOverflow(page, `self ${width} ${theme}`);
      await fullShot(page, `${shots}/after-self-${width}-${theme}.png`);
      await axe(page, `self ${width} ${theme}`);
      await tab(page, 'Gift someone').click();
      await page.locator('app-credit-gift [data-testid=gift-pack]').first().waitFor();
      await noOverflow(page, `gift empty ${width} ${theme}`);
      await fullShot(page, `${shots}/after-gift-empty-${width}-${theme}.png`);
      await axe(page, `gift empty ${width} ${theme}`);
    }
    await context.close();
  }
  pass('es copy + 320/390/1280 light/dark layouts (self, gift, confirm), no overflow, axe');
  }

  console.log(`Blocked (aborted) remote origins: ${[...new Set(blockedOrigins)].join(', ') || 'none'}`);
  console.log(`PASS credit gift redesign (${results.length} groups). Screenshots: ${shots}`);
} finally {
  await browser.close();
}
