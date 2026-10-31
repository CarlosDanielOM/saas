import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'Run against a helper preview or exact site candidate.');
const shots = '/tmp/pet-fish-favorites-shots';
const api = 'https://api.domdimabot.com';
const favoriteId = 'f'.repeat(32), customId = 'c'.repeat(32);
const defaultVoices = ['a', 'b', 'd', 'e'].map((letter, index) => ({ provider: 'fish', id: letter.repeat(32), name: `Default ${index + 1}`, language: 'any' }));
const favorites = [
  { id: favoriteId, name: 'Calm narrator', alias: 'narrator' },
  { id: favoriteId, name: 'Duplicate favorite', alias: 'duplicate' },
  { id: defaultVoices[0].id, name: 'Default already saved', alias: 'default' }
];
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
async function open({ width = 1280, theme = 'dark', language = 'en', voice = defaultVoices[0].id, favoriteStatus = 200, holdFavorites = false, items = favorites } = {}) {
  const app = { name: 'Pet Owner', email: 'pet@example.invalid', language, plan_tier: 'premium', actived: true,
    chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  let doc = seed(voice);
  const state = { writes: [], favoriteReads: 0, favoriteStatus, items, releaseFavorites: null };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
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
    if (url.pathname === `/pets/${user.id}/settings`) {
      if (req.method() === 'PUT') { const write = req.postDataJSON(); state.writes.push(write); doc = { ...doc, revision: doc.revision + 1, settings: write.settings }; }
      return ok(doc);
    }
    if (url.pathname.endsWith('/runtime')) return ok({ v: 1, generation: 1, active: null, sessions: [] });
    if (url.pathname.endsWith('/overlay-token')) return ok({ exists: false, token: null, version: null });
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.startsWith('/auth/access/')) return ok({ allowed: true });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'premium' });
    return ok({});
  });
  const page = await context.newPage();
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
  await save(page).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => /^(Save changes|Guardar cambios)$/.test(button.textContent.trim()) && button.disabled));
  assert.equal(state.writes.length, before + 1);
}
try {
  {
    const { page, context, state } = await open();
    await waitOption(page, favoriteId);
    assert.match(await voiceSelect(page).locator(`option[value="${favoriteId}"]`).textContent(), /Calm narrator/);
    const options = await voiceSelect(page).locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(options.length, new Set(options).size, 'defaults and favorites deduplicate by voice ID');
    assert.equal(options.length, 5);
    await voiceSelect(page).selectOption(favoriteId); await saveDraft(page, state);
    assert.equal(state.writes.at(-1).settings.tts.voice, favoriteId, 'save the reference ID, never its alias');
    await page.reload(); await waitOption(page, favoriteId);
    assert.equal(await voiceSelect(page).inputValue(), favoriteId);
    await page.locator('select[formcontrolname=language]').selectOption('en');
    assert.equal(await voiceSelect(page).inputValue(), favoriteId, 'reply language does not reset a Fish favorite');
    await page.getByRole('button', { name: /Piper/ }).click();
    await page.waitForFunction(() => document.querySelector('select[formcontrolname=voice]')?.value === 'en_US-ryan-medium');
    assert.equal(await voiceSelect(page).inputValue(), 'en_US-ryan-medium');
    await page.getByRole('button', { name: /Fish Audio/ }).click();
    await page.waitForFunction(() => /^[a-f\d]{32}$/i.test(document.querySelector('select[formcontrolname=voice]')?.value || ''));
    assert.ok((await voiceSelect(page).inputValue()).match(/^[a-f\d]{32}$/i));
    assert.equal(state.favoriteReads, 2, 'one favorites read per page, no form-driven refetches');
    const manage = page.locator('.voice-tile a[href*="/modules/tts"]');
    assert.equal(await manage.count(), 1, 'reuse the TTS favorites manager');
    await context.close();
  }
  {
    const { page, context, state } = await open({ voice: favoriteId, holdFavorites: true });
    assert.equal(await voiceSelect(page).inputValue(), favoriteId, 'saved ID is visible before favorites arrive');
    await page.locator('input[formcontrolname=name]').fill('Keep this draft');
    await page.waitForFunction(() => document.querySelector('input[formcontrolname=name]')?.value === 'Keep this draft');
    const loadingDeadline = Date.now() + 15000;
    while (!state.releaseFavorites) { assert(Date.now() < loadingDeadline, 'favorites request started'); await page.waitForTimeout(20); }
    state.releaseFavorites(); await waitOption(page, favoriteId);
    await page.waitForFunction(() => document.querySelector('select[formcontrolname=voice]')?.selectedOptions[0]?.textContent.includes('Calm narrator'));
    assert.equal(await page.locator('input[formcontrolname=name]').inputValue(), 'Keep this draft');
    assert.equal(state.writes.length, 0, 'loading favorites never saves or changes the draft');
    state.items = []; await page.reload(); await voiceSelect(page).waitFor();
    assert.equal(await voiceSelect(page).inputValue(), favoriteId, 'removed favorite remains a usable saved custom ID');
    await context.close();
  }
  {
    const { page, context, state } = await open({ voice: customId, favoriteStatus: 503 });
    const retry = page.locator('.voice-tile').getByRole('button', { name: /retry/i });
    await retry.waitFor();
    assert.equal(await voiceSelect(page).inputValue(), customId);
    await page.locator('select[formcontrolname=language]').selectOption('en');
    assert.equal(await voiceSelect(page).inputValue(), customId, 'custom Fish IDs survive language changes');
    state.favoriteStatus = 200; await retry.click(); await waitOption(page, favoriteId);
    assert.equal(await voiceSelect(page).inputValue(), customId, 'retry does not choose a different voice');
    await saveDraft(page, state);
    assert.equal(state.writes.at(-1).settings.tts.voice, customId);
    assert.equal(state.favoriteReads, 2);
    await context.close();
  }
  await mkdir(shots, { recursive: true });
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { page, context } = await open({ theme, width, voice: favoriteId });
    await waitOption(page, favoriteId);
    await page.locator('.voice-tile').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme}/${width} overflow`);
    await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-pet-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${theme}/${width} accessibility`);
    await page.screenshot({ path: `${shots}/${theme}-${width}.png`, fullPage: true });
    await page.locator('.voice-tile').screenshot({ path: `${shots}/voice-${theme}-${width}.png` });
    await context.close();
  }
  {
    const { page, context, state } = await open({ language: 'es', width: 390, voice: favoriteId });
    await waitOption(page, favoriteId);
    await page.getByRole('heading', { name: 'Mascota', exact: true }).waitFor();
    await voiceSelect(page).selectOption(favoriteId); await saveDraft(page, state);
    assert.equal(state.writes.at(-1).settings.tts.voice, favoriteId);
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS pet Fish favorites: named/deduplicated saved voices, ID persistence/reload, language/provider behavior, loading/error/retry draft retention, custom/removed IDs, mobile/desktop dark/light, Spanish and axe.');
} finally { await browser.close(); }
