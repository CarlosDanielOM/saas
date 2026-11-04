import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Profile → Danger zone: factory reset (POST /auth/factory-reset) and account deletion (DELETE /auth/account).
// Every API call is mocked; nothing reaches production.
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4217';
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const SESSION_KEY = 'dimasite.session.v1';

async function until(fn, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

async function setTheme(page, theme) {
  await page.evaluate(name => {
    document.documentElement.classList.toggle('dark', name === 'dark');
    document.documentElement.setAttribute('data-theme', name);
  }, theme);
}

async function axeClean(page, include, label) {
  const axe = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], label);
}

const TEXT = {
  en: {
    zone: 'Danger zone', reset: 'Reset account', del: 'Delete account', cancel: 'Cancel',
    resetTitle: 'Reset your account?', deleteTitle: 'Delete your account forever?',
    resetConfirm: 'Reset my account', deleteConfirm: 'Delete my account', typeLabel: 'Type test to confirm',
    mismatch: /Type your Twitch name exactly/, resetError: /couldn't finish the reset/, deleteError: /couldn't delete your account/,
    kept: 'Default commands, back to their original settings', dimafx: /Your DimaFX shop is deleted/, plan: /doesn't cancel your Premium plan/,
    resetDone: 'Account reset', deleteDone: 'Account deleted'
  },
  es: {
    zone: 'Zona de peligro', reset: 'Restablecer cuenta', del: 'Eliminar cuenta', cancel: 'Cancelar',
    resetTitle: '¿Restablecer tu cuenta?', deleteTitle: '¿Eliminar tu cuenta para siempre?',
    resetConfirm: 'Restablecer mi cuenta', deleteConfirm: 'Eliminar mi cuenta', typeLabel: 'Escribe test para confirmar',
    mismatch: /Escribe tu nombre de Twitch/, resetError: /No pudimos terminar el restablecimiento/, deleteError: /No pudimos eliminar tu cuenta/,
    kept: 'Los comandos predeterminados, con su configuración original', dimafx: /Se borra tu tienda DimaFX/, plan: /no cancela tu plan Premium/,
    resetDone: 'Cuenta restablecida', deleteDone: 'Cuenta eliminada'
  }
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [tier, language] of [['free', 'en'], ['premium', 'es']]) {
    const L = TEXT[language];
    const context = await browser.newContext();
    const twitch = { id: '999991', login: 'test', display_name: 'Test Streamer' };
    const app = {
      name: 'Test Streamer', email: 'test@example.invalid', language, plan_tier: tier,
      plan_tier_until: tier === 'free' ? null : '2026-12-14T12:00:00.000Z',
      actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true,
      up_to_date_permissions: true, administrating: []
    };
    // Seed the session only once, so the post-delete sign-out can be observed.
    await context.addInitScript(({ twitch, app, key }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(key, JSON.stringify({
        version: 2, token: 'test-only', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), twitchUser: twitch, appUser: app, permissions: {}
      }));
    }, { twitch, app, key: SESSION_KEY });

    const calls = { reset: [], del: [] };
    let failReset = true;
    let failDelete = true;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      if (url.pathname === '/auth/factory-reset') {
        assert.equal(request.method(), 'POST');
        assert.equal(request.headers().authorization, 'Bearer test-only');
        calls.reset.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 400));
        if (failReset) {
          failReset = false;
          return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Internal server error' } });
        }
        return route.fulfill({ status: 200, json: { error: false, status: 200, message: 'Factory reset completed', data: { commandsDeleted: 4 } } });
      }
      if (url.pathname === '/auth/account') {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
        assert.equal(request.method(), 'DELETE');
        assert.equal(request.headers().authorization, 'Bearer test-only');
        calls.del.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 400));
        if (failDelete) {
          failDelete = false;
          return route.fulfill({ status: 500, json: { error: true, status: 500, message: 'Internal server error' } });
        }
        return route.fulfill({ status: 200, json: { error: false, status: 200, message: 'Account and related data deleted permanently', data: { usersDeleted: 1 } } });
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

    const zone = page.locator('app-profile-page section.lf-danger');
    await zone.waitFor();
    await zone.getByRole('heading', { name: L.zone }).waitFor();
    const resetBtn = zone.getByRole('button', { name: L.reset });
    const deleteBtn = zone.getByRole('button', { name: L.del });
    await resetBtn.waitFor();
    await deleteBtn.waitFor();
    const dialog = page.getByRole('alertdialog');

    // Layout, touch targets, contrast and axe for the zone at phone + desktop sizes, both themes.
    for (const [width, height, theme] of [[320, 700, 'dark'], [390, 844, 'light'], [1280, 900, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await setTheme(page, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}px`);
      for (const btn of [resetBtn, deleteBtn]) {
        const box = await btn.boundingBox();
        assert.ok(box && box.height >= 44, `touch target at ${width}px`);
        assert.notEqual(await btn.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', `button bg ${theme}`);
      }
      if (shots) await zone.screenshot({ path: `${shots}/danger-zone-${tier}-${width}-${theme}.png` });
      await axeClean(page, 'app-profile-page', `${tier} danger zone axe at ${width}px ${theme}`);
    }

    // ---- Factory reset ----
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'dark');
    await resetBtn.click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('heading', { level: 2 }).innerText(), L.resetTitle);
    await until(() => dialog.evaluate(el => el.contains(document.activeElement)), 'focus moves into dialog');
    await dialog.getByText(L.kept).waitFor();
    assert.equal(await dialog.locator('.lf-billing-warn').count(), 0, 'reset never shows billing warning');

    // Escape cancels without calling the API and returns focus to the trigger.
    await page.keyboard.press('Escape');
    await until(async () => (await dialog.count()) === 0, 'escape closes reset dialog');
    await until(() => resetBtn.evaluate(el => el === document.activeElement), 'focus returns to reset button');

    // Cancel and overlay click also close; still no API call.
    await resetBtn.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: L.cancel }).click();
    await until(async () => (await dialog.count()) === 0, 'cancel closes');
    await resetBtn.click();
    await dialog.waitFor();
    await page.mouse.click(5, 5);
    await until(async () => (await dialog.count()) === 0, 'overlay click closes');
    assert.equal(calls.reset.length, 0, 'closing must never call the API');

    // Confirming without the name (or with the wrong name) only shows an inline error.
    await resetBtn.click();
    await dialog.waitFor();
    const confirmReset = dialog.locator('footer button[type=submit]');
    await confirmReset.click();
    await dialog.getByText(L.mismatch).waitFor();
    const input = dialog.getByLabel(L.typeLabel);
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    await input.fill('someone-else');
    await input.press('Enter');
    await page.waitForTimeout(150);
    assert.equal(calls.reset.length, 0, 'wrong name must not call the API');

    for (const [width, height, theme] of [[320, 700, 'dark'], [390, 844, 'light'], [1280, 900, 'dark'], [1280, 900, 'light']]) {
      await page.setViewportSize({ width, height });
      await setTheme(page, theme);
      const box = await dialog.boundingBox();
      assert.ok(box && box.width <= width && box.height <= height, `dialog fits at ${width}px`);
      if (shots) await page.screenshot({ path: `${shots}/danger-reset-dialog-${tier}-${width}-${theme}.png` });
      await axeClean(page, '[role=alertdialog]', `${tier} reset dialog axe at ${width}px ${theme}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // Name matches case-insensitively (and with a leading @). First attempt fails on the server.
    await input.fill('@TEST');
    await confirmReset.click();
    await until(() => confirmReset.isDisabled(), 'confirm disables while working');
    await page.keyboard.press('Escape');
    await confirmReset.click({ force: true, timeout: 500 }).catch(() => {});
    assert.equal(await dialog.count(), 1, 'escape is ignored while working');
    const resetAlert = dialog.getByRole('alert');
    await resetAlert.waitFor();
    assert.match(await resetAlert.innerText(), L.resetError);
    assert.equal(calls.reset.length, 1, 'no duplicate request while working');
    await until(async () => !(await confirmReset.isDisabled()), 'confirm re-enables after error');
    assert.equal(await input.inputValue(), '@TEST', 'typed name kept after an error');

    // Retry succeeds: dialog closes, success toast, still signed in on the profile page.
    await confirmReset.click();
    await until(async () => (await dialog.count()) === 0, 'dialog closes after reset');
    await page.getByText(L.resetDone, { exact: true }).first().waitFor();
    assert.equal(calls.reset.length, 2);
    assert.ok(page.url().startsWith(`${base}/test/profile`));
    assert.ok(await page.evaluate(key => !!localStorage.getItem(key), SESSION_KEY), 'reset keeps the session');

    // ---- Delete account ----
    await deleteBtn.click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('heading', { level: 2 }).innerText(), L.deleteTitle);
    await dialog.getByText(L.dimafx).waitFor();
    assert.equal(await page.getByText(L.dimafx).count(), 1, 'DimaFX line only in the delete dialog');
    const warn = dialog.locator('.lf-billing-warn');
    if (tier === 'free') {
      assert.equal(await warn.count(), 0, 'free plan has no billing warning');
    } else {
      await warn.waitFor();
      assert.match(await warn.innerText(), L.plan);
      await warn.getByRole('button').waitFor();
    }
    for (const theme of ['dark', 'light']) {
      await setTheme(page, theme);
      await axeClean(page, '[role=alertdialog]', `${tier} delete dialog axe ${theme}`);
      if (shots) await page.screenshot({ path: `${shots}/danger-delete-dialog-${tier}-390-${theme}.png` });
    }
    const delInput = dialog.getByLabel(L.typeLabel);
    assert.equal(await delInput.inputValue(), '', 'confirm text starts empty on each open');
    const confirmDelete = dialog.locator('footer button[type=submit]');
    await confirmDelete.click();
    await dialog.getByText(L.mismatch).waitFor();
    assert.equal(calls.del.length, 0);

    await delInput.fill('test');
    await confirmDelete.click();
    const delAlert = dialog.getByRole('alert');
    await delAlert.waitFor();
    assert.match(await delAlert.innerText(), L.deleteError);
    assert.ok(await page.evaluate(key => !!localStorage.getItem(key), SESSION_KEY), 'failed delete keeps the session');

    await until(async () => !(await confirmDelete.isDisabled()), 'delete re-enables');
    await confirmDelete.click();
    await page.waitForURL(url => new URL(url).pathname === '/login', { timeout: 8000 });
    assert.equal(calls.del.length, 2);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), SESSION_KEY), null, 'delete signs the user out');
    await page.getByText(L.deleteDone, { exact: true }).first().waitFor();

    assert.deepEqual(errors, [], `${tier} browser errors`);
    await context.close();
  }
  console.log('PASS profile danger zone: reset + delete (en/es, free/premium), typed-name guard, escape/cancel/overlay never call API, error + retry, no duplicate requests, delete signs out, plan warning only on paid plans, 44px targets, no overflow, axe clean at 320/390/1280 dark/light');
} finally {
  await browser.close();
}
