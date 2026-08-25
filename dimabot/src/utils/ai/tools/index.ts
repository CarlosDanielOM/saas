/**
 * Tool Registry
 * 
 * Loads tool definitions from tools.json and provides tool execution.
 */

import toolsJson from '../tools.json' with { type: 'json' };
import { execute as searchExecute, type SearchToolResult } from './search.tool.js';
import { execute as codeExecutionExecute, type CodeExecutionToolResult, type IStreamerData } from './code_execution.tool.js';
import { execute as astParserExecute, type ASTParserToolResult } from './ast_parser.tool.js';
import { execute as createMemoryExecute, type CreateMemoryToolResult } from './create_memory.tool.js';
import { execute as chatSummaryExecute, type ChatSummaryToolResult } from './chat_summary.tool.js';
import { execute as streamStatsExecute, type StreamStatsToolResult } from './stream_stats.tool.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * OpenAI-compatible function parameter definition
 */
export interface FunctionParameter {
    type: string;
    description?: string;
    properties?: Record<string, FunctionParameter>;
    required?: string[];
    items?: FunctionParameter;
    enum?: string[];
}

/**
 * OpenAI-compatible function definition from tools.json
 */
export interface ToolFunction {
    name: string;
    description?: string;
    parameters: {
        type: string;
        properties?: Record<string, FunctionParameter>;
        required?: string[];
    };
}

/**
 * Tool definition from tools.json
 */
export interface ToolDefinition {
    type: string;
    function: ToolFunction;
}

/**
 * Tools JSON structure
 */
interface ToolsJson {
    tools: ToolDefinition[];
}

/**
 * Context passed to tool executors
 */
export interface ToolContext {
    channelID: string;
    streamer: IStreamerData;
    username?: string;
    userID?: string;
    tags?: Record<string, any>;
}

/**
 * Union type for all tool results
 */
export type ToolResult = SearchToolResult | CodeExecutionToolResult | ASTParserToolResult | CreateMemoryToolResult | ChatSummaryToolResult | StreamStatsToolResult;

// ============================================================================
// TOOL REGISTRY
// ============================================================================

/**
 * Map of tool name -> execute function
 */
const toolExecutors: Record<string, (args: any, context: ToolContext) => Promise<ToolResult>> = {
    search: searchExecute,
    code_execution: codeExecutionExecute,
    AST_PARSER: astParserExecute,
    create_memory: createMemoryExecute,
    chat_summary: chatSummaryExecute,
    stream_stats: streamStatsExecute
};

/**
 * Get all tool definitions in OpenAI-compatible format for API calls
 */
export function getToolDefinitions(): ToolDefinition[] {
    return (toolsJson as unknown as ToolsJson).tools;
}

/**
 * Get tool definition by name
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
    return (toolsJson as unknown as ToolsJson).tools.find(t => t.function.name === name);
}

/**
 * Get all tool names
 */
export function getToolNames(): string[] {
    return (toolsJson as unknown as ToolsJson).tools.map(t => t.function.name);
}

/**
 * Check if a tool exists in the registry
 */
export function hasTool(name: string): boolean {
    return name in toolExecutors;
}

/**
 * Execute a tool by name with the provided arguments
 */
export async function executeTool(
    name: string,
    args: any,
    context: ToolContext
): Promise<ToolResult> {
    if (!hasTool(name)) {
        return {
            success: false,
            error: `Tool '${name}' not found in registry`
        };
    }

    const executor = toolExecutors[name];
    return executor(args, context);
}

// ============================================================================
// RE-EXPORTS FOR CONVENIENCE
// ============================================================================

export { type SearchToolResult, type SearchResult, type ISearchResult } from './search.tool.js';
export { type CodeExecutionToolResult, type IStreamerData, type IToolContext, type ICodePlanResult, type ICodeGenerationResult, type ISandboxExecutionResult } from './code_execution.tool.js';
export { type ASTParserToolResult } from './ast_parser.tool.js';
export { type CreateMemoryToolResult } from './create_memory.tool.js';
export { type ChatSummaryToolResult } from './chat_summary.tool.js';
export { type StreamStatsToolResult } from './stream_stats.tool.js';
