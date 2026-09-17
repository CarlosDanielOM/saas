import { CommandsSchema, type ICommands } from '../schemas/commands.schema.js';
import { commandAllowed, createDefaultIdentity, type UserIdentity } from '../utils/permissions/index.js';

interface CommandListResponse {
    error: boolean;
    message: string;
}

type VisibleCommandRow = Pick<ICommands, 'type' | 'cmd' | 'userLevel' | 'permissionExpression'>;

/**
 * Commands visible to an identity: every enabled non-timer command whose
 * permission policy (level or tag expression) allows that identity. Fixes the
 * legacy equality bug where commands at exactly the caller's level were
 * hidden (`userLevel >= caller` hid equal-level commands).
 */
export function visibleCommandNames(commands: VisibleCommandRow[], identity: UserIdentity): string[] {
    const names: string[] = [];

    for (const command of commands) {
        if (command.type === 'timer') continue;
        if (commandAllowed(command, identity)) {
            names.push(command.cmd);
        }
    }

    return names;
}

export async function commandListCommand(channelID: string, identity: UserIdentity = createDefaultIdentity(), type: string = 'all'): Promise<CommandListResponse> {
    try {
        const commands = await CommandsSchema.find({ channelID, enabled: true });

        if (!commands) {
            return {
                error: true,
                message: 'No commands found'
            };
        }

        const filteredCommands = visibleCommandNames(commands, identity);

        return {
            error: false,
            message: `List of commands available are: ${filteredCommands.join(', ')}`
        };
    } catch (error) {
        console.error(`Error in commandListCommand:`, {
            channelID,
            identityLevel: identity.level,
            type,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
