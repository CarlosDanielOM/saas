import { randomUUID } from 'node:crypto';
import { CommandsSchema } from '../schemas/commands.schema.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { getMinimumCommandCooldown } from './command_cooldown.js';

export class CommandCooldownError extends Error {}

/** Serialize API and chat writes competing for the channel's one editable zero-CD command. */
export async function writeCommandWithCooldown<T>(channelID: string, cooldown: unknown,
    current: { _id?: unknown; cooldown?: number; reserved?: boolean } | null,
    write: () => Promise<T>): Promise<T> {
    if (cooldown === undefined || (current && cooldown === current.cooldown && (cooldown !== 0 || current.reserved))) return write();
    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    const minimum = getMinimumCommandCooldown(streamer?.plan_tier);
    if (typeof cooldown !== 'number' || !Number.isFinite(cooldown) ||
        (cooldown !== 0 && cooldown < minimum)) {
        throw new CommandCooldownError(`Command cooldown must be 0 or at least ${minimum} seconds`);
    }
    if (cooldown !== 0) return write();
    if (current?.reserved) throw new CommandCooldownError('Only editable commands can use the 0-second cooldown slot.');
    const redis = await getDragonflyClient('command-cooldown');
    const key = `command-cooldown-write:${channelID}`;
    const token = randomUUID();
    if (!await redis.set(key, token, { NX: true, EX: 60 })) {
        throw new CommandCooldownError('Another command is being saved. Please retry.');
    }
    try {
        const existing = await CommandsSchema.exists({ channelID, cooldown: 0, reserved: { $ne: true },
            ...(current?._id ? { _id: { $ne: current._id } } : {}) });
        if (existing) throw new CommandCooldownError('Only one editable command per channel can have a 0-second cooldown.');
        return await write();
    } finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
            { keys: [key], arguments: [token] });
    }
}
