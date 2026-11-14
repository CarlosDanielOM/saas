/**
 * The MCP allowlist is one audited list: every site tool is either on it or excluded with a reason, writes leave
 * undo data, and every tool that holds command text declares it for the safe-body guard.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentTool } from '../types.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const { allTools, getTool } = await import('./registry.js');
const { MCP_ALLOWLIST, MCP_EXCLUDED, MCP_ONLY_TOOLS, MCP_TOOL_SCOPES, mcpUndoable, requiredScope } = await import('./mcp.js');
const { mcpOnlyTools } = await import('./mcp_changes.js');

/** Writes that can make command text reachable (behavior: mcp_checks.test.ts). The rest only remove code or hold none. */
const EXECUTABLE = ['create_command', 'update_command', 'update_timer', 'create_goal', 'update_goal', 'update_roulette', 'add_roulette_items', 'update_roulette_item',
    'remove_roulette_item', 'create_bits_rule', 'update_bits_rule', 'delete_bits_rule', 'create_chat_event', 'update_chat_event', 'delete_chat_event', 'update_tts_settings'];

test('the allowlist: knowledge, reads, undoable writes, the MCP-only tools; nothing else', () => {
    assert.deepEqual(Object.keys(MCP_ALLOWLIST).sort(), [
        'add_roulette_items', 'channel_overview', 'create_bits_rule', 'create_chat_event', 'create_command', 'create_goal', 'create_roulette',
        'delete_bits_rule', 'delete_chat_event', 'delete_command', 'delete_timer', 'get_ai_credits', 'get_command', 'get_referral_codes', 'get_settings', 'get_timer',
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
