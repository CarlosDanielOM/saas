import { getChannelTtsSettings, type TtsProvider } from '../../../schemas/channel_tts_settings.schema.js';
import { FISH_VOICES } from '../../../server/services/tts/fish_tts.service.js';
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
    mode: 'speak' | 'ai' | 'clone';
    provider?: 'piper' | 'xai' | 'openrouter' | 'fish';
    errorMessage?: string;
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

function parseVoiceOverrideArgument(args: unknown[], fallback?: string): { voice: string; message: string } {
    const raw = args.length > 0
        ? args.map((arg) => String(arg)).join(' ').trim()
        : String(fallback || '').trim();

    if (!raw) {
        return { voice: '', message: '' };
    }

    const [voice, ...messageParts] = raw.split(/\s+/).filter(Boolean);
    return {
        voice: String(voice || '').trim(),
        message: messageParts.join(' ').trim()
    };
}

function isModeAllowed(mode: 'speak' | 'ai' | 'clone', userPlan: 'free' | 'premium' | 'pro'): boolean {
    if (mode === 'speak') {
        return true;
    }

    if (mode === 'ai') {
        return userPlan === 'premium' || userPlan === 'pro';
    }

    return userPlan === 'pro';
}

async function queueTts(
    mode: 'default' | 'speak' | 'ai' | 'clone',
    message: string,
    ctx: Parameters<FunctionHandler>[1],
    provider?: TtsProvider,
    cloneName?: string,
    voice?: string
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
            mode: mode as 'ai' | 'clone',
            errorMessage: 'TTS is disabled for this channel'
        };
    }

    if (!isModeAllowed(mode, ctx.userPlan)) {
        return {
            output: 'Your plan does not include this TTS mode',
            success: false,
            mode: mode as 'ai' | 'clone',
            errorMessage: 'Your plan does not include this TTS mode'
        };
    }

    // Resolve provider for AI mode
    let resolvedProvider: 'xai' | 'openrouter' = 'xai';
    if (provider === 'openrouter') {
        resolvedProvider = 'openrouter';
    } else if (settings.aiProvider === 'openrouter') {
        resolvedProvider = 'openrouter';
    }

    const result = await requestTts(ctx.broadcasterId, {
        mode,
        provider: provider || settings.aiProvider,
        text: message,
        language: settings.defaultLanguage,
        cloneName,
        voice,
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
            mode: mode as 'ai' | 'clone',
            provider: mode === 'ai' ? resolvedProvider : 'fish',
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
        userID: ctx.userId,
        username: ctx.userDisplayName,
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
        userID: ctx.userId,
        username: ctx.userDisplayName,
        errorMessage: result.errorMessage,
    });

    return result.output;
};

const ttsAiHandler: FunctionHandler = async (args, ctx) => {
    const message = parseRawArgument(args, ctx.argument);
    if (!message) {
        return 'Usage: $(tts.ai message)';
    }

    const result = await queueTts('ai', message, ctx);

    // Track TTS usage in PostHog
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
        userID: ctx.userId,
        username: ctx.userDisplayName,
        errorMessage: result.errorMessage,
    });

    return result.output;
};

const ttsXaiHandler: FunctionHandler = async (args, ctx) => {
    const { voice, message } = parseVoiceOverrideArgument(args, ctx.argument);
    if (!voice || !message) {
        return 'Usage: $(tts.xai voice message)';
    }

    const result = await queueTts('ai', message, ctx, 'xai', undefined, voice);

    // Track TTS usage in PostHog
    trackTts({
        channelID: ctx.broadcasterId,
        channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast',
        ttsType: 'tts.xai',
        characters: message.length,
        message,
        status: result.success ? 'success' : 'error',
        mode: result.mode,
        provider: 'xai', // explicitly xai provider
        userID: ctx.userId,
        username: ctx.userDisplayName,
        errorMessage: result.errorMessage,
    });

    return result.output;
};

const ttsOpenRouterHandler: FunctionHandler = async (args, ctx) => {
    const message = parseRawArgument(args, ctx.argument);
    if (!message) {
        return 'Usage: $(tts.or message)';
    }

    const result = await queueTts('ai', message, ctx, 'openrouter');

    // Track TTS usage in PostHog
    trackTts({
        channelID: ctx.broadcasterId,
        channelName: ctx.streamer?.name || ctx.broadcasterId,
        source: 'ast',
        ttsType: 'tts.or',
        characters: message.length,
        message,
        status: result.success ? 'success' : 'error',
        mode: result.mode,
        provider: 'openrouter', // explicitly openrouter provider
        userID: ctx.userId,
        username: ctx.userDisplayName,
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

        const result = await queueTts('clone', message, ctx, undefined, cloneName);

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
            userID: ctx.userId,
            username: ctx.userDisplayName,
            errorMessage: result.errorMessage,
        });

        return result.output;
    };
}

const ttsCloneHandler = createCloneHandler('tts.clone');
const ttsFishHandler = createCloneHandler('tts.fish');

export function registerTtsFunctions(): void {
    registerFunction('tts', ttsSpeakHandler);
    registerFunction('tts.speak', ttsExplicitSpeakHandler);
    registerFunction('tts.ai', ttsAiHandler);
    registerFunction('tts.xai', ttsXaiHandler);
    registerFunction('tts.or', ttsOpenRouterHandler);
    registerFunction('tts.openrouter', ttsOpenRouterHandler);
    registerFunction('tts.clone', ttsCloneHandler);
    registerFunction('tts.fish', ttsFishHandler);
}
