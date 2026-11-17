// "Poll ended" and "Prediction ended" on the Chat events page (dimasite), in the real app with every
// API call intercepted: both languages, both themes, 320 / 390 / 1280 px, accessibility, saving a
// script, turning it off and on, removing it, and turning it on for a channel that never had it.
// Also the message box itself: it wraps and grows so a long script shows in full (also as the
// placeholder), and stays one line of chat (Enter and pasted line breaks never add a line).
//   scripts/saas-ops verify site-<run-id> --check ops/checks/poll-ended-chat-events-web.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// The same entries the API serves (dimabot/src/utils/chat_event_catalog.ts).
const definitions = [
  ['channel.poll.end', 'Poll ended', 'Fin de la encuesta',
    'Runs when a Twitch poll finishes with a result. Use $(poll.result) and $(poll.tied) to announce the winner or break a tie. A canceled poll stays silent.',
    'Se ejecuta cuando una encuesta de Twitch termina con resultado. Usa $(poll.result) y $(poll.tied) para anunciar la opción ganadora o desempatar. Una encuesta cancelada no envía nada.',
    '*($(poll.tied) ? "The poll ended in a tie!" : "${$(poll.result)} won the poll!")'],
  ['channel.prediction.end', 'Prediction ended', 'Fin de la predicción',
    'Runs when you choose the winning outcome of a Twitch prediction. Use $(prediction.result) to announce it. A canceled prediction stays silent.',
    'Se ejecuta cuando eliges el resultado ganador de una predicción de Twitch. Usa $(prediction.result) para anunciarlo. Una predicción cancelada no envía nada.',
    '$(prediction.result) won the prediction!']
];
const entry = (type, name, icon, EN, ES, message) => ({
  name, type, icon, version: '1', condition: { broadcaster_user_id: 'user' }, color: '#7c3aed', textColor: '#ffffff',
  releaseStage: 'stable', enabled: false, plan_tier: 'free', description: { EN, ES },
  config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: message, canDisable: true }]
});
const catalog = [
  entry('channel.follow', 'Follows', 'UserPlus', 'Thank new followers.', 'Agradece a quienes te siguen.', 'Thanks $(user)!'),
  entry('stream.online', 'Stream Started', 'Play', 'Announce the stream start.', 'Anuncia el inicio del stream.', 'We are live!'),
  ...definitions.map(([type, name, , EN, ES, message]) => entry(type, name, 'Trophy', EN, ES, message))
];

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/poll-ended-chat-events-web';
fs.mkdirSync(artifacts, { recursive: true });
const labels = {
  en: { configure: 'Configure', save: 'Save Changes', stream: 'Your stream', hint: 'Messages tied to your broadcast: starting, ending, ad breaks, polls and predictions.' },
  es: { configure: 'Configurar', save: 'Guardar cambios', stream: 'Tu stream', hint: 'Mensajes al iniciar o terminar tu transmisión, en pausas publicitarias y al terminar encuestas y predicciones.' }
};
const TIE_BREAK = '*($(poll.tied) ? "${$(roulette.fill polls $(poll.tied))}${$(roulette.start polls)}Tie! The wheel decides." : "${$(poll.result)} won the poll!")';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const lang of ['en', 'es']) for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const full = lang === 'en' && theme === 'dark' && width === 1280;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const user = { id: '999991', login: 'viewer', display_name: 'Viewer' };
    const app = { name: 'Viewer', language: lang, plan_tier: 'free', actived: true, chat_enabled: true, twitch_user_id: user.id,
      has_permissions: true, up_to_date_permissions: true, administrating: [] };
    // The poll widget already turned the poll notification on (empty message); the prediction one was never subscribed.
    let stored = [
      { _id: 'fixture-follow', id: 'twitch-follow', type: 'channel.follow', version: '2', enabled: true, status: 'enabled', message: 'Thanks $(user)!' },
      { _id: 'fixture-poll', id: 'twitch-poll-end', type: 'channel.poll.end', version: '1', enabled: true, status: 'enabled', message: '' },
      // Not chat events: the page must not show them.
      { _id: 'fixture-progress', id: 'twitch-poll-progress', type: 'channel.poll.progress', version: '1', enabled: true, status: 'enabled', message: '' }
    ];
    const writes = [];
    await context.addInitScript(({ user, app, lang, theme }) => {
      localStorage.setItem('userLanguage', lang);
      localStorage.setItem('theme', theme);
      localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    }, { user, app, lang, theme });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.includes('/access')) data = { allowed: true, role: 'owner', planTier: 'free' };
      else if (url.pathname === '/site/events') data = catalog;
      else if (url.pathname.startsWith('/eventsubs/')) {
        const index = stored.findIndex(event => url.pathname.endsWith('/' + event._id));
        if (request.method() === 'PATCH') {
          const payload = request.postDataJSON();
          writes.push({ method: 'PATCH', id: stored[index]?._id, payload });
          assert.ok(index >= 0);
          stored[index] = { ...stored[index], ...payload };
          data = stored[index];
        } else if (request.method() === 'DELETE') {
          writes.push({ method: 'DELETE', id: stored[index]?._id });
          assert.ok(index >= 0);
          // The API keeps the Twitch subscription the overlays share (and the message) and only turns the event off.
          stored[index] = { ...stored[index], enabled: false };
          return route.fulfill({ json: { error: false, status: 200, message: 'Eventsub deleted' } });
        } else if (request.method() === 'POST') {
          const payload = request.postDataJSON();
          writes.push({ method: 'POST', payload });
          data = { _id: 'created-subscription', id: 'twitch-created', status: 'enabled', ...payload, ...payload.config, enabled: true };
          stored.push(data);
        } else data = stored;
      } else if (url.pathname.includes('/live-status')) data = { isLive: false };
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fail = async (error, what) => {
      console.error({ scenario: { lang, theme, width, what }, url: page.url(), body: (await page.locator('body').innerText()).slice(0, 3000), errors, writes });
      throw error;
    };
    await page.goto(`${base}/viewer/modules/chat-events`);
    const card = name => page.locator('app-event-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const [pollName, predictionName] = definitions.map(definition => definition[lang === 'en' ? 1 : 2]);
    await card(pollName).waitFor().catch(error => fail(error, 'poll card'));
    await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);

    // Both cards sit in "Your stream", after the stream events, with their own description and hint.
    const section = page.locator('section.lf-section').filter({ has: page.getByRole('heading', { name: labels[lang].stream, exact: true }) });
    const names = await section.locator('app-event-card h3.lf-ev__name').allTextContents();
    assert.deepEqual(names.map(name => name.trim()).slice(-2), [pollName, predictionName], 'poll and prediction cards close the stream group');
    assert.equal((await section.locator('.lf-section__hint').textContent()).trim(), labels[lang].hint);
    for (const [index, definition] of definitions.entries()) {
      await card(definition[lang === 'en' ? 1 : 2]).getByText(definition[lang === 'en' ? 3 : 4], { exact: true }).waitFor().catch(error => fail(error, `description ${index}`));
    }
    assert.equal(await page.locator('app-event-card').count(), 4, 'poll progress is not offered as a chat event');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');

    // Poll ended: subscribed by the overlay widget with no message yet. The default shows as a placeholder.
    await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).click().catch(error => fail(error, 'configure poll'));
    const input = card(pollName).locator('#control-message');
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.getAttribute('placeholder'), definitions[0][5]);
    assert.equal(await input.evaluate(el => el.tagName), 'TEXTAREA', 'the message box wraps');
    const lineHeight = await input.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
    const lines = async () => Math.round(((await input.boundingBox()).height - (await input.evaluate(el => {
      const style = getComputedStyle(el); return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    }))) / lineHeight);
    // The default message is the placeholder: on a phone it needs several lines and gets them.
    if (width <= 390) assert.ok(await lines() >= 2, `placeholder shows in full at ${width}px (${await lines()} lines)`);
    assert.ok((await input.boundingBox()).height >= 44, 'touch target');
    assert.ok(parseFloat(await input.evaluate(el => getComputedStyle(el).fontSize)) >= 16, 'no zoom on iOS');
    const axe = await new AxeBuilder({ page }).include('app-chat-events-page').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target).join(' ')}`), [], 'chat events accessibility');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow with the editor open');
    await page.screenshot({ path: `${artifacts}/poll-ended-${lang}-${theme}-${width}.png`, fullPage: true });
    await input.fill(TIE_BREAK);
    // The whole script is visible: wrapped onto more lines, nothing clipped or scrolled away.
    const before = await lines();
    assert.ok(before >= 2, `a long script wraps at ${width}px (${before} lines)`);
    assert.equal(await input.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), true, 'nothing is clipped');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow with a long script');
    await page.screenshot({ path: `${artifacts}/poll-ended-script-${lang}-${theme}-${width}.png`, fullPage: true });
    // A chat message is one line: Enter adds nothing, and a pasted line break becomes a space.
    await input.press('End');
    await input.press('Enter');
    assert.equal(await input.inputValue(), TIE_BREAK);
    await input.fill('First line\nsecond line');
    assert.equal(await input.inputValue(), 'First line second line');
    assert.equal(await lines(), 1, 'the box shrinks back with short text');
    // Only the break changes: the spaces around it stay, and Windows line ends count once.
    await input.fill('A  \r\n  B');
    assert.equal(await input.inputValue(), 'A     B');
    // Pasting "A<break>B" over "A B" gives the same saved text as before: the box must still show
    // what is saved, and Save must send exactly that.
    await input.fill('A B');
    await input.fill('A\nB');
    assert.equal(await input.inputValue(), 'A B', 'the box shows what will be saved');
    await card(pollName).getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card(pollName).locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'fixture-poll', payload: { message: 'A B' } });
    await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).click();
    assert.equal(await input.inputValue(), 'A B');
    // Emptied again: the placeholder is sized on a hidden copy, so the box itself stays empty and undo still works.
    await input.fill('');
    await input.pressSequentially('abc');
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    assert.equal(await input.inputValue(), '');
    if (width <= 390) assert.ok(await lines() >= 2, 'the placeholder shows in full again');
    assert.equal(await page.locator('textarea[aria-hidden="true"]').count(), 0, 'no measuring copy is left behind');
    await input.press('ControlOrMeta+z');
    assert.equal(await input.inputValue(), 'abc', 'undo brings the text back');
    await input.fill(TIE_BREAK);
    if (full) {
      // Rotating the phone / resizing with the editor open: the box follows the new width.
      const wide = await lines();
      await page.setViewportSize({ width: 360, height: 1000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#control-message')].every(el => el.scrollHeight <= el.clientHeight + 1));
      assert.ok(await lines() > wide, `more lines after narrowing (${wide} -> ${await lines()})`);
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#control-message')].every(el => el.scrollHeight <= el.clientHeight + 1));
      assert.equal(await lines(), wide, 'and back');
    }
    await card(pollName).getByRole('button', { name: labels[lang].save, exact: true }).click();
    await card(pollName).locator('app-config-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'fixture-poll', payload: { message: TIE_BREAK } });
    await page.reload();
    await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).click().catch(error => fail(error, 'configure after reload'));
    assert.equal(await input.inputValue(), TIE_BREAK, 'the script survives a reload');
    await page.waitForFunction(() => [...document.querySelectorAll('#control-message')].every(el => el.scrollHeight <= el.clientHeight + 1));
    assert.ok(await lines() >= 2, 'a loaded script is shown in full too');

    if (full) {
      // Off and on again.
      const toggle = card(pollName).getByRole('switch', { name: pollName });
      await toggle.click();
      await page.waitForFunction(name => [...document.querySelectorAll('app-event-card [role=switch]')].find(el => el.getAttribute('aria-label') === name)?.getAttribute('aria-checked') === 'false', pollName);
      assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'fixture-poll', payload: { enabled: false } });
      await toggle.click();
      await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).waitFor();
      assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'fixture-poll', payload: { enabled: true } });

      // Prediction ended was never subscribed: turning it on creates it with the default message.
      await card(predictionName).getByRole('switch').click();
      await card(predictionName).getByRole('button', { name: labels[lang].configure, exact: true }).waitFor().catch(error => fail(error, 'prediction on'));
      assert.deepEqual(writes.at(-1), { method: 'POST', payload: { type: 'channel.prediction.end', version: '1',
        condition: { broadcaster_user_id: user.id }, config: { message: definitions[1][5] } } });

      // Removing "Poll ended" asks first, then the page shows it off.
      await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).click();
      page.once('dialog', dialog => dialog.accept());
      await card(pollName).getByRole('button', { name: /delete|remove/i }).click().catch(error => fail(error, 'delete poll'));
      await page.waitForFunction(() => true);
      await assert.doesNotReject(async () => {
        const deadline = Date.now() + 10000;
        while (writes.at(-1)?.method !== 'DELETE') { if (Date.now() > deadline) throw new Error('no DELETE request'); await page.waitForTimeout(100); }
      });
      assert.deepEqual(writes.at(-1), { method: 'DELETE', id: 'fixture-poll' });
      await page.waitForFunction(name => [...document.querySelectorAll('app-event-card [role=switch]')].find(el => el.getAttribute('aria-label') === name)?.getAttribute('aria-checked') === 'false', pollName)
        .catch(error => fail(error, 'poll card off after delete'));
      // Turning it back on brings the same script back: what the page shows is what runs, also after a reload.
      await card(pollName).getByRole('switch').click();
      await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).waitFor().catch(error => fail(error, 'poll on again'));
      assert.deepEqual(writes.at(-1), { method: 'PATCH', id: 'fixture-poll', payload: { enabled: true } });
      await page.reload();
      await card(pollName).getByRole('button', { name: labels[lang].configure, exact: true }).click().catch(error => fail(error, 'configure after re-enable'));
      assert.equal(await input.inputValue(), TIE_BREAK, 'the script is still there after delete, re-enable and reload');
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    await context.close();
    console.log(`Poll ended / Prediction ended cards passed: ${lang}, ${theme}, ${width}px${full ? ' (with toggle, create and delete)' : ''}`);
  }
} finally {
  await browser.close();
}
console.log('PASS site: Poll ended and Prediction ended chat events');
