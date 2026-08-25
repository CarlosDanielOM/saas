/**
 * AI Emote Context
 *
 * Best-effort list of emote names the bot can use in this channel, so the AI
 * can respond with native chat culture instead of plain text.
 *
 * Strategy:
 * 1. Try the channel's emotes with the bot user token (needs user:read:emotes
 *    scope; may fail - that's OK).
 * 2. Fall back to Twitch global emotes (works with the app token).
 * Cached for 1 hour per channel; returns null on total failure so callers can
 * simply omit the section.
 */

import { getTwitchAppHeader, getTwitchBotHeader } from '../header.js';
import { getTwitchHelixUrl } from '../links.js';
import { getDragonflyClient } from '../databases/dragonfly.database.js';

const CACHE_TTL_SECONDS = 3600;
const MAX_EMOTE_NAMES = 40;

function cacheKey(channelID: string): string {
    return `twitch:${channelID}:ai:emotes`;
}

async function fetchChannelEmoteNames(channelID: string): Promise<string[] | null> {
    const botHeaderResult = await getTwitchBotHeader();
    if (botHeaderResult.error || !botHeaderResult.header) return null;

    const params = new URLSearchParams({ broadcaster_id: channelID });
    const response = await fetch(getTwitchHelixUrl('chat/emotes', params.toString()), {
        headers: {
            'Client-Id': botHeaderResult.header['Client-Id'],
            'Authorization': botHeaderResult.header.Authorization,
            'Content-Type': botHeaderResult.header['Content-Type']
        }
    });
    const data = await response.json();
    if (data.error || !Array.isArray(data.data)) return null;

    return data.data
        .map((emote: any) => (typeof emote?.name === 'string' ? emote.name : null))
        .filter((name: string | null): name is string => Boolean(name));
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

        let names = await fetchChannelEmoteNames(channelID);
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
