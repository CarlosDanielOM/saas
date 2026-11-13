/**
 * Admin site full regression check (the console with five tabs: Overview, Activity, AI, Users, System).
 * Every API call is mocked on both api.domdimabot.com (built bundle) and localhost:3000 (dev server);
 * unexpected external requests fail the check, so no reminder, email, credit grant or EventSub change
 * can reach production. No live credentials are used. The newer console pages (Activity, AI hub, usage
 * explorer, decisions, assistant, docs AI) are covered here at smoke level only (load, h1, lit tab,
 * overflow + axe); their behaviour lives in ops/checks/admin-console-*-browser.mjs.
 *
 * Env: SAAS_PREVIEW_URL (default http://127.0.0.1:4310), SAAS_PLAYWRIGHT_MODULE / PLAYWRIGHT_MODULE,
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
const base = process.env.SAAS_PREVIEW_URL || "http://127.0.0.1:4310";
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
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};
const json = (route, data, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify(data),
  });
// The built bundle calls api.domdimabot.com; the dev server calls localhost:3000.
const isApi = (url) =>
  url.hostname === "api.domdimabot.com" ||
  (["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "3000");
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

// ---------- Console fixtures (fictional names; shapes follow admin/src/app/services/*-api.service.ts) ----------
// The newer console pages are smoke-tested here; their detailed fixtures live in ops/checks/admin-console-*-browser.mjs.
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const isoDay = (back) => new Date(NOW - back * 86_400_000).toISOString().slice(0, 10);
const fixtureViewer = { id: "800000001", login: "mossy_fern", name: "Mossy_Fern" };
const feedItem = (minutes, extra) => ({
  id: `f${minutes}`, at: ago(minutes), outcome: "ok", reason: null, channelID: "9001", channel: "pixelpilot", actor: fixtureViewer,
  text: null, credits: null, providerUSD: null, durationMs: null, data: {}, ref: null, ...extra,
});
const feedItems = [
  feedItem(1, { kind: "command", name: "!welcome", text: "!welcome", data: { func: "send_chat_message", trigger: "chat" } }),
  feedItem(2, { kind: "bot_message", name: "command", actor: null, text: "Welcome in, Mossy_Fern! Grab a drink.", data: { origin: "command" } }),
  feedItem(3, { kind: "twitch_event", name: "channel.follow" }),
  feedItem(4, { kind: "alert", name: "channel.follow", outcome: "skipped", reason: "alert_disabled", data: { event: "channel.follow" } }),
  feedItem(9, { kind: "voice", name: "fish", outcome: "failed", reason: "synthesis_failed", credits: 0, data: { provider: "fish", chars: 212 } }),
];
const feedKinds = [
  { kind: "command", total: 412, problems: 31, failed: 2 },
  { kind: "bot_message", total: 506, problems: 4, failed: 1 },
  { kind: "twitch_event", total: 58, problems: 0, failed: 0 },
  { kind: "alert", total: 40, problems: 9, failed: 0 },
  { kind: "voice", total: 128, problems: 5, failed: 3 },
];
const overviewData = {
  generatedAt: ago(0),
  day: { from: ago(1440), to: ago(0), kinds: feedKinds, activeChannels: 38, credits: 131400, providerUSD: 0.4312 },
  daily: Array.from({ length: 14 }, (_, i) => ({ date: isoDay(13 - i), events: 4200 + ((i * 937) % 2600), problems: 60 + ((i * 53) % 140), credits: 96000 + ((i * 17123) % 70000), providerUSD: 0.3 })),
  features: [
    { feature: "voice", count: 7420, failed: 31, credits: 742300, providerUSD: null },
    { feature: "memory", count: 310, failed: 0, credits: 88100, providerUSD: 0.881 },
    { feature: "ai_chat", count: 188, failed: 2, credits: 20400, providerUSD: 0.204 },
  ],
  topChannels: [{ channelID: "9001", channel: "pixelpilot", events: 2140, problems: 31, credits: 61200 }],
  attention: [{ key: "verdicts_waiting", count: 12 }],
  recent: feedItems,
  partial: [],
};
const tally = (count, credits, providerUSD = 0, providerKnown = 0) => ({ count, credits, providerUSD, providerKnown });
const consoleUsageSummary = (params) => {
  const from = params.get("from") || ago(10080);
  const days = Math.max(1, Math.round((NOW - new Date(from).getTime()) / 86_400_000));
  return {
    from, to: ago(0), totals: { ...tally(7918, 850800, 1.085, 430), channels: 3, chatters: 2, withActor: 600 }, granted: 25000,
    byCategory: [{ category: "tts", ...tally(7420, 742300) }, { category: "memory", ...tally(310, 88100, 0.881, 310) }, { category: "ai_chat", ...tally(188, 20400, 0.204, 120) }],
    byModel: [{ category: "tts", provider: "fish", model: null, ...tally(7420, 742300) }, { category: "ai_chat", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", ...tally(188, 20400, 0.204, 120) }],
    bySource: [{ category: "tts", source: "ast", ...tally(7420, 742300) }, { category: "ai_chat", source: "chat", ...tally(188, 20400, 0.204, 120) }],
    byChannel: rows.map((r, i) => ({ channelID: r.channelID, channel: r.channel, planTier: r.plan_tier, ...tally(3000 / (i + 1), 300000 / (i + 1)) })),
    byActor: [{ actor: fixtureViewer, ...tally(400, 40000) }],
    daily: Array.from({ length: days }, (_, i) => ({ date: isoDay(days - 1 - i), count: 900 + ((i * 377) % 700), credits: 90000 + ((i * 37123) % 70000), providerUSD: 0.1 })),
  };
};
const consoleUsageRows = Array.from({ length: 6 }, (_, i) => ({
  id: `rcpt-${i}`, at: ago(3 + i * 7), channelID: "9001", channel: "pixelpilot", entryKind: "usage", category: i % 2 ? "ai_chat" : "tts",
  operation: i % 2 ? "final_response" : "synthesize", source: i % 2 ? "chat" : "ast", adjustmentType: null, provider: i % 2 ? "openrouter" : "fish",
  model: i % 2 ? "deepseek/deepseek-v4.1-flash" : null, voice: i % 2 ? null : "Dora", quantity: 40 + i, unit: i % 2 ? "tokens" : "characters",
  credits: 60 + i, providerUSD: i % 2 ? 0.0003 : null, actor: fixtureViewer,
}));
const decisionRow = (id, minutes, extra) => ({
  id, at: ago(minutes), channelID: "9001", channel: "pixelpilot", kind: "ai", ruleType: "builtin", ruleReason: null, source: "first_message", messageOrdinal: 1,
  verdict: "allow", status: "completed", outcome: "allowed", action: null, actionError: null, model: "openai/gpt-6-luna-decisions", provider: "openai",
  scores: { self_promotion: 0.03, safe: 0.97, violation: 0.03 }, thresholdPercent: 85, inputTokens: 412, providerUSD: 0.00018, credits: 0, included: true,
  latencyMs: 610, nearMiss: false, feedback: null, chatter: { id: "81004", login: "speedrunsam", name: "SpeedrunSam" }, messageText: "gg that was a clean run", ...extra,
});
const decisionRows = [
  decisionRow("d1", 12, { chatter: { id: "81001", login: "pixelpeddler", name: "PixelPeddler" }, messageText: "Get cheap viewers at boostr dot shop!!", verdict: "violation", outcome: "acted", action: "ban", scores: { ads: 0.972, spam: 0.62, safe: 0.02, violation: 0.972 } }),
  decisionRow("d2", 200, {}),
];
const decisionSummary = () => ({
  from: ago(10080), to: ago(0), total: 640, aiReviews: 585, ruleHits: 55, violations: 14, bans: 4, bansFailed: 1, notReviewed: 9, included: 520,
  providerUSD: 0.0931, credits: 6500, latencyP50Ms: 820, latencyP95Ms: 2400, channels: 21, labelled: 30, agree: 27, disagree: 3, verdictsWaiting: 12,
  daily: Array.from({ length: 7 }, (_, i) => ({ date: isoDay(6 - i), reviews: 80 + i, violations: i % 2, notReviewed: 1, providerUSD: 0.012 })),
  byModel: [{ model: "openai/gpt-6-luna-decisions", reviews: 585, violations: 14, bans: 4, notReviewed: 9, providerUSD: 0.0931, latencyP50Ms: 820 }],
  byChannel: [{ channelID: "9001", channel: "pixelpilot", reviews: 310, violations: 3, providerUSD: 0.05 }],
});
const assistantDays = (params, fill) => {
  const n = Math.max(1, Math.round((NOW - Date.parse(params.get("from") || ago(43200))) / 86_400_000) + 1);
  return Array.from({ length: n }, (_, i) => ({ date: isoDay(n - 1 - i), ...fill(i === n - 1) }));
};
const assistantSummaryData = (params) => ({
  from: params.get("from") || ago(43200), to: ago(0),
  daily: assistantDays(params, (last) => ({ turns: last ? 7 : 0, completed: last ? 6 : 0, failed: last ? 1 : 0, cancelled: 0, steps: 0, toolCalls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, providerUSD: last ? 0.07 : 0, helpful: 0, unhelpful: 0 })),
  totals: { turns: 56, completed: 54, failed: 1, cancelled: 1, steps: 140, toolCalls: 88, promptTokens: 520000, cachedTokens: 340000, completionTokens: 21000, providerUSD: 0.58, helpful: 3, unhelpful: 1, channels: 2, people: 2 },
  byLevel: [{ level: "standard", turns: 56, failed: 1, providerUSD: 0.58, avgDurationMs: 6900 }],
  byModel: [{ model: "openai/gpt-6-luna", turns: 56, providerUSD: 0.58 }],
  byChannel: [{ channelID: "9001", channel: "pixelpilot", plan: "pro", turns: 56, failed: 1, cancelled: 1, units: 60, providerUSD: 0.58, lastAt: ago(4) }],
  byTool: [{ name: "navigate", calls: 31, failed: 0 }], errors: [{ code: "model_timeout", count: 1, lastAt: ago(38) }],
  refusals: { week: 1, total: 2 }, limitsToday: [{ channelID: "9001", channel: "pixelpilot", used: 40, limit: 400 }], recordsSince: ago(7200),
});
const assistantTurn = {
  id: "t1", at: ago(4), channelID: "9001", channel: "pixelpilot", user: { id: "810000001", login: "mia_torres", name: "Mia Torres", role: "owner" },
  plan: "pro", level: "standard", fellBack: false, models: ["openai/gpt-6-luna"], status: "completed", errorCode: null, lang: "en", pageRoute: "/pixelpilot/dashboard",
  steps: 2, question: "How do I make a !hug command?", tools: [{ name: "navigate", state: "done", ms: 30, approval: null }], units: 1,
  promptTokens: 9400, cachedTokens: 6100, completionTokens: 380, providerUSD: 0.0091, durationMs: 6400, activeMs: 6100, feedback: null,
};
const docsSummaryData = (params) => ({
  from: params.get("from") || ago(43200), to: ago(0),
  daily: assistantDays(params, (last) => ({ asked: last ? 12 : 0, answered: last ? 11 : 0, failed: last ? 1 : 0, abandoned: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, providerUSD: last ? 0.11 : 0, helpful: last ? 2 : 0, unhelpful: 0 })),
  totals: { asked: 12, answered: 11, failed: 1, abandoned: 0, toolCalls: 20, inputTokens: 40000, outputTokens: 3000, providerUSD: 0.112, helpful: 2, unhelpful: 0 },
  failures: [{ reason: "timeout", count: 1 }], byLang: [{ lang: "en", answers: 11 }], topPages: [{ page: "/en/commands/", answers: 7 }], medianDurationMs: 5900,
});
const docsAnswer = {
  id: "a1", at: ago(12), lang: "en", page: "/en/commands/", turn: 1, question: "How do I add a cooldown to a command?", answer: "Open **Commands**, edit the command and set *Cooldown*.",
  sources: ["https://docs.domdimabot.com/en/commands/cooldowns/"], tools: ["search_docs"], rounds: 1, durationMs: 5200, inputTokens: 4100, outputTokens: 310,
  providerUSD: 0.0098, stopReason: "end_turn", feedback: "helpful", failed: null,
};
const reviewChat = [{ username: "pixelpilot", message: "welcome in everyone", isBroadcaster: true }, { username: "mossy_fern", message: "hi hi", isBroadcaster: false }];
const reviewRow = {
  messageText: "Best viewers with streamboo .com", invited: false, label: null, reviewedAt: null, ids: ["r1"], count: 1, more: 0, channels: 1, withoutContext: 0,
  contexts: [{ copies: 1, channel: "pixelpilot", lines: reviewChat }],
  latest: {
    id: "r1", channelID: "9001", channel: "pixelpilot", username: "viewer_1", createdAt: ago(60), model: "openai/gpt-6-luna-decisions", verdict: "uncertain",
    status: "uncertain", reviewSource: "first_message", messageOrdinal: 1, consequence: { status: "allowed_fallback", action: null, success: null },
    thresholdPercent: 85, categories: ["spam", "ads", "self_promotion"], scores: { spam: 0.64, ads: 0.7, self_promotion: 0.02, safe: 0.73, violation: 0.7 },
  },
};
const refusalRow = {
  id: "rf1", at: ago(60), channelId: "9001", channelLogin: "pixelpilot", userId: "9001", userLogin: "pixelpilot", sessionId: "s1", turnId: "t1", step: 0,
  plan: "pro", level: "expert", model: "anthropic/claude-haiku-5.5", fallbackModel: "openai/gpt-6-luna", source: "reply", finishReason: "content_filter",
  nativeFinishReason: "refusal", refusal: "I can’t help with that.", detail: null, message: "Make a !kill command that says the viewer got eliminated",
  steers: [], partial: "Sure, here is a", recent: [{ role: "user", text: "Make a !kill command that says the viewer got eliminated" }],
};
// Channel workspace debugging data for pixelpilot (9001).
const commandStatsData = (channelID) => ({
  from: ago(10080), to: ago(0), recordsSince: channelID === "9001" ? ago(12960) : null,
  commands: channelID === "9001" ? [
    { name: "!welcome", runs: 40, ok: 38, skipped: 2, blocked: 0, failed: 0, lastAt: ago(5), lastOutcome: "ok", lastReason: null, reasons: [{ reason: "cooldown", count: 2 }] },
  ] : [],
});
const eventsubActivityData = (channelID) => (channelID === "9001" ? {
  types: [{ type: "channel.follow", lastReceivedAt: ago(120), received7d: 14, lastAlert: { at: ago(120), outcome: "ok", reason: null }, failedDeliveries: 0 }],
  revoked: [],
} : { types: [], revoked: [] });
const logEntries = [
  { id: "log1", at: ago(7), level: "error", function: "redemptionHandler", message: "Twitch refused to update the redemption status: 403 Forbidden", data: { httpStatus: 403 } },
  { id: "log2", at: ago(48), level: "warn", function: "ttsQueue", message: "Voice request skipped: the channel has no credits left", data: { queueLength: 2 } },
];

await context.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.origin === new URL(base).origin) return route.continue();
  // Read-only font downloads so screenshots match production typography.
  if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname))
    return req.method() === "GET" ? route.continue().catch(() => {}) : route.abort();
  if (!isApi(url)) {
    failures.push(`Unexpected external request ${url.origin}${url.pathname}`);
    return route.abort();
  }
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  requests.push({
    path: url.pathname,
    query: url.searchParams.toString(),
    method: req.method(),
    body: req.postData(),
    auth: req.headers()["authorization"] || null,
  });
  const p = url.pathname;
  const m = req.method();
  // ---- Console endpoints (overview, feed, AI pages, channel debugging) ----
  if (m === "GET" && p === "/admin-site/overview") return json(route, { error: false, data: overviewData });
  if (m === "GET" && p === "/admin-site/feed/summary")
    return json(route, { error: false, data: { from: ago(1440), to: ago(0), kinds: url.searchParams.get("channel") === "9001" || !url.searchParams.get("channel") ? feedKinds : [], partial: [] } });
  if (m === "GET" && p === "/admin-site/feed") {
    const kinds = (url.searchParams.get("kinds") || "").split(",").filter(Boolean);
    const channel = url.searchParams.get("channel");
    const items = feedItems.filter((it) => (!kinds.length || kinds.includes(it.kind)) && (!channel || it.channelID === channel));
    return json(route, { error: false, data: { items, nextCursor: null, partial: [] } });
  }
  if (m === "GET" && p === "/admin-site/usage/summary") return json(route, { error: false, data: consoleUsageSummary(url.searchParams) });
  if (m === "GET" && p === "/admin-site/usage/transactions") return json(route, { error: false, data: { items: consoleUsageRows, nextCursor: null } });
  if (m === "GET" && p === "/admin-site/decisions/summary") return json(route, { error: false, data: decisionSummary() });
  if (m === "GET" && p === "/admin-site/decisions")
    return json(route, { error: false, data: { rows: decisionRows, pagination: { page: 1, limit: 25, total: decisionRows.length, totalPages: 1 } } });
  if (m === "GET" && p === "/admin-site/assistant/summary") return json(route, { error: false, data: assistantSummaryData(url.searchParams) });
  if (m === "GET" && p === "/admin-site/assistant/turns")
    return json(route, { error: false, data: { rows: [assistantTurn], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } } });
  if (m === "GET" && p === "/admin-site/docs-assistant/summary") return json(route, { error: false, data: docsSummaryData(url.searchParams) });
  if (m === "GET" && p === "/admin-site/docs-assistant/answers")
    return json(route, { error: false, data: { rows: [docsAnswer], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } } });
  if (m === "GET" && p === "/admin-site/moderation-reviews") {
    const pending = url.searchParams.get("state") !== "reviewed" && url.searchParams.get("kind") === "near_miss";
    return json(route, { data: { rows: pending ? [reviewRow] : [], pagination: { page: 1, limit: 20, total: pending ? 1 : 0, totalPages: 1 }, counts: { contradiction: 0, near_miss: 1, ban: 0 } } });
  }
  if (m === "GET" && p === "/admin-site/assistant-refusals")
    return json(route, { data: { rows: [refusalRow], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }, counts: { week: 1, total: 1 } } });
  {
    const debug = p.match(/^\/admin-site\/users\/(\d+)\/(command-stats|eventsub-activity|logs)$/);
    if (m === "GET" && debug) {
      const [, id, what] = debug;
      if (what === "command-stats") return json(route, { error: false, data: commandStatsData(id) });
      if (what === "eventsub-activity") return json(route, { error: false, data: eventsubActivityData(id) });
      const level = url.searchParams.get("level");
      const entries = id === "9001" ? logEntries.filter((e) => !level || e.level === level) : [];
      return json(route, { error: false, data: { entries, truncated: false, counts: { debug: 0, info: 0, warn: 1, error: 1, fatal: 0 } } });
    }
  }
  if (p.endsWith('/pet-diagnostics')) return json(route, { data: {
    observedAt: new Date().toISOString(), configured: false, enabled: false, appearance: null, playbackTarget: null,
    vts: { selectedSessionId: null, session: null, connected: false, reportedReady: false, ready: false,
      projection: { status: 'missing', lastValidatedAt: null, expiresAt: null } },
    audio: { selectedSessionId: null, session: null, connected: false, reportedReady: false, ready: false }, failures: []
  } });
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
let page = await context.newPage();
page.on("pageerror", (err) => failures.push(err.message));
/** A fresh tab: the page matrix makes hundreds of navigations, and one long-lived tab outgrows the memory cap. */
async function freshPage() {
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (err) => failures.push(err.message));
}
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
  // The answer line: review queue (overview), Twitch access and inactive bots (users summary).
  await until(
    async () => /3 things need you/.test(await page.locator("[data-ov-answer]").innerText()),
    "overview answer",
    10000,
  );
  assert.equal(count("/admin-site/overview"), 1, "Overview reads the overview endpoint once");
  assert.equal(
    await page.locator(".live-figure strong").first().textContent(),
    "38",
  );
  assert.match(await page.locator(".connection").textContent(), /Live updates/);
  // Navigation: five tabs for the owner, rarely used tools in the account menu.
  const bottomTabs = page.locator(".bottom-nav a");
  assert.deepEqual(
    (await bottomTabs.allInnerTexts()).map((t) => t.trim()),
    ["Overview", "Activity", "AI", "Users", "System"],
  );
  assert.deepEqual(
    await bottomTabs.evaluateAll((links) => links.map((a) => a.getAttribute("href"))),
    ["/dashboard", "/activity", "/ai", "/users", "/observability"],
  );
  assert.equal(await page.locator('.bottom-nav a[aria-current="page"]').innerText(), "Overview");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  assert.equal(
    await page.locator("#account-menu").getByRole("link", { name: "Test an email" }).getAttribute("href"),
    "/email-test",
  );
  assert.equal(
    await page.locator("#account-menu").getByRole("link", { name: "Read a server file" }).getAttribute("href"),
    "/read-tool",
  );
  await page.keyboard.press("Escape");
  await page.locator("#account-menu").waitFor({ state: "hidden" });
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
  const botsRow = page.locator('[data-attention="bots"]');
  assert.match(await botsRow.innerText(), /16 bots aren't active/);
  await botsRow.click();
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
  const searchButton = page.getByRole("button", { name: "Search", exact: true });
  await until(async () => searchButton.isEnabled(), "debounced search finishes");
  await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/admin-site/users" && url.searchParams.get("search") === "example.test";
    }),
    searchButton.click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelectorAll(".user-card").length === 3 &&
    document.querySelector(".u-search__go")?.disabled === false,
  );
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
  // The channel workspace: one header for every tab, Users lit in the bottom bar.
  assert.equal(await page.locator("main h1").count(), 1);
  assert.equal((await page.locator("main h1").innerText()).trim(), "pixelpilot");
  assert.equal(await page.locator('.bottom-nav a[aria-current="page"]').innerText(), "Users");
  const channelTabs = page.getByRole("navigation", { name: "Channel sections" });
  assert.match(await channelTabs.locator('[aria-current="page"]').innerText(), /^Overview/);
  await page.getByRole("heading", { name: "Last 24 hours" }).waitFor();
  assert.equal(await page.locator(".lf-stat[data-kind]").count(), 5);
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
  const channelLoads = () =>
    requests.filter((r) => r.path === "/admin-site/users" && new URLSearchParams(r.query).get("search") === "9001").length;
  const loadsBeforeTabs = channelLoads();
  await page.locator('a.stat-clickable[href$="/commands"]').click();
  await page.getByRole("heading", { name: "Channel commands" }).waitFor({ state: "attached" });
  await page.getByText("!welcome", { exact: true }).waitFor();
  await page.getByText("2m cooldown").waitFor();
  await page.getByText("2 commands. In the last 7 days they ran 40 times.").waitFor();
  assert.match(await channelTabs.locator('[aria-current="page"]').innerText(), /^Commands/);
  assert.equal(channelLoads(), loadsBeforeTabs, "Switching tabs never reloads the channel");
  await noOverflow("Commands 390");
  await screenshot("commands-dark-390");

  // ---------- Twitch events ----------
  await page.goto(`${base}/channels/9001/eventsubs`);
  await page.getByText("1 of 2 events need attention").waitFor();
  await page.getByText("channel.follow v2").waitFor();
  await page.getByText("Last heard 2 h ago · 14 in 7 days").waitFor();
  await page.getByText("Alert sent 2 h ago").waitFor();
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
  await page.getByRole("heading", { name: "AI credit usage" }).waitFor({ state: "attached" });
  assert.equal(await page.locator(".usage-transactions li").count(), 25);
  await page.getByRole("button", { name: "Load more" }).click();
  await until(async () => (await page.locator(".usage-transactions li").count()) === 30, "load more");
  await page.getByRole("group", { name: "Filter credit activity by category" }).getByRole("button", { name: "Grants & adjustments" }).click();
  await until(async () => (await page.locator(".usage-transactions li").count()) === 1, "filter");
  await page.locator(".usage-transactions .us-amount.is-credit").waitFor();
  await noOverflow("Usage 390");
  await screenshot("usage-dark-390");

  // ---------- Bot log ----------
  await channelTabs.getByRole("link", { name: /^Bot log/ }).click();
  await page.getByText("The bot logged 1 error and 1 warning about this channel in the last 7 days.").waitFor();
  assert.equal(await page.locator("[data-log-row]").count(), 2);
  await noOverflow("Bot log 390");

  // ---------- Files ----------
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("link", { name: "Read a server file", exact: true }).click();
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
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("link", { name: "Test an email", exact: true }).click();
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
  // [route, ready selector, bottom tab that must be lit]. The console pages below "settings" are smoke-tested
  // here (load, h1, lit tab, overflow, axe); their behaviour is covered by ops/checks/admin-console-*-browser.mjs.
  const routes = [
    ["dashboard", ".metric strong", "Overview"],
    ["users", ".user-card", "Users"],
    ["channels/9001", ".credit-usage__progress", "Users"],
    ["channels/9003", ".lf-status", "Users"],
    ["channels/9001/commands", ".cmd-trigger", "Users"],
    ["channels/9001/eventsubs", ".es-row", "Users"],
    ["channels/9001/usage", ".usage-transactions li", "Users"],
    ["channels/9001/logs", "[data-log-row]", "Users"],
    ["read-tool", ".read-empty, .rt-recent", null],
    ["email-test", ".em-form", null],
    ["settings", ".st-section", null],
    ["activity", "[data-feed-row]", "Activity"],
    ["ai", "[data-hub-models]", "AI"],
    ["ai/usage?view=viewers", "[data-usage-coverage]", "AI"],
    ["ai/decisions", "[data-decision-row]", "AI"],
    ["ai/assistant", "[data-turn-row]", "AI"],
    ["ai/docs", "[data-docs-row]", "AI"],
    ["moderation-review?kind=near_miss", "[data-review-card]", "AI"],
    ["assistant-refusals", "[data-refusal-card]", "AI"],
  ];
  for (const mode of ["dark", "light"]) {
    await setMode(mode);
    for (const width of [320, 390, 768, 1280]) {
      await freshPage();
      await page.setViewportSize({ width, height: width >= 1280 ? 900 : 844 });
      for (const [route, ready, tab] of routes) {
        await page.goto(`${base}/${route}`);
        await visible("main h1");
        await visible(ready);
        assert.equal(await page.locator("main h1").count(), 1, `${route}: one h1`);
        assert.equal(
          await page.evaluate(() => document.documentElement.classList.contains("dark")),
          mode === "dark",
        );
        // Phones use the bottom bar, wider screens the pill links in the top bar.
        const lit = page.locator(width >= 960 ? '.nav__links a[aria-current="page"]' : '.bottom-nav a[aria-current="page"]');
        if (tab) assert.equal((await lit.innerText()).trim(), tab, `${route} ${width}: ${tab} tab is lit`);
        else assert.equal(await lit.count(), 0, `${route} ${width}: no tab is lit`);
        await noOverflow(`${route} ${mode} ${width}`);
        if (width === 390 || width === 1280) {
          await axe(`${route} ${mode} ${width}`);
          await screenshot(`${route.replace(/[/?=&]/g, "-")}-${mode}-${width}`);
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
  await page.getByRole("heading", { name: "No channel with this ID" }).waitFor();
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
  let analyticsGranted = false;
  const anonymous = await browser.newContext({
    viewport: { width: 320, height: 700 },
    reducedMotion: "reduce",
  });
  await anonymous.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) return route.continue();
    // Non-admins now pass through the separate analytics-access guard.
    if (isApi(url) && route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (isApi(url) && url.pathname === '/observability/api/session') {
      return json(route, { error: true }, analyticsGranted ? 200 : 403);
    }
    // Analytics reads for the granted non-owner below; answered empty.
    if (isApi(url) && analyticsGranted && url.pathname.startsWith("/observability/api/")) return json(route, { data: {} });
    return route.abort();
  });
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
  // A non-owner with an analytics grant gets only the analytics tab.
  analyticsGranted = true;
  await guardPage.goto(`${base}/observability`);
  await guardPage.locator(".bottom-nav a").first().waitFor();
  assert.equal(new URL(guardPage.url()).pathname, "/observability");
  assert.deepEqual(
    (await guardPage.locator(".bottom-nav a").allInnerTexts()).map((t) => t.trim()),
    ["Analytics"],
    "A non-owner with analytics access sees one tab",
  );
  await anonymous.close();
  assert.deepEqual(failures, [], "No browser errors or unexpected external calls");
  console.log(
    `PASS: admin console regression — five-tab navigation + account menu tools + lit tabs, overview answer and attention rows, users chips/URL state/sorting/race, channel workspace (one header, tabs without reloading the channel) with health + confirmed credit grants (cancel/over-limit/25K) + reminder, commands with run stats, Twitch events connect/switch/test retry + last heard, usage forecast/filters/load more, bot log, file reader auth + recents, email validation, settings mode/accent, smoke for activity/AI hub/usage explorer/decisions/assistant/docs AI/review queue/assistant refusals, axe + no overflow at 320/390/768/1280 in dark and light, sign-out, guard and analytics-only access. Screenshots: ${artifacts}`,
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
