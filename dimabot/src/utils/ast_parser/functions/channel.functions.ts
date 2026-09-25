import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { FunctionMetadata } from '../types.js';
import * as ChannelFunctions from '../../../functions/channels/index.js';
import * as ChatFunctions from '../../../functions/chats/index.js';
import * as UserFunctions from '../../../functions/users/index.js';
import { searchCategories } from '../../../functions/search/index.js';
import { createPrediction, getPrediction, endPrediction } from '../../../functions/predictions/index.js';
import { createPoll, getPoll, endPoll } from '../../../functions/polls/index.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { executeAiCommand } from '../../../utils/ai/openrouter/command.ai.js';
import { formatBadges, type IBadge } from '../../../utils/badges.js';
import { getFishVoiceFavorites, type FishVoiceFavorite } from '../../../schemas/channel_fish_voice_favorites.schema.js';
import { setChannelFishVoice } from '../../../schemas/channel_tts_settings.schema.js';
import { FISH_VOICES } from '../../../server/services/tts/fish_tts.service.js';

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

export function resolveAccountVoice(name: string, favorites: FishVoiceFavorite[]): { key: string; label: string } | null {
    const requested = name.trim().toLowerCase();
    if (!requested) return null;

    const builtIn = Object.keys(FISH_VOICES).find(key => key === requested || key.replaceAll('_', ' ') === requested);
    if (builtIn) return { key: builtIn, label: builtIn };

    const favorite = favorites.find(item => item.alias.toLowerCase() === requested)
        ?? favorites.find(item => item.name.trim().toLowerCase() === requested);
    return favorite ? { key: favorite.id, label: favorite.name } : null;
}

const setVoiceHandler: FunctionHandler = async (args, ctx) => {
    const name = parseRawArgument(args, ctx.argument);
    if (!name) return 'Usage: $(set.voice voice_name)';

    try {
        const favorites = await getFishVoiceFavorites(ctx.broadcasterId);
        const voice = resolveAccountVoice(name, favorites);
        if (!voice) return `Error: Voice "${name}" is not on this account. Choose one of the four default voices or a saved favorite.`;

        await setChannelFishVoice(ctx.broadcasterId, voice.key, ctx.streamer?.name || '');
        await ChatFunctions.sendTwitchChatMessage(ctx.broadcasterId, `TTS voice changed to ${voice.label}.`);
        return '';
    } catch (error) {
        console.error('Error setting channel TTS voice:', error);
        return 'Error: Unable to change the TTS voice right now.';
    }
};

const startPredictionHandler: FunctionHandler = async (args, ctx) => {
    const rawInput = parseRawArgument(args, ctx.argument);
    if (!rawInput) {
        return 'Usage: $(start.prediction "title;option1/option2;seconds") — the whole argument must be wrapped in double quotes because ; is reserved syntax';
    }

    const [title = '', optionsRaw = '', durationRaw = ''] = rawInput.split(';').map(part => part.trim());
    const options = optionsRaw
        .split('/')
        .map(option => option.trim())
        .filter(Boolean)
        .map(option => ({ title: option }));
    const duration = Number(durationRaw);

    if (!title || options.length < 2 || isNaN(duration) || duration <= 0) {
        return 'Invalid prediction format. Use: $(start.prediction "title;option1/option2;seconds") — the whole argument must be wrapped in double quotes because ; is reserved syntax';
    }

    const result = await createPrediction(ctx.broadcasterId, title, options, duration);
    return result.error ? `Error starting prediction: ${result.message}` : '';
};

const getPredictionHandler: FunctionHandler = async (_args, ctx) => {
    const current = await getPrediction(ctx.broadcasterId);
    if (current.error) return `Error getting prediction: ${current.message}`;
    if (!current.data?.id || !['ACTIVE', 'LOCKED'].includes(current.data.status || '')) {
        return 'Error getting prediction: there is no active prediction.';
    }

    const options = current.data.outcomes || [];
    if (options.length === 0) return 'Error getting prediction: Twitch returned no outcomes.';
    return `Question: ${current.data.title}\nStatus: ${current.data.status}\nOptions:\n${options.map((option, index) => `${index + 1}: ${option.title}`).join('\n')}`;
};

const endPredictionHandler: FunctionHandler = async (args, ctx) => {
    const rawOption = parseRawArgument(args, ctx.argument);
    if (!rawOption) return 'Usage: $(end.prediction "exact option title") or $(end.prediction option_number)';
    if (/^[\d.]+$/.test(rawOption) && !/^[1-9]\d*$/.test(rawOption)) {
        return 'Error ending prediction: provide a valid option number.';
    }

    // Fetch from Twitch so an absent or stale cache ID cannot select the wrong prediction.
    const current = await getPrediction(ctx.broadcasterId);
    if (current.error) return `Error ending prediction: ${current.message}`;
    if (!current.data?.id || !['ACTIVE', 'LOCKED'].includes(current.data.status || '')) {
        return 'Error ending prediction: there is no active prediction.';
    }

    const outcomes = current.data.outcomes || [];
    let winner;
    if (/^[1-9]\d*$/.test(rawOption)) {
        winner = outcomes[Number(rawOption) - 1];
        if (!winner?.id) return `Error ending prediction: option number must be between 1 and ${outcomes.length}.`;
    } else {
        const matches = outcomes.filter(option => option.title.trim().toLowerCase() === rawOption.toLowerCase());
        if (matches.length > 1) return 'Error ending prediction: ambiguous option title; use the option number shown by get.prediction.';
        winner = matches[0];
        if (!winner?.id) return 'Error ending prediction: use an exact option title shown by get.prediction.';
    }

    const result = await endPrediction(ctx.broadcasterId, current.data.id, 'RESOLVED', winner.id);
    return result.error ? `Error ending prediction: ${result.message}` : '';
};

const cancelPredictionHandler: FunctionHandler = async (_args, ctx) => {
    const current = await getPrediction(ctx.broadcasterId);
    if (current.error) return `Error cancelling prediction: ${current.message}`;
    if (!current.data?.id || !['ACTIVE', 'LOCKED'].includes(current.data.status || '')) {
        return 'Error cancelling prediction: there is no active prediction.';
    }

    const result = await endPrediction(ctx.broadcasterId, current.data.id, 'CANCELED');
    return result.error ? `Error cancelling prediction: ${result.message}` : '';
};

const startPollHandler: FunctionHandler = async (args, ctx) => {
    const rawInput = parseRawArgument(args, ctx.argument);
    if (!rawInput) {
        return 'Usage: $(start.poll "title;option1/option2;seconds") — the whole argument must be wrapped in double quotes because ; is reserved syntax';
    }

    const [title = '', optionsRaw = '', durationRaw = ''] = rawInput.split(';').map(part => part.trim());
    const options = optionsRaw
        .split('/')
        .map(option => option.trim())
        .filter(Boolean)
        .map(option => ({ title: option }));
    const duration = Number(durationRaw);

    if (!title || options.length < 2 || isNaN(duration) || duration <= 0) {
        return 'Invalid poll format. Use: $(start.poll "title;option1/option2;seconds") — the whole argument must be wrapped in double quotes because ; is reserved syntax';
    }

    const result = await createPoll(ctx.broadcasterId, title, options, duration);
    return result.error ? `Error starting poll: ${result.message}` : '';
};

const endPollHandler: FunctionHandler = async (_args, ctx) => {
    const current = await getPoll(ctx.broadcasterId);
    if (current.error) return `Error ending poll: ${current.message}`;
    if (!current.data?.id || current.data.status !== 'ACTIVE') {
        return 'Error ending poll: there is no active poll.';
    }

    const result = await endPoll(ctx.broadcasterId, current.data.id, 'ARCHIVED');
    return result.error ? `Error ending poll: ${result.message}` : '';
};

const cancelPollHandler: FunctionHandler = async (_args, ctx) => {
    const current = await getPoll(ctx.broadcasterId);
    if (current.error) return `Error cancelling poll: ${current.message}`;
    if (!current.data?.id || current.data.status !== 'ACTIVE') {
        return 'Error cancelling poll: there is no active poll.';
    }

    const result = await endPoll(ctx.broadcasterId, current.data.id, 'TERMINATED');
    return result.error ? `Error cancelling poll: ${result.message}` : '';
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
        minUserLevel: 7,
        keywords: ['raid', 'raidear', 'raid to channel']
    });
    registerFunction('unraid', unraidHandler, {
        description: 'Cancels an active raid.',
        syntax: 'unraid',
        category: 'channel',
        examples: ['unraid'],
        minUserLevel: 7,
        keywords: ['cancel raid', 'unraid', 'cancelar raid']
    });
    registerFunction('set.title', setTitleHandler, {
        description: 'Changes the stream title.',
        syntax: 'set.title new title text',
        category: 'channel',
        examples: ['set.title Cozy late night stream'],
        minUserLevel: 7,
        keywords: ['title', 'stream title', 'titulo', 'cambiar titulo']
    });
    registerFunction('set.game', setGameHandler, {
        description: 'Changes the stream category. Searches Twitch categories by name and picks the best match.',
        syntax: 'set.game game name',
        category: 'channel',
        examples: ['set.game Just Chatting'],
        minUserLevel: 7,
        keywords: ['game', 'category', 'juego', 'categoria', 'cambiar juego']
    });
    registerFunction('set.voice', setVoiceHandler, {
        description: 'Changes the channel default Fish TTS voice to one of the four built-in voices or a saved favorite. Also selects Fish as the TTS provider. A voice outside this account is rejected.',
        syntax: 'set.voice voice_name',
        category: 'tts',
        examples: ['set.voice gojo', 'set.voice rias_gremory', 'set.voice favorite_alias'],
        minUserLevel: 7,
        keywords: ['voice', 'tts voice', 'fish audio', 'change voice', 'cambiar voz', 'voz favorita']
    });
    registerFunction('start.prediction', startPredictionHandler, {
        description: 'Starts a channel points prediction (betting with points). Options are separated by / and the three parts (title, options, seconds) by ;. Requires 2-10 options. The whole argument must be wrapped in double quotes because ; is reserved syntax.',
        syntax: 'start.prediction "title;option1/option2;seconds"',
        category: 'channel',
        examples: ['start.prediction "Will we win?;Yes/No;120"'],
        minUserLevel: 7,
        keywords: ['prediction', 'prediccion', 'bet', 'apuesta']
    });
    registerFunction('get.prediction', getPredictionHandler, {
        description: 'Reads the current active or locked prediction from Twitch and returns its question and numbered option titles. Call this before end.prediction so the winner matches the question and actual option order.',
        syntax: 'get.prediction',
        category: 'channel',
        examples: ['get.prediction'],
        minUserLevel: 7,
        keywords: ['current prediction', 'prediction options', 'read prediction', 'opciones prediccion']
    });
    registerFunction('end.prediction', endPredictionHandler, {
        description: 'Resolves the current active or locked prediction with the exact winning option title or its number (starting at 1). Call get.prediction first to inspect the question and actual option order. The current prediction is fetched again before resolving.',
        syntax: 'end.prediction "exact option title"',
        category: 'channel',
        examples: ['end.prediction "No"', 'end.prediction 1'],
        minUserLevel: 7,
        destructive: true,
        keywords: ['end prediction', 'resolve prediction', 'terminar prediccion', 'resolver prediccion']
    });
    registerFunction('cancel.prediction', cancelPredictionHandler, {
        description: 'Cancels the current active or locked channel points prediction without choosing a winner. Fetches the current prediction from Twitch.',
        syntax: 'cancel.prediction',
        category: 'channel',
        examples: ['cancel.prediction'],
        minUserLevel: 7,
        destructive: true,
        keywords: ['cancel prediction', 'refund prediction', 'cancelar prediccion']
    });
    registerFunction('start.poll', startPollHandler, {
        description: 'Starts a chat poll. Options are separated by / and the three parts (title, options, seconds) by ;. Requires 2-5 options. The whole argument must be wrapped in double quotes because ; is reserved syntax.',
        syntax: 'start.poll "title;option1/option2;seconds"',
        category: 'channel',
        examples: ['start.poll "Best map?;Nuke/Mirage/Inferno;120"'],
        minUserLevel: 7,
        keywords: ['poll', 'encuesta', 'vote', 'votar', 'votacion']
    });
    registerFunction('end.poll', endPollHandler, {
        description: 'Ends the current active poll and archives its results. Fetches the current poll from Twitch.',
        syntax: 'end.poll',
        category: 'channel',
        examples: ['end.poll'],
        minUserLevel: 7,
        destructive: true,
        keywords: ['end poll', 'archive poll', 'terminar encuesta', 'archivar encuesta']
    });
    registerFunction('cancel.poll', cancelPollHandler, {
        description: 'Terminates the current active poll without archiving its results. Fetches the current poll from Twitch.',
        syntax: 'cancel.poll',
        category: 'channel',
        examples: ['cancel.poll'],
        minUserLevel: 7,
        destructive: true,
        keywords: ['cancel poll', 'terminate poll', 'cancelar encuesta']
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
