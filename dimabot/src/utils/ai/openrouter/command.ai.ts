/**
 * AI Command Handler for $(ai) Commands
 * 
 * Handles one-off AI command executions with tiered model selection.
 * Now uses the main chat harness which includes tool calling (AST_PARSER, search, code_execution).
 */

import { chat, getChannelPersonality, type IRouterResponse } from './ai.js';
import { error } from '../../logger.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface AiCommandResponse {
    error: boolean;
    message: string;
}

export interface UserContext {
    username: string;
    badges?: string;
    /** Verified permission level of the invoking user (1-10). Used to clamp tool permissions. */
    userLevel?: number;
}

export interface ModelInfo {
    model: string;
    tier: 'free' | 'premium' | 'pro';
    maxTokens: number;
}

export interface IStreamerData {
    user_id?: string;
    name?: string;
    plan_tier?: 'free' | 'premium' | 'pro';
    polar_sh_customer_id?: string;
    [key: string]: any;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sanitizes AI output to prevent command injection.
 * CRITICAL: Escapes $, %, and * to prevent recursive command parsing.
 * 
 * @param output - Raw AI response
 * @returns Sanitized output safe for command handler
 */
export function sanitizeOutput(output: unknown): string {
    if (typeof output !== 'string') return String(output || '');
    
    return output
        .replace(/\$/g, '\\$')
        .replace(/%/g, '\\%')
        .replace(/\*/g, '\\*');
}

// ============================================================================
// MAIN COMMAND HANDLER
// ============================================================================

/**
 * Executes an AI command for $(ai prompt) syntax.
 * Uses the main chat harness which supports tool calling (AST_PARSER, search, code_execution).
 * 
 * @param streamer - Streamer object from cache
 * @param userContext - User context object
 * @param userContext.username - Username of the person invoking the command
 * @param userContext.badges - Optional formatted badge string
 * @param prompt - The prompt text to send to the AI
 * @param reason - The reason for the AI command (default: 'commands')
 * @returns Result object
 */
export async function executeAiCommand(
    streamer: IStreamerData,
    userContext: UserContext,
    prompt: string,
    reason: string = 'commands'
): Promise<AiCommandResponse> {
    const channelID = streamer?.user_id;
    
    if (!prompt || prompt.trim() === '') {
        return {
            error: true,
            message: '[AI: No prompt provided]'
        };
    }
    
    if (!channelID) {
        return {
            error: true,
            message: '[AI: Channel context unavailable]'
        };
    }

    try {
        const personality = await getChannelPersonality(channelID);
        if (personality?.enabled === false) {
            return {
                error: false,
                message: '[AI: Chat responses disabled]'
            };
        }

        // Call the main chat harness which supports tool calling
        const response: IRouterResponse = await chat({
            channelID,
            message: prompt,
            streamer: streamer as any,
            history: [],  // No history for command-style $(ai) calls
            tags: {
                badges: [],  // Command-style calls don't have badge context
                username: userContext.username,
                userLevel: userContext.userLevel ?? 1
            }
        });

        if (response.error) {
            await error({
                function: 'executeAiCommand',
                error: 'Chat harness returned error',
                details: response.message
            }, { channelId: channelID, destination: 'both' });
            
            return {
                error: true,
                message: response.message || '[AI: Service error]'
            };
        }

        // Sanitize output to prevent command injection
        const sanitizedOutput = sanitizeOutput(response.message || '');
        
        return {
            error: false,
            message: sanitizedOutput
        };

    } catch (err) {
        await error({
            function: 'executeAiCommand',
            error: 'Unexpected error in AI command',
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: channelID, destination: 'both' });
        
        return {
            error: true,
            message: '[AI: Connection error]'
        };
    }
}

/**
 * Gets model information for a given streamer tier.
 * Useful for displaying to users what model they're using.
 * 
 * @param streamer - Streamer object from cache
 * @returns Model info
 */
export function getModelInfo(streamer: IStreamerData | null | undefined): ModelInfo {
    // Import here to avoid circular dependency issues
    const { MODELS, TOKEN_LIMITS } = require('../constants.js');
    
    let tier: 'free' | 'premium' | 'pro' = 'free';
    let model = MODELS.free;
    
    if (streamer?.plan_tier === 'pro') {
        tier = 'pro';
        model = MODELS.pro;
    } else if (streamer?.plan_tier === 'premium') {
        tier = 'premium';
        model = MODELS.premium;
    }
    
    return {
        model,
        tier,
        maxTokens: TOKEN_LIMITS[model as keyof typeof TOKEN_LIMITS] || TOKEN_LIMITS.default
    };
}
