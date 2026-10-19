/** Best-effort AI names from the shared native channel catalog, then globals. */
import { getTwitchAppHeader } from '../header.js';
import { getTwitchHelixUrl } from '../links.js';
import { getDragonflyClient } from '../databases/dragonfly.database.js';

import { getChannelEmoteCatalog } from '../twitch_emotes.js';

const CACHE_TTL_SECONDS = 3600;
const MAX_EMOTE_NAMES = 40;

function cacheKey(channelID: string): string {
    return `twitch:${channelID}:ai:emotes`;
}

async function fetchGlobalEmoteNames(): Promise<string[] | null> {
    const appHeader = await getTwitchAppHeader();
    const response = await fetch(getTwitchHelixUrl('chat/emotes/global'), {
        headers: {
            'Client-Id': appHeader['Client-Id'],
            'Authorization': appHeader.Authorization,
            'Content-Type': appHeader['Content-Type']
        }
    });
    const data = await response.json();
    if (data.error || !Array.isArray(data.data)) return null;

    return data.data
        .map((emote: any) => (typeof emote?.name === 'string' ? emote.name : null))
        .filter((name: string | null): name is string => Boolean(name));
}

export async function getChannelEmoteNames(channelID: string): Promise<string[] | null> {
    if (!channelID) return null;

    try {
        const cache = await getDragonflyClient('AIEmoteContext');
        const cached = await cache.get(cacheKey(channelID));
        if (cached) {
            return JSON.parse(cached) as string[];
        }

        let names: string[] | null = (await getChannelEmoteCatalog(channelID)).emotes.map(emote => emote.name);
        if (!names || names.length === 0) {
            names = await fetchGlobalEmoteNames();
        }
        if (!names || names.length === 0) return null;

        const trimmed = names.slice(0, MAX_EMOTE_NAMES);
        await cache.set(cacheKey(channelID), JSON.stringify(trimmed), { EX: CACHE_TTL_SECONDS });
        return trimmed;
    } catch {
        return null;
    }
}
