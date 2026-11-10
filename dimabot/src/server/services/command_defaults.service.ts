import { writeCommandWithCooldown, CommandCooldownError } from '../../utils/command_cooldown_write.js';
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
    message?: string;
    description?: Partial<Record<SupportedLanguage, string>> | string;
    enabled?: boolean;
    cooldown?: number;
    userLevel?: number;
    userLevelName?: string;
    /** Needs the streamer's full Twitch approval (broadcaster scopes or the bot as moderator). */
    requiresFullAccess?: boolean;
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

/** Defaults that work with only the bot in chat (no Twitch API call that needs the streamer's approval). */
const BASIC_RESERVED_COMMANDS = RESERVED_COMMANDS.filter((command) => !command.requiresFullAccess);
/** Built-in (undeletable) basic defaults: all present means the basic set was added before. */
const BASIC_RESERVED_MARKERS = BASIC_RESERVED_COMMANDS.filter((command) => command.reserved);

export async function ensureReservedCommands(channelID: string, channelName: string, options: { basicOnly?: boolean } = {}): Promise<number> {
    const commands = options.basicOnly ? BASIC_RESERVED_COMMANDS : RESERVED_COMMANDS;
    let createdCount = 0;

    for (const commandData of commands) {

        // Skip a default when the channel already has it, or already uses its chat name
        // (streamers can make their own `!s` or `!so` before they turn the defaults on).
        const exists = await CommandsSchema.exists({
            $or: [{ func: commandData.func }, { cmd: commandData.cmd }],
            activation: { $ne: 'keyword' },
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
            message: commandData.message || '',
            responses: [],
            paused: false,
            platform: 'twitch',
            premiumRequired: false,
            premiumLevelRequired: 0,
            createdAt: new Date()
        });

        try {
            if (!newCommand.reserved && newCommand.cooldown === 0) {
                try {
                    await writeCommandWithCooldown(channelID, 0, null, () => newCommand.save());
                } catch (error) {
                    if (!(error instanceof CommandCooldownError)) throw error;
                    // Existing custom commands retain their slot when missing defaults are added.
                    newCommand.cooldown = 5;
                    await newCommand.save();
                }
            } else {
                await newCommand.save();
            }
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

/**
 * Adds the defaults that work without full access (TTS `!s`, `!commands`, `!cc`, `!clip`, games...)
 * for a channel that only added the bot to chat. Timers need stream start/end events, so their
 * commands wait for full access like the other Twitch-dependent ones.
 * Full access later adds the rest through `ensureReservedCommands`.
 */
export async function ensureBasicReservedCommands(channelID: string, channelName: string): Promise<number> {
    // Complete when every undeletable basic default exists (or the streamer's own command took
    // its name/job, which the seed skips too). An interrupted seed is finished on the next call;
    // a finished one is never repeated, so editable defaults the streamer deleted stay deleted.
    const present = await CommandsSchema.find({
        channelID,
        activation: { $ne: 'keyword' },
        $or: [
            { func: { $in: BASIC_RESERVED_MARKERS.map((command) => command.func) } },
            { cmd: { $in: BASIC_RESERVED_MARKERS.map((command) => command.cmd) } }
        ]
    }).select('func cmd').lean();
    const funcs = new Set(present.map((command) => command.func));
    const cmds = new Set(present.map((command) => command.cmd));
    if (BASIC_RESERVED_MARKERS.every((command) => funcs.has(command.func) || cmds.has(command.cmd))) {
        return 0;
    }
    return ensureReservedCommands(channelID, channelName, { basicOnly: true });
}
