/**
 * What MCP clients read: every allowlisted tool's MCP description tells the MCP truth (no approval card, undo with
 * undo_change, only the safe reply functions) and every tool that changes something declares its hints. The website's
 * descriptions stay exactly as they were.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { AgentTool } from '../types.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const { allTools } = await import('./registry.js');
const { MCP_ALLOWLIST } = await import('./mcp.js');
const { mcpOnlyTools } = await import('./mcp_changes.js');
const { listing, mcpTool } = await import('./execute.js');
const { SAFE_FUNCTIONS } = await import('./safe_body.js');
const { COMMAND_LANGUAGE_BASICS } = await import('./write/commands.js');
const { REPEAT_RULES } = await import('./write/repeat.js');

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const allowlisted = () => Object.keys(MCP_ALLOWLIST).map((name) => ({ name, tool: mcpTool(name)! }));
const isRead = (tool: AgentTool) => tool.kind === 'read' || tool.kind === 'knowledge';
/** Words that only make sense on the website (approval card, the site prompt's docs index). */
const SITE_ONLY_WORDS = /\bpropos|approv(e|es|al)\b|press Apply|sees a card|a card\b|in your instructions/i;

test('MCP descriptions never speak of the approval card or the site prompt', () => {
    for (const { name, tool } of allowlisted()) {
        assert.ok(tool, `${name} resolves`);
        assert.doesNotMatch(listing(tool).description, SITE_ONLY_WORDS, name);
    }
});

test('MCP descriptions only show functions the safe-body guard allows, and no #(…) command references', () => {
    for (const { name, tool } of allowlisted()) {
        const description = listing(tool).description;
        assert.doesNotMatch(description, /#\(/, name);
        for (const match of description.matchAll(/\$\(([^\s()]*)/g)) {
            assert.ok(Object.hasOwn(SAFE_FUNCTIONS, match[1]), `${name}: $(${match[1]} is not a safe reply function`);
        }
    }
});

test('every website write has its own MCP description: applies at once, undo_change, reply functions for command text', () => {
    for (const { name, tool } of allowlisted()) {
        if (isRead(tool) || mcpOnlyTools.some((only) => only.name === name)) continue;
        assert.equal(typeof tool.mcpDescription, 'string', `${name}: needs an mcpDescription`);
        const description = listing(tool).description;
        assert.match(description, /Applies immediately/, name);
        assert.match(description, /undo_change/, name);
        if (tool.executableFields && name !== 'update_tts_settings') assert.match(description, /reply functions/, name);
        assert.ok(tool.mcpDescription!.length < tool.description.length + 400, `${name}: the MCP text should not grow much past the website one`);
    }
    // TTS can only be turned off through MCP (turning it on is blocked by its executableFields).
    assert.match(listing(mcpTool('update_tts_settings')!).description, /through MCP only false/);
    // MCP clients get no docs index: they find ids with search_docs.
    assert.match(listing(mcpTool('read_docs')!).description, /search_docs/);
});

test('hints: reads are read-only; every tool that changes something declares them explicitly', () => {
    const expected: Record<string, [destructive: boolean, idempotent: boolean, openWorld: boolean]> = {
        create_command: [true, true, false], // a same-name chat timer becomes its repeat (replaced with repeatMinutes)
        update_command: [true, true, false],
        delete_command: [true, true, false],
        update_timer: [true, true, false],
        delete_timer: [true, true, false],
        create_goal: [false, false, false], // a second call makes a second goal
        update_goal: [true, true, false],
        create_roulette: [false, true, false], // the alias is unique
        update_roulette: [true, true, false],
        add_roulette_items: [false, false, false], // a second call adds the prizes again
        update_roulette_item: [true, true, false],
        remove_roulette_item: [true, true, false],
        create_bits_rule: [false, false, false], // every call adds a rule with a new id
        update_bits_rule: [true, true, false],
        delete_bits_rule: [true, true, false],
        create_chat_event: [false, true, true], // subscribes on Twitch
        update_chat_event: [true, true, false], // saved settings only
        delete_chat_event: [true, true, true], // unsubscribes on Twitch
        update_tts_settings: [true, true, false],
        undo_change: [true, true, true], // undoing a chat event change (un)subscribes on Twitch
    };
    const writes: string[] = [];
    for (const { name, tool } of allowlisted()) {
        const { annotations } = listing(tool);
        if (isRead(tool)) {
            assert.deepEqual(annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, name);
            continue;
        }
        writes.push(name);
        assert.ok(tool.mcpAnnotations, `${name}: needs mcpAnnotations`);
        const [destructive, idempotent, openWorld] = expected[name] ?? [];
        assert.deepEqual(annotations, { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld }, name);
    }
    assert.deepEqual(writes.sort(), Object.keys(expected).sort());
});

test('a write without MCP text falls back to the website text plus the MCP notes and the spec\'s cautious hints', () => {
    const tool = {
        name: 'create_thing', description: 'Make a thing.', kind: 'write', permissions: [], parameters: { type: 'object', properties: {} },
        label: () => '', validate: (raw: unknown) => raw, run: async () => ({ type: 'result', result: null }), executableFields: () => [],
    } as unknown as AgentTool;
    const listed = listing(tool);
    assert.match(listed.description, /^Make a thing\. Through MCP the change applies right away and is logged; undo_change reverts it\. Command text .*reply functions/);
    assert.match(listed.description, / Costs 1 AI credit from the channel\.$/);
    assert.deepEqual(listed.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});

test('the website descriptions and shared texts are unchanged (MCP text lives in mcpDescription)', () => {
    // Update these hashes only when a website description is changed on purpose (the site prompt and tests use them).
    const rows = [...allTools().values(), ...mcpOnlyTools].map((tool) => [tool.name, tool.description]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.equal(rows.length, 47);
    assert.equal(sha(rows), '3818fd376681f77bac1a1fc4337046840c08ea21cd57042850a65a4608f9e9b8');
    assert.equal(sha(COMMAND_LANGUAGE_BASICS), '4a8228696306d227637da99397bafa9d1402a6be24a4d59d31ff0e1b55ed3491');
    assert.equal(sha(REPEAT_RULES), 'e6f32b248f64c2dcaa1706b2621890dffa32b5c59f5f85ac056f712623565151');
});
