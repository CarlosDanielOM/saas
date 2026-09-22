import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import JSONCOMMANDS from '../../config/commands/reservedcommands.json' with { type: 'json' };
import { CommandsSchema } from '../../schemas/commands.schema.js';

type SupportedLanguage = 'en' | 'es';

interface ReservedCommandDefinition {
    name: string;
    cmd: string;
    func: string;
    type: string;
    reserved: boolean;
    description?: Partial<Record<SupportedLanguage, string>> | string;
    enabled?: boolean;
    cooldown?: number;
    userLevel?: number;
    userLevelName?: string;
}

interface LocalizedReservedCommandDefinition extends Omit<ReservedCommandDefinition, 'description'> {
    description?: string;
}

type ReservedCommandsPayload =
    | { commands: ReservedCommandDefinition[] }
    | { commands: LocalizedReservedCommandDefinition[] };

const RESERVED_COMMANDS = (JSONCOMMANDS.commands || []) as ReservedCommandDefinition[];
const DEFAULT_COMMAND_ID_NAMESPACE = 'dimabot:default-command:v1';

function getDefaultCommandID(channelID: string, func: string): Types.ObjectId {
    const hex = createHash('sha256')
        .update(JSON.stringify([DEFAULT_COMMAND_ID_NAMESPACE, channelID, func]))
        .digest('hex')
        .slice(0, 24);

    return new Types.ObjectId(hex);
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 11000;
}

export function normalizeSupportedLanguage(language?: string | null): SupportedLanguage {
    return String(language || '').trim().toLowerCase() === 'es' ? 'es' : 'en';
}

export function getReservedCommandDefinition(command: Pick<ReservedCommandDefinition, 'cmd' | 'func'>): ReservedCommandDefinition | null {
    return RESERVED_COMMANDS.find((reservedCommand) => {
        if (command.func && reservedCommand.func === command.func) {
            return true;
        }

        return Boolean(command.cmd) && reservedCommand.cmd === command.cmd;
    }) || null;
}

export function getLocalizedReservedCommandDescription(
    command: Pick<ReservedCommandDefinition, 'cmd' | 'func'>,
    language?: string | null,
    fallbackDescription: string = ''
): string {
    const reservedCommand = getReservedCommandDefinition(command);
    if (!reservedCommand) {
        return fallbackDescription;
    }

    const description = reservedCommand.description;
    if (typeof description === 'string') {
        return description || fallbackDescription;
    }

    const normalizedLanguage = normalizeSupportedLanguage(language);
    return description?.[normalizedLanguage] || description?.en || fallbackDescription;
}

export function getReservedCommandsPayload(language?: string | null): ReservedCommandsPayload {
    if (!language) {
        return {
            commands: RESERVED_COMMANDS
        };
    }

    return {
        commands: RESERVED_COMMANDS.map((command) => ({
            ...command,
            description: getLocalizedReservedCommandDescription(command, language)
        }))
    };
}

export async function ensureReservedCommands(channelID: string, channelName: string): Promise<number> {
    const commands = RESERVED_COMMANDS;
    let createdCount = 0;

    for (const commandData of commands) {

        const exists = await CommandsSchema.exists({
            func: commandData.func,
            channelID
        });

        if (exists) {
            continue;
        }

        const newCommand = new CommandsSchema({
            // A stable _id turns concurrent first-activation seed attempts into
            // one insert plus one duplicate-key no-op. MongoDB always enforces
            // _id uniqueness, so this does not require an index migration over
            // legacy command rows that may already contain duplicates.
            _id: getDefaultCommandID(channelID, commandData.func),
            name: commandData.name,
            cmd: commandData.cmd,
            func: commandData.func,
            type: commandData.type,
            channel: channelName,
            channelID,
            cooldown: commandData.cooldown,
            enabled: commandData.enabled,
            userLevel: commandData.userLevel || 0,
            userLevelName: commandData.userLevelName || 'everyone',
            reserved: commandData.reserved,
            message: '',
            responses: [],
            paused: false,
            platform: 'twitch',
            premiumRequired: false,
            premiumLevelRequired: 0,
            createdAt: new Date()
        });

        try {
            await newCommand.save();
            createdCount += 1;
        } catch (error) {
            if (!isDuplicateKeyError(error)) {
                throw error;
            }

            const concurrentSeed = await CommandsSchema.exists({
                _id: newCommand._id,
                func: commandData.func,
                channelID
            });

            if (!concurrentSeed) {
                throw error;
            }
        }
    }

    return createdCount;
}
