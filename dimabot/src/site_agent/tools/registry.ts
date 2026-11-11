/**
 * All site-agent tools, filtered per requester. A tool is offered only if the requester holds
 * ALL of its permissions and the channel's plan allows it, so the model never sees actions the
 * person couldn't do by hand. Permissions are re-checked on every call and before every apply.
 */
import { SITE_AGENT_LIMITS } from '../config.js';
import type { AgentTool, LlmToolDefinition, PlanTier } from '../types.js';
import { knowledgeTools } from './knowledge.js';
import { readTools } from './read.js';
import { settingsReadTools } from './settings_read.js';
import { commandTools } from './write/commands.js';
import { timerTools } from './write/timers.js';
import { settingsTools } from './write/settings/index.js';
import { streamTools } from './stream.js';
import { uiTools } from './ui.js';

const PLAN_ORDER: Record<PlanTier, number> = { free: 0, premium: 1, pro: 2 };

let all: Map<string, AgentTool> | null = null;

export function allTools(): Map<string, AgentTool> {
    if (!all) {
        all = new Map();
        for (const tool of [...knowledgeTools, ...readTools, ...settingsReadTools, ...commandTools, ...timerTools, ...settingsTools, ...streamTools, ...uiTools]) {
            if (all.has(tool.name)) throw new Error(`Duplicate site agent tool: ${tool.name}`);
            all.set(tool.name, tool as AgentTool);
        }
    }
    return all;
}

export function getTool(name: string): AgentTool | undefined {
    return allTools().get(name);
}

export function planAllows(tool: AgentTool, plan: PlanTier): boolean {
    return !tool.minPlan || PLAN_ORDER[plan] >= PLAN_ORDER[tool.minPlan];
}

/** Tools this requester may use on this channel. */
export async function toolsFor(can: (permissions: readonly string[]) => Promise<boolean>, plan: PlanTier, role: 'owner' | 'admin'): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    for (const tool of allTools().values()) {
        if (!planAllows(tool, plan)) continue;
        if (tool.permissions.includes('owner') && role !== 'owner') continue;
        if (await can(tool.permissions.filter((permission) => permission !== 'owner'))) tools.push(tool);
    }
    return tools;
}

export function toLlmTools(tools: AgentTool[]): LlmToolDefinition[] {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

/** JSON for the model, cut to the size limit with a note so the model can narrow its request. */
export function toolResultText(value: unknown, limit: number = SITE_AGENT_LIMITS.toolResultBytes): string {
    let text: string;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
    if (Buffer.byteLength(text, 'utf8') <= limit) return text;
    const cut = Buffer.from(text, 'utf8').subarray(0, limit - 200).toString('utf8').replace(/�$/, '');
    return `${cut}\n…[result cut at ${limit} bytes: ask for less, e.g. a narrower query, one section, or the next page]`;
}
