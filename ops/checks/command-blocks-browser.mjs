// Command block editor (dimasite): commands modal Blocks tab, import box, saving blocks,
// server errors on a block, free try-out + upgrade + draft resume, refresh draft restore,
// locked (downgraded) block commands, "AST Blocks" label + read-only viewer on the
// dashboard and public page, Spanish label, axe + no overflow at 320/390/1280 dark then light.
// SAAS_BROWSER_TOOLS must contain Playwright + @axe-core/playwright. All API traffic is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.SAAS_BROWSER_TOOLS || '/tmp/saas-cooldown-browser'}/package.json`);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

const base = process.env.SAAS_PREVIEW_URL;
assert.ok(base, 'SAAS_PREVIEW_URL is required');
const shots = process.env.SAAS_SHOTS_DIR || '';
const channelID = '999991';
const avatar = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#7c3aed"/></svg>');

const blocksRoot = {
  id: 'r1', type: 'root', children: [
    { id: 'a1', type: 'literal', value: 'Deaths: ' },
    { id: 'a2', type: 'getVar', name: 'deaths', storage: 'db' },
    { id: 'a3', type: 'literal', value: ' · ' },
    { id: 'a4', type: 'function', name: 'user', args: [] }
  ]
};
const importedRoot = {
  id: 'i1', type: 'root', children: [
    { id: 'i2', type: 'literal', value: 'Hello ' },
    { id: 'i3', type: 'function', name: 'user', args: [] },
    { id: 'i4', type: 'literal', value: '! Welcome' }
  ]
};
const c = (over) => ({ func: 'custom', cooldown: 10, userLevel: 1, userLevelName: 'everyone', enabled: true, reserved: false,
  description: 'No description provided.', channel: 'test', channelID, createdAt: '2026-01-01T00:00:00Z', message: '', authoring: 'text', ...over });
const fixtures = () => [
  c({ _id: 'discord', name: 'Discord', cmd: 'discord', message: 'Join us: discord.gg/example' }),
  c({ _id: 'deaths', name: 'Deaths', cmd: 'deaths', message: '', authoring: 'blocks', blocks: { v: 1, root: blocksRoot } }),
  c({ _id: 'b-so', name: 'shoutout', cmd: 'so', func: 'shoutout', reserved: true, userLevel: 7 })
];

async function until(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function open(browser, path, { tier = 'premium', width = 1280, height = 900, theme = 'dark', lang = 'en', saveError = null, keepStorage = null } = {}) {
  const context = keepStorage ?? await browser.newContext({ viewport: { width, height } });
  const user = { id: channelID, login: 'test', display_name: 'Test' };
  const app = { name: 'Test', email: 'test@example.invalid', language: lang, plan_tier: tier, actived: true, chat_enabled: true,
    twitch_user_id: channelID, has_permissions: true, up_to_date_permissions: true, administrating: [] };
  const writes = [];
  if (!keepStorage) {
    await context.addInitScript(({ user, app, lang, theme }) => {
      if (!sessionStorage.getItem('fixture-ready')) {
        localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} }));
        localStorage.setItem('dimasite.language', lang);
        localStorage.setItem('userLanguage', lang);
        localStorage.setItem('theme', theme);
        sessionStorage.setItem('fixture-ready', '1');
      }
    }, { user, app, lang, theme });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const commands = fixtures();
    context.__writes = writes;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) return route.continue();
      if (url.hostname !== 'api.domdimabot.com') return route.abort();
      const method = request.method();
      let data = {};
      if (url.pathname === '/users') data = { id: channelID, username: 'test', display_name: 'TestStreamer', profile_image_url: avatar };
      else if (url.pathname === '/auth/session') data = { twitch: user, app };
      else if (url.pathname.startsWith('/auth/access/')) data = { allowed: true };
      else if (url.pathname.endsWith('/access')) data = { allowed: true, role: 'owner', planTier: tier };
      else if (url.pathname.includes('/live-status')) data = { isLive: false, currentViewers: 0 };
      else if (url.pathname.startsWith('/timers/')) data = [];
      else if (url.pathname === `/commands/${channelID}/blocks/import` && method === 'POST') {
        context.__writes.push({ method, path: url.pathname, body: request.postDataJSON() });
        return route.fulfill({ json: { error: false, root: importedRoot, advancedCount: 0, status: 200 } });
      } else if (url.pathname.startsWith(`/commands/${channelID}`)) {
        const id = url.pathname.split('/')[3];
        if (method === 'PUT' || method === 'POST') {
          const body = request.postDataJSON();
          context.__writes.push({ method, id, body });
          if (context.__saveError) {
            const err = context.__saveError;
            context.__saveError = null;
            return route.fulfill({ status: err.status, json: { error: true, ...err } });
          }
          const saved = method === 'POST'
            ? c({ _id: `new-${body.cmd}`, ...body, message: body.authoring === 'blocks' ? '' : body.message, blocks: body.blocks ? { v: 1, root: body.blocks } : null })
            : { ...commands.find((x) => x._id === id), ...body, ...(body.blocks ? { blocks: { v: 1, root: body.blocks } } : {}), message: '' };
          if (method === 'POST') commands.push(saved);
          data = { command: saved };
        } else if (method === 'GET') {
          data = { commands };
        }
      }
      return route.fulfill({ json: { error: false, status: 200, data } });
    });
  }
  context.__saveError = saveError;
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}${path}`);
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  return { context, page, writes: context.__writes, errors };
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(250);
}

async function axe(page, label, include) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  assert.deepEqual(result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(', ')}`), [], `axe ${label}`);
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

const modal = (page) => page.locator('app-command-modal .lf-modal');
const editor = (page) => page.locator('app-command-modal app-blocks-editor');

async function openNew(page) {
  const root = page.locator('app-commands-page');
  await root.locator('.lf-cmd-row').first().waitFor();
  await root.getByRole('button', { name: 'New command', exact: true }).first().click();
  await modal(page).waitFor();
}

async function fillDetails(page, cmd) {
  await modal(page).getByRole('tab', { name: 'Details' }).click();
  await modal(page).locator('input[formcontrolname="name"]').fill(`Name ${cmd}`);
  await modal(page).locator('input[formcontrolname="cmd"]').fill(cmd);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // 1. Premium: build from an example, preview, save blocks, label + viewer.
  {
    const { context, page, writes, errors } = await open(browser, '/test/commands');
    const root = page.locator('app-commands-page');
    const deathsRow = root.locator('.lf-cmd-row', { hasText: '!deaths' });
    await deathsRow.getByRole('button', { name: 'See how !deaths works' }).waitFor();
    assert.equal(await deathsRow.locator('.lf-blocks-label').textContent().then((t) => t.trim()), 'AST Blocks');

    await openNew(page);
    assert.equal(await modal(page).locator('textarea[formcontrolname="message"]').getAttribute('maxlength'), '10000', 'website replies allow 10k characters');
    await modal(page).getByRole('tab', { name: 'Blocks' }).click();
    await modal(page).getByRole('button', { name: 'Start with empty blocks' }).click();
    await editor(page).locator('.bx-import').waitFor();
    await editor(page).getByRole('button', { name: 'Greeting' }).click();
    await until(async () => (await editor(page).locator('.bx-msg--bot .bx-msg__text').first().textContent())?.includes('Hello PixelFan! Welcome to the stream.'), 'preview reply');
    assert.equal(await editor(page).locator('.bx-import').count(), 0, 'import box hides once there are edited blocks');

    // Add a block from the library and fill an argument in the details panel.
    await editor(page).locator('.bx-search input').fill('random');
    await editor(page).locator('.bx-item[data-item="fn:random"]').click();
    await editor(page).locator('app-block-inspector').waitFor();
    await editor(page).locator('app-block-inspector #arg-0').fill('6');
    await editor(page).locator('app-block-inspector #arg-0').dispatchEvent('change');
    await until(async () => (await editor(page).locator('.blk[data-type="function"]').filter({ hasText: 'random' }).locator('input.blk__text').evaluateAll((els) => els.map((e) => e.value))).includes('6'), 'argument typed');
    if (shots) await page.screenshot({ path: `${shots}/blocks-desktop-dark.png` });
    await axe(page, 'modal blocks desktop dark', 'app-command-modal');
    await setTheme(page, 'light');
    await axe(page, 'modal blocks desktop light', 'app-command-modal');
    if (shots) await page.screenshot({ path: `${shots}/blocks-desktop-light.png` });
    await setTheme(page, 'dark');

    // Function levels only matter for the AI: in a command, anyone allowed to use it triggers it.
    await editor(page).locator('.bx-search input').fill('tts.refresh');
    await editor(page).locator('.bx-item[data-item="fn:tts.refresh"]').click();
    await editor(page).locator('app-block-inspector .insp__note--danger').getByText('right now that includes people below mods', { exact: false }).waitFor();
    assert.equal(await editor(page).locator('.blk[data-type="function"]').filter({ hasText: 'tts.refresh' }).locator('.blk__badge').textContent().then((t) => t.trim()), 'Mod action');
    assert.ok(await editor(page).locator('.bx-test').isVisible(), 'desktop keeps Try it visible while a block is selected');
    await until(async () => (await editor(page).locator('.bx-effect__name').allTextContents()).includes('tts.refresh'), 'viewer can trigger it');
    await modal(page).getByRole('tab', { name: 'Details' }).click();
    await modal(page).locator('select[formcontrolname="userLevel"]').selectOption('7');
    await modal(page).getByRole('tab', { name: 'Blocks' }).click();
    await editor(page).getByText("A Viewer can't use this command", { exact: false }).waitFor();
    await editor(page).getByRole('button', { name: 'Mod', exact: true }).click();
    await until(async () => (await editor(page).locator('.bx-effect__name').allTextContents()).includes('tts.refresh'), 'mod runs it');
    await editor(page).locator('.blk[data-type="function"]').filter({ hasText: 'tts.refresh' }).click();
    await editor(page).locator('app-block-inspector').getByText('In a command it runs for anyone allowed', { exact: false }).waitFor();
    await editor(page).locator('app-block-inspector').getByRole('button', { name: 'Delete block' }).click();

    await fillDetails(page, 'greet');
    assert.ok(await modal(page).locator('.lf-blocks-chip').isVisible(), 'details show the AST Blocks reply summary');
    await modal(page).getByRole('button', { name: 'Create', exact: true }).click();
    await until(() => writes.some((w) => w.method === 'POST' && w.body?.cmd === 'greet'), 'POST sent');
    const post = writes.find((w) => w.method === 'POST' && w.body?.cmd === 'greet').body;
    assert.equal(post.authoring, 'blocks');
    assert.equal(post.message, '', 'no command text is sent for block commands');
    assert.equal(post.blocks.type, 'root');
    assert.ok(JSON.stringify(post.blocks).includes('"name":"random"'));
    await until(async () => (await modal(page).count()) === 0, 'modal closes after a block save');
    const greetRow = root.locator('.lf-cmd-row', { hasText: '!greet' });
    await greetRow.getByRole('button', { name: 'See how !greet works' }).click();
    const viewer = page.locator('app-blocks-viewer-dialog');
    await viewer.getByRole('heading', { name: '!greet' }).waitFor();
    assert.equal(await viewer.locator('.bx-lib').count(), 0, 'viewer has no library');
    assert.equal(await viewer.locator('input.blk__text').count(), 0, 'viewer text is not editable');
    await viewer.getByText("A Viewer can't use this command", { exact: false }).waitFor();
    await viewer.getByRole('button', { name: 'Mod', exact: true }).click();
    await until(async () => (await viewer.locator('.bx-msg--bot .bx-msg__text').first().textContent())?.includes('Hello PixelFan!'), 'viewer preview');
    await axe(page, 'viewer dialog dark', 'app-blocks-viewer-dialog');
    await page.keyboard.press('Escape');
    await until(async () => (await viewer.count()) === 0, 'viewer closes on Escape');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. Import box: text → blocks, hides and clears after an edit; server error points at a block.
  {
    const { context, page, writes } = await open(browser, '/test/commands', {
      saveError: { status: 400, code: 'blocks_invalid', message: 'This block would run differently than it looks.', blockId: 'i3' }
    });
    await openNew(page);
    await modal(page).getByRole('tab', { name: 'Blocks' }).click();
    await modal(page).getByRole('button', { name: 'Start with empty blocks' }).click();
    await editor(page).locator('#bx-import-text').fill('Hello $(user)! Welcome');
    await editor(page).getByRole('button', { name: 'Turn into blocks' }).click();
    await editor(page).locator('.blk[data-block-id="i3"]').waitFor();
    assert.equal(writes.find((w) => w.path?.endsWith('/blocks/import')).body.text, 'Hello $(user)! Welcome');
    assert.equal(await editor(page).locator('#bx-import-text').inputValue(), 'Hello $(user)! Welcome', 'pasted text stays until an edit');
    await editor(page).locator('input.blk__text').first().fill('Hey ');
    await until(async () => (await editor(page).locator('.bx-import').count()) === 0, 'import box hidden after editing');

    await fillDetails(page, 'hello');
    await modal(page).getByRole('button', { name: 'Create', exact: true }).click();
    await until(async () => (await editor(page).locator('.blk.is-error').count()) === 1, 'block highlighted');
    assert.equal(await editor(page).locator('.blk.is-error').getAttribute('data-block-id'), 'i3');
    await editor(page).locator('.insp__error').getByText('This block would run differently than it looks.').waitFor();
    assert.equal(await modal(page).count(), 1, 'dialog stays open on a block error');
    await context.close();
  }

  // 3. Free plan: try-out, upgrade prompt keeps the draft, resume after "checkout".
  {
    const { context, page, writes } = await open(browser, '/test/commands', { tier: 'free', width: 390, height: 844 });
    await openNew(page);
    await modal(page).getByRole('tab', { name: /Blocks/ }).locator('.lf-plan-tag').waitFor();
    await modal(page).getByRole('tab', { name: /Blocks/ }).click();
    await modal(page).getByText('Saving block commands needs Premium or Pro.', { exact: false }).first().waitFor();
    await modal(page).getByRole('button', { name: 'Start with empty blocks' }).click();
    await editor(page).getByRole('button', { name: 'Death counter' }).click();
    await editor(page).getByRole('button', { name: 'Try it' }).click();
    await until(async () => (await editor(page).locator('.bx-msg--bot .bx-msg__text').first().textContent())?.includes('Deaths so far: 1'), 'phone preview');
    await editor(page).getByRole('button', { name: 'Build' }).click();
    if (shots) await page.screenshot({ path: `${shots}/blocks-phone-dark.png` });
    await noOverflow(page, 'phone blocks');
    await axe(page, 'modal blocks phone dark', 'app-command-modal');
    await fillDetails(page, 'deathsfree');
    await modal(page).getByRole('button', { name: 'Create', exact: true }).click();
    await modal(page).locator('.lf-upgrade').getByText('Block commands need Premium or Pro').waitFor();
    await modal(page).locator('.lf-upgrade').getByText('Your blocks are kept on this device.').waitFor();
    assert.equal(writes.filter((w) => w.method === 'POST').length, 0, 'nothing saved on a free plan');
    const draftKey = `dimasite.commandDraft.v1.${channelID}.new-command`;
    assert.ok(await page.evaluate((k) => !!localStorage.getItem(k), draftKey), 'draft stored');
    await modal(page).getByRole('button', { name: 'See plans' }).click();
    assert.ok(await page.evaluate((id) => !!localStorage.getItem(`dimasite.commandDraft.resume.${id}`), channelID), 'resume marker set');
    // Back from checkout: the page reopens the dialog with the draft.
    await page.goto(`${base}/test/commands?upgrade=success&tier=premium`);
    await modal(page).waitFor();
    await until(async () => (await modal(page).locator('input[formcontrolname="cmd"]').inputValue().catch(() => '')) === 'deathsfree'
      || (await editor(page).locator('.blk').filter({ hasText: 'deaths' }).count()) > 0, 'draft restored after checkout');
    assert.equal(await modal(page).getByRole('tab', { name: /Blocks/ }).getAttribute('aria-selected'), 'true');
    assert.ok((await editor(page).locator('.blk[data-type="setVar"]').count()) >= 1, 'blocks restored');
    await context.close();
  }

  // 4. Refresh keeps edits: draft offer on the edit dialog.
  {
    const { context, page } = await open(browser, '/test/commands');
    const root = page.locator('app-commands-page');
    await root.getByRole('button', { name: 'Edit Deaths' }).click().catch(async () => {
      await root.locator('.lf-cmd-row', { hasText: '!deaths' }).getByRole('button', { name: /Edit/ }).click();
    });
    await editor(page).waitFor();
    await editor(page).locator('input.blk__text').first().fill('Total deaths: ');
    await page.waitForTimeout(900);
    await page.reload();
    await root.locator('.lf-cmd-row', { hasText: '!deaths' }).getByRole('button', { name: /Edit/ }).click();
    await modal(page).locator('.lf-draft').getByText('You have unsaved changes', { exact: false }).waitFor();
    await modal(page).locator('.lf-draft').getByRole('button', { name: 'Restore' }).click();
    await until(async () => (await editor(page).locator('input.blk__text').first().inputValue()) === 'Total deaths: ', 'draft restored after refresh');
    await context.close();
  }

  // 5. Downgraded: block command is read-only; settings save without blocks.
  {
    const { context, page, writes } = await open(browser, '/test/commands', { tier: 'free', theme: 'light' });
    const root = page.locator('app-commands-page');
    await root.locator('.lf-cmd-row', { hasText: '!deaths' }).getByRole('button', { name: /Edit/ }).click();
    await modal(page).getByText('This command keeps working in chat.', { exact: false }).waitFor();
    assert.equal(await editor(page).locator('.bx-lib').count(), 0, 'no library when locked');
    assert.equal(await editor(page).locator('input.blk__text').count(), 0, 'no editable text when locked');
    await axe(page, 'locked modal light', 'app-command-modal');
    await modal(page).getByRole('tab', { name: 'Details' }).click();
    await modal(page).locator('input[formcontrolname="cooldown"]').fill('20');
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await until(() => writes.some((w) => w.method === 'PUT'), 'PUT sent');
    const put = writes.find((w) => w.method === 'PUT').body;
    assert.equal(put.authoring, 'blocks');
    assert.equal(put.blocks, undefined, 'locked save sends settings only');
    assert.equal(put.cooldown, 20);
    await context.close();
  }

  // 6. Public page: label + viewer at 320/390/1280, dark then light; Spanish label.
  for (const [width, height] of [[320, 700], [390, 844], [1280, 900]]) {
    for (const theme of ['dark', 'light']) {
      const { context, page, errors } = await open(browser, '/commands/test', { width, height, theme });
      const row = page.locator('.lf-pub-row', { hasText: '!deaths' });
      await row.getByRole('button', { name: 'See how !deaths works' }).click();
      const viewer = page.locator('app-blocks-viewer-dialog');
      await viewer.locator('.blk').first().waitFor();
      await until(async () => (await viewer.locator('.bx-msg--bot .bx-msg__text').first().textContent())?.includes('Deaths:'), 'public viewer preview');
      if (width < 960) {
        await viewer.getByRole('button', { name: 'Try it' }).click();
        await viewer.locator('.bx-test').waitFor();
      }
      await noOverflow(page, `public ${width} ${theme}`);
      await axe(page, `public viewer ${width} ${theme}`, 'app-blocks-viewer-dialog');
      if (shots) await page.screenshot({ path: `${shots}/public-viewer-${width}-${theme}.png` });
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  {
    const { context, page } = await open(browser, '/commands/test', { lang: 'es' });
    await page.locator('.lf-pub-row', { hasText: '!deaths' }).locator('.lf-blocks-label').filter({ hasText: 'Bloques AST' }).waitFor();
    await context.close();
  }

  console.log('PASS site: blocks tab build/preview/save, AST Blocks label + viewer, import box hides after edit, block error highlight, free try-out + upgrade + resume, refresh draft, locked command, public viewer, es, axe/overflow');
} finally {
  await browser.close();
}
