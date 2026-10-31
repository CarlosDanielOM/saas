import type { ChannelTtsSettingsData, TtsProvider } from '../schemas/channel_tts_settings.schema.js';
import { filterExpressiveTtsTags, normalizeTtsMessage } from '../utils/tts/normalize_tts_message.util.js';

export function filterPetTalkText(text: string, provider: TtsProvider, filters: ChannelTtsSettingsData['filters'], emoteNames: string[]) {
    const filtered = filterExpressiveTtsTags(text, { provider, enabledTags: filters.expressiveTags });
    return normalizeTtsMessage(filtered, { ...filters, emoteNames });
}

/** Refilter a previously normalized desktop response if the effective voice changed. */
export function refilterDesktopPetText(text: string, provider: TtsProvider, filters: ChannelTtsSettingsData['filters'], emoteNames: string[]) {
    // Preserve the existing link placeholder through the tag filter; literal
    // private-use characters are removed first so they cannot collide with it.
    const marker = '\uE000';
    const result = filterPetTalkText(text.replace(/\uE000/g, '').replace(/\[link\]/g, marker), provider, filters, emoteNames);
    const restored = result.text.replace(/\uE000/g, '[link]');
    return { ...result, text: restored, error: !restored.trim() };
}
