import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base = process.env.SAAS_PREVIEW_URL; assert(base);
const axePath = process.env.AXE_PATH || '/tmp/saas-cooldown-browser/node_modules/axe-core/axe.min.js';
const shots = process.env.SAAS_SCREENSHOT_DIR;
const api = 'https://api.domdimabot.com';
const user = { id: '991404', login: 'persona_owner', display_name: 'Persona_Owner' };
const app = { name: 'Persona_Owner', email: 'ai@example.invalid', language: 'en', plan_tier: 'pro', actived: true, chat_enabled: true, twitch_user_id: user.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
const voice = { tone: 'Friendly and playful', cadence: 'Short and dynamic', style: 'Chat-native', catchphrases: ['GG chat'] };
const profile = (id, name, personality) => ({ profileID: id, name, personality, personaMode: 'original', personaReference: '', tonePreset: 'balanced', voiceProfile: { ...voice } });
const learning = { enabled: true, autoConfirmEnabled: true, autoConfirmThreshold: 0.92, minMessageLength: 12, maxPendingMemories: 50, maxConfirmedMemories: 500, postStreamSummaryEnabled: true, weeklyMaintenanceEnabled: true, monthlyMaintenanceEnabled: false, autoApplyCreates: true, autoApplyEdits: true, autoApplyArchives: false, autoApplyPermanentDeletes: false, summaryMinDurationMinutes: 20, summaryMinChatMessages: 40, createMinConfidence: 0.8, editMinConfidence: 0.85, archiveMinConfidence: 0.9, deleteMinConfidence: 0.97, maxActionsPerRun: 10, maxDeletesPerRun: 2, minMemoryAgeDaysForDelete: 30, minUnusedDaysForDelete: 60 };
const seed = () => ({ channelID: user.id, channel: user.login, enabled: true, streamSummariesEnabled: true, recommendationsEnabled: true,
  profiles: [profile('p1', 'Chill co-host', 'You are a chill co-host. Reply in Spanish, keep it short and never spoil games.'), profile('p2', 'Horror night', 'Spooky narrator voice for horror streams.')],
  activeProfileId: 'p1', personality: '', personaMode: 'original', personaReference: '', tonePreset: 'balanced', voiceProfile: { ...voice },
  learningConfig: { ...learning }, memoryPolicy: { prioritizeRecentChat: true, allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true },
  rules: ['No spoilers', 'Be kind to new chatters'], knownUsers: [{ username: 'luna_v', relationship: 'Mod', description: 'Learning Spanish, loves horror games' }], contextWindow: 35,
  tier: { isPremiumPlus: true, isPremium: true, limits: { profiles: 3, rules: 'unlimited', knownUsers: 'unlimited', contextWindow: 35 } } });
const errors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function open({ theme = 'dark', width = 1280, manage = true } = {}) {
  let doc = seed(); const writes = [];
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ user, app, theme }) => { localStorage.setItem('theme', theme); localStorage.setItem('userLanguage', 'en'); localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: user, appUser: app, permissions: {} })); }, { user, app, theme });
  await context.routeWebSocket(/./, ws => ws.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(base).origin) {
      if (url.pathname.startsWith('/persona_owner/')) return route.fulfill({ response: await route.fetch({ url: base + '/index.csr.html' }) });
      return route.continue();
    }
    if (url.origin !== api) return route.abort();
    const ok = data => route.fulfill({ json: { error: false, status: 200, data } });
    if (url.pathname.startsWith('/auth/access/')) {
      const allowed = url.searchParams.get('permission') === 'ai:manage' ? manage : true;
      return route.fulfill({ status: allowed ? 200 : 403, json: { error: !allowed, data: { allowed } } });
    }
    if (url.pathname === `/ai-personality/${user.id}`) {
      if (method === 'PUT') { const body = request.postDataJSON(); writes.push(body); doc = { ...doc, ...body }; }
      return ok(doc);
    }
    if (url.pathname === '/auth/session') return ok({ twitch: user, app });
    if (url.pathname.endsWith('/access')) return ok({ allowed: true, role: 'owner', planTier: 'pro' });
    return ok({});
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /TypeError|NG0/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/persona_owner/modules/ai-personality');
  await page.locator('.lf-profile').first().waitFor();
  return { context, page, writes };
}
const settle = page => page.waitForTimeout(150);
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(() => window.axe.run(document.querySelector('app-ai-personality-page'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label);
}
try {
  {
    const { context, page, writes } = await open();
    const head = page.locator('.lf-head');
    assert.match(await head.innerText(), /AI chat on[\s\S]*In chat: Chill co-host[\s\S]*Pro[\s\S]*AI memories/);
    const row = name => page.locator('.lf-profile').filter({ hasText: name });
    assert.match(await row('Chill co-host').innerText(), /In chat now[\s\S]*Reply in Spanish/);
    // Editing another personality does not switch the bot to it.
    await row('Horror night').getByRole('button', { name: 'Edit Horror night' }).click();
    await page.getByRole('heading', { name: 'Editing Horror night' }).waitFor();
    await page.getByText(/This personality isn't in chat/).waitFor();
    const prompt = page.getByRole('textbox', { name: 'How the bot talks' });
    assert.equal(await prompt.inputValue(), 'Spooky narrator voice for horror streams.');
    await prompt.fill('Spooky narrator. Whisper-y, short replies, jump-scare jokes.');
    const bar = page.locator('.lf-save-bar');
    await bar.getByText('Unsaved changes').waitFor();
    await bar.getByRole('button', { name: 'Save changes' }).click();
    await bar.getByText('All changes saved').waitFor();
    let sent = writes.at(-1);
    assert.equal(sent.activeProfileId, 'p1', 'editing did not switch the active personality');
    assert.equal(sent.personality, 'You are a chill co-host. Reply in Spanish, keep it short and never spoil games.');
    assert.equal(sent.profiles.find(p => p.profileID === 'p2').personality, 'Spooky narrator. Whisper-y, short replies, jump-scare jokes.');
    // "Use in chat" switches the bot and the header follows.
    await row('Horror night').getByRole('button', { name: 'Use Horror night in chat' }).click();
    await head.getByText('In chat: Horror night').waitFor();
    await bar.getByRole('button', { name: 'Save changes' }).click();
    await bar.getByText('All changes saved').waitFor();
    sent = writes.at(-1);
    assert.equal(sent.activeProfileId, 'p2');
    assert.equal(sent.personality, 'Spooky narrator. Whisper-y, short replies, jump-scare jokes.');
    // Style details explain they don't drive chat replies.
    await page.getByText('Style details').click();
    await page.getByText(/Chat replies currently follow only "How the bot talks"/).waitFor();
    // Rules and regulars.
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByRole('textbox', { name: 'Rule 3' }).fill('Never mention the streamer\'s city');
    await page.getByRole('button', { name: 'Remove rule 1' }).click();
    await page.getByRole('button', { name: 'Add known user' }).click();
    const users = page.locator('.lf-user');
    await users.nth(1).getByRole('textbox', { name: 'Username' }).fill('tank_mod');
    await users.nth(1).getByRole('textbox', { name: 'Who they are' }).fill('Mod');
    // Memory kinds and confidence as percentages; unused settings are not shown.
    assert.equal(await page.getByText(/Prioritize recent chat|Minimum message length/).count(), 0);
    await page.getByRole('checkbox', { name: 'Sensitive details' }).check();
    await page.getByText('Fine-tune the numbers').click();
    const skip = page.getByRole('spinbutton', { name: 'Skip review above' });
    assert.equal(await skip.inputValue(), '92');
    await skip.fill('95'); await skip.blur();
    // Discard restores the last save; then redo and save.
    await bar.getByRole('button', { name: 'Discard' }).click();
    await bar.getByText('All changes saved').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Rule 1' }).inputValue(), 'No spoilers');
    assert.equal(await page.getByRole('checkbox', { name: 'Sensitive details' }).isChecked(), false);
    await page.getByRole('textbox', { name: 'Rule 2' }).fill('Be extra kind to new chatters');
    await page.getByRole('checkbox', { name: 'Sensitive details' }).check();
    if (!(await skip.isVisible())) await page.getByText('Fine-tune the numbers').click();
    await skip.fill('95'); await skip.blur();
    await bar.getByRole('button', { name: 'Save changes' }).click();
    await bar.getByText('All changes saved').waitFor();
    sent = writes.at(-1);
    assert.deepEqual(sent.rules, ['No spoilers', 'Be extra kind to new chatters']);
    assert.equal(sent.memoryPolicy.allowSensitiveMemories, true);
    assert.equal(sent.memoryPolicy.prioritizeRecentChat, true, 'hidden setting kept as stored');
    assert.equal(sent.learningConfig.autoConfirmThreshold, 0.95);
    assert.equal(sent.learningConfig.minMessageLength, 12, 'hidden setting kept as stored');
    // Turning off learning disables the memory-kind switches.
    await page.getByRole('checkbox', { name: 'Learn from chat' }).uncheck();
    await page.waitForFunction(() => [...document.querySelectorAll('input[type=checkbox]')].some(i => i.getAttribute('aria-label') === 'Running jokes' && i.disabled));
    assert.equal(await page.getByRole('checkbox', { name: 'Delete memories forever' }).isDisabled(), true);
    await bar.getByRole('button', { name: 'Discard' }).click();
    // Deleting the personality in chat explains what happens; Escape cancels.
    await page.getByRole('button', { name: 'Delete Horror night' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete Horror night?' });
    await confirm.getByText(/switches to your first remaining personality/).waitFor();
    await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Delete Horror night' }).click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await head.getByText('In chat: Chill co-host').waitFor();
    assert.equal(await page.locator('.lf-profile').count(), 1);
    assert.equal(await page.getByRole('button', { name: /^Delete / }).count(), 0, 'last personality cannot be deleted');
    // New personality opens in the editor but does not go live.
    await page.getByRole('button', { name: 'New personality' }).click();
    await page.getByRole('heading', { name: /^Editing Profile 2/ }).waitFor();
    await head.getByText('In chat: Chill co-host').waitFor();
    await context.close();
  }
  {
    const { context, page } = await open({ manage: false });
    await page.locator('.lf-head').getByText('View only').waitFor();
    assert.equal(await page.locator('.lf-save-bar').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Use .* in chat|Add rule|New personality/ }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: 'How the bot talks' }).isDisabled(), true);
    await page.getByRole('button', { name: 'View Horror night' }).click();
    await page.getByRole('heading', { name: 'Editing Horror night' }).waitFor();
    await context.close();
  }
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280]) {
    const { context, page } = await open({ theme, width });
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${theme} ${width}`);
    await axe(page, `axe ${theme} ${width}`);
    if (width < 960) {
      const top = s => page.evaluate(sel => document.querySelector(sel).getBoundingClientRect().top, s);
      assert.ok(await top('#ai-switches-title') < await top('#ai-profiles-title'), 'phones show the on/off switches first');
    }
    if (shots && width !== 320) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/ai-personality-${theme}-${width}.png`, fullPage: true }); }
    if (width === 390 && theme === 'light') {
      await page.getByText('Style details').click();
      await page.getByText('Fine-tune the numbers').click();
      await settle(page);
      await axe(page, 'expanded details axe');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole('button', { name: 'Delete Horror night' }).click();
      await page.waitForTimeout(250);
      await axe(page, 'delete dialog axe');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS AI personality: header chat/in-use/plan chips, personalities list with in-chat marker, editing without switching, Use in chat, honest style-details note, rules + regulars editing, memory kinds, confidence as %, hidden unused settings preserved, discard, learning-off disables dependents, delete with explained consequence + Escape, new personality not live, view-only, axe + no overflow at 320/390/1280 in dark and light.');
} finally { await browser.close(); }
