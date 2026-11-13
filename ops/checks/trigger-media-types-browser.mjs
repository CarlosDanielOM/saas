// All API requests, including uploads and trigger tests, are intercepted with disposable fixtures.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
// saas-ops copies this check into its private run directory before execution.
const repo = process.env.SAAS_REPO_ROOT || '/root/saas';
const shots = process.env.SAAS_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const user = { id: '991542', login: 'mediafixture', display_name: 'Media Fixture' };
const id = n => String(n).padStart(24, '0');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
// A looping, two-frame red/blue GIF, generated locally rather than downloaded.
const gif = Buffer.from('47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex');
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const samples = [
  { type: 'image', mime: 'image/png', ext: 'png', body: png },
  { type: 'gif', mime: 'image/gif', ext: 'gif', body: gif },
  { type: 'audio', mime: 'audio/wav', ext: 'wav', body: wav },
  { type: 'video', mime: 'video/webm', ext: 'webm', body: readFileSync(`${repo}/ops/checks/clip-recommendations-fixtures/moment-1.webm`) }
];
const triggerOverlay = readFileSync(`${repo}/dimabot/src/server/routes/public/trigger.html`, 'utf8');
function libraryItem(sample, n) {
  const asset = { _id: id(n), displayName: `Sample_${sample.type}`, fileName: `sample.${sample.ext}`,
    extension: sample.ext, mimeType: sample.mime, mediaType: sample.type, bytes: sample.body.length,
    ownerChannelID: user.id, ownerChannelName: user.login, scope: 'public', marketplaceStatus: 'published',
    playbackUrl: `https://media.fixture.invalid/sample.${sample.ext}` };
  return { _id: id(n + 100), assetID: asset._id, relationType: 'owner_upload', localAlias: null,
    quotaBytesCharged: 0, assetScope: 'public', mediaType: sample.type, isActive: true, asset };
}
async function open(browser, { theme = 'dark', width = 390, lang = 'en', permissions = true } = {}) {
  const app = { name: 'Media Fixture', email: 'fixture@example.invalid', language: lang, plan_tier: 'pro',
    actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true,
    up_to_date_permissions: true, administrating: [] };
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme, lang }) => {
    localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', lang);
    localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: user, appUser: app, permissions: {} }));
  }, { user, app, theme, lang });
  await context.routeWebSocket(/.*/, ws => ws.close());
  const state = { library: samples.map((s, i) => libraryItem(s, i + 1)), triggers: [], uploads: [], creates: [], sends: [], rejectUpload: false };
  const meta = { planTier: 'pro', quotaBytesUsed: 0, quotaBytesLimit: 1_000_000_000 };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (url.origin === new URL(base).origin) {
      if (p.startsWith('/mediafixture/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.hostname === 'media.fixture.invalid') {
      const sample = samples.find(s => p.endsWith(`.${s.ext}`));
      return sample ? route.fulfill({ body: sample.body, contentType: sample.mime }) : route.abort();
    }
    if (url.hostname !== 'api.domdimabot.com') return route.abort();
    if (p.startsWith('/overlays/triggers/')) return route.fulfill({ body: triggerOverlay, contentType: 'text/html' });
    let data = [];
    if (p === '/auth/session') data = { twitch: user, app };
    else if (p.startsWith('/auth/access/')) {
      const permission = url.searchParams.get('permission') || '';
      data = { allowed: permissions || !['triggers:attach', 'triggers:upload', 'triggers:edit', 'triggers:delete'].includes(permission) };
    } else if (p.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (p === `/triggers/library/${user.id}/upload`) {
      assert.equal(request.method(), 'POST');
      const multipart = request.postDataBuffer().toString('latin1');
      state.uploads.push(multipart);
      if (state.rejectUpload) return route.fulfill({ status: 400, json: { error: true, message: 'Storage quota exceeded', status: 400 } });
      const sample = samples.find(s => multipart.includes(`Content-Type: ${s.mime}`));
      assert.ok(sample, 'upload preserves its media MIME type');
      assert.ok(multipart.includes('name="trigger"') && multipart.includes('name="name"') && multipart.includes('name="scope"'));
      data = libraryItem(sample, 10 + state.uploads.length);
      data.asset.displayName = `Uploaded_${sample.type}`;
      state.library.unshift(data);
    } else if (p === `/triggers/library/${user.id}`) data = state.library;
    else if (p === '/triggers/assets/public') data = state.library.map(item => item.asset);
    else if (p === `/triggers/${user.id}/send`) { state.sends.push(request.postDataJSON()); data = {}; }
    else if (p === `/triggers/${user.id}` && request.method() === 'POST') {
      const body = request.postDataJSON(); state.creates.push(body);
      const item = state.library.find(item => item._id === body.libraryItemID);
      assert.ok(item, 'trigger uses a library item');
      data = { _id: id(300 + state.creates.length), name: body.name, channel: user.login, channelID: user.id,
        file: item.asset.displayName, mediaType: item.asset.mimeType, isEnabled: true, volume: body.volume,
        libraryItemID: item._id, assetID: item.assetID, reward: null, rewardID: '' };
      state.triggers.unshift(data);
    } else if (p === `/triggers/${user.id}`) data = state.triggers;
    return route.fulfill({ json: { error: false, status: 200, data, meta } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/mediafixture/modules/triggers');
  const root = page.locator('app-triggers-page');
  try { await root.locator('.lf-media-row').first().waitFor(); }
  catch (error) {
    console.error('Fixture page failed to load', { url: page.url(), body: (await page.locator('body').innerText()).slice(0, 1500), errors });
    await page.screenshot({ path: '/tmp/trigger-media-open-failure.png' });
    throw error;
  }
  return { page, root, context, state, errors };
}
async function closeDialog(page) {
  await page.getByRole('dialog').locator('button.lf-modal__close').click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
async function checkLayout(page, selector, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `page overflow ${label}`);
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(', ')}`), [], `axe ${label}`);
}
async function shot(page, name) { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); }

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  // End-to-end dashboard interactions: file chooser, drop, multipart upload, picker, save, and test.
  {
    const { page, root, context, state, errors } = await open(browser);
    for (const sample of samples) {
      await root.locator('.lf-head__actions').getByRole('button', { name: 'Upload media', exact: true }).click();
      const dialog = page.getByRole('dialog');
      assert.match(await dialog.locator('input[type=file]').getAttribute('accept'), /image\/\*/);
      const file = { name: `Uploaded_${sample.type}.${sample.ext}`, mimeType: sample.mime, buffer: sample.body };
      if (sample.type === 'gif') {
        await dialog.locator('.lf-drop').evaluate((el, file) => {
          const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(file.bytes), c => c.charCodeAt(0))], file.name, { type: file.mime }));
          el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, { name: file.name, mime: file.mimeType, bytes: file.buffer.toString('base64') });
      } else await dialog.locator('input[type=file]').setInputFiles(file);
      await dialog.locator('.lf-modal__footer .lf-btn--primary').click();
      await dialog.waitFor({ state: 'detached' });
      const row = root.locator('.lf-media-row').filter({ hasText: `Uploaded ${sample.type}` });
      await row.waitFor();
      assert.equal(await row.getByText('Not usable yet').count(), 0);
      await row.getByRole('button', { name: `Create a trigger with Uploaded ${sample.type}`, exact: true }).click();
      const editor = page.getByRole('dialog');
      await editor.locator('.lf-pick__select').first().waitFor();
      assert.equal(await editor.locator('.lf-pick__select').count(), state.library.length, 'picker offers images, GIFs, audio and video');
      assert.equal(await editor.locator('.lf-pick.is-selected strong').innerText(), `Uploaded ${sample.type}`);
      await editor.locator('.lf-step').nth(1).locator('input[type=text]').fill(`Trigger_${sample.type}`);
      await editor.locator('.lf-modal__footer .lf-btn--primary').click();
      await editor.waitFor({ state: 'detached' });
      assert.equal(state.creates.at(-1).reward, null);
      const sent = page.waitForResponse(response => new URL(response.url()).pathname === `/triggers/${user.id}/send`);
      await root.getByRole('button', { name: `Test Trigger_${sample.type} on the overlay`, exact: true }).click();
      await sent;
      assert.equal(state.sends.at(-1)?.mediaType, sample.mime, `${sample.type} test sends its original MIME`);
      assert.equal(state.sends.at(-1)?.url, `https://media.fixture.invalid/sample.${sample.ext}`);
      const player = page.frameLocator('.lf-test-frame__iframe');
      if (['image', 'gif'].includes(sample.type)) {
        await player.locator('img').evaluate(img => img.decode());
        assert.ok(await player.locator('img').evaluate(img => img.naturalWidth > 0), 'overlay decodes the uploaded image/GIF');
        await player.locator('img').waitFor({ state: 'detached', timeout: 7000 });
      } else {
        await player.locator(sample.type).evaluate(media => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('media did not play')), 8000);
          media.addEventListener('timeupdate', () => { if (media.currentTime > 0) { clearTimeout(timeout); resolve(); } });
        }));
      }
      await closeDialog(page);
    }
    assert.equal(state.uploads.length, 4); assert.equal(state.creates.length, 4);
    // Server-side quota rejection keeps the selected file/draft available for correction.
    state.rejectUpload = true;
    await root.locator('.lf-head__actions').getByRole('button', { name: 'Upload media', exact: true }).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('dialog').locator('.lf-modal__footer .lf-btn--primary').click();
    await page.getByText('Storage quota exceeded', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    await closeDialog(page);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS uploads and trigger playback for all four media types, plus upload failure handling.');
  }

  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { page, root, context, errors } = await open(browser, { theme, width });
    await checkLayout(page, 'app-triggers-page', `${theme} ${width} page`);
    for (const sample of samples.filter(s => ['image', 'gif'].includes(s.type))) {
      const row = root.locator('.lf-media-row').filter({ hasText: `Sample ${sample.type}` });
      await row.getByRole('button', { name: `Preview Sample ${sample.type}`, exact: true }).click();
      await page.getByRole('dialog').locator('img').evaluate(img => img.decode());
      assert.ok(await page.getByRole('dialog').locator('img').evaluate(img => img.naturalWidth > 0));
      await closeDialog(page);
    }
    await root.locator('.lf-head__actions .lf-btn--primary').click();
    await page.getByRole('dialog').locator('.lf-pick__select').first().waitFor();
    assert.equal(await page.getByRole('dialog').locator('.lf-pick__select').count(), 4);
    await checkLayout(page, '.lf-modal--form', `${theme} ${width} editor`);
    await shot(page, `trigger-media-editor-${theme}-${width}`);
    await closeDialog(page);
    await root.locator('.lf-head__actions').getByRole('button', { name: 'Upload media', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /Image, GIF, audio or video/);
    await checkLayout(page, '.lf-modal--narrow', `${theme} ${width} upload`);
    await shot(page, `trigger-media-upload-${theme}-${width}`);
    await closeDialog(page);
    await root.getByRole('button', { name: 'Browse public library', exact: true }).click();
    const publicDialog = page.locator('app-public-library-modal');
    await publicDialog.locator('.lf-asset-card').first().waitFor();
    assert.equal(await publicDialog.getByRole('button', { name: /^Create a trigger with/ }).count(), 4, 'public library offers all four types');
    await checkLayout(page, 'app-public-library-modal', `${theme} ${width} public library`);
    await publicDialog.getByRole('button', { name: 'Create a trigger with Sample gif', exact: true }).click();
    await page.getByRole('dialog').locator('.lf-pick__select').first().waitFor();
    assert.equal(await page.getByRole('dialog').locator('.lf-pick.is-selected strong').innerText(), 'Sample gif');
    await closeDialog(page);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS trigger media layout/accessibility: ${theme} ${width}px.`);
  }
  {
    const { page, context } = await open(browser, { lang: 'es' });
    await page.locator('.lf-head__actions .lf-btn').first().click();
    assert.match(await page.getByRole('dialog').innerText(), /Imagen, GIF, audio o video/);
    await context.close();
  }
  {
    const { root, context } = await open(browser, { permissions: false });
    assert.equal(await root.locator('.lf-head__actions button').count(), 0, 'upload/create remain permission gated');
    await context.close();
  }
  console.log('PASS trigger media: PNG/GIF/WAV/WebM chooser/drop multipart uploads, all-type picker/save/test, image/GIF decoding, public-library creation, quota rejection, permissions, English/Spanish, 320/390/1280px dark/light layout and axe.');
} finally { await browser.close(); }
