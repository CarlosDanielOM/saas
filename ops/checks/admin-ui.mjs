/**
 * Admin site (Live First redesign) behavior check. Every API call is mocked;
 * unexpected external requests fail the check, so no reminder, email, credit
 * grant or EventSub change can reach production. No live credentials are used.
 *
 * Env: SAAS_PREVIEW_URL (required), SAAS_PLAYWRIGHT_MODULE / PLAYWRIGHT_MODULE,
 * AXE_PATH, SAAS_CHROMIUM_PATH, SAAS_UI_ARTIFACTS (screenshots).
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.SAAS_PLAYWRIGHT_MODULE ||
    process.env.PLAYWRIGHT_MODULE ||
    "/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs"
);
const axePath =
  process.env.AXE_PATH ||
  "/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js";
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, "SAAS_PREVIEW_URL is required");
const artifacts = process.env.SAAS_UI_ARTIFACTS || "/tmp/admin-ui-check";
await mkdir(artifacts, { recursive: true });

const TOKEN = "disposable-ui-fixture";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SAAS_CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  serviceWorkers: "block",
});
const failures = [];
const requests = [];
const snapshot = {
  registeredUsers: 2486,
  liveUsers: 38,
  authorizedAccounts: 1924,
  totalMessages: 28400000,
  totalCommands: 843200,
  totalLiveViewers: 12480,
};
const rows = [
  "pixelpilot",
  "lunastreams",
  "theverylongstreamername_for_layout_checks",
].map((channel, i) => ({
  channel,
  channelID: String(9001 + i),
  email:
    i === 2
      ? "a.long.address.for.mobile@example.test"
      : `${channel}@example.test`,
  plan_tier: ["pro", "premium", "free"][i],
  actived: i < 2,
  chat_enabled: i < 2,
  has_permissions: i < 2,
  up_to_date_permissions: i === 0,
  isLive: i === 0,
  liveViewers: i === 0 ? 1284 : 0,
  commandsCount: 24 + i,
  eventsubsActiveCount: 1,
  eventsubsDisabledCount: 0,
  created_at: "2026-08-10T12:00:00Z",
  reminder_sent_at: i === 1 ? "2026-09-01T12:00:00Z" : null,
}));
const summary = {
  totalChannels: 101,
  liveChannels: 38,
  activeBots: 85,
  inactiveBots: 16,
  withPermissions: 94,
  permissionsNeedUpdate: 7,
  liveViewers: 12480,
  totalCommands: 900,
  totalEventsubsActive: 400,
  totalEventsubsDisabled: 3,
};
const page2 = [{ ...rows[0], channel: "secondpage", channelID: "9010" }];
let failAnalytics = false;
let failUsers = false;
let rankFixtureMode = false;
let holdDescending = false;
let releaseDescending;
let testEventCalls = 0;
const eventsubState = { followEnabled: true, subscribeConnected: false };
const rankedRows = Array.from({ length: 201 }, (_, i) => ({
  ...rows[0],
  channelID: String(20000 + i),
  channel:
    i === 200 ? "ranked-top-streamer" : `ranked-${String(i).padStart(3, "0")}`,
  liveViewers: i === 200 ? 999999 : i + 1,
  commandsCount: 201 - i,
  created_at: new Date(Date.UTC(2026, 8, 13) - i * 86400000).toISOString(),
}));
function sortRows(source, params) {
  const field = params.get("sortBy") || "channel";
  const direction = params.get("sortOrder") === "desc" ? -1 : 1;
  return [...source].sort((a, b) => {
    let av = a[field],
      bv = b[field];
    if (field === "created_at") {
      av = Date.parse(av);
      bv = Date.parse(bv);
    }
    if (field === "has_permissions") {
      av = a.has_permissions && a.up_to_date_permissions;
      bv = b.has_permissions && b.up_to_date_permissions;
    }
    return av === bv
      ? a.channel.localeCompare(b.channel)
      : (av < bv ? -1 : 1) * direction;
  });
}
const json = (route, data, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
const usageSummary = {
  planTier: "pro",
  credits: {
    version: 1,
    used: 37500,
    limit: 200000,
    balance: 162500,
    meterId: "m",
    updatedAt: "2026-10-01T00:00:00Z",
    available: true,
  },
  billingPeriod: {
    source: "subscription",
    from: "2026-09-20",
    to: "2026-10-20",
    totalDayCount: 30,
    elapsedDayCount: 13,
  },
  ledger: { status: "ready", coverageStart: "2026-09-20" },
  pacing: {
    status: "over_pace",
    averageDailyCredits: 9000,
    projectedPeriodCredits: 270000,
    remainingPeriodDays: 17,
    expectedToExhaustWithinPeriod: true,
    estimatedDaysUntilExhaustion: 12,
  },
  analytics: {
    itemizationStartedAt: "2026-09-01T00:00:00Z",
    totalSpentCredits: 117000,
    averageDailySpentCredits: 9000,
    grantedCredits: 25000,
    netConsumedCredits: 92000,
    transactionCount: 412,
    daily: Array.from({ length: 13 }, (_, i) => ({
      date: `2026-09-${String(20 + i).padStart(2, "0")}`.replace(
        "2026-09-31",
        "2026-10-01",
      ),
      credits: 4000 + ((i * 3137) % 9000),
      transactionCount: 20 + i,
    })).map((d, i) =>
      i > 10 ? { ...d, date: `2026-10-0${i - 9}` } : d,
    ),
    categories: [
      { category: "tts", credits: 70000, transactionCount: 300, percentage: 60 },
      { category: "ai_chat", credits: 35000, transactionCount: 100, percentage: 30 },
      { category: "memory", credits: 12000, transactionCount: 12, percentage: 10 },
    ],
  },
};
const transactions = Array.from({ length: 30 }, (_, i) => ({
  id: `tx${i}`,
  occurredAt: new Date(Date.UTC(2026, 9, 2, 12, 0) - i * 3600000).toISOString(),
  entryKind: i === 4 ? "adjustment" : "usage",
  category: i === 4 ? "credit_adjustment" : i % 2 ? "ai_chat" : "tts",
  operation: i === 4 ? "admin_grant" : i % 2 ? "chat_reply" : "synthesize",
  provider: "fixture",
  model: i % 2 ? "fixture-model" : null,
  quantity: null,
  unit: null,
  credits: i === 4 ? -25000 : 120 + i,
}));

await context.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.origin === new URL(base).origin) return route.continue();
  // Read-only font downloads so screenshots match production typography.
  if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname))
    return req.method() === "GET" ? route.continue().catch(() => {}) : route.abort();
  if (url.hostname !== "api.domdimabot.com") {
    failures.push(`Unexpected external request ${url.origin}${url.pathname}`);
    return route.abort();
  }
  requests.push({
    path: url.pathname,
    query: url.searchParams.toString(),
    method: req.method(),
    body: req.postData(),
    auth: req.headers()["authorization"] || null,
  });
  const p = url.pathname;
  const m = req.method();
  if (p === "/config/site/analytics")
    return json(
      route,
      failAnalytics ? { error: true } : { data: snapshot },
      failAnalytics ? 503 : 200,
    );
  if (p === "/users")
    return json(route, {
      data: { profile_image_url: `${base}/favicon.png` },
    });
  if (p === "/admin-site/users") {
    if (failUsers) return json(route, { error: true }, 503);
    const search = url.searchParams.get("search");
    if (rankFixtureMode && !/^\d+$/.test(search || "")) {
      assert.equal(url.searchParams.get("limit"), "100");
      const filtered = rankedRows.filter(
        (row) => !search || row.channel.includes(search),
      );
      const sorted = sortRows(filtered, url.searchParams);
      const pageNumber = Math.min(
        Number(url.searchParams.get("page") || 1),
        Math.max(1, Math.ceil(sorted.length / 100)),
      );
      if (holdDescending && url.searchParams.get("sortOrder") === "desc") {
        await new Promise((resolve) => {
          releaseDescending = resolve;
        });
      }
      return json(route, {
        data: {
          rows: sorted.slice((pageNumber - 1) * 100, pageNumber * 100),
          pagination: {
            page: pageNumber,
            limit: 100,
            total: sorted.length,
            totalPages: Math.max(1, Math.ceil(sorted.length / 100)),
          },
          summary: { ...summary, totalChannels: sorted.length },
        },
      }).catch(() => {});
    }
    const filtered = search
      ? rows.filter((r) =>
          `${r.channel} ${r.email} ${r.channelID}`.includes(search),
        )
      : url.searchParams.get("page") === "2"
        ? page2
        : rows;
    const limit = Number(url.searchParams.get("limit") || 25);
    return json(route, {
      data: {
        rows: sortRows(filtered, url.searchParams).slice(0, limit),
        pagination: {
          page: Number(url.searchParams.get("page") || 1),
          limit,
          total: search ? filtered.length : 101,
          totalPages: search ? 1 : 2,
        },
        summary,
      },
    });
  }
  if (p.endsWith("/send-reminder"))
    return json(route, { data: { message: "Mock reminder sent" } });
  if (p.endsWith("/ai-credits/grant")) {
    const credits = JSON.parse(req.postData() || "{}").credits;
    return json(route, {
      error: false,
      data: {
        granted: credits,
        before: { used: 37500, limit: 200000, balance: 162500 },
        after: {
          used: 37500,
          limit: 200000 + credits,
          balance: 162500 + credits,
        },
      },
    });
  }
  if (p.endsWith("/ai-credits"))
    return json(route, {
      data: {
        version: 1,
        used: 37500,
        limit: 200000,
        balance: 162500,
        available: true,
      },
    });
  if (p.endsWith("/ai-usage/summary")) return json(route, { error: false, data: usageSummary });
  if (p.endsWith("/ai-usage/transactions")) {
    const category = url.searchParams.get("category");
    const cursor = Number(url.searchParams.get("cursor") || 0);
    const list = transactions.filter((t) => !category || t.category === category);
    const items = list.slice(cursor, cursor + 25);
    return json(route, {
      error: false,
      data: {
        items,
        nextCursor: cursor + 25 < list.length ? String(cursor + 25) : null,
      },
    });
  }
  if (p.endsWith("/commands"))
    return json(route, {
      data: {
        rows: [
          {
            id: "cmd1",
            name: "Welcome to the channel",
            cmd: "!welcome",
            func: "send_chat_message",
            message: "Welcome in, $(user)! Grab a drink.",
            cooldown: 10,
            userLevelName: "Everyone",
            enabled: true,
          },
          {
            id: "cmd2",
            name: "Discord",
            cmd: "!discord",
            func: "send_chat_message",
            message: "Join us at example.test/discord",
            cooldown: 120,
            userLevelName: "Subscribers",
            enabled: false,
          },
        ],
        pagination: { page: 1, totalPages: 1, total: 2 },
      },
    });
  if (p === "/eventsubs/standard")
    return json(route, {
      data: {
        standardTypes: [
          { type: "channel.follow", version: "2", condition: {} },
          { type: "channel.subscribe", version: "1", condition: {} },
        ],
      },
    });
  if (p.endsWith("/eventsubs") && p.startsWith("/admin-site/"))
    return json(route, {
      data: {
        rows: [
          {
            id: "es1",
            type: "channel.follow",
            version: "2",
            enabled: eventsubState.followEnabled,
            status: "enabled",
            created_at: "2026-08-10T12:00:00Z",
          },
          ...(eventsubState.subscribeConnected
            ? [
                {
                  id: "es2",
                  type: "channel.subscribe",
                  version: "1",
                  enabled: true,
                  status: "enabled",
                  created_at: "2026-10-03T12:00:00Z",
                },
              ]
            : []),
        ],
        pagination: { total: 1, totalPages: 1, page: 1 },
      },
    });
  if (p === "/eventsubs/9001/test") {
    testEventCalls += 1;
    return json(
      route,
      testEventCalls === 1
        ? { error: true, message: "Fixture handler failed", status: 500 }
        : { error: false, message: "ok", status: 200 },
    );
  }
  if (p === "/eventsubs/9001" && m === "POST") {
    eventsubState.subscribeConnected = true;
    return json(route, { error: false, message: "created" });
  }
  if (p === "/eventsubs/9001/es1" && m === "PATCH") {
    eventsubState.followEnabled = JSON.parse(req.postData()).enabled;
    return json(route, { error: false, message: "updated" });
  }
  if (p.startsWith("/rewards/")) return json(route, { data: { rewards: [] } });
  if (p.startsWith("/triggers/files/"))
    return json(route, { data: { files: [] } });
  if (p.startsWith("/triggers/"))
    return json(route, { data: { triggers: [] } });
  if (p.startsWith("/timers/")) return json(route, { data: { timers: [] } });
  if (p.startsWith("/memories/"))
    return json(route, { data: { memories: [] } });
  if (p === "/admin/read-file") {
    if (req.headers()["authorization"] !== `Bearer ${TOKEN}`)
      return json(route, { error: true, message: "No token provided" }, 401);
    return json(
      route,
      url.searchParams.get("path") === "/missing"
        ? { error: true, message: "Fixture file not found" }
        : {
            data: {
              content:
                'export const status = "ready";\n// Disposable browser fixture\n',
            },
          },
    );
  }
  if (p === "/email/test")
    return json(route, {
      error: false,
      data: { activationLink: "https://example.test/activate?fixture=true" },
    });
  failures.push(`Unmocked API request ${m} ${p}`);
  return route.abort();
});
await context.addInitScript(
  ({ snapshot, TOKEN }) => {
    // The fake session unlocks only the local UI; every remote request is intercepted.
    localStorage.setItem(
      "dima-admin.session.v1",
      JSON.stringify({
        version: 2,
        token: TOKEN,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: {
          id: "533538623",
          login: "admin_fixture",
          display_name: "Alex",
          email: "alex@example.test",
        },
        appUser: {
          twitch_user_id: "533538623",
          name: "admin_fixture",
          plan_tier: "free",
        },
      }),
    );
    window.EventSource = class {
      constructor() {
        window.__analyticsStream = this;
        this.timer = setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify(snapshot) });
        }, 60);
      }
      close() {
        clearTimeout(this.timer);
      }
    };
    // Clipboard is not granted in headless runs; record writes instead.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => (window.__copied = text) },
    });
  },
  { snapshot, TOKEN },
);
const page = await context.newPage();
page.on("pageerror", (err) => failures.push(err.message));
const visible = (selector) =>
  page.locator(selector).first().waitFor({ state: "visible" });
const count = (path, method) =>
  requests.filter((r) => r.path.endsWith(path) && (!method || r.method === method))
    .length;
async function until(fn, label, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await page.waitForTimeout(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function settled() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
}
async function noOverflow(label) {
  await settled();
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  if (overflow.scroll > overflow.width + 1) {
    const culprits = await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
        .slice(-5)
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`),
    );
    assert.fail(`${label}: page overflows ${JSON.stringify(overflow)} ${culprits.join(" | ")}`);
  }
}
async function screenshot(name) {
  const modal = await page.locator("dialog[open]").count();
  if (!modal) await page.evaluate(() => window.scrollTo(0, 0));
  await settled();
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: !modal });
}
async function axe(label) {
  await settled();
  if (!(await page.evaluate(() => Boolean(window.axe))))
    await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() =>
    window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }),
  );
  assert.deepEqual(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target).slice(0, 4),
    })),
    [],
    `axe ${label}`,
  );
}
async function setMode(mode) {
  await page.evaluate((mode) => localStorage.setItem("dima-admin.mode.v1", mode), mode);
}

try {
  // ---------- Overview ----------
  await page.goto(`${base}/dashboard`);
  await visible(".metrics .metric strong");
  await page.getByText("Some streamers might need a hand").waitFor();
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );
  assert.match(await page.locator(".connection").textContent(), /Live updates/);
  assert.equal(await page.locator(".bottom-nav a").count(), 4);
  await page.getByRole("link", { name: /pixelpilot/ }).first().waitFor();
  const healthQuery = new URLSearchParams(
    requests.find((r) => r.path === "/admin-site/users").query,
  );
  assert.equal(healthQuery.get("sortBy"), "liveViewers");
  assert.equal(healthQuery.get("limit"), "6");
  await noOverflow("Overview 390");
  await screenshot("overview-dark-390");
  await page.evaluate(() =>
    window.__analyticsStream.onmessage({ data: "{invalid" }),
  );
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );
  // "Needs attention" rows open the directory sorted to the right people.
  await page.getByRole("link", { name: /16 Bots not active/ }).click();
  await visible(".user-identity");
  assert.match(page.url(), /sort=actived/);
  assert.match(page.url(), /order=asc/);
  assert.equal(
    await page.getByRole("button", { name: "16 bots off" }).getAttribute("aria-pressed"),
    "true",
  );
  let lastUsers = new URLSearchParams(
    requests.filter((r) => r.path === "/admin-site/users").at(-1).query,
  );
  assert.equal(lastUsers.get("sortBy"), "actived");
  assert.equal(lastUsers.get("sortOrder"), "asc");

  // ---------- Users ----------
  await page.locator(".bottom-nav").getByRole("link", { name: "Users", exact: true }).click();
  await visible(".user-card");
  assert.equal(await page.locator(".user-card").count(), 3);
  await noOverflow("Users 390");
  await screenshot("users-dark-390");
  await page.locator(".user-details summary").first().click();
  await page
    .locator(".user-details__body")
    .first()
    .getByRole("button", { name: "Send reminder" })
    .click();
  await visible("dialog[open]");
  assert.ok(
    await page.evaluate(() =>
      document.querySelector("dialog[open]").contains(document.activeElement),
    ),
    "Modal gets focus",
  );
  await screenshot("reminder-dark-390");
  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(count("/send-reminder"), 0, "Cancelling never sends a reminder");
  await page
    .locator(".user-details__body")
    .first()
    .getByRole("button", { name: "Send reminder" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send reminder", exact: true })
    .click();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(count("/send-reminder"), 1);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("secondpage", { exact: true }).waitFor();
  assert.equal(await page.locator(".user-card").count(), 1, "Pagination shows selected page only");
  assert.match(page.url(), /page=2/);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByText("pixelpilot", { exact: true }).waitFor();
  await page.getByRole("searchbox").fill("example.test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await visible(".user-identity");
  assert.equal(await page.locator(".user-card").count(), 3, "Search keeps all matches");
  assert.match(page.url(), /q=example\.test/);
  await page.getByRole("button", { name: "Clear search" }).click();
  await visible(".user-identity");
  await page.getByRole("searchbox").fill("no-match");
  await page.getByRole("heading", { name: "No users found" }).waitFor();
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await page.getByLabel("Sort by", { exact: true }).selectOption("channel");
  await page.getByLabel("Sort order", { exact: true }).selectOption("asc");
  await page.waitForFunction(
    () => document.querySelector(".user-identity strong")?.textContent === "lunastreams",
  );
  // Live chip sorts live first.
  await page.getByRole("button", { name: "38 live" }).click();
  await page.waitForFunction(
    () => document.querySelector(".user-identity strong")?.textContent === "pixelpilot",
  );

  // ---------- Channel ----------
  await page.getByRole("link", { name: "Open channel for pixelpilot" }).click();
  await visible(".credit-usage__progress");
  await page.getByText("Twitch access is out of date.").waitFor({ state: "attached" }).catch(() => {});
  assert.equal(
    await page.getByRole("progressbar").getAttribute("aria-valuenow"),
    "19",
  );
  await page.getByText("Everything looks good").waitFor();
  await noOverflow("Channel 390");
  await screenshot("channel-dark-390");
  // Granting credits needs an explicit confirmation.
  await page.getByRole("button", { name: "Add credits" }).click();
  await visible("dialog[open]");
  assert.deepEqual(
    (await page.locator(".credit-grant-panel__presets button").allTextContents()).map((t) => t.trim()),
    ["+25K", "+200K", "+800K"],
    "credit grant presets must reflect the plan ceilings",
  );
  await screenshot("grant-dark-390");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(count("/ai-credits/grant"), 0, "Cancelling never grants");
  await page.getByRole("button", { name: "Add credits" }).click();
  await page.getByRole("dialog").getByPlaceholder("e.g. 50000").fill("9000000");
  await page.getByRole("dialog").getByRole("button", { name: /^Add/ }).last().click();
  await page.getByText("You can add up to 5,000,000 credits at once.").waitFor();
  assert.equal(count("/ai-credits/grant"), 0, "Over-limit grant is blocked inline");
  await page.getByRole("radio", { name: "+25K" }).click();
  await page.getByText("Balance goes from 162,500 to 187,500").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Add 25K credits" }).click();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(count("/ai-credits/grant"), 1);
  assert.equal(
    JSON.parse(requests.filter((r) => r.path.endsWith("/ai-credits/grant")).at(-1).body).credits,
    25000,
  );
  await page.getByText("187.5K left", { exact: true }).waitFor();

  // Channel with problems answers in plain words.
  await page.goto(`${base}/channels/9003`);
  await page.getByText("3 things need attention").waitFor();
  await page.getByText("Bot isn't active.", { exact: false }).waitFor();
  await screenshot("channel-problems-dark-390");
  await page.goto(`${base}/channels/9001`);
  await visible(".credit-usage__progress");

  // ---------- Commands ----------
  await page.locator('a.stat-clickable[href$="/commands"]').click();
  await page.getByRole("heading", { name: "Channel commands" }).waitFor();
  await page.getByText("!welcome", { exact: true }).waitFor();
  await page.getByText("2m cooldown").waitFor();
  await noOverflow("Commands 390");
  await screenshot("commands-dark-390");

  // ---------- Twitch events ----------
  await page.goto(`${base}/channels/9001/eventsubs`);
  await page.getByText("1 of 2 events need attention").waitFor();
  await page.getByText("channel.follow v2").waitFor();
  await noOverflow("Twitch events 390");
  await screenshot("events-dark-390");
  await page.getByRole("button", { name: "Connect New subs" }).click();
  await page.getByText("All 2 events are connected and on").waitFor();
  assert.equal(count("/eventsubs/9001", "POST"), 1);
  await page.getByRole("switch", { name: "Follows on" }).click();
  await until(() => count("/eventsubs/9001/es1", "PATCH") === 1, "follow patch");
  assert.equal(eventsubState.followEnabled, false);
  await page.getByText("1 of 2 events need attention").waitFor();
  await page.getByRole("button", { name: "Test New subs" }).click();
  await visible(".payload-editor");
  await page.getByText("can really appear on their stream", { exact: false }).waitFor();
  await noOverflow("Event editor 390");
  await screenshot("event-test-dark-390");
  await page.getByRole("button", { name: "Send test event" }).click();
  await until(() => testEventCalls === 1, "first test call");
  await until(
    async () => !(await page.getByRole("button", { name: "Send test event" }).isDisabled()),
    "send re-enabled after failure",
  );
  await page.getByRole("button", { name: "Send test event" }).click();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(testEventCalls, 2);

  // ---------- Usage ----------
  await page.goto(`${base}/channels/9001/usage`);
  await page.getByText("On pace to run out in ~12 days").waitFor();
  await page.getByText("that's 5 days before the period resets", { exact: false }).waitFor();
  await page.getByRole("heading", { name: "AI credit usage" }).waitFor();
  assert.equal(await page.locator(".usage-transactions li").count(), 25);
  await page.getByRole("button", { name: "Load more" }).click();
  await until(async () => (await page.locator(".usage-transactions li").count()) === 30, "load more");
  await page.getByRole("group", { name: "Filter charges by category" }).getByRole("button", { name: "Credit adjustments" }).click();
  await until(async () => (await page.locator(".usage-transactions li").count()) === 1, "filter");
  await page.locator(".us-amount.is-credit").waitFor();
  await noOverflow("Usage 390");
  await screenshot("usage-dark-390");

  // ---------- Files ----------
  await page.locator(".bottom-nav").getByRole("link", { name: "Files", exact: true }).click();
  await page.getByRole("heading", { name: "File reader" }).waitFor();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByText("Please enter a file path").waitFor();
  await page.getByLabel("File path", { exact: true }).fill("/fixture");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await visible(".file-content");
  assert.match(await page.locator(".file-content").textContent(), /Disposable browser fixture/);
  assert.equal(
    requests.filter((r) => r.path === "/admin/read-file").at(-1).auth,
    `Bearer ${TOKEN}`,
    "File reader sends the admin session token",
  );
  await page.getByText("2 lines", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Copy" }).click();
  assert.match(await page.evaluate(() => window.__copied), /status = "ready"/);
  await page.getByRole("button", { name: "/fixture", exact: true }).waitFor();
  await noOverflow("Files 390");
  await screenshot("files-dark-390");
  await page.getByLabel("File path", { exact: true }).fill("/missing");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByText("Fixture file not found").waitFor();

  // ---------- Email ----------
  await page.locator(".bottom-nav").getByRole("link", { name: "Email", exact: true }).click();
  await page.getByRole("heading", { name: "Email studio" }).waitFor();
  await page.getByRole("button", { name: "Send Test Email", exact: true }).click();
  await page.getByText("Please enter a recipient email", { exact: true }).waitFor();
  assert.equal(count("/email/test"), 0);
  await page.getByText("Reminder", { exact: true }).click();
  await page.getByText("Español", { exact: true }).click();
  await page.getByText("Light Mode", { exact: true }).click();
  await page.getByRole("button", { name: "Use my email" }).click();
  await until(
    async () => (await page.getByLabel("Recipient Email", { exact: true }).inputValue()) === "alex@example.test",
    "use my email fills the recipient",
  );
  await page.getByLabel("Recipient Email", { exact: true }).fill("fixture@example.test");
  await page.getByRole("button", { name: "Send Test Email", exact: true }).click();
  await page.getByText("Email sent successfully!", { exact: true }).waitFor();
  assert.ok(
    requests.some(
      (r) =>
        r.path === "/email/test" &&
        r.query.includes("lang=es") &&
        r.query.includes("theme=light") &&
        r.query.includes("type=activation-reminder") &&
        r.query.includes("to=fixture%40example.test"),
    ),
  );
  await noOverflow("Email 390");
  await screenshot("email-dark-390");
  await page.getByRole("button", { name: "Clear activation link" }).click();
  await page.locator(".activation-link__url").waitFor({ state: "hidden" });

  // ---------- Every page: widths, light + dark, axe ----------
  const routes = [
    ["dashboard", ".metric strong"],
    ["users", ".user-card"],
    ["channels/9001", ".credit-usage__progress"],
    ["channels/9003", ".lf-status"],
    ["channels/9001/commands", ".cmd-trigger"],
    ["channels/9001/eventsubs", ".es-row"],
    ["channels/9001/usage", ".usage-transactions li"],
    ["read-tool", ".read-empty, .rt-recent"],
    ["email-test", ".em-form"],
    ["settings", ".st-section"],
  ];
  for (const mode of ["dark", "light"]) {
    await setMode(mode);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: width >= 1280 ? 900 : 844 });
      for (const [route, ready] of routes) {
        await page.goto(`${base}/${route}`);
        await visible("main h1");
        await visible(ready);
        assert.equal(
          await page.evaluate(() => document.documentElement.classList.contains("dark")),
          mode === "dark",
        );
        await noOverflow(`${route} ${mode} ${width}`);
        if (width === 390 || width === 1280) {
          await axe(`${route} ${mode} ${width}`);
          await screenshot(`${route.replaceAll("/", "-")}-${mode}-${width}`);
        }
      }
    }
  }
  await setMode("dark");
  await page.setViewportSize({ width: 390, height: 844 });

  // ---------- Errors keep state ----------
  await page.goto(`${base}/dashboard`);
  await visible(".metric strong");
  failAnalytics = true;
  await page.evaluate(() => window.__analyticsStream.onerror({}));
  await page.getByText("Showing the last available figures. We could not refresh the data.").waitFor();
  assert.equal(await page.locator(".live-figure strong").first().textContent(), "38");
  failAnalytics = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".dashboard-notice").waitFor({ state: "hidden" });
  failUsers = true;
  await page.goto(`${base}/users`);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  failUsers = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await visible(".user-card");

  // ---------- Settings: mode, accent, quick toggle ----------
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.locator("#account-menu").waitFor({ state: "hidden" });
  const card = (name) =>
    page.locator("label.lf-choice").filter({ has: page.getByRole("radio", { name, exact: true }) });
  await card("Light").click();
  await until(() => page.evaluate(() => !document.documentElement.classList.contains("dark")), "light mode");
  for (const accent of ["green", "blue", "cyan", "violet"]) {
    const label = accent[0].toUpperCase() + accent.slice(1);
    await card(`${label} accent`).click();
    await until(() => page.evaluate((a) => document.documentElement.dataset.accent === a, accent), accent);
    assert.equal(await page.evaluate(() => localStorage.getItem("dima-admin.accent.v1")), accent);
    await page.reload();
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    assert.equal(await page.getByRole("radio", { name: `${label} accent`, exact: true }).isChecked(), true, "Accent survives reload");
    assert.equal(await page.getByRole("radio", { name: "Light", exact: true }).isChecked(), true, "Mode survives reload");
    if (accent !== "violet") {
      await axe(`settings light ${accent}`);
      await screenshot(`settings-light-${accent}-390`);
    }
  }
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await until(() => page.evaluate(() => document.documentElement.classList.contains("dark")), "toggle dark");
  assert.equal(await page.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);

  // ---------- Global ranking + race cancellation (201 users) ----------
  rankFixtureMode = true;
  await page.goto(`${base}/users`);
  await visible(".user-identity");
  assert.equal(await page.locator(".user-identity").count(), 100);
  assert.equal(await page.getByText("ranked-top-streamer", { exact: true }).count(), 0);
  await page.getByLabel("Sort by", { exact: true }).selectOption("liveViewers");
  await page.waitForFunction(
    () => document.querySelector(".user-identity strong")?.textContent === "ranked-top-streamer",
  );
  assert.equal(await page.getByLabel("Sort order", { exact: true }).inputValue(), "desc");
  let lastParams = new URLSearchParams(
    requests.filter((r) => r.path === "/admin-site/users").at(-1).query,
  );
  assert.equal(lastParams.get("page"), "1");
  assert.equal(lastParams.get("sortBy"), "liveViewers");
  assert.equal(lastParams.get("sortOrder"), "desc");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 2 of 3", { exact: false }).waitFor();
  await page.getByLabel("Sort order", { exact: true }).selectOption("asc");
  await page.waitForFunction(
    () => document.querySelector(".user-identity strong")?.textContent === "ranked-000",
  );
  await page.getByText("Page 1 of 3", { exact: false }).waitFor();
  await page.getByRole("searchbox").fill("ranked-");
  await visible(".user-identity");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 2 of 3", { exact: false }).waitFor();
  lastParams = new URLSearchParams(
    requests.filter((r) => r.path === "/admin-site/users").at(-1).query,
  );
  assert.equal(lastParams.get("search"), "ranked-");
  assert.equal(lastParams.get("sortBy"), "liveViewers");
  assert.equal(lastParams.get("sortOrder"), "asc");
  // Coming back from a channel restores search, order and page from the URL.
  await page.locator(".user-identity").first().click();
  await page.waitForURL(/\/channels\/\d+$/);
  await page.getByText("No user with this channel ID was found.").waitFor();
  await page.goBack();
  await visible(".user-identity");
  assert.equal(await page.getByRole("searchbox").inputValue(), "ranked-");
  await page.getByText("Page 2 of 3", { exact: false }).waitFor();
  failUsers = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  failUsers = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await visible(".user-identity");
  assert.equal(await page.getByRole("searchbox").inputValue(), "ranked-");
  await page.getByText("Page 2 of 3", { exact: false }).waitFor();
  holdDescending = true;
  await page.getByLabel("Sort order", { exact: true }).selectOption("desc");
  while (!releaseDescending) await new Promise((resolve) => setTimeout(resolve, 10));
  await page.getByLabel("Sort order", { exact: true }).selectOption("asc");
  await page.waitForFunction(
    () => document.querySelector(".user-identity strong")?.textContent === "ranked-000",
  );
  holdDescending = false;
  releaseDescending();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".user-identity strong").first().textContent(),
    "ranked-000",
    "Outdated responses cannot overwrite newer sorting",
  );
  rankFixtureMode = false;

  // ---------- Sign out, login, guard ----------
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("dima-admin.session.v1")), null);
  await axe("login dark 390");
  await screenshot("login-dark-390");
  await page.setViewportSize({ width: 1280, height: 900 });
  await screenshot("login-dark-1280");
  await setMode("light");
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await axe("login light 1280");
  await screenshot("login-light-1280");
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow("Login 320");
  const anonymous = await browser.newContext({
    viewport: { width: 320, height: 700 },
    reducedMotion: "reduce",
  });
  await anonymous.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  const guardPage = await anonymous.newPage();
  await guardPage.goto(`${base}/dashboard`);
  await guardPage.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(new URL(guardPage.url()).pathname, "/login");
  await guardPage.evaluate(() =>
    localStorage.setItem(
      "dima-admin.session.v1",
      JSON.stringify({
        version: 2,
        token: "non-admin-fixture",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: { id: "unlisted-user", display_name: "Fixture" },
        appUser: { twitch_user_id: "unlisted-user" },
      }),
    ),
  );
  await guardPage.goto(`${base}/users`);
  await guardPage.getByRole("heading", { name: "This workspace is private." }).waitFor();
  assert.equal(new URL(guardPage.url()).pathname, "/access-denied");
  await guardPage.screenshot({ path: `${artifacts}/access-denied-320.png`, fullPage: true });
  await anonymous.close();
  assert.deepEqual(failures, [], "No browser errors or unexpected external calls");
  console.log(
    `PASS: admin Live First redesign — overview answers "who needs a hand", users chips/URL state/sorting/race, channel health + confirmed credit grants (cancel/over-limit/25K), commands, Twitch events connect/switch/test retry, usage forecast/filters/load more, file reader auth + recents, email validation, settings mode/accent, axe + no overflow at 320/390/768/1280 in dark and light, sign-out and guard. Screenshots: ${artifacts}`,
  );
} catch (error) {
  console.error({
    url: page.url(),
    failures,
    requests: requests.slice(-8),
    body: (await page.locator("body").innerText().catch(() => "")).slice(0, 2000),
  });
  await screenshot("failure").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
