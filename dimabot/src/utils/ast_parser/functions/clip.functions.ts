import { registerFunction, type FunctionHandler } from '../evaluator.js';
import * as ClipFunctions from '../../../functions/clips/index.js';
import { targetUser, targetChannel } from './shoutout_target.js';
import { parseClipOptions, type CreateClipOptions } from '../../../commands/create_clip.command.js';

function parseRawArgument(args: unknown[], fallback?: string): string {
    if (args.length > 0) {
        return args.map(arg => String(arg)).join(' ').trim();
    }
    return String(fallback || '').trim();
}

const createClipHandler: FunctionHandler = async (args, ctx) => {
    const rawArgument = parseRawArgument(args, ctx.argument);
    const options: CreateClipOptions = parseClipOptions(rawArgument);
    const result = await ClipFunctions.createClip(ctx.broadcasterId, options);
    if (result.error || !result.clipID) {
        return '';
    }
    return `https://clips.twitch.tv/${result.clipID}`;
};

export function registerClipFunctions(): void {
    registerFunction('show.clip', async (args, ctx) => {
        try {
            const user = await targetUser(ctx, args[0]);
            if (!user) return '';
            const [channel, clips] = await Promise.all([targetChannel(ctx, args[0]), ClipFunctions.getChannelClips(user.id)]);
            if (channel && !clips.error && clips.data?.length) await ClipFunctions.showClip(ctx.broadcasterId, clips.data, user, channel, false);
        } catch { /* best effort */ }
        return '';
    }, { description: 'Best effort: shows a cached selected clip from the target login (optional @) on the overlay. Missing or invalid targets, no clips or disconnected overlay produce no output.', syntax: 'show.clip target', category: 'clip', examples: ['show.clip streamer'], minUserLevel: 7, keywords: ['clip', 'overlay', 'show clip', 'mostrar clip'] });
    registerFunction('create.clip', createClipHandler, {
        description: 'Creates a clip of the current stream moment and returns the clip URL. Optional clip title.',
        syntax: 'create.clip [title]',
        category: 'clip',
        examples: ['create.clip', 'create.clip Epic win'],
        minUserLevel: 7,
        keywords: ['clip', 'create clip', 'crear clip', 'clip this', 'momento']
    });
}
