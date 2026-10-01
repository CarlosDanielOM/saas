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
const labels = {
  en: { name: 'Chat Notifications', configure: 'Configure', save: 'Save Changes', reset: 'Restore default message', disable: 'Disable', enable: 'Enable' },
  es: { name: 'Notificaciones del chat', configure: 'Configurar', save: 'Guardar Cambios', reset: 'Restaurar mensaje predeterminado', disable: 'Deshabilitar', enable: 'Habilitar' }
};
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
    const card = page.locator('app-event-card').filter({ has: page.getByRole('heading', { name: labels[lang].name, exact: true }) });
    try { await card.getByRole('button', { name: labels[lang].configure, exact: true }).click(); }
    catch (error) { console.error({ url: page.url(), body: await page.locator('body').innerText(), errors }); throw error; }
    const input = card.locator('#control-message');
    const streakControl = card.locator('.lf-config__control').filter({ has: page.locator('#control-message') });
    const modInput = card.locator('#control-modiversaryMessage');
    const modControl = card.locator('.lf-config__control').filter({ has: page.locator('#control-modiversaryMessage') });
    const expectValue = async value => {
      await page.waitForFunction(expected => document.querySelector('#control-message')?.value === expected, value);
      assert.equal(await input.inputValue(), value);
    };
    await expectValue('');
    assert.equal(await input.getAttribute('placeholder'), templates[lang]);
    assert.match(await card.locator('#notification-help-message').innerText(), /\$\(twitch\.streak\)/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal page overflow');
    if (process.env.SAAS_SCREENSHOTS) await card.screenshot({ path: `${process.env.SAAS_SCREENSHOTS}/watch-streak-${lang}-${width}.png` });

    const custom = '$(user): $(twitch.streak) — keep watching!';
    await input.fill(custom);
    await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: true, message: custom, modiversaryEnabled: true, modiversaryMessage: '' });
    await page.reload();
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
    await page.reload(); // The second reload hydrates the populated session cache.
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
    await expectValue(custom);
    await streakControl.getByRole('button', { name: labels[lang].reset, exact: true }).click();
    await expectValue('');
    await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: true, message: '', modiversaryEnabled: true, modiversaryMessage: '' });
    await card.getByRole('button', { name: labels[lang].disable, exact: true }).click();
    await card.getByRole('button', { name: labels[lang].enable, exact: true }).waitFor();
    assert.deepEqual(writes.at(-1), { enabled: false });
    await card.getByRole('button', { name: labels[lang].enable, exact: true }).click();
    await card.getByRole('button', { name: labels[lang].disable, exact: true }).waitFor();
    assert.deepEqual(writes.at(-1), { enabled: true });


    await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
    assert.equal(await modInput.inputValue(), '');
    assert.equal(await modInput.getAttribute('placeholder'), lang === 'en'
      ? 'Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!'
      : '¡Feliz aniversario de moderación, $(user)! ¡Gracias por tus $(twitch.modiversary) meses como moderador!');
    assert.match(await card.locator('#notification-help-modiversaryMessage').innerText(), /\$\(twitch\.modiversary\)/);
    const modCustom = 'Moderator $(user): $(twitch.modiversary) months!';
    await modInput.fill(modCustom);
    await card.locator('#control-watchStreakEnabled').uncheck();
    await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: false, message: '', modiversaryEnabled: true, modiversaryMessage: modCustom });
    await page.reload();
    await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
    await page.waitForFunction(value => document.querySelector('#control-modiversaryMessage')?.value === value, modCustom);
    assert.equal(await card.locator('#control-watchStreakEnabled').isChecked(), false);
    assert.equal(await card.locator('#control-modiversaryEnabled').isChecked(), true);
    await modControl.getByRole('button', { name: labels[lang].reset, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#control-modiversaryMessage')?.value === '');
    await card.locator('#control-modiversaryEnabled').uncheck();
    await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card.locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { watchStreakEnabled: false, message: '', modiversaryEnabled: false, modiversaryMessage: '' });
    if (lang === 'en' && width === 1440) {
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
      await input.fill('Unsaved fixture');
      rejectSave = true;
      await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
      await card.getByRole('button', { name: labels[lang].save, exact: true }).waitFor({ state: 'visible' });
      await page.getByText('Fixture save failure', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Unsaved fixture', 'failed saves retain edits');
      rejectSave = false;
      canManage = false;
      await page.reload();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
      assert.equal(await input.isDisabled(), true);
      assert.equal(await card.getByRole('button', { name: labels[lang].save, exact: true }).count(), 0);
      assert.equal(await streakControl.getByRole('button', { name: labels[lang].reset, exact: true }).count(), 0);
      canManage = true;
      stored = null;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await card.getByRole('button', { name: labels[lang].enable, exact: true }).click();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
      assert.deepEqual(writes.at(-1), { type, version: '1', condition: { broadcaster_user_id: '999991', user_id: '698614112' }, config: { watchStreakEnabled: true, message: '', modiversaryEnabled: true, modiversaryMessage: '' } });
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log(`PASS ${lang} ${width}px: localized streak/modiversary defaults, custom save/reload, independent controls, reset, toggle${lang === 'en' && width === 1440 ? ', failures, read-only, subscription creation' : ''}`);
    await context.close();
  }
} finally { await browser.close(); }
