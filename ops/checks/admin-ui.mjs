/**
 * Mobile/desktop admin behavior check. All APIs and streaming data are mocked;
 * unexpected external requests fail the check. No live credentials are used.
 * Run with SAAS_PREVIEW_URL and, if needed, SAAS_PLAYWRIGHT_MODULE pointing at
 * an installed Playwright module. SAAS_CHROMIUM_PATH may select a local browser.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.SAAS_PLAYWRIGHT_MODULE || "playwright"
);
const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, "SAAS_PREVIEW_URL is required");
const artifacts = process.env.SAAS_UI_ARTIFACTS || "/tmp/admin-ui-check";
await mkdir(artifacts, { recursive: true });
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
  chat_enabled: true,
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
const page2 = [{ ...rows[0], channel: "secondpage", channelID: "9010" }];
let failAnalytics = false;
let failUsers = false;
let rankFixtureMode = false;
let holdDescending = false;
let releaseDescending;
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
await context.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.origin === new URL(base).origin) return route.continue();
  if (url.hostname !== "api.domdimabot.com") {
    failures.push(`Unexpected external request ${url.origin}${url.pathname}`);
    return route.abort();
  }
  requests.push({
    path: url.pathname,
    query: url.searchParams.toString(),
    method: req.method(),
    body: req.postData(),
  });
  const p = url.pathname;
  if (p === "/config/site/analytics")
    return json(
      route,
      failAnalytics ? { error: true } : { data: snapshot },
      failAnalytics ? 503 : 200,
    );
  if (p === "/admin-site/users") {
    if (failUsers) return json(route, { error: true }, 503);
    const search = url.searchParams.get("search");
    if (rankFixtureMode) {
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
          summary: {
            totalChannels: sorted.length,
            activeBots: sorted.length,
            liveChannels: sorted.length,
            liveViewers: 1000000,
          },
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
    return json(route, {
      data: {
        rows: sortRows(filtered, url.searchParams),
        pagination: {
          page: Number(url.searchParams.get("page") || 1),
          limit: 100,
          total: 101,
          totalPages: search ? 1 : 2,
        },
        summary: {
          totalChannels: 101,
          liveChannels: 38,
          activeBots: 85,
          liveViewers: 12480,
        },
      },
    });
  }
  if (p.endsWith("/send-reminder"))
    return json(route, { data: { message: "Mock reminder sent" } });
  if (p.endsWith("/commands"))
    return json(route, {
      data: {
        rows: [
          {
            id: "cmd1",
            name: "Welcome to the channel",
            cmd: "!welcome",
            func: "send_chat_message",
            cooldown: 10,
            userLevelName: "Everyone",
            enabled: true,
          },
        ],
        pagination: { page: 1, totalPages: 1, total: 1 },
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
  if (p.endsWith("/eventsubs"))
    return json(route, {
      data: {
        rows: [
          {
            id: "es1",
            type: "channel.follow",
            version: "2",
            enabled: true,
            status: "enabled",
            created_at: "2026-08-10T12:00:00Z",
          },
        ],
        pagination: { total: 1, totalPages: 1, page: 1 },
      },
    });
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
  if (p.startsWith("/rewards/")) return json(route, { data: { rewards: [] } });
  if (p.startsWith("/triggers/files/"))
    return json(route, { data: { files: [] } });
  if (p.startsWith("/triggers/"))
    return json(route, { data: { triggers: [] } });
  if (p.startsWith("/timers/")) return json(route, { data: { timers: [] } });
  if (p.startsWith("/memories/"))
    return json(route, { data: { memories: [] } });
  if (p === "/admin/read-file")
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
  if (p === "/email/test")
    return json(route, {
      error: false,
      data: { activationLink: "https://example.test/activate?fixture=true" },
    });
  failures.push(`Unmocked API request ${req.method()} ${p}`);
  return route.abort();
});
await context.addInitScript(
  ({ snapshot }) => {
    // The fake session unlocks only the local UI; every remote request is intercepted.
    localStorage.setItem(
      "dima-admin.session.v1",
      JSON.stringify({
        version: 2,
        token: "disposable-ui-fixture",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        twitchUser: {
          id: "533538623",
          login: "admin_fixture",
          display_name: "Alex",
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
  },
  { snapshot },
);
const page = await context.newPage();
page.on("pageerror", (err) => failures.push(err.message));
const visible = async (selector) => {
  await page.locator(selector === ".user-card" ? ".user-identity" : selector).first().waitFor({ state: "visible" });
};
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
  assert.ok(
    overflow.scroll <= overflow.width + 1,
    `${label}: page overflows ${JSON.stringify(overflow)}`,
  );
}
async function screenshot(name) {
  const modal = await page.locator("dialog[open]").count();
  if (!modal) await page.evaluate(() => window.scrollTo(0, 0));
  await settled();
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: !modal });
}
try {
  await page.goto(`${base}/dashboard`);
  await visible(".metrics .metric strong");
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );
  assert.match(await page.locator(".connection").textContent(), /Live updates/);
  assert.equal(await page.locator(".bottom-nav a").count(), 4);
  await noOverflow("Dashboard 390");
  await screenshot("overview-mobile");
  await page.evaluate(() =>
    window.__analyticsStream.onmessage({ data: "{invalid" }),
  );
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );

  await page
    .locator(".bottom-nav")
    .getByRole("link", { name: "Users", exact: true })
    .click();
  await visible(".user-card");
  assert.equal(await page.locator(".user-card").count(), 3);
  await noOverflow("Users 390");
  await screenshot("users-mobile");
  await page.locator(".user-details summary").first().click();
  await page
    .locator(".user-details__body")
    .first()
    .getByRole("button", { name: "Send reminder" })
    .click();
  await visible("dialog[open]");
  assert.ok(
    await page.evaluate(() =>
      document.querySelector("dialog").contains(document.activeElement),
    ),
    "Modal gets focus",
  );
  await screenshot("reminder-mobile");
  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(
    requests.filter((r) => r.path.endsWith("/send-reminder")).length,
    0,
    "Cancelling never sends a reminder",
  );
  await page
    .locator(".user-details__body")
    .first()
    .getByRole("button", { name: "Send reminder" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send reminder", exact: true })
    .click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  assert.equal(
    requests.filter((r) => r.path.endsWith("/send-reminder")).length,
    1,
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("secondpage", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".user-card").count(),
    1,
    "Pagination shows selected page only",
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByText("pixelpilot", { exact: true }).waitFor();
  assert.equal(await page.locator(".user-card").count(), 3);
  await page.getByRole("searchbox").fill("example.test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await visible(".user-identity");
  assert.equal(
    await page.locator(".user-card").count(),
    3,
    "Search keeps all matches",
  );
  await page.getByRole("button", { name: "Clear search" }).click();
  await visible(".user-identity");
  assert.equal(
    await page.locator(".user-card").count(),
    3,
    "Clearing search reloads the full directory",
  );
  await page.getByRole("searchbox").fill("no-match");
  await page.getByRole("heading", { name: "No users found" }).waitFor();
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await page.getByLabel("Sort by", { exact: true }).selectOption("channel");
  await page.getByLabel("Sort order", { exact: true }).selectOption("asc");
  await page.waitForFunction(
    () =>
      document.querySelector(".user-identity strong")?.textContent ===
      "lunastreams",
  );
  assert.match(
    await page.locator(".user-identity strong").first().textContent(),
    /lunastreams/,
  );

  await page.getByRole("link", { name: "Open channel for pixelpilot" }).click();
  await visible(".credit-usage__progress");
  await noOverflow("Channel 390");
  await screenshot("channel-mobile");
  assert.equal(
    await page.getByRole("progressbar").getAttribute("aria-valuenow"),
    "19",
  );
  assert.deepEqual(
    (
      await page
        .locator(".credit-grant-panel__presets button")
        .allTextContents()
    ).map((label) => label.trim()),
    ["+25K", "+200K", "+800K"],
    "credit grant presets must reflect the updated plan ceilings",
  );
  await page.locator('a.stat-clickable[href$="/commands"]').click();
  await page.getByRole("heading", { name: "Channel commands" }).waitFor();
  await page.getByText("!welcome", { exact: true }).waitFor();
  await noOverflow("Commands 390");
  await screenshot("commands-mobile");
  await page.goto(`${base}/channels/9001/eventsubs`);
  await page.getByText("channel.follow", { exact: true }).waitFor();
  await noOverflow("Event subscriptions 390");
  await screenshot("events-mobile");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await visible(".payload-editor");
  await noOverflow("Event editor 390");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page
    .locator(".bottom-nav")
    .getByRole("link", { name: "Files", exact: true })
    .click();
  await page.getByRole("heading", { name: "File reader" }).waitFor();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByText("Please enter a file path").waitFor();
  await page.getByLabel("File Path", { exact: true }).fill("/fixture");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await visible(".file-content");
  assert.match(
    await page.locator(".file-content").textContent(),
    /Disposable browser fixture/,
  );
  await noOverflow("Files 390");
  await screenshot("files-mobile");
  await page.getByLabel("File Path", { exact: true }).fill("/missing");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByText("Fixture file not found").waitFor();

  await page
    .locator(".bottom-nav")
    .getByRole("link", { name: "Email", exact: true })
    .click();
  await page.getByRole("heading", { name: "Email studio" }).waitFor();
  await page
    .getByRole("button", { name: "Send Test Email", exact: true })
    .click();
  await page
    .getByText("Please enter a recipient email", { exact: true })
    .waitFor();
  await page.getByText("Reminder", { exact: true }).click();
  await page.getByText("Español", { exact: true }).click();
  await page.getByText("Light Mode", { exact: true }).click();
  await page
    .getByLabel("Recipient Email", { exact: true })
    .fill("fixture@example.test");
  await page
    .getByRole("button", { name: "Send Test Email", exact: true })
    .click();
  await page.getByText("Email sent successfully!", { exact: true }).waitFor();
  assert.ok(
    requests.some(
      (r) =>
        r.path === "/email/test" &&
        r.query.includes("lang=es") &&
        r.query.includes("theme=light") &&
        r.query.includes("type=activation-reminder"),
    ),
  );
  await noOverflow("Email 390");
  await screenshot("email-mobile");
  await page.getByRole("button", { name: "Clear activation link" }).click();
  await page.locator(".activation-link__url").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".activation-link__url").count(), 0);

  for (const width of [320, 480, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const route of [
      "dashboard",
      "users",
      "channels/9001",
      "channels/9001/commands",
      "channels/9001/eventsubs",
      "read-tool",
      "email-test",
      "settings",
    ]) {
      await page.goto(`${base}/${route}`);
      await visible("main h1");
      if (route === "dashboard") await visible(".metric strong");
      if (route === "users") await visible(".user-card");
      if (route === "channels/9001") await visible(".credit-usage__progress");
      if (route.endsWith("commands"))
        await page.getByText("!welcome", { exact: true }).waitFor();
      if (route.endsWith("eventsubs"))
        await page.getByText("channel.follow", { exact: true }).waitFor();
      await noOverflow(`${route} ${width}`);
      if (width === 1440 || width === 320)
        await screenshot(`${route.replaceAll("/", "-")}-${width}`);
    }
  }
  await page.goto(`${base}/dashboard`);
  await visible(".metric strong");
  failAnalytics = true;
  await page.evaluate(() => window.__analyticsStream.onerror({}));
  await page
    .getByText(
      "Showing the last available figures. We could not refresh the data.",
    )
    .waitFor();
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );
  failAnalytics = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".dashboard-notice").waitFor({ state: "hidden" });
  failUsers = true;
  await page.goto(`${base}/users`);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  failUsers = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await visible(".user-card");

  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.locator("#account-menu").waitFor({ state: "hidden" });
  const accents = {
    green: "#d3f892",
    purple: "#cfb2ff",
    blue: "#9fc8ff",
    cyan: "#89e4ed",
  };
  for (const [theme, accent] of Object.entries(accents).sort(([a], [b]) => (a === 'green' ? 1 : b === 'green' ? -1 : 0))) {
    const label = theme[0].toUpperCase() + theme.slice(1);
    await page.locator(".theme-option").filter({ has: page.getByRole("radio", { name: `${label} theme`, exact: true }) }).click();
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.adminTheme === theme,
      theme,
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim(),
      ),
      accent,
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("dima-admin.theme.v1")),
      theme,
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("radio", { name: `${label} theme`, exact: true })
        .isChecked(),
      true,
      "Preference survives reload",
    );
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
      await noOverflow(`Settings ${theme} ${width}`);
      await screenshot(`settings-${theme}-${width}`);
      await page.goto(`${base}/dashboard`);
      await visible(".metric strong");
      await noOverflow(`Dashboard ${theme} ${width}`);
      await screenshot(`dashboard-${theme}-${width}`);
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.adminTheme),
        theme,
      );
      await page.goto(`${base}/settings`);
      await page
        .getByRole("heading", { name: "Settings", exact: true })
        .waitFor();
    }
  }
  // A previously unseen streamer on page three must become the first result.
  rankFixtureMode = true;
  await page.goto(`${base}/users`);
  await visible(".user-identity");
  assert.equal(await page.locator(".user-identity").count(), 100);
  assert.equal(
    await page.getByText("ranked-top-streamer", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Sort by", { exact: true }).selectOption("liveViewers");
  await page.waitForFunction(
    () =>
      document.querySelector(".user-identity strong")?.textContent ===
      "ranked-top-streamer",
  );
  assert.equal(
    await page.getByLabel("Sort order", { exact: true }).inputValue(),
    "desc",
  );
  assert.equal(await page.locator(".user-identity").count(), 100);
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
    () =>
      document.querySelector(".user-identity strong")?.textContent ===
      "ranked-000",
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
  failUsers = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  failUsers = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await visible(".user-identity");
  assert.equal(await page.getByRole("searchbox").inputValue(), "ranked-");
  await page.getByText("Page 2 of 3", { exact: false }).waitFor();
  // Hold an older response while the operator changes the ordering again.
  holdDescending = true;
  await page.getByLabel("Sort order", { exact: true }).selectOption("desc");
  while (!releaseDescending)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await page.getByLabel("Sort order", { exact: true }).selectOption("asc");
  await page.waitForFunction(
    () =>
      document.querySelector(".user-identity strong")?.textContent ===
      "ranked-000",
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
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("dima-admin.session.v1")),
    null,
  );
  await screenshot("login-desktop");
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow("Login 320");
  await screenshot("login-320");
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
  await guardPage
    .getByRole("heading", { name: "This workspace is private." })
    .waitFor();
  assert.equal(new URL(guardPage.url()).pathname, "/access-denied");
  await guardPage.screenshot({
    path: `${artifacts}/access-denied-mobile.png`,
    fullPage: true,
  });
  await anonymous.close();
  assert.deepEqual(
    failures,
    [],
    "No browser errors or unexpected external calls",
  );
  console.log(
    `PASS: admin layouts at 320/390/480/768/1440px; four persistent themes, profile settings, global sorting with 201 users, race cancellation, search/pagination, channel navigation, modals, file/email mocks, errors and sign-out. Screenshots: ${artifacts}`,
  );
} catch (error) {
  console.error({
    url: page.url(),
    failures,
    requests: requests.slice(-8),
    body: (await page.locator("body").innerText()).slice(0, 2000),
  });
  await screenshot("failure");
  throw error;
} finally {
  await browser.close();
}
