import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

// --- fakes -------------------------------------------------------------------------------------
const events: { subs: any[]; calls: string[]; activated: boolean } = { subs: [], calls: [], activated: true };
const goals: { doc: any; calls: any[] } = { doc: null, calls: [] };
const bits: { revision: number; rules: any[] } = { revision: 0, rules: [] };
const realEventsubService = await import('../../../../server/services/eventsub_config.service.js');
const realGoalsService = await import('../../../../goals/service.js');
const realBitsStore = await import('../../../../bits_rules/store.js');
const realRefresh = await import('../../../../widget_feed/session-refresh.js');
mock.module('../../effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../../../widget_feed/session-refresh.js', { namedExports: { ...realRefresh, requestWidgetSessionRefresh: () => {} } });
mock.module('../../../../server/services/eventsub_config.service.js', {
    namedExports: {
        ...realEventsubService,
        createChannelEventsub: async (channelID: string, body: any) => {
            events.calls.push(`create:${body.type}`);
            events.subs.push({ _id: `id-${events.subs.length + 1}`, channelID, type: body.type, version: body.version, condition: body.condition, enabled: true, ...body.config });
            return { status: 201, body: { error: false, data: events.subs.at(-1) } };
        },
        updateChannelEventsub: async (_channelID: string, id: string, body: any) => {
            events.calls.push(`update:${id}`);
            Object.assign(events.subs.find((sub) => sub._id === id), body);
            return { status: 200, body: { error: false } };
        },
        deleteChannelEventsub: async (_channelID: string, id: string) => {
            events.calls.push(`delete:${id}`);
            events.subs = events.subs.filter((sub) => sub._id !== id);
            return { status: 200, body: { error: false, message: 'Eventsub deleted', status: 200 } };
        }
    }
});
mock.module('../../../../goals/service.js', {
    namedExports: {
        ...realGoalsService,
        changeGoal: async (_channel: string, action: string, input: any, revision: number, id?: string) => {
            goals.calls.push({ action, input, revision, id });
            const { GoalError, newGoal } = await import('../../../../goals/model.js');
            if ((goals.doc?.revision ?? 0) !== revision) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
            const list = [...(goals.doc?.goals ?? [])];
            if (action === 'create') list.push(newGoal(input, 'free', `g${list.length + 1}`, Date.now()));
            if (action === 'edit') { const index = list.findIndex((goal) => goal.id === id); list[index] = { ...list[index], name: input.name, target: input.target, ...(input.actions ? { actions: input.actions } : {}) }; }
            if (action === 'delete') list.splice(list.findIndex((goal) => goal.id === id), 1);
            goals.doc = { _id: '100', revision: revision + 1, goals: list };
        }
    }
});
mock.module('../../../../bits_rules/store.js', {
    namedExports: {
        ...realBitsStore,
        loadBitsRules: async () => ({ revision: bits.revision, rules: structuredClone(bits.rules) }),
        changeBitsRules: async (_channel: string, _by: string, change: (rules: any[]) => any[]) => {
            bits.rules = change(structuredClone(bits.rules)); bits.revision++;
            return { revision: bits.revision, rules: structuredClone(bits.rules) };
        }
    }
});

const { EventSchema } = await import('../../../../schemas/event.schema.js');
const { default: EventsubSchema } = await import('../../../../schemas/eventsub.schema.js');
const { default: UsersSchema } = await import('../../../../schemas/users.schema.js');
const { GoalSet } = await import('../../../../goals/service.js');
const catalog = [
    { name: 'Follow', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: 'user', moderator_user_id: 'moderator' }, plan_tier: 'free', releaseStage: 'stable',
        config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Thanks $(user)!' }] },
    { name: 'Stream online', type: 'stream.online', version: '1', condition: { broadcaster_user_id: 'user' }, plan_tier: 'free', releaseStage: 'stable',
        config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Live!' }] },
    { name: 'Hype Train', type: 'channel.hype_train.begin', version: '1', condition: { broadcaster_user_id: 'user' }, plan_tier: 'premium', releaseStage: 'stable', config: [] }
];
mock.method(EventSchema, 'find', (filter: any) => {
    const types: string[] | undefined = filter?.type?.$in;
    const rows = types ? catalog.filter((event) => types.includes(event.type)) : catalog;
    return { lean: async () => structuredClone(rows), sort: () => ({ lean: async () => structuredClone(rows) }) };
});
mock.method(EventsubSchema, 'find', (filter: any) => ({ lean: async () => structuredClone(events.subs.filter((sub) => !filter.type || filter.type.$in.includes(sub.type))) }));
mock.method(EventsubSchema, 'findOne', (filter: any) => ({ lean: async () => structuredClone(events.subs.find((sub) => sub._id === filter._id) ?? null) }));
mock.method(UsersSchema, 'findOne', () => ({ select: () => ({ lean: async () => ({ plan_tier: 'free', accounts: [{ type: 'twitch', id: '100', actived: events.activated }] }) }) }));
mock.method(GoalSet, 'findById', () => ({ lean: async () => structuredClone(goals.doc) }));

const { createChatEvent, updateChatEvent, deleteChatEvent } = await import('./chat_events.js');
const { createGoal, updateGoal, deleteGoal } = await import('./goals.js');
const { createBitsRule, updateBitsRule, deleteBitsRule } = await import('./bits_rules.js');
const { ToolConflictError, ToolInputError } = await import('../../../types.js');

beforeEach(() => {
    events.subs = []; events.calls = []; events.activated = true;
    goals.doc = null; goals.calls = [];
    bits.revision = 0; bits.rules = [];
});

// --- chat events -------------------------------------------------------------------------------

test('create_chat_event: EventSub effect, message dry-run, catalog condition, full access and plan gates', async () => {
    const ctx = makeCtx();
    const proposal = await propose(createChatEvent, { type: 'channel.follow', fields: { message: 'Welcome $(user)! $(tts thanks)' } }, ctx);
    assert.deepEqual(proposal.permissions, ['eventsubs:manage']);
    assert.ok(proposal.effects[0].includes('EventSub'));
    assert.ok(proposal.effects.some((effect) => effect.includes('Runs tts')));
    assert.deepEqual(proposal.payload.body, { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '100', moderator_user_id: '698614112' }, config: { message: 'Welcome $(user)! $(tts thanks)' } });
    assert.equal(events.calls.length, 0, 'run never subscribes');
    await assert.rejects(createChatEvent.run(createChatEvent.validate({ type: 'channel.follow', fields: { nope: 1 } }), ctx), /has no field "nope"/);
    const plan = await createChatEvent.run(createChatEvent.validate({ type: 'channel.hype_train.begin' }), ctx);
    assert.equal(plan.type, 'result');
    assert.match(JSON.stringify(plan), /Premium/);
    events.activated = false;
    const locked = await createChatEvent.run(createChatEvent.validate({ type: 'channel.follow' }), ctx);
    assert.equal((locked as any).result.needsFullAccess, true);
    events.activated = true;
    const { change } = await applyProposal(createChatEvent, proposal, ctx);
    assert.deepEqual(events.calls, ['create:channel.follow']);
    await assert.rejects(applyProposal(createChatEvent, proposal, ctx), ToolConflictError);
    await undoChange(createChatEvent, change!, ctx);
    assert.deepEqual(events.calls.at(-1), 'delete:id-1');
});

test('update_chat_event: changed fields only, CAS, stream online cannot be turned off, undo', async () => {
    events.subs = [{ _id: 'e1', channelID: '100', type: 'channel.follow', version: '2', condition: {}, enabled: true, message: 'Old' },
        { _id: 'e2', channelID: '100', type: 'stream.online', version: '1', condition: {}, enabled: true, message: 'Live!' }];
    const ctx = makeCtx({ lang: 'es' });
    await assert.rejects(updateChatEvent.run(updateChatEvent.validate({ type: 'stream.online', enabled: false }), ctx), /cannot be turned off/);
    const proposal = await propose(updateChatEvent, { type: 'channel.follow', enabled: true, fields: { message: 'New $(user)' } }, ctx);
    assert.deepEqual(proposal.before, { Mensaje: 'Old' });
    assert.deepEqual(proposal.after, { Mensaje: 'New $(user)' });
    events.subs[0].message = 'Changed on the page';
    await assert.rejects(applyProposal(updateChatEvent, proposal, ctx), ToolConflictError);
    events.subs[0].message = 'Old';
    const { change } = await applyProposal(updateChatEvent, proposal, ctx);
    assert.equal(events.subs[0].message, 'New $(user)');
    await undoChange(updateChatEvent, change!, ctx);
    assert.equal(events.subs[0].message, 'Old');
});

test('delete_chat_event: never for stream online/offline; undo subscribes again with the same settings', async () => {
    events.subs = [{ _id: 'e1', channelID: '100', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '100' }, enabled: false, message: 'Hi' },
        { _id: 'e2', channelID: '100', type: 'stream.offline', version: '1', condition: {}, enabled: true }];
    const ctx = makeCtx();
    await assert.rejects(deleteChatEvent.run(deleteChatEvent.validate({ type: 'stream.offline' }), ctx), /cannot be deleted/);
    const proposal = await propose(deleteChatEvent, { type: 'channel.follow' }, ctx);
    assert.equal(proposal.after, null);
    assert.ok(proposal.effects[0].includes('Removes the Twitch EventSub subscription'));
    const { change } = await applyProposal(deleteChatEvent, proposal, ctx);
    assert.deepEqual(events.calls, ['delete:e1']);
    await undoChange(deleteChatEvent, change!, ctx);
    assert.deepEqual(events.calls.at(-1), 'create:channel.follow');
    assert.equal(events.subs.at(-1).message, 'Hi');
    assert.equal(events.subs.at(-1).enabled, false);
});

// --- goals ---------------------------------------------------------------------------------------

test('goals: plan gates and limits, AST action effects, revision compare-and-set, undo create, delete has no undo', async () => {
    const ctx = makeCtx();
    await assert.rejects(createGoal.run(createGoal.validate({ name: 'Bits', metric: 'bits', mode: 'total', target: 100 }), ctx), /require Premium/);
    assert.throws(() => createGoal.validate({ name: 'x', metric: 'follows', mode: 'weekly', target: 1 }), ToolInputError);
    const proposal = await propose(createGoal, { name: '100 follows', metric: 'follows', mode: 'total', target: 100, completionAction: { type: 'ast', text: '$(tts we did it)' } }, ctx);
    assert.deepEqual(proposal.permissions, ['*']);
    assert.ok(proposal.effects.some((effect) => /Runs tts/.test(effect)));
    assert.equal(goals.calls.length, 0);
    const { change } = await applyProposal(createGoal, proposal, ctx);
    assert.equal(goals.doc.goals.length, 1);
    assert.equal(goals.calls[0].revision, 0);

    const edit = await propose(updateGoal, { id: 'g1', target: 150 }, ctx);
    assert.deepEqual(goals.calls.length, 1);
    goals.doc.revision = 5; // edited elsewhere
    await assert.rejects(applyProposal(updateGoal, edit, ctx), (error: Error) => error instanceof ToolConflictError && /Goals changed/.test(error.message));
    goals.doc.revision = 1;
    const edited = await applyProposal(updateGoal, edit, ctx);
    assert.equal(goals.doc.goals[0].target, 150);
    await assert.rejects(undoChange(createGoal, change!, ctx), /edited after it was created/);
    await undoChange(updateGoal, edited.change!, ctx);
    assert.equal(goals.doc.goals[0].target, 100);
    await undoChange(createGoal, change!, ctx);
    assert.equal(goals.doc.goals.length, 0);

    goals.doc = { _id: '100', revision: 3, goals: [{ id: 'gx', name: 'Subs', metric: 'subs', mode: 'total', target: 5, createdAt: 1, startsAt: 1 }] };
    const del = await propose(deleteGoal, { id: 'gx' }, ctx);
    assert.ok(del.warnings!.some((w) => /cannot be undone/.test(w)));
    const deleted = await applyProposal(deleteGoal, del, ctx);
    assert.equal(deleted.change!.undo, null);
    assert.equal(deleteGoal.undo, undefined);
    goals.doc = { _id: '100', revision: 0, goals: [{ id: 'a' }, { id: 'b' }] };
    await assert.rejects(createGoal.run(createGoal.validate({ name: 'x', metric: 'follows', mode: 'total', target: 1 }), ctx), /allows 2 goals/);
});

// --- Bits rules ----------------------------------------------------------------------------------

test('Bits rules: validation from the shared model, custom message effects, CAS inside the store change, undo', async () => {
    const ctx = makeCtx();
    assert.throws(() => createBitsRule.validate({ min: 0 }), /at least 1/);
    await assert.rejects(createBitsRule.run(createBitsRule.validate({ min: 100, max: 50 }), ctx), /at least the lowest amount/);
    await assert.rejects(createBitsRule.run(createBitsRule.validate({ min: 100, chatMode: 'custom' }), ctx), /Write the chat message/);
    const proposal = await propose(createBitsRule, { min: 69, max: 69, name: 'Nice', chatMode: 'custom', message: 'Nice $(user) $(tts nice)' }, ctx);
    assert.deepEqual(proposal.permissions, ['eventsubs:manage']);
    assert.equal(proposal.after!.bits, '69');
    assert.ok(proposal.effects.some((effect) => /Runs tts/.test(effect)));
    const created = await applyProposal(createBitsRule, proposal, ctx);
    assert.equal(bits.rules.length, 1);
    const id = bits.rules[0].id;

    const update = await propose(updateBitsRule, { id, alert: false }, ctx);
    assert.deepEqual([update.before!.alert, update.after!.alert], [true, false]);
    bits.rules[0].name = 'Renamed on the Studio';
    await assert.rejects(applyProposal(updateBitsRule, update, ctx), ToolConflictError);
    bits.rules[0].name = 'Nice';
    const updated = await applyProposal(updateBitsRule, update, ctx);
    assert.equal(bits.rules[0].alert, false);
    assert.equal(bits.rules[0].chat.message, 'Nice $(user) $(tts nice)');
    await assert.rejects(undoChange(createBitsRule, created.change!, ctx), /edited after/);
    await undoChange(updateBitsRule, updated.change!, ctx);
    assert.equal(bits.rules[0].alert, true);

    const removal = await propose(deleteBitsRule, { id }, ctx);
    const removed = await applyProposal(deleteBitsRule, removal, ctx);
    assert.equal(bits.rules.length, 0);
    await undoChange(deleteBitsRule, removed.change!, ctx);
    assert.equal(bits.rules[0].id, id, 'undo keeps the id so Overlay Studio looks reconnect');
});
