import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const origin = 'https://domdimabot.com', capability = 'p'.repeat(43), overlay = 'q'.repeat(48);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(path, { referrer, owner = false, tokenMode = 'readable' } = {}) {
  const context = await browser.newContext();
  const network = [], rewritten = [];
  const user = { id: '991505', login: 'pet_owner', display_name: 'Pet Owner' };
  const app = { name: 'Pet Owner', email: 'fixture@example.invalid', language: 'en', plan_tier: 'premium', actived: true, chat_enabled: true,
    twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  if (owner) await context.addInitScript(({ user, app }) => localStorage.setItem('dimasite.session.v1', JSON.stringify({
    version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {}
  })), { user, app });
  await context.addInitScript(() => {
    window.__privateAnalytics = { init: [], attempted: [], sent: [], previous: '' };
    // Instrument only the test response of the compiled bootstrap. The real
    // service and its production configuration execute against a mocked SDK;
    // no PostHog initialization, persistence or network request reaches a service.
    Object.defineProperty(window, '__fixturePosthog', { configurable: true, set(sdk) {
      const state = window.__privateAnalytics;
      window.__posthogFixtureSdk = sdk;
      sdk.init = (key, config) => { state.init.push({ host: config.api_host }); state.config = config; sdk.config = config; return sdk; };
      sdk.identify = () => {};
      sdk.reset = () => {};
      sdk.stopSessionRecording = () => { state.stops = (state.stops || 0) + 1; state.config.disable_session_recording = true; };
      sdk.startSessionRecording = () => { state.starts = (state.starts || 0) + 1; state.config.disable_session_recording = false; };
      sdk.opt_out_capturing = () => { state.optedOut = true; };
      sdk.capture = (event, properties = {}) => {
        if (!state.config || state.optedOut) return;
        const value = { event, properties: { $current_url: location.href, $referrer: document.referrer, $prev_pageview_pathname: state.previous, ...properties } };
        state.previous = location.href;
        state.attempted.push(event);
        const accepted = state.config.before_send(value);
        if (accepted) state.sent.push(accepted);
      };
      window.addEventListener('pagehide', () => sdk.capture('$pageleave'));
    } });
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) {
      const asset = /\.(?:js|css|svg|png|jpg|webp|woff2?|ico|json|map)$/.test(url.pathname);
      const response = await route.fetch({ url: base + (asset ? url.pathname + url.search : '/index.csr.html') });
      if (url.pathname.endsWith('.js')) {
        let body = await response.text();
        // The production bundle retains environment property names. Assert the
        // bootstrap interception exists so this cannot pass with an inert mock.
        body = body.replace(/\b([$\w]+)\.init\(([$\w]+)\.POSTHOG_KEY,/g, (_, sdk, env) => {
          rewritten.push(url.pathname); return `(window.__fixtureAnalyticsService=this,window.__fixturePosthog=${sdk}).init(${env}.POSTHOG_KEY,`;
        });
        return route.fulfill({ response, body });
      }
      return route.fulfill({ response });
    }
    network.push(url.origin + url.pathname);
    if (url.origin === 'https://api.domdimabot.com') {
      let data = {};
      if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: 'premium' };
      else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
      else if (url.pathname.endsWith('/runtime')) data = { v: 1, generation: 1, active: null, sessions: [] };
      else if (url.pathname.endsWith('/overlay-token')) data = { token: tokenMode === 'readable' ? capability : null, exists: true, version: 'a'.repeat(64) };
      else if (url.pathname === `/pets/${user.id}/settings`) data = { schemaVersion: 2, revision: 0, updatedAt: null,
        settings: { enabled: false, name: 'Dima', appearance: { kind: 'png', idleAssetId: null, talkingAssetId: null },
          playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null }, tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' },
          personality: { source: 'custom', profileId: '', prompt: 'Friendly companion.' }, rules: [],
          behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280 } }, profiles: [],
        voices: [{ provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' }], runtime: { enabled: false, issues: [], playbackAvailable: true } };
      return route.fulfill({ json: { error: false, data } });
    }
    // Everything else, including analytics script/config/ingestion hosts, is
    // blocked. These fixture requests never leave the Playwright interceptor.
    return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + path, referrer ? { referer: referrer } : {});
  await page.locator('app-root > router-outlet + *').waitFor({ state: 'attached' });
  await page.waitForTimeout(300);
  assert.equal(rewritten.length, 1, 'instrument exactly the production analytics bootstrap');
  return { context, page, network };
}
async function navigate(page, path) {
  await page.evaluate(path => window.__fixtureAnalyticsService.router.navigateByUrl(path), path);
  await page.waitForTimeout(350);
}
async function assertNoSecrets(page) {
  const sent = await page.evaluate(() => window.__privateAnalytics.sent);
  assert(!JSON.stringify(sent).includes(capability), 'no pet capability in any outgoing event property');
  assert(!JSON.stringify(sent).includes(overlay), 'no overlay capability in any outgoing event property');
  return sent;
}
try {
  for (const path of [`/pet/${capability}`, `/%70et/${capability}`, `/overlays/${overlay}`, `/overlays/roulette/fixture#${capability}`]) {
    const { context, page, network } = await open(path);
    assert.equal(await page.evaluate(() => window.__privateAnalytics.init.length), 0, 'direct private routes never initialize PostHog');
    assert.equal(await page.evaluate(() => window.__privateAnalytics.sent.length), 0);
    assert(!network.some(url => /posthog|tadd\.domdimabot/.test(url)), 'no analytics network attempt');
    await context.close();
  }
  {
    const { context, page } = await open('/404');
    assert.equal(await page.evaluate(() => window.__privateAnalytics.init.length), 1, 'public production hostname initializes analytics');
    assert((await assertNoSecrets(page)).some(event => event.event === '$pageview'), 'public pageview remains active');
    for (const [index, path] of [`/pet/${capability}`, `/overlays/${overlay}`].entries()) {
      await navigate(page, path);
      const before = (await assertNoSecrets(page)).length;
      assert.equal(await page.evaluate(() => window.__privateAnalytics.config.disable_session_recording), true, 'replay is paused before private source renders');
      await page.evaluate(() => { window.__posthogFixtureSdk.capture('$pageleave'); dispatchEvent(new Event('pagehide')); });
      assert.equal((await assertNoSecrets(page)).length, before, 'private pageleave and SDK capture are discarded');
      await navigate(page, index ? '/404?from=fixture' : '/500?from=fixture');
      const sent = await assertNoSecrets(page);
      assert(sent.length > before, 'public navigation resumes permitted events');
      assert.equal(await page.evaluate(() => window.__privateAnalytics.config.disable_session_recording), false, 'public replay policy restored without forcing sampling');
      assert(sent.some(event => event.properties.$prev_pageview_pathname === '/private-source'), 'previous private URL is redacted after exit');
    }
    // Exercise the actual router's NavigationStart -> cancellation/error path,
    // without changing any existing application guard or route.
    await page.evaluate(async () => {
      const router = window.__fixtureAnalyticsService.router;
      const pet = router.config.find(route => route.path === 'pet/:capability');
      if (!pet) throw new Error('Missing production pet route');
      const blocked = () => { window.__posthogFixtureSdk.capture('$pageleave'); return false; };
      const failed = () => { window.__posthogFixtureSdk.capture('$pageleave'); throw new Error('fixture navigation failure'); };
      router.resetConfig([{ ...pet, path: 'pet/privacy-cancel', canActivate: [blocked] }, { ...pet, path: 'pet/privacy-error', canActivate: [failed] }, ...router.config]);
      window.__privateAnalytics.cancellationBefore = window.__privateAnalytics.sent.length;
      await router.navigateByUrl('/pet/privacy-cancel');
      try { await router.navigateByUrl('/pet/privacy-error'); } catch { /* Expected fixture navigation error. */ }
    });
    assert.equal(await page.evaluate(() => window.__privateAnalytics.sent.length), await page.evaluate(() => window.__privateAnalytics.cancellationBefore), 'pending private pageleave blocked before URL changes');
    assert.equal(await page.evaluate(() => window.__privateAnalytics.config.disable_session_recording), false, 'cancel/error restores public recording policy');
    await page.evaluate(() => { window.__privateAnalytics.config.disable_session_recording = true; });
    const replayStarts = await page.evaluate(() => window.__privateAnalytics.starts);
    await navigate(page, `/pet/${capability}`); await navigate(page, '/500');
    assert.equal(await page.evaluate(() => window.__privateAnalytics.starts), replayStarts, 'pre-existing disabled replay is never resumed');
    assert.equal(await page.evaluate(() => window.__privateAnalytics.config.disable_session_recording), true);
    // The SDK can attach stale referrers, entry URLs and nested properties even
    // after the router has left a private source. Exercise that boundary directly.
    await page.evaluate(({ capability, overlay }) => window.__posthogFixtureSdk.capture('fixture-public-event', {
      public_path: '/pet_owner/modules/pet',
      encoded_referrer: `https://domdimabot.com/%70et/${capability}`,
      $referrer: `https://domdimabot.com/pet/${capability}`,
      $initial_current_url: `https://domdimabot.com/overlays/${overlay}`,
      nested: { previous_url: `/pet/${capability}?anything=private`, urls: [`https://domdimabot.com/overlays/${overlay}#secret`] }
    }), { capability, overlay });
    const event = (await assertNoSecrets(page)).find(event => event.event === 'fixture-public-event');
    assert.equal(event.properties.$referrer, '/private-source');
    assert.equal(event.properties.encoded_referrer, '/private-source');
    assert.equal(event.properties.public_path, '/pet_owner/modules/pet', 'authenticated pet settings URL is preserved');
    assert.equal(event.properties.nested.previous_url, '/private-source');
    assert.deepEqual(event.properties.nested.urls, ['/private-source']);
    await context.close();
  }
  {
    const { context, page } = await open('/404', { referrer: `${origin}/pet/${capability}` });
    const sent = await assertNoSecrets(page);
    assert(sent.some(event => event.properties.$referrer === '/private-source'), 'private document referrer is redacted on a fresh public load');
    await context.close();
  }
  {
    const { context, page } = await open('/pet_owner/modules/pet', { owner: true });
    await page.getByRole('textbox', { name: 'Pet name' }).waitFor();
    assert.match(await page.locator('.overlay-controls').getAttribute('class'), /ph-no-capture/, 'private URL subtree has the SDK capture-block marker');
    const field = page.getByRole('textbox', { name: 'Private pet browser-source URL', exact: true }); await field.waitFor();
    assert(await field.evaluate(element => !!element.closest('.ph-no-capture')), 'generated URL display is inside blocked subtree');
    assert(await page.getByRole('button', { name: 'Copy URL', exact: true }).evaluate(element => !!element.closest('.ph-no-capture')), 'copy control is inside blocked subtree');
    const privateLinks = page.locator('a[href*="/pet/"]');
    assert(await privateLinks.evaluateAll(elements => elements.every(element => !!element.closest('.ph-no-capture'))), 'any private URL open control is inside blocked subtree');
    const sent = await assertNoSecrets(page);
    assert(sent.some(event => event.event === '$pageview' && event.properties.current_path === '/pet_owner/modules/pet' && event.properties.route_path === 'pet' && event.properties.authenticated_access_role === 'owner'), 'real guarded owner pet settings retain analytics');
    await context.close();
  }
  {
    const { context, page } = await open('/pet_owner/modules/pet', { owner: true, tokenMode: 'hashOnly' });
    const recovery = page.getByRole('textbox', { name: 'Existing OBS pet URL', exact: true }); await recovery.waitFor();
    assert(await recovery.evaluate(element => !!element.closest('.ph-no-capture')), 'recovery input is inside blocked subtree');
    assert(await page.getByRole('button', { name: 'Recover existing URL', exact: true }).evaluate(element => !!element.closest('.ph-no-capture')), 'recovery action is inside blocked subtree');
    assert((await assertNoSecrets(page)).some(event => event.event === '$pageview' && event.properties.current_path === '/pet_owner/modules/pet'), 'recovery state retains protected settings pageview');
    await context.close();
  }
  assert.deepEqual(errors.filter(message => !message.includes('fixture navigation failure')), [], 'no analytics-privacy browser errors');
  console.log('PASS private-source analytics: production hostname, mocked SDK/network, no PostHog init on pet/overlay/fragment sources; real Router entry/exit/cancel/error, mock replay pause/resume policy and disabled setting preserved, protected owner settings tracked, generated URL/copy/recovery DOM in blocked subtree, private pageleave and capture discarded, public capture retained, nested referrer/previous/session-entry URLs redacted.');
} finally { await browser.close(); }
