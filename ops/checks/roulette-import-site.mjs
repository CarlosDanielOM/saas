// Roulette "Import prizes" browser check. Every API call is answered by an in-memory
// fixture that mirrors the server's import rules; no real channel, token or user is touched.
// Covers: comma/new-line lists, CSV with header + command column, one atomic request,
// retry after a lost response (same idempotency key), replace with If-Match + skipped-line
// confirmation, 'increase' clashes, capacity, row errors, Windows-1252 and Excel files,
// CSV download round trip, drag and drop, Spanish, phone/desktop, dark/light, axe.
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
assert(en.roulette.import.err.network && es.roulette.import.err.network);

const until = async (fn, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const axeClean = async (page) => {
  const axe = await new AxeBuilder({ page }).include("[data-rl-import-dialog]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target) })), [], "axe import dialog");
};
const fill = (s, params) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k]));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const [width, scheme, lang] of [[390, "dark", "en"], [1280, "light", "en"], [320, "dark", "es"]]) {
    let nextId = 0;
    const prize = (label, multiplier = 1, weight = 1, action = "") => {
      const id = `item${++nextId}`;
      return { id, label, multiplier, weight, action, copies: Array.from({ length: multiplier }, (_, i) => `${id}c${i}`) };
    };
    const items = [prize("Old A", 2), prize("Old B", 1, 1, "$(user) wins")];
    const r = {
      id: "roulette1", name: "Friday prizes", alias: "friday", design: "reel", cardSize: "large", durationSeconds: 1,
      colors: ["#cbbaff", "#f4c968", "#ec9baf", "#a5d5c2"],
      settings: { insertion: "append", duplicate: "separate", shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: "keep" },
      items, order: items.flatMap((i) => i.copies),
    };
    const state = { revision: 1, serverTime: Date.now(), roulettes: [r], activeId: r.id, visible: false, draw: null, history: [], hideAt: null, actionRuns: [] };
    const imports = [];
    const receipts = new Map();
    let failNext = null; // 'lost' (save, then drop the response) | { status, json }
    const applyImport = (body) => {
      if (body.replace) { r.items = []; r.order = []; }
      for (const row of body.items) {
        const found = r.settings.duplicate === "increase" ? r.items.find((i) => i.label === row.label) : null;
        const item = found ?? prize(row.label, 0, row.weight ?? 1, row.action ?? "");
        if (!found) r.items.push(item);
        for (let i = 0; i < (row.multiplier ?? 1); i++) { const key = `${item.id}c${item.copies.length}`; item.copies.push(key); r.order.push(key); }
        item.multiplier = item.copies.length;
      }
    };

    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, acceptDownloads: true });
    const user = { id: "999992", login: "adminviewer", display_name: "Viewer" };
    const app = {
      name: "Viewer", email: "test@example.invalid", language: lang, plan_tier: "free", actived: true, chat_enabled: true,
      twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true,
      administrating: [{ channelID: "999991", channelName: "viewer" }],
    };
    await context.addInitScript(({ user, app, lang, scheme }) => {
      localStorage.setItem("userLanguage", lang);
      localStorage.setItem("theme", scheme);
      localStorage.setItem("dimasite.session.v1", JSON.stringify({
        version: 2, token: "fixture-only", createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {},
      }));
    }, { user, app, lang, scheme });
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
          assert.equal(suffix[2], "import", `only the import endpoint is written (${method} ${suffix.join("/")})`);
          const headers = req.headers();
          const body = req.postDataJSON();
          const key = headers["idempotency-key"];
          assert(key, "idempotency key sent");
          imports.push({ key, ifMatch: headers["if-match"], body });
          if (receipts.has(key)) {
            assert.deepEqual(receipts.get(key), body, "same key, same payload");
            return route.fulfill({ json: { error: false, status: 200, data: { result: String(body.items.length), replayed: true } } });
          }
          const fail = failNext;
          failNext = null;
          if (fail && fail !== "lost") return route.fulfill({ status: fail.status, json: { error: true, status: fail.status, ...fail.json } });
          if (headers["if-match"] !== undefined && Number(headers["if-match"]) !== state.revision)
            return route.fulfill({ status: 409, json: { error: true, status: 409, code: "revision_conflict" } });
          applyImport(body);
          receipts.set(key, body);
          state.revision++;
          if (fail === "lost") return route.abort("connectionreset");
          data = { result: String(body.items.length) };
        }
      }
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const T = lang === "es" ? es.roulette : en.roulette;

    await page.goto(`${base}/viewer/modules/roulette`);
    const module = page.locator("app-roulette-page");
    await module.getByRole("heading", { name: T.title, level: 1 }).waitFor();
    await until(async () => (await module.locator(".rl-prize").count()) === 2, "fixture prizes shown");
    const openDialog = async () => {
      await module.getByRole("button", { name: T.import.button, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: T.import.title });
      await dialog.waitFor();
      return dialog;
    };
    const summaryHas = (dialog, prizes, slots) =>
      until(async () => {
        const s = dialog.locator("[data-rl-import-summary]");
        return (await s.count()) && (await s.innerText()).replace(/\s+/g, " ").includes(`${prizes} ${T.import.sumPrizes} ${slots} ${T.import.sumSlots}`);
      }, `summary ${prizes}/${slots}`);
    const run = (dialog) => dialog.locator("[data-rl-import-run]");
    const text = (dialog) => dialog.getByLabel(T.import.pasteLabel);

    // 1. Comma list with repeats → one request, no If-Match for an append.
    let dialog = await openDialog();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), scheme, "site theme under test");
    await dialog.getByRole("heading", { name: T.import.examples }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/roulette-import-empty-${width}-${scheme}-${lang}.png` });
    await text(dialog).fill("prize1, prize1, prize 2, prize 3");
    await summaryHas(dialog, 3, 4);
    assert(await dialog.getByRole("radio", { name: T.import.format.list }).isChecked());
    await axeClean(page);
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, "dialog fits the viewport");
    if (shots) await page.screenshot({ path: `${shots}/roulette-import-${width}-${scheme}-${lang}.png` });
    assert.equal(imports.length, 0, "nothing sent before confirming");
    await run(dialog).click();
    await dialog.waitFor({ state: "detached" });
    await module.getByText(fill(T.import.done, { count: 3, slots: 4 })).waitFor();
    assert.equal(imports.length, 1, "one request for the whole list");
    assert.equal(imports[0].ifMatch, undefined);
    assert.deepEqual(imports[0].body, { items: [
      { label: "prize1", weight: 1, multiplier: 2 },
      { label: "prize 2", weight: 1, multiplier: 1 },
      { label: "prize 3", weight: 1, multiplier: 1 },
    ] });
    await until(async () => (await module.locator(".rl-prize").count()) === 5, "prize list shows the import");

    if (lang === "es") {
      // Spanish run: Windows-1252 file note and Ctrl+Enter, then stop.
      dialog = await openDialog();
      await dialog.locator("[data-rl-import-file]").setInputFiles({ name: "premios.txt", mimeType: "text/plain", buffer: Buffer.from([0x50, 0x72, 0x65, 0x6d, 0x69, 0x6f, 0x20, 0xfa, 0x6e, 0x69, 0x63, 0x6f, 0x0a, 0x4f, 0x74, 0x72, 0x6f]) });
      await dialog.getByText(fill(T.import.fileReadLatin, { name: "premios.txt" })).waitFor();
      await dialog.locator("[data-rl-import-list]").getByText("Premio único", { exact: true }).waitFor();
      await text(dialog).press("Control+Enter");
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(imports.at(-1).body.items.map((i) => i.label), ["Premio único", "Otro"]);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`roulette import ok at ${width}px ${scheme} ${lang}`);
      continue;
    }

    // 2. New-line .txt via drag and drop.
    dialog = await openDialog();
    const drop = dialog.locator(".rl-import-drop");
    const transfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["alpha\r\nbeta\nalpha\n\n"], "prizes.txt", { type: "text/plain" }));
      return dt;
    });
    await drop.dispatchEvent("dragover", { dataTransfer: transfer });
    await dialog.getByText(T.import.dropHere).waitFor();
    await drop.dispatchEvent("drop", { dataTransfer: transfer });
    await dialog.getByText(fill(T.import.fileRead, { name: "prizes.txt" })).waitFor();
    await summaryHas(dialog, 2, 3);

    // 3. Excel file and over capacity are explained; nothing is sent.
    await dialog.locator("[data-rl-import-file]").setInputFiles({ name: "prizes.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) });
    await dialog.getByText(T.import.fileSpreadsheet).waitFor();
    await text(dialog).fill("name,weight,count\nBig,1,100");
    await dialog.getByText(fill(T.previewOver, { used: 107, max: 60 })).waitFor();
    assert(await run(dialog).isDisabled());
    const sentBefore = imports.length;

    // Values past the header are reported instead of silently dropped.
    await text(dialog).fill("name,weight,count\nTimeout,1,1,$(timeout $(user) 60)");
    await dialog.locator("[data-rl-import-extra]").getByText(fill(T.import.extraCells, { count: 1, line: 2 })).waitFor();

    // 4. Lost response near the slot limit: saved, but the browser never heard back. The refreshed
    // preview now counts it (107 > 60), yet the unchanged retry stays allowed and replays.
    const lostText = "name,count\nLost,30\nFound,20";
    await text(dialog).fill(lostText);
    failNext = "lost";
    await run(dialog).click();
    await dialog.locator("[data-rl-import-error]").getByText(T.import.err.network).waitFor();
    assert.equal(await text(dialog).inputValue(), lostText, "the list stays for the retry");
    await until(async () => (await module.locator(".rl-prize").count()) === 7, "refresh shows the saved import");
    await dialog.getByText(fill(T.import.sumAfterMax, { used: 107, max: 60 })).waitFor();
    await until(async () => (await run(dialog).innerText()).trim() === T.import.retry && (await run(dialog).isEnabled()), "retry stays available");
    await run(dialog).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(imports.length, sentBefore + 2);
    assert.equal(imports.at(-1).key, imports.at(-2).key, "retry reuses the idempotency key");
    assert.equal(r.items.filter((i) => i.label === "Lost").length, 1, "not added twice");
    assert.equal(r.order.length, 57);

    // 5. A server row error is shown in the dialog with the file line and name.
    dialog = await openDialog();
    await text(dialog).fill("name,weight,count,action\nFine,1,1\nBroken,1,1,$(oops");
    assert(await dialog.getByRole("radio", { name: T.import.format.table }).isChecked());
    failNext = { status: 400, json: { code: "invalid_action", row: 2, message: "Prize 2: Invalid AST syntax in item action" } };
    await run(dialog).click();
    await dialog.getByText(fill(T.import.err.action, { line: 3, name: "Broken" })).waitFor();
    const keyBefore = imports.at(-1).key;

    // 6. Replace: needs If-Match, asks before dropping skipped lines, warns about commands.
    await text(dialog).fill('name;weight;count;action\nVIP;5;2;\n"Pick; the game";1;3;$(user) picks\nskip me;0;1;\nHug;;;');
    await dialog.locator("[data-rl-import-replace]").check();
    await dialog.getByText(fill(T.import.replaceCommands, { count: 1 })).waitFor();
    await dialog.getByText(fill(T.import.skipped, { count: 1 })).waitFor();
    await dialog.getByText(T.import.blockSkips).waitFor();
    assert(await run(dialog).isDisabled(), "replace waits for the skipped-lines confirmation");
    await dialog.locator("[data-rl-import-ack]").check();
    // Changing the text asks again: the confirmation was for the old skipped lines.
    const replaceText = await text(dialog).inputValue();
    await text(dialog).fill(replaceText + "\nbad two;x;1;");
    await dialog.getByText(fill(T.import.skipped, { count: 2 })).waitFor();
    await until(async () => !(await dialog.locator("[data-rl-import-ack]").isChecked()), "confirmation resets", 3000);
    assert(await run(dialog).isDisabled());
    await dialog.locator("[data-rl-import-ack]").check();
    if (shots) await dialog.screenshot({ path: `${shots}/roulette-import-replace-${width}-${scheme}.png` });
    if (width === 1280) await axeClean(page);
    const rev = state.revision;
    await run(dialog).click();
    await dialog.waitFor({ state: "detached" });
    const sent = imports.at(-1);
    assert.notEqual(sent.key, keyBefore, "a new payload gets a new key");
    assert.equal(sent.ifMatch, String(rev));
    assert.deepEqual(sent.body, { replace: true, items: [
      { label: "VIP", weight: 5, multiplier: 2, action: "" },
      { label: "Pick; the game", weight: 1, multiplier: 3, action: "$(user) picks" },
      { label: "Hug", weight: 1, multiplier: 1, action: "" },
    ] });
    assert.deepEqual(r.items.map((i) => i.label), ["VIP", "Pick; the game", "Hug"]);
    await until(async () => (await module.locator(".rl-prize").count()) === 3, "replaced list shown");

    // 7. 'increase' setting: a same-name row with another weight is marked and blocks the import.
    r.settings.duplicate = "increase";
    state.revision++;
    await page.waitForTimeout(2300);
    dialog = await openDialog();
    await text(dialog).fill("name,weight,count\nVIP,1,1\nHug,1,4\nNew,1,1");
    await dialog.getByText(fill(T.import.status.weightClash, { weight: 5 })).waitFor();
    await dialog.getByText(T.import.status.joins).waitFor();
    await dialog.getByText(T.import.blockClashes).waitFor();
    assert(await run(dialog).isDisabled());
    if (shots) await page.screenshot({ path: `${shots}/roulette-import-clash-${width}-${scheme}.png` });
    await axeClean(page);
    // The format switch re-reads the same text as plain names.
    await dialog.getByRole("radio", { name: T.import.format.list }).check();
    await summaryHas(dialog, 8, 12);

    // 8. Download round trip: BOM, header, quoted separators, command column.
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.locator("[data-rl-export]").click()]);
    assert.equal(download.suggestedFilename(), "friday-prizes.csv");
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const csv = Buffer.concat(chunks);
    assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
    assert.equal(csv.subarray(3).toString("utf8"), 'name,weight,count,action\r\nVIP,5,2,\r\n"Pick; the game",1,3,$(user) picks\r\nHug,1,1,\r\n');
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    assert.deepEqual(errors, []);
    await context.close();
    console.log(`roulette import ok at ${width}px ${scheme} ${lang}`);
  }
} finally {
  await browser.close();
}
