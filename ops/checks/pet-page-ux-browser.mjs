// Pet module page redesign (2026-11-04): readiness checklist, "fix before saving"
// chips, folded groups, own-voice sections, function copy, phone/desktop axe.
// Every API call is mocked; nothing reaches production.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const user = { id: '991505', login: 'pet_owner', display_name: 'Pet Owner' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const seed = () => ({ schemaVersion: 3, revision: 0, updatedAt: null,
  settings: { enabled: false, name: 'Dima', sources: { independent: true, readTts: false }, ttsAudio: 'pet',
    appearance: { kind: 'png', idleAssetId: 'a'.repeat(24), talkingAssetId: null },
    playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null },
    tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' },
    personality: { source: 'custom', profileId: '', prompt: 'A friendly virtual companion.' }, rules: [],
    behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280, queueSize: 5, askLane: 'independent' } },
  profiles: [{ id: 'p1', name: 'Co-host' }],
  voices: [{ provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' }, { provider: 'kokoro', id: 'ef_dora', name: 'Dora', language: 'es' },
    { provider: 'fish', id: '7b5626abdaa044babfc3829ec15acf31', name: 'Gojo', language: 'any' }],
  runtime: { enabled: false, issues: [], playbackAvailable: false } });
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const until = async (fn, label, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { assert(Date.now() < end, label); await new Promise(r => setTimeout(r, 50)); } };

async function open({ theme = 'dark', width = 1280, language = 'en', tier = 'premium', settings = {}, runtime = {}, token = true } = {}) {
  const app = { name: 'Pet Owner', email: 'pet@example.invalid', language, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const doc = seed(); Object.assign(doc.settings, settings); Object.assign(doc.runtime, runtime);
  const state = { writes: [], token: token ? 'a'.repeat(43) : null, rotations: [] };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  await context.addInitScript(({ user, app, theme, language }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', language);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, theme, language });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/pet_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== 'https://api.domdimabot.com') return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    if (url.pathname === `/speech/favorites/${user.id}`) return ok([]);
    if (/^\/pets\/[^/]+\/runtime$/.test(url.pathname)) return ok({ v: 1, generation: 1, active: null, sessions: [{ sessionId: 'd'.repeat(24), label: 'Streaming PC', audioReady: true, vtsReady: true }] });
    if (/^\/pets\/[^/]+\/overlay-token$/.test(url.pathname)) {
      if (request.method() !== 'GET') { state.rotations.push(request.postDataJSON()); state.token = 'b'.repeat(43); }
      return ok({ token: state.token, exists: !!state.token, version: state.token ? 'v1' : null });
    }
    if (url.pathname.startsWith('/asset-library/')) {
      if (url.pathname.endsWith('/access')) return ok({ path: '/pet-fixture/' + url.pathname.split('/')[3] });
      return ok({ assets: [{ id: 'a'.repeat(24), name: 'Idle.png', kind: 'image', mime: 'image/png', bytes: png.length, width: 1, height: 1, createdAt: new Date().toISOString() }], usedBytes: png.length, quotaBytes: 500000000, maxFileBytes: 20000000, planTier: tier });
    }
    if (url.pathname.startsWith('/pet-fixture/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (/^\/pets\/[^/]+\/settings$/.test(url.pathname)) {
      if (request.method() === 'PUT') { const body = request.postDataJSON(); state.writes.push(body); doc.revision++; doc.settings = body.settings; }
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
  await page.locator('input[formcontrolname=name]').waitFor();
  return { context, page, state };
}
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-pet-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
const statusTitle = page => page.locator('#pet-status-title').innerText();
const saveButton = page => page.getByRole('button', { name: /^(Save changes|Guardar cambios)$/ });

try {
  {
    // Readiness checklist answers "can my pet appear?" and points at the fix.
    const { page, context, state } = await open();
    await until(async () => (await statusTitle(page)) === '2 steps left before Dima can appear on stream', 'two steps left');
    const steps = page.locator('.pet-step');
    assert.equal(await steps.count(), 4);
    assert.deepEqual(await page.locator('.pet-step--done .pet-step__label').evaluateAll(e => e.map(x => x.firstChild.textContent.trim())),
      ['Add the browser source to OBS', 'Choose what it says']);
    assert.match(await page.locator('.lf-head__chips').innerText(), /Player not open[\s\S]*Image pet[\s\S]*Piper · Ald/);
    // "Turn on" from the checklist flips the header switch and blocks saving on the missing image, with a jump chip.
    await page.locator('.pet-step', { hasText: 'Turn it on' }).getByRole('button', { name: 'Turn on' }).click();
    await until(() => page.getByRole('switch', { name: 'Enable pet responses' }).isChecked(), 'header switch follows checklist');
    await page.locator('.pet-problems').getByText('Fix before saving:').waitFor();
    assert.equal(await saveButton(page).isDisabled(), true);
    await page.locator('.pet-problem', { hasText: 'Idle and talking images' }).click();
    await until(() => page.evaluate(() => document.activeElement?.closest('#pet-look') !== null), 'problem chip focuses the look card');
    assert.equal(await page.locator('.image-choice--missing').count(), 1, 'missing talking image is highlighted');
    // A bad queue size opens the folded "Queue and limits" group from the save bar.
    await page.locator('.pet-limits summary').click();
    await page.getByRole('spinbutton', { name: 'Pet queue size' }).fill('40');
    await page.locator('.pet-limits summary').click();
    assert.equal(await page.locator('.pet-limits').evaluate(d => d.open), false);
    await page.locator('.pet-problem', { hasText: 'Queue size' }).click();
    await until(() => page.locator('.pet-limits').evaluate(d => d.open), 'problem chip opens the folded group');
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('formcontrolname') === 'queueSize'), 'invalid field focused');
    await page.getByRole('spinbutton', { name: 'Pet queue size' }).fill('4');
    await until(async () => (await page.locator('.pet-limits__sum').innerText()).includes('4 waiting'), 'limits summary follows values');
    // Own voice off hides voice/personality/limits and offers one way back.
    await page.getByRole('switch', { name: 'Speak on its own' }).uncheck();
    await page.getByRole('heading', { name: 'Its own voice and personality are off' }).waitFor();
    assert.equal(await page.locator('#pet-voice, #pet-personality, #pet-behavior').count(), 0);
    assert.equal(await page.locator('.lf-head__chips').getByText(/Piper/).count(), 0);
    await page.getByText('Turn on “Speak on its own” for these to work.').waitFor();
    await page.locator('.pet-off').getByRole('button', { name: 'Turn on' }).click();
    await page.locator('#pet-voice').waitFor();
    await page.locator('select[formcontrolname=voice]').waitFor();
    // Provider cards show honest cost tags; Kokoro adds the credits note.
    assert.match(await page.locator('.pet-providers').innerText(), /Piper[\s\S]*Free[\s\S]*Kokoro[\s\S]*Uses credits[\s\S]*Fish Audio[\s\S]*Uses credits/);
    await page.getByRole('radio', { name: /Kokoro/ }).check();
    await page.locator('.lf-note--gold').getByText(/Uses your credits each time/).waitFor();
    // Copy buttons for the pet functions.
    await page.getByRole('button', { name: 'Copy $(pet.talk Hello chat!)' }).click();
    await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === '$(pet.talk Hello chat!)', 'function copied');
    // Fix the image and save: checklist turns ready.
    await page.getByRole('button', { name: 'Choose talking image' }).click();
    const dialog = page.getByRole('dialog'); await dialog.locator('.asset').first().click(); await dialog.locator('button.use').click();
    await dialog.waitFor({ state: 'detached' });
    await until(async () => (await statusTitle(page)) === 'Dima is ready for your stream', 'ready title');
    assert.match(await page.locator('#pet-status-title + .lf-note').innerText(), /speaks when your commands and events use/);
    await saveButton(page).click();
    await page.getByText('Pet configuration saved', { exact: true }).waitFor();
    const saved = state.writes.at(-1).settings;
    assert.equal(saved.enabled, true); assert.equal(saved.behavior.queueSize, 4); assert.equal(saved.tts.provider, 'kokoro');
    assert.equal(saved.appearance.talkingAssetId, 'a'.repeat(24));
    await context.close();
  }
  {
    // OBS URL: create when missing (amber strip), replacing needs the folded group + explicit confirm.
    const { page, context, state } = await open({ token: false });
    assert.match(await page.locator('.pet-setup').getAttribute('class'), /pet-setup--warn/);
    assert.match(await statusTitle(page), /3 steps left/);
    await page.getByRole('button', { name: 'Create browser-source URL' }).click();
    await page.getByRole('textbox', { name: 'Private pet browser-source URL' }).waitFor();
    await until(async () => !/pet-setup--warn/.test(await page.locator('.pet-setup').getAttribute('class')), 'strip leaves warning');
    await page.locator('summary', { hasText: 'URL leaked or not working?' }).click();
    await page.getByRole('button', { name: 'Replace URL' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(state.rotations.length, 1, 'only the create call; cancel never rotates');
    await context.close();
  }
  {
    // Live2D: computer picker lives with the look choice; saved-issue lines explain server problems.
    const { page, context } = await open({ settings: { appearance: { kind: 'vts', idleAssetId: null, talkingAssetId: null }, playback: { target: 'browser', desktopSessionId: null, vtsSessionId: 'd'.repeat(24) } },
      runtime: { issues: ['vts_unavailable'], playbackAvailable: true } });
    await page.locator('#pet-look').getByRole('combobox', { name: 'Computer running VTube Studio' }).waitFor();
    await page.getByText("VTube Studio isn't ready on the chosen computer.", { exact: false }).waitFor();
    assert.match(await page.locator('.lf-head__chips').innerText(), /Player connected[\s\S]*Live2D pet/);
    await page.getByRole('radio', { name: 'A computer with Dima App', exact: true }).check();
    await page.locator('#pet-setup').getByRole('combobox', { name: 'Computer for pet audio' }).waitFor();
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    for (const variant of ['default', 'ownVoiceOff']) {
      const { page, context } = await open({ theme, width, settings: variant === 'ownVoiceOff' ? { sources: { independent: false, readTts: true } } : {} });
      await page.locator('[data-mood=happy] summary').click();
      if (variant === 'default') { await page.locator('.pet-limits summary').click(); await page.getByRole('switch', { name: 'Enable pet responses' }).check(); }
      await page.waitForTimeout(250);
      await axe(page, `${theme}/${width}/${variant}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme}/${width}/${variant}`);
      // Every primary button has a visible fill (undefined tokens render transparent).
      const fills = await page.locator('.lf-btn--primary').evaluateAll(e => e.map(x => getComputedStyle(x).backgroundColor));
      assert(fills.every(c => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'), `primary fills ${theme}/${width}`);
      if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/pet-ux-${variant}-${theme}-${width}.png`, fullPage: true }); }
      await context.close();
    }
  }
  {
    const { page, context } = await open({ language: 'es', width: 390 });
    await page.getByRole('heading', { name: 'Mascota', exact: true }).waitFor();
    await until(async () => (await statusTitle(page)) === 'Faltan 2 pasos para que Dima aparezca en el stream', 'Spanish status');
    await page.getByRole('heading', { name: 'Añade tu mascota a OBS' }).waitFor();
    await page.locator('.pet-limits summary', { hasText: 'Cola y límites' }).waitFor();
    await axe(page, 'Spanish');
    await context.close();
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('PASS pet page UX: readiness checklist + jump-to-fix, fix-before-saving chips (incl. folded limits), own-voice off/on, honest provider cost tags, function copy, OBS URL create/replace confirm, Live2D computer + saved issue, chips, axe/overflow/primary fills at 320/390/1280 dark+light, Spanish');
} finally { await browser.close(); }
