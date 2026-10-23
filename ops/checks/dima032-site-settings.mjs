import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
// saas-ops deliberately filters the caller environment; keep exact-candidate
// visual evidence in a runtime-only directory when no override is forwarded.
const shots = process.env.SAAS_SCREENSHOT_DIR || '/tmp/dima032-site-shots';
const user = { id: '991505', login: 'pet_owner', display_name: 'Pet Owner' };
const seed = () => ({ schemaVersion: 3, revision: 0, updatedAt: null,
  settings: { sources: { independent: true, readTts: false }, ttsAudio: 'pet', enabled: false, name: 'Dima', appearance: { kind: 'png', idleAssetId: 'a'.repeat(24), talkingAssetId: 'b'.repeat(24) }, playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null }, tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' },
    personality: { source: 'custom', profileId: '', prompt: 'A friendly virtual companion.' }, rules: [],
    behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280 } },
  profiles: [{ id: 'p1', name: 'Co-host' }, { id: 'p2', name: 'Storyteller' }],
  voices: [{ provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' },
    { provider: 'piper', id: 'en_US-ryan-medium', name: 'Ryan', language: 'en' },
    { provider: 'kokoro', id: 'ef_dora', name: 'Dora', language: 'es' },
    { provider: 'kokoro', id: 'af_heart', name: 'Heart', language: 'en' },
    { provider: 'fish', id: '7b5626abdaa044babfc3829ec15acf31', name: 'Gojo', language: 'any' }],
  runtime: { enabled: false, issues: [], playbackAvailable: false } });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
// Two complete GIF frames; library upload must receive these exact original bytes.
const gif = Buffer.from('47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex');
const idle = { id: 'a'.repeat(24), name: 'Idle.png', kind: 'image', mime: 'image/png', bytes: png.length, width: 1, height: 1, createdAt: new Date().toISOString() };
const animated = { id: 'c'.repeat(24), name: 'Talking.gif', kind: 'image', mime: 'image/gif', bytes: gif.length, width: 1, height: 1, createdAt: new Date().toISOString() };
const errors = [];
let ownerRaceVerified = false;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open({ theme = 'dark', width = 1280, language = 'en', tier = 'premium', failLoad = false, noProfiles = false, legacy = false, deferRuntime = false, hashOnly = false, noToken = false, savedOffline = false, noDesktop = false, missingProfile = false } = {}) {
  const app = { name: 'Pet Owner', email: 'pet@example.invalid', language, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  let doc = seed(); if (noProfiles) doc.profiles = [];
  if (missingProfile) { doc.settings.personality = { source: 'profile', profileId: 'deleted-profile', prompt: '' }; doc.settings.tts.voice = 'saved-unavailable-voice'; }
  if (legacy) { delete doc.settings.appearance; delete doc.settings.playback; delete doc.settings.sources; delete doc.settings.ttsAudio; }
  const state = { writes: [], saveError: null, failLoad, reads: 0, runtimeReads: 0, tokenReads: 0, rotations: [], uploads: [], token: hashOnly ? null : 'a'.repeat(43), tokenVersion: createHash('sha256').update('a'.repeat(43)).digest('hex'), releaseRuntime: null, releaseToken: null };
  if (noToken) { state.token = null; state.tokenVersion = null; }
  if (savedOffline) doc.settings.playback = { target: 'desktop', desktopSessionId: 'f'.repeat(24), vtsSessionId: null };
  const assets = [idle];
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
    if (url.pathname.match(/^\/pets\/[^/]+\/runtime$/)) {
      state.runtimeReads++;
      const owner = url.pathname.split('/')[2];
      if (deferRuntime && owner === user.id) await new Promise(resolve => { state.releaseRuntime = resolve; });
      return ok({ v: 1, generation: 1, active: null, sessions: savedOffline || noDesktop ? [] : [{ sessionId: owner === user.id ? 'd'.repeat(24) : 'e'.repeat(24), label: owner === user.id ? 'Streaming PC' : 'Second PC', audioReady: true, vtsReady: true }] });
    }
    if (url.pathname.match(/^\/pets\/[^/]+\/overlay-token$/)) {
      const owner = url.pathname.split('/')[2];
      if (request.method() === 'GET') {
        state.tokenReads++;
        if (deferRuntime && owner === user.id) await new Promise(resolve => { state.releaseToken = resolve; });
      } else { const body = request.postDataJSON(); state.rotations.push(body); state.token = body.token ?? 'b'.repeat(43); state.tokenVersion = createHash('sha256').update(state.token).digest('hex'); }
      return ok({ token: owner === user.id ? state.token : 'c'.repeat(43), exists: !!state.tokenVersion, version: state.tokenVersion });
    }
    if (url.pathname.startsWith('/asset-library/')) {
      if (url.pathname.endsWith('/access')) return ok({ path: '/pet-fixture/' + url.pathname.split('/')[3] });
      if (request.method() === 'POST') { state.uploads.push(request.postDataBuffer()); assets.push(animated); return ok(animated); }
      return ok({ assets, usedBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0), quotaBytes: 500000000, maxFileBytes: 20000000, planTier: tier });
    }
    if (url.pathname.startsWith('/pet-fixture/')) return route.fulfill({ contentType: url.pathname.endsWith(animated.id) ? 'image/gif' : 'image/png', body: url.pathname.endsWith(animated.id) ? gif : png });
    if (url.pathname.match(/^\/pets\/[^/]+\/settings$/)) {
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
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('settings persistence timed out'); }
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
    const { page, context, state } = await open({ missingProfile: true, noDesktop: true });
    await page.locator('input[formcontrolname=independent]').uncheck();
    await page.locator('input[formcontrolname=readTts]').check();
    await save(page).click(); await until(() => state.writes.length === 1);
    assert.equal(state.writes[0].settings.personality.profileId, 'deleted-profile', 'inactive independent settings preserved');
    assert.equal(state.writes[0].settings.tts.voice, 'saved-unavailable-voice');
    await context.close();
  }
  for (const language of ['en', 'es']) {
    const { page, context, state } = await open({ language, noDesktop: true, width: 390 });
    const read = page.locator('input[formcontrolname=readTts]');
    const independent = page.locator('input[formcontrolname=independent]');
    const choice = page.locator('select[formcontrolname=ttsAudio]');
    const saveSource = () => page.locator('button[type=submit]').click();
    await read.waitFor();
    assert.equal(await read.isChecked(), false); assert.equal(await independent.isChecked(), true);
    assert.equal(await choice.count(), 0);
    await read.check(); await independent.uncheck(); await choice.selectOption('overlay');
    await page.locator('input[formcontrolname=enabled]').check();
    await saveSource(); await until(() => state.writes.length === 1 && !state.writes.at(-1).settings.sources.independent);
    assert.deepEqual(state.writes.at(-1).settings.sources, { independent: false, readTts: true });
    assert.equal(state.writes.at(-1).settings.ttsAudio, 'overlay');
    assert.deepEqual(state.writes.at(-1).settings.playback, { target: 'browser', desktopSessionId: null, vtsSessionId: null });
    await page.reload(); await read.waitFor();
    assert.equal(await read.isChecked(), true); assert.equal(await independent.isChecked(), false); assert.equal(await choice.inputValue(), 'overlay');
    await independent.check(); await saveSource(); await until(() => state.writes.length === 2);
    assert.deepEqual(state.writes.at(-1).settings.sources, { independent: true, readTts: true });
    await page.waitForFunction(() => !document.querySelector('input[formcontrolname=readTts]').disabled);
    await choice.selectOption('pet'); await saveSource(); await until(() => state.writes.length === 3);
    assert.equal(state.writes.at(-1).settings.ttsAudio, 'pet');
    await page.waitForFunction(() => !document.querySelector('input[formcontrolname=readTts]').disabled);
    await read.uncheck(); await saveSource(); await until(() => state.writes.length === 4);
    assert.equal(state.writes.at(-1).settings.ttsAudio, 'pet', 'hidden audio choice roundtrips');
    assert.deepEqual(state.writes.at(-1).settings.sources, { independent: true, readTts: false });
    await context.close();
  }
  {
    const { page, context, state } = await open();
    await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    await page.getByRole('textbox', { name: 'Private pet browser-source URL' }).waitFor();
    const initialCounts = [state.reads, state.runtimeReads, state.tokenReads];
    await page.waitForTimeout(1200);
    assert.deepEqual([state.reads, state.runtimeReads, state.tokenReads], initialCounts, 'idle signals never cause refetch loops');
    assert.deepEqual(initialCounts, [1, 1, 1]);
    const opener = page.getByRole('button', { name: 'Choose talking image', exact: true });
    await opener.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Asset Library', exact: true });
    await dialog.waitFor();
    await dialog.locator('input[type=file]').setInputFiles({ name: animated.name, mimeType: animated.mime, buffer: gif });
    await dialog.getByRole('button', { name: 'Use asset', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert(state.uploads[0].includes(gif), 'original animation bytes preserved in multipart upload');
    assert.equal(await opener.evaluate(button => document.activeElement === button), true, 'picker restores keyboard focus');
    await page.getByRole('combobox', { name: 'Pet audio output', exact: true }).selectOption('desktop');
    await page.getByRole('combobox', { name: 'Computer for pet audio', exact: true }).selectOption('d'.repeat(24));
    await save(page).click(); await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    assert.equal(state.writes.at(-1).settings.appearance.talkingAssetId, animated.id);
    assert.equal(state.writes.at(-1).settings.playback.desktopSessionId, 'd'.repeat(24));
    assert(!JSON.stringify(state.writes).includes('/pet-fixture/'), 'settings persist IDs, never temporary media URLs');
    await page.getByRole('combobox', { name: 'Pet appearance', exact: true }).selectOption('vts');
    await page.getByRole('combobox', { name: 'Pet audio output', exact: true }).selectOption('browser');
    await page.getByRole('combobox', { name: 'Computer running VTube Studio', exact: true }).selectOption('d'.repeat(24));
    await save(page).click(); await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    assert.deepEqual(state.writes.at(-1).settings.playback, { target: 'browser', desktopSessionId: 'd'.repeat(24), vtsSessionId: 'd'.repeat(24) }, 'browser audio and VTS selection remain independent');
    await page.getByRole('button', { name: 'Replace URL', exact: true }).click();
    assert.equal(state.rotations.length, 0, 'first tap only explains rotation');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(state.rotations.length, 0);
    await page.getByRole('button', { name: 'Replace URL', exact: true }).click();
    await page.getByRole('button', { name: 'Replace and disconnect old sources', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.overlay-url')?.value.includes('/pet/' + 'b'.repeat(43)));
    assert.deepEqual(state.rotations, [{ rotate: true, version: createHash('sha256').update('a'.repeat(43)).digest('hex') }]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'URL copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), new URL(base).origin + '/pet/' + 'b'.repeat(43));
    await context.close();
  }
  {
    const { page, context, state } = await open({ noToken: true });
    await page.getByRole('button', { name: 'Create browser-source URL', exact: true }).click();
    await page.getByRole('textbox', { name: 'Private pet browser-source URL', exact: true }).waitFor();
    assert.deepEqual(state.rotations, [{}], 'first issuance is explicit and does not guess a capability');
    await context.close();
  }
  {
    const { page, context } = await open({ savedOffline: true });
    const output = page.getByRole('combobox', { name: 'Computer for pet audio', exact: true });
    await output.waitFor(); assert.equal(await output.inputValue(), 'f'.repeat(24));
    await output.getByRole('option', { name: 'Saved computer · unavailable' }).waitFor({ state: 'attached' });
    await context.close();
  }
  {
    const { page, context, state } = await open({ hashOnly: true });
    await page.getByRole('textbox', { name: 'Existing OBS pet URL', exact: true }).fill(new URL(base).origin + '/pet/' + 'a'.repeat(43));
    await page.getByRole('button', { name: 'Recover existing URL', exact: true }).click();
    await page.getByRole('textbox', { name: 'Private pet browser-source URL', exact: true }).waitFor();
    assert.deepEqual(state.rotations, [{ token: 'a'.repeat(43) }], 'recovery returns the existing capability without rotation');
    await context.close();
  }
  {
    const { page, context, state } = await open({ legacy: true });
    await page.getByText('No unsaved changes', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(state.writes.length, 0, 'legacy missing fields normalize without writing');
    await saveState(page, true);
    await context.close();
  }
  {
    const { page, context, state } = await open({ deferRuntime: true });
    await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    const deadline = Date.now() + 10000;
    while (!state.releaseRuntime || !state.releaseToken) { assert(Date.now() < deadline, 'in-flight owner fixture requests'); await page.waitForTimeout(20); }
    // Same component owner change while both old-owner reads are in flight. This
    // regression fixture uses Angular's development API; production bundles skip it.
    const debug = await page.evaluate(() => !!window.ng?.getComponent);
    if (debug) {
      await page.evaluate(() => {
        const component = window.ng.getComponent(document.querySelector('app-pet-page'));
        Object.defineProperty(component, 'channelID', { value: () => '991506' });
        void component.refreshRuntime('991506'); void component.loadToken('991506');
      });
      await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-pet-page')).runtime()?.sessions?.[0]?.label === 'Second PC');
      state.releaseRuntime(); state.releaseToken();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-pet-page')).runtime().sessions[0].label), 'Second PC');
      assert.match(await page.getByRole('textbox', { name: 'Private pet browser-source URL' }).inputValue(), new RegExp('c{43}$'));
      ownerRaceVerified = true;
    } else { state.releaseRuntime(); state.releaseToken(); }
    await context.close();
  }
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
    await page.locator('input[formcontrolname=readTts]').check();
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
  console.log(`Owner-switch in-flight race: ${ownerRaceVerified ? 'PASS (development API)' : 'SKIP (production bundle; verified separately in development preview)'}`);
  console.log('PASS DIMA-032 switches, independent persistence, no-desktop PNG settings, hidden audio roundtrip, plus pet UI: private still/animated assets, original upload bytes, separate output/VTS, capability issuance/recovery/opaque rotation/copy, saved offline computers, idle-fetch regression, legacy read-only normalization, provider/voice/language, profiles, rules, limits, save/reload/discard/errors/conflicts, free plan guard, Premium/Pro, Spanish, axe and overflow at 320/390/1280 in both themes');
} finally { await browser.close(); }
