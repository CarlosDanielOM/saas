import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const user = { id: '991505', login: 'pet_owner', display_name: 'Pet Owner' };
const seed = () => ({ schemaVersion: 1, revision: 0, updatedAt: null,
  settings: { enabled: false, name: 'Dima', tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' },
    personality: { source: 'custom', profileId: '', prompt: 'A friendly virtual companion.' }, rules: [],
    behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280 } },
  profiles: [{ id: 'p1', name: 'Co-host' }, { id: 'p2', name: 'Storyteller' }],
  voices: [{ provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' },
    { provider: 'piper', id: 'en_US-ryan-medium', name: 'Ryan', language: 'en' },
    { provider: 'kokoro', id: 'ef_dora', name: 'Dora', language: 'es' },
    { provider: 'kokoro', id: 'af_heart', name: 'Heart', language: 'en' },
    { provider: 'fish', id: '7b5626abdaa044babfc3829ec15acf31', name: 'Gojo', language: 'any' }],
  runtime: { enabled: false, issues: [], playbackAvailable: false } });
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open({ theme = 'dark', width = 1280, language = 'en', tier = 'premium', failLoad = false, noProfiles = false } = {}) {
  const app = { name: 'Pet Owner', email: 'pet@example.invalid', language, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  let doc = seed(); if (noProfiles) doc.profiles = [];
  const state = { writes: [], saveError: null, failLoad, reads: 0 };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, theme, language });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/pet_owner/')) {
        const response = await route.fetch({ url: base + '/index.csr.html' });
        return route.fulfill({ response });
      }
      return route.continue();
    }
    if (url.origin !== 'https://api.domdimabot.com') return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    if (url.pathname === `/pets/${user.id}/settings`) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON(); state.writes.push(body);
        if (state.saveError) return route.fulfill({ status: state.saveError === 'settings_conflict' ? 409 : 503,
          json: { error: true, message: state.saveError } });
        doc = { ...doc, revision: doc.revision + 1, settings: body.settings };
      } else {
        state.reads++;
        if (state.failLoad) return route.fulfill({ status: 503, json: { error: true, message: 'temporarily_unavailable' } });
      }
      return ok(doc);
    }
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.startsWith('/auth/access/')) return ok({ allowed: true });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: tier });
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/pet_owner/modules/pet');
  if (tier !== 'free') await page.locator('app-pet-page').waitFor();
  return { context, page, state };
}
const save = page => page.getByRole('button', { name: 'Save changes', exact: true });
const saveState = (page, disabled) => page.waitForFunction(expected => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Save changes' && button.disabled === expected), disabled);
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-pet-page'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  {
    const { page, context, state } = await open();
    await page.getByText('No unsaved changes', { exact: true }).waitFor();
    await saveState(page, true);
    await page.getByRole('textbox', { name: 'Pet name' }).fill('Luna');
    await page.getByRole('checkbox', { name: 'Enable pet responses' }).check();
    await page.getByRole('button', { name: /Kokoro/ }).click();
    await page.waitForFunction(() => document.querySelector('select[formcontrolname=voice]')?.value === 'ef_dora');
    await page.getByRole('combobox', { name: 'Reply language' }).selectOption('en');
    await page.waitForFunction(() => document.querySelector('select[formcontrolname=voice]')?.value === 'af_heart');
    await page.getByRole('combobox', { name: 'Personality source' }).selectOption('profile');
    await saveState(page, true);
    await page.getByRole('combobox', { name: 'AI personality profile', exact: true }).selectOption('p2');
    await page.getByRole('textbox', { name: 'Extra pet rules' }).fill('No spoilers\nBe kind');
    await page.getByRole('spinbutton', { name: 'Seconds between responses' }).fill('35');
    await save(page).click();
    await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].revision, 0);
    assert.equal(state.writes[0].settings.personality.profileId, 'p2');
    assert.equal(state.writes[0].settings.tts.provider, 'kokoro');
    assert.equal(state.writes[0].settings.behavior.cooldownSeconds, 35);
    assert.deepEqual(state.writes[0].settings.rules, ['No spoilers','Be kind']);
    // Reload persists the saved settings; discard restores the last save.
    await page.reload(); await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Pet name' }).inputValue(), 'Luna');
    await page.getByRole('textbox', { name: 'Pet name' }).fill('Discard me');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Pet name' }).inputValue(), 'Luna');
    // Provider changes, custom voices, and field validation.
    await page.getByRole('button', { name: /Fish Audio/ }).click();
    await page.getByText('Custom Fish voice', { exact: true }).click();
    const custom = page.getByRole('textbox', { name: 'Public voice reference ID' });
    await custom.fill('bad'); await saveState(page, true);
    await custom.fill('0123456789abcdef0123456789abcdef');
    await page.getByRole('spinbutton', { name: 'Maximum reply characters' }).fill('501');
    await saveState(page, true);
    await page.getByRole('spinbutton', { name: 'Maximum reply characters' }).fill('300');
    await save(page).click(); await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    assert.equal(state.writes.at(-1).settings.tts.voice, '0123456789abcdef0123456789abcdef');
    // Save failure and conflict retain the draft; retry sends the same revision.
    state.saveError = 'temporarily_unavailable';
    await page.getByRole('textbox', { name: 'Pet name' }).fill('Keep this draft');
    await save(page).click(); await page.getByText(/Could not save your pet/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Pet name' }).inputValue(), 'Keep this draft');
    state.saveError = 'settings_conflict';
    await save(page).click(); await page.getByText(/changed in another tab/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Pet name' }).inputValue(), 'Keep this draft');
    state.saveError = null;
    await save(page).click(); await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    await context.close();
  }
  {
    const { page, context, state } = await open({ failLoad: true });
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    state.failLoad = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    assert.equal(state.reads, 2); await context.close();
  }
  {
    const { page, context } = await open({ noProfiles: true });
    await page.getByRole('combobox', { name: 'Personality source' }).selectOption('profile');
    await page.getByText(/Create an AI personality profile first/).waitFor();
    await saveState(page, true); await context.close();
  }
  {
    const { page, context, state } = await open({ tier: 'free' });
    await page.waitForURL('**/pet_owner/modules');
    assert.equal(state.reads, 0, 'free users never load pet settings');
    await page.getByRole('button', { name: /Pet/ }).first().waitFor();
    await context.close();
  }
  for (const tier of ['premium','pro']) for (const theme of ['dark','light']) for (const width of [320,390,1280]) {
    const { page, context } = await open({ tier, theme, width });
    await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    await axe(page, `${tier}/${theme}/${width}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `overflow ${tier}/${theme}/${width}`);
    if (shots && tier === 'premium') { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/pet-${theme}-${width}.png`, fullPage: true }); }
    await context.close();
  }
  {
    const { page, context } = await open({ language: 'es', width: 390 });
    await page.getByRole('heading', { name: 'Mascota', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Nombre de la mascota' }).waitFor();
    await page.getByRole('button', { name: /Kokoro/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Guardar cambios' && !button.disabled));
    await axe(page, 'Spanish'); await context.close();
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('PASS pet UI: provider/voice/language, profiles, rules, limits, save/reload/discard/errors/conflicts, free plan guard, Premium/Pro, Spanish, axe and overflow at 320/390/1280 in both themes');
} finally { await browser.close(); }
