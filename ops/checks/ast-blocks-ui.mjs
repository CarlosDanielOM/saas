/**
 * Behavior check: command builder (AST blocks) mock at /mocks/dev/command-ast.
 * Everything runs locally; all non-site requests are aborted.
 *
 *  - starts from the Greeting starter; live preview shows the bot reply with no Run button
 *  - typing in a text block updates the reply and the command text immediately
 *  - library: 115 catalog functions, search, add at the cursor; labelled argument holes
 *  - inspector: Mods+ / destructive notes, typed arguments, cursor into an empty hole,
 *    move earlier/later, duplicate, delete; undo/redo buttons and Ctrl+Z
 *  - Try it: viewer vs mod role (mod-only actions skipped for viewers), "Remembers" list
 *  - code box → blocks (debounced), real loop syntax round-trip
 *  - variable storage choice rewrites the prefix (* → none)
 *  - HTML5 drag from the library onto the first slot
 *  - phone: tab bar, library bottom sheet (Escape closes), docked details, Try it / Text tabs
 *  - axe (wcag2a/2aa/21aa) clean and no horizontal overflow at 320/390/1280, dark first then light
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const tools = process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const origin = new URL(base).origin;
const shots = process.env.SAAS_SCREENSHOT_DIR || '';
const URL_PATH = '/mocks/dev/command-ast';

async function until(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function open(browser, { width, height, dark }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  await context.addInitScript((d) => localStorage.setItem('theme', d ? 'dark' : 'light'), dark);
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}${URL_PATH}`);
  await page.getByRole('heading', { name: 'Command builder' }).waitFor({ timeout: 20000 });
  return { context, page, errors };
}

const code = (page) => page.locator('#command-source').inputValue();
const botSays = (page) => page.locator('.msg--bot').first().innerText();
/** Library entry by its exact title (e.g. "ban", not "ban.self"). */
const libItem = (page, title) => page.locator('.lib .item').filter({ has: page.locator('.item__title', { hasText: new RegExp(`^${title.replace('.', '\\.')}$`) }) }).first();

async function axe(page, label) {
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  const result = await new AxeBuilder({ page }).include('app-command-ast-mock').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`),
    [],
    `${label}: axe`
  );
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // ================= Desktop flow =================
  {
    const { context, page, errors } = await open(browser, { width: 1440, height: 1000, dark: true });

    // Starter + live preview.
    assert.equal(await page.locator('.chip.is-on').innerText(), 'Greeting');
    assert.equal(await code(page), 'Hello $(user)! Welcome to the stream.');
    assert.match(await botSays(page), /Hello PixelFan! Welcome to the stream\./);
    assert.equal(await page.getByRole('button', { name: /run preview/i }).count(), 0, 'no Run button: preview is live');
    assert.match(await page.locator('.lib__count').innerText(), /115 functions/);

    // Typing in a text block updates reply + command text live.
    const first = page.locator('.canvas .blk__text').first();
    await first.fill('Hey ');
    await until(async () => /Hey PixelFan!/.test(await botSays(page)), 'live reply after typing');
    assert.equal(await code(page), 'Hey $(user)! Welcome to the stream.');
    assert.equal(await page.locator('.chip.is-on').count(), 0, 'starter no longer marked as active after edits');

    // Search the library and add ban at the end.
    await page.locator('.search input').fill('timeout');
    await until(async () => (await page.locator('.lib .item').count()) > 0, 'search results');
    assert.match(await page.locator('.lib__results').innerText(), /\d+ blocks?/);
    await libItem(page, 'ban').click();
    await until(async () => (await code(page)).includes('$(ban trolluser)'), 'ban added from its example');
    assert.equal((await page.locator('.insp__title').innerText()).trim(), 'ban', 'new block is selected');
    assert.equal(await page.locator('.insp__note').count(), 2, 'Mods+ and destructive notes');
    assert.match(await page.locator('.insp__note').first().innerText(), /Mods\+/);
    const labels = await page.locator('.insp .field__label').allInnerTexts();
    assert.deepEqual(labels.slice(0, 2), ['username', 'seconds (optional)'], 'labelled arguments from the catalog syntax');
    // Empty optional hole is shown on the block with its label.
    assert.equal(await page.locator('.canvas .blk[data-type="function"] .hole__empty', { hasText: 'seconds (optional)' }).count(), 1);

    // Try it: viewer → skipped; mod → runs.
    const effect = page.locator('.effect').filter({ hasText: 'ban' });
    await until(async () => /Skipped · Mods\+/.test(await effect.innerText()), 'ban skipped for viewers');
    await page.locator('.test-tile .seg__btn', { hasText: 'Mod' }).click();
    await until(async () => !/Skipped/.test(await effect.innerText()), 'ban runs for mods');
    await page.locator('.test-tile .seg__btn', { hasText: 'Viewer' }).click();

    // Type an argument in the inspector.
    const username = page.locator('.insp #arg-0');
    await username.fill('$(touser)');
    await username.dispatchEvent('change');
    await until(async () => (await code(page)).includes('$(ban $(touser))'), 'typed argument becomes a block');

    // Put a block into the empty seconds hole via the cursor.
    await page.locator('.insp .field__pick').nth(1).click();
    await until(async () => /into “seconds \(optional\)” of ban/.test(await page.locator('.lib__where').innerText()), 'cursor in seconds hole');
    await page.locator('.search input').fill('random');
    await libItem(page, 'random').click();
    await until(async () => (await code(page)).includes('$(ban $(touser) $(random))'), 'random placed into the seconds hole');

    // Move, duplicate, delete, undo.
    await page.locator('.canvas > app-command-ast-block .blk[data-type="function"]').filter({ hasText: 'ban' }).first().click({ position: { x: 8, y: 8 } });
    await until(async () => (await page.locator('.insp__title').innerText()).trim() === 'ban', 'ban selected');
    await page.getByRole('button', { name: 'Move earlier' }).click();
    await until(async () => (await code(page)).startsWith('Hey $(user)$(ban') || (await code(page)).includes('$(user) $(ban'), 'moved earlier');
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await until(async () => ((await code(page)).match(/\$\(ban /g) ?? []).length === 2, 'duplicated');
    await page.getByRole('button', { name: 'Delete block' }).click();
    await until(async () => ((await code(page)).match(/\$\(ban /g) ?? []).length === 1, 'deleted');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await until(async () => ((await code(page)).match(/\$\(ban /g) ?? []).length === 2, 'undo restores');
    await page.locator('.head').click();
    await page.keyboard.press('Control+z');
    await until(async () => ((await code(page)).match(/\$\(ban /g) ?? []).length === 1, 'Ctrl+Z undoes the duplicate');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await until(async () => ((await code(page)).match(/\$\(ban /g) ?? []).length === 2, 'redo');

    // Code box → blocks.
    await page.locator('#command-source').fill('*($(user) == PixelFan ? "hi boss" : "hi")');
    await until(async () => (await page.locator('.canvas .blk[data-type="ternary"]').count()) === 1, 'if block from text');
    assert.match(await botSays(page), /hi boss/);
    assert.match(await page.locator('#code-status').innerText(), /In sync|Updating/);

    // Real loop syntax round-trips.
    await page.locator('#command-source').fill('*(for #i = 2; #i < 10; #i = #i + 2 { #i })');
    await until(async () => (await page.locator('.canvas .blk[data-type="forLoop"]').count()) === 1, 'loop block');
    assert.match(await botSays(page), /2 4 6 8/);
    await page.locator('#command-source').blur();
    assert.equal(await code(page), '*(for #i = 2; #i < 10; #i = #i + 2 { #i })');

    // Death counter: remembered value + storage choice.
    await page.getByRole('button', { name: 'Death counter' }).click();
    await until(async () => /Deaths so far: 1/.test(await botSays(page)), 'counter reply');
    assert.match(await page.locator('.effect--var').innerText(), /\*deaths\s*= 1/);
    await page.locator('.canvas > app-command-ast-block .blk[data-type="setVar"]').click({ position: { x: 6, y: 6 } });
    await until(async () => (await page.locator('.insp .choice__opt.is-on').count()) === 1, 'storage choice shown');
    assert.match(await page.locator('.insp .choice__opt.is-on').innerText(), /Saved for the channel/);
    await page.locator('.insp .choice__opt', { hasText: 'Just this run' }).click();
    await until(async () => (await code(page)).startsWith('%(deaths '), 'storage prefix removed');

    // Drag a library block onto the first slot.
    await page.getByRole('button', { name: 'Greeting' }).click();
    await page.locator('.search input').fill('randomuser');
    await page.evaluate(() => window.scrollTo(0, 0));
    await libItem(page, 'randomuser').dragTo(page.locator('.canvas > .slot').first());
    await until(async () => (await code(page)).startsWith('$(randomuser)'), 'dragged block lands at the start');

    if (shots) await page.screenshot({ path: `${shots}/ast-desktop-dark.png` });
    await noOverflow(page, 'desktop');
    await axe(page, 'desktop dark');
    assert.deepEqual(errors, [], 'desktop page errors');
    await context.close();
  }

  // ================= Phone flow =================
  {
    const { context, page, errors } = await open(browser, { width: 390, height: 844, dark: true });
    assert.ok(await page.locator('.tabbar').isVisible(), 'tab bar on phones');
    assert.equal(await page.locator('.lib').isVisible(), false, 'library hidden until opened');
    await page.getByRole('button', { name: 'Add block' }).click();
    await until(async () => page.locator('.lib').isVisible(), 'library sheet open');
    await page.keyboard.press('Escape');
    await until(async () => !(await page.locator('.lib').isVisible()), 'Escape closes the sheet');
    await page.getByRole('button', { name: 'Add block' }).click();
    await page.locator('.lib__sections .chip', { hasText: 'Chat & voice' }).click();
    await libItem(page, 'tts').click();
    await until(async () => !(await page.locator('.lib').isVisible()), 'sheet closes after adding');
    await until(async () => page.locator('.insp-tile').isVisible(), 'details docked after adding');
    assert.equal((await page.locator('.insp__title').innerText()).trim(), 'tts');
    if (shots) await page.screenshot({ path: `${shots}/ast-phone-details-dark.png` });
    await noOverflow(page, 'phone build');
    await axe(page, 'phone build dark');

    await page.getByRole('button', { name: 'Try it' }).click();
    await until(async () => page.locator('.test-tile').isVisible(), 'Try it tab');
    assert.equal(await page.locator('.canvas-tile').isVisible(), false);
    assert.match(await page.locator('.effects').innerText(), /tts/);
    if (shots) await page.screenshot({ path: `${shots}/ast-phone-test-dark.png` });
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await until(async () => page.locator('.code-tile').isVisible(), 'Text tab');
    assert.match(await code(page), /\$\(tts Hello chat!\)$/);
    assert.deepEqual(errors, [], 'phone page errors');
    await context.close();
  }

  // ================= Widths × themes =================
  for (const dark of [true, false]) {
    for (const [width, height] of [[1280, 900], [390, 844], [320, 640]]) {
      const label = `${dark ? 'dark' : 'light'} ${width}`;
      const { context, page, errors } = await open(browser, { width, height, dark });
      await page.getByRole('button', { name: 'Timeout roulette' }).click();
      await page.locator('.canvas .blk[data-type="function"]').filter({ hasText: /^ban/ }).first().click({ position: { x: 6, y: 6 } });
      await until(async () => page.locator('.insp-tile').isVisible(), `${label}: details`);
      await noOverflow(page, label);
      await axe(page, label);
      if (shots && width !== 320) await page.screenshot({ path: `${shots}/ast-${dark ? 'dark' : 'light'}-${width}.png` });
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }
  }

  console.log('PASS command builder: live preview, catalog library + search, labelled args, cursor holes, inspector notes/edit/move/duplicate/delete, undo/redo + Ctrl+Z, role-gated actions, remembered vars, storage choice, code→blocks + real loop syntax, drag from library, phone tabs/sheet/docked details; axe + overflow at 320/390/1280 dark/light');
} finally {
  await browser.close();
}
