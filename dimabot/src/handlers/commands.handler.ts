import type { ITwitchEventData } from '../interfaces/twitch/eventsub.interface.js';
import Commands from '../classes/command.class.js';
import { parseSpecialCommands } from './special_parser.handler.js';
import { BROADCASTER_USER_LEVEL, commandAllowed, type UserIdentity } from '../utils/permissions/index.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Command data structure from database
 */
interface ICommandData {
    enabled: boolean;
    name?: string;
    cmd?: string;
    message: string;
    type?: string;
    count?: number;
    [key: string]: any;
}

/**
 * Standard response object for command handling
 */
interface ICommandResponse {
    error: boolean;
    message: string;
    status: number;
    type: string;
    command?: ICommandData;
}

/**
 * Explicit authorization context for custom command execution
 * (TAG_PERMISSION_SYSTEM.md §2.4):
 *
 * - `chat`  — direct chat invocation; the command policy governs the
 *   chatter, so the authorization identity is the chatter's resolved
 *   UserIdentity.
 * - `llm`   — an LLM-generated AST referencing the command; the referenced
 *   command's policy is evaluated against the REAL requesting chatter before
 *   the trusted streamer-authored body runs.
 * - `authored` — a nested command reference inside streamer-authored AST;
 *   the outer command/event gate already passed, so no additional command
 *   policy is enforced and the body runs with the trusted broadcaster
 *   identity.
 */
export type CommandExecutionOrigin = 'chat' | 'llm' | 'authored';

export interface CommandExecutionAuthorization {
    origin: CommandExecutionOrigin;
    identity: UserIdentity;
}

// ============================================================================
// MAIN COMMAND HANDLER EXPORT
// ============================================================================

/**
 * Pure policy decision for custom command execution. Trusted authored
 * references skip the per-command gate (the outer gate already passed);
 * direct chat and LLM references evaluate the command's own policy
 * (level or tag expression) against the authorization identity.
 */
export function commandExecutionAllowed(
    command: { permissionExpression?: unknown; userLevel?: unknown } | null | undefined,
    authorization: CommandExecutionAuthorization | undefined
): boolean {
    if (!authorization) {
        // An explicit execution identity/origin is required.
        return false;
    }

    if (authorization.origin === 'authored') {
        return true;
    }

    return commandAllowed(command, authorization.identity);
}

async function commandHandler(
    channelID: string,
    messageEventData: ITwitchEventData | Record<string, unknown>,
    command: string,
    argument?: string,
    authorization?: CommandExecutionAuthorization
): Promise<ICommandResponse> {
    const cmdDB = await Commands.getCommandFromDB(channelID, command);

    if (cmdDB.error || !cmdDB.command) {
        return {
            error: true,
            message: cmdDB.message,
            status: cmdDB.status,
            type: 'command_not_found'
        };
    }

    const commandData: ICommandData = {
        enabled: cmdDB.command.enabled,
        name: cmdDB.command.name,
        cmd: cmdDB.command.cmd,
        message: cmdDB.command.message || '',
        type: cmdDB.command.type,
        count: cmdDB.command.count || 0
    };

    if (!commandData.enabled) {
        return {
            error: true,
            message: 'Command is disabled',
            status: 400,
            type: 'command_disabled'
        };
    }

    // Explicit authorization gate. Direct chat and LLM references evaluate the
    // command's policy against the real chatter; trusted authored references
    // only arrive after the outer command/event gate passed.
    if (!commandExecutionAllowed(cmdDB.command, authorization)) {
        return {
            error: true,
            message: 'You do not have permission to use this command',
            status: 403,
            type: 'permission_denied'
        };
    }

    // The command body is streamer-authored and the outer gate has passed, so
    // it executes with the explicit trusted broadcaster identity — never with
    // an identity inferred from the (possibly synthetic) event badges.
    const specialRes = await parseSpecialCommands(commandData.message, {
        channelID,
        scopeType: 'command',
        scopeName: commandData.cmd || command,
        scopeAliases: commandData.name ? [commandData.name] : [],
        eventData: messageEventData,
        argument: argument || '',
        literalArguments: true,
        count: commandData.count || 0,
        userLevel: BROADCASTER_USER_LEVEL
    });

    if (specialRes.countModified) {
        await Commands.updateCommandInDB(channelID, command, { count: specialRes.count });
    }
    commandData.message = specialRes.parsedText;

    return {
        error: false,
        message: commandData.message,
        status: 200,
        type: 'success',
        command: commandData
    };
}

export { commandHandler };
