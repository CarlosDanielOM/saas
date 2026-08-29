import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { FunctionMetadata } from '../types.js';
import * as ChannelFunctions from '../../../functions/channels/index.js';
import * as ChatFunctions from '../../../functions/chats/index.js';
import * as UserFunctions from '../../../functions/users/index.js';
import { searchCategories } from '../../../functions/search/index.js';
import { createPrediction } from '../../../functions/predictions/index.js';
import { createPoll } from '../../../functions/polls/index.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { executeAiCommand } from '../../../utils/ai/openrouter/command.ai.js';
import { formatBadges, type IBadge } from '../../../utils/badges.js';

function parseRawArgument(args: unknown[], fallback?: string): string {
    if (args.length > 0) {
        return args.map(arg => String(arg)).join(' ').trim();
    }
    return String(fallback || '').trim();
}

const raidHandler: FunctionHandler = async (args, ctx) => {
    const raidTarget = (parseRawArgument(args, ctx.argument).split(/\s+/)[0] || '').replace(/^@/, '').toLowerCase();
    if (!raidTarget) return '';

    const raidUserResult = await UserFunctions.getTwitchUserByLogin(raidTarget);
    let targetUserId = raidUserResult.data?.id || '';

    if (!targetUserId) {
        const raidUserData = await TwitchStreamers.getTwitchAccountById(raidTarget);
        if (raidUserData?.id) {
            targetUserId = raidUserData.id;
        }
    }

    if (!targetUserId) {
        return 'User not found';
    }

    const result = await ChannelFunctions.raid(ctx.broadcasterId, targetUserId);
    return result.error || (result.status && result.status >= 400)
        ? (result.message || 'Error raiding channel')
        : '';
};

const unraidHandler: FunctionHandler = async (_args, ctx) => {
    const result = await ChannelFunctions.unraid(ctx.broadcasterId);
    if (result.error) {
        return `Error cancelling raid: ${result.message}`;
    }
    await ChatFunctions.sendTwitchChatMessage(ctx.broadcasterId, 'Raid cancelled!');
    return '';
};

const setTitleHandler: FunctionHandler = async (args, ctx) => {
    const newTitle = parseRawArgument(args, ctx.argument);
    if (!newTitle) {
        return 'Usage: $(set.title new title)';
    }
    const result = await ChannelFunctions.setChannelInformation(ctx.broadcasterId, { title: newTitle });
    if (result.error) {
        return `Error setting title: ${result.message}`;
    }
    await ChatFunctions.sendTwitchChatMessage(ctx.broadcasterId, `Title updated to: ${newTitle}`);
    return '';
};

const setGameHandler: FunctionHandler = async (args, ctx) => {
    const gameQuery = parseRawArgument(args, ctx.argument);
    if (!gameQuery) {
        return 'Usage: $(set.game game name)';
    }

    const gameSearchResult = await searchCategories(gameQuery);
    if (gameSearchResult.error || !gameSearchResult.data || gameSearchResult.data.length === 0) {
        return `Error finding game: ${gameSearchResult.message || 'Game not found'}`;
    }

    const selectedGame = gameSearchResult.data.find(
        game => game.name.toLowerCase() === gameQuery.toLowerCase()
    ) || gameSearchResult.data[0];

    const result = await ChannelFunctions.setChannelInformation(ctx.broadcasterId, { game_id: selectedGame.id });
    if (result.error) {
        return `Error setting game: ${result.message}`;
    }

    await ChatFunctions.sendTwitchChatMessage(ctx.broadcasterId, `Game updated to: ${selectedGame.name}`);
    return '';
};

const startPredictionHandler: FunctionHandler = async (args, ctx) => {
    const rawInput = parseRawArgument(args, ctx.argument);
    if (!rawInput) {
        return 'Usage: $(start.prediction title;option1/option2;seconds)';
    }

    const [title = '', optionsRaw = '', durationRaw = ''] = rawInput.split(';').map(part => part.trim());
    const options = optionsRaw
        .split('/')
        .map(option => option.trim())
        .filter(Boolean)
        .map(option => ({ title: option }));
    const duration = Number(durationRaw);

    if (!title || options.length < 2 || isNaN(duration) || duration <= 0) {
        return 'Invalid prediction format. Use: title;option1/option2;seconds';
    }

    const result = await createPrediction(ctx.broadcasterId, title, options, duration);
    return result.error ? `Error starting prediction: ${result.message}` : '';
};

const startPollHandler: FunctionHandler = async (args, ctx) => {
    const rawInput = parseRawArgument(args, ctx.argument);
    if (!rawInput) {
        return 'Usage: $(start.poll title;option1/option2;seconds)';
    }

    const [title = '', optionsRaw = '', durationRaw = ''] = rawInput.split(';').map(part => part.trim());
    const options = optionsRaw
        .split('/')
        .map(option => option.trim())
        .filter(Boolean)
        .map(option => ({ title: option }));
    const duration = Number(durationRaw);

    if (!title || options.length < 2 || isNaN(duration) || duration <= 0) {
        return 'Invalid poll format. Use: title;option1/option2;seconds';
    }

    const result = await createPoll(ctx.broadcasterId, title, options, duration);
    return result.error ? `Error starting poll: ${result.message}` : '';
};

const adHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = ctx.eventData as Record<string, unknown> | undefined;
    if (eventData?.duration_seconds) {
        return String(eventData.duration_seconds) || '0';
    }
    return '0';
};

const aiHandler: FunctionHandler = async (args, ctx) => {
    const prompt = parseRawArgument(args, ctx.argument);
    if (!prompt) {
        return '[AI: No prompt provided]';
    }

    const streamer = await TwitchStreamers.getTwitchAccountById(ctx.broadcasterId);
    if (!streamer) {
        return '[AI: Streamer context unavailable]';
    }

    const eventData = ctx.eventData as { badges?: IBadge[] } | undefined;
    const badgeFormatting = await formatBadges({
        badges: Array.isArray(eventData?.badges) ? eventData.badges : []
    });

    const result = await executeAiCommand({
        ...streamer,
        user_id: streamer.id
    }, {
        username: ctx.userDisplayName || ctx.userLogin || 'unknown user',
        badges: badgeFormatting.formattedBadges,
        userLevel: ctx.userLevel ?? 1
    }, prompt, 'ast_parser');

    return result.message;
};

export function registerChannelFunctions(): void {
    registerFunction('raid', raidHandler, {
        description: 'Starts a raid to another channel.',
        syntax: 'raid channel',
        category: 'channel',
        examples: ['raid friendlystreamer'],
        minUserLevel: 8,
        keywords: ['raid', 'raidear', 'raid to channel']
    });
    registerFunction('unraid', unraidHandler, {
        description: 'Cancels an active raid.',
        syntax: 'unraid',
        category: 'channel',
        examples: ['unraid'],
        minUserLevel: 8,
        keywords: ['cancel raid', 'unraid', 'cancelar raid']
    });
    registerFunction('set.title', setTitleHandler, {
        description: 'Changes the stream title.',
        syntax: 'set.title new title text',
        category: 'channel',
        examples: ['set.title Cozy late night stream'],
        minUserLevel: 8,
        keywords: ['title', 'stream title', 'titulo', 'cambiar titulo']
    });
    registerFunction('set.game', setGameHandler, {
        description: 'Changes the stream category. Searches Twitch categories by name and picks the best match.',
        syntax: 'set.game game name',
        category: 'channel',
        examples: ['set.game Just Chatting'],
        minUserLevel: 8,
        keywords: ['game', 'category', 'juego', 'categoria', 'cambiar juego']
    });
    registerFunction('start.prediction', startPredictionHandler, {
        description: 'Starts a channel points prediction (betting with points). Options are separated by / and the three parts (title, options, seconds) by ;. Requires 2-10 options.',
        syntax: 'start.prediction title;option1/option2;seconds',
        category: 'channel',
        examples: ['start.prediction Will we win?;Yes/No;120'],
        minUserLevel: 8,
        keywords: ['prediction', 'prediccion', 'bet', 'apuesta']
    });
    registerFunction('start.poll', startPollHandler, {
        description: 'Starts a chat poll. Options are separated by / and the three parts (title, options, seconds) by ;. Requires 2-5 options.',
        syntax: 'start.poll title;option1/option2;seconds',
        category: 'channel',
        examples: ['start.poll Best map?;Nuke/Mirage/Inferno;120'],
        minUserLevel: 8,
        keywords: ['poll', 'encuesta', 'vote', 'votar', 'votacion']
    });
    const adMetadata: FunctionMetadata = {
        description: 'Returns the duration in seconds of the current ad break (event data).',
        syntax: 'ad.time',
        category: 'event-data',
        examples: ['ad.time'],
        keywords: ['ad', 'commercial', 'anuncio', 'publicidad'],
        surfaces: ['authoring']
    };
    registerFunction('ad', adHandler, { ...adMetadata, aliasOf: 'ad.time' });
    registerFunction('ad.time', adHandler, adMetadata);
    registerFunction('ai', aiHandler, {
        description: 'Generates an AI response for the given prompt using the channel AI personality.',
        syntax: 'ai prompt',
        category: 'ai',
        examples: ['ai tell me a joke'],
        keywords: ['ai', 'ask ai', 'preguntar a la ia', 'generar respuesta']
    });
}
