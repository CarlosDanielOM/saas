// Admin channel workspace → Referrals (/channels/:id/referrals): who invited a person, who they invited, their
// codes, and the owner's hand edits. Every API call is mocked on both api.domdimabot.com and localhost:3000 with
// a stateful fixture of fictional accounts: no referral change can reach production.
// Covers the tab in the strip + deep link, the answer line (credits with their dollar value), the "Invited by"
// wording per case (code sign-up, set by hand, no code, inactive code, deleted inviter, nobody), codes, the people
// they invited (rows, links, load more with the cursor), set an inviter (default code: no `code` sent), change
// an inviter (`code` sent, 409 → Move them with `replace: true`), remove an inviter (confirmed first), add someone
// they invited (PUT on the invited person's channel with `referrer` = this channel, 409 → Move them), remove an
// invited person (confirmed), load errors + Retry, and layout + axe at 320/390/1280 in dark and light, with the
// dialog open at 390 dark and 1280 light.
//
// Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4393), SAAS_BROWSER_TOOLS (playwright + @axe-core/playwright),
// SAAS_SCREENSHOTS (default /tmp/saas-admin-console-referrals).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------
// Fixtures (fictional names only)
// ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const dayText = (value) => {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
};

/** channelID → account. */
const accounts = {
  '8200001': { login: 'mossy_lantern', plan: 'pro', signedUpAt: '2026-05-02T12:00:00.000Z' },
  '8200010': { login: 'quiet_fjord', plan: 'premium', signedUpAt: '2026-03-01T12:00:00.000Z' },
  '8200002': { login: 'amber_kettle', plan: 'free', signedUpAt: daysAgo(40) },
  '8200003': { login: 'pale_comet', plan: 'free', signedUpAt: daysAgo(41) },
  '8200004': { login: 'rusty_heron', plan: 'premium', signedUpAt: daysAgo(42) },
  '8200005': { login: 'violet_moth', plan: 'free', signedUpAt: daysAgo(43) },
  '8200006': { login: 'tidal_rook', plan: 'free', signedUpAt: daysAgo(44) },
  '8200007': { login: 'sunny_badger', plan: 'free', signedUpAt: daysAgo(0.5) },
};
const ADJ = ['brisk', 'cedar', 'dusky', 'ember', 'frosty', 'gentle', 'hazel', 'ivory', 'jolly', 'koi', 'lunar', 'maple', 'nimble', 'olive'];
const GENERATED = ADJ.flatMap((adj) => ['finch', 'otter'].map((noun) => `${adj}_${noun}`));
GENERATED.forEach((login, i) => { accounts[String(8300000 + i)] = { login, plan: i % 5 === 0 ? 'premium' : 'free', signedUpAt: daysAgo(1 + i) }; });
const userId = (channelID) => `u${channelID}`;

const SET_BY_HAND = '2026-11-10T12:00:00.000Z';
function newState() {
  /** channelID → who invited them (`referrer`: a channel id, or 'gone' for a deleted account). */
  const refs = {
    '8200001': { referrer: '8200010', code: 'fjord', source: 'code', setAt: null },
    '8200002': { referrer: '8200001', code: 'lantern', source: 'manual', setAt: SET_BY_HAND },
    '8200003': { referrer: '8200001', code: null, source: 'manual', setAt: SET_BY_HAND },
    '8200004': { referrer: '8200001', code: 'oldlamp', source: 'code', setAt: null },
    '8200005': { referrer: 'gone', code: null, source: 'unknown', setAt: null },
    '8200007': { referrer: '8200010', code: 'fjord', source: 'code', setAt: null },
  };
  GENERATED.forEach((_, i) => {
    refs[String(8300000 + i)] = i % 7 === 3 ? { referrer: '8200001', code: null, source: 'unknown', setAt: null }
      : i % 7 === 5 ? { referrer: '8200001', code: 'lantern', source: 'manual', setAt: SET_BY_HAND }
      : { referrer: '8200001', code: i % 2 ? 'cozy' : 'lantern', source: 'code', setAt: null };
  });
  return { refs, fail: new Set() };
}
/** Owner → codes, oldest first (as the API sends them). */
const codes = {
  '8200001': [
    { code: 'oldlamp', label: 'Old banner', active: false, signups: 3, conversions: 1, createdAt: '2026-04-01T12:00:00.000Z' },
    { code: 'lantern', label: 'Main link', active: true, signups: 17, conversions: 4, createdAt: '2026-05-03T12:00:00.000Z' },
    { code: 'cozy', label: '', active: true, signups: 12, conversions: 0, createdAt: '2026-09-01T12:00:00.000Z' },
  ],
  '8200010': [
    { code: 'fjordold', label: 'First try', active: false, signups: 0, conversions: 0, createdAt: '2026-03-02T12:00:00.000Z' },
    { code: 'fjord', label: 'Panel link', active: true, signups: 2, conversions: 2, createdAt: '2026-04-02T12:00:00.000Z' },
  ],
};
/** Credits each referrer earned from each person ("referrer:person"); paid rewards never move. */
const earned = { '8200001:8200004': 1500, '8200001:8300000': 2000, '8200001:8300001': 1000, '8200010:8200001': 9000, '8200010:8200007': 300 };
const PAGE = 25;

const ok = (data, message = 'ok') => ({ status: 200, body: { error: false, message, status: 200, data } });
const fail = (status = 503, message = 'Fixture failure') => ({ status, body: { error: true, message, status } });

function makeApi(state) {
  const view = (channelID, cursor) => {
    const account = accounts[channelID];
    const ref = state.refs[channelID];
    let referredBy = null;
    if (ref) {
      const inviter = accounts[ref.referrer];
      const active = !!ref.code && !!inviter && (codes[ref.referrer] ?? []).some((c) => c.code === ref.code && c.active);
      referredBy = {
        userId: ref.referrer === 'gone' ? 'u-gone' : userId(ref.referrer),
        login: inviter ? inviter.login : null,
        channelID: inviter ? ref.referrer : null,
        code: ref.code,
        source: ref.source,
        setAt: ref.setAt,
        rewardsReferrer: active,
        discount: !!ref.code && ref.source !== 'manual',
      };
    }
    const invited = Object.entries(state.refs)
      .filter(([, r]) => r.referrer === channelID)
      .map(([id, r]) => ({
        userId: userId(id), login: accounts[id].login, channelID: id, plan: accounts[id].plan, code: r.code, source: r.source,
        signedUpAt: accounts[id].signedUpAt, creditsEarned: earned[`${channelID}:${id}`] ?? 0,
      }))
      .sort((a, b) => b.signedUpAt.localeCompare(a.signedUpAt));
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString().replace('offset:', '')) : 0;
    const page = invited.slice(offset, offset + PAGE);
    const nextOffset = offset + PAGE;
    return {
      person: { userId: userId(channelID), login: account.login, channelID, plan: account.plan },
      referredBy,
      codes: codes[channelID] ?? [],
      referred: page,
      referredTotal: invited.length,
      creditsEarnedTotal: Object.entries(earned).filter(([key]) => key.startsWith(`${channelID}:`)).reduce((sum, [, value]) => sum + value, 0),
      next: nextOffset < invited.length ? Buffer.from(`offset:${nextOffset}`).toString('base64url') : null,
    };
  };

  return (method, path, url, body) => {
    const params = url.searchParams;
    let m;
    if (method === 'GET' && path === '/admin-site/users') {
      const search = (params.get('search') || '').toLowerCase();
      const rows = Object.entries(accounts)
        .filter(([id, a]) => !search || id === search || a.login.includes(search))
        .slice(0, Number(params.get('limit') || 100))
        .map(([id, a]) => ({
          channel: a.login, channelID: id, email: `${a.login}@example.test`, plan_tier: a.plan, actived: true, chat_enabled: true,
          has_permissions: true, up_to_date_permissions: true, isLive: false, liveViewers: 0, commandsCount: 0, eventsubsActiveCount: 0,
          eventsubsDisabledCount: 0, created_at: a.signedUpAt, reminder_sent_at: null,
        }));
      return ok({ rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 }, summary: {} });
    }
    if (method === 'GET' && path === '/admin-site/feed/summary') return ok({ from: daysAgo(1), to: daysAgo(0), partial: [], kinds: [] });
    if ((m = path.match(/^\/admin-site\/users\/(\d+)\/(.+)$/))) {
      const [, id, rest] = m;
      if (method === 'GET' && rest === 'logs') return ok({ entries: [], truncated: false, counts: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } });
      if (method === 'GET' && rest === 'referrals') {
        if (state.fail.has('referrals') || (params.get('cursor') && state.fail.has('more'))) return fail();
        if (!accounts[id]) return fail(404, 'Channel not found');
        return ok(view(id, params.get('cursor')));
      }
      if (method === 'PUT' && rest === 'referrer') {
        if (!accounts[id]) return fail(404, 'Channel not found');
        const current = state.refs[id];
        if (body?.referrer === null) {
          delete state.refs[id];
          return ok(view(id), 'Referrer removed');
        }
        const referrer = Object.keys(accounts).find((cid) => cid === body?.referrer || accounts[cid].login === body?.referrer);
        if (!referrer) return fail(404, 'No account has that channel');
        if (referrer === id) return fail(400, "Someone can't invite themselves");
        if (current && current.referrer !== referrer && body.replace !== true) {
          const name = accounts[current.referrer]?.login || 'a deleted account';
          return fail(409, `${accounts[id].login} were invited by ${name}${current.code ? ` (code ${current.code})` : ''}. Confirm to move them.`);
        }
        let code;
        if (body.code !== undefined && body.code !== null) {
          const owned = (codes[referrer] ?? []).find((c) => c.code === body.code);
          if (!owned) return fail(400, `${accounts[referrer].login} has no code "${body.code}"`);
          code = owned.code;
        } else {
          code = (codes[referrer] ?? []).find((c) => c.active)?.code ?? null;
        }
        state.refs[id] = { referrer, code, source: 'manual', setAt: new Date().toISOString() };
        return ok(view(id), code ? `Now invited by ${accounts[referrer].login} (code ${code})` : `Now invited by ${accounts[referrer].login}, without a code`);
      }
    }
    if (method === 'GET' && path === '/users') return { status: 200, body: { data: {} } };
    return null;
  };
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.SAAS_PREVIEW_URL || 'http://127.0.0.1:4393';
const artifacts = process.env.SAAS_SCREENSHOTS || '/tmp/saas-admin-console-referrals';
fs.mkdirSync(artifacts, { recursive: true });

let state = newState();
let api = makeApi(state);
const requests = [];
const unexpected = [];
const pageErrors = [];
const isApi = (url) => url.hostname === 'api.domdimabot.com' || ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000');
const count = (pred) => requests.filter(pred).length;
const puts = () => requests.filter((r) => r.method === 'PUT');
const referralGets = (id) => requests.filter((r) => r.method === 'GET' && r.path === `/admin-site/users/${id}/referrals`);
const channelLoads = (id) => count((r) => r.method === 'GET' && r.path === '/admin-site/users' && r.query.get('search') === id);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('dima-admin.session.v1', JSON.stringify({
      version: 2, token: 'disposable-referrals-fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: { id: '533538623', login: 'admin_fixture', display_name: 'Alex', email: 'alex@example.test' },
      appUser: { twitch_user_id: '533538623', name: 'admin_fixture', plan_tier: 'free' },
    }));
    if (!localStorage.getItem('dima-admin.mode.v1')) localStorage.setItem('dima-admin.mode.v1', 'dark');
    window.EventSource = class { constructor() { this.timer = setTimeout(() => this.onopen?.({}), 50); } close() { clearTimeout(this.timer); } };
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return request.method() === 'GET' ? route.continue().catch(() => {}) : route.abort();
    if (!isApi(url)) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = request.postDataJSON(); } catch { /* no body */ }
    requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, body });
    const result = api(request.method(), url.pathname, url, body);
    if (!result) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: true, message: 'Not mocked' }) });
    }
    return route.fulfill({ status: result.status, headers: cors, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR|status of 409/.test(message.text())) pageErrors.push(message.text()); });

  const until = async (check, label, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  const shot = (name) => page.screenshot({ path: `${artifacts}/${name}.png` });
  const h1 = page.locator('main h1');
  const strip = page.getByRole('navigation', { name: 'Channel sections' });
  const tab = (name) => strip.getByRole('link', { name: new RegExp(`^${name}`) });
  const current = () => strip.locator('[aria-current="page"]');
  const answer = page.locator('[data-answer]');
  const by = page.locator('[data-invited-by]');
  const people = page.locator('[data-invited] li[data-person]');
  const editor = page.locator('dialog[data-referral-editor]');
  const confirm = page.locator('dialog.confirm');
  const settle = () => page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
  const goto = async (path, ready = '[data-answer]') => { await page.goto(`${base}${path}`); await h1.first().waitFor(); await page.locator(ready).first().waitFor(); await settle(); };
  const axeOn = async (selector, label) => {
    const axe = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })), [], `${label}: axe`);
  };
  const pick = async (term, login) => {
    await editor.getByLabel('Search channels').fill(term);
    await editor.getByRole('button', { name: new RegExp(`^${login}`) }).click();
    await editor.locator('.re-picked').getByText(login, { exact: true }).waitFor();
  };
  const facts = async () => ({
    how: await text(by.locator('[data-how]')),
    discount: await text(by.locator('[data-discount]')),
    discountOk: await by.locator('[data-discount]').evaluate((el) => el.classList.contains('is-ok')),
    rewards: await text(by.locator('[data-rewards]')),
    rewardsOk: await by.locator('[data-rewards]').evaluate((el) => el.classList.contains('is-ok')),
  });

  // ---------------------------------------------------------------- Tab strip + deep link
  await goto('/channels/8200001/logs', 'main h1');
  const tabNames = await strip.getByRole('link').evaluateAll((els) => els.map((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.lf-tab__count').forEach((badge) => badge.remove());
    return copy.textContent.trim();
  }));
  assert.deepEqual(tabNames, ['Overview', 'Activity', 'Commands', 'Twitch events', 'Protection', 'AI & credits', 'Referrals', 'Bot log']);
  assert.equal(await tab('Referrals').getAttribute('href'), '/channels/8200001/referrals');
  await tab('Referrals').click();
  await answer.waitFor();
  await settle();
  assert.equal(new URL(page.url()).pathname, '/channels/8200001/referrals');
  assert.match(await text(current()), /^Referrals/);
  assert.equal(await page.title(), 'Channel referrals | DimaBot Admin');
  assert.equal(channelLoads('8200001'), 1, 'switching to Referrals never re-requests the channel');
  assert.equal(await h1.count(), 1, 'one h1');
  assert.equal(await text(h1), 'mossy_lantern');

  // ---------------------------------------------------------------- Answer, invited by (code sign-up), list, codes
  assert.equal(await text(answer), 'Invited by quiet_fjord (code fjord) · invited 31 people · earned 4,500 credits ($0.045)');
  assert.equal(await by.getByRole('link', { name: 'quiet_fjord' }).getAttribute('href'), '/channels/8200010/referrals');
  assert.equal(await text(by.locator('.rf-code')), 'code fjord');
  assert.deepEqual(await facts(), {
    how: 'Signed up with their link', discount: 'Gets the 10% discount on a first subscription (if they never subscribed before)', discountOk: true,
    rewards: 'quiet_fjord earns referral rewards from them', rewardsOk: true,
  });
  await until(async () => (await people.count()) === 25, 'first page of people');
  assert.equal(await text(page.locator('[data-total]')), '31');
  assert.equal(await text(page.locator('[data-showing]')), 'Showing 25 of 31');
  assert.equal(referralGets('8200001').length, 1);
  assert.equal(referralGets('8200001')[0].query.get('cursor'), null);
  // Newest sign-up first; each row links to that person's referrals.
  assert.equal(await people.first().getAttribute('data-person'), 'brisk_finch');
  const brisk = people.filter({ has: page.locator('a', { hasText: /^brisk_finch$/ }) });
  assert.equal(await brisk.getByRole('link', { name: 'brisk_finch' }).getAttribute('href'), '/channels/8300000/referrals');
  assert.match(await text(brisk), /Premium/);
  assert.match(await text(brisk), /code lantern · used their link · signed up /);
  assert.equal(await text(brisk.locator('[data-earned]')), 'Earned 2,000 credits ($0.02)');
  const unknownRow = page.locator('[data-invited] li[data-person="cedar_otter"]');
  assert.match(await text(unknownRow), /no code · old record · signed up /);
  assert.equal(await text(unknownRow.locator('[data-earned]')), 'Nothing earned yet');
  const byHandRow = page.locator('[data-invited] li[data-person="dusky_otter"]');
  assert.match(await text(byHandRow), /code lantern · added by you · signed up /);
  // Codes: API order (oldest first), active or off, paid sign-ups.
  const codeRows = page.locator('[data-codes] li[data-code-row]');
  assert.deepEqual(await codeRows.evaluateAll((els) => els.map((el) => el.dataset.codeRow)), ['oldlamp', 'lantern', 'cozy']);
  assert.match(await text(codeRows.nth(0)), /oldlamp Old banner 3 signed up · 1 paid Off/);
  assert.match(await text(codeRows.nth(1)), /lantern Main link 17 signed up · 4 paid Active/);
  assert.match(await text(codeRows.nth(2)), /cozy 12 signed up · 0 paid Active/);
  assert.match(await text(page.locator('[data-codes] .lf-tile__head')), /2 of 3 active/);
  await shot('referrals-dark-390');

  // ---------------------------------------------------------------- Load more with the cursor
  const firstNext = Buffer.from('offset:25').toString('base64url');
  await page.getByRole('button', { name: 'Load more' }).click();
  await until(async () => (await people.count()) === 31, 'second page');
  assert.equal(referralGets('8200001').at(-1).query.get('cursor'), firstNext, 'load more sends the cursor');
  assert.equal(await text(page.locator('[data-showing]')), 'Showing 31 of 31');
  assert.equal(await page.getByRole('button', { name: 'Load more' }).count(), 0, 'nothing more to load');
  assert.ok((await people.evaluateAll((els) => els.map((el) => el.dataset.person))).includes('rusty_heron'), 'second page includes rusty_heron');
  assert.equal(await text(page.locator('[data-invited] li[data-person="rusty_heron"] [data-earned]')), 'Earned 1,500 credits ($0.015)');
  // A failed "load more" keeps the rows and offers Retry.
  state.fail.add('more');
  await goto('/channels/8200001/referrals');
  await page.getByRole('button', { name: 'Load more' }).click();
  await page.locator('[data-invited] .lf-notice').getByText("Couldn't load more").waitFor();
  assert.equal(await people.count(), 25, 'rows kept after a failed load more');
  state.fail.delete('more');
  await page.locator('[data-invited] .lf-notice').getByRole('button', { name: 'Retry' }).click();
  await until(async () => (await people.count()) === 31, 'load more retry');

  // ---------------------------------------------------------------- Wording per case
  const cases = [
    ['8200002', 'Invited by mossy_lantern (code lantern) · they haven\'t invited anyone', {
      how: `Added by you on ${dayText(SET_BY_HAND)}`, discount: 'No 10% discount (added by you)', discountOk: false,
      rewards: 'mossy_lantern earns referral rewards from them', rewardsOk: true,
    }],
    ['8200003', 'Invited by mossy_lantern · they haven\'t invited anyone', {
      how: `Added by you on ${dayText(SET_BY_HAND)}`, discount: 'No 10% discount (added by you)', discountOk: false,
      rewards: 'mossy_lantern earns nothing from them: no code on this referral', rewardsOk: false,
    }],
    ['8200004', 'Invited by mossy_lantern (code oldlamp) · they haven\'t invited anyone', {
      how: 'Signed up with their link', discount: 'Gets the 10% discount on a first subscription (if they never subscribed before)', discountOk: true,
      rewards: "mossy_lantern earns nothing from them: code oldlamp isn't active", rewardsOk: false,
    }],
    ['8200005', 'Invited by a deleted account · they haven\'t invited anyone', {
      how: 'Old record', discount: 'No 10% discount (no code on record)', discountOk: false,
      rewards: "Nobody earns rewards from them: the inviter's account was deleted", rewardsOk: false,
    }],
  ];
  for (const [id, line, expected] of cases) {
    await goto(`/channels/${id}/referrals`);
    assert.equal(await text(answer), line, `${id}: answer`);
    assert.deepEqual(await facts(), expected, `${id}: invited-by facts`);
    await page.locator('[data-invited] .rf-empty').getByText("They haven't invited anyone").waitFor();
    await page.locator('[data-codes]').getByText('They have no referral codes.').waitFor();
  }
  assert.equal(await text(by.locator('.rf-who__name')), 'a deleted account');
  assert.equal(await by.locator('a.rf-who__name').count(), 0, 'a deleted inviter has no link');
  assert.equal(await text(by.locator('.lf-chip')), 'No code');
  await shot('deleted-inviter-dark-390');
  await goto('/channels/8200003/referrals');
  assert.equal(await text(by.locator('.lf-chip')), 'No code');

  // ---------------------------------------------------------------- Nobody invited them → set one (default code)
  await goto('/channels/8200006/referrals');
  assert.equal(await text(answer), "Nobody invited them · they haven't invited anyone");
  await by.getByText('Nobody invited them.').waitFor();
  assert.equal(await by.getByRole('button', { name: 'Change' }).count(), 0);
  await shot('nobody-dark-390');
  await by.getByRole('button', { name: 'Add who invited them' }).click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await text(editor.locator('h2')), 'Add who invited tidal_rook');
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('type') === 'search'), 'search field focused');
  await editor.getByRole('button', { name: 'Save' }).click();
  await editor.getByText('Pick who invited them first.').waitFor();
  assert.equal(puts().length, 0, 'nothing saved without an inviter');
  // Picking the person themselves is refused before saving.
  await pick('tidal', 'tidal_rook');
  await editor.getByText("Someone can't invite themselves. Pick another channel.").waitFor();
  assert.equal(await editor.getByRole('radiogroup').count(), 0);
  await editor.getByRole('button', { name: /^Change tidal_rook/ }).click();
  const inviterGets = referralGets('8200001').length;
  await pick('mossy', 'mossy_lantern');
  await editor.getByRole('radiogroup').waitFor();
  assert.equal(referralGets('8200001').length, inviterGets + 1, "the inviter's codes are loaded");
  const choices = editor.locator('.re-codes label[data-code]');
  assert.deepEqual(await choices.evaluateAll((els) => els.map((el) => el.dataset.code)), ['', 'lantern', 'cozy', 'oldlamp'], 'first active default, then active codes, then off');
  assert.equal(await text(choices.nth(0)), 'Their first active code Uses lantern');
  assert.equal(await editor.locator('input[name="re-code"][value=""]').isChecked(), true, 'default is their first active code');
  assert.match(await text(choices.nth(3)), /oldlamp Old banner Off: rewards won't reach mossy_lantern/);
  const consequence = editor.locator('[data-consequence]');
  assert.equal(await text(consequence), "tidal_rook counts as invited by mossy_lantern. They won't get the 10% discount. mossy_lantern earns rewards when tidal_rook pays.");
  await choices.nth(3).click();
  await until(async () => (await text(consequence)).endsWith('mossy_lantern earns nothing when tidal_rook pays: code oldlamp is off.'), 'inactive code consequence');
  await choices.nth(0).click();
  await until(async () => (await text(consequence)).endsWith('mossy_lantern earns rewards when tidal_rook pays.'), 'default code consequence');
  await settle();
  await axeOn('[data-referral-editor]', 'editor 390 dark');
  await shot('set-inviter-dialog-dark-390');
  await editor.getByRole('button', { name: 'Save' }).click();
  await until(async () => puts().length === 1, 'set inviter PUT');
  assert.equal(puts()[0].path, '/admin-site/users/8200006/referrer');
  assert.deepEqual(puts()[0].body, { referrer: '8200001', expectedReferrer: null }, 'the default code sends no code and no replace; nobody invited them before');
  await editor.waitFor({ state: 'hidden' });
  await until(async () => (await text(answer)) === "Invited by mossy_lantern (code lantern) · they haven't invited anyone", 'answer after setting the inviter');
  assert.equal((await facts()).how, `Added by you on ${dayText(new Date().toISOString())}`);
  await page.getByText('Now invited by mossy_lantern (code lantern)').first().waitFor();

  // ---------------------------------------------------------------- Change an inviter: code sent, 409 → Move them
  await goto('/channels/8200002/referrals');
  await by.getByRole('button', { name: 'Change who invited amber_kettle' }).click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await text(editor.locator('h2')), 'Change who invited amber_kettle');
  assert.match(await text(editor.locator('.re-now')), /^Now invited by mossy_lantern \(code lantern\)\. Rewards already paid stay where they are\.$/);
  await pick('quiet', 'quiet_fjord');
  await editor.getByRole('radiogroup').waitFor();
  assert.deepEqual(await choices.evaluateAll((els) => els.map((el) => el.dataset.code)), ['', 'fjord', 'fjordold']);
  await editor.locator('label[data-code="fjord"]').click();
  await until(async () => editor.locator('input[name="re-code"][value="fjord"]').isChecked(), 'fjord chosen');
  assert.equal(await text(consequence), "amber_kettle counts as invited by quiet_fjord. They won't get the 10% discount. quiet_fjord earns rewards when amber_kettle pays.");
  await editor.getByRole('button', { name: 'Save' }).click();
  const conflict = editor.locator('[data-conflict]');
  await conflict.waitFor();
  assert.equal(await text(conflict), 'amber_kettle were invited by mossy_lantern (code lantern). Confirm to move them.');
  assert.equal(puts().length, 2);
  assert.deepEqual(puts()[1].body, { referrer: '8200010', code: 'fjord', expectedReferrer: 'u8200001' }, 'first save: the code, no replace, the inviter the page showed');
  assert.equal(await editor.getByRole('button', { name: 'Save' }).count(), 0, 'Save becomes Move them');
  assert.equal(state.refs['8200002'].referrer, '8200001', 'a 409 changes nothing');
  await shot('move-them-dark-390');
  await editor.getByRole('button', { name: 'Move them' }).click();
  await until(async () => puts().length === 3, 'move PUT');
  assert.equal(puts()[2].path, '/admin-site/users/8200002/referrer');
  assert.deepEqual(puts()[2].body, { referrer: '8200010', code: 'fjord', replace: true, expectedReferrer: 'u8200001' });
  await editor.waitFor({ state: 'hidden' });
  await until(async () => (await text(answer)) === "Invited by quiet_fjord (code fjord) · they haven't invited anyone", 'answer after moving');
  assert.equal(await by.getByRole('link', { name: 'quiet_fjord' }).getAttribute('href'), '/channels/8200010/referrals');
  // Cancel never writes.
  await by.getByRole('button', { name: /^Change who invited/ }).click();
  await editor.waitFor({ state: 'visible' });
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(puts().length, 3, 'cancel writes nothing');

  // ---------------------------------------------------------------- Remove an inviter (confirmed first)
  await goto('/channels/8200001/referrals');
  await by.getByRole('button', { name: 'Remove who invited mossy_lantern' }).click();
  await confirm.waitFor({ state: 'visible' });
  assert.equal(await text(confirm.locator('.confirm__message')), "Remove quiet_fjord as the person who invited mossy_lantern? Rewards already paid stay; future payments won't reward quiet_fjord.");
  await settle();
  await axeOn('dialog.confirm', 'remove confirm 390 dark');
  await shot('remove-inviter-confirm-dark-390');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(puts().length, 3, 'cancelled remove writes nothing');
  await by.getByRole('button', { name: 'Remove who invited mossy_lantern' }).click();
  await confirm.waitFor({ state: 'visible' });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await until(async () => puts().length === 4, 'remove PUT');
  assert.equal(puts()[3].path, '/admin-site/users/8200001/referrer');
  assert.deepEqual(puts()[3].body, { referrer: null, expectedReferrer: 'u8200010' }, 'removal names the inviter the page showed');
  await confirm.waitFor({ state: 'hidden' });
  await by.getByText('Nobody invited them.').waitFor();
  assert.equal(await text(answer), 'Nobody invited them · invited 31 people · earned 4,500 credits ($0.045)');

  // ---------------------------------------------------------------- Add someone they invited (PUT on their channel)
  const getsBefore = referralGets('8200001').length;
  await page.getByRole('button', { name: 'Add someone they invited' }).click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await text(editor.locator('h2')), 'Add someone mossy_lantern invited');
  // pale_comet is on the second page (not loaded): the dialog asks who invited them and refuses a re-add.
  const paleGets = referralGets('8200003').length;
  const sunnyGets = referralGets('8200007').length;
  await pick('pale', 'pale_comet');
  await editor.getByText('pale_comet already counts as invited by mossy_lantern.').waitFor();
  assert.equal(referralGets('8200003').length, paleGets + 1, "the picked person's inviter is checked");
  assert.equal(await editor.getByRole('radiogroup').count(), 0);
  await editor.getByRole('button', { name: /^Change pale_comet/ }).click();
  await pick('sunny', 'sunny_badger');
  await editor.getByRole('radiogroup').waitFor();
  assert.equal(await text(editor.locator('[data-picked-inviter]')), "Now invited by quiet_fjord (code fjord). You'll be asked to confirm the move.");
  assert.equal(referralGets('8200001').length, getsBefore, "this channel's own codes are used (no extra request)");
  assert.equal(referralGets('8200007').length, sunnyGets + 1);
  assert.deepEqual(await choices.evaluateAll((els) => els.map((el) => el.dataset.code)), ['', 'lantern', 'cozy', 'oldlamp']);
  await editor.locator('label[data-code="lantern"]').click();
  assert.equal(await text(consequence), "sunny_badger counts as invited by mossy_lantern. They won't get the 10% discount. mossy_lantern earns rewards when sunny_badger pays.");
  await editor.getByRole('button', { name: 'Save' }).click();
  await conflict.waitFor();
  assert.equal(await text(conflict), 'sunny_badger were invited by quiet_fjord (code fjord). Confirm to move them.');
  assert.equal(puts().at(-1).path, '/admin-site/users/8200007/referrer', "the PUT goes to the invited person's channel");
  assert.deepEqual(puts().at(-1).body, { referrer: '8200001', code: 'lantern', expectedReferrer: 'u8200010' }, "the picked person's current inviter");
  await editor.getByRole('button', { name: 'Move them' }).click();
  await until(async () => puts().at(-1).body.replace === true, 'move invited PUT');
  assert.equal(puts().at(-1).path, '/admin-site/users/8200007/referrer');
  assert.deepEqual(puts().at(-1).body, { referrer: '8200001', code: 'lantern', replace: true, expectedReferrer: 'u8200010' });
  await editor.waitFor({ state: 'hidden' });
  await until(async () => referralGets('8200001').length === getsBefore + 1, 'list asked again');
  assert.equal(referralGets('8200001').at(-1).query.get('cursor'), null, 'refresh starts from the first page');
  await until(async () => (await text(page.locator('[data-total]'))) === '32', 'total after adding');
  assert.equal(await people.first().getAttribute('data-person'), 'sunny_badger');
  assert.match(await text(people.first()), /code lantern · added by you/);
  assert.equal(await text(answer), 'Nobody invited them · invited 32 people · earned 4,500 credits ($0.045)');

  // ---------------------------------------------------------------- Remove an invited person (confirmed)
  const paleRow = page.locator('[data-invited] li[data-person="pale_comet"]');
  await page.getByRole('button', { name: 'Load more' }).click();
  await paleRow.waitFor();
  const putsBefore = puts().length;
  await paleRow.getByRole('button', { name: 'Remove pale_comet from people mossy_lantern invited' }).click();
  await confirm.waitFor({ state: 'visible' });
  assert.equal(await text(confirm.locator('.confirm__message')), "Remove mossy_lantern as the person who invited pale_comet? Rewards already paid stay; future payments won't reward mossy_lantern.");
  assert.equal(puts().length, putsBefore, 'nothing removed before confirming');
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await until(async () => puts().length === putsBefore + 1, 'remove invited PUT');
  assert.equal(puts().at(-1).path, '/admin-site/users/8200003/referrer');
  assert.deepEqual(puts().at(-1).body, { referrer: null, expectedReferrer: 'u8200001' }, 'removing someone from this list names this channel as their inviter');
  await confirm.waitFor({ state: 'hidden' });
  await until(async () => (await text(page.locator('[data-total]'))) === '31', 'total after removing');
  await until(async () => (await paleRow.count()) === 0, 'pale_comet left the list');

  // ---------------------------------------------------------------- Load error + Retry
  state.fail.add('referrals');
  await goto('/channels/8200001/referrals', '.lf-status--live');
  await page.getByText("Couldn't load referrals").waitFor();
  state.fail.delete('referrals');
  await page.locator('.rf').getByRole('button', { name: 'Retry' }).click();
  await answer.waitFor();
  assert.match(await text(answer), /^Nobody invited them · invited 31 people/);

  // ---------------------------------------------------------------- Layout + accessibility matrix
  state = newState();
  api = makeApi(state);
  const matrix = [
    ['/channels/8200001/referrals', '[data-invited] li[data-person]'],
    ['/channels/8200005/referrals', '[data-invited-by] .rf-facts'],
    ['/channels/8200006/referrals', '[data-invited-by] .rf-none'],
  ];
  const targets = '.rf-actions .lf-btn, .rf-none .lf-btn, [data-add-invited], .rf-person__act, .rf-more .lf-btn, a.rf-who__name, a.rf-person__name, .ws-tabs .lf-tab';
  for (const mode of ['dark', 'light']) {
    await page.evaluate((value) => localStorage.setItem('dima-admin.mode.v1', value), mode);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      for (const [path, ready] of matrix) {
        await goto(path, ready);
        await page.waitForTimeout(150);
        const label = `${path} ${mode} ${width}`;
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), mode === 'dark', `${label}: theme`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${label}: horizontal overflow`);
        assert.equal(await h1.count(), 1, `${label}: one h1`);
        if (width < 960) {
          for (const target of await page.locator(targets).all()) {
            if (!(await target.isVisible())) continue;
            // Stretched links: the hit area is the ::after box over the row.
            const box = await target.evaluate((el) => {
              const after = getComputedStyle(el, '::after');
              const host = after.content !== 'none' && after.position === 'absolute' ? el.closest('.rf-person, .rf-who') : el;
              const rect = host.getBoundingClientRect();
              return { height: rect.height, name: el.className };
            });
            assert.ok(box.height >= 43.5, `${label}: 44px touch target for ${box.name} (${box.height})`);
          }
        }
        await axeOn('app-channel-shell', label);
        await page.screenshot({ path: `${artifacts}/${path.split('/')[2]}-${mode}-${width}.png`, fullPage: width < 960 });
      }
    }
  }
  // The dialog open at 1280 light (the matrix ends there): axe, then Cancel writes nothing.
  const putsAtEnd = puts().length;
  await goto('/channels/8200001/referrals', '[data-invited] li[data-person]');
  await page.getByRole('button', { name: 'Add someone they invited' }).click();
  await editor.waitFor({ state: 'visible' });
  await pick('tidal', 'tidal_rook');
  await editor.getByRole('radiogroup').waitFor();
  await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'dialog 1280 light: horizontal overflow');
  await axeOn('[data-referral-editor]', 'editor 1280 light');
  await shot('add-invited-dialog-light-1280');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(puts().length, putsAtEnd, 'cancel writes nothing');
  // And the phone sheet at 320 light: fits without sideways scrolling.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole('button', { name: 'Change who invited mossy_lantern' }).click();
  await editor.waitFor({ state: 'visible' });
  await pick('quiet', 'quiet_fjord');
  await editor.getByRole('radiogroup').waitFor();
  await settle();
  assert.equal(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'dialog 320: no sideways scroll');
  await shot('change-inviter-dialog-light-320');
  await editor.getByRole('button', { name: 'Cancel' }).click();

  assert.deepEqual(unexpected, [], 'no unexpected API calls');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`PASS admin channel referrals: Referrals tab in the strip (8 tabs) + deep link + title, answer line with credits and dollars, invited-by wording (code sign-up, set by hand, no code, inactive code, deleted inviter, nobody), codes, people rows/links/load more with cursor/error + retry, set inviter (self refused, default code sends no code), change inviter (code sent, 409 → Move them with replace), remove inviter (confirmed, cancel writes nothing), add someone they invited (already invited by them refused from a page not loaded, current inviter shown, PUT on their channel, 409 → Move them), remove an invited person (confirmed), load error + retry, 320/390/1280 dark+light overflow/44px/axe, dialog axe at 390 dark + 1280 light. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
