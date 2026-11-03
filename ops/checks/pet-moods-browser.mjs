import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'Run against a helper preview or exact site candidate.');
const shots = '/tmp/pet-moods-shots';
const api = 'https://api.domdimabot.com';
const favoriteId = 'f'.repeat(32), customId = 'c'.repeat(32);
const defaultVoices = ['a', 'b', 'd', 'e'].map((letter, index) => ({ provider: 'fish', id: letter.repeat(32), name: `Default ${index + 1}`, language: 'any' }));
const favorites = [
  { id: favoriteId, name: 'Calm narrator', alias: 'narrator' },
  { id: favoriteId, name: 'Duplicate favorite', alias: 'duplicate' },
  { id: defaultVoices[0].id, name: 'Default already saved', alias: 'default' }
];
const defaultMoods = {"enabled": false, "holdMs": 2000, "images": {}, "emotions": {"happy": ["happy", "delighted", "satisfied", "grateful", "proud", "confident", "optimistic", "hopeful", "moved", "empathetic", "sympathetic", "compassionate", "laugh", "chuckle", "giggle"], "excited": ["excited", "hysterical", "determined"], "sad": ["sad", "disappointed", "depressed", "unhappy", "regretful", "lonely", "nostalgic", "resigned", "pessimistic", "guilty", "cry", "sobbing"], "angry": ["angry", "frustrated", "upset", "disgusted", "contemptuous", "disdainful", "jealous", "envious", "sarcastic"], "surprised": ["surprised", "gasp"], "scared": ["scared", "nervous", "anxious", "worried"], "embarrassed": ["embarrassed", "ashamed"], "thinking": ["curious", "confused", "uncertain", "doubtful"]}};
const moodAsset = { id: 'c'.repeat(24), name: 'Happy pose', kind: 'image', mime: 'image/png', bytes: 123, width: 1, height: 1, createdAt: new Date().toISOString() };
const user = { id: '991505', login: 'pet_owner', display_name: 'Pet Owner' };
const seed = voice => ({ schemaVersion: 3, revision: 1, updatedAt: null,
  settings: { enabled: false, sources: { independent: true, readTts: false }, ttsAudio: 'pet', name: 'Dima',
    appearance: { kind: 'png', idleAssetId: 'a'.repeat(24), talkingAssetId: 'b'.repeat(24) },
    playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null },
    tts: { enabled: true, provider: 'fish', language: 'es', voice },
    personality: { source: 'custom', profileId: '', prompt: 'A friendly virtual companion.' }, rules: [],
    behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280, queueSize: 5, askLane: 'independent' } },
  profiles: [], voices: [...defaultVoices, { provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' },
    { provider: 'piper', id: 'en_US-ryan-medium', name: 'Ryan', language: 'en' }],
  runtime: { enabled: false, issues: [], playbackAvailable: false } });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const pageErrors = [];
async function open({ width = 1280, theme = 'dark', language = 'en', voice = defaultVoices[0].id, favoriteStatus = 200, holdFavorites = false, items = favorites, tier = 'premium', initialMoods, storedCount = 1 } = {}) {
  const app = { name: 'Pet Owner', email: 'pet@example.invalid', language, plan_tier: tier, actived: true,
    chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  let doc = seed(voice); doc.settings.moods = structuredClone(initialMoods === undefined ? defaultMoods : initialMoods); doc.moodImageLimit = tier === 'pro' ? 16 : 8;
  const state = { writes: [], settingsReads: 0, navigations: [], favoriteReads: 0, favoriteStatus, items, releaseFavorites: null };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
    window.__moodEvents = [];
    document.addEventListener('click', event => { const button = event.target.closest?.('button'); if (button) window.__moodEvents.push(button.textContent.trim()); }, true);
  }, { user, app, theme, language });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/pet_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    if (url.pathname === `/speech/favorites/${user.id}`) {
      assert.equal(req.method(), 'GET', 'pet only reads the existing favorites list');
      state.favoriteReads++;
      if (holdFavorites) { holdFavorites = false; await new Promise(resolve => { state.releaseFavorites = resolve; }); }
      return state.favoriteStatus === 200 ? ok(state.items) : route.fulfill({ status: state.favoriteStatus, json: { error: true, message: 'fixture unavailable' } });
    }
    if (url.pathname === `/asset-library/${user.id}`) {
      assert.equal(url.searchParams.get('purpose'), 'pet-mood', 'mood picker uses independent private allowance');
      assert.equal(req.method(), 'GET', 'fixture does not upload files');
      return ok({ assets: [moodAsset], planTier: tier, usedBytes: 99999999999, quotaBytes: 0, maxFileBytes: 10000000,
        moodImageLimit: tier === 'pro' ? 16 : 8, storedMoodImages: storedCount,
        configuredMoodImages: Object.values(doc.settings.moods.images).reduce((n, image) => n + Number(!!image.idleAssetId) + Number(!!image.talkingAssetId), 0) });
    }
    if (url.pathname.startsWith(`/asset-library/${user.id}/`) && url.pathname.endsWith('/access')) return ok({ path: '/mood-fixture.png' });
    if (url.pathname === '/mood-fixture.png') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WoAAAAASUVORK5CYII=', 'base64') });
    if (url.pathname === `/pets/${user.id}/settings`) {
      if (req.method() === 'PUT') { const write = req.postDataJSON(); state.writes.push(write); doc = { ...doc, revision: doc.revision + 1, settings: write.settings }; }
      else state.settingsReads++;
      return ok(doc);
    }
    if (url.pathname.endsWith('/runtime')) return ok({ v: 1, generation: 1, active: null, sessions: [] });
    if (url.pathname.endsWith('/overlay-token')) return ok({ exists: false, token: null, version: null });
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.startsWith('/auth/access/')) return ok({ allowed: true });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: tier });
    return ok({});
  });
  const page = await context.newPage();
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) state.navigations.push(frame.url()); });
  page.setDefaultTimeout(15000); page.on('pageerror', err => pageErrors.push(err.message));
  await page.goto(base + '/pet_owner/modules/pet');
  await page.locator('app-pet-page select[formcontrolname=voice]').waitFor();
  return { page, context, state };
}
const voiceSelect = page => page.locator('select[formcontrolname=voice]');
const save = page => page.getByRole('button', { name: /^(Save changes|Guardar cambios)$/ });
async function waitOption(page, id) { await voiceSelect(page).locator(`option[value="${id}"]`).waitFor({ state: 'attached' }); }
async function saveDraft(page, state) {
  const before = state.writes.length;
  await page.locator('input[formcontrolname=name]').fill(`Pet ${before + 1}`);
  try { await save(page).click({ timeout: 4000 }); }
  catch (error) {
    const form = await page.evaluate(() => ({
      status: document.querySelector('.lf-save-bar')?.textContent,
      events: window.__moodEvents,
      fields: [...document.querySelectorAll('app-pet-page [formcontrolname]')].map(field => ({ name: field.getAttribute('formcontrolname'), value: field.value, classes: field.className }))
    }));
    throw new Error(`Unable to save fixture: ${JSON.stringify({ form, writes: state.writes.length, reads: state.settingsReads, navigations: state.navigations })}`, { cause: error });
  }
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => /^(Save changes|Guardar cambios)$/.test(button.textContent.trim()) && button.disabled));
  assert.equal(state.writes.length, before + 1);
}
try {
  {
    const { page, context, state } = await open();
    const section = page.locator('.moods-tile');
    await section.getByRole('heading', { name: 'Moods', exact: true }).waitFor();
    assert.equal(await section.locator('[formcontrolname=moodsEnabled]').isChecked(), false);
    assert.equal(await section.locator('[formcontrolname=moodHoldMs]').inputValue(), '2000');
    assert.equal(await section.locator('details.mood-row').count(), 8);
    await section.locator('[formcontrolname=moodsEnabled]').check();
    await section.locator('[formcontrolname=moodHoldMs]').fill('10001');
    await saveDraft(page, state);
    assert.deepEqual(state.writes.at(-1).settings.moods, defaultMoods, 'invalid optional hold defaults moods off while valid core edits save');
    assert.equal(state.writes.at(-1).settings.name, 'Pet 1', 'core settings survive optional mood validation');
    await section.locator('[formcontrolname=moodsEnabled]').check();
    await section.locator('[formcontrolname=moodHoldMs]').fill('1250');
    const happy = section.locator('[data-mood=happy]'); await happy.locator('summary').click();
    await happy.getByRole('button', { name: 'Remove emotion happy', exact: true }).click();
    await happy.locator('select').selectOption('calm');
    await happy.getByRole('button', { name: 'Remove emotion calm', exact: true }).waitFor();
    const sad = section.locator('[data-mood=sad]'); await sad.locator('summary').click();
    assert.equal(await sad.locator('select option[value=calm]').count(), 0, 'each tag has only one mood');
    await section.getByRole('button', { name: 'Reset emotion lists to defaults' }).click();
    await happy.getByRole('button', { name: 'Remove emotion calm', exact: true }).waitFor({ state: 'detached' });
    await happy.getByRole('button', { name: 'Remove emotion happy', exact: true }).waitFor();
    await happy.locator('.image-choice').first().getByRole('button', { name: /choose image/i }).click();
    const dialog = page.getByRole('dialog'); await dialog.locator('.asset').first().click();
    assert.equal(await dialog.locator('button.upload').isDisabled(), false, 'media byte quota does not block mood uploads');
    await dialog.locator('button.use').click();
    await dialog.waitFor({ state: 'detached' }); // Wait for focus restoration before editing the form.
    await saveDraft(page, state);
    assert.equal(state.writes.at(-1).settings.moods.enabled, true);
    assert.equal(state.writes.at(-1).settings.moods.holdMs, 1250);
    assert.deepEqual(state.writes.at(-1).settings.moods.emotions, defaultMoods.emotions);
    assert.equal(state.writes.at(-1).settings.moods.images.happy.idleAssetId, moodAsset.id);
    await context.close();
  }
  {
    const initialMoods = structuredClone(defaultMoods); initialMoods.enabled = true;
    for (const mood of Object.keys(initialMoods.emotions)) initialMoods.images[mood] = { idleAssetId: moodAsset.id, talkingAssetId: moodAsset.id };
    const { page, context, state } = await open({ initialMoods, storedCount: 16 });
    const section = page.locator('.moods-tile');
    for (const summary of await section.locator('details summary').all()) await summary.click();
    assert.equal(await section.locator('.mood-inactive').count(), 8, 'Premium keeps first 8 configured fields active');
    assert.match(await section.locator('.mood-toolbar').innerText(), /16\s*\/\s*8/);
    await section.locator('[data-mood=happy] .image-choice').first().getByRole('button', { name: /choose image/i }).click();
    const dialog = page.getByRole('dialog'); await dialog.locator('.asset').first().waitFor();
    assert.equal(await dialog.locator('button.upload').isDisabled(), true, 'downgraded storage blocks new uploads');
    await dialog.locator('.asset').first().click(); await dialog.locator('button.use').click();
    await dialog.waitFor({ state: 'detached' });
    await section.locator('[formcontrolname=moodHoldMs]').fill('500');
    await saveDraft(page, state);
    assert.equal(Object.keys(state.writes.at(-1).settings.moods.images).length, 8, 'editing retains inactive images');
    await context.close();
  }
  {
    const { page, context } = await open({ tier: 'pro' });
    assert.match(await page.locator('.mood-toolbar').innerText(), /0\s*\/\s*16/);
    await context.close();
  }
  for (const malformed of [null, { enabled: true, holdMs: 'invalid', emotions: [], images: 'corrupt' },
    { ...defaultMoods, enabled: true, images: { happy: { idleAssetId: 42 } } }]) {
    const { page, context } = await open({ initialMoods: malformed });
    const section = page.locator('.moods-tile');
    assert.equal(await section.locator('[formcontrolname=moodsEnabled]').isChecked(), false, 'corrupt server settings safely default off');
    assert.equal(await section.locator('[formcontrolname=moodHoldMs]').inputValue(), '2000');
    assert.equal(await section.locator('details.mood-row').count(), 8);
    await section.locator('[data-mood=happy] summary').click();
    assert.equal(await section.getByRole('button', { name: 'Remove emotion happy', exact: true }).count(), 1);
    await context.close();
  }
  await mkdir(shots, { recursive: true });
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { page, context } = await open({ theme, width });
    const section = page.locator('.moods-tile');
    await section.locator('[data-mood=happy] summary').click();
    await section.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme}/${width} overflow`);
    await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-pet-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${theme}/${width} accessibility`);
    await section.screenshot({ path: `${shots}/moods-${theme}-${width}.png` });
    await context.close();
  }
  {
    const { page, context } = await open({ language: 'es', width: 390 });
    await page.locator('.moods-tile').getByRole('heading', { name: 'Estados de ánimo', exact: true }).waitFor();
    await page.locator('[data-mood=thinking] summary').click();
    await page.getByRole('button', { name: 'Quitar emoción curious', exact: true }).waitFor();
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS pet moods: defaults, hold validation, unique tag lists/reset, independent image picker/allowance, Premium downgrade retention/inactive slots/upload block, Pro slots, mobile/desktop dark/light, Spanish and axe.');
} finally { await browser.close(); }
