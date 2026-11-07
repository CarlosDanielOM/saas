// Roulette "Import prizes" browser check. Every API call is answered by an in-memory
// fixture; no real channel, token or Twitch user is touched.
// Covers: comma list with repeats, new-line .txt file, CSV name/weight/count with header
// + "remove current prizes first", over-capacity block, mobile/desktop, dark/light, a11y.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || "/tmp/saas-cooldown-browser"}/package.json`);
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const base = process.env.SAAS_PREVIEW_URL;
assert(base);
const shots = process.env.SAAS_SCREENSHOT_DIR;

const keys = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
const en = await (await fetch(`${base}/assets/i18n/en.json`)).json();
const es = await (await fetch(`${base}/assets/i18n/es.json`)).json();
assert.deepEqual(keys(es.roulette).sort(), keys(en.roulette).sort(), "roulette en/es keys match");
assert(en.roulette.import.title && es.roulette.import.title);

const until = async (fn, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const [width, scheme] of [[390, "dark"], [1280, "light"]]) {
    let nextId = 0;
    const prize = (label, multiplier = 1, weight = 1) => {
      const id = `item${++nextId}`;
      return { id, label, multiplier, weight, action: "", copies: Array.from({ length: multiplier }, (_, i) => `${id}c${i}`) };
    };
    const items = [prize("Old A", 2), prize("Old B")];
    const r = {
      id: "roulette1", name: "Friday prizes", alias: "friday", design: "reel", cardSize: "large", durationSeconds: 1,
      colors: ["#cbbaff", "#f4c968", "#ec9baf", "#a5d5c2"],
      settings: { insertion: "append", duplicate: "separate", shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: "keep" },
      items, order: items.flatMap((i) => i.copies),
    };
    const state = { revision: 1, serverTime: Date.now(), roulettes: [r], activeId: r.id, visible: false, draw: null, history: [], hideAt: null, actionRuns: [] };
    const writes = [];
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const user = { id: "999992", login: "adminviewer", display_name: "Viewer" };
    const app = {
      name: "Viewer", email: "test@example.invalid", language: "en", plan_tier: "free", actived: true, chat_enabled: true,
      twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true,
      administrating: [{ channelID: "999991", channelName: "viewer" }],
    };
    await context.addInitScript(({ user, app }) =>
      localStorage.setItem("dimasite.session.v1", JSON.stringify({
        version: 2, token: "fixture-only", createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {},
      })), { user, app });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== "api.domdimabot.com") return route.abort();
      let data = {};
      if (url.pathname === "/auth/session") data = { twitch: user, app };
      else if (url.pathname.endsWith("/access")) data = { allowed: true, role: "admin", planTier: app.plan_tier };
      else if (url.pathname.startsWith("/auth/access/")) data = { allowed: true };
      else if (url.pathname.includes("/live-status")) data = { isLive: false, currentViewers: 0 };
      else if (url.pathname.startsWith("/roulettes/")) {
        state.serverTime = Date.now();
        const suffix = url.pathname.split("/").slice(3), method = req.method();
        if (method === "GET") data = suffix[0] === "overlay-token" ? { token: null, exists: false, version: null } : structuredClone(state);
        else {
          assert(req.headers()["idempotency-key"], "idempotency key sent");
          const body = req.postDataJSON() || {};
          writes.push({ method, path: suffix.join("/"), body });
          if (suffix[2] === "items" && method === "POST") {
            assert.deepEqual(Object.keys(body).sort(), ["label", "multiplier", "weight"]);
            const item = prize(body.label, body.multiplier, body.weight);
            r.items.push(item);
            r.order.push(...item.copies);
            data = { result: item.id };
          } else if (suffix[2] === "items" && method === "DELETE") {
            r.items = r.items.filter((i) => i.id !== suffix[3]);
            r.order = r.items.flatMap((i) => i.copies);
          }
          state.revision++;
        }
      }
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/viewer/modules`);
    const card = page.locator(".lf-mod").filter({ has: page.locator(".lf-mod__name", { hasText: /^\s*Roulette\b/ }) }).first();
    await card.click();
    const module = page.locator("app-roulette-page");
    await module.getByRole("heading", { name: "Roulette", level: 1 }).waitFor();
    assert.equal(await module.locator(".rl-prize").count(), 2);

    // 1. Comma list: repeats become slots, weight 1 each.
    await module.getByRole("button", { name: "Import", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Import prizes" });
    await dialog.waitFor();
    const text = dialog.getByLabel("Or paste the list");
    await text.fill("prize1, prize1, prize 2, prize 3");
    await dialog.getByText("Prizes: 3 · Slots: 4").waitFor();
    assert(await dialog.getByRole("radio", { name: "List of names" }).isChecked());
    if (shots) await page.screenshot({ path: `${shots}/roulette-import-${width}-${scheme}.png`, fullPage: false });
    const axe = await new AxeBuilder({ page }).include("[data-rl-import-dialog]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target) })), [], "axe import dialog");
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, "dialog fits the viewport");
    assert.equal(writes.length, 0, "nothing sent before confirming");
    await dialog.getByRole("button", { name: "Add prizes (3)" }).click();
    await dialog.waitFor({ state: "detached" });
    await module.getByText("Prizes imported: 3 · Slots: 4").waitFor();
    assert.deepEqual(writes.map((w) => w.body), [
      { label: "prize1", weight: 1, multiplier: 2 },
      { label: "prize 2", weight: 1, multiplier: 1 },
      { label: "prize 3", weight: 1, multiplier: 1 },
    ]);
    await until(async () => (await module.locator(".rl-prize").count()) === 5, "list shows 5 prizes");
    assert.equal(r.order.length, 7);

    // 2. New-line .txt file.
    writes.length = 0;
    await module.getByRole("button", { name: "Import", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Import prizes" });
    await dialog.locator("[data-rl-import-file]").setInputFiles({ name: "prizes.txt", mimeType: "text/plain", buffer: Buffer.from("alpha\r\nbeta\nalpha\n\n") });
    await dialog.getByText("Prizes: 2 · Slots: 3").waitFor();
    await dialog.getByRole("button", { name: "Add prizes (2)" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(writes.map((w) => w.body), [
      { label: "alpha", weight: 1, multiplier: 2 },
      { label: "beta", weight: 1, multiplier: 1 },
    ]);

    // 3. Over capacity (reel fits 60): blocked before anything is sent.
    writes.length = 0;
    await module.getByRole("button", { name: "Import", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Import prizes" });
    await dialog.getByLabel("Or paste the list").fill("name,weight,count\nBig,1,100");
    await dialog.getByText(/That makes 110 slots, but this style fits 60/).waitFor();
    assert(await dialog.getByRole("button", { name: "Add prizes (1)" }).isDisabled());

    // 4. CSV file with header, name/weight/count, replacing the current prizes.
    await dialog.locator("[data-rl-import-file]").setInputFiles({
      name: "prizes.csv", mimeType: "text/csv",
      buffer: Buffer.from('﻿name,weight,count\r\nVIP,5,2\r\n"Pick, the game",1,3\r\nHug,,\r\nskip me,0,1\r\n'),
    });
    await dialog.getByText("Prizes: 3 · Slots: 6").waitFor();
    assert(await dialog.getByRole("radio", { name: "Name, weight, count" }).isChecked());
    await dialog.getByText("Skipped: 1.", { exact: false }).waitFor();
    await dialog.locator("[data-rl-import-replace]").check();
    await dialog.getByRole("button", { name: "Add prizes (3)" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(writes.filter((w) => w.method === "DELETE").length, 7, "current prizes removed first");
    assert(writes.slice(0, 7).every((w) => w.method === "DELETE"));
    assert.deepEqual(writes.slice(7).map((w) => w.body), [
      { label: "VIP", weight: 5, multiplier: 2 },
      { label: "Pick, the game", weight: 1, multiplier: 3 },
      { label: "Hug", weight: 1, multiplier: 1 },
    ]);
    assert.deepEqual(r.items.map((i) => i.label), ["VIP", "Pick, the game", "Hug"]);
    await until(async () => (await module.locator(".rl-prize").count()) === 3, "list shows imported CSV");

    // 5. Switching the format re-reads the text; Escape closes.
    await module.getByRole("button", { name: "Import", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Import prizes" });
    await dialog.getByLabel("Or paste the list").fill("a,2\nb,3");
    await dialog.getByText("Prizes: 2 · Slots: 2").waitFor();
    await dialog.getByRole("radio", { name: "List of names" }).check();
    await dialog.getByText("Prizes: 4 · Slots: 4").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    assert.deepEqual(errors, []);
    await context.close();
    console.log(`roulette import ok at ${width}px ${scheme}`);
  }
} finally {
  await browser.close();
}
