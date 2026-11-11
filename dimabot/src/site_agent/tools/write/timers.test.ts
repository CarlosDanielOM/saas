import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, fakeRedis, installFakeModel } from './fake_store.testutil.js';
import type { ChangeProposal, ToolContext, ToolOutcome } from '../../types.js';

const OWNER = '1001';
const plan = { tier: 'free' as 'free' | 'premium' | 'pro' };
const redis = fakeRedis();

mock.module('../../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => redis } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async (id: string) => ({ id, name: 'owner_login', plan_tier: plan.tier }) } });
mock.module('../../../functions/channels/is_live.channel.js', { namedExports: { isLive: async () => ({ error: false, data: [] }) } });
mock.module('../../../schemas/users.schema.js', { defaultExport: { findOne: () => chain(() => null) } });
mock.module('../../../utils/keyword_cache.js', { namedExports: { refreshKeywordIndex: async () => {} } });
mock.module('../effects.js', {
    namedExports: {
        describeCommandEffects: async (body: string) => ({ effects: body.includes('$(tts') ? ['Speaks on stream with TTS'] : [], problems: [] }),
    },
});
mock.module('../../../utils/siteanalytics.js', { namedExports: { getCachedLiveStatus: async () => ({ isLive: false, stream: null }) } });
mock.module('../../../utils/ai/tools/stream_stats.tool.js', { namedExports: { execute: async () => ({ success: true, result: {} }) } });
mock.module('../../../classes/chat_history.js', { defaultExport: { getRecentMessages: async () => [] } });

const { CustomTimerSchema } = await import('../../../schemas/custom_timer.schema.js');
const { CommandsSchema } = await import('../../../schemas/commands.schema.js');
const { ToolConflictError, ToolInputError } = await import('../../types.js');
const { updateTimerTool, deleteTimerTool, timerTools, retiredCreateTimerTool, retiredTimerTools } = await import('./timers.js');

const db = installFakeModel(CustomTimerSchema, { base: { channelID: OWNER, channel: 'owner_login', frequencyUnit: 'minutes', active: true }, unique: [['channelID', 'name']] });
/** Commands of the channel: a timer named like one is that command's repeat. */
const commands = installFakeModel(CommandsSchema, { defaults: { activation: 'command' }, base: { channelID: OWNER, channel: 'owner_login' } });

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        channelId: OWNER, channelLogin: 'owner_login', requester: { id: OWNER, login: 'owner_login', displayName: 'Owner' },
        role: 'owner', plan: plan.tier, lang: 'en', sessionId: 's1', turnId: 't1', callId: 'c1', userMessage: 'please',
        page: null, signal: new AbortController().signal, can: async () => true, ...overrides,
    };
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function propose(tool: any, raw: unknown, context = ctx()): Promise<ChangeProposal> {
    const outcome = await tool.run(tool.validate(raw), context) as ToolOutcome;
    assert.equal(outcome.type, 'approval');
    return json((outcome as { proposal: ChangeProposal }).proposal);
}
const find = (name: string) => [...db.store.values()].find((raw) => raw.name === name);

beforeEach(() => { db.store.clear(); commands.store.clear(); redis.reset(); plan.tier = 'free'; });

test('timer tools validate names, messages and that something changes; there is no create tool', () => {
    assert.equal(updateTimerTool.validate({ name: '!Discord', minutes: 10 }).name, 'discord');
    for (const raw of [{ name: 'two words', minutes: 10 }, { name: 'a-b', minutes: 10 }, { name: 'ok', minutes: 0 }, { name: 'ok', message: '' }, { name: 'ok', message: 'x'.repeat(351) }]) {
        assert.throws(() => updateTimerTool.validate(raw), ToolInputError, JSON.stringify(raw));
    }
    assert.throws(() => updateTimerTool.validate({ name: 'ok' }), /Nothing to change/);
    assert.deepEqual(updateTimerTool.permissions, ['commands:manage']);
    assert.deepEqual(deleteTimerTool.permissions, ['commands:manage']);
    // The website lists a repeating message only as a command, so new ones are made by the command tools.
    assert.deepEqual(timerTools.map((tool) => tool.name), ['update_timer', 'delete_timer']);
});

test('a command\'s repeat: cards speak about the command, its text follows the command, stand-alone timers say they are unlisted', async () => {
    commands.seed({ cmd: 'Discord', name: 'Discord', func: 'Discord', message: 'Join' });
    commands.seed({ cmd: 'commands', name: 'commands', func: 'commands', message: '', reserved: true });
    db.seed({ name: 'discord', message: 'Join', frequency: 10 });
    db.seed({ name: 'commands', message: 'made in chat', frequency: 10 });
    db.seed({ name: 'promo', message: 'Buy', frequency: 10 });
    const run = (raw: object) => updateTimerTool.run(updateTimerTool.validate(raw), ctx());

    await assert.rejects(run({ name: 'discord', message: 'Other text' }), /repeat of !Discord.*update_command/);
    const pause = await propose(updateTimerTool, { name: 'discord', enabled: false });
    assert.equal(pause.title, 'Pause the repeat of !Discord');
    assert.equal(pause.warnings, undefined);
    assert.equal((await propose(updateTimerTool, { name: 'discord', minutes: 20 })).title, 'Change the repeat of !Discord');
    const stop = await propose(deleteTimerTool, { name: 'discord' });
    assert.equal(stop.title, 'Stop repeating !Discord');
    assert.match(stop.warnings![0], /!Discord itself stays/);

    // No command (or only a built-in one) with that name: a stand-alone timer, editable in full.
    for (const name of ['promo', 'commands']) {
        const edit = await propose(updateTimerTool, { name, message: 'New text' });
        assert.equal(edit.title, `Update timer "${name}"`);
        assert.match(edit.warnings![0], /Commands page does not list it/);
    }
    assert.match((await propose(deleteTimerTool, { name: 'promo' })).warnings![0], /Commands page does not list it/);
    await assert.rejects(run({ name: 'missing', enabled: false }), /No timer.*repeatMinutes/);
});

test('update_timer: only changes shown, grandfathered intervals, compare-and-set, undo', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 10 });
    const run = (raw: object) => updateTimerTool.run(updateTimerTool.validate(raw), ctx());
    await assert.rejects(run({ name: 'discord', minutes: 10 }), /nothing to change/);
    await assert.rejects(run({ name: 'missing', enabled: false }), /No timer/);
    await assert.rejects(run({ name: 'discord', minutes: 15 }), /Free timers/);

    const off = await propose(updateTimerTool, { name: 'discord', enabled: false });
    assert.equal(off.title, 'Turn off timer "discord"');
    assert.match(off.warnings![0], /made in chat/);
    assert.deepEqual(off.before, { Timer: 'discord', On: true });
    assert.deepEqual(off.after, { Timer: 'discord', On: false });

    const proposal = await propose(updateTimerTool, { name: 'discord', minutes: 30, message: 'Join us', enabled: false });
    assert.deepEqual(proposal.after, { Timer: 'discord', 'Every (minutes)': 30, Message: 'Join us', On: false });
    timer.message = 'changed by hand';
    await assert.rejects(updateTimerTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /message/.test(error.message));
    assert.equal(timer.frequency, 10);
    timer.message = 'Join';
    const applied = await updateTimerTool.apply!(proposal, ctx());
    assert.equal(timer.frequency, 30);
    assert.equal(timer.message, 'Join us');
    assert.equal(timer.active, false);

    const change = json(applied.change!);
    timer.active = true;
    await assert.rejects(updateTimerTool.undo!(change, ctx()), ToolConflictError);
    timer.active = false;
    await updateTimerTool.undo!(change, ctx());
    assert.equal(timer.frequency, 10);
    assert.equal(timer.message, 'Join');
    assert.equal(timer.active, true);

    // Interval the plan no longer allows: other edits need a valid interval too.
    const legacy = db.seed({ name: 'old', message: 'x', frequency: 7 });
    await assert.rejects(run({ name: 'old', message: 'y' }), /no longer allows/);
    await propose(updateTimerTool, { name: 'old', enabled: false });
    assert.equal(legacy.frequency, 7);
});

test('delete_timer: compare-and-set, undo recreates it (off stays off), refuses when the name is taken', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 20, active: false });
    const proposal = await propose(deleteTimerTool, { name: 'discord' });
    assert.equal(proposal.title, 'Delete timer "discord"');
    assert.equal(proposal.after, null);
    assert.deepEqual(proposal.before, { Timer: 'discord', 'Every (minutes)': 20, Message: 'Join', On: false });
    timer.frequency = 30;
    await assert.rejects(deleteTimerTool.apply!(proposal, ctx()), ToolConflictError);
    timer.frequency = 20;
    const applied = await deleteTimerTool.apply!(proposal, ctx());
    assert.equal(find('discord'), undefined);

    const change = json(applied.change!);
    db.seed({ name: 'discord', message: 'another', frequency: 10 });
    await assert.rejects(deleteTimerTool.undo!(change, ctx()), /exists again/);
    db.store.clear();
    await deleteTimerTool.undo!(change, ctx());
    const restored = find('discord')!;
    assert.equal(restored.message, 'Join');
    assert.equal(restored.frequency, 20);
    assert.equal(restored.active, false);
});

// Compare-and-set inside the write: an edit that lands between the tool's re-read and its write wins.

test('update_timer: interval, message and on/off land in one guarded write; an edit in between wins', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 10 });
    const proposal = await propose(updateTimerTool, { name: 'discord', minutes: 30, message: 'Join us', enabled: false });
    db.beforeNextWrite(() => { timer.message = 'edited on the page'; });
    await assert.rejects(updateTimerTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /message/.test(error.message));
    assert.equal(timer.message, 'edited on the page', 'the concurrent edit survives');
    assert.equal(timer.frequency, 10, 'nothing of the proposal was written');
    assert.equal(timer.active, true);

    timer.message = 'Join';
    const change = json((await updateTimerTool.apply!(proposal, ctx())).change!);
    assert.deepEqual([timer.frequency, timer.message, timer.active], [30, 'Join us', false]);
    db.beforeNextWrite(() => { timer.frequency = 40; });
    await assert.rejects(updateTimerTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /interval/.test(error.message));
    assert.deepEqual([timer.frequency, timer.message, timer.active], [40, 'Join us', false], 'undo wrote nothing');
});

test('delete_timer deletes only the timer it checked', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 20 });
    const proposal = await propose(deleteTimerTool, { name: 'discord' });
    db.beforeNextWrite(() => { timer.message = 'new text'; });
    await assert.rejects(deleteTimerTool.apply!(proposal, ctx()), ToolConflictError);
    assert.equal(find('discord')?.message, 'new text', 'the edited timer was not deleted');
});

test('delete_timer undo puts the timer back in one write: off stays off at the plan limit, an old interval is kept', async () => {
    db.seed({ name: 'old', message: 'Join', frequency: 7, active: false }); // 7 minutes: not a Free interval any more
    const change = json((await deleteTimerTool.apply!(await propose(deleteTimerTool, { name: 'old' }), ctx())).change!);
    for (let i = 0; i < 5; i++) db.seed({ name: `t${i}`, message: 'm', frequency: 10 }); // the plan's 5 enabled timers
    let writes = 0;
    db.beforeNextWrite(() => { writes++; }, () => { writes++; return false; });
    await deleteTimerTool.undo!(change, ctx());
    assert.equal(writes, 1, 'created already switched off: no second write that could fail after the first');
    assert.deepEqual([find('old')!.frequency, find('old')!.active], [7, false]);

    // An enabled timer needs room again: refused before anything is written.
    db.seed({ name: 'promo', message: 'Buy', frequency: 10 });
    find('t0')!.active = false;
    const enabled = json((await deleteTimerTool.apply!(await propose(deleteTimerTool, { name: 'promo' }), ctx())).change!);
    find('t0')!.active = true;
    await assert.rejects(deleteTimerTool.undo!(enabled, ctx()), (error: unknown) => error instanceof ToolConflictError && /can't be restored: Timer limit reached/.test(error.message));
    assert.equal(find('promo'), undefined);
});

test('a timer named like a display name is stand-alone when that command has a repeat under its own trigger', async () => {
    commands.seed({ cmd: 'mycode', name: 'legacy', func: 'mycode', message: 'Use my code' });
    db.seed({ name: 'mycode', message: 'Use my code', frequency: 10 });
    db.seed({ name: 'legacy', message: 'made in chat', frequency: 10 });
    const edit = await propose(updateTimerTool, { name: 'legacy', message: 'New text' });
    assert.equal(edit.title, 'Update timer "legacy"');
    assert.match(edit.warnings![0], /Commands page does not list it/);
    await assert.rejects(updateTimerTool.run(updateTimerTool.validate({ name: 'mycode', message: 'x' }), ctx()), /repeat of !mycode/);
    // Without the trigger-named timer, the display-name one is the command's repeat (older data).
    db.store.delete(String(find('mycode')!._id));
    await assert.rejects(updateTimerTool.run(updateTimerTool.validate({ name: 'legacy', message: 'x' }), ctx()), /repeat of !mycode/);
});

test('create_timer is retired: never offered or run, but a change it made before can still be undone', async () => {
    // Offered tools come from timerTools; the registry keeps retired ones for undo only (checked end to end in ops/checks/site-agent-api.mjs).
    assert.ok(!timerTools.includes(retiredCreateTimerTool as never));
    assert.deepEqual(retiredTimerTools.map((tool) => tool.name), ['create_timer']);
    assert.throws(() => retiredCreateTimerTool.validate({ name: 'a', minutes: 10, message: 'x' }), /retired.*repeatMinutes/);
    assert.equal(retiredCreateTimerTool.apply, undefined);

    // The undo data of a record written while the tool existed.
    const stored = db.seed({ name: 'referral', message: 'Use my code', frequency: 20 });
    const change = json({ undo: { op: 'create', name: 'referral', expected: { id: String(stored._id), name: 'referral', message: 'Use my code', minutes: 20, active: true } }, after: null, target: { type: 'timer', id: String(stored._id), label: '"referral"' } });
    stored.message = 'edited since';
    await assert.rejects(retiredCreateTimerTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /message/.test(error.message));
    stored.message = 'Use my code';
    await retiredCreateTimerTool.undo!(change, ctx());
    assert.equal(find('referral'), undefined);
    await assert.rejects(retiredCreateTimerTool.undo!(change, ctx()), /already deleted/);
});
