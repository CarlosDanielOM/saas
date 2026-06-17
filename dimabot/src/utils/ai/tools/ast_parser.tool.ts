/**
 * AST Parser Tool
 * 
 * Provides AI with controlled access to execute bot commands via AST syntax.
 * The AI calls this tool when it needs to perform moderation actions,
 * channel management, or other bot operations.
 */

import { parseAndEvaluate } from '../../ast_parser/index.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import type { IStreamerData } from './code_execution.tool.js';
import type { IUsersCache } from '../../../interfaces/cache/users.cache.interface.js';

export interface ASTParserToolResult {
    success: boolean;
    result?: string;
    error?: string;
}

export interface ASTParserToolContext {
    channelID: string;
    streamer: IStreamerData;
    username?: string;
    tags?: Record<string, unknown>;
}

export interface ASTParserArgs {
    /** The AST command to execute. Do NOT include the $() wrapper - just the command name and arguments.
     * Examples: 'ban offensiveuser 300', 'set.title New Stream Title', 'add.vip gooduser' */
    command: string;
    /** The userlevel to use for permission checking.
     * - 7 for mod actions (ban, vip, clear.chat)
     * - 8 for broadcaster actions (set.title, set.game, add.mod)
     * For automated AI calls, use 7. */
    userlevel: number;
}

/**
 * Execute an AST command via the AI tool interface.
 */
export async function execute(
    args: ASTParserArgs,
    context: ASTParserToolContext
): Promise<ASTParserToolResult> {
    const { command, userlevel } = args;

    // Use channelID from context - the harness provides this
    const channelID = context.channelID;

    if (!command || typeof command !== 'string') {
        return {
            success: false,
            error: 'Command is required and must be a string'
        };
    }

    if (!channelID || typeof channelID !== 'string') {
        return {
            success: false,
            error: 'Channel ID is missing from context'
        };
    }

    if (typeof userlevel !== 'number' || userlevel < 1 || userlevel > 9) {
        return {
            success: false,
            error: 'Userlevel must be a number between 1 and 9'
        };
    }

    try {
        // Get streamer data for context
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);

        // Cast streamer to IStreamerData for AST parser compatibility
        const streamerData = streamer as IStreamerData | null;

        // Build ExecutionContext for AST parser
        const execContext = {
            broadcasterId: channelID,
            userId: context.username || 'AI',
            userLogin: context.username || 'AI',
            userDisplayName: context.username || 'AI',
            userPlan: (streamerData?.plan_tier as 'free' | 'premium' | 'pro') || 'free',
            userLevel: userlevel,
            streamer: streamerData
        };

        // Wrap command in $(...) if not already wrapped
        let astCommand = command.trim();
        if (!astCommand.startsWith('$(')) {
            astCommand = `$(${astCommand})`;
        }

        // Execute the AST command
        const { result } = await parseAndEvaluate(astCommand, execContext);

        const resultStr = String(result ?? 'Command executed successfully');

        // Filter out empty results (many AST commands return empty string on success)
        if (resultStr === '' || resultStr === 'undefined' || resultStr === 'null') {
            return {
                success: true,
                result: 'Command executed successfully'
            };
        }

        return {
            success: true,
            result: resultStr
        };
    } catch (error) {
        console.error('AST Parser tool error:', {
            command,
            channelID: context.channelID,
            userlevel,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}