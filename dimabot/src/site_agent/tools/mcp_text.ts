/**
 * Shared words for MCP tool descriptions (`AgentTool.mcpDescription`). On MCP there is no approval card: a write
 * applies at once, is logged and can be undone with undo_change, and its command text must pass the safe-body guard
 * (`safe_body.ts`). Only name functions from SAFE_FUNCTIONS here; mcp_descriptions.test.ts checks every `$(…)`.
 */

/** Ends every MCP write description. */
export const MCP_APPLIES = 'Applies immediately and is logged; undo_change reverts it.';

const REPLY_FUNCTIONS = 'reply functions ($(user), $(random N), $(count), text helpers, event values, Twitch reads), variables and math';

/**
 * For writes whose command text the safe-body guard checks. `stored`: a sentence naming the stored text the change
 * also lets run (the change is refused, not made, when that text does more than reply).
 */
export function mcpCommandText(stored?: string): string {
    return `Command text may only use ${REPLY_FUNCTIONS}; anything else is refused (set it up on the website).`
        + (stored ? ` ${stored}` : '') + ' Test new text with test_command.';
}

/** For removals the guard checks: `stored` names the text that keeps running afterwards. */
export function mcpStoredText(stored: string): string {
    return `${stored} must only use ${REPLY_FUNCTIONS}; otherwise this is refused (do it on the website).`;
}
