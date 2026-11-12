// Twitch's 50-reward limit on the Triggers and Redemptions pages: plain-language errors that stay up
// ~12 s instead of Twitch's raw codes, and the dismissable "50 of 50" note (per channel, comes back
// after dropping below 50). SAAS_BROWSER_TOOLS must contain Playwright + @axe-core/playwright.
// All API traffic is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SHOTS_DIR || '';
const channelID = '999993';
const DISMISS_KEY = `dimasite.rewardLimitNote.dismissed:${channelID}`;
const TOO_MANY = 'CREATE_CUSTOM_REWARD_TOO_MANY_REWARDS';
const DUPLICATE = 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD';

const twitchReward = (id, title) => ({ id, broadcaster_id: channelID, broadcaster_login: 'test', title, prompt: '', cost: 100,
  is_enabled: true, is_paused: false, background_color: '#9147FF', image: null, default_image: null });
const asset = { _id: 'a1', ownerChannelID: channelID, ownerChannelName: 'test', displayName: 'Airhorn', fileName: 'airhorn.mp3',
  extension: 'mp3', mimeType: 'audio/mpeg', mediaType: 'audio', bytes: 2048, storageUrl: '', playbackUrl: '', scope: 'private',
  marketplaceStatus: 'not_listed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
const libraryItem = { _id: 'li1', assetID: 'a1', relationType: 'owner_upload', localAlias: null, quotaBytesCharged: 2048,
  assetScope: 'private', mediaType: 'audio', isActive: true, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', asset };
const linkedReward = { _id: 'db1', rewardID: 'r1', title: 'Boom', type: 'custom', prompt: '', cost: 100, cooldown: 0, isEnabled: true };
const baseTriggers = () => [
  { _id: 't1', name: 'Boom', channel: 'test', channelID, rewardID: 'r1', file: 'Airhorn', type: 'trigger', mediaType: 'audio/mpeg',
    isEnabled: true, cost: 100, cooldown: 0, prompt: '', volume: 100, assetID: 'a1', libraryItemID: 'li1', reward: linkedReward },
  { _id: 't2', name: 'Racha', channel: 'test', channelID, rewardID: '', file: 'Airhorn', type: 'trigger', mediaType: 'audio/mpeg',
    isEnabled: true, cost: 0, cooldown: 0, prompt: '', volume: 100, assetID: 'a1', libraryItemID: 'li1', reward: null },
];
const dbRewards = () => [{ id: 'r1', rewardID: 'r1', eventsubID: 'e1', channelID, channel: 'test', title: 'Boom', type: 'custom',
  prompt: '', cost: 100, originalCost: 100, costChange: 0, returnToOriginalCost: false, isEnabled: true, message: '', duration: 0, cooldown: 0 }];

/**
 * state.twitchCount: rewards on Twitch (r1 + filler). state.createError: message the trigger/reward POST fails with.
 * Deleting the reward-linked trigger or a reward drops one from Twitch, like the real API.
 */
async function open(browser, { path = 'triggers', twitchCount = 50, lang = 'en', theme = 'dark', width = 1280, height = 900,
  attach = true, rewardsView = true, createError = TOO_MANY, keepStorage = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const user = { id: channelID, login: 'test', display_name: 'Test' };
  const app = { name: 'Test', email: 'test@example.invalid', language: lang, plan_tier: 'premium', actived: true, chat_enabled: true,
    twitch_user_id: channelID, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  await context.addInitScript(({ user, app, lang, theme, keepStorage }) => {
    if (sessionStorage.getItem('__fixture_init')) return;
    sessionStorage.setItem('__fixture_init', '1');
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    localStorage.setItem('dimasite.language', lang);
    localStorage.setItem('theme', theme);
    for (const [k, v] of Object.entries(keepStorage || {})) localStorage.setItem(k, v);
  }, { user, app, lang, theme, keepStorage });
  await context.routeWebSocket(/.*/, ws => ws.close());
  const state = { twitchCount, createError, calls: [], posts: [] };
  const twitchList = () => [twitchReward('r1', 'Boom'),
    ...Array.from({ length: Math.max(0, state.twitchCount - 1) }, (_, i) => twitchReward(`tw${i}`, `Other app reward ${i}`))];
  let triggers = baseTriggers();
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/test/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    const method = request.method();
    const p = url.pathname;
    let data = {};
    let extra = {};
    if (p === '/auth/session') data = { twitch: user, app };
    else if (p.startsWith('/auth/access/')) {
      const permission = url.searchParams.get('permission') || '';
      data = { allowed: ['triggers:attach', 'triggers:edit'].includes(permission) ? attach : permission === 'rewards:view' ? rewardsView : true };
    } else if (p.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'premium' };
    else if (p.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
    else if (p === `/rewards/twitch/${channelID}`) { state.calls.push('GET twitch'); data = twitchList(); }
    else if (p === `/triggers/library/${channelID}`) { data = [libraryItem]; extra = { meta: { planTier: 'premium', quotaBytesUsed: 2048, quotaBytesLimit: 1e9 } }; }
    else if (p === `/triggers/${channelID}` && method === 'GET') data = triggers;
    else if (p === `/triggers/${channelID}` && method === 'POST') {
      state.calls.push('POST trigger');
      state.posts.push(request.postDataJSON());
      if (state.createError) return route.fulfill({ status: 400, json: { error: true, message: state.createError, status: 400 } });
      data = { ...baseTriggers()[0], _id: 't9', name: request.postDataJSON().name };
      triggers = [data, ...triggers];
      state.twitchCount += 1;
    } else if (p.startsWith(`/triggers/${channelID}/`) && method === 'DELETE') {
      const id = p.split('/').pop();
      if (triggers.find(t => t._id === id)?.rewardID) state.twitchCount -= 1;
      triggers = triggers.filter(t => t._id !== id);
    } else if (p.startsWith(`/rewards/${channelID}`)) {
      if (method === 'GET') data = dbRewards();
      else if (method === 'POST') {
        state.calls.push('POST reward');
        return route.fulfill({ status: 400, json: { error: true, message: state.createError, status: 400 } });
      } else if (method === 'DELETE') state.twitchCount -= 1;
    }
    return route.fulfill({ json: { error: false, status: 200, data, ...extra } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/test/modules/${path}`);
  await page.evaluate(t => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  const root = page.locator(path === 'triggers' ? 'app-triggers-page' : 'app-redemptions-page');
  await root.locator('h1').waitFor();
  if (path === 'triggers') await root.getByText('Racha').first().waitFor();
  else await root.locator('.lf-reward').first().waitFor();
  return { context, page, root, state, errors };
}

const note = root => root.locator('app-reward-limit-note');
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out: ${label}`);
}
const noteVisible = async root => (await note(root).locator('section').count()) > 0 && await note(root).isVisible();

async function axeNote(page, label) {
  const result = await new AxeBuilder({ page }).include('app-reward-limit-note').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), [], `axe ${label}`);
}
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `horizontal overflow ${label}`);
}
async function shot(page, name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // 1. Triggers page at 50/50: note with both links; dark + light, phone + desktop, axe on the note, no overflow.
  for (const theme of ['dark', 'light']) {
    for (const width of [320, 390, 1280]) {
      const { context, page, root, errors } = await open(browser, { theme, width, height: width < 640 ? 800 : 900 });
      await until(() => noteVisible(root), `note shown (${theme} ${width})`);
      const n = note(root);
      await n.getByText('Your channel has 50 of 50 Twitch rewards').waitFor();
      await n.getByText("Rewards made on Twitch or in other apps count too, even turned off or paused. Delete ones you don't use to make new ones.").waitFor();
      assert.equal(await n.getByRole('link', { name: 'See your rewards' }).getAttribute('href'), '/test/modules/redemptions');
      const twitch = n.getByRole('link', { name: 'Manage on Twitch' });
      assert.equal(await twitch.getAttribute('href'), 'https://dashboard.twitch.tv/u/test/viewer-rewards/channel-points/rewards');
      assert.equal(await twitch.getAttribute('target'), '_blank');
      const close = n.getByRole('button', { name: 'Hide this notice' });
      const box = await close.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `dismiss target ${box.width}x${box.height}`);
      await axeNote(page, `triggers ${theme} ${width}`);
      await noOverflow(page, `triggers ${theme} ${width}`);
      await shot(page, `triggers-note-${theme}-${width}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  }

  // 2. Dismiss sticks per channel across reloads; dropping below 50 forgets it, filling up again brings it back.
  {
    const { context, page, root, state } = await open(browser);
    await until(() => noteVisible(root), 'note shown');
    await note(root).getByRole('button', { name: 'Hide this notice' }).click();
    await until(async () => !(await noteVisible(root)), 'note hidden after dismiss');
    assert.equal(await page.evaluate(k => localStorage.getItem(k), DISMISS_KEY), '1');
    // Hidden note leaves no empty grid row: the setup strip sits right after the header gap.
    assert.equal(await note(root).evaluate(el => getComputedStyle(el).display), 'none');
    await page.reload();
    await root.getByText('Racha').first().waitFor();
    await until(() => state.calls.filter(c => c === 'GET twitch').length >= 2, 'count reloaded');
    await page.waitForTimeout(300);
    assert.equal(await noteVisible(root), false, 'dismissal survives a reload');

    // Deleting the reward-linked trigger frees a Twitch slot (the API deletes its reward): count refetched, 49 → dismissal forgotten.
    await root.getByRole('button', { name: 'Delete Boom' }).click();
    await page.locator('app-confirmation-modal').getByRole('button', { name: 'Delete', exact: true }).click();
    await until(() => state.calls.filter(c => c === 'GET twitch').length >= 3, 'count refetched after delete');
    await until(async () => (await page.evaluate(k => localStorage.getItem(k), DISMISS_KEY)) === null, 'dismissal cleared below 50');
    await context.close();
  }

  // 3. Create a trigger with a reward on a full channel: plain words, ~12 s toast, no raw code, note comes up.
  for (const lang of ['en', 'es']) {
    const { context, page, root, state, errors } = await open(browser, { lang, twitchCount: 49, width: 390, height: 844 });
    await until(() => state.calls.includes('GET twitch'), 'count loaded');
    await page.waitForTimeout(200);
    assert.equal(await noteVisible(root), false, 'no note at 49');
    // Twitch's count can be stale (rewards made elsewhere meanwhile): the refusal itself raises the note.
    state.twitchCount = 50;
    await root.locator('.lf-head__actions .lf-btn--primary').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.lf-pick__select').first().click();
    await dialog.locator('.lf-step').nth(1).locator('input[type=text]').fill('Ganaste');
    await dialog.locator('.lf-step').nth(2).locator('input[type=checkbox]').first().check();
    await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
    await until(() => state.calls.includes('POST trigger'), 'create sent');
    const toast = page.locator('app-toast-container');
    const title = lang === 'en' ? 'Twitch reward limit reached' : 'Llegaste al límite de recompensas de Twitch';
    const body = lang === 'en'
      ? "Your channel already has the 50 rewards Twitch allows, and turned-off or paused ones still count. We turned the reward off, so saving again keeps the trigger without one. To add a reward, delete one you don't use first."
      : 'Tu canal ya tiene las 50 recompensas que permite Twitch, y las desactivadas o en pausa también cuentan. Apagamos la recompensa, así que al guardar de nuevo el trigger se guarda sin ella. Para agregar una recompensa, primero elimina una que no uses.';
    await toast.getByText(title).waitFor();
    await toast.getByText(body).waitFor();
    assert.equal(await page.getByText(TOO_MANY).count(), 0, 'raw Twitch code never shown');
    await until(() => noteVisible(root), 'note raised by the refusal');
    await note(root).getByText(lang === 'en' ? 'Your channel has 50 of 50 Twitch rewards' : 'Tu canal tiene 50 de 50 recompensas de Twitch').waitFor();
    assert.equal(await dialog.isVisible(), true, 'editor stays open with the draft');
    // The toast must sit above the open editor, not behind its overlay (hit-test its text).
    await page.waitForTimeout(900);
    const onTop = await page.evaluate(text => {
      const el = [...document.querySelectorAll('app-toast-container .toast-3d-title')].find(e => e.textContent.trim() === text);
      if (!el) return 'missing';
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !hit.closest('app-toast-container')) return `covered by ${hit?.className || hit?.tagName}`;
      const close = el.closest('.toast-3d-card').querySelector('.toast-3d-close').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const line = [...range.getClientRects()].at(0);
      return line.right <= close.left + 0.5 || line.top >= close.bottom ? 'top' : 'title runs under the close button';
    }, title);
    assert.equal(onTop, 'top', 'error toast readable above the editor');
    await shot(page, `triggers-toomany-${lang}-390`);
    // The refusal locks the reward off in the open editor, with the reason; the draft name stays.
    const toggle = dialog.getByRole('checkbox', { name: lang === 'en' ? 'Create a channel points reward' : 'Crear una recompensa de puntos de canal' });
    await until(async () => (await toggle.isDisabled()) && !(await toggle.isChecked()), 'reward switch off + locked after refusal');
    await dialog.locator('#trigger-reward-full').waitFor();
    assert.equal(await dialog.locator('.lf-step').nth(1).locator('input[type=text]').inputValue(), 'Ganaste');
    await page.waitForTimeout(8000);
    assert.equal(await toast.getByText(title).isVisible(), true, 'toast still up after 8 s (old default was 5.2 s)');
    await until(async () => (await toast.getByText(title).count()) === 0, 'toast leaves after ~12 s', 6000);
    // Saving again creates the trigger without a reward.
    state.createError = null;
    await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(state.posts.length, 2);
    assert.ok(state.posts[0].reward && state.posts[0].reward.create === true, 'first try asked for a reward');
    assert.equal(state.posts[1].reward, null, 'second try sends no reward');
    assert.equal(state.posts[1].name, 'Ganaste');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3b. Already at 50 when the editor opens: switch off + locked with the reason; the trigger saves without a reward.
  //     A trigger that already has its reward keeps it (edit shows the linked switch, not the lock).
  for (const theme of ['dark', 'light']) {
    const { context, page, root, state, errors } = await open(browser, { theme, twitchCount: 50, createError: null, width: 390, height: 844 });
    await until(() => noteVisible(root), 'note at 50');
    await root.locator('.lf-head__actions .lf-btn--primary').click();
    const dialog = page.getByRole('dialog');
    const toggle = dialog.getByRole('checkbox', { name: 'Create a channel points reward' });
    await until(async () => await toggle.isDisabled(), 'switch locked');
    assert.equal(await toggle.isChecked(), false);
    const hint = dialog.locator('#trigger-reward-full');
    await hint.getByText("Your channel has all 50 Twitch rewards, so this trigger can't get one right now. It still plays from any command. Delete a reward you don't use to add one here.").waitFor();
    assert.equal(await toggle.getAttribute('aria-describedby'), 'trigger-reward-full');
    const result = await new AxeBuilder({ page }).include('#trigger-reward-full').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => v.id), [], `axe editor hint ${theme}`);
    await hint.scrollIntoViewIfNeeded();
    await shot(page, `triggers-editor-locked-${theme}-390`);
    await dialog.locator('.lf-pick__select').first().click();
    await dialog.locator('.lf-step').nth(1).locator('input[type=text]').fill('Sin_recompensa');
    await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(state.posts.at(-1).reward, null, 'saved without a reward');
    if (theme === 'dark') {
      await root.getByRole('button', { name: 'Edit Boom' }).click();
      const edit = page.getByRole('dialog');
      const linked = edit.getByRole('checkbox', { name: 'Create a channel points reward' });
      await linked.waitFor();
      assert.equal(await linked.isChecked(), true, 'existing reward stays on');
      assert.equal(await edit.locator('#trigger-reward-full').count(), 0, 'no lock hint for a trigger that has its reward');
      await edit.getByText('This trigger already has a reward.', { exact: false }).waitFor();
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'detached' });
      await root.getByRole('button', { name: 'Edit Racha' }).click();
      const edit2 = page.getByRole('dialog');
      await edit2.locator('#trigger-reward-full').waitFor();
      assert.equal(await edit2.getByRole('checkbox', { name: 'Create a channel points reward' }).isDisabled(), true, 'no new reward for a reward-less trigger');
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 4. Duplicate reward name: plain words, no raw code.
  {
    const { context, page, root, state } = await open(browser, { twitchCount: 10, createError: DUPLICATE });
    await root.locator('.lf-head__actions .lf-btn--primary').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.lf-pick__select').first().click();
    await dialog.locator('.lf-step').nth(1).locator('input[type=text]').fill('Boom2');
    await dialog.locator('.lf-step').nth(2).locator('input[type=checkbox]').first().check();
    await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
    await until(() => state.calls.includes('POST trigger'), 'create sent');
    await page.locator('app-toast-container').getByText('You already have a reward with this name on Twitch. Pick a different name.').waitFor();
    assert.equal(await page.getByText(DUPLICATE).count(), 0);
    assert.equal(await noteVisible(root), false, 'duplicate is not a full channel');
    await context.close();
  }

  // 5. A successful create with a reward refetches the count (49 → 50 brings the note up).
  {
    const { context, page, root, state } = await open(browser, { twitchCount: 49, createError: null });
    await until(() => state.calls.includes('GET twitch'), 'count loaded');
    await root.locator('.lf-head__actions .lf-btn--primary').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.lf-pick__select').first().click();
    await dialog.locator('.lf-step').nth(1).locator('input[type=text]').fill('Nuevo');
    await dialog.locator('.lf-step').nth(2).locator('input[type=checkbox]').first().check();
    await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
    await dialog.waitFor({ state: 'detached' });
    await until(() => noteVisible(root), 'note after filling the last slot');
    await context.close();
  }

  // 6. People who can't make or edit triggers don't get the note; without rewards:view the count isn't even asked for.
  {
    const { context, page, root, state } = await open(browser, { attach: false });
    await until(() => state.calls.includes('GET twitch'), 'count loaded');
    await page.waitForTimeout(300);
    assert.equal(await note(root).count(), 0, 'no note without triggers:attach/edit');
    await context.close();
  }
  {
    const { context, page, root, state } = await open(browser, { rewardsView: false });
    await page.waitForTimeout(1500);
    assert.equal(state.calls.includes('GET twitch'), false, 'no Twitch reward request without rewards:view');
    assert.equal(await noteVisible(root), false);
    await context.close();
  }

  // 7. Redemptions page: note without the self-link; deleting a reward hides it; a full-channel create error shows it again.
  for (const theme of ['dark', 'light']) {
    const { context, page, root, state, errors } = await open(browser, { path: 'redemptions', theme, width: 390, height: 844 });
    await until(() => noteVisible(root), 'note on redemptions');
    const n = note(root);
    await n.getByText('Your channel has 50 of 50 Twitch rewards').waitFor();
    assert.equal(await n.getByRole('link', { name: 'See your rewards' }).count(), 0, 'no link to the page you are on');
    await n.getByRole('link', { name: 'Manage on Twitch' }).waitFor();
    await axeNote(page, `redemptions ${theme}`);
    await noOverflow(page, `redemptions ${theme}`);
    await shot(page, `redemptions-note-${theme}-390`);
    if (theme === 'dark') {
      await root.getByRole('button', { name: 'Delete Boom' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete reward' }).click();
      await until(async () => !(await noteVisible(root)), 'note hidden after deleting a reward');
      await root.getByRole('button', { name: 'New reward' }).click();
      const dialog = page.getByRole('dialog', { name: 'New reward' });
      await dialog.getByLabel('Name', { exact: true }).fill('Hydrate');
      await dialog.getByRole('button', { name: 'Create reward' }).click();
      await until(() => state.calls.includes('POST reward'), 'reward create sent');
      await page.locator('app-toast-container').getByText("Your channel already has the 50 rewards Twitch allows, and turned-off or paused ones still count. Delete one you don't use to make room.").waitFor();
      assert.equal(await page.getByText(TOO_MANY).count(), 0);
      await until(() => noteVisible(root), 'refusal brings the note back');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('PASS reward limit: plain errors (en/es) with ~12 s toasts, 50/50 note on Triggers + Redemptions, dismiss/reset, axe, overflow.');
} finally {
  await browser.close();
}
