// Browser interactions use disposable in-memory API fixtures; no real channel is modified.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  `${process.env.SAAS_BROWSER_TOOLS || "/tmp/saas-cooldown-browser"}/package.json`,
);
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const base = process.env.SAAS_PREVIEW_URL;
assert(base);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const settings = {
  insertion: "append",
  duplicate: "separate",
  shuffleBeforeDraw: false,
  showOnStart: true,
  hideAfterSeconds: null,
  winnerAction: "keep",
};
let nextId = 0;
const prize = (label, multiplier = 1, weight = 1) => {
  const id = `item${++nextId}`;
  return {
    id,
    label,
    multiplier,
    weight,
    copies: Array.from({ length: multiplier }, (_, i) => `${id}copy${i}`),
  };
};
function roulette(name = "Friday prizes", alias = "friday") {
  const items = [
    prize("VIP for a day", 3, 2),
    prize("Choose the game", 1),
    prize("Mystery prize", 2),
  ];
  return {
    id: `roulette${++nextId}`,
    name,
    alias,
    design: "reel",
    cardSize: "large",
    durationSeconds: 1,
    colors: ["#7c3aed", "#b45309", "#0369a1"],
    settings: { ...settings },
    items,
    order: items.flatMap((i) => i.copies),
  };
}
function slots(r) {
  const map = new Map(
    r.items.flatMap((i) =>
      i.copies.map((key, n) => [
        key,
        {
          key,
          itemId: i.id,
          label: i.label,
          copy: n + 1,
          multiplier: i.multiplier,
          weight: i.weight,
        },
      ]),
    ),
  );
  return r.order.map((k) => map.get(k));
}
try {
  for (const width of [320, 390, 1440]) {
    const r = roulette();
    const state = {
      revision: 1,
      serverTime: Date.now(),
      roulettes: [r],
      activeId: r.id,
      visible: false,
      draw: null,
      history: [],
      hideAt: null,
    };
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const user = { id: "999991", login: "viewer", display_name: "Viewer" };
    const app = {
      name: "Viewer",
      email: "test@example.invalid",
      language: "en",
      plan_tier: "pro",
      actived: true,
      chat_enabled: true,
      twitch_user_id: user.id,
      has_permissions: true,
      up_to_date_permissions: true,
      administrating: [],
    };
    await context.addInitScript(
      ({ user, app }) =>
        localStorage.setItem(
          "dimasite.session.v1",
          JSON.stringify({
            version: 2,
            token: "fixture-only",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            twitchUser: user,
            appUser: app,
            permissions: {},
          }),
        ),
      { user, app },
    );
    let writes = 0,
      forceConflict = false;
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== "api.domdimabot.com") return route.abort();
      let data = {};
      if (url.pathname === "/auth/session") data = { twitch: user, app };
      else if (url.pathname.endsWith("/access"))
        data = { allowed: true, role: "owner", planTier: app.plan_tier };
      else if (url.pathname.startsWith("/auth/access/"))
        data = { allowed: true };
      else if (url.pathname.includes("/live-status"))
        data = { isLive: false, currentViewers: 0 };
      else if (url.pathname.startsWith("/roulettes/")) {
        state.serverTime = Date.now();
        if (
          state.draw &&
          !state.draw.completedAt &&
          state.draw.endsAt <= Date.now()
        ) {
          state.draw.completedAt = Date.now();
          state.history.unshift({ ...state.draw });
          state.revision++;
        }
        const suffix = url.pathname.split("/").slice(3),
          method = req.method();
        const body = req.postDataJSON() || {};
        if (method === "GET") data = structuredClone(state);
        else {
          writes++;
          assert(req.headers()["idempotency-key"]);
          if (forceConflict) {
            forceConflict = false;
            return route.fulfill({
              status: 409,
              json: { error: true, code: "revision_conflict" },
            });
          }
          if (suffix[0] === "overlay-token") data = { token: "a".repeat(43) };
          else if (suffix[0] === "roulettes") {
            const selected = state.roulettes.find((r) => r.id === suffix[1]);
            if (suffix.length === 1) {
              const r = roulette(body.name, body.alias);
              r.items = [];
              r.order = [];
              state.roulettes.push(r);
              data = { result: r.id };
            } else if (suffix[2] === "items") {
              if (method === "POST") {
                const item = prize(body.label, body.multiplier, body.weight);
                selected.items.push(item);
                selected.order.push(...item.copies);
                data = { result: item.id };
              }
              if (method === "PATCH") {
                const item = selected.items.find((i) => i.id === suffix[3]);
                Object.assign(item, body);
                item.copies = Array.from(
                  { length: item.multiplier },
                  (_, i) => `${item.id}copy${i}`,
                );
                selected.order = selected.items.flatMap((i) => i.copies);
              }
              if (method === "DELETE") {
                selected.items = selected.items.filter(
                  (i) => i.id !== suffix[3],
                );
                selected.order = selected.items.flatMap((i) => i.copies);
              }
            } else if (method === "PATCH") {
              Object.assign(selected, body);
              if (state.activeId === selected.id) state.draw = null;
            } else if (method === "DELETE") {
              state.roulettes = state.roulettes.filter((r) => r !== selected);
              if (state.activeId === selected.id) {
                state.activeId = null;
                state.visible = false;
                state.draw = null;
              }
            }
          } else if (suffix[0] === "actions") {
            const selected = state.roulettes.find(
              (r) => r.id === body.roulette,
            );
            switch (suffix[1]) {
              case "show":
                state.visible = true;
                break;
              case "hide":
                state.visible = false;
                break;
              case "switch":
                state.activeId = selected.id;
                state.draw = null;
                break;
              case "shuffle":
                selected.order.reverse();
                break;
              case "start": {
                const copies = slots(selected);
                state.activeId = selected.id;
                state.visible = true;
                state.draw = {
                  id: `draw${++nextId}`,
                  rouletteId: selected.id,
                  startedAt: Date.now(),
                  endsAt: Date.now() + 1000,
                  completedAt: null,
                  winner: copies[2] || copies[0],
                  slots: copies,
                  design: selected.design,
                  cardSize: selected.cardSize,
                  colors: selected.colors,
                };
                break;
              }
            }
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
    const card = page.locator("article").filter({
      has: page.getByRole("heading", { name: "Roulette", exact: true }),
    });
    await card.getByText("Alpha", { exact: true }).waitFor();
    assert.equal(await card.locator(".lf-chip--pro").textContent(), "Pro");
    await card.getByRole("button", { name: /open module/i }).click();
    const module = page.locator("app-roulette-page");
    await module.getByRole("heading", { name: "Friday prizes" }).waitFor();
    assert.equal(await module.locator(".reel-card").count(), 9);
    assert.equal(await module.locator(".items li").count(), 3);
    await module
      .getByLabel("Prize label", { exact: true })
      .fill("Community choice");
    await module.getByLabel("Multiplier", { exact: true }).fill("4");
    await module.getByLabel("Weight", { exact: true }).fill("3");
    await module.getByRole("button", { name: "Add item", exact: true }).click();
    await module
      .getByText("Community choice", { exact: true })
      .first()
      .waitFor();
    assert.equal(r.order.length, 10);
    await module
      .getByRole("button", { name: "Edit: Community choice", exact: true })
      .click();
    await module.getByLabel("Multiplier", { exact: true }).fill("5");
    await module
      .getByRole("button", { name: "Save item", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.equal(r.order.length, 11);
    await module
      .getByRole("button", { name: "Shuffle copies", exact: true })
      .click();
    await page.waitForTimeout(150);
    await module
      .getByRole("button", { name: "Start draw", exact: true })
      .click();
    await module.locator("[data-winner]").waitFor();
    assert.equal(
      await module.locator("[data-winner]").getAttribute("data-winner"),
      state.draw.winner.key,
    );
    const winner = module.locator(".reel-card.winner");
    await winner.waitFor();
    const winnerBox = await winner.boundingBox(),
      reelBox = await module.locator(".reel").boundingBox();
    assert(
      Math.abs(
        winnerBox.x + winnerBox.width / 2 - reelBox.x - reelBox.width / 2,
      ) < 2,
      "winner centered exactly",
    );
    await module
      .getByRole("button", { name: "Hide overlay", exact: true })
      .click();
    await module.getByText("Overlay hidden", { exact: true }).waitFor();
    assert.equal(state.visible, false);
    for (const design of ["wheel", "cards", "reel"]) {
      await module.getByLabel("Design", { exact: true }).selectOption(design);
      await module
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await page.waitForTimeout(150);
      assert.equal(r.design, design);
      await module.locator(`[data-design="${design}"]`).waitFor();
    }
    forceConflict = true;
    await module.getByLabel("Draw duration (seconds)").fill("5");
    await module
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await module.getByRole("alert").waitFor();
    assert.equal(r.durationSeconds, 1, "conflict preserves server config");
    assert.equal(
      await module.getByLabel("Draw duration (seconds)").inputValue(),
      "5",
      "conflict keeps draft",
    );
    await module
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.equal(r.durationSeconds, 5);
    await module
      .getByRole("button", { name: "Generate overlay link", exact: true })
      .click();
    await module
      .getByRole("button", { name: "Generate new private link", exact: true })
      .click();
    await module.getByLabel("Private overlay link").waitFor();
    assert.match(
      await module.getByLabel("Private overlay link").inputValue(),
      /\/overlays\/roulette\/999991#[a]{43}$/,
    );
    const create = module.locator(".library form");
    await create.getByLabel("Name", { exact: true }).fill("Second wheel");
    await create.getByLabel("Command alias").fill("second");
    await create.getByRole("button", { name: "Create roulette" }).click();
    await module
      .getByRole("heading", { name: "Second wheel", exact: true })
      .waitFor();
    await module
      .getByRole("button", { name: "Use on overlay", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.equal(state.activeId, state.roulettes[1].id);
    await page.reload();
    await module
      .getByRole("heading", { name: "Second wheel", exact: true })
      .waitFor();
    await module
      .getByRole("button", { name: "Delete roulette", exact: true })
      .click();
    await module
      .getByRole("button", { name: "Yes, delete roulette", exact: true })
      .click();
    await module
      .getByRole("heading", { name: "Friday prizes", exact: true })
      .waitFor();
    assert.equal(state.roulettes.length, 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "no horizontal overflow",
    );
    const axe = await new AxeBuilder({ page })
      .include("app-roulette-page")
      .analyze();
    assert.deepEqual(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          html: n.html,
          summary: n.failureSummary,
        })),
      })),
      [],
    );
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `/tmp/roulette-alpha-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    const lightAxe = await new AxeBuilder({ page })
      .include("app-roulette-page")
      .analyze();
    assert.deepEqual(
      lightAxe.violations.map((v) => v.id),
      [],
    );
    await page.screenshot({
      path: `/tmp/roulette-alpha-light-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    for (const tier of ["free", "premium"]) {
      app.plan_tier = tier;
      const before = writes;
      await page.reload();
      await module
        .getByRole("heading", { name: "Roulette Alpha is exclusive to Pro" })
        .waitFor();
      assert.equal(
        await module
          .getByRole("button", { name: "Start draw", exact: true })
          .count(),
        0,
      );
      assert.equal(writes, before);
      await page.goto(`${base}/viewer/modules`);
      await card.waitFor();
      assert((await card.getAttribute("class")).includes("lf-mod--locked"));
      await page.goto(`${base}/viewer/modules/roulette`);
    }
    await context.close();
  }
  // Overlay: public token, mid-draw reconnect, frozen result, visibility and revoke disconnect.
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
  });
  const overlayRequests = [];
  context.on("request", (request) => overlayRequests.push(request.url()));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  const r = roulette(),
    copies = slots(r);
  let serverSocket;
  const namespace = "/overlays/roulette/999991";
  await context.routeWebSocket(/socket.io/, (socket) => {
    serverSocket = socket;
    socket.send(
      "0" +
        JSON.stringify({
          sid: "fixture",
          upgrades: [],
          pingInterval: 25000,
          pingTimeout: 20000,
          maxPayload: 1000000,
        }),
    );
    socket.onMessage((message) => {
      if (String(message).startsWith("40")) {
        assert(String(message).includes("a".repeat(43)));
        socket.send(
          "40" + namespace + "," + JSON.stringify({ sid: "fixture" }),
        );
      }
    });
  });
  const page = await context.newPage();
  await page.goto(`${base}${namespace}#${"a".repeat(43)}`);
  await page.waitForTimeout(500);
  assert(serverSocket);
  assert(
    !overlayRequests.some((url) => url.includes("tadd.domdimabot.com")),
    "private OBS sources never initialize analytics",
  );
  const draw = {
    id: "restored",
    rouletteId: r.id,
    startedAt: Date.now() - 700,
    endsAt: Date.now() + 300,
    completedAt: null,
    winner: copies[2],
    slots: copies,
    design: "reel",
    cardSize: "large",
    colors: r.colors,
  };
  const send = (visible = true) =>
    serverSocket.send(
      "42" +
        namespace +
        "," +
        JSON.stringify([
          "roulette-state",
          {
            revision: 1,
            serverTime: Date.now(),
            visible,
            roulette: r,
            draw,
            hideAt: null,
          },
        ]),
    );
  send();
  await page.locator("[data-winner]").waitFor();
  assert.equal(
    await page.locator("[data-winner]").getAttribute("data-winner"),
    copies[2].key,
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  send(false);
  await page.locator("app-roulette-display").waitFor({ state: "detached" });
  send();
  await page.locator("app-roulette-display").waitFor();
  serverSocket.send("41" + namespace + ",");
  await page.locator("app-roulette-display").waitFor({ state: "detached" });
  await context.close();
  console.log(
    "PASS Roulette Alpha: desktop/mobile editor, real copies, centered authoritative winner, designs, CAS error recovery, persistence, overlay token/reconnect/visibility, Pro gating and axe.",
  );
} finally {
  await browser.close();
}
