import type { ExecutionContext, IStreamerData } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import * as ChannelFunctions from '../../../functions/channels/index.js';
import * as ChatFunctions from '../../../functions/chats/index.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';

const subsHandler: FunctionHandler = async (_args, ctx) => {
    const result = await ChannelFunctions.getChannelSubscriptions(ctx.broadcasterId);
    if (result.error) {
        return `Error fetching subscribers: ${result.message}`;
    }
    return String(result.total || 0);
};

const titleHandler: FunctionHandler = async (_args, ctx) => {
    const result = await ChannelFunctions.getChannelInformation(ctx.broadcasterId);
    if (result.error) {
        return `Error fetching channel title: ${result.message}`;
    }
    return result.data?.title || 'No title set';
};

const gameHandler: FunctionHandler = async (_args, ctx) => {
    if (ctx.extraContext?.game) {
        return String(ctx.extraContext.game);
    }
    const result = await ChannelFunctions.getChannelInformation(ctx.broadcasterId);
    if (result.error) {
        return `Error fetching game: ${result.message}`;
    }
    return result.data?.game_name || 'No game set';
};

const viewersHandler: FunctionHandler = async (_args, ctx) => {
    if (ctx.extraContext?.viewers !== undefined) {
        return String(ctx.extraContext.viewers);
    }
    const result = await ChatFunctions.getChatters(ctx.broadcasterId, ctx.broadcasterId);
    if (result.error) {
        return result.message;
    }
    return String(result.chatters?.length || 0);
};

const followsHandler: FunctionHandler = async (_args, ctx) => {
    const result = await ChannelFunctions.getTwitchFollowers(ctx.broadcasterId);
    if (result.error) {
        return `Error fetching followers: ${result.message}`;
    }
    return String(result.total || 0);
};

const channelHandler: FunctionHandler = async (_args, ctx) => {
    const extraContext = ctx.extraContext as Record<string, unknown> | undefined;
    
    if (extraContext?.broadcasterName) {
        return String(extraContext.broadcasterName);
    }
    
    let streamer = ctx.streamer;
    if (!streamer) {
        streamer = await TwitchStreamers.getTwitchAccountById(ctx.broadcasterId) as IStreamerData | null;
    }
    
    if (!streamer) {
        const result = await ChannelFunctions.getChannelInformation(ctx.broadcasterId, true);
        if (result.error) {
            return 'Streamer with provided ID does not exist';
        }
        return result.data.broadcaster_name || 'Unknown';
    }
    
    return streamer.name || 'Unknown';
};

const channelLoginHandler: FunctionHandler = async (_args, ctx) => {
    const extraContext = ctx.extraContext as Record<string, unknown> | undefined;

    if (extraContext?.broadcasterLogin) {
        return String(extraContext.broadcasterLogin);
    }

    const result = await ChannelFunctions.getChannelInformation(ctx.broadcasterId, true);
    if (!result.error && result.data?.broadcaster_login) {
        return String(result.data.broadcaster_login);
    }

    let streamer = ctx.streamer;
    if (!streamer) {
        streamer = await TwitchStreamers.getTwitchAccountById(ctx.broadcasterId) as IStreamerData | null;
    }

    if (streamer?.name) {
        return String(streamer.name).toLowerCase();
    }

    return 'unknown';
};

export function registerTwitchFunctions(): void {
    registerFunction('twitch.subs', subsHandler, {
        description: 'Returns the total subscriber count of the channel.',
        syntax: 'twitch.subs',
        category: 'twitch-data',
        examples: ['twitch.subs'],
        keywords: ['subscribers', 'subs', 'suscriptores', 'cuantos subs']
    });
    registerFunction('twitch.title', titleHandler, {
        description: 'Returns the current stream title.',
        syntax: 'twitch.title',
        category: 'twitch-data',
        examples: ['twitch.title'],
        keywords: ['title', 'stream title', 'titulo actual']
    });
    registerFunction('twitch.game', gameHandler, {
        description: 'Returns the current game/category of the stream.',
        syntax: 'twitch.game',
        category: 'twitch-data',
        examples: ['twitch.game'],
        keywords: ['game', 'category', 'juego actual', 'categoria actual']
    });
    registerFunction('twitch.viewers', viewersHandler, {
        description: 'Returns the current viewer count.',
        syntax: 'twitch.viewers',
        category: 'twitch-data',
        examples: ['twitch.viewers'],
        keywords: ['viewers', 'espectadores', 'cuanta gente', 'cuantos viewers']
    });
    registerFunction('twitch.follows', followsHandler, {
        description: 'Returns the total follower count of the channel.',
        syntax: 'twitch.follows',
        category: 'twitch-data',
        examples: ['twitch.follows'],
        keywords: ['followers', 'follows', 'seguidores', 'cuantos followers']
    });
    registerFunction('twitch.channel', channelHandler, {
        description: 'Returns the display name of the channel.',
        syntax: 'twitch.channel',
        category: 'twitch-data',
        examples: ['twitch.channel'],
        keywords: ['channel name', 'nombre del canal', 'broadcaster name']
    });
    registerFunction('twitch.login', channelLoginHandler, {
        description: 'Returns the login name (lowercase, URL-safe) of the channel.',
        syntax: 'twitch.login',
        category: 'twitch-data',
        examples: ['twitch.login'],
        keywords: ['channel login', 'login del canal', 'username del canal']
    });
}
