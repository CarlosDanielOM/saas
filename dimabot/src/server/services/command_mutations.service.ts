/**
 * Create, update, delete (and restore) a channel's chat commands and keywords. Shared by the
 * commands page routes (`server/routes/command.route.ts`) and the site assistant's command tools,
 * so both apply the same validation, built-in rules, cooldown policy, block handling and cache
 * invalidation.
 *
 * Errors:
 * - `CommandMutationError` — validation/state problems with an HTTP status (400/403/404/409);
 * - `CommandBlocksRequestError` (block/reply checks) and `CommandCooldownError` (cooldown policy)
 *   come from the helpers unchanged;
 * - anything else is unexpected (the route answers 500).
 */
import type { HydratedDocument } from 'mongoose';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { CommandsSchema, type ICommands } from '../../schemas/commands.schema.js';
import { getLocalizedReservedCommandDescription } from './command_defaults.service.js';
import { inspectExpression, LEGACY_USER_LEVEL_NAMES } from '../../utils/permissions/index.js';
import { writeCommandWithCooldown, validateKeywordCooldown } from '../../utils/command_cooldown_write.js';
import { normalizeKeyword, validateKeyword } from '../../utils/keywords.js';
import { refreshKeywordIndex } from '../../utils/keyword_cache.js';
import { presentCommand, resolveCommandBody } from './command_blocks.service.js';

export type CommandDocument = HydratedDocument<ICommands>;

/**
 * Request body of the commands page (all optional; presence matters for updates).
 * Values are checked here, so they stay `unknown`.
 */
export interface CommandWriteBody {
    name?: unknown;
    cmd?: unknown;
    func?: unknown;
    message?: unknown;
    channel?: unknown;
    activation?: unknown;
    keywordSettings?: unknown;
    authoring?: unknown;
    blocks?: unknown;
    responses?: unknown;
    type?: unknown;
    description?: unknown;
    cooldown?: unknown;
    enabled?: unknown;
    userLevel?: unknown;
    userLevelName?: unknown;
    permissionExpression?: unknown;
    [key: string]: unknown;
}

export interface CommandMutationResult {
    command: CommandDocument;
    /** What the commands page receives: `presentCommand` (+ blocks) and `permissionMode`. */
    view: Record<string, unknown>;
}

export interface CommandDeleteResult extends CommandMutationResult {
    /** JSON-safe copy of the deleted document (blocks included) for `restoreDeletedCommand`. */
    raw: Record<string, unknown>;
}

export class CommandMutationError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        /** Machine code when the route sends one (`reserved`), or `changed` for a failed guard. */
        public readonly code?: string,
        /** The command that already uses the trigger (create conflicts). */
        public readonly existing?: Record<string, unknown>,
    ) {
        super(message);
    }
}

/** Computes the non-localized permission mode for API responses. */
export function permissionModeFor(command: { permissionExpression?: unknown }): 'level' | 'tags' | 'invalid' {
    return inspectExpression(command.permissionExpression).mode;
}

export function isValidUserLevel(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

// Default remains commands for existing clients and the public !command list.
export function activationFilter(value: unknown): Record<string, unknown> {
    if (value === 'all') return {};
    if (value === 'keyword') return { activation: 'keyword' };
    return { activation: { $ne: 'keyword' } };
}

function present(command: CommandDocument): Record<string, unknown> {
    return { ...presentCommand(command, { blocks: true }), permissionMode: permissionModeFor(command) };
}

/** POST /commands/:channelID. */
export async function createChannelCommand(channelID: string, body: CommandWriteBody): Promise<CommandMutationResult> {
    const usesBlocks = body.authoring === 'blocks';
    if (!body.name || !body.cmd || !body.func || (!usesBlocks && !body.message) || !body.channel) {
        throw new CommandMutationError(400, 'Missing required fields');
    }

    if (body.activation !== undefined && !['command', 'keyword'].includes(body.activation as string)) {
        throw new CommandMutationError(400, 'Invalid activation type');
    }
    const isKeyword = body.activation === 'keyword';
    let cmd = body.cmd;
    let keywordSettings;
    if (isKeyword) {
        try { keywordSettings = validateKeyword(body.cmd, body.keywordSettings); }
        catch (error) { throw new CommandMutationError(400, (error as Error).message); }
        cmd = normalizeKeyword(body.cmd as string);
        await validateKeywordCooldown(channelID, body.cooldown ?? 10);
    } else if (body.keywordSettings !== undefined) {
        throw new CommandMutationError(400, 'Keyword settings require keyword activation');
    }

    // Permission mode validation: missing/null creates level mode; a
    // non-null expression must validate (tag mode cannot be empty —
    // universal access is {role:'everyone'}).
    const permissionState = inspectExpression(body.permissionExpression);
    if (permissionState.mode === 'invalid') {
        throw new CommandMutationError(400, `Invalid permission expression: ${permissionState.error}`);
    }

    // Validate the numeric level. The display name is stored as
    // provided so existing dashboard clients (which still use the
    // legacy labels) keep working; the numeric level is the source
    // of truth for authorization either way.
    const userLevel = body.userLevel === undefined ? 1 : Number(body.userLevel);
    if (!isValidUserLevel(userLevel)) {
        throw new CommandMutationError(400, 'userLevel must be an integer between 1 and 10');
    }
    const userLevelName = typeof body.userLevelName === 'string' && body.userLevelName
        ? body.userLevelName
        : LEGACY_USER_LEVEL_NAMES[userLevel];

    const existingCommand = await CommandsSchema.findOne({
        channelID,
        ...activationFilter(isKeyword ? 'keyword' : 'command'),
        cmd
    });

    if (existingCommand) {
        throw new CommandMutationError(409, 'Command already exists', undefined, presentCommand(existingCommand));
    }

    const reply = await resolveCommandBody(channelID, body, null);

    const newCommand = new CommandsSchema({
        name: body.name,
        cmd,
        activation: isKeyword ? 'keyword' : 'command',
        keywordSettings,
        func: isKeyword ? 'custom' : body.func,
        message: reply.message,
        authoring: reply.authoring ?? 'text',
        blocks: reply.blocks ?? null,
        responses: body.responses ?? [],
        type: body.type ?? 'command',
        reserved: false,
        description: body.description ?? '',
        cooldown: body.cooldown ?? 10,
        enabled: body.enabled ?? true,
        userLevelName: userLevelName,
        userLevel: userLevel,
        permissionExpression: permissionState.mode === 'tags' ? permissionState.expression : null,
        channelID,
        channel: body.channel,
    });

    if (isKeyword) await newCommand.save();
    else await writeCommandWithCooldown(channelID, newCommand.cooldown, null, () => newCommand.save());

    const cacheClient = await getDragonflyClient();
    if (isKeyword) await refreshKeywordIndex(channelID, String(newCommand._id));
    else {
        await cacheClient.del(`${channelID}:commands:${cmd}`);
        await cacheClient.del(`${channelID}:commands:${body.name}`);
    }

    return { command: newCommand, view: present(newCommand) };
}

export interface CommandUpdateOptions {
    /** `?language=` of the request: built-in descriptions come back localized. */
    language?: string;
    /**
     * Extra equality filter on the write (compare-and-set). When the stored command no longer
     * matches, nothing is written and a 409 `changed` error is thrown. The route never sets it.
     */
    guard?: Record<string, unknown>;
}

/** PUT /commands/:channelID/:commandID. */
export async function updateChannelCommand(channelID: string, commandID: string, body: CommandWriteBody, options: CommandUpdateOptions = {}): Promise<CommandMutationResult & { previous: CommandDocument }> {
    const cacheClient = await getDragonflyClient();

    const command = await CommandsSchema.findOne({
        channelID,
        _id: commandID
    });

    if (!command) {
        throw new CommandMutationError(404, 'Command not found for this channel');
    }

    const updatePayload: Record<string, unknown> = {};
    const updatableFields = ['name', 'cmd', 'func', 'responses', 'type', 'description', 'cooldown', 'enabled', 'userLevelName', 'userLevel'] as const;
    for (const field of updatableFields) {
        if (field in body) {
            updatePayload[field] = body[field];
        }
    }

    const isKeyword = command.activation === 'keyword';
    if (body.activation !== undefined && body.activation !== (command.activation ?? 'command')) {
        throw new CommandMutationError(400, 'Activation type cannot be changed');
    }
    if (isKeyword) {
        try {
            updatePayload.keywordSettings = validateKeyword(body.cmd ?? command.cmd, body.keywordSettings ?? command.keywordSettings);
        } catch (error) { throw new CommandMutationError(400, (error as Error).message); }
        if ('cmd' in body) updatePayload.cmd = normalizeKeyword(body.cmd as string);
        updatePayload.func = 'custom';
        if (body.cooldown !== undefined) await validateKeywordCooldown(channelID, body.cooldown);
    } else if (body.keywordSettings !== undefined) {
        throw new CommandMutationError(400, 'Keyword settings require keyword activation');
    }
    if ('cmd' in updatePayload && updatePayload.cmd !== command.cmd) {
        const conflict = await CommandsSchema.exists({ channelID,
            _id: { $ne: commandID }, cmd: updatePayload.cmd,
            ...activationFilter(isKeyword ? 'keyword' : 'command') });
        if (conflict) throw new CommandMutationError(409, 'Activation already exists');
    }

    // Reply text or blocks (plan, size and block checks live in the service).
    if (!command.reserved) {
        Object.assign(updatePayload, await resolveCommandBody(channelID, body, command));
    } else if (body.authoring === 'blocks') {
        throw new CommandMutationError(400, 'Built-in commands can\'t use blocks', 'reserved');
    }

    if (command.reserved && 'description' in updatePayload) {
        delete updatePayload.description;
    }

    // Permission mode updates: missing leaves the mode unchanged;
    // explicit null switches to level mode (requires a valid
    // level/name pair); a valid tree switches to tag mode.
    if ('permissionExpression' in body) {
        const permissionState = inspectExpression(body.permissionExpression);
        if (permissionState.mode === 'invalid') {
            throw new CommandMutationError(400, `Invalid permission expression: ${permissionState.error}`);
        }

        updatePayload.permissionExpression = permissionState.mode === 'tags'
            ? permissionState.expression
            : null;

        if (permissionState.mode === 'level') {
            const level = Number(body.userLevel);
            if (!isValidUserLevel(level)) {
                throw new CommandMutationError(400, 'Switching to level mode requires a valid userLevel (1-10)');
            }
            updatePayload.userLevel = level;
            // Keep the caller-provided display name (legacy dashboard
            // labels included); only fall back when it is missing.
            updatePayload.userLevelName = typeof body.userLevelName === 'string' && body.userLevelName
                ? body.userLevelName
                : LEGACY_USER_LEVEL_NAMES[level];
        }
    } else if ('userLevel' in body) {
        const level = Number(body.userLevel);
        if (!isValidUserLevel(level)) {
            throw new CommandMutationError(400, 'userLevel must be an integer between 1 and 10');
        }
        if (updatePayload.userLevelName === undefined) {
            updatePayload.userLevelName = LEGACY_USER_LEVEL_NAMES[level];
        }
    }

    const writeUpdate = () => CommandsSchema.findOneAndUpdate(
        { channelID, _id: commandID, ...(options.guard ?? {}) },
        updatePayload,
        { new: true }
    ).select('+blocks').exec();
    const updatedCommand = isKeyword ? await writeUpdate()
        : await writeCommandWithCooldown(channelID, updatePayload.cooldown, command, writeUpdate);

    if (!updatedCommand) {
        if (options.guard) throw new CommandMutationError(409, 'The command changed since it was read', 'changed');
        throw new CommandMutationError(404, 'Command not found for this channel');
    }

    // Invalidate both the previous and current command-name cache
    // keys — even when equal — so a rename can never leave the old
    // name executable through a stale one-hour cache entry.
    if (isKeyword) await refreshKeywordIndex(channelID, commandID);
    else {
        await cacheClient.del(`${channelID}:commands:${command.cmd}`);
        await cacheClient.del(`${channelID}:commands:${updatedCommand.cmd}`);
    }

    const view = present(updatedCommand);
    if (view.reserved) {
        view.description = getLocalizedReservedCommandDescription(
            view as never,
            options.language,
            String(view.description || '')
        );
    }

    return { command: updatedCommand, previous: command, view };
}

/** DELETE /commands/:channelID/:commandID. Built-in commands can't be deleted. */
export async function deleteChannelCommand(channelID: string, commandID: string, options: { guard?: Record<string, unknown> } = {}): Promise<CommandDeleteResult> {
    const cacheClient = await getDragonflyClient();

    const command = await CommandsSchema.findOne({
        channelID,
        _id: commandID
    });

    if (!command) {
        throw new CommandMutationError(404, 'Command not found for this channel');
    }

    if (command.reserved) {
        throw new CommandMutationError(403, 'Cannot delete reserved command');
    }

    // Blocks are loaded so a restore puts them back; the response never includes them.
    const deletedCommand = await CommandsSchema.findOneAndDelete({
        channelID,
        _id: commandID,
        ...(options.guard ?? {})
    }).select('+blocks');

    if (!deletedCommand) {
        if (options.guard) throw new CommandMutationError(409, 'The command changed since it was read', 'changed');
        throw new CommandMutationError(404, 'Command not found for this channel');
    }

    if (deletedCommand.activation === 'keyword') await refreshKeywordIndex(channelID, commandID);
    else await cacheClient.del(`${channelID}:commands:${deletedCommand.cmd}`);

    return {
        command: deletedCommand,
        view: presentCommand(deletedCommand),
        raw: JSON.parse(JSON.stringify(deletedCommand.toObject({ flattenMaps: true }))) as Record<string, unknown>,
    };
}

/**
 * Puts a deleted command back (same id, use count, variables and blocks) under today's rules:
 * the trigger must be free and the cooldown must fit the channel's plan and 0-second slot.
 */
export async function restoreDeletedCommand(channelID: string, raw: Record<string, unknown>): Promise<CommandMutationResult> {
    if (!raw || raw.channelID !== channelID || typeof raw.cmd !== 'string' || !raw._id || raw.reserved) {
        throw new CommandMutationError(400, 'Nothing to restore');
    }
    const isKeyword = raw.activation === 'keyword';
    const taken = await CommandsSchema.exists({ channelID, cmd: raw.cmd, ...activationFilter(isKeyword ? 'keyword' : 'command') });
    if (taken) {
        throw new CommandMutationError(409, isKeyword ? `Another keyword already uses "${raw.cmd}"` : `Another command already uses !${raw.cmd}`, 'changed');
    }
    if (await CommandsSchema.exists({ _id: raw._id })) {
        throw new CommandMutationError(409, 'The command already exists again', 'changed');
    }

    const create = async () => await CommandsSchema.create({ ...raw }) as unknown as CommandDocument;
    let restored: CommandDocument;
    if (isKeyword) {
        await validateKeywordCooldown(channelID, raw.cooldown);
        restored = await create();
    } else {
        restored = await writeCommandWithCooldown(channelID, raw.cooldown, null, create);
    }

    const cacheClient = await getDragonflyClient();
    if (isKeyword) await refreshKeywordIndex(channelID, String(restored._id));
    else {
        await cacheClient.del(`${channelID}:commands:${raw.cmd}`);
        await cacheClient.del(`${channelID}:commands:${raw.name}`);
    }
    return { command: restored, view: present(restored) };
}
