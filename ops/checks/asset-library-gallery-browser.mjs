import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991004', login: 'gallery', display_name: 'Gallery' };
const app = { name: 'Gallery', email: 'gallery@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const id = n => n.toString(16).padStart(24, '0');
const asset = (n, kind, name) => ({ id: id(n), name, kind, mime: kind === 'video' ? 'video/webm' : 'image/png', bytes: 45_000_000, width: 1920, height: 1080, createdAt: new Date().toISOString() });
const names = ['Starting soon.png', 'BRB screen.png', 'Webcam frame.png', 'Sub alert.png', 'Raid banner.png', 'Ending.png'];
let assets = [...names.map((name, i) => asset(i + 1, 'image', name)), asset(20, 'video', 'Intro loop.webm'), asset(21, 'video', 'Confetti.webm')];
const quota = 500_000_000;
const used = () => assets.reduce((sum, a) => sum + a.bytes, 0);
const writes = [], errors = [];
const until = async (read, expected, message) => {
  for (let i = 0; i < 40; i++) { if (await read() === expected) return; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(await read(), expected, message);
};
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  // Record a short real WebM in the browser so video thumbnails have a frame to show.
  const recorder = await browser.newPage();
  const webm = Buffer.from(await recorder.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    let frame = 0; const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#7c3aed' : '#ef4444'; ctx.fillRect(0, 0, 160, 90); }, 60);
    rec.start(); await new Promise(r => setTimeout(r, 900)); rec.stop(); await new Promise(r => rec.onstop = r); clearInterval(timer);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let bin = ''; buf.forEach(b => bin += String.fromCharCode(b)); return btoa(bin);
  }), 'base64');
  await recorder.close();
  assert(webm.length > 200, 'recorded a WebM fixture');

  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
    await context.routeWebSocket(/./, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(base).origin) {
        if (url.pathname.startsWith('/gallery/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
        return route.continue();
      }
      if (url.origin !== api) return route.abort();
      if (url.pathname.startsWith('/asset-library/content/')) {
        const item = assets.find(a => a.id === url.pathname.split('/')[3]);
        return item?.kind === 'video' ? route.fulfill({ body: webm, contentType: 'video/webm' }) : route.fulfill({ body: png, contentType: 'image/png' });
      }
      let data = {};
      if (url.pathname === `/asset-library/${user.id}`) {
        if (request.method() === 'POST') { writes.push('POST'); const added = asset(99, 'image', 'Dropped overlay.png'); assets = [added, ...assets]; data = added; }
        else data = { assets, usedBytes: used(), quotaBytes: quota, maxFileBytes: 50_000_000, planTier: app.plan_tier };
      } else if (url.pathname.startsWith('/asset-library/') && url.pathname.endsWith('/access')) data = { path: `/asset-library/content/${url.pathname.split('/')[3]}?ticket=fixture` };
      else if (url.pathname.startsWith('/asset-library/') && request.method() === 'DELETE') { writes.push('DELETE'); const del = url.pathname.split('/')[3]; assets = assets.filter(a => a.id !== del); }
      else if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: app.plan_tier };
      else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
      else if (url.pathname.startsWith('/admins/')) data = [];
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/gallery/settings');
    await page.getByRole('button', { name: 'Browse Asset Library', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Asset Library', exact: true });
    await dialog.locator('.asset').first().waitFor();
    const first = theme === 'dark' && width === 1280;

    if (first) {
      // 8 assets x 45 MB = 360 MB of 500 MB: not yet "almost full"; space left is the headline.
      assert.match(await dialog.locator('.quota').innerText(), /140 MB free[\s\S]*360 MB of 500 MB used/);
      assert.equal(await dialog.getByText(/^Almost full/).count(), 0);
      // Type chips with counts and a search box once the library is long.
      const chip = name => dialog.getByRole('group', { name: 'Asset type' }).getByRole('button', { name: new RegExp(`^${name}`) });
      assert.match(await chip('Videos').innerText(), /2/);
      await chip('Videos').click();
      await until(() => dialog.locator('.asset').count(), 2, 'Videos chip filters to videos');
      assert.equal(await chip('Videos').getAttribute('aria-pressed'), 'true');
      await dialog.locator('.asset video').first().evaluate(v => new Promise((resolve, reject) => { if (v.readyState >= 2) resolve(); v.onloadeddata = resolve; v.onerror = reject; setTimeout(() => reject(new Error('video frame did not load')), 8000); }));
      assert.equal(await dialog.locator('.asset video').first().evaluate(v => v.paused && v.videoWidth > 0), true, 'video thumbnails show a paused real frame');
      await chip('All').click();
      const search = dialog.getByRole('searchbox', { name: 'Search assets' });
      await search.fill('raid'); await until(() => dialog.locator('.asset').count(), 1, 'search narrows the grid');
      await search.fill('nothing-here'); await dialog.getByText('No matching assets', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Show all assets' }).click();
      await until(() => dialog.locator('.asset').count(), 8, 'Show all clears search and filter');
      // Dropping a file onto the dialog uploads it and selects it.
      await dialog.evaluate(d => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'Dropped overlay.png', { type: 'image/png' })); d.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); d.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
      await dialog.getByRole('complementary', { name: 'Selected asset' }).getByText('Dropped overlay.png').waitFor();
      assert.equal(writes.filter(w => w === 'POST').length, 1, 'drop uploads once');
      // 9 assets = 405 MB (81%) of 500 MB: crosses into the "almost full" warning.
      assert.match(await dialog.locator('.quota').innerText(), /95 MB free/);
      await dialog.getByText(/^Almost full/).waitFor();
      // Delete explains the consequence before it runs.
      await dialog.getByRole('button', { name: 'Delete asset', exact: true }).click();
      await dialog.getByText(/removes the file for good/).waitFor();
      assert.equal(writes.includes('DELETE'), false, 'first click only asks');
      await dialog.getByRole('button', { name: 'Yes, delete permanently', exact: true }).click();
      await dialog.locator('.selection').waitFor({ state: 'detached' });
      assert.equal(assets.some(a => a.name === 'Dropped overlay.png'), false);
    } else {
      await dialog.locator('.asset').first().click();
      await dialog.locator('.selection').waitFor();
    }
    await page.waitForTimeout(250);
    assert.equal(await dialog.evaluate(d => d.scrollWidth > d.clientWidth), false, `dialog overflow ${theme} ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `page overflow ${theme} ${width}`);
    for (const button of await dialog.locator('footer button, .tools button').all()) assert((await button.boundingBox()).height >= 40, 'touch targets');
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(() => window.axe.run(document.querySelector('app-asset-library-dialog'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe ${theme} ${width}`);
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/gallery-${theme}-${width}.png` }); }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS Asset Library gallery: space-left headline, almost-full warning, type chips, search after 6 assets, real paused video frames, drag-and-drop upload, explained delete, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
