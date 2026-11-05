import defaults from '../config/commands/reservedcommands.json' with { type: 'json' };
export const defaultShoutoutBody = defaults.commands.find(command => command.func === 'shoutout')!.message!;
export function migrationForShoutout(row: Record<string, any>) {
    if (row.func !== 'shoutout' || row.reserved !== true || row.activation === 'keyword') return null;
    const set: Record<string, unknown> = { reserved: false };
    if ((!row.message || !String(row.message).trim()) && !row.blocks && row.authoring !== 'blocks') set.message = defaultShoutoutBody;
    const filter: Record<string, unknown> = { _id: row._id, func: 'shoutout', reserved: true, activation: { $ne: 'keyword' } };
    for (const key of ['message', 'authoring', 'blocks', 'channelID', 'cmd']) filter[key] = Object.hasOwn(row, key) ? { $eq: row[key] } : { $exists: false };
    return { filter, update: { $set: set } };
}
