/**
 * MCP v1 tool surface: ONE audited allowlist over the site assistant's registry (`registry.ts`) plus the MCP-only
 * tools of `mcp_changes.ts`. Every other tool stays site-only (MCP_EXCLUDED says why; a test makes every site tool
 * appear in one of the two lists). Writes apply without an approval card (`execute.ts`), so a write is listed only
 * if its change leaves undo data and every command text it makes run is checked by the safe-body guard
 * (`executableFields`).
 */
import type { ToolKind } from '../types.js';
import { MCP_TOOL_SCOPES } from '../../server/oauth/catalog.js';

export { MCP_TOOL_SCOPES };

/** The token scope a tool kind needs (knowledge needs none; `ui` is never offered on MCP). */
export function requiredScope(kind: ToolKind): string | null {
    if (kind === 'knowledge') return null;
    return kind === 'ui' ? 'site:ui' : MCP_TOOL_SCOPES[kind];
}

/** Tool name → why it is on MCP. */
export const MCP_ALLOWLIST: Readonly<Record<string, string>> = {
    // Knowledge (free; pure: no channel data, nothing runs for real)
    search_docs: 'docs search',
    read_docs: 'docs text',
    search_ast_functions: 'command function catalog search',
    test_command: 'command tester: pure functions run, every action is only recorded',
    // Reads (no secrets; people's text comes wrapped as untrusted_data)
    channel_overview: 'plan, bot setup and live status',
    list_commands: 'commands and keywords',
    get_command: 'one command in full',
    list_timers: 'timers',
    get_timer: 'one timer',
    get_settings: 'settings areas, each with its own view permission; overlay/speech links are never shown',
    stream_stats: 'live stream numbers',
    recent_chat: 'recent chat (moderation:view)',
    get_referral_codes: 'the owner\'s public referral codes, links and signup counts; no secrets',
    list_recent_changes: 'MCP-only: the change log the requester may see',
    // Writes (undo data on every change; executable text checked)
    create_command: 'undo deletes it; body checked',
    update_command: 'undo restores it; new body, or the stored one it turns on, opens or repeats, checked',
    delete_command: 'undo restores it with its repeat',
    update_timer: 'undo restores it; a new message, or the stored one it turns on, checked',
    delete_timer: 'undo re-creates it',
    create_goal: 'undo deletes it; AST actions checked',
    update_goal: 'undo restores it; AST actions checked (also stored ones when the target goes down)',
    create_roulette: 'undo deletes it while empty',
    update_roulette: 'undo restores the setup; no executable fields',
    add_roulette_items: 'undo removes them; winner actions checked',
    update_roulette_item: 'undo restores it; the winner action checked',
    remove_roulette_item: 'undo adds it back',
    create_bits_rule: 'undo deletes it; a custom chat message checked',
    update_bits_rule: 'undo restores it; the custom message checked',
    delete_bits_rule: 'undo adds it back',
    create_chat_event: 'undo removes the subscription; every text value checked',
    update_chat_event: 'undo restores it; new text, or the stored text it turns on, checked',
    delete_chat_event: 'undo subscribes again',
    update_tts_settings: 'undo restores them; no executable fields',
    undo_change: 'MCP-only: undo through the change log, with the original tool\'s scope, permissions and plan',
};

/** Site tools that are not on MCP v1, and why. */
export const MCP_EXCLUDED: Readonly<Record<string, string>> = {
    send_test_alert: 'stream action: plays on stream, no undo',
    set_stream_info: 'stream action on Twitch, no undo',
    create_poll: 'stream action on Twitch, no undo',
    create_prediction: 'stream action on Twitch, no undo',
    create_reward: 'stream kind (Twitch channel points); excluded in v1',
    update_reward: 'stream kind (Twitch channel points); excluded in v1',
    update_ai_personality: 'excluded in v1 (changes what the bot says to everyone)',
    update_moderation_settings: 'excluded in v1 (chat protection)',
    update_follow_defense_settings: 'excluded in v1 (raid/follow protection)',
    delete_goal: 'no undo (the goal and its progress are gone)',
    show_ui: 'site UI (sandboxed card in the panel)',
    navigate: 'site UI (moves the browser)',
};

/** MCP-only tools (never in the site registry). */
export const MCP_ONLY_TOOLS: readonly string[] = ['list_recent_changes', 'undo_change'];

/**
 * Logged changes undo_change may undo: the ones the MCP write tools make, and the retired create_timer (its undo
 * deletes a timer, like delete_timer). Changes from site-only tools are undone on the website.
 */
export function mcpUndoable(tool: string): boolean {
    return tool === 'create_timer' || (Object.hasOwn(MCP_ALLOWLIST, tool) && !MCP_ONLY_TOOLS.includes(tool) && /^(create|update|delete|add|remove)_/.test(tool));
}

/** MCP-only tools throw it to refuse with an `ExecuteOutcome` code; nothing was changed. */
export class ToolDeniedError extends Error {
    constructor(readonly code: 'permission_denied' | 'plan_required' | 'insufficient_scope', message: string, readonly requiredScopes?: string[]) {
        super(message);
    }
}
