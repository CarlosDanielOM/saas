// Every external request is intercepted; these fixtures never change live settings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const definitions = [
  ['channel.subscribe', 'New subscriptions', 'Nuevas suscripciones', 'Star',
    'Welcome new subscribers, including viewers who receive a gift subscription.',
    'Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada.',
    'Thanks $(user) for subscribing at $(sub.tier)!'],
  ['channel.subscription.gift', 'Gifted subscriptions', 'Suscripciones regaladas', 'Heart',
    'Thank subscription gifts with one message per gift batch, including anonymous gifts.',
    'Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos.',
    'Thank you for the gifted $(sub.tier) subscriptions!'],
  ['channel.subscription.message', 'Resubscription messages', 'Mensajes de resuscripción', 'MessageCircle',
    'Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.',
    'Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje.',
    'Thanks $(user) for $(sub.months) months of support at $(sub.tier)!'],
  ['channel.subscription.end', 'Subscription endings', 'Suscripciones finalizadas', 'Clock',
    'Post a message when a subscription expires. Leave the message empty to stay silent.',
    'Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo.', '']
];
const catalog = definitions.map(([type, name, , icon, EN, ES, message]) => ({
  name, type, icon, version: '1', condition: { broadcaster_user_id: 'user' },
  releaseStage: 'stable', enabled: false, plan_tier: 'free', description: { EN, ES },
  config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: message, canDisable: true }]
}));

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/subscription-chat-events-web';
fs.mkdirSync(artifacts, { recursive: true });
const labels = {
  en: { configure: 'Configure', save: 'Save Changes', community: 'Community moments' },
  es: { configure: 'Configurar', save: 'Guardar Cambios', community: 'Momentos de la comunidad' }
};
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const lang of ['en', 'es']) for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
    const app = { name: 'Viewer', language: lang, plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id,
      has_permissions: true, up_to_date_permissions: true, administrating: [] };
    let stored = catalog.map((event, i) => ({ _id: `fixture-${i}`, id: `twitch-${i}`, type: event.type, version: '1', enabled: true, status: 'enabled', message: event.type === 'channel.subscription.end' ? '' : `Existing ${event.type}` }));
    let canManage = true;
    let rejectSave = false;
    const writes = [];
    await context.addInitScript(({ user, app, lang, theme }) => {
      localStorage.setItem('userLanguage', lang);
      localStorage.setItem('theme', theme);
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
      sessionStorage.setItem('eventsCache:v6:999991', '[]');
    }, { user, app, lang, theme });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.includes('/access')) data = { allowed: !url.searchParams.get('permission')?.endsWith(':manage') || canManage, role: 'owner', planTier: 'free' };
      else if (url.pathname === '/site/events') data = catalog;
      else if (url.pathname.startsWith('/eventsubs/')) {
        if (request.method() === 'PATCH') {
          const payload = request.postDataJSON();
          writes.push({ method: 'PATCH', payload });
          if (rejectSave) return route.fulfill({ status: 500, json: { error: true, message: 'Fixture save failure' } });
          const index = stored.findIndex(event => url.pathname.endsWith('/' + event._id));
          assert.ok(index >= 0);
          stored[index] = { ...stored[index], ...payload };
          data = stored[index];
        } else if (request.method() === 'POST') {
          const payload = request.postDataJSON();
          writes.push({ method: 'POST', payload });
          data = { _id: 'created-subscription', ...payload, ...payload.config, enabled: true };
          stored.push(data);
        } else data = stored;
      } else if (url.pathname.includes('/live-status')) data = { isLive: false };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/viewer/modules/chat-events`);
    for (const [index, definition] of definitions.entries()) {
      const type = definition[0];
      const name = definition[lang === 'en' ? 1 : 2];
      const template = catalog[index];
      const card = page.locator('app-event-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click().catch(async error => {
        console.error({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 5000), errors });
        throw error;
      });
      const input = card.locator('#control-message');
      assert.equal(await input.inputValue(), type === 'channel.subscription.end' ? '' : `Existing ${type}`);
      await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
      const axe = await new AxeBuilder({ page }).include('app-chat-events-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(axe.violations, [], 'chat events accessibility');
      await page.screenshot({ path: `${artifacts}/subscription-${index}-${lang}-${theme}-${width}.png`, fullPage: true });
      const custom = 'Thanks $(user) for your $(sub.tier) support!';
      await input.fill(custom);
      await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
      await card.locator('app-config-panel').waitFor({ state: 'hidden' });
      assert.deepEqual(writes.at(-1), { method: 'PATCH', payload: { message: custom } });
      await page.reload();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
      await page.reload(); // Also exercises the new session cache.
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).click().catch(async error => {
        console.error({ scenario: { lang, theme, width, type }, url: page.url(),
          body: (await page.locator('body').innerText()).slice(0, 5000),
          cache: await page.evaluate(() => sessionStorage.getItem('eventsCache:v7:999991')), errors });
        throw error;
      });
      assert.equal(await input.inputValue(), custom);
      const toggle = card.getByRole('switch', { name });
      await toggle.click();
      await page.waitForFunction(name => [...document.querySelectorAll('app-event-card [role=switch]')].find(el => el.getAttribute('aria-label') === name)?.getAttribute('aria-checked') === 'false', name);
      assert.deepEqual(writes.at(-1).payload, { enabled: false });
      await toggle.click();
      await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
      assert.deepEqual(writes.at(-1).payload, { enabled: true });

      if (lang === 'en' && theme === 'dark' && width === 1280) {
        await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
        await input.fill('Unsaved fixture');
        rejectSave = true;
        await card.getByRole('button', { name: labels[lang].save, exact: true }).click();
        await page.getByText('Fixture save failure', { exact: true }).waitFor();
        assert.equal(await input.inputValue(), 'Unsaved fixture');
        rejectSave = false;
        canManage = false;
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await card.getByRole('heading', { name }).waitFor();
        await card.getByRole('button', { name: labels[lang].configure, exact: true }).click();
        assert.equal(await input.isDisabled(), true);
        assert.equal(await card.getByRole('switch').count(), 0);
        assert.equal(await card.getByRole('button', { name: labels[lang].save, exact: true }).count(), 0);
        canManage = true;
        stored = stored.filter(event => event.type !== type);
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await card.getByRole('switch').click();
        await card.getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
        assert.deepEqual(writes.at(-1), { method: 'POST', payload: { type, version: '1',
          condition: { broadcaster_user_id: user.id },
          config: { message: template.config[0].value } } });
      }
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    await context.close();
    console.log(`All four subscription editors passed: ${lang}, ${theme}, ${width}px`);
  }
} finally {
  await browser.close();
}
