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
    provider?: 'piper' | 'fish' | 'kokoro';
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
    mode: 'default' | 'speak' | 'clone' | 'kokoro',
    message: string,
    ctx: Parameters<FunctionHandler>[1],
    cloneName?: string
): Promise<QueueTtsResult> {
    const fragments = (ctx.eventData?.message as { fragments?: { type?: string; text?: string }[] } | undefined)?.fragments;
    const result = await queueDefaultTts({
        channelID: ctx.broadcasterId,
        rawMessage: message,
        source: 'ast',
        preferredMode: mode,
        cloneName,
        userID: ctx.userId,
        userLogin: ctx.userLogin,
        userName: ctx.userDisplayName,
        userLevel: ctx.userLevel,
        emoteNames: fragments?.filter(fragment => fragment.type === 'emote' && typeof fragment.text === 'string')
            .map(fragment => fragment.text!)
    });

    return {
        output: result.error ? result.message : '',
        success: !result.error,
        mode: mode === 'clone' ? 'clone' : 'speak',
        provider: mode === 'clone' ? 'fish' : mode === 'kokoro' ? 'kokoro' : undefined,
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

const ttsKokoroHandler: FunctionHandler = async (args, ctx) => {
    const { cloneName: voice, message } = parseCloneArgument(args, ctx.argument);
    if (!voice || !message) return 'Usage: $(tts.kokoro voice_name text)';
    const result = await queueTts('kokoro', message, ctx, voice);
    trackTts({ channelID: ctx.broadcasterId, channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast', ttsType: 'tts.kokoro', characters: message.length, message,
        status: result.success ? 'success' : 'error', mode: 'speak', provider: 'kokoro',
        ...resolveTrackingIdentity(ctx), errorMessage: result.errorMessage });
    return result.output;
};

export function registerTtsFunctions(): void {
    registerFunction('tts.kokoro', ttsKokoroHandler, {
        description: 'Speaks text with a Kokoro preset voice using DeepInfra only. Costs one credit per 15 characters, rounded up; falls back to Piper when credits are exhausted or synthesis fails.',
        syntax: 'tts.kokoro voice_name text', category: 'tts',
        examples: ['tts.kokoro af_heart Hello chat!', 'tts.kokoro ef_dora Hola chat!'],
        keywords: ['kokoro', 'preset voice', 'deepinfra', 'tts', 'voz']
    });
    const ttsMetadata = {
        description: 'Speaks a message out loud using the channel default TTS voice.',
        syntax: 'tts message',
        category: 'tts',
        examples: ['tts Hello chat!'],
        keywords: ['tts', 'speak', 'text to speech', 'hablar', 'voz', 'di esto']
    };
    registerFunction('tts', ttsSpeakHandler, ttsMetadata);
    registerFunction('tts.speak', ttsExplicitSpeakHandler, { ...ttsMetadata, description: 'Speaks a message using Piper (1 credit per 50 characters, rounded up), including after credit exhaustion.', syntax: 'tts.speak message' });
    registerFunction('tts.piper', ttsExplicitSpeakHandler, { ...ttsMetadata, description: 'Speaks a message using Piper (1 credit per 50 characters, rounded up), including after credit exhaustion.', syntax: 'tts.piper message', aliasOf: 'tts.speak' });
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
