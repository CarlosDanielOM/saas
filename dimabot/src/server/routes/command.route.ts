import express, { type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { getChannelAccessContext } from "../../middleware/admin.middleware.js";
import { CommandsSchema } from "../../schemas/commands.schema.js";
import UsersSchema from "../../schemas/users.schema.js";
import { ensureBasicReservedCommands, ensureReservedCommands, getLocalizedReservedCommandDescription } from "../services/command_defaults.service.js";
import { CommandCooldownError } from '../../utils/command_cooldown_write.js';
import { MAX_COMMAND_TEXT, BlocksError, importCommandText } from '../../utils/ast_blocks/index.js';
import { CommandBlocksRequestError, presentCommand } from '../services/command_blocks.service.js';
import {
    activationFilter,
    CommandMutationError,
    createChannelCommand,
    deleteChannelCommand,
    permissionModeFor,
    updateChannelCommand
} from '../services/command_mutations.service.js';
import { RandomUserSettingsSchema } from '../../schemas/randomuser_settings.schema.js';
import { getRandomUserBlacklist, normalizeRandomUserBlacklist } from '../../utils/ast_parser/randomuser_settings.js';

const router = express.Router();

router.get('/:channelID/randomuser-settings', authMiddleware as any, async (req: Request, res: Response) => {
    const channelID = String(req.params.channelID);
    try {
        const access = await getChannelAccessContext((req as any).user?.id, channelID, 'commands:manage');
        if (!access.allowed) return res.status(403).send({ error: true, message: 'You do not have access to this channel', status: 403 });
        const blacklist = await getRandomUserBlacklist(channelID);
        return res.send({ error: false, status: 200, blacklist });
    } catch {
        return res.status(500).send({ error: true, message: 'Unable to load random user settings', status: 500 });
    }
});

router.put('/:channelID/randomuser-settings', authMiddleware as any, async (req: Request, res: Response) => {
    const channelID = String(req.params.channelID);
    try {
        const access = await getChannelAccessContext((req as any).user?.id, channelID, 'commands:manage');
        if (!access.allowed) return res.status(403).send({ error: true, message: 'You do not have access to this channel', status: 403 });
        const blacklist = normalizeRandomUserBlacklist(req.body?.blacklist);
        if (!blacklist) return res.status(400).send({ error: true, message: 'Blacklist must contain at most 200 valid Twitch logins', status: 400 });
        await RandomUserSettingsSchema.updateOne({ channelID }, { $set: { blacklist } }, { upsert: true });
        return res.send({ error: false, status: 200, blacklist });
    } catch {
        return res.status(500).send({ error: true, message: 'Unable to save random user settings', status: 500 });
    }
});

function sendBlocksError(res: Response, error: CommandBlocksRequestError) {
    return res.status(error.status).send({
        error: true,
        code: error.code,
        message: error.message,
        ...(error.blockId ? { blockId: error.blockId } : {}),
        status: error.status
    });
}

/** Same bodies the handlers sent before the service extraction. */
function sendMutationError(res: Response, error: CommandMutationError) {
    return res.status(error.status).send({
        error: true,
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
        ...(error.existing ? { command: error.existing } : {}),
        status: error.status
    });
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

            const owner = await UsersSchema.findOne({
                accounts: { $elemMatch: { type: 'twitch', id: channelIdStr } }
            }).select('accounts').lean();
            const twitchAccount = owner?.accounts?.find((account) => account.type === 'twitch' && account.id === channelIdStr);
            // Without full access only the defaults that need no Twitch approval are added
            // (TTS `!s`, `!commands`, `!cc`, `!clip`...); the site shows the rest locked.
            const fullAccess = twitchAccount ? Boolean(twitchAccount.actived) : undefined;

            if (twitchAccount && !twitchAccount.actived && query.activation !== 'keyword') {
                await ensureBasicReservedCommands(channelIdStr, twitchAccount.name || channelIdStr);
            }

            let commands = await CommandsSchema.find({ channelID: channelIdStr, ...activationFilter(query.activation) })
                .select('+blocks')
                .sort({ reserved: -1, name: 1 })
                .skip(skip)
                .limit(limit)
                .lean();

            if (commands.length === 0 && query.activation !== 'keyword' && twitchAccount?.actived) {
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
                total: presented.length,
                ...(fullAccess === undefined ? {} : { fullAccess })
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

            const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
            if (!access.allowed) {
                return res.status(403).send({
                    error: true,
                    message: 'You do not have access to this channel',
                    status: 403
                });
            }

            const { view } = await createChannelCommand(channelIdStr, req.body);

            res.send({
                error: false,
                message: 'Command created',
                command: view,
                status: 200
            });
        } catch (error) {
            if (error instanceof CommandMutationError) return sendMutationError(res, error);
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
            const language = typeof req.query.language === 'string' ? req.query.language : undefined;

            const access = await getChannelAccessContext((req as any).user?.id, channelIdStr, 'commands:manage');
            if (!access.allowed) {
                return res.status(403).send({
                    error: true,
                    message: 'You do not have access to this channel',
                    status: 403
                });
            }

            const { view } = await updateChannelCommand(channelIdStr, commandIdStr, req.body, { language });

            res.send({
                error: false,
                message: 'Command updated',
                command: view,
                status: 200
            });
        } catch (error) {
            if (error instanceof CommandMutationError) return sendMutationError(res, error);
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

            const { view } = await deleteChannelCommand(channelIdStr, commandIdStr);

            res.send({
                error: false,
                message: 'Command deleted',
                command: view,
                status: 200
            });
        } catch (error) {
            if (error instanceof CommandMutationError) return sendMutationError(res, error);
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
