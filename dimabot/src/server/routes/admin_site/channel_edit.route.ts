import express from 'express';
import mongoose from 'mongoose';
import { CommandsSchema } from '../../../schemas/commands.schema.js';
import EventsubSchema from '../../../schemas/eventsub.schema.js';
import UsersSchema from '../../../schemas/users.schema.js';
import {
    CommandMutationError, createChannelCommand, deleteChannelCommand, updateChannelCommand, type CommandWriteBody
} from '../../services/command_mutations.service.js';
import { CommandBlocksRequestError } from '../../services/command_blocks.service.js';
import { CommandCooldownError } from '../../../utils/command_cooldown_write.js';
import { updateChannelEventsub } from '../../services/eventsub_config.service.js';
import { COMMAND_ROW_FIELDS, EVENTSUB_ROW_FIELDS, EVENTSUB_SETTING_TYPES, commandRow, eventsubRow } from './channel_rows.js';
import { AdminRequestError, ownerDelete, ownerPatch, ownerPost, ownerPut, reply, type AuthRequest } from './shared.js';

/**
 * Owner console edits of a channel's commands and Twitch event chat settings, mounted under `/admin-site`.
 *
 * The owner edits as they could in the database: these routes call the same write services as the site with
 * `override`, which skips the streamer's plan limits, built-in command locks, the 0-second slot, the raid field
 * list and "can't be disabled". Integrity checks stay (a trigger used twice, invalid blocks or permission rules,
 * keyword format), and the caches the bot reads are refreshed exactly as for a site edit. Bits rules are edited
 * through the site's `/bits-rules/:channelID` API, which the owner can use for any channel.
 */
const router = express.Router();

const COMMAND_FIELDS = ['name', 'cmd', 'func', 'message', 'authoring', 'blocks', 'activation', 'keywordSettings', 'cooldown', 'enabled',
    'userLevel', 'userLevelName', 'permissionExpression', 'description', 'channel'] as const;
const TEXT_MAX = 10_000;

function channelID(req: AuthRequest): string {
    const value = String(req.params.channelID || '');
    if (!/^\d{1,20}$/.test(value)) throw new AdminRequestError('Channel not found', 404);
    return value;
}

function objectID(value: unknown, what: string): string {
    if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw new AdminRequestError(`${what} not found`, 404);
    return value;
}

async function requireChannel(id: string): Promise<string> {
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id } } }).select('accounts.type accounts.id accounts.name').maxTimeMS(5000).lean();
    const account = owner?.accounts?.find(item => item.type === 'twitch' && String(item.id) === id);
    if (!account) throw new AdminRequestError('Channel not found', 404);
    return String(account.name || '');
}

/** Only the command fields the console edits, with their types checked; anything else is refused, not ignored. */
function commandBody(raw: unknown): CommandWriteBody {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdminRequestError('Invalid command');
    const body = raw as Record<string, unknown>;
    const unknown = Object.keys(body).filter(key => !(COMMAND_FIELDS as readonly string[]).includes(key));
    if (unknown.length) throw new AdminRequestError(`Unknown command fields: ${unknown.join(', ')}`);
    for (const key of ['name', 'cmd', 'func', 'message', 'description', 'userLevelName', 'channel'] as const) {
        if (key in body && (typeof body[key] !== 'string' || (body[key] as string).length > TEXT_MAX)) throw new AdminRequestError(`Invalid ${key}`);
    }
    if ('cmd' in body && !(body.cmd as string).trim()) throw new AdminRequestError('The trigger is empty');
    if ('cooldown' in body && (typeof body.cooldown !== 'number' || !Number.isInteger(body.cooldown) || body.cooldown < 0 || body.cooldown > 86_400)) {
        throw new AdminRequestError('Cooldown must be whole seconds from 0 to 86,400');
    }
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new AdminRequestError('Invalid enabled');
    if ('userLevel' in body && typeof body.userLevel !== 'number') throw new AdminRequestError('Invalid userLevel');
    if ('authoring' in body && body.authoring !== 'text' && body.authoring !== 'blocks') throw new AdminRequestError('Invalid authoring');
    if ('activation' in body && body.activation !== 'command' && body.activation !== 'keyword') throw new AdminRequestError('Invalid activation');
    // Rows carry blocks as stored (`{ v, root }`); the compiler takes the root. Accept both shapes.
    const blocks = body.blocks as { v?: unknown; root?: unknown } | undefined;
    if (blocks && typeof blocks === 'object' && !Array.isArray(blocks) && 'v' in blocks && 'root' in blocks) body.blocks = blocks.root;
    return body;
}

/** Service errors → the console's plain messages (all of these are safe to show). */
function commandError(error: unknown): never {
    if (error instanceof CommandMutationError) throw new AdminRequestError(error.message, error.status === 409 ? 409 : error.status === 404 ? 404 : 400);
    if (error instanceof CommandBlocksRequestError) throw new AdminRequestError(error.message, 400);
    if (error instanceof CommandCooldownError) throw new AdminRequestError(error.message, 400);
    throw error;
}

async function commandView(channel: string, id: string) {
    const row = await CommandsSchema.findOne({ channelID: channel, _id: id }).select(COMMAND_ROW_FIELDS).maxTimeMS(5000).lean();
    if (!row) throw new AdminRequestError('Command not found', 404);
    return commandRow(row);
}

/** POST /users/:channelID/commands — create (only `cmd` is required; a plain text reply by default). */
ownerPost(router, '/users/:channelID/commands', async (req) => {
    const channel = channelID(req);
    const login = await requireChannel(channel);
    const body = commandBody(req.body);
    const created = await createChannelCommand(channel, { channel: login, ...body }, { override: true }).catch(commandError);
    return reply(await commandView(channel, String(created.command._id)), 'Command created');
});

/** PUT /users/:channelID/commands/:commandID — change only the fields sent. */
ownerPut(router, '/users/:channelID/commands/:commandID', async (req) => {
    const channel = channelID(req);
    const id = objectID(req.params.commandID, 'Command');
    const body = commandBody(req.body);
    if (!Object.keys(body).length) throw new AdminRequestError('Nothing to change');
    await updateChannelCommand(channel, id, body, { override: true }).catch(commandError);
    return reply(await commandView(channel, id), 'Command saved');
});

/** DELETE /users/:channelID/commands/:commandID — built-in commands too. No undo. */
ownerDelete(router, '/users/:channelID/commands/:commandID', async (req) => {
    const channel = channelID(req);
    const id = objectID(req.params.commandID, 'Command');
    const deleted = await deleteChannelCommand(channel, id, { override: true }).catch(commandError);
    return reply({ id, cmd: String(deleted.command.cmd || '') }, 'Command deleted');
});

/**
 * PATCH /users/:channelID/eventsubs/:id — the stored chat settings of a subscription (every config field the
 * schema has, typed). Never its Twitch identity (type, condition, transport, status, ids).
 */
ownerPatch(router, '/users/:channelID/eventsubs/:id', async (req) => {
    const channel = channelID(req);
    const id = objectID(req.params.id, 'Subscription');
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdminRequestError('Invalid settings');
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const type = key === 'enabled' ? 'boolean' : EVENTSUB_SETTING_TYPES[key as keyof typeof EVENTSUB_SETTING_TYPES];
        if (!type) throw new AdminRequestError(`Not an editable setting: ${key}`);
        if (typeof value !== type) throw new AdminRequestError(`Invalid ${key}`);
        if (type === 'number' && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000_000)) throw new AdminRequestError(`Invalid ${key}`);
        if (type === 'string' && (value as string).length > TEXT_MAX) throw new AdminRequestError(`${key} is too long`);
        body[key] = value;
    }
    if (!Object.keys(body).length) throw new AdminRequestError('Nothing to change');
    const result = await updateChannelEventsub(channel, id, body, { override: true });
    if (result.status !== 200) {
        const message = typeof (result.body as { message?: unknown }).message === 'string' ? (result.body as { message: string }).message : 'This could not be saved';
        throw new AdminRequestError(message, result.status === 404 ? 404 : result.status === 409 ? 409 : 400);
    }
    const row = await EventsubSchema.findOne({ _id: id, channelID: channel }).select(EVENTSUB_ROW_FIELDS).maxTimeMS(5000).lean();
    if (!row) throw new AdminRequestError('Subscription not found', 404);
    return reply(eventsubRow(row), 'Saved');
});

export const adminChannelEditRouter = router;
