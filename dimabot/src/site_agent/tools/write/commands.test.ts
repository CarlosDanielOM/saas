import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, fakeRedis, installFakeModel, type Raw } from './fake_store.testutil.js';
import type { ChangeProposal, ToolContext, ToolOutcome } from '../../types.js';

const OWNER = '1001';
const plan = { tier: 'free' as 'free' | 'premium' | 'pro' };
const redis = fakeRedis();
const keywordRefreshes: string[] = [];
const timers = new Set<string>();

mock.module('../../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => redis } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async (id: string) => ({ id, name: 'owner_login', plan_tier: plan.tier }) } });
mock.module('../../../schemas/users.schema.js', { defaultExport: { findOne: () => chain(() => ({ plan_tier: plan.tier, accounts: [] })) } });
mock.module('../../../utils/keyword_cache.js', { namedExports: { refreshKeywordIndex: async (channel: string, id?: string) => { keywordRefreshes.push(`${channel}:${id}`); } } });
mock.module('../../../schemas/custom_timer.schema.js', {
    namedExports: { CustomTimerSchema: { exists: (filter: Raw) => chain(() => (timers.has(String(filter.name)) ? { _id: 'x' } : null)) } },
});
mock.module('../effects.js', {
    namedExports: {
        describeCommandEffects: async (body: string, opts: { lang: string }) => ({
            effects: body.includes('$(ban') ? [opts.lang === 'es' ? 'Puede dar ban a espectadores' : 'Can ban viewers'] : [],
            problems: body.includes('$(nope') ? ['[Unknown function: nope]'] : [],
        }),
    },
});
mock.module('../../../utils/siteanalytics.js', { namedExports: { getCachedLiveStatus: async () => ({ isLive: false, stream: null }) } });
mock.module('../../../utils/ai/tools/stream_stats.tool.js', { namedExports: { execute: async () => ({ success: true, result: { isLive: false } }) } });
mock.module('../../../commands/timer_manager.command.js', { namedExports: { listTimers: async () => ({ error: false, timers: [] }), getTimer: async () => ({ error: true, status: 404 }) } });
mock.module('../../../classes/chat_history.js', { defaultExport: { getRecentMessages: async () => [] } });

const { CommandsSchema } = await import('../../../schemas/commands.schema.js');
const { ToolConflictError, ToolInputError } = await import('../../types.js');
const { createCommandTool, updateCommandTool, deleteCommandTool } = await import('./commands.js');

const db = installFakeModel(CommandsSchema, { defaults: { activation: 'command' }, base: { channelID: OWNER, channel: 'owner_login' } });

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        channelId: OWNER, channelLogin: 'owner_login', requester: { id: OWNER, login: 'owner_login', displayName: 'Owner' },
        role: 'owner', plan: plan.tier, lang: 'en', sessionId: 's1', turnId: 't1', callId: 'c1', userMessage: 'please',
        page: null, signal: new AbortController().signal, can: async () => true, ...overrides,
    };
}

/** Proposals and undo data travel as JSON (turn store, change log). */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function propose(tool: any, raw: unknown, context = ctx()): Promise<ChangeProposal> {
    const outcome = await tool.run(tool.validate(raw), context) as ToolOutcome;
    assert.equal(outcome.type, 'approval');
    return json((outcome as { proposal: ChangeProposal }).proposal);
}

const find = (cmd: string) => [...db.store.values()].find((raw) => raw.cmd === cmd);

beforeEach(() => {
    db.store.clear();
    redis.reset();
    keywordRefreshes.length = 0;
    timers.clear();
    plan.tier = 'free';
});

// ---------------------------------------------------------------------------
// create_command
// ---------------------------------------------------------------------------

test('create_command validates names, bodies, access and cooldown before anything else', () => {
    const v = (raw: Raw) => createCommandTool.validate(raw);
    assert.equal(v({ name: '!Dice', body: 'hi' }).name, 'dice');
    assert.deepEqual(v({ name: 'dice', body: '  hi  ' }), { name: 'dice', body: 'hi', access: 'everyone', cooldown: 10, enabled: true, description: '' });
    for (const raw of [
        { name: 'two words', body: 'x' }, { name: 'a-b', body: 'x' }, { name: '', body: 'x' }, { name: 'x'.repeat(31), body: 'x' },
        { name: 'dice', body: '' }, { name: 'dice', body: '!cc dice hi' }, { name: 'dice', body: 'x'.repeat(10_001) },
        { name: 'dice', body: 'x', cooldown: 61 }, { name: 'dice', body: 'x', cooldown: 1.5 }, { name: 'dice', body: 'x', access: 'god' },
        { name: 'dice', body: 'x', description: 'd'.repeat(201) }, { name: 'dice' },
    ]) {
        assert.throws(() => v(raw), ToolInputError, JSON.stringify(raw).slice(0, 60));
    }
});

test('create_command proposal: no side effects, built-in names refused, defaults warned, plan cooldown rules', async () => {
    const proposal = await propose(createCommandTool, { name: 'dice', body: 'You rolled $(random 1-6) $(nope)', access: 'mod', cooldown: 15, description: 'Roll' });
    assert.equal(db.store.size, 0);
    assert.equal(proposal.title, 'Create command !dice');
    assert.equal(proposal.area, 'commands');
    assert.deepEqual(proposal.target, { type: 'command', id: null, label: '!dice' });
    assert.equal(proposal.before, null);
    assert.deepEqual(proposal.after, { Command: '!dice', Reply: 'You rolled $(random 1-6) $(nope)', 'Who can use it': 'Mods and above', 'Cooldown (seconds)': 15, On: true, Description: 'Roll' });
    assert.deepEqual(proposal.warnings, ['Test run: [Unknown function: nope]']);
    assert.deepEqual(proposal.permissions, ['commands:manage']);
    assert.deepEqual(createCommandTool.permissions, ['commands:manage']);

    for (const name of ['cc', 'commands', 'mod', 'title', 'vip', 'duel']) {
        await assert.rejects(createCommandTool.run(createCommandTool.validate({ name, body: 'hi' }), ctx()), ToolInputError, name);
    }
    const so = await propose(createCommandTool, { name: 'so', body: 'hi' });
    assert.match(String(so.warnings?.[0]), /default commands/);

    await assert.rejects(createCommandTool.run(createCommandTool.validate({ name: 'x', body: 'hi', cooldown: 3 }), ctx()), /0 or 5-60/);
    plan.tier = 'pro';
    await propose(createCommandTool, { name: 'x', body: 'hi', cooldown: 1 }, ctx({ plan: 'pro' }));
    db.seed({ name: 'zero', cmd: 'zero', func: 'zero', message: 'z', cooldown: 0 });
    await assert.rejects(createCommandTool.run(createCommandTool.validate({ name: 'y', body: 'hi', cooldown: 0 }), ctx()), /0-second cooldown/);
    db.seed({ name: 'Dice', cmd: 'Dice', func: 'Dice', message: 'old' });
    await assert.rejects(createCommandTool.run(createCommandTool.validate({ name: 'dice', body: 'hi' }), ctx()), /already exists/);

    const es = await propose(createCommandTool, { name: 'ban', body: '$(ban &p1)' }, ctx({ lang: 'es' }));
    assert.equal(es.title, 'Crear comando !ban');
    assert.deepEqual(es.effects, ['Puede dar ban a espectadores']);
    assert.ok('Quién puede usarlo' in (es.after ?? {}));
});

test('create_command apply writes through the commands service; undo deletes only an unchanged command', async () => {
    const proposal = await propose(createCommandTool, { name: 'dice', body: 'roll', access: 'vip', cooldown: 20, enabled: false });
    const applied = await createCommandTool.apply!(proposal, ctx());
    const stored = find('dice')!;
    assert.ok(stored);
    assert.equal(stored.func, 'dice');
    assert.equal(stored.channel, 'owner_login');
    assert.equal(stored.userLevel, 5);
    assert.equal(stored.userLevelName, 'vip');
    assert.equal(stored.enabled, false);
    assert.equal(stored.cooldown, 20);
    assert.deepEqual(redis.deleted, [`${OWNER}:commands:dice`, `${OWNER}:commands:dice`]);
    assert.deepEqual(applied.result, { created: true, id: String(stored._id), trigger: '!dice' });
    const change = json(applied.change!);
    assert.equal(change.target.id, String(stored._id));
    assert.equal(change.before, null);

    // Someone edits it afterwards: undo refuses and keeps it.
    stored.message = 'edited by hand';
    await assert.rejects(createCommandTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /reply/.test(error.message));
    assert.ok(find('dice'));
    stored.message = 'roll';
    await createCommandTool.undo!(change, ctx());
    assert.equal(find('dice'), undefined);
    await assert.rejects(createCommandTool.undo!(change, ctx()), ToolConflictError);
});

test('create_command apply refuses when the name was taken after the proposal', async () => {
    const proposal = await propose(createCommandTool, { name: 'dice', body: 'roll' });
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'someone else' });
    await assert.rejects(createCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.equal(db.store.size, 1);
    assert.equal(find('dice')!.message, 'someone else');
});

// ---------------------------------------------------------------------------
// update_command
// ---------------------------------------------------------------------------

test('update_command proposal shows only what changes and refuses what the page would not allow', async () => {
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10, userLevel: 1, description: 'Roll' });
    db.seed({ name: 'coin', cmd: 'coin', func: 'coin', message: 'flip', cooldown: 10 });
    db.seed({ name: 'commands', cmd: 'commands', func: 'commands', message: '', reserved: true, cooldown: 10 });
    db.seed({ name: 'b', cmd: 'b', func: 'b', message: 'compiled', authoring: 'blocks', cooldown: 10 });
    db.seed({ name: 'game', cmd: 'game', func: 'game', message: '', cooldown: 10 });
    const before = structuredClone([...db.store.values()].map((raw) => ({ ...raw, _id: String(raw._id) })));

    assert.throws(() => updateCommandTool.validate({ name: 'dice' }), /Nothing to change/);
    const run = (raw: Raw) => updateCommandTool.run(updateCommandTool.validate(raw), ctx());
    await assert.rejects(run({ name: '!dice', body: 'roll' }), /nothing to change/);
    await assert.rejects(run({ name: '!missing', body: 'x' }), /No command or keyword/);
    await assert.rejects(run({ name: '!commands', body: 'x' }), /built in/);
    await assert.rejects(run({ name: '!commands', description: 'x' }), /built in/);
    await assert.rejects(run({ name: '!game', body: 'x' }), /built in/);
    await assert.rejects(run({ name: '!b', body: 'x' }), /blocks/);
    await assert.rejects(run({ name: '!dice', newName: 'coin' }), /already used/);
    await assert.rejects(run({ name: '!dice', newName: 'mod' }), /built-in command name/);
    await assert.rejects(run({ name: '!commands', cooldown: 0 }), /0-second/);

    timers.add('dice');
    const proposal = await propose(updateCommandTool, { name: 'DICE', body: '$(ban $(user)) bye', cooldown: 30 });
    assert.equal(proposal.title, 'Update command !dice');
    assert.deepEqual(proposal.before, { Command: '!dice', Reply: 'roll', 'Cooldown (seconds)': 10 });
    assert.deepEqual(proposal.after, { Command: '!dice', Reply: '$(ban $(user)) bye', 'Cooldown (seconds)': 30 });
    assert.deepEqual(proposal.effects, ['Can ban viewers']);
    assert.match(String(proposal.warnings?.join(' ')), /timer "dice" still posts/);

    const settingsOnly = await propose(updateCommandTool, { name: '!b', cooldown: 20 });
    assert.deepEqual(settingsOnly.effects, []);
    const builtIn = await propose(updateCommandTool, { name: '!commands', enabled: false, access: 'mod' });
    assert.deepEqual(builtIn.after, { Command: '!commands', 'Who can use it': 'Mods and above', On: false });
    assert.deepEqual([...db.store.values()].map((raw) => ({ ...raw, _id: String(raw._id) })), before, 'proposals never write');
});

test('update_command apply: compare-and-set against the proposal and against edits racing the write', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const proposal = await propose(updateCommandTool, { name: '!dice', body: 'new roll', enabled: false });

    dice.cooldown = 25; // changed by hand after the proposal
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /cooldown/.test(error.message));
    assert.equal(dice.message, 'roll');

    dice.cooldown = 10;
    db.beforeNextWrite(() => { dice.message = 'sneaky'; }); // lands between the re-read and the write
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.equal(dice.message, 'sneaky');

    dice.message = 'roll';
    const applied = await updateCommandTool.apply!(proposal, ctx());
    assert.equal(dice.message, 'new roll');
    assert.equal(dice.enabled, false);
    assert.deepEqual(applied.result, { updated: true, id: String(dice._id), trigger: '!dice' });

    const change = json(applied.change!);
    dice.enabled = true; // someone turned it back on: undo refuses
    await assert.rejects(updateCommandTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /on\/off/.test(error.message));
    dice.enabled = false;
    await updateCommandTool.undo!(change, ctx());
    assert.equal(dice.message, 'roll');
    assert.equal(dice.enabled, true);
});

test('update_command rename keeps a matching display name in step, and undo renames back', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll' });
    const proposal = await propose(updateCommandTool, { name: '!dice', newName: '!Die' });
    assert.deepEqual(proposal.after, { Command: '!die' });
    const applied = await updateCommandTool.apply!(proposal, ctx());
    assert.equal(dice.cmd, 'die');
    assert.equal(dice.name, 'die');
    assert.equal(dice.func, 'dice', 'the reply keeps running as before');
    assert.deepEqual(redis.deleted.slice(-2), [`${OWNER}:commands:dice`, `${OWNER}:commands:die`]);
    assert.equal(applied.change!.target.label, '!die');
    await updateCommandTool.undo!(json(applied.change!), ctx());
    assert.equal(dice.cmd, 'dice');
    assert.equal(dice.name, 'dice');
});

test('update_command access on a custom-rule command switches to a level; undo puts the rule back', async () => {
    const rule = { role: 'vip' };
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', userLevel: 1, permissionExpression: rule });
    const proposal = await propose(updateCommandTool, { name: '!dice', access: 'mod' });
    assert.match(String(proposal.warnings?.[0]), /custom access rule/);
    assert.deepEqual(proposal.before, { Command: '!dice', 'Who can use it': 'Custom rule (set on the Commands page)' });
    const applied = await updateCommandTool.apply!(proposal, ctx());
    assert.equal(dice.permissionExpression, null);
    assert.equal(dice.userLevel, 7);
    await updateCommandTool.undo!(json(applied.change!), ctx());
    assert.deepEqual(dice.permissionExpression, rule);
});

test('update_command on keywords: trigger normalized, cooldown minimum, index refreshed', async () => {
    db.seed({ name: 'hi', cmd: 'hello', func: 'custom', message: 'hey', activation: 'keyword', keywordSettings: { matchMode: 'start' }, cooldown: 10 });
    await assert.rejects(updateCommandTool.run(updateCommandTool.validate({ name: 'hello', cooldown: 0 }), ctx()), /at least 5/);
    const proposal = await propose(updateCommandTool, { name: 'hello', kind: 'keyword', newName: 'Hello  There' });
    assert.equal(proposal.title, 'Update keyword "hello"');
    assert.deepEqual(proposal.after, { Keyword: '"hello there"' });
    await updateCommandTool.apply!(proposal, ctx());
    assert.ok(find('hello there'));
    assert.equal(keywordRefreshes.length, 1);
});

// ---------------------------------------------------------------------------
// delete_command
// ---------------------------------------------------------------------------

test('delete_command: built-ins refused, compare-and-set, undo restores the same command', async () => {
    db.seed({ name: 'commands', cmd: 'commands', func: 'commands', reserved: true });
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', count: 7, cooldown: 0 });
    await assert.rejects(deleteCommandTool.run(deleteCommandTool.validate({ name: '!commands' }), ctx()), /can't be deleted/);
    timers.add('dice');
    const proposal = await propose(deleteCommandTool, { name: '!dice' });
    assert.equal(proposal.title, 'Delete command !dice');
    assert.equal(proposal.after, null);
    assert.equal((proposal.before as Raw).Reply, 'roll');
    assert.match(String(proposal.warnings?.[0]), /not deleted/);
    assert.equal(db.store.size, 2);

    dice.message = 'changed';
    await assert.rejects(deleteCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.ok(find('dice'));
    dice.message = 'roll';
    const applied = await deleteCommandTool.apply!(proposal, ctx());
    assert.equal(find('dice'), undefined);

    const change = json(applied.change!);
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'new one' });
    await assert.rejects(deleteCommandTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /already uses !dice/.test(error.message));
    db.store.delete(String(find('dice')!._id));
    await deleteCommandTool.undo!(change, ctx());
    const restored = find('dice')!;
    assert.equal(String(restored._id), String(dice._id));
    assert.equal(restored.count, 7);
    assert.equal(restored.cooldown, 0);
});

test('update_command: the write guard covers the access rule and the editor too (edits racing the write win)', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10, userLevel: 1, permissionExpression: null });
    const proposal = await propose(updateCommandTool, { name: '!dice', access: 'mod' });
    db.beforeNextWrite(() => { dice.permissionExpression = { role: 'vip' }; }); // set on the page between the re-read and the write
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.deepEqual(dice.permissionExpression, { role: 'vip' }, 'the access rule set meanwhile survives');
    assert.equal(dice.userLevel, 1);

    dice.permissionExpression = null;
    db.beforeNextWrite(() => { dice.authoring = 'blocks'; });
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.equal(dice.userLevel, 1);
});
