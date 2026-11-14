/**
 * MCP writes apply without an approval card, so `executableFields` must return every command text a change makes
 * reachable: new text, and stored text exposed by enable flags, thresholds, access, modes, renames, odds, fallbacks
 * or deletion. Chat events and Bits rules check their whole effective text on every write and pin it for apply.
 * (Review 2026-11-14, findings 3, 4 and 6.)
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { installFakeModel } from './write/fake_store.testutil.js';
import { makeCtx } from './write/settings/test_context.test_util.js';
import type { AgentTool, ChangeProposal, ExecutableCheck } from '../types.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const realMongo = await import('../../utils/databases/mongodb.database.js');
mock.module('../../utils/databases/mongodb.database.js', { namedExports: { ...realMongo, getMongoDBConnection: async () => ({}) } });
const guards: Array<Record<string, unknown> | undefined> = [];
const eventCalls: string[] = [];
const realEventsub = await import('../../server/services/eventsub_config.service.js');
mock.module('../../server/services/eventsub_config.service.js', {
    namedExports: {
        ...realEventsub,
        createChannelEventsub: async (_channel: string, body: { type: string }) => { eventCalls.push(`create:${body.type}`); return { status: 201, body: {} }; },
        updateChannelEventsub: async (_channel: string, id: string, _body: unknown, options: { guard?: Record<string, unknown> } = {}) => { eventCalls.push(`update:${id}`); guards.push(options.guard); return { status: 200, body: {} }; },
        deleteChannelEventsub: async (_channel: string, id: string) => { eventCalls.push(`delete:${id}`); return { status: 200, body: {} }; },
    },
});
const bits: { revision: number; rules: any[]; beforeChange: (() => void) | null } = { revision: 1, rules: [], beforeChange: null };
const realBits = await import('../../bits_rules/store.js');
mock.module('../../bits_rules/store.js', {
    namedExports: {
        ...realBits,
        loadBitsRules: async () => ({ revision: bits.revision, rules: structuredClone(bits.rules) }),
        changeBitsRules: async (_channel: string, _by: string, change: (rules: any[]) => any[]) => {
            const hook = bits.beforeChange; bits.beforeChange = null; hook?.();
            bits.rules = change(structuredClone(bits.rules));
            bits.revision++;
            return { revision: bits.revision, rules: bits.rules };
        },
    },
});

const { CommandsSchema } = await import('../../schemas/commands.schema.js');
const { default: EventsubSchema } = await import('../../schemas/eventsub.schema.js');
const { RouletteChannel } = await import('../../roulette/service.js');
const roulettes: { doc: any } = { doc: null };
mock.method(RouletteChannel, 'findById', () => ({ lean: async () => structuredClone(roulettes.doc) }));
const commands = installFakeModel(CommandsSchema);
const eventsubs = installFakeModel(EventsubSchema);

const { updateCommandTool } = await import('./write/commands.js');
const { updateTimerTool } = await import('./write/timers.js');
const { createGoal, updateGoal } = await import('./write/settings/goals.js');
const { createBitsRule, updateBitsRule, deleteBitsRule } = await import('./write/settings/bits_rules.js');
const { createChatEvent, updateChatEvent, deleteChatEvent } = await import('./write/settings/chat_events.js');
const { updateRoulette, addRouletteItems, updateRouletteItem, removeRouletteItem } = await import('./write/settings/roulettes.js');
const { ToolConflictError } = await import('../types.js');

const ctx = makeCtx({ channelId: '100' });
const proposal = (payload: Record<string, unknown>): ChangeProposal => ({ tool: 'x', title: 't', area: 'a', target: { type: 't', id: null, label: 'l' }, before: null, after: null, effects: [], permissions: [], payload });
type Found = { texts: string[]; stored: string[]; pinned?: Record<string, unknown> } | null;
async function check(tool: AgentTool<any>, payload: Record<string, unknown>, input: unknown = {}): Promise<Found> {
    const found = await tool.executableFields!(input as never, proposal(payload), ctx) as string[] | ExecutableCheck | null;
    if (found === null) return null;
    return Array.isArray(found) ? { texts: found, stored: [] } : { texts: found.texts, stored: found.stored ?? [], ...(found.pinned ? { pinned: found.pinned } : {}) };
}
const every = (found: Found) => found ? [...found.texts, ...found.stored] : null;

beforeEach(() => {
    commands.store.clear();
    eventsubs.store.clear();
    guards.length = 0;
    eventCalls.length = 0;
    bits.revision = 1;
    bits.rules = [];
    bits.beforeChange = null;
    roulettes.doc = null;
});

// ---------------------------------------------------------------------------
// Finding 3: chat events
// ---------------------------------------------------------------------------

const raidRow = () => eventsubs.seed({ channelID: '100', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '100' }, enabled: true, message: '$(ban $(raid.login))', minViewers: 50 });

test('chat events: every write checks all text of the event as it will be, stored text included', async () => {
    const raid = raidRow();
    const lower = await check(updateChatEvent, { id: String(raid._id), type: 'channel.raid', after: { minViewers: 1 } });
    assert.ok(lower!.stored.includes('$(ban $(raid.login))'), 'a lower minViewers makes the stored raid message run for more raids');
    assert.ok(lower!.pinned, 'pinned for apply');
    const off = await check(updateChatEvent, { id: String(raid._id), type: 'channel.raid', after: { enabled: false } });
    assert.ok(off!.stored.includes('$(ban $(raid.login))'), 'whatever changed (lead decision)');

    const ad = eventsubs.seed({ channelID: '100', type: 'channel.ad_break.begin', version: '1', condition: { broadcaster_user_id: '100' }, enabled: true, message: 'Ad time', endEnabled: false, endMessage: '$(clear.chat)' });
    const end = await check(updateChatEvent, { id: String(ad._id), type: 'channel.ad_break.begin', after: { endEnabled: true } });
    assert.ok(end!.stored.includes('$(clear.chat)'), 'endEnabled runs the stored end message');
    const reworded = await check(updateChatEvent, { id: String(ad._id), type: 'channel.ad_break.begin', after: { message: 'Back soon $(user)' } });
    assert.deepEqual(reworded!.texts, ['Back soon $(user)']);
    assert.ok(reworded!.stored.includes('$(clear.chat)'));
    assert.ok(!every(reworded)!.includes('Ad time'), 'the replaced message no longer runs');

    const created = await check(createChatEvent, { body: { type: 'channel.follow', config: { message: 'Hi $(user)', enabled: false } } });
    assert.deepEqual(created!.texts, ['Hi $(user)']);
});

test('chat events: a delete checks the rows that stay (the runtime picks any equivalent row); Cheers includes the Bits rules', async () => {
    const canonical = eventsubs.seed({ channelID: '100', type: 'channel.bits.use', version: '1', condition: {}, enabled: true, message: 'Thanks $(user)' });
    eventsubs.seed({ channelID: '100', type: 'channel.cheer', version: '1', condition: {}, enabled: true, message: '$(ban $(user))' });
    const removed = await check(deleteChatEvent, { id: String(canonical._id), type: 'channel.bits.use', expected: {}, recreate: {} });
    assert.ok(removed!.stored.includes('$(ban $(user))'), 'the legacy row takes over');
    assert.ok(!removed!.stored.includes('Thanks $(user)'));

    bits.rules = [{ id: 'rule-1', name: '', enabled: true, min: 100, max: 100, chat: { mode: 'custom', message: '$(tts $(user) 100!)' }, alert: true }];
    const cheers = await check(updateChatEvent, { id: String(canonical._id), type: 'channel.bits.use', after: { enabled: true } });
    assert.ok(cheers!.stored.includes('$(tts $(user) 100!)'));
});

test('chat events: apply refuses when the checked event changed in between, and pins the stored text in the write', async () => {
    const raid = raidRow();
    const id = String(raid._id);
    const payload = { id, type: 'channel.raid', before: { minViewers: 50 }, after: { minViewers: 1 }, expected: { minViewers: 50 } };
    const first = await check(updateChatEvent, payload);
    eventsubs.store.get(id)!.message = '$(add.mod $(raid.login))';
    await assert.rejects(updateChatEvent.apply!(proposal({ ...payload, pinned: first!.pinned }), ctx), ToolConflictError);
    assert.deepEqual(eventCalls, []);

    const second = await check(updateChatEvent, payload);
    await updateChatEvent.apply!(proposal({ ...payload, pinned: second!.pinned }), ctx);
    assert.equal(guards.at(-1)!.message, '$(add.mod $(raid.login))', 'the write is conditional on the text that was checked');
    // The site (no pin) keeps its guard on the changed fields only.
    await updateChatEvent.apply!(proposal(payload), ctx);
    assert.deepEqual(guards.at(-1), { minViewers: 50 });

    const removed = await check(deleteChatEvent, { id, type: 'channel.raid', expected: {}, recreate: {} });
    eventsubs.seed({ channelID: '100', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '100' }, message: 'dup' });
    await assert.rejects(deleteChatEvent.apply!(proposal({ id, type: 'channel.raid', expected: {}, recreate: {}, pinned: removed!.pinned }), ctx), ToolConflictError);
});

// ---------------------------------------------------------------------------
// Finding 4: Bits rules
// ---------------------------------------------------------------------------

const rule = (id: string, min: number, max: number | null, mode: 'custom' | 'default' | 'silent', message = '', enabled = true) => ({ id, name: '', enabled, min, max, chat: { mode, message }, alert: true });

test('Bits rules: every write checks every rule message and the default Cheers message as they will be', async () => {
    eventsubs.seed({ channelID: '100', type: 'channel.bits.use', version: '1', condition: {}, enabled: true, message: '$(tts $(user) cheered)' });
    eventsubs.seed({ channelID: '100', type: 'channel.cheer', version: '1', condition: {}, enabled: true, message: 'old', cheerTiers: [{ min_amount: 1, max_amount: 5, message: '$(ban $(user) 60)' }] });
    bits.rules = [rule('rule-1', 100, 100, 'custom', 'Nice $(user)'), rule('rule-2', 1, 99, 'silent')];

    const toDefault = await check(updateBitsRule, { id: 'rule-1', raw: { chat: { mode: 'default', message: '' } }, expected: bits.rules[0] });
    assert.ok(toDefault!.stored.includes('$(tts $(user) cheered)'), 'default mode sends the stored default message');
    assert.ok(toDefault!.stored.includes('$(ban $(user) 60)'), 'legacy tiers of a Cheers row count too');
    assert.ok(toDefault!.pinned);
    const disabled = await check(updateBitsRule, { id: 'rule-2', raw: { enabled: false }, expected: bits.rules[1] });
    assert.ok(disabled!.stored.includes('$(tts $(user) cheered)') && disabled!.stored.includes('Nice $(user)'));
    const removed = await check(deleteBitsRule, { id: 'rule-1', expected: bits.rules[0] });
    assert.ok(removed!.stored.includes('$(tts $(user) cheered)'));
    assert.ok(!removed!.stored.includes('Nice $(user)'), 'the deleted rule no longer runs');
    const created = await check(createBitsRule, { id: 'rule-3', raw: { min: 5, chat: { mode: 'custom', message: 'Five $(user)' } } });
    assert.deepEqual(created!.texts, ['Five $(user)']);
    assert.ok(created!.stored.includes('Nice $(user)') && created!.stored.includes('$(tts $(user) cheered)'));
});

test('Bits rules: apply refuses when the checked rules or the default message changed in between', async () => {
    const cheers = eventsubs.seed({ channelID: '100', type: 'channel.bits.use', version: '1', condition: {}, enabled: true, message: 'Thanks' });
    bits.rules = [rule('rule-1', 100, 100, 'custom', 'Nice')];
    const payload = { id: 'rule-1', expected: bits.rules[0] };
    const found = await check(deleteBitsRule, payload);
    eventsubs.store.get(String(cheers._id))!.message = '$(ban $(user))';
    await assert.rejects(deleteBitsRule.apply!(proposal({ ...payload, pinned: found!.pinned }), ctx), ToolConflictError);
    eventsubs.store.get(String(cheers._id))!.message = 'Thanks';

    const again = await check(deleteBitsRule, payload);
    bits.beforeChange = () => { bits.rules.push(rule('rule-9', 1, 9, 'custom', '$(ban $(user))')); };
    await assert.rejects(deleteBitsRule.apply!(proposal({ ...payload, pinned: again!.pinned }), ctx), ToolConflictError, 'a save landing inside the write');
    assert.equal(bits.rules.length, 2, 'nothing deleted');

    const fresh = await check(deleteBitsRule, { id: 'rule-1', expected: bits.rules[0] });
    await deleteBitsRule.apply!(proposal({ id: 'rule-1', expected: bits.rules[0], pinned: fresh!.pinned }), ctx);
    assert.deepEqual(bits.rules.map((item) => item.id), ['rule-9']);
});

// ---------------------------------------------------------------------------
// Finding 6: the other writes
// ---------------------------------------------------------------------------

test('update_command: the reply as it will be for anything but turning it off or narrowing it; built-in code is opaque', async () => {
    const seed = (fields: Record<string, unknown>) => String(commands.seed({ channelID: '100', cmd: 'x', name: 'x', func: 'x', enabled: true, userLevel: 7, cooldown: 10, ...fields })._id);
    const custom = seed({ message: '$(ban $(touser))' });
    const mod = seed({ cmd: 'mod', func: 'mod', reserved: true, message: '' });
    const list = seed({ cmd: 'commands', func: 'commands', reserved: true, message: '' });
    const changes = (id: string, change: Record<string, unknown>, repeat?: unknown) => check(updateCommandTool, { id, changes: change, ...(repeat ? { repeat } : {}) });

    assert.deepEqual(await changes(custom, { body: 'hi' }), { texts: ['hi'], stored: [] });
    for (const change of [{ newName: 'y' }, { cooldown: 1 }, { enabled: true }, { access: 'everyone' }]) {
        assert.deepEqual(every(await changes(custom, change)), ['$(ban $(touser))'], JSON.stringify(change));
    }
    for (const change of [{ enabled: false }, { cooldown: 30 }, { access: 'broadcaster' }, { description: 'x' }, { enabled: false, cooldown: 60 }]) {
        assert.deepEqual(every(await changes(custom, change)), [], `narrowing: ${JSON.stringify(change)}`);
    }
    assert.deepEqual(every(await changes(custom, {}, { from: { id: 't', name: 'x', minutes: 10, message: 'm', active: true }, to: null })), [], 'stopping the repeat');
    assert.ok(every(await changes(custom, {}, { from: null, to: { name: 'x', minutes: 10, message: '#(x)', active: true } }))!.includes('#(x)'));
    assert.equal(await changes(mod, { access: 'everyone' }), null);
    assert.equal(await changes(mod, { cooldown: 1 }), null);
    assert.equal(await changes(mod, { newName: 'm' }), null);
    assert.deepEqual(every(await changes(mod, { enabled: false })), [], 'turning a built-in off is fine');
    assert.deepEqual(every(await changes(list, { enabled: true })), []);
});

test('update_timer and update_goal: the stored text counts unless the change only pauses or slows it', async () => {
    const timer = { name: 'promo', minutes: 10, message: '$(ban $(user))', active: true, id: 't1' };
    assert.deepEqual(every(await check(updateTimerTool, { changes: { minutes: 5 }, expected: timer })), ['$(ban $(user))'], 'more often');
    assert.deepEqual(every(await check(updateTimerTool, { changes: { minutes: 20 }, expected: timer })), []);
    assert.deepEqual(every(await check(updateTimerTool, { changes: { enabled: false }, expected: timer })), []);
    assert.deepEqual(every(await check(updateTimerTool, { changes: { enabled: true }, expected: { ...timer, active: false } })), ['$(ban $(user))']);
    assert.deepEqual(await check(updateTimerTool, { changes: { message: 'hi' }, expected: timer }), { texts: ['hi'], stored: [] });

    assert.deepEqual(every(await check(createGoal, {}, { completionAction: { type: 'ast', text: '$(tts yay)' }, failureAction: { type: 'message', text: '$(ban x)' } })), ['$(tts yay)'], 'message actions are plain text');
    const before = { target: 10, actions: { completion: { type: 'ast', text: '$(trigger.send boom)' }, failure: { type: 'message', text: 'plain' } } };
    assert.deepEqual(every(await check(updateGoal, { body: { name: 'renamed', target: 10 }, before })), ['$(trigger.send boom)'], 'any goal edit checks its actions');
    assert.deepEqual(await check(updateGoal, { body: { name: 'x', target: 10, actions: { completion: { type: 'ast', text: '$(user)' } } }, before }), { texts: ['$(user)'], stored: [] });
});

test('roulettes: every prize write checks the roulette\'s winner actions as they will be, pinned for apply', async () => {
    const items = [
        { id: 'i1', label: 'boom', weight: 1, multiplier: 1, copies: ['c1'], action: '$(ban $(user) 60)' },
        { id: 'i2', label: 'hug', weight: 1, multiplier: 1, copies: ['c2'], action: '' },
    ];
    const roulette = { id: 'r1', alias: 'prizes', name: 'Prizes', design: 'wheel', cardSize: 'medium', colors: ['#fff'], durationSeconds: 5, settings: {}, items, order: ['c1', 'c2'] };
    roulettes.doc = { _id: '100', revision: 3, state: { roulettes: [roulette], activeId: 'r1', visible: false, draw: null, history: [], hideAt: null } };

    const renamed = await check(updateRoulette, { id: 'r1', config: { alias: 'other' }, expected: {} });
    assert.deepEqual(renamed!.stored, ['$(ban $(user) 60)'], 'a new alias makes other commands spin it');
    assert.deepEqual((await check(removeRouletteItem, { id: 'r1', itemId: 'i2', expected: {} }))!.stored, ['$(ban $(user) 60)'], 'better odds for the rest');
    assert.deepEqual((await check(removeRouletteItem, { id: 'r1', itemId: 'i1', expected: {} }))!.stored, []);
    assert.deepEqual((await check(updateRouletteItem, { id: 'r1', itemId: 'i2', data: { label: 'x' }, expected: {} }))!.stored, ['$(ban $(user) 60)']);
    const replaced = await check(updateRouletteItem, { id: 'r1', itemId: 'i1', data: { action: 'hi $(user)' }, expected: {} });
    assert.deepEqual([replaced!.texts, replaced!.stored], [['hi $(user)'], []]);
    const added = await check(addRouletteItems, { id: 'r1', data: {}, expectedItems: '' }, { items: [{ label: 'new', winnerAction: '$(tts hi)' }] });
    assert.deepEqual([added!.texts, added!.stored], [['$(tts hi)'], ['$(ban $(user) 60)']]);

    const { configView } = await import('./write/settings/roulettes.js');
    const payload = { id: 'r1', config: { name: 'Renamed' }, expected: configView(roulette as never) };
    const found = await check(updateRoulette, payload);
    roulettes.doc.state.roulettes[0].items[1].action = '$(add.mod $(user))';
    await assert.rejects(updateRoulette.apply!(proposal({ ...payload, pinned: found!.pinned }), ctx), ToolConflictError);
});

test('update_tts_settings: turning TTS on through MCP is blocked (every stored $(tts …), !s and TTS reward would speak); other fields pass', async () => {
    const { updateTtsSettings } = await import('./write/settings/tts.js');
    const on = await updateTtsSettings.executableFields!({} as never, proposal({ before: { enabled: false }, after: { enabled: true }, expected: { enabled: false } }), ctx) as ExecutableCheck;
    assert.match(String(on?.blocked), /Text to Speech/);
    for (const after of [{ enabled: false }, { provider: 'fish' }, { 'filters.maxLength': 300 }]) {
        const found = await updateTtsSettings.executableFields!({} as never, proposal({ before: {}, after, expected: {} }), ctx) as ExecutableCheck | string[];
        assert.deepEqual(Array.isArray(found) ? found : found.blocked, Array.isArray(found) ? [] : undefined, JSON.stringify(after));
    }
});
