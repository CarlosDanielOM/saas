import { requestTts, type TtsRequestBody } from '../../functions/chats/speech.chat.js';
import { getTtsEmoteNames } from './emote_names.util.js';
import { getChannelTtsSettings, type ChannelTtsSettingsData, type TtsProvider } from '../../schemas/channel_tts_settings.schema.js';
import {
    buildSpokenUserMessage,
    extractEmoteNames,
    filterExpressiveTtsTags,
    normalizeTtsMessage
} from './normalize_tts_message.util.js';
import { recordTtsRequestRefused, type TtsRequestCode } from './tts_activity.js';

interface QueueDefaultTtsInput {
    channelID: string;
    rawMessage: string;
    source: 'chat-command' | 'ast' | 'redemption';
    /**
     * A channel-point reward ran this AST. It is spoken like any AST voice; the request says 'redemption'
     * and the speech route keeps reporting it as 'ast' to Polar and analytics (see `ttsRequestSources`).
     */
    redemption?: boolean;
    preferredMode?: 'default' | 'speak' | 'clone' | 'kokoro';
    cloneName?: string;
    userID?: string;
    userLogin?: string;
    userName?: string;
    userLevel?: number;
    language?: 'en' | 'es';
    emotes?: Record<string, string[]>;
    emoteNames?: string[];
}

interface QueueDefaultTtsResult {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
    /** Why it was refused (see `tts_activity.ts`); the speech service's own code when it refused. */
    code?: TtsRequestCode | string;
    data?: unknown;
}

function resolveDisplayName(input: QueueDefaultTtsInput): string {
    return String(input.userName || input.userLogin || '').trim();
}

function resolveTtsMode(input: QueueDefaultTtsInput, settings: ChannelTtsSettingsData): { mode: 'speak' | 'clone'; provider: TtsProvider } {
    const preferredMode = input.preferredMode || 'default';

    if (preferredMode === 'clone') {
        return { mode: 'clone', provider: 'fish' };
    }

    if (preferredMode === 'kokoro') return { mode: 'speak', provider: 'kokoro' };

    if (preferredMode === 'speak') {
        return { mode: 'speak', provider: 'piper' };
    }

    return settings.provider === 'fish'
        ? { mode: 'clone', provider: 'fish' }
        : { mode: 'speak', provider: settings.provider };
}

/**
 * Queues a viewer's voice request with the channel's settings. A request that is not queued leaves an owner
 * activity row saying why (`tts_activity.ts`); the reply text for chat is unchanged.
 */
export async function queueDefaultTts(input: QueueDefaultTtsInput): Promise<QueueDefaultTtsResult> {
    let provider: string | null = null;
    const refused = (result: { message?: string | null; status?: number | null; code?: string | null }) => recordTtsRequestRefused({
        channelID: input.channelID,
        actor: input.userID || input.userLogin || input.userName ? { id: input.userID, login: input.userLogin, name: input.userName } : null,
        source: input.redemption ? 'redemption' : input.source,
        text: input.rawMessage,
        provider,
        result
    });
    try {
        const result = await queueDefaultTtsRequest(input, chosen => { provider = chosen; });
        if (result.error) refused(result);
        return result;
    } catch (error) {
        refused({ message: error instanceof Error ? error.message : String(error) });
        throw error;
    }
}

async function queueDefaultTtsRequest(input: QueueDefaultTtsInput, onProvider: (provider: string) => void): Promise<QueueDefaultTtsResult> {
    const rawMessage = String(input.rawMessage || '').trim();
    if (!rawMessage) {
        return {
            error: true,
            message: 'No message provided',
            status: 400,
            type: 'error',
            code: 'empty_text'
        };
    }

    const settings = await getChannelTtsSettings(input.channelID);
    if (!settings.enabled) {
        return {
            error: true,
            message: 'TTS is disabled for this channel',
            status: 403,
            type: 'error',
            code: 'tts_disabled'
        };
    }

    const emoteNames = input.emoteNames ?? (input.emotes
        ? extractEmoteNames(rawMessage, input.emotes)
        : settings.filters.skipEmotes ? await getTtsEmoteNames(input.channelID) : []);
    const resolvedMode = resolveTtsMode(input, settings);
    onProvider(resolvedMode.provider);
    // Remove disabled cues before truncation so a partial tag cannot be spoken.
    const filteredMessage = filterExpressiveTtsTags(rawMessage, {
        provider: resolvedMode.provider,
        enabledTags: settings.filters.expressiveTags,
        freeformTags: settings.filters.freeformTags
    });
    const normalized = normalizeTtsMessage(filteredMessage, {
        skipEmotes: settings.filters.skipEmotes,
        stripLinks: settings.filters.stripLinks,
        normalizeWhitespace: settings.filters.normalizeWhitespace,
        maxLength: settings.filters.maxLength,
        emoteNames
    });

    if (normalized.error) {
        return {
            error: true,
            message: normalized.message,
            status: 400,
            type: 'error',
            code: 'text_rejected'
        };
    }

    const language = input.language || settings.defaultLanguage;
    const spokenMessage = buildSpokenUserMessage(resolveDisplayName(input), normalized.text, language, input.source);

    if (!spokenMessage.trim()) return { error: true, message: 'No message provided', status: 400, type: 'error', code: 'empty_text' };

    const payload: TtsRequestBody = {
        mode: resolvedMode.mode,
        provider: resolvedMode.provider,
        ...(input.cloneName ? resolvedMode.provider === 'kokoro'
            ? { voice: input.cloneName } : { cloneName: input.cloneName } : {}),
        text: spokenMessage,
        language,
        requestedBy: {
            userID: input.userID,
            userLogin: input.userLogin,
            userName: resolveDisplayName(input),
            userLevel: input.userLevel
        },
        meta: {
            source: input.redemption ? 'redemption' : input.source,
            originalText: rawMessage,
            skipEmotes: settings.filters.skipEmotes,
            stripLinks: settings.filters.stripLinks
        }
    };

    return await requestTts(input.channelID, payload);
}
