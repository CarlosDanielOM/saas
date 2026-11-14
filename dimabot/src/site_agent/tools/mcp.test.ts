/**
 * The MCP allowlist is one audited list: every site tool is either on it or excluded with a reason, writes leave
 * undo data, and every tool that holds command text declares it for the safe-body guard.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installFakeModel } from './write/fake_store.testutil.js';
import { makeCtx } from './write/settings/test_context.test_util.js';
import type { AgentTool, ChangeProposal } from '../types.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const { allTools, getTool } = await import('./registry.js');
const { MCP_ALLOWLIST, MCP_EXCLUDED, MCP_ONLY_TOOLS, MCP_TOOL_SCOPES, mcpUndoable, requiredScope } = await import('./mcp.js');
const { mcpOnlyTools } = await import('./mcp_changes.js');
const { CommandsSchema } = await import('../../schemas/commands.schema.js');
const { default: EventsubSchema } = await import('../../schemas/eventsub.schema.js');

const commands = installFakeModel(CommandsSchema);
const eventsubs = installFakeModel(EventsubSchema);

const EXECUTABLE = ['create_command', 'update_command', 'update_timer', 'create_goal', 'update_goal', 'add_roulette_items', 'update_roulette_item',
    'create_bits_rule', 'update_bits_rule', 'create_chat_event', 'update_chat_event'];

const proposal = (payload: Record<string, unknown>): ChangeProposal => ({ tool: 'x', title: 't', area: 'a', target: { type: 't', id: null, label: 'l' }, before: null, after: null, effects: [], permissions: [], payload });
const fields = (name: string, payload: Record<string, unknown>, input: unknown = {}) => getTool(name)!.executableFields!(input as never, proposal(payload), makeCtx({ channelId: '100' }));

test('the allowlist: knowledge, reads, undoable writes, the two MCP-only tools; nothing else', () => {
    assert.deepEqual(Object.keys(MCP_ALLOWLIST).sort(), [
        'add_roulette_items', 'channel_overview', 'create_bits_rule', 'create_chat_event', 'create_command', 'create_goal', 'create_roulette',
        'delete_bits_rule', 'delete_chat_event', 'delete_command', 'delete_timer', 'get_command', 'get_referral_codes', 'get_settings', 'get_timer',
        'list_commands', 'list_recent_changes', 'list_timers', 'read_docs', 'recent_chat', 'remove_roulette_item', 'search_ast_functions', 'search_docs',
        'stream_stats', 'test_command', 'undo_change', 'update_bits_rule', 'update_chat_event', 'update_command', 'update_goal', 'update_roulette',
        'update_roulette_item', 'update_timer', 'update_tts_settings',
    ]);
    const site = [...allTools().values()];
    for (const tool of site) {
        const listed = Object.hasOwn(MCP_ALLOWLIST, tool.name);
        assert.notEqual(listed, Object.hasOwn(MCP_EXCLUDED, tool.name), `${tool.name}: exactly one of allowlist / excluded`);
        if (listed) assert.ok(['knowledge', 'read', 'write'].includes(tool.kind), `${tool.name}: no ${tool.kind} tools on MCP v1`);
        if (tool.kind === 'stream' || tool.kind === 'ui') assert.ok(Object.hasOwn(MCP_EXCLUDED, tool.name), tool.name);
    }
    for (const name of Object.keys(MCP_EXCLUDED)) assert.ok(getTool(name), `${name} is a site tool`);
    for (const name of ['update_ai_personality', 'update_moderation_settings', 'update_follow_defense_settings', 'delete_goal']) assert.ok(Object.hasOwn(MCP_EXCLUDED, name));
    for (const name of Object.keys(MCP_ALLOWLIST)) assert.ok(getTool(name) || MCP_ONLY_TOOLS.includes(name), `${name} exists`);
});

test('every MCP write can apply and undo; the change log undoes exactly those (plus the retired create_timer)', () => {
    for (const name of Object.keys(MCP_ALLOWLIST)) {
        const tool = getTool(name);
        if (!tool || tool.kind !== 'write') continue;
        assert.equal(typeof tool.apply, 'function', name);
        assert.equal(typeof tool.undo, 'function', name);
        assert.equal(mcpUndoable(name), true, name);
    }
    assert.equal(mcpUndoable('create_timer'), true);
    for (const name of [...Object.keys(MCP_EXCLUDED), 'list_commands', 'undo_change', 'list_recent_changes', 'nope']) assert.equal(mcpUndoable(name), false, name);
});

test('tools holding command text declare it; the others have nothing to check', () => {
    for (const name of Object.keys(MCP_ALLOWLIST)) {
        const tool = getTool(name);
        if (!tool) continue;
        assert.equal(typeof tool.executableFields === 'function', EXECUTABLE.includes(name), name);
    }
});

test('MCP-only tools are never in the site registry; scopes follow the tool kind', () => {
    assert.deepEqual(mcpOnlyTools.map((tool) => tool.name), [...MCP_ONLY_TOOLS]);
    for (const tool of mcpOnlyTools as AgentTool[]) {
        assert.deepEqual(tool.surfaces, ['mcp']);
        assert.equal(allTools().has(tool.name), false, tool.name);
    }
    assert.deepEqual(MCP_TOOL_SCOPES, { read: 'channel:read', write: 'channel:write', stream: 'stream:act' });
    assert.deepEqual([requiredScope('knowledge'), requiredScope('read'), requiredScope('write'), requiredScope('stream')], [null, 'channel:read', 'channel:write', 'stream:act']);
});

test('executableFields: new text, plus stored text a change turns on, opens or schedules', async () => {
    const timer = { name: 'promo', minutes: 10, message: '$(ban $(user))', active: false, id: 't1' };
    assert.deepEqual(await fields('update_timer', { changes: { minutes: 20 }, expected: timer }), []);
    assert.deepEqual(await fields('update_timer', { changes: { enabled: true }, expected: timer }), ['$(ban $(user))']);
    assert.deepEqual(await fields('update_timer', { changes: { message: 'hi' }, expected: timer }), ['hi']);

    assert.deepEqual(await fields('create_goal', {}, { completionAction: { type: 'ast', text: '$(tts yay)' }, failureAction: { type: 'message', text: '$(ban x)' } }), ['$(tts yay)']);
    const before = { target: 10, actions: { completion: { type: 'ast', text: '$(trigger.send boom)' } } };
    assert.deepEqual(await fields('update_goal', { body: { name: 'x', target: 20 }, before }), [], 'a higher target exposes nothing');
    assert.deepEqual(await fields('update_goal', { body: { name: 'x', target: 5 }, before }), ['$(trigger.send boom)'], 'a lower target runs the stored action sooner');
    assert.deepEqual(await fields('update_goal', { body: { name: 'x', target: 10, actions: {} }, before }), []);

    assert.deepEqual(await fields('create_bits_rule', { raw: { min: 1, chat: { mode: 'custom', message: '$(user)!' } } }), ['$(user)!']);
    assert.deepEqual(await fields('create_bits_rule', { raw: { min: 1 } }), []);
    const rule = { id: 'r', name: '', enabled: false, min: 1, max: null, chat: { mode: 'custom', message: '$(ban $(user))' }, alert: true };
    assert.deepEqual(await fields('update_bits_rule', { raw: { name: 'n' }, expected: rule }), []);
    assert.deepEqual(await fields('update_bits_rule', { raw: { enabled: true }, expected: rule }), ['$(ban $(user))']);
    assert.deepEqual(await fields('update_bits_rule', { raw: { chat: { mode: 'silent', message: '' } }, expected: rule }), []);

    assert.deepEqual(await fields('add_roulette_items', {}, { items: [{ label: 'a' }, { label: 'b', winnerAction: '$(ban $(user) 60)' }] }), ['$(ban $(user) 60)']);
    const item = { label: 'a', weight: 1, count: 1, winnerAction: '$(tts hi)' };
    assert.deepEqual(await fields('update_roulette_item', { data: { label: 'b' }, expected: item }), []);
    assert.deepEqual(await fields('update_roulette_item', { data: { weight: 50 }, expected: item }), ['$(tts hi)']);
    assert.deepEqual(await fields('update_roulette_item', { data: { action: 'ok' }, expected: item }), ['ok']);

    assert.deepEqual(await fields('create_chat_event', { body: { type: 'channel.follow', config: { message: 'Hi $(user)', minViewers: 3, enabled: false } } }), ['Hi $(user)']);
    eventsubs.store.clear();
    const event = eventsubs.seed({ channelID: '100', type: 'channel.follow', message: '$(clear.chat)', enabled: false });
    assert.deepEqual(await fields('update_chat_event', { id: String(event._id), type: 'channel.follow', after: { message: 'new' } }), ['new']);
    assert.ok((await fields('update_chat_event', { id: String(event._id), type: 'channel.follow', after: { enabled: true } }))!.includes('$(clear.chat)'));

    assert.deepEqual(await fields('create_command', {}, { body: '$(user) hi' }), ['$(user) hi']);
});

test('update_command: the stored reply counts when it is turned on or opened to more people; built-in code is opaque', async () => {
    commands.store.clear();
    const seed = (fields: Record<string, unknown>) => String(commands.seed({ channelID: '100', cmd: 'x', name: 'x', func: 'x', enabled: false, userLevel: 7, ...fields })._id);
    const custom = seed({ message: '$(ban $(touser))' });
    const mod = seed({ cmd: 'mod', func: 'mod', reserved: true, message: '' });
    const list = seed({ cmd: 'commands', func: 'commands', reserved: true, message: '' });
    const changes = (id: string, change: Record<string, unknown>, repeat?: unknown) => fields('update_command', { id, changes: change, ...(repeat ? { repeat } : {}) });

    assert.deepEqual(await changes(custom, { cooldown: 5 }), []);
    assert.deepEqual(await changes(custom, { body: 'hi' }), ['hi']);
    assert.deepEqual(await changes(custom, { enabled: true }), ['$(ban $(touser))']);
    assert.deepEqual(await changes(custom, { access: 'everyone' }), ['$(ban $(touser))'], 'mods → everyone');
    assert.deepEqual(await changes(custom, { access: 'broadcaster' }), [], 'narrowing access exposes nothing');
    assert.equal(await changes(mod, { access: 'everyone' }), null, '!mod for everyone would mod anyone');
    assert.equal(await changes(mod, { enabled: true }), null);
    assert.deepEqual(await changes(list, { enabled: true }), []);
    // A repeat that starts posting runs its message on its own.
    assert.deepEqual(await changes(custom, {}, { from: null, to: { name: 'x', minutes: 10, message: '#(x)', active: true } }), ['#(x)']);
    assert.deepEqual(await changes(custom, { newName: 'y' }, { from: { id: 't', name: 'x', minutes: 10, message: 'm', active: true }, to: { name: 'y', minutes: 10, message: 'm', active: true } }), [], 'a rename moves the repeat as is');
});
