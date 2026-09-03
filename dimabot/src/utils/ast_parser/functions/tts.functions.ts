import { getChannelTtsSettings } from '../../../schemas/channel_tts_settings.schema.js';
import { requestTts } from '../../../functions/chats/speech.chat.js';
import { queueDefaultTts } from '../../../utils/tts/queue_default_tts.util.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { trackTts } from '../../../utils/posthog_events.js';

/**
 * Result from queueTts - includes both the output string and metadata for tracking
 */
interface QueueTtsResult {
    output: string;
    success: boolean;
    mode: 'speak' | 'clone';
    provider?: 'piper' | 'fish';
    errorMessage?: string;
}

/**
 * Resolve the user identity attached to TTS analytics. When the AST runs
 * without a triggering chatter (timers, nested command refs, server-side
 * renders), attribute the event to the channel instead of sending empty
 * user fields to PostHog.
 */
function resolveTrackingIdentity(ctx: Parameters<FunctionHandler>[1]): { userID: string; username: string } {
    return {
        userID: ctx.userId || ctx.broadcasterId,
        username: ctx.userDisplayName || ctx.userLogin || ctx.streamer?.name || ctx.broadcasterId
    };
}

function parseRawArgument(args: unknown[], fallback?: string): string {
    if (args.length > 0) {
        return args.map((arg) => String(arg)).join(' ').trim();
    }

    return String(fallback || '').trim();
}

function parseCloneArgument(args: unknown[], fallback?: string): { cloneName: string; message: string } {
    if (args.length > 1) {
        return {
            cloneName: String(args[0] || '').trim(),
            message: args.slice(1).map((arg) => String(arg)).join(' ').trim()
        };
    }

    const raw = String(fallback || '').trim();
    if (!raw) {
        return { cloneName: '', message: '' };
    }

    const [cloneName, ...messageParts] = raw.split(/\s+/).filter(Boolean);
    return {
        cloneName: String(cloneName || '').trim(),
        message: messageParts.join(' ').trim()
    };
}

async function queueTts(
    mode: 'default' | 'speak' | 'clone',
    message: string,
    ctx: Parameters<FunctionHandler>[1],
    cloneName?: string
): Promise<QueueTtsResult> {
    if (mode === 'default' || mode === 'speak') {
        const result = await queueDefaultTts({
            channelID: ctx.broadcasterId,
            rawMessage: message,
            source: 'ast',
            preferredMode: mode,
            userID: ctx.userId,
            userLogin: ctx.userLogin,
            userName: ctx.userDisplayName,
            userLevel: ctx.userLevel
        });

        return {
            output: result.error ? result.message : '',
            success: !result.error,
            mode: 'speak',
            provider: 'piper',
            errorMessage: result.error ? result.message : undefined
        };
    }

    const settings = await getChannelTtsSettings(ctx.broadcasterId);

    if (!settings.enabled) {
        return {
            output: 'TTS is disabled for this channel',
            success: false,
            mode: 'clone',
            errorMessage: 'TTS is disabled for this channel'
        };
    }

    const result = await requestTts(ctx.broadcasterId, {
        mode: 'clone',
        provider: 'fish',
        text: message,
        language: settings.defaultLanguage,
        cloneName,
        requestedBy: {
            userID: ctx.userId,
            userLogin: ctx.userLogin,
            userName: ctx.userDisplayName,
            userLevel: ctx.userLevel
        },
        meta: {
            source: 'ast',
            originalText: message,
            skipEmotes: settings.filters.skipEmotes,
            stripLinks: settings.filters.stripLinks
        }
    });

    return {
        output: result.error ? result.message : '',
        success: !result.error,
        mode: 'clone',
        provider: 'fish',
        errorMessage: result.error ? result.message : undefined
    };
}

const ttsSpeakHandler: FunctionHandler = async (args, ctx) => {
    const message = parseRawArgument(args, ctx.argument);
    if (!message) {
        return 'Usage: $(tts message)';
    }

    const result = await queueTts('default', message, ctx);

    // Track TTS usage in PostHog
    trackTts({
        channelID: ctx.broadcasterId,
        channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast',
        ttsType: 'tts',
        characters: message.length,
        message,
        status: result.success ? 'success' : 'error',
        mode: result.mode,
        provider: result.provider,
        ...resolveTrackingIdentity(ctx),
        errorMessage: result.errorMessage,
    });

    return result.output;
};

const ttsExplicitSpeakHandler: FunctionHandler = async (args, ctx) => {
    const message = parseRawArgument(args, ctx.argument);
    if (!message) {
        return 'Usage: $(tts.speak message)';
    }

    const result = await queueTts('speak', message, ctx);

    // Track TTS usage in PostHog
    trackTts({
        channelID: ctx.broadcasterId,
        channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast',
        ttsType: 'tts.speak',
        characters: message.length,
        message,
        status: result.success ? 'success' : 'error',
        mode: result.mode,
        provider: result.provider,
        ...resolveTrackingIdentity(ctx),
        errorMessage: result.errorMessage,
    });

    return result.output;
};

const ttsAiHandler: FunctionHandler = async (args, ctx) => {
    const message = parseRawArgument(args, ctx.argument);
    if (!message) {
        return 'Usage: $(tts.ai message)';
    }

    const result = await queueTts('default', message, ctx);

    trackTts({
        channelID: ctx.broadcasterId,
        channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast',
        ttsType: 'tts.ai',
        characters: message.length,
        message,
        status: result.success ? 'success' : 'error',
        mode: result.mode,
        provider: result.provider,
        ...resolveTrackingIdentity(ctx),
        errorMessage: result.errorMessage,
    });

    return result.output;
};

function createCloneHandler(ttsType: 'tts.clone' | 'tts.fish'): FunctionHandler {
    return async (args, ctx) => {
        const { cloneName, message } = parseCloneArgument(args, ctx.argument);

        if (!cloneName || !message) {
            return `Usage: $(${ttsType} clone_name message)`;
        }

        const result = await queueTts('clone', message, ctx, cloneName);

        trackTts({
            channelID: ctx.broadcasterId,
            channelName: ctx.streamer?.name || ctx.broadcasterId,
            source: 'ast',
            ttsType,
            characters: message.length,
            message,
            status: result.success ? 'success' : 'error',
            mode: result.mode,
            provider: 'fish',
            ...resolveTrackingIdentity(ctx),
            errorMessage: result.errorMessage,
        });

        return result.output;
    };
}

const ttsCloneHandler = createCloneHandler('tts.clone');
const ttsFishHandler = createCloneHandler('tts.fish');

export function registerTtsFunctions(): void {
    const ttsMetadata = {
        description: 'Speaks a message out loud using the channel default TTS voice.',
        syntax: 'tts message',
        category: 'tts',
        examples: ['tts Hello chat!'],
        keywords: ['tts', 'speak', 'text to speech', 'hablar', 'voz', 'di esto']
    };
    registerFunction('tts', ttsSpeakHandler, ttsMetadata);
    registerFunction('tts.speak', ttsExplicitSpeakHandler, { ...ttsMetadata, aliasOf: 'tts' });
    registerFunction('tts.ai', ttsAiHandler, { ...ttsMetadata, aliasOf: 'tts' });
    const cloneMetadata = {
        description: 'Speaks a message with a named Fish Audio cloned voice. First argument is the voice name or voice ID, the rest is the message.',
        syntax: 'tts.clone voice_name message',
        category: 'tts',
        examples: ['tts.clone gojo Hello chat!', 'tts.clone rias_gremory Welcome!'],
        keywords: ['clone voice', 'fish audio', 'voz clonada', 'hablar con voz', 'gojo', 'rias_gremory', 'carlos_bodoque', 'toji_fushiguro']
    };
    registerFunction('tts.clone', ttsCloneHandler, cloneMetadata);
    registerFunction('tts.fish', ttsFishHandler, { ...cloneMetadata, aliasOf: 'tts.clone' });
}
