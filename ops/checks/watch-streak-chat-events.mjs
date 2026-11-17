// Uses fixture sessions and intercepts every external request; never updates live settings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const type = 'channel.chat.notification';
const templates = {
  en: '$(user) has a streak of $(twitch.streak) days!',
  es: '¡$(user) tiene una racha de $(twitch.streak) días!'
};
// Names and button labels come from the bundle under test, so a wording change cannot make this check stale.
const dictionary = async lang => (await (await fetch(`${base}/assets/i18n/${lang}.json`)).json()).chatEvents;
const dictionaries = { en: await dictionary('en'), es: await dictionary('es') };
const definition = {
  name: 'Chat Notifications', type, version: '1', condition: { broadcaster_user_id: 'user', user_id: 'moderator' },
  icon: 'Trophy', releaseStage: 'stable', enabled: false, plan_tier: 'free',
  description: { EN: 'Celebrate watch streaks and moderator anniversaries shared in chat.', ES: 'Celebra las rachas de visualización y los aniversarios de moderación compartidos en el chat.' },
  config: [{ id: 'watchStreakEnabled', label: { EN: 'Watch streak announcements', ES: 'Anuncios de rachas de visualización' }, type: 'checkbox', value: true, canDisable: true }, { id: 'message', label: { EN: 'Streak message', ES: 'Mensaje de la racha' }, type: 'text', value: templates.en, canDisable: true },
    { id: 'modiversaryEnabled', label: { EN: 'Moderator anniversary announcements', ES: 'Anuncios de aniversarios de moderación' }, type: 'checkbox', value: true, canDisable: true },
    { id: 'modiversaryMessage', label: { EN: 'Moderator anniversary message', ES: 'Mensaje de aniversario de moderación' }, type: 'text', value: 'Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!', canDisable: true }]
};
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const lang of ['en', 'es']) for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
    const app = { name: 'Viewer', language: lang, plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id,
      has_permissions: true, up_to_date_permissions: true, administrating: [] };
    let stored = { _id: 'fixture-subscription', id: 'twitch-fixture', type, version: '1', enabled: true, status: 'enabled', message: lang === 'es' ? templates.en : '' };
    let canManage = true;
    let rejectSave = false;
    const writes = [];
    await context.addInitScript(({ user, app, lang }) => {
      localStorage.setItem('userLanguage', lang);
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    }, { user, app, lang });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.includes('/access')) data = { allowed: !url.searchParams.get('permission')?.endsWith(':manage') || canManage, role: 'owner', planTier: 'free' };
      else if (url.pathname === '/site/events') data = [definition];
      else if (url.pathname.startsWith('/eventsubs/')) {
        if (request.method() === 'PATCH') {
          const payload = request.postDataJSON();
          writes.push(payload);
          if (rejectSave) return route.fulfill({ status: 500, json: { error: true, message: 'Fixture save failure' } });
          stored = { ...stored, ...payload };
          data = stored;
        } else if (request.method() === 'POST') {
          const payload = request.postDataJSON();
          writes.push(payload);
          stored = { ...stored, ...payload.config, enabled: true };
          data = stored;
        } else data = stored ? [stored] : [];
      } else if (url.pathname.includes('/live-status')) data = { isLive: false };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/viewer/modules/chat-events`);
    const T = dictionaries[lang];
    // The shared "chat notifications" subscription shows as one card per notice, each with its own switch and message.
    const cardOf = name => page.locator('app-event-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const streak = cardOf(T.watchStreak.name), mod = cardOf(T.modiversary.name);
    const configure = card => card.getByRole('button', { name: T.configure, exact: true });
    const save = card => card.getByRole('button', { name: T.saveChanges, exact: true });
    const toggle = (card, name) => card.getByRole('switch', { name });
    const checked = async (card, name, state) => page.waitForFunction(([label, wanted]) =>
      [...document.querySelectorAll('app-event-card [role=switch]')].find(el => el.getAttribute('aria-label') === label)?.getAttribute('aria-checked') === wanted, [name, String(state)]);
    try { await configure(streak).click(); }
    catch (error) { console.error({ url: page.url(), body: await page.locator('body').innerText(), errors }); throw error; }
    assert.equal(await page.locator('app-event-card').count(), 2, 'one card per notice, no combined card');
    const input = streak.locator('#control-message');
    const modInput = mod.locator('#control-modiversaryMessage');
    const reset = card => card.getByRole('button', { name: T.watchStreak.restoreDefault, exact: true });
    const expectValue = async (id, value) => page.waitForFunction(([field, expected]) => document.querySelector(`#control-${field}`)?.value === expected, [id, value]);
    await expectValue('message', '');
    assert.equal(await input.getAttribute('placeholder'), templates[lang]);
    assert.equal(T.watchStreak.defaultMessage, templates[lang]);
    assert.match(await streak.locator('#notification-help-message').innerText(), /\$\(twitch\.streak\)/);
    // Each card edits only its own message and has no delete (the subscription is shared).
    assert.equal(await streak.locator('#control-modiversaryMessage').count(), 0);
    assert.equal(await streak.getByRole('button', { name: T.deleteEvent, exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal page overflow');
    if (process.env.SAAS_SCREENSHOTS) await streak.screenshot({ path: `${process.env.SAAS_SCREENSHOTS}/watch-streak-${lang}-${width}.png` });

    const custom = '$(user): $(twitch.streak) — keep watching!';
    await input.fill(custom);
    await save(streak).click();
    await streak.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { message: custom }, 'the streak card saves only its own message');
    await page.reload();
    await configure(streak).waitFor();
    await page.reload(); // The second reload hydrates the populated session cache.
    await configure(streak).click();
    await expectValue('message', custom);
    await reset(streak).click();
    await expectValue('message', '');
    await save(streak).click();
    await streak.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { message: '' }, 'empty means the default in the channel language');

    // Each switch flips only its own notice; the subscription stays on while the other notice is on.
    await toggle(streak, T.watchStreak.name).click();
    await checked(streak, T.watchStreak.name, false);
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: false });
    await checked(mod, T.modiversary.name, true);
    await toggle(streak, T.watchStreak.name).click();
    await checked(streak, T.watchStreak.name, true);
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: true, modiversaryEnabled: true, enabled: true });

    await configure(mod).click();
    await expectValue('modiversaryMessage', '');
    assert.equal(await modInput.getAttribute('placeholder'), T.modiversary.defaultMessage);
    assert.equal(T.modiversary.defaultMessage, lang === 'en'
      ? 'Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!'
      : '¡Feliz aniversario de moderación, $(user)! ¡Gracias por tus $(twitch.modiversary) meses como moderador!');
    assert.match(await mod.locator('#notification-help-modiversaryMessage').innerText(), /\$\(twitch\.modiversary\)/);
    const modCustom = 'Moderator $(user): $(twitch.modiversary) months!';
    await modInput.fill(modCustom);
    await save(mod).click();
    await mod.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { modiversaryMessage: modCustom });
    await page.reload();
    await configure(mod).click();
    await expectValue('modiversaryMessage', modCustom);
    await reset(mod).click();
    await expectValue('modiversaryMessage', '');
    await save(mod).click();
    await mod.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { modiversaryMessage: '' });
    // Turning the last notice off turns the shared subscription off too.
    await toggle(streak, T.watchStreak.name).click();
    await checked(streak, T.watchStreak.name, false);
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: false });
    await toggle(mod, T.modiversary.name).click();
    await checked(mod, T.modiversary.name, false);
    assert.deepEqual(writes.at(-1), { modiversaryEnabled: false, enabled: false });
    await toggle(streak, T.watchStreak.name).click();
    await checked(streak, T.watchStreak.name, true);
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: true, modiversaryEnabled: false, enabled: true });
    await checked(mod, T.modiversary.name, false);
    if (lang === 'en' && width === 1440) {
      await configure(streak).click();
      await input.fill('Unsaved fixture');
      rejectSave = true;
      await save(streak).click();
      await save(streak).waitFor({ state: 'visible' });
      await page.getByText('Fixture save failure', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Unsaved fixture', 'failed saves retain edits');
      rejectSave = false;
      canManage = false;
      await page.reload();
      await configure(streak).click();
      assert.equal(await input.isDisabled(), true);
      assert.equal(await save(streak).count(), 0);
      assert.equal(await reset(streak).count(), 0);
      assert.equal(await streak.getByRole('switch').count(), 0, 'read-only: no switch');
      canManage = true;
      stored = null;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      // No subscription yet: turning one notice on creates it with that notice on and the other off.
      await toggle(mod, T.modiversary.name).click();
      await configure(mod).waitFor();
      const created = writes.at(-1);
      assert.deepEqual([created.type, created.version, created.condition], [type, '1', { broadcaster_user_id: '999991', user_id: '698614112' }]);
      assert.deepEqual([created.config.modiversaryEnabled, created.config.watchStreakEnabled], [true, false]);
      assert.deepEqual([created.config.message, created.config.modiversaryMessage], ['', ''], 'default messages are stored as empty (channel language)');
      await checked(streak, T.watchStreak.name, false);
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log(`PASS ${lang} ${width}px: one card per notice, localized defaults, custom save/reload, reset, independent switches${lang === 'en' && width === 1440 ? ', failures, read-only, subscription creation' : ''}`);
    await context.close();
  }
} finally { await browser.close(); }
