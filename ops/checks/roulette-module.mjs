// Roulette module + overlay browser check. Every API call is answered by an in-memory
// fixture; no real channel, token or Twitch user is touched.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  `${process.env.SAAS_BROWSER_TOOLS || "/tmp/saas-cooldown-browser"}/package.json`,
);
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const base = process.env.SAAS_PREVIEW_URL;
assert(base);
const shots = process.env.SAAS_SCREENSHOT_DIR;
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
    action: "",
    copies: Array.from({ length: multiplier }, (_, i) => `${id}copy${i}`),
  };
};
function roulette(name = "Friday prizes", alias = "friday", design = "reel") {
  const items = [prize("VIP for a day", 3, 2), prize("Choose the game", 1), prize("Mystery prize", 2)];
  return {
    id: `roulette${++nextId}`,
    name,
    alias,
    design,
    cardSize: "large",
    durationSeconds: 1,
    colors: ["#cbbaff", "#f4c968", "#ec9baf", "#a5d5c2"],
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
        { key, itemId: i.id, label: i.label, copy: n + 1, multiplier: i.multiplier, weight: i.weight },
      ]),
    ),
  );
  return r.order.map((k) => map.get(k));
}
const until = async (fn, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const axeClean = async (page, include) => {
  const axe = await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(
    axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target) })),
    [],
    `axe ${include}`,
  );
};

// i18n parity: every roulette key exists in both languages.
const keys = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
const en = await (await fetch(`${base}/assets/i18n/en.json`)).json();
const es = await (await fetch(`${base}/assets/i18n/es.json`)).json();
assert.deepEqual(keys(es.roulette).sort(), keys(en.roulette).sort(), "roulette en/es keys match");
assert(en.roulette.design.elimination.name, "fourth design is translated");

try {
  for (const width of [320, 390, 1280]) {
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
      actionRuns: [],
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
      forceConflict = false,
      lastStartUser;
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== "api.domdimabot.com") return route.abort();
      let data = {};
      if (url.pathname === "/auth/session") data = { twitch: user, app };
      else if (url.pathname.endsWith("/access")) data = { allowed: true, role: "owner", planTier: app.plan_tier };
      else if (url.pathname.startsWith("/auth/access/")) data = { allowed: true };
      else if (url.pathname.includes("/live-status")) data = { isLive: false, currentViewers: 0 };
      else if (url.pathname.startsWith("/roulettes/")) {
        state.serverTime = Date.now();
        if (state.draw && !state.draw.completedAt && state.draw.endsAt <= Date.now()) {
          state.draw.completedAt = state.draw.endsAt;
          const { slots: _s, ...result } = state.draw;
          state.history.unshift(result);
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
            return route.fulfill({ status: 409, json: { error: true, code: "revision_conflict" } });
          }
          if (suffix[0] === "overlay-token") data = { token: "a".repeat(43) };
          else if (suffix[0] === "roulettes") {
            const selected = state.roulettes.find((x) => x.id === suffix[1]);
            if (suffix.length === 1) {
              const created = roulette(body.name, body.alias, body.design);
              created.items = [];
              created.order = [];
              state.roulettes.push(created);
              data = { result: created.id };
            } else if (suffix[2] === "items") {
              if (method === "POST") {
                const item = prize(body.label, body.multiplier, body.weight);
                item.action = body.action ?? "";
                selected.items.push(item);
                selected.order.push(...item.copies);
                data = { result: item.id };
              }
              if (method === "PATCH") {
                const item = selected.items.find((i) => i.id === suffix[3]);
                Object.assign(item, body);
                item.copies = Array.from({ length: item.multiplier }, (_, i) => `${item.id}copy${i}`);
                selected.order = selected.items.flatMap((i) => i.copies);
              }
              if (method === "DELETE") {
                selected.items = selected.items.filter((i) => i.id !== suffix[3]);
                selected.order = selected.items.flatMap((i) => i.copies);
              }
            } else if (method === "PATCH") {
              Object.assign(selected, body);
              if (state.activeId === selected.id) state.draw = null;
            } else if (method === "DELETE") {
              state.roulettes = state.roulettes.filter((x) => x !== selected);
              if (state.activeId === selected.id) {
                state.activeId = null;
                state.visible = false;
                state.draw = null;
              }
            }
          } else if (suffix[0] === "actions") {
            const selected = state.roulettes.find((x) => x.id === body.roulette);
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
                lastStartUser = body.user;
                const copies = slots(selected);
                state.activeId = selected.id;
                state.visible = true;
                state.draw = {
                  id: `draw${++nextId}`,
                  rouletteId: selected.id,
                  startedAt: Date.now(),
                  endsAt: Date.now() + selected.durationSeconds * 1000,
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
    const card = page.locator(".lf-mod").filter({ has: page.locator(".lf-mod__name", { hasText: /^\s*Roulette\b/ }) }).first();
    await card.getByText("Alpha", { exact: true }).waitFor();
    await card.click();
    const module = page.locator("app-roulette-page");
    await module.getByRole("heading", { name: "Roulette", level: 1 }).waitFor();
    await module.locator("[data-design='reel']").waitFor();
    assert.equal(await module.locator(".reel-card").count(), 9);
    assert.equal(await module.locator(".rl-prize").count(), 3);
    await module.getByText("6 of 60 slots used").waitFor();
    // Overlay not set up yet: the setup strip says so in amber.
    assert(await module.locator(".lf-setup--warn").isVisible());

    // Add a prize through the stepped dialog, including a command that runs on win.
    await module.getByRole("button", { name: "Add prize", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Add a prize" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Add prize", exact: true }).click();
    await dialog.getByText("Write the prize.").waitFor();
    assert.equal(writes, 0, "empty prize is not sent");
    await dialog.getByLabel("Prize", { exact: true }).fill("Community choice");
    await dialog.getByLabel("Slots", { exact: true }).fill("3");
    await dialog.getByRole("button", { name: "More Slots" }).click();
    await dialog.getByLabel("Weight", { exact: true }).fill("3");
    // (2·3 + 1 + 2 + 4·3) = 21 total; 12/21 = 57%
    await dialog.getByText("this has a 57% chance").waitFor();
    await dialog.getByText("When it wins, run a command (optional)").click();
    await dialog.getByLabel("Command to run").fill("$(timer 300 $(user), speak again.)");
    if (width === 1280) await axeClean(page, ".lf-modal-overlay");
    await dialog.getByRole("button", { name: "Add prize", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await module.getByText("Community choice", { exact: true }).first().waitFor();
    assert.equal(r.order.length, 10);
    assert.equal(r.items.at(-1).action, "$(timer 300 $(user), speak again.)");
    await module.getByText("Runs a command").waitFor();

    // Capacity is explained before saving: reel fits 60 slots.
    await module.getByRole("button", { name: "Edit Community choice", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit Community choice" });
    assert.equal(await dialog.getByLabel("Command to run").inputValue(), "$(timer 300 $(user), speak again.)");
    await dialog.getByLabel("Slots", { exact: true }).fill("60");
    await dialog.getByText("That makes 66 slots, but this style fits 60").waitFor();
    const beforeOver = writes;
    await dialog.getByRole("button", { name: "Save prize" }).click();
    await page.waitForTimeout(200);
    assert.equal(writes, beforeOver, "over-capacity edit is not sent");
    await dialog.getByLabel("Slots", { exact: true }).fill("5");
    await dialog.getByRole("button", { name: "Save prize" }).click();
    await dialog.waitFor({ state: "detached" });
    await until(() => r.order.length === 11, "edit saved 5 slots");

    // Target user appears because a prize runs a command.
    await module.getByPlaceholder("username (optional)").fill("punished");
    await module.getByRole("button", { name: "Shuffle", exact: true }).click();
    await until(() => state.revision > 3, "shuffle sent");
    await module.getByRole("button", { name: "Start draw", exact: true }).click();
    await module.locator("[data-winner]").waitFor();
    assert.equal(lastStartUser, "punished");
    assert.equal(await module.locator("[data-winner]").getAttribute("data-winner"), state.draw.winner.key);
    const winner = module.locator(".reel-card.winner");
    await winner.waitFor();
    const winnerBox = await winner.boundingBox(),
      reelBox = await module.locator(".reel").boundingBox();
    assert(Math.abs(winnerBox.x + winnerBox.width / 2 - reelBox.x - reelBox.width / 2) < 2, "winner centered exactly");
    await module.locator(".result--win").getByText(state.draw.winner.label).waitFor();
    await module.locator(".rl-history").getByText(state.draw.winner.label).waitFor();
    await module.getByRole("button", { name: "Hide", exact: true }).click();
    await module.getByText("Overlay hidden").waitFor();
    assert.equal(state.visible, false);

    // Remove asks first, then removes.
    await module.getByRole("button", { name: "Remove Mystery prize" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Remove Mystery prize?" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    assert(r.items.some((i) => i.label === "Mystery prize"));
    await module.getByRole("button", { name: "Remove Mystery prize" }).click();
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await until(() => !r.items.some((i) => i.label === "Mystery prize"), "prize removed");

    // Each style previews before saving, saves through the save bar, and animates correctly.
    const lookReady = () => module.locator('input[name="rl-design"]').first().isEnabled();
    for (const design of ["wheel", "cards", "elimination", "reel"]) {
      await until(lookReady, "look controls unlock after the draw", 4000);
      const radio = module.locator(`input[name="rl-design"][value="${design}"]`);
      try {
        await radio.check();
      } catch (e) {
        console.error("DEBUG", width, design, await radio.evaluate((n) => ({ disabled: n.disabled, checked: n.checked, fs: n.closest("fieldset").disabled })), state.draw?.completedAt, r.design);
        if (shots) await page.screenshot({ path: `${shots}/debug.png`, fullPage: true });
        throw e;
      }
      await module.getByText("Previewing unsaved look").waitFor();
      await module.locator(`app-roulette-display [data-design="${design}"]`).waitFor();
      assert.equal(r.design === design, false, "preview does not save");
      await module.getByRole("button", { name: "Save", exact: true }).click();
      await until(() => r.design === design, `saved ${design}`);
      await module.getByText("Unsaved changes").waitFor({ state: "detached" });
      if (design === "reel") break;
      await module.getByRole("button", { name: "Start draw", exact: true }).click();
      await until(() => state.draw && !state.draw.completedAt, "draw started");
      const winningIndex = state.draw.slots.findIndex((s) => s.key === state.draw.winner.key);
      if (design === "cards") {
        const boxes = () =>
          module.locator(".card").evaluateAll((nodes) =>
            nodes.map((n) => ({
              x: n.getBoundingClientRect().x - n.parentElement.getBoundingClientRect().x,
              y: n.getBoundingClientRect().y - n.parentElement.getBoundingClientRect().y,
            })),
          );
        const before = await boxes();
        const hops = await module.locator(".cards").evaluate(async (board) => {
          const seen = [];
          for (let i = 0; i < 20; i++) {
            const index = [...board.children].findIndex((n) => n.classList.contains("highlight"));
            if (seen.at(-1) !== index) seen.push(index);
            await new Promise((r) => setTimeout(r, 35));
          }
          return seen;
        });
        assert(hops.length >= 3, "cards highlight several different copies");
        assert.deepEqual(await boxes(), before, "cards themselves do not move");
        await module.locator(".card.winner").waitFor();
        assert(await module.locator(".card").nth(winningIndex).evaluate((n) => n.classList.contains("winner")));
      }
      if (design === "elimination") {
        const total = state.draw.slots.length;
        const seen = await module.locator(".chips").evaluate(async (board) => {
          const counts = [];
          for (let i = 0; i < 20; i++) {
            counts.push(board.querySelectorAll(".chip.out").length);
            await new Promise((r) => setTimeout(r, 40));
          }
          return counts;
        });
        assert(seen.some((c, i) => i > 0 && c > seen[0]), "entries are knocked out during the draw");
        assert(seen.every((c, i) => i === 0 || c >= seen[i - 1]), "knocked-out entries stay out");
        await module.locator(".chip.winner").waitFor();
        assert.equal(await module.locator(".chip.out").count(), total - 1, "everyone but the winner is out");
        assert(await module.locator(".chip").nth(winningIndex).evaluate((n) => n.classList.contains("winner")));
        await module.locator(".royale-count").getByText("1").waitFor();
      }
      if (design === "wheel") {
        await module.locator(".seg--win").waitFor();
        const rotation = await module
          .locator(".wheel svg > g")
          .first()
          .evaluate((g) => Number(/rotate\(([-\d.e]+)/.exec(g.getAttribute("transform"))[1]));
        const n = state.draw.slots.length,
          seg = 360 / n;
        const center = ((((winningIndex + 0.5) * seg + rotation) % 360) + 360) % 360;
        const offTop = Math.min(center, 360 - center);
        assert(offTop < seg / 2, `pointer lands inside the winning segment (${offTop} < ${seg / 2})`);
      }
      await until(() => state.draw?.completedAt, "draw finished on server");
    }

    // Look draft: slider, palette and conflict recovery.
    await until(lookReady, "look controls unlocked", 4000);
    await module.locator(".lf-range").fill("5");
    await until(async () => (await module.getByLabel("Draw length in seconds").inputValue()) === "5", "slider updates the exact box");
    await module.getByLabel("Draw length in seconds").fill("90");
    await module.getByLabel("Draw length in seconds").press("Tab");
    await until(async () => (await module.locator(".lf-range").inputValue()) === "60", "slider pins at its max for long draws");
    await module.locator(".lf-range").fill("5");
    await module.getByRole("button", { name: "Neon" }).click();
    forceConflict = true;
    await module.getByRole("button", { name: "Save", exact: true }).click();
    await module.getByRole("alert").first().waitFor();
    assert.equal(r.durationSeconds, 1, "conflict preserves server config");
    assert.equal(await module.getByLabel("Draw length in seconds").inputValue(), "5", "conflict keeps draft");
    await module.getByRole("button", { name: "Save", exact: true }).click();
    await until(() => r.durationSeconds === 5, "duration saved");
    assert.deepEqual(r.colors, ["#a855f7", "#22d3ee", "#f472b6", "#facc15"]);
    // After-draw rules
    await module.getByText("Leaves the draw").click();
    await module.getByRole("checkbox", { name: "Hide after the result" }).check({ force: true });
    await module.getByRole("button", { name: "Save", exact: true }).click();
    await until(() => r.settings.winnerAction === "remove-item" && r.settings.hideAfterSeconds === 10, "rules saved");

    // OBS link: confirm, then a copyable private URL.
    await module.getByRole("button", { name: "Get overlay link" }).click();
    await page.getByRole("alertdialog", { name: "Get an overlay link" }).getByRole("button", { name: "Get link" }).click();
    await module.getByLabel("Private overlay link").waitFor();
    assert.match(await module.getByLabel("Private overlay link").inputValue(), /\/overlays\/roulette\/999991#[a]{43}$/);
    assert.equal(await module.locator(".lf-setup--warn").count(), 0);

    // Create a second roulette: ID follows the name, style chosen up front.
    await module.getByRole("button", { name: "New roulette" }).click();
    dialog = page.getByRole("dialog", { name: "New roulette" });
    await dialog.getByLabel("Name", { exact: true }).fill("Sub Giveaway ñ");
    assert.equal(await dialog.getByLabel("Command ID").inputValue(), "sub-giveaway-n");
    await dialog.locator(".rl-design", { hasText: "Last one standing" }).click();
    await dialog.getByRole("button", { name: "Create roulette" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(state.roulettes[1].design, "elimination");
    await module.getByRole("button", { name: /Sub Giveaway ñ/, pressed: true }).waitFor();
    await module.getByText("No prizes yet").waitFor();
    await module.getByRole("button", { name: "Put on stream" }).click();
    await until(() => state.activeId === state.roulettes[1].id, "switched");
    await page.reload();
    await module.getByRole("button", { name: /Sub Giveaway ñ/, pressed: true }).waitFor();
    await module.getByText("More options").click();
    await module.getByRole("button", { name: "Delete roulette" }).click();
    await page.getByRole("alertdialog", { name: "Delete Sub Giveaway ñ?" }).getByRole("button", { name: "Delete roulette" }).click();
    await module.getByText("Community choice", { exact: true }).first().waitFor();
    assert.equal(state.roulettes.length, 1);

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
      await page.waitForTimeout(100);
      await axeClean(page, "app-roulette-page");
      if (shots) await page.screenshot({ path: `${shots}/roulette-${width}-${theme}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    for (const tier of ["free", "premium"]) {
      app.plan_tier = tier;
      const before = writes;
      await page.reload();
      await module.getByRole("heading", { name: "Roulette Alpha is exclusive to Pro" }).waitFor();
      assert.equal(await module.getByRole("button", { name: "Start draw", exact: true }).count(), 0);
      assert.equal(writes, before);
      await page.goto(`${base}/viewer/modules`);
      await card.waitFor();
      assert((await card.getAttribute("class")).includes("lf-mod--locked"), "Roulette is locked below Pro");
      await page.goto(`${base}/viewer/modules/roulette`);
    }
    await context.close();
  }

  // Overlay: public token, mid-draw reconnect, frozen result for every style, visibility, revoke.
  const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const overlayRequests = [];
  context.on("request", (request) => overlayRequests.push(request.url()));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort(),
  );
  const r = roulette(),
    copies = slots(r);
  let serverSocket;
  const namespace = "/overlays/roulette/999991";
  await context.routeWebSocket(/socket.io/, (socket) => {
    serverSocket = socket;
    socket.send("0" + JSON.stringify({ sid: "fixture", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }));
    socket.onMessage((message) => {
      if (String(message).startsWith("40")) {
        assert(String(message).includes("a".repeat(43)));
        socket.send("40" + namespace + "," + JSON.stringify({ sid: "fixture" }));
      }
    });
  });
  const page = await context.newPage();
  await page.goto(`${base}${namespace}#${"a".repeat(43)}`);
  await page.waitForTimeout(500);
  assert(serverSocket);
  assert(!overlayRequests.some((url) => url.includes("tadd.domdimabot.com")), "private OBS sources never initialize analytics");
  const send = (draw, visible = true) =>
    serverSocket.send(
      "42" + namespace + "," +
        JSON.stringify(["roulette-state", { revision: 1, serverTime: Date.now(), visible, roulette: { ...r, design: draw.design }, draw, hideAt: null }]),
    );
  let draw;
  for (const design of ["reel", "wheel", "cards", "elimination"]) {
    draw = {
      id: `restored-${design}`,
      rouletteId: r.id,
      startedAt: Date.now() - 700,
      endsAt: Date.now() + 300,
      completedAt: null,
      winner: copies[2],
      slots: copies,
      design,
      cardSize: "large",
      colors: r.colors,
    };
    send(draw);
    await page.locator(`[data-design="${design}"][data-winner="${copies[2].key}"]`).waitFor();
    await page.locator(".result--win").getByText(copies[2].label).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/roulette-overlay-${design}.png` });
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgba(0, 0, 0, 0)");
  send(draw, false);
  await page.locator("app-roulette-display").waitFor({ state: "detached" });
  send(draw);
  await page.locator("app-roulette-display").waitFor();
  serverSocket.send("41" + namespace + ",");
  await page.locator("app-roulette-display").waitFor({ state: "detached" });
  await context.close();
  console.log(
    "PASS Roulette: redesigned page at 320/390/1280 (prize dialog, capacity, odds, remove confirm, target user, draft preview + save bar, conflict recovery, OBS link, create/switch/delete), all four styles incl. last one standing land on the saved winner, overlay reconnect/visibility/revoke, Pro gating, en/es parity and axe in dark + light.",
  );
} finally {
  await browser.close();
}
