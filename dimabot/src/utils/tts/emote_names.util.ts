import { getDragonflyClient } from '../databases/dragonfly.database.js';
import { getTwitchAppHeader } from '../header.js';
import { getTwitchHelixUrl } from '../links.js';

const inFlight = new Map<string, Promise<string[]>>();

async function loadEmoteNames(channelID?: string): Promise<string[]> {
    const key = channelID ? `twitch:${channelID}:tts:emotes` : 'twitch:global:tts:emotes';
    try {
        const cache = await getDragonflyClient('TtsEmotes');
        const cached = await cache.get(key);
        if (cached) {
            const names: unknown = JSON.parse(cached);
            if (Array.isArray(names) && names.every(name => typeof name === 'string')) return names;
        }

        let names: string[] = [];
        let succeeded = false;
        try {
            const headers = await getTwitchAppHeader();
            const response = await fetch(getTwitchHelixUrl(
                channelID ? 'chat/emotes' : 'chat/emotes/global',
                channelID ? new URLSearchParams({ broadcaster_id: channelID }).toString() : undefined
            ), { headers: { ...headers }, signal: AbortSignal.timeout(3000) });
            const body = await response.json() as { data?: { name?: unknown }[] };
            if (response.ok && Array.isArray(body.data)) {
                names = body.data.map(emote => emote.name).filter((name): name is string => typeof name === 'string' && !!name);
                succeeded = true;
            }
        } catch {
            // A catalog outage must not prevent ordinary speech.
        }
        await cache.set(key, JSON.stringify(names), { EX: succeeded ? 3600 : 60 });
        return names;
    } catch {
        return [];
    }
}

function cachedEmoteNames(channelID?: string): Promise<string[]> {
    const key = channelID || '';
    let pending = inFlight.get(key);
    if (!pending) {
        pending = loadEmoteNames(channelID).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    return pending;
}

/** Redemptions contain plain user_input, so recognize native emotes by name. */
export async function getTtsEmoteNames(channelID: string): Promise<string[]> {
    const [globalNames, channelNames] = await Promise.all([cachedEmoteNames(), cachedEmoteNames(channelID)]);
    return [...new Set([...globalNames, ...channelNames])];
}
