// Redemptions page (Live First): rows merged with Twitch's copy, editor, toggle rollback, delete, plans, i18n, axe.
// SAAS_BROWSER_TOOLS must contain Playwright + @axe-core/playwright. All API traffic is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SHOTS_DIR || '';
const channelID = '999991';
const icon = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><circle cx="14" cy="14" r="10" fill="white"/></svg>');

// Our DB copy: Mongo doesn't store colour / user input / skip queue, Twitch does.
const dbRewards = () => [
  { id: 'r1', rewardID: 'r1', eventsubID: 'e1', channelID, channel: 'test', title: 'Hydrate', type: 'custom', prompt: 'Make me drink water', cost: 500, originalCost: 500, costChange: 50, returnToOriginalCost: true, isEnabled: true, message: '$(user) hydrated me', duration: 0, cooldown: 300 },
  { id: 'r2', rewardID: 'r2', eventsubID: 'e2', channelID, channel: 'test', title: 'Airhorn', type: 'custom', prompt: '', cost: 1000, originalCost: 1000, costChange: 0, returnToOriginalCost: false, isEnabled: true, message: '', duration: 0, cooldown: 0 },
  { id: 'r3', rewardID: 'r3', eventsubID: 'e3', channelID, channel: 'test', title: 'Say something', type: 'custom', prompt: 'TTS', cost: 300, originalCost: 300, costChange: 0, returnToOriginalCost: false, isEnabled: false, message: '$(tts &t)', duration: 0, cooldown: 30 },
];
const twitchRewards = () => [
  { id: 'r1', broadcaster_id: channelID, broadcaster_login: 'test', title: 'Hydrate', prompt: 'Make me drink water', cost: 500, is_enabled: true, is_paused: false, background_color: '#00C7AC', is_user_input_required: true, should_redemptions_skip_request_queue: true, image: null, default_image: { url_1x: icon, url_2x: icon, url_4x: icon }, global_cooldown_setting: { is_enabled: true, global_cooldown_seconds: 300 } },
  { id: 'r2', broadcaster_id: channelID, broadcaster_login: 'test', title: 'Airhorn', prompt: '', cost: 1000, is_enabled: true, is_paused: true, background_color: '#FA1ED2', is_user_input_required: false, should_redemptions_skip_request_queue: false, image: null, default_image: { url_1x: icon, url_2x: icon, url_4x: icon }, global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 } },
  { id: 'r3', broadcaster_id: channelID, broadcaster_login: 'test', title: 'Say something', prompt: 'TTS', cost: 300, is_enabled: false, background_color: '#FFFFFF', is_user_input_required: true, should_redemptions_skip_request_queue: false, image: null, default_image: null },
  { id: 'tw1', broadcaster_id: channelID, broadcaster_login: 'test', title: 'Highlight My Message', prompt: '', cost: 200, is_enabled: true, background_color: '#9147FF', image: null, default_image: { url_1x: icon, url_2x: icon, url_4x: icon } },
];
const triggers = [{ _id: 't1', name: 'Airhorn', channel: 'test', channelID, rewardID: 'r2', file: '', type: 'redemption', mediaType: 'audio', isEnabled: true, cost: 1000, cooldown: 0, prompt: '', volume: 100 }];

async function open(browser, { tier = 'premium', canManage = true, width = 1280, height = 900, theme = 'light', lang = 'en', failPatch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const user = { id: channelID, login: 'test', display_name: 'Test' };
  const app = { name: 'Test', email: 'test@example.invalid', language: lang, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: channelID, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  await context.addInitScript(({ user, app, lang, theme }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('dimasite.language', lang);
    localStorage.setItem('theme', theme);
    sessionStorage.clear();
  }, { user, app, lang, theme });
  await context.routeWebSocket(/.*/, ws => ws.close());
  const calls = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const method = request.method();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.startsWith('/auth/access/')) data = { allowed: url.searchParams.get('permission') === 'rewards:manage' ? canManage : true };
    else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: tier };
    else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    else if (url.pathname === `/rewards/twitch/${channelID}`) data = twitchRewards();
    else if (url.pathname === `/triggers/${channelID}`) data = triggers;
    else if (url.pathname.startsWith(`/rewards/${channelID}`)) {
      if (method === 'GET') data = dbRewards();
      else {
        calls.push({ method, path: url.pathname, body: request.postDataJSON?.() ?? null });
        if (failPatch && method === 'PATCH') return route.fulfill({ status: 400, json: { error: true, message: 'Twitch refused', status: 400 } });
        data = method === 'POST' ? { ...dbRewards()[0], id: 'r9', rewardID: 'r9' } : {};
      }
    }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/test/modules/redemptions`);
  await page.evaluate(t => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  const root = page.locator('app-redemptions-page');
  await root.locator('.lf-reward').first().waitFor();
  await root.locator('.lf-mini').first().waitFor();
  return { context, page, root, calls, errors };
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), [], `axe ${label}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // 1. Rows, merged Twitch data, cross-links, Made-on-Twitch list.
  {
    const { context, page, root, calls, errors } = await open(browser);
    await root.getByRole('heading', { name: 'Redemptions', level: 1 }).waitFor();
    assert.equal(await root.locator('.lf-reward').count(), 3);
    await root.getByText('2 of 3 on').waitFor();
    await root.getByText('1 made on Twitch').waitFor();
    const hydrate = root.locator('.lf-reward', { hasText: 'Hydrate' });
    assert.equal(await hydrate.locator('.lf-reward-icon').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 199, 172)', 'colour comes from Twitch');
    assert.equal(await hydrate.locator('.lf-reward-icon img').count(), 1, 'real Twitch icon shown');
    await hydrate.getByText('500 points').waitFor();
    await hydrate.getByText('+50 per redeem').waitFor();
    await hydrate.getByText('5 min').waitFor();
    await hydrate.getByText('Viewer types text').waitFor();
    const airhorn = root.locator('.lf-reward', { hasText: 'Airhorn' });
    assert.equal(await airhorn.getByRole('link', { name: /Plays the trigger Airhorn/ }).getAttribute('href'), '/test/modules/triggers');
    await airhorn.getByText('Paused').waitFor();
    await root.locator('.lf-reward', { hasText: 'Say something' }).getByText('Hidden').waitFor();
    assert.deepEqual(await root.locator('.lf-mini__name').allTextContents(), ['Highlight My Message'], 'only rewards made on Twitch are listed there');
    assert.match(await root.getByRole('link', { name: 'Open Twitch rewards' }).getAttribute('href'), /dashboard\.twitch\.tv\/u\/test\/viewer-rewards/);
    assert.equal(await root.locator('input[type=search]').count(), 0, 'no search for short lists');

    // 2. Edit loads Twitch's real flags (DB copy has none) and saves them back unchanged.
    await root.getByRole('button', { name: 'Edit Hydrate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit reward' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Viewer must type something').isChecked(), true, 'user input loaded from Twitch');
    await dialog.getByText('More options').click();
    assert.equal(await dialog.getByLabel('Skip the requests queue').isChecked(), true, 'skip queue loaded from Twitch');
    assert.equal(await dialog.locator('[formControlName="background_color"]').inputValue(), '#00c7ac');
    assert.equal(await dialog.locator('[formControlName="duration"]').count(), 0, 'VIP days hidden for non-VIP rewards');
    await dialog.getByText('500 → 550 → 600 …').waitFor();
    await dialog.getByLabel('Price (channel points)').fill('600');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.waitFor({ state: 'detached' });
    const patch = calls.find(c => c.method === 'PATCH' && c.path.endsWith('/r1'));
    assert.ok(patch, 'PATCH sent');
    assert.equal(patch.body.cost, 600);
    assert.equal(patch.body.userInput, true);
    assert.equal(patch.body.skipQueue, true);
    assert.equal(patch.body.background_color, '#00c7ac');
    assert.equal(patch.body.costChange, 50);
    assert.equal(patch.body.originalCost, 500);
    assert.equal('duration' in patch.body, false);
    await hydrate.getByText('600 points').waitFor();

    // 3. Optimistic toggle.
    await root.getByRole('checkbox', { name: 'Airhorn on' }).uncheck();
    await root.locator('.lf-reward.lf-item--off', { hasText: 'Airhorn' }).waitFor();
    assert.deepEqual(calls.at(-1), { method: 'PATCH', path: `/rewards/${channelID}/r2`, body: { isEnabled: false } });

    // 4. Create: inline validation first, then a clean payload.
    await root.getByRole('button', { name: 'New reward' }).click();
    const create = page.getByRole('dialog', { name: 'New reward' });
    await create.getByRole('button', { name: 'Create reward' }).click();
    await create.getByText('Give it a name (up to 45 characters).').waitFor();
    assert.equal(await create.locator('[formControlName="title"]').getAttribute('aria-invalid'), 'true');
    assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'invalid form not sent');
    await create.getByLabel('Name', { exact: true }).fill('  Stretch  ');
    await create.getByRole('button', { name: 'Colour #22c55e' }).click();
    await create.getByLabel('Raise the price by (points)').fill('25');
    await create.getByRole('button', { name: 'Create reward' }).click();
    await create.waitFor({ state: 'detached' });
    const post = calls.find(c => c.method === 'POST');
    assert.equal(post.body.title, 'Stretch');
    assert.equal(post.body.background_color, '#22c55e');
    assert.equal(post.body.costChange, 25);
    assert.equal('originalCost' in post.body, false, 'server sets the starting price on create');
    assert.equal(post.body.type, 'custom');

    // 5. Delete explains the trigger consequence.
    await root.getByRole('button', { name: 'Delete Airhorn' }).click();
    const del = page.getByRole('alertdialog', { name: 'Delete “Airhorn”?' });
    await del.getByText('The trigger “Airhorn” stays').waitFor();
    await page.keyboard.press('Escape');
    await del.waitFor({ state: 'detached' });
    await root.getByRole('button', { name: 'Delete Airhorn' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete reward' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.ok(calls.some(c => c.method === 'DELETE' && c.path.endsWith('/r2')));
    assert.equal(await root.locator('.lf-reward', { hasText: 'Airhorn' }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS rows, merge, edit, toggle, create, delete');
    await context.close();
  }

  // 6. Toggle rolls back when Twitch refuses.
  {
    const { context, page, root } = await open(browser, { failPatch: true });
    const box = root.getByRole('checkbox', { name: 'Hydrate on' });
    const refused = page.waitForResponse(r => r.request().method() === 'PATCH' && r.status() === 400);
    await box.click({ force: true });
    await refused;
    await page.waitForFunction(() => {
      const input = [...document.querySelectorAll('.lf-reward')].find(r => r.textContent.includes('Hydrate'))?.querySelector('.lf-switch input');
      return input?.checked === true && !input.disabled;
    }, null, { timeout: 5000 });
    assert.equal(await root.locator('.lf-reward.lf-item--off', { hasText: 'Hydrate' }).count(), 0, 'row rolled back');
    console.log('PASS toggle rollback');
    await context.close();
  }

  // 7. Free plan locks price increase; view-only users get no controls.
  {
    const { context, page, root } = await open(browser, { tier: 'free' });
    await root.getByRole('button', { name: 'New reward' }).click();
    const modal = page.locator('app-create-reward-modal');
    await modal.locator('[formControlName="costChange"]').waitFor();
    assert.equal(await modal.locator('.lf-premium--locked').count(), 1);
    assert.equal(await modal.locator('[formControlName="costChange"]').isDisabled(), true);
    await modal.getByText('Premium and Pro plans can raise the price').waitFor();
    await context.close();
    const viewer = await open(browser, { canManage: false });
    await viewer.root.getByText('View only').waitFor();
    assert.equal(await viewer.root.getByRole('button', { name: 'New reward' }).count(), 0);
    assert.equal(await viewer.root.locator('.lf-switch').count(), 0);
    await viewer.context.close();
    console.log('PASS free plan + view only');
  }

  // 8. Spanish.
  {
    const { context, root } = await open(browser, { lang: 'es' });
    await root.getByRole('heading', { name: 'Canjes', level: 1 }).waitFor();
    await root.getByText('2 de 3 activas').waitFor();
    await root.getByText('+50 por canje').waitFor();
    console.log('PASS es');
    await context.close();
  }

  // 9. Layout + accessibility at phone/desktop, light/dark, with the editor open.
  for (const [width, height, theme] of [[320, 720, 'light'], [390, 844, 'dark'], [390, 844, 'light'], [1280, 900, 'light'], [1280, 900, 'dark']]) {
    const { context, page, root } = await open(browser, { width, height, theme });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal scroll at ${width}px (${overflow})`);
    await axe(page, `page ${width} ${theme}`);
    if (shots) await page.screenshot({ path: `${shots}/redemptions-${width}-${theme}.png`, fullPage: true });
    await root.getByRole('button', { name: 'Edit Hydrate' }).click();
    await page.getByRole('dialog').waitFor();
    await axe(page, `editor ${width} ${theme}`);
    if (shots) await page.screenshot({ path: `${shots}/redemptions-editor-${width}-${theme}.png` });
    console.log(`PASS layout + axe ${width}px ${theme}`);
    await context.close();
  }
} finally {
  await browser.close();
}
