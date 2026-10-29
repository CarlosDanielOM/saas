import type { ChannelTtsSettingsData, TtsProvider } from '../schemas/channel_tts_settings.schema.js';
import { filterExpressiveTtsTags, normalizeTtsMessage } from '../utils/tts/normalize_tts_message.util.js';

export function filterPetTalkText(text: string, provider: TtsProvider, filters: ChannelTtsSettingsData['filters'], emoteNames: string[]) {
    const filtered = filterExpressiveTtsTags(text, { provider, enabledTags: filters.expressiveTags });
    return normalizeTtsMessage(filtered, { ...filters, emoteNames });
}
