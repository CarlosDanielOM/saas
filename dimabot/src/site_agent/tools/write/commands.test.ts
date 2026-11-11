import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, fakeRedis, installFakeModel, type Raw } from './fake_store.testutil.js';
import type { ChangeProposal, ToolContext, ToolOutcome } from '../../types.js';

const OWNER = '1001';
const plan = { tier: 'free' as 'free' | 'premium' | 'pro' };
const redis = fakeRedis();
const keywordRefreshes: string[] = [];

mock.module('../../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => redis } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async (id: string) => ({ id, name: 'owner_login', plan_tier: plan.tier }) } });
mock.module('../../../schemas/users.schema.js', { defaultExport: { findOne: () => chain(() => ({ plan_tier: plan.tier, accounts: [] })) } });
mock.module('../../../utils/keyword_cache.js', { namedExports: { refreshKeywordIndex: async (channel: string, id?: string) => { keywordRefreshes.push(`${channel}:${id}`); } } });
mock.module('../../../functions/channels/is_live.channel.js', { namedExports: { isLive: async () => ({ error: false, data: [] }) } });
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
mock.module('../../../classes/chat_history.js', { defaultExport: { getRecentMessages: async () => [] } });

const { CommandsSchema } = await import('../../../schemas/commands.schema.js');
const { CustomTimerSchema } = await import('../../../schemas/custom_timer.schema.js');
const { ToolConflictError, ToolInputError } = await import('../../types.js');
const { createCommandTool, updateCommandTool, deleteCommandTool } = await import('./commands.js');

const db = installFakeModel(CommandsSchema, { defaults: { activation: 'command' }, base: { channelID: OWNER, channel: 'owner_login' } });
/** Timers: the one named like a command is that command's repeat. */
const timerDb = installFakeModel(CustomTimerSchema, { base: { channelID: OWNER, channel: 'owner_login', frequencyUnit: 'minutes', active: true }, unique: [['channelID', 'name']] });
const timer = (name: string) => [...timerDb.store.values()].find((raw) => raw.name === name);

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
    timerDb.store.clear();
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

test('update_command: a text body replaces a block reply (warned), and undo puts the blocks back', async () => {
    const blocks = { type: 'root', children: [{ type: 'text', text: 'hi' }] };
    db.seed({ name: 'b', cmd: 'b', func: 'b', message: 'compiled from blocks', authoring: 'blocks', blocks, cooldown: 10 });
    const proposal = await propose(updateCommandTool, { name: '!b', body: 'Hello $(user)' });
    assert.match(String(proposal.warnings?.join(' ')), /replaces its blocks/);
    assert.deepEqual(proposal.before, { Command: '!b', Reply: 'compiled from blocks', Editor: 'Blocks' });
    assert.deepEqual(proposal.after, { Command: '!b', Reply: 'Hello $(user)', Editor: 'Text' });
    assert.equal((proposal.payload as { changes: { fromBlocks?: boolean } }).changes.fromBlocks, true);
    const applied = await updateCommandTool.apply!(proposal, ctx());
    const row = [...db.store.values()].find((raw) => raw.cmd === 'b')!;
    assert.equal(row.authoring, 'text');
    assert.equal(row.message, 'Hello $(user)');
    const restore = (applied.change!.undo as { restore: Record<string, unknown> }).restore;
    assert.equal(restore.authoring, 'blocks');
    assert.deepEqual(restore.blocks, blocks, 'undo sends the original blocks back to the service');
});

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
    await assert.rejects(run({ name: '!dice', newName: 'coin' }), /already used/);
    await assert.rejects(run({ name: '!dice', newName: 'mod' }), /built-in command name/);
    await assert.rejects(run({ name: '!commands', cooldown: 0 }), /0-second/);

    // A repeat with its own text (not a copy of the reply) is left alone, and the card says so.
    timerDb.seed({ name: 'dice', message: 'own text', frequency: 10 });
    const proposal = await propose(updateCommandTool, { name: 'DICE', body: '$(ban $(user)) bye', cooldown: 30 });
    assert.equal(proposal.title, 'Update command !dice');
    assert.deepEqual(proposal.before, { Command: '!dice', Reply: 'roll', 'Cooldown (seconds)': 10 });
    assert.deepEqual(proposal.after, { Command: '!dice', Reply: '$(ban $(user)) bye', 'Cooldown (seconds)': 30 });
    assert.deepEqual(proposal.effects, ['Can ban viewers']);
    assert.match(String(proposal.warnings?.join(' ')), /repeat of !dice posts its own text/);
    // Nothing moves, but Apply still checks the repeat is as it was (the reply change counted on it).
    const expectedRepeat = (proposal.payload as Raw).repeat;
    assert.deepEqual([expectedRepeat.from.message, expectedRepeat.to.message, expectedRepeat.from.minutes, expectedRepeat.to.minutes], ['own text', 'own text', 10, 10]);

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
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20, active: false });
    const proposal = await propose(deleteCommandTool, { name: '!dice' });
    assert.equal(proposal.title, 'Delete command !dice');
    assert.equal(proposal.after, null);
    assert.equal((proposal.before as Raw).Reply, 'roll');
    assert.equal((proposal.before as Raw).Repeats, 'Every 20 minutes (paused)');
    assert.match(String(proposal.warnings?.[0]), /Its repeat \(every 20 minutes \(paused\)\) is removed too/);
    assert.equal(db.store.size, 2);

    dice.message = 'changed';
    await assert.rejects(deleteCommandTool.apply!(proposal, ctx()), ToolConflictError);
    assert.ok(find('dice'));
    dice.message = 'roll';
    const applied = await deleteCommandTool.apply!(proposal, ctx());
    assert.equal(find('dice'), undefined);
    assert.equal(timer('dice'), undefined, 'the repeat goes with its command, so nothing keeps posting unseen');

    const change = json(applied.change!);
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'new one' });
    await assert.rejects(deleteCommandTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /already uses !dice/.test(error.message));
    assert.equal(timer('dice'), undefined, 'a refused undo leaves no repeat behind');
    db.store.delete(String(find('dice')!._id));
    await deleteCommandTool.undo!(change, ctx());
    const restored = find('dice')!;
    assert.equal(String(restored._id), String(dice._id));
    assert.equal(restored.count, 7);
    assert.equal(restored.cooldown, 0);
    assert.deepEqual([timer('dice')!.message, timer('dice')!.frequency, timer('dice')!.active], ['roll', 20, false]);
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

// ---------------------------------------------------------------------------
// A command's repeat (the "Repeating" tab of the commands page)
// ---------------------------------------------------------------------------

test('create_command repeatMinutes: one card makes the command and its repeat; undo removes both', async () => {
    const run = (raw: Raw, context = ctx()) => createCommandTool.run(createCommandTool.validate(raw), context);
    await assert.rejects(run({ name: 'referral', body: 'Use my code', repeatMinutes: 17 }), /Free timers/);
    await assert.rejects(run({ name: 'señal', body: 'hola', repeatMinutes: 20 }), /a-z, 0-9 or _/);
    await assert.rejects(run({ name: 'referral', body: 'x'.repeat(351), repeatMinutes: 20 }), /at most 350 characters and this reply has 351/);
    for (let i = 0; i < 5; i++) timerDb.seed({ name: `t${i}`, message: 'm', frequency: 10 });
    await assert.rejects(run({ name: 'referral', body: 'Use my code', repeatMinutes: 20 }), /limit reached \(5/);
    timerDb.store.clear();
    assert.equal(createCommandTool.validate({ name: 'a', body: 'b' }).repeatMinutes, undefined);
    assert.throws(() => createCommandTool.validate({ name: 'a', body: 'b', repeatMinutes: 0 }), ToolInputError);

    plan.tier = 'pro';
    const pro = ctx({ plan: 'pro' });
    const proposal = await propose(createCommandTool, { name: 'referral', body: 'Use my code', repeatMinutes: 17 }, pro);
    assert.equal(proposal.title, 'Create command !referral');
    assert.equal((proposal.after as Raw).Repeats, 'Every 17 minutes');
    assert.deepEqual(proposal.effects, ['Posts by itself every 17 minutes while you are live']);
    assert.equal(db.store.size + timerDb.store.size, 0, 'a proposal writes nothing');

    const applied = await createCommandTool.apply!(proposal, pro);
    assert.equal(find('referral')!.message, 'Use my code');
    assert.deepEqual([timer('referral')!.message, timer('referral')!.frequency, timer('referral')!.active], ['Use my code', 17, true]);
    assert.equal((applied.result as Raw).repeatsEveryMinutes, 17);

    const change = json(applied.change!);
    timer('referral')!.frequency = 30; // changed on the Commands page afterwards
    await assert.rejects(createCommandTool.undo!(change, pro), (error: unknown) => error instanceof ToolConflictError && /repeat of !referral changed after the assistant's change/.test(error.message));
    assert.ok(find('referral'), 'a refused undo keeps the command');
    timer('referral')!.frequency = 17;
    await createCommandTool.undo!(change, pro);
    assert.equal(find('referral'), undefined);
    assert.equal(timer('referral'), undefined);
});

test('create_command: a repeat that cannot be saved takes the new command back out', async () => {
    const proposal = await propose(createCommandTool, { name: 'referral', body: 'Use my code', repeatMinutes: 20 });
    for (let i = 0; i < 5; i++) timerDb.seed({ name: `t${i}`, message: 'm', frequency: 10 }); // the plan limit fills up before Apply
    await assert.rejects(createCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /could not be saved \(Timer limit reached.*nothing was changed/.test(error.message));
    assert.equal(find('referral'), undefined);
    assert.equal(timer('referral'), undefined);
});

test('create_command adopts a stand-alone timer with the same name (made in chat) as its repeat', async () => {
    timerDb.seed({ name: 'referral', message: 'old chat text', frequency: 10 });
    // Without repeatMinutes the timer is left alone; the card says it will show as the repeat.
    const plain = await propose(createCommandTool, { name: 'referral', body: 'Use my code' });
    assert.match(String(plain.warnings?.[0]), /already exists \(every 10 minutes\)/);
    assert.equal((plain.after as Raw).Repeats, 'Every 10 minutes');
    assert.equal((plain.payload as Raw).repeat, undefined);

    const proposal = await propose(createCommandTool, { name: 'referral', body: 'Use my code', repeatMinutes: 20 });
    const applied = await createCommandTool.apply!(proposal, ctx());
    assert.equal(timerDb.store.size, 1, 'the same timer, not a second one');
    assert.deepEqual([timer('referral')!.message, timer('referral')!.frequency], ['Use my code', 20]);
    await createCommandTool.undo!(json(applied.change!), ctx());
    assert.equal(find('referral'), undefined);
    assert.deepEqual([timer('referral')!.message, timer('referral')!.frequency], ['old chat text', 10], 'undo gives the chat-made timer back as it was');
});

test('update_command repeatMinutes: start, change and stop a repeat; only custom commands can repeat', async () => {
    db.seed({ name: 'commands', cmd: 'commands', func: 'commands', reserved: true });
    db.seed({ name: 'hi', cmd: 'hello there', func: 'custom', message: 'hey', activation: 'keyword', keywordSettings: { matchMode: 'start' } });
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const run = (raw: Raw) => updateCommandTool.run(updateCommandTool.validate(raw), ctx());
    await assert.rejects(run({ name: '!commands', repeatMinutes: 10 }), /can't repeat/);
    await assert.rejects(run({ name: 'hello there', kind: 'keyword', repeatMinutes: 10 }), /can't repeat/);
    await assert.rejects(run({ name: '!dice', repeatMinutes: 15 }), /Free timers/);
    await assert.rejects(run({ name: '!dice', repeatMinutes: 0 }), /nothing to change/);

    const start = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 20 });
    assert.equal(start.title, 'Repeat !dice every 20 minutes');
    assert.deepEqual(start.before, { Command: '!dice', Repeats: 'No' });
    assert.deepEqual(start.after, { Command: '!dice', Repeats: 'Every 20 minutes' });
    assert.deepEqual(start.effects, ['Posts by itself every 20 minutes while you are live']);
    const started = json((await updateCommandTool.apply!(start, ctx())).change!);
    assert.deepEqual([timer('dice')!.message, timer('dice')!.frequency], ['roll', 20]);
    assert.equal(dice.message, 'roll', 'the command itself is not rewritten');
    await assert.rejects(run({ name: '!dice', repeatMinutes: 20 }), /nothing to change/);

    const change = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 30 });
    assert.equal(change.title, 'Change the repeat of !dice');
    assert.deepEqual(change.after, { Command: '!dice', Repeats: 'Every 30 minutes' });
    const changed = json((await updateCommandTool.apply!(change, ctx())).change!);
    assert.equal(timer('dice')!.frequency, 30);

    const stop = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 0 });
    assert.equal(stop.title, 'Stop repeating !dice');
    const stopped = json((await updateCommandTool.apply!(stop, ctx())).change!);
    assert.equal(timer('dice'), undefined);
    assert.ok(find('dice'));

    // Each step undoes on its own, newest first.
    await updateCommandTool.undo!(stopped, ctx());
    assert.equal(timer('dice')!.frequency, 30);
    await updateCommandTool.undo!(changed, ctx());
    assert.equal(timer('dice')!.frequency, 20);
    await updateCommandTool.undo!(started, ctx());
    assert.equal(timer('dice'), undefined);
});

test('update_command: the repeat follows a new reply and a new name, and undo puts both back', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
    const proposal = await propose(updateCommandTool, { name: '!dice', body: 'roll again', newName: 'roll' });
    assert.deepEqual(proposal.before, { Command: '!dice', Reply: 'roll' });
    assert.deepEqual(proposal.after, { Command: '!roll', Reply: 'roll again' });
    assert.equal(proposal.warnings, undefined);
    const applied = await updateCommandTool.apply!(proposal, ctx());
    assert.equal(dice.cmd, 'roll');
    assert.equal(timer('dice'), undefined);
    assert.deepEqual([timer('roll')!.message, timer('roll')!.frequency], ['roll again', 20]);

    await updateCommandTool.undo!(json(applied.change!), ctx());
    assert.deepEqual([dice.cmd, dice.message], ['dice', 'roll']);
    assert.equal(timer('roll'), undefined);
    assert.deepEqual([timer('dice')!.message, timer('dice')!.frequency], ['roll', 20]);

    // A reply too long to repeat is refused before anything is proposed.
    await assert.rejects(updateCommandTool.run(updateCommandTool.validate({ name: '!dice', body: 'x'.repeat(351) }), ctx()), /at most 350 characters/);
    // The repeat changed on the page after the proposal: nothing is written, the command included.
    const late = await propose(updateCommandTool, { name: '!dice', body: 'third' });
    timer('dice')!.frequency = 30;
    await assert.rejects(updateCommandTool.apply!(late, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeat "dice" changed since/.test(error.message));
    assert.equal(dice.message, 'roll');
});

// ---------------------------------------------------------------------------
// Repeat + command stay all or nothing (review findings, 2026-11-11)
// ---------------------------------------------------------------------------

/** Runs `fn` on the nth timer write from now (1 = the next one). */
function onTimerWrite(nth: number, fn: () => void): void {
    let seen = 0;
    timerDb.beforeNextWrite(fn, () => ++seen === nth);
}

test('a timer write that lands and then reports a failure (live cache down) still counts, and the command is made', async () => {
    const proposal = await propose(createCommandTool, { name: 'referral', body: 'Use my code', repeatMinutes: 20 });
    const sIsMember = redis.sIsMember;
    let failed = false;
    redis.sIsMember = async () => { if (!failed) { failed = true; throw new Error('dragonfly down'); } return false; };
    try {
        const applied = await createCommandTool.apply!(proposal, ctx());
        assert.ok(failed, 'the cache failure happened after the timer was stored');
        assert.ok(find('referral'), 'the command was created');
        assert.deepEqual([timer('referral')!.message, timer('referral')!.frequency], ['Use my code', 20]);
        await createCommandTool.undo!(json(applied.change!), ctx());
        assert.equal(find('referral'), undefined);
        assert.equal(timer('referral'), undefined);
    } finally {
        redis.sIsMember = sIsMember;
    }
});

test('a refused command write moves the repeat back, so "not applied" means nothing changed', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
    const proposal = await propose(updateCommandTool, { name: '!dice', newName: 'roll' });
    db.seed({ name: 'roll', cmd: 'roll', func: 'roll', message: 'taken meanwhile' }); // someone takes the new name before Apply
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError);
    assert.equal(dice.cmd, 'dice');
    assert.deepEqual([timer('dice')?.message, timer('dice')?.frequency, timer('roll')], ['roll', 20, undefined], 'the repeat is back under the old name');
});

test('undo of a rename that can no longer be put back leaves the repeat with the renamed command', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
    const applied = await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!dice', newName: 'roll' }), ctx());
    assert.equal(dice.cmd, 'roll');
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'a new, ordinary !dice' });
    await assert.rejects(updateCommandTool.undo!(json(applied.change!), ctx()), (error: unknown) => error instanceof ToolConflictError);
    assert.equal(dice.cmd, 'roll', 'the command keeps its new name');
    assert.deepEqual([timer('roll')?.frequency, timer('dice')], [20, undefined], 'and its repeat did not jump to the other !dice');
});

test('a repeat that cannot be moved back is reported as an unknown outcome, never as "nothing changed"', async () => {
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
    const proposal = await propose(updateCommandTool, { name: '!dice', newName: 'roll' });
    db.seed({ name: 'roll', cmd: 'roll', func: 'roll', message: 'taken meanwhile' });
    // Write 1 renames the timer; before write 2 (moving it back) someone edits it on the page.
    onTimerWrite(2, () => { timer('roll')!.frequency = 30; });
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), (error: unknown) => !(error instanceof ToolConflictError) && /could not be put back/.test((error as Error).message));
    assert.equal(timer('roll')?.frequency, 30, 'the edit made in between survives');
});

test('renaming a paused repeat at the plan limit keeps it (one write, no delete and re-create)', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    for (let i = 0; i < 5; i++) timerDb.seed({ name: `t${i}`, message: 'm', frequency: 10 });
    const paused = timerDb.seed({ name: 'dice', message: 'roll', frequency: 20, active: false });
    const applied = await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!dice', newName: 'roll' }), ctx());
    assert.equal(dice.cmd, 'roll');
    assert.deepEqual([paused.name, paused.frequency, paused.active], ['roll', 20, false], 'same timer, renamed in place');
    await updateCommandTool.undo!(json(applied.change!), ctx());
    assert.deepEqual([dice.cmd, paused.name, paused.active], ['dice', 'dice', false]);
});

test('undo puts back a repeat whose interval the plan no longer offers, and a paused one at the plan limit', async () => {
    db.seed({ name: 'old', cmd: 'old', func: 'old', message: 'hi', cooldown: 10 });
    timerDb.seed({ name: 'old', message: 'hi', frequency: 7, active: false }); // 7 minutes: not a Free interval any more
    for (let i = 0; i < 5; i++) timerDb.seed({ name: `t${i}`, message: 'm', frequency: 10 });
    const applied = await deleteCommandTool.apply!(await propose(deleteCommandTool, { name: '!old' }), ctx());
    assert.equal(timer('old'), undefined);
    await deleteCommandTool.undo!(json(applied.change!), ctx());
    assert.ok(find('old'));
    assert.deepEqual([timer('old')!.frequency, timer('old')!.active], [7, false]);
});

test('resuming a paused repeat checks the plan limit again at Apply', async () => {
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    for (let i = 0; i < 4; i++) timerDb.seed({ name: `t${i}`, message: 'm', frequency: 10 });
    const paused = timerDb.seed({ name: 'dice', message: 'roll', frequency: 20, active: false });
    const proposal = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 20 });
    assert.deepEqual(proposal.after, { Command: '!dice', Repeats: 'Every 20 minutes' });
    timerDb.seed({ name: 't4', message: 'm', frequency: 10 }); // the fifth enabled one arrives before Apply
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /could not be saved \(the limit of enabled repeating messages.*nothing was changed/.test(error.message));
    assert.equal(paused.active, false);
});

test('a repeat stored under the display name (older data) belongs to its command, like on the Commands page', async () => {
    db.seed({ name: 'referral', cmd: 'mycode', func: 'mycode', message: 'Use my code', cooldown: 10 });
    timerDb.seed({ name: 'referral', message: 'Use my code', frequency: 20 });
    const proposal = await propose(deleteCommandTool, { name: '!mycode' });
    assert.equal((proposal.before as Raw).Repeats, 'Every 20 minutes');
    const applied = await deleteCommandTool.apply!(proposal, ctx());
    assert.equal(timer('referral'), undefined, 'no repeat is left posting for a command that is gone');
    await deleteCommandTool.undo!(json(applied.change!), ctx());
    assert.equal(timer('referral')!.frequency, 20);

    // A reply change follows it in place; a rename moves it under the new trigger, as the page would.
    await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!mycode', body: 'New text' }), ctx());
    assert.equal(timer('referral')!.message, 'New text');
    await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!mycode', newName: 'code' }), ctx());
    assert.ok(find('code'), 'renamed (the row was re-created by the undo above, so look it up again)');
    assert.deepEqual([timer('referral'), timer('code')?.message], [undefined, 'New text']);

    // …unless that word is another command's trigger: then the timer is that command's repeat.
    db.seed({ name: 'referral', cmd: 'mycode2', func: 'mycode2', message: 'other', cooldown: 10 });
    db.seed({ name: 'referral', cmd: 'referral', func: 'referral', message: 'owner', cooldown: 10 });
    timerDb.seed({ name: 'referral', message: 'owner', frequency: 30 });
    const other = await propose(deleteCommandTool, { name: '!mycode2' });
    assert.equal((other.before as Raw).Repeats, undefined);
    await deleteCommandTool.apply!(other, ctx());
    assert.equal(timer('referral')!.frequency, 30, 'the timer of !referral is untouched');
});

test('a repeat added after the proposal stops Apply when the change counted on there being none', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const gone = await propose(deleteCommandTool, { name: '!dice' });
    const renamed = await propose(updateCommandTool, { name: '!dice', newName: 'roll' });
    const reworded = await propose(updateCommandTool, { name: '!dice', body: 'roll again' });
    const slower = await propose(updateCommandTool, { name: '!dice', cooldown: 30 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 }); // made on the page in the meantime
    for (const [tool, proposal] of [[deleteCommandTool, gone], [updateCommandTool, renamed], [updateCommandTool, reworded]] as const) {
        await assert.rejects(tool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeat of !dice changed since this was proposed/.test(error.message));
    }
    assert.deepEqual([dice.cmd, dice.message, timer('dice')!.message], ['dice', 'roll', 'roll']);
    // A change that has nothing to do with the repeat (cooldown) still applies.
    await updateCommandTool.apply!(slower, ctx());
    assert.equal(dice.cooldown, 30);
});

test('a write that landed while the live cache stays down is an unknown outcome; once the cache answers it is repaired', async () => {
    db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
    const real = { del: redis.del, hDel: redis.hDel };
    const down = async () => { throw new Error('dragonfly down'); };
    try {
        // Cache down for the whole Apply: the timer row is deleted, but the worker may still post it → never "nothing changed", never "applied".
        const stop = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 0 });
        redis.hDel = down as never;
        redis.del = down as never;
        await assert.rejects(updateCommandTool.apply!(stop, ctx()), (error: unknown) => !(error instanceof ToolConflictError));
        assert.equal(timer('dice'), undefined);

        // Cache fails once, then answers: the write is recognised as landed and the cache entry is dropped for real.
        timerDb.seed({ name: 'dice', message: 'roll', frequency: 20 });
        const again = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 0 });
        let failures = 0;
        const dropped: string[] = [];
        redis.hDel = (async (...args: unknown[]) => { if (failures++ === 0) throw new Error('dragonfly blip'); dropped.push(String(args[1])); return 1; }) as never;
        redis.del = real.del;
        const id = String(timer('dice')!._id);
        await updateCommandTool.apply!(again, ctx());
        assert.equal(timer('dice'), undefined);
        assert.deepEqual(dropped, [id], 'the deleted timer left the live cache');
    } finally {
        redis.del = real.del;
        redis.hDel = real.hDel;
    }
});

test('a repeat-only change notices a command deleted while it was being applied, and takes the repeat back', async () => {
    const dice = db.seed({ name: 'dice', cmd: 'dice', func: 'dice', message: 'roll', cooldown: 10 });
    const proposal = await propose(updateCommandTool, { name: '!dice', repeatMinutes: 20 });
    onTimerWrite(1, () => { db.store.delete(String(dice._id)); }); // deleted on the page between the check and the timer write
    await assert.rejects(updateCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /deleted in the meantime/.test(error.message));
    assert.equal(timer('dice'), undefined, 'no repeat is left without its command');
});

test('Apply refuses when another timer became the command\'s repeat since the proposal', async () => {
    db.seed({ name: 'legacy', cmd: 'mycode', func: 'mycode', message: 'Use my code', cooldown: 10 });
    timerDb.seed({ name: 'legacy', message: 'Use my code', frequency: 20 }); // linked through the display name
    const proposal = await propose(deleteCommandTool, { name: '!mycode' });
    timerDb.seed({ name: 'mycode', message: 'made meanwhile', frequency: 10 }); // now this one is the command's repeat
    await assert.rejects(deleteCommandTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeat of !mycode changed since this was proposed/.test(error.message));
    assert.ok(find('mycode'));
    assert.deepEqual([timer('legacy')?.frequency, timer('mycode')?.frequency], [20, 10]);
});

test('undoing an older change does not strand a repeat that a later change added', async () => {
    // Rename with no repeat → the repeat is added afterwards → undo of the rename must not leave timer "b" without !b.
    const a = db.seed({ name: 'a', cmd: 'a', func: 'a', message: 'hi', cooldown: 10 });
    const renamed = json((await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!a', newName: 'b' }), ctx())).change!);
    const repeating = json((await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!b', repeatMinutes: 20 }), ctx())).change!);
    await assert.rejects(updateCommandTool.undo!(renamed, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeat of !b changed after the assistant's change.*Undo the newer change/.test(error.message));
    assert.deepEqual([a.cmd, timer('b')?.frequency], ['b', 20], 'nothing moved');
    // Newest first works: the repeat goes, then the rename.
    await updateCommandTool.undo!(repeating, ctx());
    await updateCommandTool.undo!(renamed, ctx());
    assert.deepEqual([a.cmd, timer('b'), timer('a')], ['a', undefined, undefined]);

    // A change that has nothing to do with the repeat (cooldown) still undoes after a repeat was added.
    const slower = json((await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!a', cooldown: 30 }), ctx())).change!);
    await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!a', repeatMinutes: 20 }), ctx());
    await updateCommandTool.undo!(slower, ctx());
    assert.deepEqual([a.cooldown, timer('a')?.frequency], [10, 20]);

    // Same for a command created without a repeat that got one later.
    const created = json((await createCommandTool.apply!(await propose(createCommandTool, { name: 'x', body: 'hello' }), ctx())).change!);
    const repeatingX = json((await updateCommandTool.apply!(await propose(updateCommandTool, { name: '!x', repeatMinutes: 20 }), ctx())).change!);
    await assert.rejects(createCommandTool.undo!(created, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeat of !x changed after/.test(error.message));
    assert.ok(find('x') && timer('x'), 'the command and its repeat both stay');
    await updateCommandTool.undo!(repeatingX, ctx());
    await createCommandTool.undo!(created, ctx());
    assert.deepEqual([find('x'), timer('x')], [undefined, undefined]);
});

test('undo records from before repeats were tracked refuse to strand a repeat, and otherwise work as before', async () => {
    const dice = db.seed({ name: 'roll', cmd: 'roll', func: 'roll', message: 'roll', cooldown: 10 });
    const expected = (await import('./commands.js')).commandSnapshot(dice as never);
    // Shapes the old code wrote: no `repeat`, no `repeatAfter`.
    const oldRename = json({ undo: { op: 'update', id: String(dice._id), restore: { cmd: 'dice', name: 'dice' }, expected }, after: null, target: { type: 'command', id: String(dice._id), label: '!roll' } });
    const oldCreate = json({ undo: { op: 'create', id: String(dice._id), expected }, after: null, target: { type: 'command', id: String(dice._id), label: '!roll' } });
    timerDb.seed({ name: 'roll', message: 'roll', frequency: 20 });
    for (const [tool, change] of [[updateCommandTool, oldRename], [createCommandTool, oldCreate]] as const) {
        await assert.rejects(tool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /repeats now.*Stop the repeat first/.test(error.message));
    }
    assert.deepEqual([dice.cmd, timer('roll')?.frequency], ['roll', 20]);
    timerDb.store.clear();
    await updateCommandTool.undo!(oldRename, ctx());
    assert.equal(dice.cmd, 'dice');
});
