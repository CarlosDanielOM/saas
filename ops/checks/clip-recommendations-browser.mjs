import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const fixtures = process.env.CLIP_FIXTURES || '/root/saas/ops/checks/clip-recommendations-fixtures';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const media = 'https://media.fixture.invalid';
const user = { id: '991402', login: 'clip_owner', display_name: 'Clip_Owner' };
const app = { name: 'Clip_Owner', email: 'clip@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const hours = (h) => new Date(Date.now() - h * 3600000).toISOString();
const vods = [
  { id: '9001', title: 'Ranked grind to Diamond', url: 'https://www.twitch.tv/videos/9001', duration: '3h12m5s', durationMinutes: 193, createdAt: hours(20), thumbnailUrl: `${media}/vod-1-%{width}x%{height}.jpg` },
  { id: '9002', title: 'Horror night with chat', url: 'https://www.twitch.tv/videos/9002', duration: '1h40m0s', durationMinutes: 100, createdAt: hours(48), thumbnailUrl: `${media}/vod-2-%{width}x%{height}.jpg` },
  { id: '9003', title: 'Just chatting & cat', url: 'https://www.twitch.tv/videos/9003', duration: '55m10s', durationMinutes: 56, createdAt: hours(96), thumbnailUrl: `${media}/vod-4-%{width}x%{height}.jpg` }
];
const cand = (id, start, len, reason, extra = {}) => ({ _id: id, startSeconds: start, endSeconds: start + len, reason, audioConfidence: 0.87, videoApproved: true, videoWhy: '', s3Key: '', previewUrl: `${media}/moment-${(Number(id.slice(1)) % 4) + 1}.webm`, status: 'pending', twitchClipID: '', created_at: hours(19), ...extra });
const seed = () => [
  { _id: 'r1', channelID: user.id, channel: user.login, sessionID: '', streamID: '', vodID: '9001', vodUrl: 'https://www.twitch.tv/videos/9001', source: 'manual', status: 'completed', requestedBy: user.id, modelID: 'internal-model-id', vodDurationMinutes: 193, costCredits: 9400, candidateCount: 5, approvedCount: 4, errorMessage: '', startedAt: hours(19), completedAt: hours(19), created_at: hours(19), updated_at: hours(19),
    candidates: [
      cand('c0', 3725, 32, 'Clutches a 1v3 and the whole chat explodes', { videoWhy: 'Scoreboard shows the round win at the same moment.' }),
      cand('c1', 812, 41, 'Streamer screams at a jumpscare, then laughs for ten seconds'),
      cand('c2', 6120, 25, 'Chat wins the poll and the streamer has to sing'),
      cand('c3', 9000, 30, 'Cat walks across the keyboard mid-fight', { status: 'confirmed' }),
      cand('c4', 4000, 20, 'Loud noise from the background', { videoApproved: false, previewUrl: '', videoWhy: 'Nothing visible happens on screen.' })
    ] },
  { _id: 'r2', channelID: user.id, channel: user.login, sessionID: '', streamID: '', vodID: '9002', vodUrl: 'https://www.twitch.tv/videos/9002', source: 'manual', status: 'failed', requestedBy: user.id, modelID: 'internal-model-id', vodDurationMinutes: 100, costCredits: 0, candidateCount: 0, approvedCount: 0, errorMessage: 'Not enough AI credits. Required 4750, available 1200.', candidates: [], startedAt: hours(40), completedAt: null, created_at: hours(40), updated_at: hours(40) }
];
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
async function open({ theme = 'dark', width = 1280, manage = true, plan = 'premium', balance = 50000 } = {}) {
  let store = seed(); const writes = []; let auto = false;
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app: { ...app, plan_tier: plan }, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/clip_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin === media) {
      const name = url.pathname.slice(1).replace(/-%7Bwidth%7Dx%7Bheight%7D|-320x180/, '');
      return route.fulfill({ body: await readFile(`${fixtures}/${name}`), contentType: name.endsWith('.webm') ? 'video/webm' : 'image/jpeg' });
    }
    if (url.origin !== api) return route.abort();
    const ok = (data, status = 200) => route.fulfill({ status, json: { error: status >= 400, status, data } });
    const root = `/clip-recommendations/${user.id}`;
    if (url.pathname.startsWith('/auth/access/')) {
      const allowed = url.searchParams.get('permission') === 'clips:manage' ? manage : true;
      return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed } } });
    }
    if (url.pathname === '/billing/ai-credits') return ok({ used: 0, limit: 100000, balance, meterId: 'm', updatedAt: new Date().toISOString(), available: true });
    if (url.pathname === `${root}/config` && method === 'GET') return ok({ autoAnalyzeEnabled: auto, canAutoAnalyze: plan === 'pro', planTier: plan, lastAnalyzedAt: null, pricing: { baseCredits: 2750, baseMinutes: 60, extraCreditsPerMinute: 50 } });
    if (url.pathname === `${root}/config` && method === 'PUT') { writes.push({ path: 'config', body: request.postDataJSON() }); auto = request.postDataJSON().autoAnalyzeEnabled; return ok({}); }
    if (url.pathname === root) return ok({ items: store, total: store.length });
    if (url.pathname === `${root}/vods`) return ok({ days: 7, vods });
    if (url.pathname === `${root}/queue`) {
      const body = request.postDataJSON(); writes.push({ path: 'queue', body });
      if (store.some(r => r.vodID === body.vodId && (r.status === 'pending' || r.status === 'processing'))) return ok({}, 409);
      const vod = vods.find(v => v.id === body.vodId);
      store = [{ ...seed()[1], _id: 'r' + (store.length + 1), vodID: vod.id, vodUrl: vod.url, status: 'processing', errorMessage: '', vodDurationMinutes: vod.durationMinutes, created_at: new Date().toISOString() }, ...store];
      return ok({ estimatedCostCredits: 4750, vod }, 202);
    }
    const action = url.pathname.match(new RegExp(`^${root}/(r\\d+)/candidates/(c\\d+)/(confirm|deny)$`));
    if (action) {
      writes.push({ path: 'candidate', id: action[2], action: action[3] });
      const rec = store.find(r => r._id === action[1]);
      rec.candidates.find(c => c._id === action[2]).status = action[3] === 'confirm' ? 'confirmed' : 'denied';
      return ok(rec);
    }
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: plan });
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/clip_owner/modules/clip-recommendations');
  await page.locator('.lf-moment').first().waitFor();
  return { context, page, writes, store: () => store };
}
const settle = page => page.waitForTimeout(150);
const until = async (fn, label) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout: ' + label); };
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-clip-recommendations-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  {
    const { context, page, writes, store } = await open();
    const head = page.locator('.lf-head');
    await head.getByText('3 to review').waitFor();
    assert.match(await head.innerText(), /1 kept[\s\S]*Auto after streams: off[\s\S]*50,000 credits left/);
    assert.equal(await page.getByText(/internal-model-id|0\.87|Not enough AI credits\. Required/).count(), 0, 'no model ids, raw scores or raw errors');
    // Analysis summary answers "what happened" in plain words, with the VOD title and thumbnail.
    const analysis = page.locator('.lf-analysis').filter({ hasText: 'Ranked grind to Diamond' });
    assert.match(await analysis.locator('summary').innerText(), /4 moments found · 3 to review · 1 kept/);
    assert.equal(await analysis.locator('summary img').getAttribute('src'), `${media}/vod-1-320x180.jpg`);
    // Moments are sorted by time and show real video frames; rejected ones are hidden until asked.
    const times = await analysis.locator('.lf-moment__time').allInnerTexts();
    assert.deepEqual(times, ['13:32 – 14:13', '1:02:05 – 1:02:37', '1:42:00 – 1:42:25', '2:30:00 – 2:30:30']);
    await until(() => analysis.locator('.lf-moment video').first().evaluate(v => v.readyState >= 2), 'first video frame painted');
    await analysis.getByRole('button', { name: 'Show 1 that didn\'t pass the video check' }).click();
    await analysis.getByText('Loud noise from the background').waitFor();
    assert.match(await analysis.locator('.lf-moment').filter({ hasText: 'Loud noise' }).innerText(), /Didn't pass the video check/);
    assert.equal(await analysis.locator('.lf-moment').filter({ hasText: 'Loud noise' }).getByRole('button', { name: 'Keep' }).count(), 0);
    // "Open on Twitch" jumps to the second in the VOD.
    const clutch = analysis.locator('.lf-moment').filter({ hasText: 'Clutches a 1v3' });
    assert.equal(await clutch.getByRole('link', { name: /Open on Twitch/ }).getAttribute('href'), 'https://www.twitch.tv/videos/9001?t=1h2m5s');
    // Keep / Skip are one tap and update the counts.
    await clutch.getByRole('button', { name: 'Keep' }).click();
    await head.getByText('2 to review').waitFor();
    assert.deepEqual(writes.at(-1), { path: 'candidate', id: 'c0', action: 'confirm' });
    assert.match(await clutch.innerText(), /Kept/);
    const jump = analysis.locator('.lf-moment').filter({ hasText: 'jumpscare' });
    await jump.getByRole('button', { name: 'Skip' }).click();
    await head.getByText('1 to review').waitFor();
    assert.match(await jump.innerText(), /Skipped/);
    await jump.getByRole('button', { name: 'Keep' }).waitFor();
    // Tap a thumbnail to watch; keep from the player; Escape closes.
    await analysis.getByRole('button', { name: 'Watch the moment at 1:42:00' }).click();
    const player = page.getByRole('dialog', { name: '1:42:00 – 1:42:25' });
    await player.locator('video').waitFor();
    await page.keyboard.press('Escape'); await player.waitFor({ state: 'detached' });
    await analysis.getByRole('button', { name: 'Watch the moment at 1:42:00' }).click();
    await player.getByRole('button', { name: 'Keep' }).click();
    await player.waitFor({ state: 'detached' });
    await page.locator('.lf-head').getByText('to review').waitFor({ state: 'detached' });
    assert.equal(store()[0].candidates.find(c => c._id === 'c2').status, 'confirmed');
    // Failed analysis: plain reason, nothing charged, a way to fix it.
    const failed = page.locator('.lf-analysis').filter({ hasText: 'Horror night' });
    await failed.locator('summary').getByText("Couldn't finish: not enough AI credits").waitFor();
    if (!(await failed.evaluate(d => d.open))) await failed.locator('summary').click();
    await failed.getByText('No credits were charged for this attempt.').waitFor();
    await failed.getByRole('link', { name: 'Get credits' }).waitFor();
    // VOD picker: analyzed VODs say so; analyzing asks first with the cost and balance.
    const vodRow = name => page.locator('.lf-vod').filter({ hasText: name });
    assert.match(await vodRow('Ranked grind').innerText(), /Already analyzed/);
    assert.match(await vodRow('Just chatting').innerText(), /about 2,750 credits/);
    await vodRow('Just chatting').getByRole('button', { name: /^Find clips/ }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Find clips in this stream?' });
    await confirm.getByText('About 2,750 AI credits').waitFor();
    await confirm.getByText('You have 50,000 credits.').waitFor();
    await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'detached' });
    assert.equal(writes.some(w => w.path === 'queue'), false, 'nothing queued before confirming');
    await vodRow('Just chatting').getByRole('button', { name: /^Find clips/ }).click();
    await confirm.getByRole('button', { name: 'Find clips' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.deepEqual(writes.at(-1), { path: 'queue', body: { vodId: '9003' } });
    await vodRow('Just chatting').getByText('Analyzing…').waitFor();
    await page.locator('.lf-head').getByText('Analyzing a stream').waitFor();
    await page.locator('.lf-analysis').first().getByText('Analyzing… this can take a few minutes').waitFor();
    // Auto analysis is Pro only; Premium sees why and no switch.
    assert.equal(await page.getByRole('checkbox', { name: 'Find clips after every stream' }).count(), 0);
    await page.getByText('Available on Pro. You can still analyze any stream by hand.').waitFor();
    await context.close();
  }
  {
    // Not enough credits: the confirm dialog says so and offers credits instead of queueing.
    const { context, page, writes } = await open({ balance: 1200, plan: 'pro' });
    const vodRow = page.locator('.lf-vod').filter({ hasText: 'Just chatting' });
    assert.match(await vodRow.innerText(), /Not enough credits/);
    await vodRow.getByRole('button', { name: /^Find clips/ }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Find clips in this stream?' });
    await confirm.getByText('You only have 1,200 credits. Get more credits first.').waitFor();
    assert.equal(await confirm.getByRole('button', { name: 'Find clips' }).count(), 0);
    assert.equal(await confirm.getByRole('link', { name: 'Get credits' }).getAttribute('href'), '/clip_owner/credits');
    await page.keyboard.press('Escape');
    // Pro: the auto switch saves and the header chip follows it.
    const auto = page.getByRole('checkbox', { name: 'Find clips after every stream' });
    await auto.check();
    await page.locator('.lf-head').getByText('Auto after streams: on').waitFor();
    assert.deepEqual(writes.at(-1), { path: 'config', body: { autoAnalyzeEnabled: true } });
    await context.close();
  }
  {
    // View-only helpers see the moments but no actions.
    const { context, page } = await open({ manage: false });
    await page.locator('.lf-head').getByText('View only').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Keep' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Find clips/ }).count(), 0);
    await page.getByRole('link', { name: /Open on Twitch/ }).first().waitFor();
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open({ theme, width });
    await page.locator('.lf-head').getByText('3 to review').waitFor();
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await axe(page, `axe ${theme} ${width}`);
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/clips-reco-${theme}-${width}.png`, fullPage: true }); }
    if (width === 390 && theme === 'light') {
      await page.locator('.lf-vod').filter({ hasText: 'Just chatting' }).getByRole('button', { name: /^Find clips/ }).click();
      await page.waitForTimeout(250);
      await axe(page, 'confirm dialog axe');
      if (shots) await page.screenshot({ path: `${shots}/clips-reco-confirm-390.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Watch the moment at 1:02:05' }).click();
      await page.waitForTimeout(400);
      await axe(page, 'player dialog axe');
      if (shots) await page.screenshot({ path: `${shots}/clips-reco-player-390.png` });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS clip recommendations: plain review/kept/balance header, analysis outcomes with VOD title + thumbnail, time-sorted moments with real video frames, hidden video-check rejects, Twitch VOD timestamp links, one-tap keep/skip, player dialog with keep + Escape, failed analysis reason + no-charge + credits link, VOD picker states, cost/balance confirm before queueing, not-enough-credits path, Pro-only auto switch, view-only mode, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
