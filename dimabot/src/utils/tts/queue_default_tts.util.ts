import { requestTts, type TtsRequestBody } from '../../functions/chats/speech.chat.js';
import { getTtsEmoteNames } from './emote_names.util.js';
import { getChannelTtsSettings, type ChannelTtsSettingsData, type TtsProvider } from '../../schemas/channel_tts_settings.schema.js';
import {
    buildSpokenUserMessage,
    extractEmoteNames,
    filterExpressiveTtsTags,
    normalizeTtsMessage
} from './normalize_tts_message.util.js';

interface QueueDefaultTtsInput {
    channelID: string;
    rawMessage: string;
    source: 'chat-command' | 'ast' | 'redemption';
    preferredMode?: 'default' | 'speak' | 'clone';
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

    if (preferredMode === 'speak' || settings.provider !== 'fish') {
        return { mode: 'speak', provider: 'piper' };
    }

    return { mode: 'clone', provider: 'fish' };
}

export async function queueDefaultTts(input: QueueDefaultTtsInput): Promise<QueueDefaultTtsResult> {
    const rawMessage = String(input.rawMessage || '').trim();
    if (!rawMessage) {
        return {
            error: true,
            message: 'No message provided',
            status: 400,
            type: 'error'
        };
    }

    const settings = await getChannelTtsSettings(input.channelID);
    if (!settings.enabled) {
        return {
            error: true,
            message: 'TTS is disabled for this channel',
            status: 403,
            type: 'error'
        };
    }

    const emoteNames = input.emoteNames ?? (input.emotes
        ? extractEmoteNames(rawMessage, input.emotes)
        : settings.filters.skipEmotes ? await getTtsEmoteNames(input.channelID) : []);
    const resolvedMode = resolveTtsMode(input, settings);
    // Remove disabled cues before truncation so a partial tag cannot be spoken.
    const filteredMessage = filterExpressiveTtsTags(rawMessage, {
        provider: resolvedMode.provider,
        enabledTags: settings.filters.expressiveTags
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
            type: 'error'
        };
    }

    const language = input.language || settings.defaultLanguage;
    const spokenMessage = buildSpokenUserMessage(resolveDisplayName(input), normalized.text, language, input.source);

    if (!spokenMessage.trim()) return { error: true, message: 'No message provided', status: 400, type: 'error' };

    const payload: TtsRequestBody = {
        mode: resolvedMode.mode,
        provider: resolvedMode.provider,
        ...(input.cloneName ? { cloneName: input.cloneName } : {}),
        text: spokenMessage,
        language,
        requestedBy: {
            userID: input.userID,
            userLogin: input.userLogin,
            userName: resolveDisplayName(input),
            userLevel: input.userLevel
        },
        meta: {
            source: input.source,
            originalText: rawMessage,
            skipEmotes: settings.filters.skipEmotes,
            stripLinks: settings.filters.stripLinks
        }
    };

    return await requestTts(input.channelID, payload);
}
