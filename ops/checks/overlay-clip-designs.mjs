import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const api = 'https://api.domdimabot.com', publicId = 'a'.repeat(48), errors = [];
// One-second H.264/AAC fixture generated with ffmpeg in an isolated candidate container.
const mp4 = Buffer.from('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', 'base64');
const variants = ['classic', 'third', 'tile', 'cinema', 'orbit', 'pill', 'hud', 'slash'];
const user = { id: '990091', login: 'fixture', display_name: 'Fixture' };
const app = { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const widget = { id: 'clip-1', kind: 'clip', x: 40, y: 40, width: 800, height: 240, visible: true, locked: false };
const text = { ...widget, id: 'text', kind: 'text', text: '$(user)' };
const design = { id: 'starter', name: 'My alerts', revision: 1, width: 800, height: 240, events: Object.fromEntries(['follow', 'bits', 'sub', 'raid'].map(kind => [kind, { duration: 1, widgets: [text] }])) };
let state = { schemaVersion: 1, revision: 0, scenes: [{ id: 'main', name: 'My overlay', publicId, revision: 0, width: 1920, height: 1080, waitFor: ['clip'], widgets: [widget] }], designs: [design] };
const metadata = { streamer: 'Fixture streamer', game: 'Fixture game', description: '<img src=x onerror=bad> clip caption', profileImage: 'https://fixture.invalid/avatar.svg', streamerColor: '#22c55e' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e11d48"/><text x="10" y="43" fill="white" font-size="32">FX</text></svg>';
const shots = process.env.SAAS_SCREENSHOT_DIR;
async function session(context, tier = 'pro') {
  await context.addInitScript(({ user, app }) => { localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); localStorage.setItem('dimasite.language', 'en'); }, { user, app: { ...app, plan_tier: tier } });
}
async function until(predicate, message) { for (let i = 0; i < 240; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error(message); }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await session(context);
  let legacySocket; const editorEnded = [];
  await context.routeWebSocket('**/*', ws => { if (!ws.url().includes('/socket.io/')) return ws.close(); legacySocket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); ws.onMessage(message => { const m = String(message); if (m.startsWith('40/clip/')) ws.send(`40/clip/${user.id},{"sid":"fixture"}`); if (m.includes('clip-ended')) editorEnded.push(m); }); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/video/clip/')) return route.fulfill({ contentType: 'video/mp4', body: mp4 });
    if (url.href === metadata.profileImage) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (url.origin === new URL(base).origin) return route.continue(); if (url.origin !== api) return route.abort();
    let data = {};
    if (url.pathname === '/auth/session') data = { twitch: user, app };
    else if (url.pathname.endsWith('/access') || url.pathname.startsWith('/auth/access/')) data = { allowed: true, role: 'owner', planTier: 'pro' };
    else if (url.pathname.endsWith('/preview')) data = req.postDataJSON().texts.map(t => t.replaceAll('$(user)', 'Luna'));
    else if (url.pathname === '/clip/test') { legacySocket.send(`42/clip/${user.id},${JSON.stringify(['play-clip', { clipID: 'fixture-clip', streamerLogin: 'fixture', title: 'Fixture title', duration: 30, ...metadata }])}`); }
    else if (url.pathname.endsWith('/connections')) data = { checkedAt: Date.now(), pollingFailed: false, scenes: [] };
    else if (url.pathname === `/overlay-studio/${user.id}`) { if (req.method() === 'PUT') { state = structuredClone(req.postDataJSON()); state.revision++; } data = state; }
    else if (url.pathname.includes('/scenes/')) { const s = state.scenes[0]; s.revision++; s.published = structuredClone({ width: s.width, height: s.height, widgets: s.widgets, waitFor: s.waitFor, designs: state.designs }); state.revision++; data = state; }
    return route.fulfill({ json: { error: false, status: 200, data } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  const load = async () => { await page.goto(base + '/fixture/modules/overlays'); await page.locator('app-overlay-editor .stage').waitFor(); await page.locator('.widget[data-kind="clip"]').first().click(); };
  await load();
  const select = page.getByLabel('Clip design', { exact: true }); await select.waitFor();
  assert.equal(await select.inputValue(), 'classic', 'older widgets without a design keep a valid default');
  assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(o => [o.value, o.disabled])), variants.map(v => [v, false]));
  const geometry = [];
  for (const variant of variants) {
    await select.selectOption(variant); await page.waitForFunction(v => document.querySelector('.widget app-overlay-clip .clip-design').dataset.variant === v, variant);
    const composition = await page.locator('.widget app-overlay-clip').evaluate(element => {
      const canvas = element.querySelector('.clip-design'), video = element.querySelector('.skin__video'), meta = element.querySelector('.skin__meta');
      const c = canvas.getBoundingClientRect(), v = video.getBoundingClientRect(), m = meta.getBoundingClientRect();
      return { aspect: c.width / c.height, videoWidth: v.width / c.width, metaWidth: m.width / c.width, metaTop: (m.top - c.top) / c.height, videoMask: getComputedStyle(video).clipPath };
    });
    if (['third', 'cinema', 'pill', 'hud', 'slash'].includes(variant)) {
      assert.ok(Math.abs(composition.aspect - 16 / 9) < .01, `${variant} must use its own 16:9 composition, not the Classic banner`);
      assert.ok(composition.videoWidth > .99, `${variant} keeps a full-canvas clip`);
    }
    if (['third', 'cinema'].includes(variant)) { assert.ok(composition.metaWidth > .99); assert.ok(composition.metaTop > .5, `${variant} has bottom chrome, not a side panel`); }
    if (variant === 'pill') assert.ok(composition.metaTop > .75, 'Pill floats at the bottom');
    if (variant === 'slash') {
      assert.equal(composition.videoMask, 'none', 'the decorative Slash mask must not cut the video');
      assert.ok(composition.videoWidth > .99, 'Slash overlays its mesh on the full video');
      const meta = await page.locator('.widget app-overlay-clip .skin__meta').evaluate(e => ({ background: getComputedStyle(e).backgroundImage, mask: getComputedStyle(e).clipPath }));
      assert.match(meta.background, /repeating-linear-gradient/, 'Slash has a mesh');
      assert.match(meta.background, /rgba\([^)]*, 0\)/, 'Slash fades from transparent');
      assert.match(meta.mask, /polygon/, 'Slash decor has a diagonal edge');
    }
    geometry.push(await page.locator('.widget app-overlay-clip').evaluate(element => {
      const frame = element.getBoundingClientRect();
      const video = element.querySelector('.skin__video');
      const meta = element.querySelector('.skin__meta');
      const avatar = element.querySelector('.skin__avatar');
      const vrect = video.getBoundingClientRect(), mrect = meta.getBoundingClientRect(), arect = avatar.getBoundingClientRect(), ast = getComputedStyle(avatar);
      return [Math.round(vrect.width), Math.round(vrect.height), Math.round(mrect.x - frame.x), Math.round(mrect.y - frame.y), Math.round(mrect.width), Math.round(mrect.height), getComputedStyle(video).clipPath, ast.display, ast.left, ast.top, ast.right, ast.bottom, Math.round(arect.width), Math.round(arect.height)].join(':');
    }));
  }
  assert.equal(new Set(geometry).size, 8, 'all designs must have different layout geometry');
  for (const entry of geometry) { const [width, height] = entry.split(':').map(Number); assert.ok(Math.abs(width / height - 16 / 9) < 0.03, `every design must give the clip a 16:9 slot, got ${width}x${height}`); }
  await select.selectOption('pill');
  await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('domdimabot-overlay-draft:') && JSON.parse(localStorage.getItem(k)).scenes[0].widgets[0].clipDesign === 'pill'));
  page.once('dialog', d => d.accept()); await page.reload(); await page.getByRole('button', { name: 'Restore local draft', exact: true }).click(); await select.waitFor(); await page.waitForFunction(() => document.querySelector('[aria-label="Clip design"]').value === 'pill').catch(async e=>{console.log('Restored variant', await page.locator('.widget .clip-design').getAttribute('data-variant'));throw e;}); assert.equal(await select.inputValue(), 'pill');
  const save = async () => { await page.locator('app-overlay-editor .topbar').getByRole('button', { name: 'Save draft', exact: true }).click(); await page.locator('app-overlay-editor .topbar').getByRole('button', { name: 'Saved', exact: true }).waitFor(); };
  await save(); assert.equal(state.scenes[0].widgets[0].clipDesign, 'pill');
  const publish = async () => { const response = page.waitForResponse(r => r.url().endsWith('/publish')); await page.locator('.publish-button').click(); await response; await page.waitForFunction(() => !document.querySelector('.editor-fields').disabled); await page.getByText('Published. Connected browser sources are updating.', { exact: true }).waitFor(); };
  await publish(); assert.equal(state.scenes[0].published.widgets[0].clipDesign, 'pill');
  await select.selectOption('hud'); await save(); assert.equal(state.scenes[0].published.widgets[0].clipDesign, 'pill', 'saving a design never changes the published layout');
  await page.locator('.properties').getByRole('button', { name: 'Duplicate', exact: true }).click(); await select.selectOption('slash'); await save(); await publish();
  assert.deepEqual(state.scenes[0].published.widgets.map(w => w.clipDesign), ['hud', 'slash']);
  await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.widget app-overlay-clip video').length === 2);
  assert.equal(await page.locator('.widget app-overlay-clip').count(), 2, 'each playing widget has one renderer; sample metadata must be removed');
  assert.deepEqual(await page.locator('.widget app-overlay-clip video').evaluateAll(videos => videos.map(v => v.muted)), [false, true]);
  assert.equal(await page.locator('.widget app-overlay-clip .skin__name').getByText('Fixture streamer', { exact: true }).count(), 2);
  await until(() => editorEnded.length === 1, 'editor clip test must release the producer once after both players finish');
  assert.equal(await page.locator('.widget app-overlay-clip').count(), 2, 'sample cards return after completion');
  await select.selectOption('orbit');
  await page.locator('.event-tester__actions').getByRole('button', { name: 'Clips', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.widget app-overlay-clip video').length === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.widget app-overlay-clip video')].every(v => v.readyState >= 2 && !v.paused));
  await page.locator('.widget app-overlay-clip video').evaluateAll(videos => videos.forEach(v => v.pause()));
  assert.equal(await page.locator('.widget app-overlay-clip').count(), 2, 'Orbit has one text layer per placement during playback');
  assert.equal(await page.locator('.widget [data-variant="orbit"] .skin__name').textContent(), 'Fixture streamer');
  await page.waitForFunction(() => [...document.querySelectorAll('.widget app-overlay-clip .clip-design')].every(e => e.classList.contains('is-in') && e.getAnimations({ subtree: true }).every(a => a.playState === 'finished')));
  if (shots) await page.locator('.widget[data-kind="clip"]').last().screenshot({ path: `${shots}/editor-orbit-playing.png` });
  await page.locator('.widget app-overlay-clip video').evaluateAll(videos => videos.forEach(v => v.dispatchEvent(new Event('ended'))));
  await page.locator('.widget .clip-design.is-out').first().waitFor();
  assert.equal(editorEnded.length, 1, 'Studio holds its producer until the exit is finished');
  await until(() => editorEnded.length === 2, 'Orbit completion restores its sample card');
  await select.selectOption('slash');
  await page.locator('.widget[data-kind="clip"]').last().click();
  for (const width of [320, 375, 768, 1440]) { await page.setViewportSize({ width, height: 1000 }); if (width < 780) await page.locator('.mobile-tabs').getByRole('button', { name: 'Properties', exact: true }).click(); await select.waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${width}`); if (shots && [375, 1440].includes(width)) { await mkdir(shots, { recursive: true }); await page.locator('.properties').screenshot({ path: `${shots}/clip-selector-${width}.png` }); } }
  await page.addScriptTag({ path: '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js' });
  const axe = async () => { const result = await page.evaluate(() => window.axe.run(document.querySelector('app-overlay-editor'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []); }; await axe();
  await page.locator('app-overlay-editor .topbar__actions button').first().click(); await page.getByLabel('Diseño de clips', { exact: true }).waitFor(); await axe();
  assert.equal(await page.getByLabel('Diseño de clips', { exact: true }).inputValue(), 'slash'); await context.close();
  console.log('PASS editor: eight distinct designs, default for older widgets, local recovery/save, publish isolation, independent placements, real native clip preview with metadata and single audio, en/es, mobile and axe.');

  // The standalone catalog continues to grant two designs to Free and all eight to both paid tiers.
  for (const tier of ['free', 'premium', 'pro']) {
    const c = await browser.newContext(); await session(c, tier); await c.routeWebSocket('**/*', ws => ws.close());
    await c.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === new URL(base).origin) return route.continue(); if (url.origin !== api) return route.abort(); const data = url.pathname === '/auth/session' ? { twitch: user, app: { ...app, plan_tier: tier } } : { allowed: true, role: 'owner', planTier: tier }; return route.fulfill({ json: { error: false, data } }); });
    const p = await c.newPage(); await p.goto(base + '/fixture/modules/clips'); await p.locator('.lf-slide').first().waitFor();
    assert.equal(await p.locator('.lf-slide').count(), 8);
    assert.equal(await p.locator('.lf-slide__actions a').count(), tier === 'free' ? 2 : 8);
    assert.equal(await p.locator('app-clip-design-mock .clip-design').count(), 8);
    for (const width of [320, 1440]) {
      await p.setViewportSize({ width, height: 1000 });
      const canvases = await p.locator('app-clip-design-mock .clip-design').evaluateAll(elements => elements.map(e => ({ variant: e.dataset.variant, width: e.offsetWidth, height: e.offsetHeight })));
      assert.deepEqual(canvases, variants.map(variant => ({ variant, width: 800, height: ['third', 'cinema', 'pill', 'hud', 'slash'].includes(variant) ? 450 : 225 })), 'catalog canvases must not flex-shrink before scaling');
    }
    await c.close();
  }
  console.log('PASS shared catalog: Free retains Classic/Third; Premium and Pro retain all eight designs.');

  const runtime = await browser.newContext({ viewport: { width: 960, height: 650 } }); let socket, revision = 1; const ended = [], health = [], events = new Map();
  let snapshot = { width: 900, height: 600, waitFor: ['clip'], widgets: [{ ...widget, x: 30, y: 20 }, { ...widget, id: 'second', x: 30, y: 300, clipDesign: 'slash' }], designs: [] };
  const send = (name, value) => socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name, value])}`);
  await runtime.routeWebSocket('**/*', ws => { if (!ws.url().includes('/socket.io/')) return ws.close(); socket = ws; ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}'); ws.onMessage(message => { const m = String(message); if (m.startsWith('40/overlay-studio/')) { ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`); send('overlay-state', { revision, snapshot }); } else if (m.includes('overlay-ended')) ended.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); else if (m.includes('overlay-health')) health.push(JSON.parse(m.slice(m.indexOf(',') + 1))[1]); }); });
  await runtime.route('**/*', route => { const url = new URL(route.request().url()); if (url.pathname === '/clip-fixture.mp4') return route.fulfill({ contentType: 'video/mp4', body: mp4 }); if (url.href === metadata.profileImage) return route.fulfill({ contentType: 'image/svg+xml', body: svg }); if (url.pathname === '/broken.mp4') return route.fulfill({ status: 404, body: '' }); if (url.origin === new URL(base).origin) return route.continue(); if (url.pathname.includes('/events/')) return route.fulfill({ json: { data: events.get(url.pathname.split('/').at(-1)) } }); if (url.pathname.startsWith('/overlay-studio/public/')) return route.fulfill({ json: { data: { revision, snapshot } } }); return route.abort(); });
  const source = await runtime.newPage(); source.on('pageerror', e => errors.push(e.message)); await source.goto(base + '/overlays/' + publicId); await source.locator('.canvas').waitFor();
  // Keep native playback alive while checking the original transitions, then
  // dispatch ended deliberately to exercise duplicate notifications and FIFO.
  const fetches = [];
  await runtime.route('**/events/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1); fetches.push(id);
    return route.fulfill({ json: { data: events.get(id) } });
  });
  for (const variant of variants) {
    snapshot.widgets[0].clipDesign = variant; const id = 'clip-' + variant;
    events.set(id, { id, kind: 'clip', snapshot: structuredClone(snapshot), revision, media: { type: 'video', url: api + '/clip-fixture.mp4', title: 'Fixture title', volume: 1, duration: 30, clip: metadata } }); send('overlay-event', { id, kind: 'clip' });
    await source.waitForFunction(() => document.querySelectorAll('app-overlay-clip video').length === 2 && [...document.querySelectorAll('app-overlay-clip video')].every(v => v.readyState >= 2 && !v.paused));
    await source.locator('app-overlay-clip video').evaluateAll(videos => videos.forEach(v => v.pause()));
    await source.waitForFunction(() => document.querySelectorAll('.clip-design.is-in').length === 2);
    assert.deepEqual(await source.locator('app-overlay-clip .clip-design').evaluateAll(elements => elements.map(e => e.dataset.variant)), [variant, 'slash']);
    assert.deepEqual(await source.locator('app-overlay-clip video').evaluateAll(videos => videos.map(v => [v.muted,getComputedStyle(v).objectFit])), [[false,'contain'], [true,'contain']]);
    const motion = await source.locator('.clip-design').first().evaluate(e => ({
      videoDuration: getComputedStyle(e.querySelector('app-overlay-media')).transitionDuration,
      animated: e.getAnimations({ subtree: true }).some(a => a.playState === 'running'),
      opacity: Number(getComputedStyle(e.querySelector('app-overlay-media')).opacity),
      stagger: getComputedStyle(e.querySelector(e.dataset.variant==='hud' ? '.skin__title' : '.skin__meta')).transitionDelay
    }));
    assert.ok(motion.stagger.split(', ').every(delay => delay === { classic:'0s',third:'0.12s',tile:'0.14s',cinema:'0.16s',orbit:'0.18s',pill:'0.18s',hud:'0.24s',slash:'0.12s' }[variant]), variant + ' preserves original stagger');
    assert.ok(motion.animated, variant + ' runs entrance transitions');
    assert.ok(motion.opacity < 1, variant + ' fades the native media host, including across Angular child boundaries');
    assert.ok(motion.videoDuration.split(', ').every(duration => duration === (variant === 'classic' ? '1.5s' : ['third','slash'].includes(variant) ? '1.2s' : ['cinema','pill','hud'].includes(variant) ? '1.15s' : '1.1s')), variant + ' retains original media transition timing');
    assert.equal(await source.locator('.skin__meta img').count(), 0, 'caption uses plain text');
    assert.equal(await source.locator('.skin__name').first().textContent(), 'Fixture streamer');
    if (variant === 'classic') { snapshot.widgets[0].clipDesign = 'hud'; revision++; send('overlay-updated', { revision }); await until(() => health.some(h => h.revision === revision), 'publish refresh acknowledgement'); assert.equal(await source.locator('app-overlay-clip .clip-design').first().getAttribute('data-variant'), 'classic', 'publishing preserves the active event design'); }
    await source.waitForFunction(() => [...document.querySelectorAll('.clip-design')].every(e => e.getAnimations({ subtree: true }).every(a => a.playState === 'finished') && getComputedStyle(e.querySelector('app-overlay-media')).opacity === '1'));
    if (shots) { await mkdir(shots, { recursive: true }); await source.locator('[data-event="clip"]').first().screenshot({ path: `${shots}/runtime-${variant}.png` }); }
    const nextId = id + '-queued';
    if (variant === 'classic') {
      events.set(nextId, { id: nextId, kind:'clip', media: { type:'video', url: api+'/broken.mp4', title:'', volume:1 } });
      send('overlay-event', { id: nextId, kind:'clip' });
    }
    await source.locator('app-overlay-clip video').evaluateAll(videos => videos.forEach(v => { v.dispatchEvent(new Event('ended')); v.dispatchEvent(new Event('ended')); }));
    await source.waitForFunction(() => document.querySelectorAll('.clip-design.is-out').length === 2);
    await source.waitForTimeout(180);
    assert.equal(ended.includes(id), false, variant + ' keeps its queue slot throughout exit');
    assert.equal(await source.locator('.clip-design.is-out').count(), 2, 'both placements remain mounted during exit');
    const fade = await source.locator('.clip-design.is-out').first().evaluate(e => Number(getComputedStyle(e.querySelector('app-overlay-media')).opacity));
    assert.ok(fade > 0 && fade < 1, variant + ' animates its exit');
    if (variant === 'classic') assert.equal(fetches.includes(nextId), false, 'queued event is not fetched during any placement exit');
    await until(() => ended.includes(id), 'animated clip completion for ' + variant); assert.equal(ended.filter(e => e === id).length, 1);
    if (variant === 'classic') { await until(() => ended.includes(nextId), 'FIFO advances only after completed exit'); }
  }
  console.log('PASS motion: all eight entrance/exit fades, design timings, native media, independent placements, Studio completion, immutable active design, single audio and FIFO after exit.');

  // A short native clip must finish its entrance before its exit starts.
  snapshot.widgets = [{ ...widget, clipDesign:'classic' }];
  events.set('short', { id:'short', kind:'clip', snapshot:structuredClone(snapshot), media:{ type:'video', url:api+'/clip-fixture.mp4', title:'Short', volume:1, duration:.1 } });
  const shortStart = Date.now(); send('overlay-event', { id:'short', kind:'clip' });
  await source.locator('.clip-design.is-in').waitFor();
  await source.locator('.clip-design.is-out').waitFor();
  assert.ok(Date.now()-shortStart >= 1800, 'very short clips retain entrance plus readable dwell');
  await until(() => ended.includes('short'), 'short clip finishes gracefully');

  // Producer limit wins if the player stalls; no parent timer may cut off exit.
  events.set('limited', { id:'limited', kind:'clip', snapshot:structuredClone(snapshot), media:{ type:'video', url:api+'/clip-fixture.mp4', title:'Limited', volume:1, duration:3 } });
  send('overlay-event', { id:'limited', kind:'clip' });
  await source.waitForFunction(() => { const v=document.querySelector('app-overlay-clip video'); return v && !v.paused && v.readyState>=2; });
  await source.locator('app-overlay-clip video').evaluate(v=>v.pause());
  await source.locator('.clip-design.is-out').waitFor();
  assert.equal(ended.includes('limited'),false);
  await until(() => ended.includes('limited'), 'stalled clip releases at configured limit after exit');

  // Autoplay controls stay visible while the initial animation state is hidden.
  await source.evaluate(() => { window.nativePlay=HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play=function(){ return Promise.reject(new DOMException('fixture','NotAllowedError')); }; });
  events.set('blocked', { id:'blocked', kind:'clip', snapshot:structuredClone(snapshot), media:{ type:'video', url:api+'/clip-fixture.mp4', title:'Blocked', volume:1, duration:30 } });
  send('overlay-event', { id:'blocked', kind:'clip' });
  await source.getByRole('button',{name:'Play media'}).waitFor();
  await source.waitForFunction(()=>getComputedStyle(document.querySelector('app-overlay-media')).opacity==='1');
  assert.equal(await source.locator('app-overlay-media').evaluate(e=>getComputedStyle(e).opacity),'1', 'autoplay button is visible through media host');
  assert.ok(health.some(h=>h.issue==='autoplay'));
  await source.evaluate(()=>{HTMLMediaElement.prototype.play=window.nativePlay;});
  await source.getByRole('button',{name:'Play media'}).click();
  await source.locator('.clip-design.is-in').waitFor();
  await source.locator('app-overlay-clip video').evaluate(v=>v.dispatchEvent(new Event('ended')));
  await until(()=>ended.includes('blocked'),'manual autoplay recovery finishes motion');

  // Reduced motion removes the transition without delaying queue release.
  await source.emulateMedia({reducedMotion:'reduce'});
  events.set('reduced', {id:'reduced',kind:'clip',snapshot:structuredClone(snapshot),media:{type:'video',url:api+'/clip-fixture.mp4',title:'Reduced',volume:1,duration:30}});
  send('overlay-event',{id:'reduced',kind:'clip'});
  await source.locator('.clip-design.is-in').waitFor();
  assert.equal(await source.locator('app-overlay-media').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  const reducedEnd=Date.now(); await source.locator('app-overlay-clip video').evaluate(v=>v.dispatchEvent(new Event('ended')));
  await until(()=>ended.includes('reduced'),'reduced motion completion'); assert.ok(Date.now()-reducedEnd<600);
  await source.emulateMedia({reducedMotion:'no-preference'});

  // Simulate RAF suspension after playback starts, as in an OBS background tab.
  events.set('suspended', {id:'suspended',kind:'clip',snapshot:structuredClone(snapshot),media:{type:'video',url:api+'/clip-fixture.mp4',title:'Suspended',volume:1,duration:30}});
  send('overlay-event',{id:'suspended',kind:'clip'});
  await source.locator('.clip-design.is-in').waitFor();
  await source.locator('app-overlay-clip video').evaluate(v=>v.pause());
  await source.evaluate(()=>{ window.nativeRaf=requestAnimationFrame; window.requestAnimationFrame=()=>2147483647; document.querySelector('app-overlay-clip video').dispatchEvent(new Event('ended')); });
  await until(()=>ended.includes('suspended'),'bounded exit fallback releases a source with RAF suspended');
  await source.evaluate(()=>{window.requestAnimationFrame=window.nativeRaf;});

  events.set('broken', { id: 'broken', kind: 'clip', media: { type: 'video', url: api + '/broken.mp4', title: '', volume: 1 } }); send('overlay-event', { id: 'broken', kind: 'clip' }); await until(() => ended.includes('broken') && health.some(h => h.issue === 'media'), 'clip error releases event and reports health');
  events.set('revoked', {id:'revoked',kind:'clip',snapshot:structuredClone(snapshot),media:{type:'video',url:api+'/clip-fixture.mp4',title:'Revoked',volume:1,duration:30}});
  send('overlay-event',{id:'revoked',kind:'clip'}); await source.locator('.clip-design.is-in').waitFor();
  send('overlay-revoked',{}); await source.waitForFunction(()=>!document.querySelector('app-overlay-clip'));
  await source.waitForTimeout(1800); assert.equal(ended.includes('revoked'),false,'destroy cancels motion callbacks');
  console.log('PASS lifecycle: short clips, duration limit, autoplay recovery, reduced motion, errors and revocation cleanup.');
  assert.equal(await source.evaluate(() => document.body.style.background), 'transparent'); assert.deepEqual(errors, []); await runtime.close();
  console.log('PASS OBS runtime: all eight skins render real H.264 clips, metadata and independent published choices; active design survives publish, duplicate players use one audio copy, errors release and report diagnostics, transparent output.');
  const playground = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await playground.routeWebSocket('**/*', ws => ws.close());
  await playground.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const demo = await playground.newPage(); await demo.goto(base + '/mocks/dev/clips');
  await demo.getByText('Hold at peak', { exact: true }).click();
  for (const variant of variants) {
    await demo.getByRole('tab').filter({ hasText: new RegExp(variant, 'i') }).click();
    await demo.getByRole('button', { name: 'Test', exact: true }).click();
    await demo.waitForFunction(() => {
      const e = document.querySelector('.overlay.is-in');
      return e && e.getBoundingClientRect().width > 100 && getComputedStyle(e.querySelector('video')).opacity === '1';
    });
    await demo.waitForFunction(() => document.querySelector('.overlay').getAnimations({ subtree: true }).every(a => a.playState === 'finished'));
    const size = await demo.locator('.overlay').evaluate(e => ({ width: e.offsetWidth, height: e.offsetHeight }));
    assert.deepEqual(size, { width: 800, height: ['third', 'cinema', 'pill', 'hud', 'slash'].includes(variant) ? 450 : 225 });
  }
  await demo.setViewportSize({ width: 375, height: 900 });
  await demo.waitForFunction(() => document.querySelector('.overlay').getBoundingClientRect().width <= document.querySelector('.stage').clientWidth);
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await playground.close();
  console.log('PASS playground: eight visible moving clip compositions, design switching, and mobile scaling.');
} finally { await browser.close(); }
