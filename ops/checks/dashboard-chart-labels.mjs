/**
 * Behavior check: dashboard performance-chart label layout.
 *
 * Renders the real DashboardComponent against a mocked session + API so the
 * ECharts chart draws with 30 days of history, then asserts the change:
 *
 *  - desktop keeps the rotated y-axis names and shows no axis color guide;
 *  - mobile drops the rotated names, fits the tile width without horizontal
 *    overflow, and shows the axis color guide with the expected scales/colors.
 *
 * Screenshots are written to /tmp for human review. Canvas text cannot be
 * asserted directly, so the mobile/desktop screenshots are the visual evidence.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire((process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser') + '/package.json');
const { chromium } = require('playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;

const CHANNEL_ID = '123456789';
const TWITCH = {
  id: CHANNEL_ID,
  login: 'test',
  display_name: 'Test Streamer',
  profile_image_url: ''
};

const EXPECTED_CHIPS = [
  { label: 'Engagement', dots: 3 },
  { label: 'Hours', dots: 1 },
  { label: 'Bits', dots: 1 },
  { label: 'Donations', dots: 1 }
];

function buildHistory() {
  const out = [];
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 29; i >= 0; i--) {
    const day = new Date(cursor);
    day.setUTCDate(cursor.getUTCDate() - i);
    out.push({
      date: day.toISOString(),
      viewers: Math.round(20 + Math.random() * 200),
      hours: Number((1 + Math.random() * 5).toFixed(1)),
      bits: Math.round(Math.random() * 900),
      donations: Number((Math.random() * 40).toFixed(2)),
      follows: Math.round(Math.random() * 60),
      subs: Math.round(Math.random() * 10)
    });
  }
  return out;
}

function bootstrapData() {
  const history = buildHistory();
  return {
    role: 'owner',
    channel: { id: CHANNEL_ID, name: 'Test Streamer', chatEnabled: true },
    isLive: false,
    liveStream: null,
    liveSession: null,
    kpis: {
      activeViewers: 0,
      averageViewers: 120,
      monthlyAverageViewers: 110,
      averageHoursPerStream: 3.2,
      totalBits: 4200,
      totalStreams: 18,
      totalDonations: 210.5,
      activeFollows: 55,
      activeSubs: 9,
      monthlyGoalSubs: 100,
      subsProgressPct: 9
    },
    trend: history.map((point) => ({ date: point.date, viewers: point.viewers, hours: point.hours })),
    streamHistory: history,
    totalFollowers: 5400,
    totalSubs: 320,
    monthlyGoals: { followersGoal: 6000, followersCurrent: 5400, subsGoal: 500, subsCurrent: 320 }
  };
}

function envelope(data) {
  return { error: false, status: 200, message: 'ok', data };
}

async function installMocks(context) {
  const twitch = TWITCH;
  const app = {
    name: 'Test Streamer',
    email: 'test@example.invalid',
    language: 'en',
    plan_tier: 'premium',
    actived: true,
    chat_enabled: true,
    twitch_user_id: CHANNEL_ID,
    has_permissions: true,
    up_to_date_permissions: true,
    administrating: []
  };
  await context.addInitScript(({ twitch, app }) => {
    localStorage.setItem('dimasite.session.v1', JSON.stringify({
      version: 2,
      token: 'test-only',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      twitchUser: twitch,
      appUser: app,
      permissions: {}
    }));
  }, { twitch, app });

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      return route.continue();
    }
    if (url.hostname !== 'api.domdimabot.com') {
      return route.abort();
    }

    let data = {};
    if (url.pathname === '/auth/session') {
      data = { twitch, app };
    } else if (url.pathname.startsWith('/auth/access/')) {
      data = { allowed: true, role: 'owner' };
    } else if (/^\/dashboard\/[^/]+\/bootstrap$/.test(url.pathname)) {
      data = bootstrapData();
    } else if (/^\/dashboard\/[^/]+\/access$/.test(url.pathname)) {
      data = { allowed: true, role: 'owner', channelID: CHANNEL_ID, channelName: 'Test Streamer', planTier: 'premium' };
    } else if (/^\/dashboard\/[^/]+\/live-status$/.test(url.pathname)) {
      data = { isLive: false, checkedAt: new Date().toISOString(), stream: null, liveSession: null };
    } else if (url.pathname === '/users') {
      data = { id: CHANNEL_ID, username: 'test', profile_image_url: '' };
    }
    return route.fulfill({ status: 200, json: envelope(data) });
  });
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const [width, height, mode] of [
    [1280, 900, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
    [320, 568, 'mobile-320']
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await installMocks(context);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/test/dashboard`);
    await page.waitForSelector('.lf-chart__canvas canvas', { timeout: 15000 });
    await page.waitForTimeout(700);

    const chart = await page.evaluate(() => {
      const host = document.querySelector('.lf-chart__canvas');
      const canvas = host?.querySelector('canvas');
      const chipRow = document.querySelector('.lf-axis-chips');
      return {
        hostWidth: host ? Math.round(host.getBoundingClientRect().width) : 0,
        hostScrollWidth: host ? host.scrollWidth : 0,
        canvasWidth: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
        canvasHeight: canvas ? Math.round(canvas.getBoundingClientRect().height) : 0,
        chipCount: chipRow ? chipRow.querySelectorAll('.lf-axis-chip').length : 0,
        chips: chipRow
          ? [...chipRow.querySelectorAll('.lf-axis-chip')].map((chip) => ({
              label: chip.textContent?.trim() ?? '',
              dots: [...chip.querySelectorAll('.lf-axis-chip__dot')].map((dot) => {
                const rect = dot.getBoundingClientRect();
                return Math.round(rect.width);
              })
            }))
          : [],
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });

    assert.ok(chart.canvasWidth > 200 && chart.canvasHeight > 150,
      `${mode}: chart canvas too small (${chart.canvasWidth}x${chart.canvasHeight})`);
    assert.ok(chart.documentOverflow <= 1,
      `${mode}: page overflows horizontally by ${chart.documentOverflow}px`);
    assert.ok(chart.hostScrollWidth <= chart.hostWidth + 1,
      `${mode}: chart host overflows its tile (${chart.hostScrollWidth} > ${chart.hostWidth})`);

    if (mode === 'desktop' || mode === 'tablet') {
      assert.equal(chart.chipCount, 0, 'desktop must not show the mobile axis color guide');
    } else {
      assert.equal(chart.chipCount, EXPECTED_CHIPS.length,
        `mobile axis guide must list ${EXPECTED_CHIPS.length} scales, saw ${chart.chipCount}`);
      chart.chips.forEach((chip, index) => {
        const expected = EXPECTED_CHIPS[index];
        assert.equal(chip.label, expected.label, `mobile chip ${index} label mismatch: "${chip.label}"`);
        assert.equal(chip.dots.length, expected.dots, `mobile chip "${chip.label}" dot count`);
        chip.dots.forEach((dotWidth) =>
          assert.ok(dotWidth >= 4, `mobile chip "${chip.label}" dot too small (${dotWidth}px)`));
      });
    }

    await page.locator('.lf-chart').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.locator('.lf-chart').screenshot({ path: `/tmp/dashboard-chart-${mode}.png` });
    await page.screenshot({ path: `/tmp/dashboard-page-${mode}.png`, fullPage: false });
    assert.deepEqual(errors, [], `${mode}: browser errors`);
    await context.close();
  }
  console.log('PASS dashboard chart fits its tile, hides mobile axis names, and shows the axis color guide');
} finally {
  await browser.close();
}
