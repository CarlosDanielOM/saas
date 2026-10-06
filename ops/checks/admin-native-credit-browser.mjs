/**
 * Admin AI credit usage: native Polar credit grants in reporting. Every API
 * call is mocked and every other remote request is aborted, so no grant,
 * payment, chat message or live API read can happen. No live credentials.
 *
 * Covers: granted totals + per-type breakdown, "Permanent/Period credits
 * granted" rows instead of raw operations, positive adjustments shown as
 * debits (never "+"), credit-activity copy/filters/empty state, pending
 * credit-history sync notice, no inferred gift buyer, axe + no overflow at
 * 320/390/1280 in dark and light.
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
const artifacts = process.env.SAAS_UI_ARTIFACTS || "/tmp/admin-native-credit-check";
await mkdir(artifacts, { recursive: true });

// Production builds call api.domdimabot.com, development previews localhost:3000.
const API_ORIGINS = new Set(["https://api.domdimabot.com", "http://localhost:3000"]);
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
const json = (route, data, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

let mode = "pending";
const summary = () => ({
  planTier: "pro",
  credits: {
    version: 1,
    used: 37500,
    limit: 260000,
    balance: 222500,
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
  ledger:
    mode === "pending"
      ? { status: "pending", coverageStart: "2026-09-28T00:00:00.000Z", lastSyncedAt: "2026-10-02T10:15:00.000Z" }
      : { status: "ready", coverageStart: "2026-09-20T00:00:00.000Z", lastSyncedAt: "2026-10-02T10:15:00.000Z" },
  pacing: {
    status: "within_pace",
    averageDailyCredits: 2900,
    projectedPeriodCredits: 87000,
    remainingPeriodDays: 17,
    expectedToExhaustWithinPeriod: false,
    estimatedDaysUntilExhaustion: null,
  },
  analytics: {
    itemizationStartedAt: "2026-09-18T19:30:00.000Z",
    totalSpentCredits: mode === "pending" ? 117000 : 3800,
    averageDailySpentCredits: mode === "pending" ? 9000 : 292,
    grantedCredits: 65000,
    adjustmentDebitedCredits: 1200,
    netConsumedCredits: mode === "pending" ? 53200 : -60000,
    transactionCount: 26,
    daily: Array.from({ length: 13 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10),
      credits: 4000 + ((i * 3137) % 9000),
      transactionCount: 2,
    })),
    categories: [
      { category: "tts", credits: 70000, transactionCount: 13, percentage: 60 },
      { category: "ai_chat", credits: 47000, transactionCount: 13, percentage: 40 },
    ],
    adjustments: [
      { type: "correction", grantedCredits: 0, debitedCredits: 1200, transactionCount: 1 },
      { type: "manual_grant", grantedCredits: 5000, debitedCredits: 0, transactionCount: 1 },
      { type: "native_grant", grantedCredits: 60000, debitedCredits: 0, transactionCount: 2 },
    ],
  },
});
const adjustment = (id, at, extra) => ({
  id,
  occurredAt: at,
  entryKind: "adjustment",
  category: "credit_adjustment",
  provider: "polar",
  model: null,
  quantity: null,
  unit: null,
  ...extra,
});
const transactions = [
  adjustment("polar-credit:6f1c2d3e-0000-4000-8000-000000000001", "2026-10-02T15:00:00.000Z", {
    operation: "permanent_credit_grant",
    source: "polar_meter_credit",
    adjustmentType: "native_grant",
    credits: -40000,
  }),
  adjustment("polar-credit:6f1c2d3e-0000-4000-8000-000000000002", "2026-10-02T14:00:00.000Z", {
    operation: "period_credit_grant",
    source: "polar_meter_credit",
    adjustmentType: "native_grant",
    credits: -20000,
  }),
  adjustment("adm-grant-1", "2026-10-02T13:00:00.000Z", {
    operation: "grant",
    source: "admin_credit_grant",
    adjustmentType: "manual_grant",
    credits: -5000,
  }),
  // A positive adjustment removes credits: it must read as a debit.
  adjustment("adm-correction-1", "2026-10-02T12:30:00.000Z", {
    operation: "correction",
    source: "admin_correction",
    adjustmentType: "correction",
    credits: 1200,
  }),
  ...Array.from({ length: 26 }, (_, i) => ({
    id: `tx${i}`,
    occurredAt: new Date(Date.UTC(2026, 9, 2, 12, 0) - i * 3600000).toISOString(),
    entryKind: "usage",
    category: i % 2 ? "ai_chat" : "tts",
    operation: i % 2 ? "chat_reply" : "synthesize",
    source: i % 2 ? "chat" : "tts",
    adjustmentType: null,
    provider: "fixture",
    model: i % 2 ? "fixture-model" : null,
    quantity: null,
    unit: null,
    credits: 120 + i,
  })),
];

await context.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.origin === new URL(base).origin) return route.continue();
  if (!API_ORIGINS.has(url.origin)) {
    // Fonts are cosmetic; abort them too so nothing leaves the host.
    if (!["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname))
      failures.push(`Unexpected external request ${url.origin}${url.pathname}`);
    return route.abort();
  }
  const p = url.pathname;
  requests.push({ method: req.method(), path: p, query: url.searchParams.toString() });
  if (req.method() !== "GET") {
    failures.push(`Unexpected ${req.method()} ${p}`);
    return route.abort();
  }
  if (p === "/admin-site/users")
    return json(route, {
      data: {
        rows: [{ channel: "pixelpilot", channelID: "9001", plan_tier: "pro" }],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      },
    });
  if (p === "/users") return json(route, { data: {} });
  if (p === "/admin-site/users/9001/ai-usage/summary")
    return json(route, { error: false, message: "ok", status: 200, data: summary() });
  if (p === "/admin-site/users/9001/ai-usage/transactions") {
    const category = url.searchParams.get("category");
    const cursor = Number(url.searchParams.get("cursor") || 0);
    const list = transactions.filter((t) => !category || t.category === category);
    return json(route, {
      error: false,
      message: "ok",
      status: 200,
      data: {
        items: list.slice(cursor, cursor + 25),
        nextCursor: cursor + 25 < list.length ? String(cursor + 25) : null,
      },
    });
  }
  failures.push(`Unmocked API request GET ${p}`);
  return route.abort();
});
await context.addInitScript(() => {
  // The fake session unlocks only the local UI; every remote request is intercepted.
  localStorage.setItem(
    "dima-admin.session.v1",
    JSON.stringify({
      version: 2,
      token: "disposable-ui-fixture",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      twitchUser: { id: "533538623", login: "admin_fixture", display_name: "Alex", email: "alex@example.test" },
      appUser: { twitch_user_id: "533538623", name: "admin_fixture", plan_tier: "free" },
    }),
  );
  window.EventSource = class {
    close() {}
  };
});
const page = await context.newPage();
page.on("pageerror", (err) => failures.push(err.message));
const rows = page.locator(".usage-transactions > li");
const row = (title) => rows.filter({ has: page.locator(".lf-row__title", { hasText: title }) });
async function until(fn, label, timeout = 4000) {
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
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  });
}
async function noOverflow(label) {
  await settled();
  const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  assert.ok(o.scroll <= o.width + 1, `${label}: page overflows ${JSON.stringify(o)}`);
}
async function axe(label) {
  await settled();
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() =>
    window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }),
  );
  assert.deepEqual(
    result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target).slice(0, 4) })),
    [],
    `axe ${label}`,
  );
}
async function open() {
  await page.goto(`${base}/channels/9001/usage`);
  await page.getByRole("heading", { name: "Credit activity" }).waitFor();
  await until(async () => (await rows.count()) > 0, "activity rows");
}

try {
  await open();

  // Granted totals are visible next to spending.
  const granted = page.locator(".lf-metric").filter({ hasText: "Granted this period" });
  assert.equal((await granted.locator(".lf-metric__value").textContent()).trim(), "+65K");
  await granted.getByText("53.2K net used").waitFor();
  await page.locator(".lf-metric").filter({ hasText: "Spent this period" }).getByText("26 charges").waitFor();

  // Per-type breakdown: grants add, corrections remove (never "+").
  const grants = page.locator(".usage-grants");
  await grants.getByRole("heading", { name: "Grants & adjustments" }).waitFor();
  const group = (name) => grants.locator(".usage-adjustment").filter({ hasText: name });
  assert.equal((await group("Granted in Polar").locator(".us-amount").textContent()).trim(), "+60,000");
  assert.equal((await group("Admin grants").locator(".us-amount").textContent()).trim(), "+5,000");
  assert.equal((await group("Corrections").locator(".us-amount").textContent()).trim(), "−1,200");
  await group("Granted in Polar").getByText("2 entries").waitFor();
  assert.equal(
    (await grants.locator(".us-grants__name > span").first().textContent()).trim(),
    "Granted in Polar",
    "largest adjustment first",
  );
  await grants.getByText("credits carry over until used", { exact: false }).waitFor();
  await grants.getByText("don't record who paid or why", { exact: false }).waitFor();

  // Rows read as what happened, raw operation secondary.
  const permanent = row("Permanent credits granted");
  assert.equal(await permanent.count(), 1);
  assert.equal((await permanent.locator(".us-amount").textContent()).trim(), "+40,000");
  await permanent.getByText("Polar · carries over until used").waitFor();
  assert.equal((await permanent.locator("code.us-raw").textContent()).trim(), "permanent_credit_grant");
  const period = row("Period credits granted");
  assert.equal((await period.locator(".us-amount").textContent()).trim(), "+20,000");
  await period.getByText("Polar · ends at the period reset").waitFor();
  const admin = row("Admin credit grant");
  assert.equal((await admin.locator(".us-amount").textContent()).trim(), "+5,000");
  await admin.getByText("Added to balance").waitFor();
  const correction = row("Balance correction");
  assert.equal((await correction.locator(".us-amount").textContent()).trim(), "−1,200");
  assert.equal(await correction.locator(".us-amount.is-credit").count(), 0, "debit is not green");
  await correction.getByText("Removed from balance").waitFor();
  const usage = row("AI chat").first();
  assert.match((await usage.locator(".us-amount").textContent()).trim(), /^−\d/);
  await usage.getByText("chat_reply · fixture-model").waitFor();
  const titles = await rows.locator(".lf-row__title").allTextContents();
  assert.ok(!titles.some((t) => /_|^(grant|correction)$/.test(t.trim())), `raw titles: ${titles}`);

  // No gift buyer or order is ever inferred.
  const text = await page.locator("main").innerText();
  assert.ok(!/gift(ed)? (from|by)|bought by|purchased by|buyer/i.test(text), "no inferred gift buyer");
  assert.ok(!text.includes("Every charge"));

  // Pending sync covers credit history, not just old usage.
  await page.locator(".lf-chip--warn", { hasText: "Credit history still syncing" }).waitFor();
  const sync = page.locator(".usage-sync");
  await sync.getByText("older usage and Polar credit grants", { exact: false }).waitFor();
  await sync.getByText("Last synced", { exact: false }).waitFor();
  assert.equal(await sync.getAttribute("role"), "status");

  // Filters, load more and empty copy include grants.
  const filters = page.getByRole("group", { name: "Filter credit activity by category" });
  await page.getByRole("button", { name: "Load more" }).click();
  await until(async () => (await rows.count()) === 30, "load more");
  await filters.getByRole("button", { name: "Grants & adjustments" }).click();
  await until(async () => (await rows.count()) === 4, "grants filter");
  assert.equal(
    requests.filter((r) => r.path.endsWith("/transactions") && r.query.includes("category=credit_adjustment")).length,
    1,
  );
  await filters.getByRole("button", { name: "Memory" }).click();
  await page.getByText("Nothing in this category for these dates.").waitFor();
  await filters.getByRole("button", { name: "All" }).click();
  await until(async () => (await rows.count()) === 25, "all again");

  // Ready ledger + more granted than used.
  mode = "ready";
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.locator(".lf-metric").filter({ hasText: "60K more granted than used" }).waitFor();
  await until(async () => (await page.locator(".usage-sync").count()) === 0, "sync notice gone");
  assert.equal(await page.getByText("Credit history still syncing").count(), 0);
  mode = "pending";

  for (const theme of ["dark", "light"]) {
    await page.evaluate((m) => localStorage.setItem("dima-admin.mode.v1", m), theme);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width >= 1280 ? 900 : 844 });
      await open();
      await page.locator(".usage-grants").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
      await noOverflow(`usage ${theme} ${width}`);
      await axe(`usage ${theme} ${width}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${artifacts}/usage-${theme}-${width}.png`, fullPage: true });
    }
  }

  assert.ok(requests.every((r) => r.method === "GET"), "read-only API traffic");
  assert.deepEqual(failures, []);
  console.log(
    `PASS: admin native credit grants — granted totals/breakdown, Permanent/Period rows, debits never "+", credit-activity filters/empty, pending credit-history notice, no gift-buyer inference, axe + no overflow at 320/390/1280 dark/light. Screenshots: ${artifacts}`,
  );
} catch (error) {
  console.error(error);
  if (failures.length) console.error("Failures:", failures);
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
