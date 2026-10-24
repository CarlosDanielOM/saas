import express, { type Request, type Response } from "express";
import { getDragonflyClient } from "../../utils/databases/dragonfly.database.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { getChannelAccessContext } from "../../middleware/admin.middleware.js";
import { CommandsSchema } from "../../schemas/commands.schema.js";
import UsersSchema from "../../schemas/users.schema.js";
import { ensureReservedCommands, getLocalizedReservedCommandDescription } from "../services/command_defaults.service.js";
import { inspectExpression, LEGACY_USER_LEVEL_NAMES } from "../../utils/permissions/index.js";

import { writeCommandWithCooldown, validateKeywordCooldown, CommandCooldownError } from '../../utils/command_cooldown_write.js';
import { normalizeKeyword, validateKeyword } from '../../utils/keywords.js';
import { refreshKeywordIndex } from '../../utils/keyword_cache.js';
import { MAX_COMMAND_TEXT, BlocksError, importCommandText } from '../../utils/ast_blocks/index.js';
import { CommandBlocksRequestError, presentCommand, resolveCommandBody } from '../services/command_blocks.service.js';

const router = express.Router();

/** Computes the non-localized permission mode for API responses. */
function permissionModeFor(command: { permissionExpression?: unknown }): 'level' | 'tags' | 'invalid' {
    return inspectExpression(command.permissionExpression).mode;
}

function sendBlocksError(res: Response, error: CommandBlocksRequestError) {
    return res.status(error.status).send({
        error: true,
        code: error.code,
        message: error.message,
        ...(error.blockId ? { blockId: error.blockId } : {}),
        status: error.status
    });
}

function isValidUserLevel(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

// Default remains commands for existing clients and the public !command list.
function activationFilter(value: unknown): Record<string, unknown> {
    if (value === 'all') return {};
    if (value === 'keyword') return { activation: 'keyword' };
    return { activation: { $ne: 'keyword' } };
}

router.get('/', async (req: Request, res: Response) => {
        try {
            const query = req.query;
            const limit = parseInt((query.limit as string) || '100');
            const skip = parseInt((query.skip as string) || '0');

            const commands = await CommandsSchema.find(activationFilter(query.activation)).skip(skip).limit(limit).lean();

            const commandsWithMode = commands.map((command) => ({
                ...presentCommand(command),
                permissionMode: permissionModeFor(command)
            }));

            res.send({
                error: false,
                message: 'Commands fetched',
                commands: commandsWithMode,
                status: 200,
                total: commandsWithMode.length
            });
        } catch (error) {
            console.error('Error in GET /:', {
                query: req.query,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Error fetching commands',
                status: 500
            });
        }
    });

router.get('/:channelID', async (req: Request, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const query = req.query;
            const limit = parseInt((query.limit as string) || '100');
            const skip = parseInt((query.skip as string) || '0');
            const language = typeof query.language === 'string' ? query.language : undefined;

            let commands = await CommandsSchema.find({ channelID: channelIdStr, ...activationFilter(query.activation) })
                .select('+blocks')
                .sort({ reserved: -1, name: 1 })
                .skip(skip)
                .limit(limit)
                .lean();

            if (commands.length === 0 && query.activation !== 'keyword') {
                const user = await UsersSchema.findOne({
                    accounts: {
                        $elemMatch: {
                            type: 'twitch',
                            id: channelIdStr,
                            actived: true
                        }
                    }
                }).select('accounts').lean();

                const twitchAccount = user?.accounts?.find((account) => account.type === 'twitch' && account.id === channelIdStr);

                if (twitchAccount?.actived) {
                    const createdCount = await ensureReservedCommands(channelIdStr, twitchAccount.name || channelIdStr);

                    if (createdCount > 0) {
                        commands = await CommandsSchema.find({ channelID: channelIdStr, ...activationFilter(query.activation) })
                            .select('+blocks')
                            .sort({ reserved: -1, name: 1 })
                            .skip(skip)
                            .limit(limit)
                            .lean();
                    }
                }
            }

            const presented = commands.map((command) => {
                const mapped = {
                    ...presentCommand(command, { blocks: true }),
                    permissionMode: permissionModeFor(command)
                };

                if (!command.reserved) {
                    return mapped;
                }

                return {
                    ...mapped,
                    description: getLocalizedReservedCommandDescription(command, language, command.description || '')
                };
            });

            res.send({
                error: false,
                message: 'Commands fetched from database',
                commands: presented,
                status: 200,
                total: presented.length
            });
        } catch (error) {
            console.error('Error in GET /:channelID:', {
                channelID: req.params.channelID,
                query: req.query,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Error fetching commands',
                status: 500
            });
        }
    });

router.post('/:channelID', authMiddleware as any, async (req: Request, res: Response) => {
        try {
            const { channelID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const body = req.body;

            const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
            if (!access.allowed) {
                return res.status(403).send({
                    error: true,
                    message: 'You do not have access to this channel',
                    status: 403
                });
            }

            const usesBlocks = body.authoring === 'blocks';
            if (!body.name || !body.cmd || !body.func || (!usesBlocks && !body.message) || !body.channel) {
                return res.status(400).send({
                    error: true,
                    message: 'Missing required fields',
                    status: 400
                });
            }

            if (body.activation !== undefined && !['command', 'keyword'].includes(body.activation)) {
                return res.status(400).send({ error: true, message: 'Invalid activation type', status: 400 });
            }
            const isKeyword = body.activation === 'keyword';
            let keywordSettings;
            if (isKeyword) {
                try { keywordSettings = validateKeyword(body.cmd, body.keywordSettings); }
                catch (error) { return res.status(400).send({ error: true, message: (error as Error).message, status: 400 }); }
                body.cmd = normalizeKeyword(body.cmd);
                await validateKeywordCooldown(channelIdStr, body.cooldown ?? 10);
            } else if (body.keywordSettings !== undefined) {
                return res.status(400).send({ error: true, message: 'Keyword settings require keyword activation', status: 400 });
            }

            // Permission mode validation: missing/null creates level mode; a
            // non-null expression must validate (tag mode cannot be empty —
            // universal access is {role:'everyone'}).
            const permissionState = inspectExpression(body.permissionExpression);
            if (permissionState.mode === 'invalid') {
                return res.status(400).send({
                    error: true,
                    message: `Invalid permission expression: ${permissionState.error}`,
                    status: 400
                });
            }

            // Validate the numeric level. The display name is stored as
            // provided so existing dashboard clients (which still use the
            // legacy labels) keep working; the numeric level is the source
            // of truth for authorization either way.
            const userLevel = body.userLevel === undefined ? 1 : Number(body.userLevel);
            if (!isValidUserLevel(userLevel)) {
                return res.status(400).send({
                    error: true,
                    message: 'userLevel must be an integer between 1 and 10',
                    status: 400
                });
            }
            const userLevelName = typeof body.userLevelName === 'string' && body.userLevelName
                ? body.userLevelName
                : LEGACY_USER_LEVEL_NAMES[userLevel];

            const existingCommand = await CommandsSchema.findOne({
                channelID: channelIdStr,
                ...activationFilter(isKeyword ? 'keyword' : 'command'),
                cmd: body.cmd
            });

            if (existingCommand) {
                return res.status(409).send({
                    error: true,
                    message: 'Command already exists',
                    command: presentCommand(existingCommand),
                    status: 409
                });
            }

            const reply = await resolveCommandBody(channelIdStr, body, null);

            const newCommand = new CommandsSchema({
                name: body.name,
                cmd: body.cmd,
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
                channelID: channelIdStr,
                channel: body.channel,
            });

            if (isKeyword) await newCommand.save();
            else await writeCommandWithCooldown(channelIdStr, newCommand.cooldown, null, () => newCommand.save());

            const cacheClient = await getDragonflyClient();
            if (isKeyword) await refreshKeywordIndex(channelIdStr, String(newCommand._id));
            else {
                await cacheClient.del(`${channelIdStr}:commands:${body.cmd}`);
                await cacheClient.del(`${channelIdStr}:commands:${body.name}`);
            }

            res.send({
                error: false,
                message: 'Command created',
                command: { ...presentCommand(newCommand, { blocks: true }), permissionMode: permissionModeFor(newCommand) },
                status: 200
            });
        } catch (error) {
            if (error instanceof CommandBlocksRequestError) return sendBlocksError(res, error);
            if (error instanceof CommandCooldownError) return res.status(400).send({ error: true, message: error.message, status: 400 });
            console.error('Error in POST /:channelID:', {
                channelID: req.params.channelID,
                body: req.body,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Error creating command',
                status: 500
            });
        }
    });

router.put('/:channelID/:commandID', authMiddleware as any, async (req: Request, res: Response) => {
        try {
            const { channelID, commandID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const commandIdStr = Array.isArray(commandID) ? commandID[0] : commandID;
            const body = req.body;
            const language = typeof req.query.language === 'string' ? req.query.language : undefined;

            const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
            if (!access.allowed) {
                return res.status(403).send({
                    error: true,
                    message: 'You do not have access to this channel',
                    status: 403
                });
            }

            const cacheClient = await getDragonflyClient();

            const command = await CommandsSchema.findOne({
                channelID: channelIdStr,
                _id: commandIdStr
            });

            if (!command) {
                return res.status(404).send({
                    error: true,
                    message: 'Command not found for this channel',
                    status: 404
                });
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
                return res.status(400).send({ error: true, message: 'Activation type cannot be changed', status: 400 });
            }
            if (isKeyword) {
                try {
                    updatePayload.keywordSettings = validateKeyword(body.cmd ?? command.cmd, body.keywordSettings ?? command.keywordSettings);
                } catch (error) { return res.status(400).send({ error: true, message: (error as Error).message, status: 400 }); }
                if ('cmd' in body) updatePayload.cmd = normalizeKeyword(body.cmd);
                updatePayload.func = 'custom';
                if (body.cooldown !== undefined) await validateKeywordCooldown(channelIdStr, body.cooldown);
            } else if (body.keywordSettings !== undefined) {
                return res.status(400).send({ error: true, message: 'Keyword settings require keyword activation', status: 400 });
            }
            if ('cmd' in updatePayload && updatePayload.cmd !== command.cmd) {
                const conflict = await CommandsSchema.exists({ channelID: channelIdStr,
                    _id: { $ne: commandIdStr }, cmd: updatePayload.cmd,
                    ...activationFilter(isKeyword ? 'keyword' : 'command') });
                if (conflict) return res.status(409).send({ error: true, message: 'Activation already exists', status: 409 });
            }

            // Reply text or blocks (plan, size and block checks live in the service).
            if (!command.reserved) {
                Object.assign(updatePayload, await resolveCommandBody(channelIdStr, body, command));
            } else if (body.authoring === 'blocks') {
                return res.status(400).send({ error: true, code: 'reserved', message: 'Built-in commands can\'t use blocks', status: 400 });
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
                    return res.status(400).send({
                        error: true,
                        message: `Invalid permission expression: ${permissionState.error}`,
                        status: 400
                    });
                }

                updatePayload.permissionExpression = permissionState.mode === 'tags'
                    ? permissionState.expression
                    : null;

                if (permissionState.mode === 'level') {
                    const level = Number(body.userLevel);
                    if (!isValidUserLevel(level)) {
                        return res.status(400).send({
                            error: true,
                            message: 'Switching to level mode requires a valid userLevel (1-10)',
                            status: 400
                        });
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
                    return res.status(400).send({
                        error: true,
                        message: 'userLevel must be an integer between 1 and 10',
                        status: 400
                    });
                }
                if (updatePayload.userLevelName === undefined) {
                    updatePayload.userLevelName = LEGACY_USER_LEVEL_NAMES[level];
                }
            }

            const writeUpdate = () => CommandsSchema.findOneAndUpdate(
                { channelID: channelIdStr, _id: commandIdStr },
                updatePayload,
                { new: true }
            ).select('+blocks').exec();
            const updatedCommand = isKeyword ? await writeUpdate()
                : await writeCommandWithCooldown(channelIdStr, updatePayload.cooldown, command, writeUpdate);

            if (!updatedCommand) {
                return res.status(404).send({
                    error: true,
                    message: 'Command not found for this channel',
                    status: 404
                });
            }

            // Invalidate both the previous and current command-name cache
            // keys — even when equal — so a rename can never leave the old
            // name executable through a stale one-hour cache entry.
            if (isKeyword) await refreshKeywordIndex(channelIdStr, commandIdStr);
            else {
                await cacheClient.del(`${channelIdStr}:commands:${command.cmd}`);
                await cacheClient.del(`${channelIdStr}:commands:${updatedCommand.cmd}`);
            }

            const commandResponse: Record<string, unknown> = presentCommand(updatedCommand, { blocks: true });
            commandResponse.permissionMode = permissionModeFor(updatedCommand);
            if (commandResponse.reserved) {
                commandResponse.description = getLocalizedReservedCommandDescription(
                    commandResponse as never,
                    language,
                    String(commandResponse.description || '')
                );
            }

            res.send({
                error: false,
                message: 'Command updated',
                command: commandResponse,
                status: 200
            });
        } catch (error) {
            if (error instanceof CommandBlocksRequestError) return sendBlocksError(res, error);
            if (error instanceof CommandCooldownError) return res.status(400).send({ error: true, message: error.message, status: 400 });
            console.error('Error in PUT /:channelID/:commandID:', {
                channelID: req.params.channelID,
                commandID: req.params.commandID,
                body: req.body,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Error updating command',
                status: 500
            });
        }
    });

router.delete('/:channelID/:commandID', authMiddleware as any, async (req: Request, res: Response) => {
        try {
            const { channelID, commandID } = req.params;
            const channelIdStr = Array.isArray(channelID) ? channelID[0] : channelID;
            const commandIdStr = Array.isArray(commandID) ? commandID[0] : commandID;

            const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
            if (!access.allowed) {
                return res.status(403).send({
                    error: true,
                    message: 'You do not have access to this channel',
                    status: 403
                });
            }

            const cacheClient = await getDragonflyClient();

            const command = await CommandsSchema.findOne({
                channelID: channelIdStr,
                _id: commandIdStr
            });

            if (!command) {
                return res.status(404).send({
                    error: true,
                    message: 'Command not found for this channel',
                    status: 404
                });
            }

            if (command.reserved) {
                return res.status(403).send({
                    error: true,
                    message: 'Cannot delete reserved command',
                    status: 403
                });
            }

            const deletedCommand = await CommandsSchema.findOneAndDelete({
                channelID: channelIdStr,
                _id: commandIdStr
            });

            if (!deletedCommand) {
                return res.status(404).send({
                    error: true,
                    message: 'Command not found for this channel',
                    status: 404
                });
            }

            if (deletedCommand.activation === 'keyword') await refreshKeywordIndex(channelIdStr, commandIdStr);
            else await cacheClient.del(`${channelIdStr}:commands:${deletedCommand.cmd}`);

            res.send({
                error: false,
                message: 'Command deleted',
                command: presentCommand(deletedCommand),
                status: 200
            });
        } catch (error) {
            console.error('Error in DELETE /:channelID/:commandID:', {
                channelID: req.params.channelID,
                commandID: req.params.commandID,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString()
            });

            res.status(500).send({
                error: true,
                message: 'Error deleting command',
                status: 500
            });
        }
    });

/**
 * Command text → blocks for the editor's import box. Any channel editor may
 * use it (free channels too: the editor is a try-out until they upgrade).
 */
router.post('/:channelID/blocks/import', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const channelIdStr = String(req.params.channelID);
        const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
        if (!access.allowed) {
            return res.status(403).send({ error: true, message: 'You do not have access to this channel', status: 403 });
        }
        const text = req.body?.text;
        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).send({ error: true, code: 'missing_text', message: 'Paste the command text to import', status: 400 });
        }
        if (text.length > MAX_COMMAND_TEXT) {
            return res.status(400).send({ error: true, code: 'too_long', message: `The text is too long (${text.length} of ${MAX_COMMAND_TEXT} characters)`, status: 400 });
        }
        const imported = importCommandText(text);
        res.set('Cache-Control', 'no-store');
        res.send({ error: false, message: 'Imported', root: imported.root, advancedCount: imported.advancedCount, status: 200 });
    } catch (error) {
        if (error instanceof BlocksError) {
            return res.status(400).send({ error: true, code: 'blocks_invalid', message: error.message, status: 400 });
        }
        console.error('Error in POST /:channelID/blocks/import:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).send({ error: true, message: 'Error importing command text', status: 500 });
    }
});

export const commandRoute = router;
