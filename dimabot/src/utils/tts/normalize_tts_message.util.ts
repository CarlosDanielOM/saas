import type { TtsLanguage } from '../../schemas/channel_tts_settings.schema.js';

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LINK_REGEX = /((http|https):\/\/)?(www\.)?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]{2,})+(:\d+)?(\/\S*)?(\?\S+)?/gi;

const XAI_INLINE_TAG_DEFINITIONS = [
    { key: 'pause', tag: 'pause' },
    { key: 'longPause', tag: 'long-pause' },
    { key: 'humTune', tag: 'hum-tune' },
    { key: 'laugh', tag: 'laugh' },
    { key: 'chuckle', tag: 'chuckle' },
    { key: 'giggle', tag: 'giggle' },
    { key: 'cry', tag: 'cry' },
    { key: 'tsk', tag: 'tsk' },
    { key: 'tongueClick', tag: 'tongue-click' },
    { key: 'lipSmack', tag: 'lip-smack' },
    { key: 'breath', tag: 'breath' },
    { key: 'inhale', tag: 'inhale' },
    { key: 'exhale', tag: 'exhale' },
    { key: 'sigh', tag: 'sigh' }
] as const;

const XAI_WRAPPING_TAG_DEFINITIONS = [
    { key: 'soft', tag: 'soft' },
    { key: 'whisper', tag: 'whisper' },
    { key: 'loud', tag: 'loud' },
    { key: 'buildIntensity', tag: 'build-intensity' },
    { key: 'decreaseIntensity', tag: 'decrease-intensity' },
    { key: 'higherPitch', tag: 'higher-pitch' },
    { key: 'lowerPitch', tag: 'lower-pitch' },
    { key: 'slow', tag: 'slow' },
    { key: 'fast', tag: 'fast' },
    { key: 'singSong', tag: 'sing-song' },
    { key: 'singing', tag: 'singing' },
    { key: 'laughSpeak', tag: 'laugh-speak' },
    { key: 'emphasis', tag: 'emphasis' }
] as const;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function filterExpressiveTtsTags(rawText: string): string {
    let text = String(rawText || '');

    for (const definition of XAI_INLINE_TAG_DEFINITIONS) {
        const tagRegex = new RegExp(`\\[${escapeRegExp(definition.tag)}\\]`, 'gi');
        text = text.replace(tagRegex, ' ');
    }

    for (const definition of XAI_WRAPPING_TAG_DEFINITIONS) {
        const tagRegex = new RegExp(`</?${escapeRegExp(definition.tag)}>`, 'gi');
        text = text.replace(tagRegex, '');
    }

    return text;
}

export interface NormalizeTtsMessageOptions {
    skipEmotes: boolean;
    stripLinks: boolean;
    normalizeWhitespace: boolean;
    maxLength: number;
    emoteNames?: string[];
}

export interface NormalizeTtsMessageResult {
    error: boolean;
    message: string;
    text: string;
    originalText: string;
}

function stripEmoteTokens(text: string, emoteNames: string[]): string {
    if (emoteNames.length === 0) {
        return text;
    }

    const emoteSet = new Set(emoteNames.map((emote) => emote.trim()).filter(Boolean));
    if (emoteSet.size === 0) {
        return text;
    }

    return text
        .split(/(\s+)/)
        .filter((token) => {
            if (/^\s+$/.test(token)) {
                return true;
            }

            return !emoteSet.has(token.trim());
        })
        .join('');
}

export function normalizeTtsMessage(
    rawText: string,
    options: NormalizeTtsMessageOptions
): NormalizeTtsMessageResult {
    const originalText = String(rawText || '');
    let text = originalText;

    if (options.skipEmotes) {
        text = stripEmoteTokens(text, options.emoteNames || []);
    }

    if (options.stripLinks) {
        text = text.replace(LINK_REGEX, '[link]');
    }

    text = text.replace(CONTROL_CHARS_REGEX, ' ');

    if (options.normalizeWhitespace) {
        text = text.replace(/\s+/g, ' ').trim();
    } else {
        text = text.trim();
    }

    if (options.maxLength > 0 && text.length > options.maxLength) {
        text = text.slice(0, options.maxLength).trim();
    }

    if (!text) {
        return {
            error: true,
            message: 'No speakable text remained after filtering',
            text: '',
            originalText
        };
    }

    return {
        error: false,
        message: 'TTS message normalized',
        text,
        originalText
    };
}

export function buildSpokenUserMessage(userName: string, message: string, language: TtsLanguage): string {
    const cleanedUserName = String(userName || '').trim();
    if (!cleanedUserName) {
        return message;
    }

    if (language === 'en') {
        return `${cleanedUserName} say: ${message}`;
    }

    return `${cleanedUserName} dice: ${message}`;
}

export function extractEmoteNames(message: string, emotes?: Record<string, string[]>): string[] {
    if (!message || !emotes) {
        return [];
    }

    const extracted = new Set<string>();

    for (const emoteEntries of Object.values(emotes)) {
        for (const entry of emoteEntries) {
            const [rawStart, rawEnd] = entry.split('-');
            const start = Number.parseInt(rawStart || '', 10);
            const end = Number.parseInt(rawEnd || '', 10);

            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                continue;
            }

            const emote = message.slice(start, end + 1).trim();
            if (emote) {
                extracted.add(emote);
            }
        }
    }

    return [...extracted];
}
