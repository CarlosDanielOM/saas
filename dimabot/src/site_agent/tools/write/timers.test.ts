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
const { ToolConflictError, ToolInputError } = await import('../../types.js');
const { createTimerTool, updateTimerTool, deleteTimerTool } = await import('./timers.js');

const db = installFakeModel(CustomTimerSchema, { base: { channelID: OWNER, channel: 'owner_login', frequencyUnit: 'minutes', active: true }, unique: [['channelID', 'name']] });

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

beforeEach(() => { db.store.clear(); redis.reset(); plan.tier = 'free'; });

test('timer tools validate names, messages and that something changes', () => {
    assert.equal(createTimerTool.validate({ name: 'Discord', minutes: 10, message: 'Join!' }).name, 'discord');
    for (const raw of [{ name: 'two words', minutes: 10, message: 'x' }, { name: 'a-b', minutes: 10, message: 'x' }, { name: 'ok', minutes: 0, message: 'x' },
        { name: 'ok', minutes: 10, message: '' }, { name: 'ok', minutes: 10, message: 'x'.repeat(351) }, { name: 'ok', message: 'x' }]) {
        assert.throws(() => createTimerTool.validate(raw), ToolInputError, JSON.stringify(raw));
    }
    assert.throws(() => updateTimerTool.validate({ name: 'ok' }), /Nothing to change/);
    assert.deepEqual(createTimerTool.permissions, ['commands:manage']);
    assert.deepEqual(updateTimerTool.permissions, ['commands:manage']);
    assert.deepEqual(deleteTimerTool.permissions, ['commands:manage']);
});

test('create_timer: plan intervals and limits, no side effects, apply, undo only when unchanged', async () => {
    await assert.rejects(createTimerTool.run(createTimerTool.validate({ name: 'a', minutes: 15, message: 'x' }), ctx()), /Free timers/);
    await propose(createTimerTool, { name: 'a', minutes: 15, message: 'x' }, ctx({ plan: 'premium' }));
    for (let i = 0; i < 5; i++) db.seed({ name: `t${i}`, message: 'm', frequency: 10 });
    await assert.rejects(createTimerTool.run(createTimerTool.validate({ name: 'a', minutes: 10, message: 'x' }), ctx()), /limit reached \(5/);
    db.store.clear();
    db.seed({ name: 'discord', message: 'm', frequency: 10 });
    await assert.rejects(createTimerTool.run(createTimerTool.validate({ name: 'Discord', minutes: 10, message: 'x' }), ctx()), /already exists/);
    db.store.clear();

    const proposal = await propose(createTimerTool, { name: 'discord', minutes: 20, message: 'Join $(tts hi)' });
    assert.equal(db.store.size, 0);
    assert.equal(proposal.title, 'Create timer "discord"');
    assert.deepEqual(proposal.after, { Timer: 'discord', 'Every (minutes)': 20, Message: 'Join $(tts hi)', On: true });
    assert.deepEqual(proposal.effects, ['Speaks on stream with TTS']);

    const applied = await createTimerTool.apply!(proposal, ctx());
    const stored = find('discord')!;
    assert.equal(stored.frequency, 20);
    assert.equal(stored.frequencyUnit, 'minutes');
    assert.equal(stored.active, true);
    assert.equal((applied.result as { created: boolean }).created, true);
    await assert.rejects(createTimerTool.apply!(proposal, ctx()), ToolConflictError);

    const change = json(applied.change!);
    stored.message = 'edited';
    await assert.rejects(createTimerTool.undo!(change, ctx()), (error: unknown) => error instanceof ToolConflictError && /message/.test(error.message));
    stored.message = 'Join $(tts hi)';
    await createTimerTool.undo!(change, ctx());
    assert.equal(find('discord'), undefined);
});

test('update_timer: only changes shown, grandfathered intervals, compare-and-set, undo', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 10 });
    const run = (raw: object) => updateTimerTool.run(updateTimerTool.validate(raw), ctx());
    await assert.rejects(run({ name: 'discord', minutes: 10 }), /nothing to change/);
    await assert.rejects(run({ name: 'missing', enabled: false }), /No timer/);
    await assert.rejects(run({ name: 'discord', minutes: 15 }), /Free timers/);

    const off = await propose(updateTimerTool, { name: 'discord', enabled: false });
    assert.equal(off.title, 'Turn off timer "discord"');
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

test('delete_timer and create_timer undo delete only the timer they checked', async () => {
    const timer = db.seed({ name: 'discord', message: 'Join', frequency: 20 });
    const proposal = await propose(deleteTimerTool, { name: 'discord' });
    db.beforeNextWrite(() => { timer.message = 'new text'; });
    await assert.rejects(deleteTimerTool.apply!(proposal, ctx()), ToolConflictError);
    assert.equal(find('discord')?.message, 'new text', 'the edited timer was not deleted');

    db.store.clear();
    const created = json((await createTimerTool.apply!(await propose(createTimerTool, { name: 'promo', minutes: 20, message: 'Buy' }), ctx())).change!);
    db.beforeNextWrite(() => { find('promo')!.active = false; });
    await assert.rejects(createTimerTool.undo!(created, ctx()), (error: unknown) => error instanceof ToolConflictError && /on\/off/.test(error.message));
    assert.equal(find('promo')?.active, false, 'the timer someone edited stays');
});

test('create_timer: a timer with the same name created in between is a conflict, not an error', async () => {
    const proposal = await propose(createTimerTool, { name: 'discord', minutes: 20, message: 'Join' });
    db.beforeNextWrite(() => { db.seed({ name: 'discord', message: 'made on the page', frequency: 10 }); }, (op) => op === 'create');
    await assert.rejects(createTimerTool.apply!(proposal, ctx()), (error: unknown) => error instanceof ToolConflictError && /created in the meantime/.test(error.message));
    assert.equal(db.store.size, 1);
    assert.equal(find('discord')?.message, 'made on the page');
});

test('delete_timer undo turns the restored timer off only if nobody touched it', async () => {
    db.seed({ name: 'discord', message: 'Join', frequency: 20, active: false });
    const change = json((await deleteTimerTool.apply!(await propose(deleteTimerTool, { name: 'discord' }), ctx())).change!);
    db.beforeNextWrite(() => { find('discord')!.message = 'edited right away'; }, (op) => op === 'findOneAndUpdate');
    await assert.rejects(deleteTimerTool.undo!(change, ctx()), ToolConflictError);
    assert.equal(find('discord')?.message, 'edited right away');
});
