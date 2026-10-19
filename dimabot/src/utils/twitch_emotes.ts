import { getDragonflyClient } from './databases/dragonfly.database.js';
import { getTwitchAppHeader } from './header.js';
import { getTwitchHelixUrl } from './links.js';

export interface ChannelEmoteCatalog {
    emotes: { id: string; name: string }[];
    status: 'ready' | 'stale' | 'unavailable';
    checkedAt: string | null;
}
interface CachedCatalog { emotes: ChannelEmoteCatalog['emotes']; checkedAt: string | null; retryAt: number; }
const inFlight = new Map<string, Promise<ChannelEmoteCatalog>>();
const unavailable = (): ChannelEmoteCatalog => ({ emotes: [], status: 'unavailable', checkedAt: null });

// Shared native channel catalog for analytics, speech filters and AI context.
// Never fall back to global emotes: an empty catalog and an outage are distinct.
async function loadCatalog(channelID: string): Promise<ChannelEmoteCatalog> {
    if (!/^\d{1,30}$/.test(channelID)) return unavailable();
    try {
        const cache = await getDragonflyClient('ChannelEmotes');
        const key = `twitch:${channelID}:emote-catalog:v1`;
        let previous: CachedCatalog | null = null;
        try {
            const raw = await cache.get(key);
            if (raw) {
                const row = JSON.parse(raw) as CachedCatalog;
                if (Array.isArray(row.emotes) && row.emotes.length <= 2000 && row.emotes.every(item => typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) && typeof item.name === 'string')
                    && (row.checkedAt === null || Number.isFinite(Date.parse(row.checkedAt))) && Number.isFinite(row.retryAt)) previous = row;
            }
        } catch { /* Corrupt/absent cache can be repaired from Twitch. */ }
        const view = (row: CachedCatalog): ChannelEmoteCatalog => {
            const age = row.checkedAt ? Date.now() - Date.parse(row.checkedAt) : Infinity;
            return { emotes: age < 86400000 ? row.emotes : [], checkedAt: row.checkedAt,
                status: age >= 86400000 ? 'unavailable' : age < 3600000 ? 'ready' : 'stale' };
        };
        if (previous && previous.retryAt > Date.now()) return view(previous);
        try {
            const headers = await getTwitchAppHeader();
            const response = await fetch(getTwitchHelixUrl('chat/emotes', new URLSearchParams({ broadcaster_id: channelID }).toString()),
                { headers: { ...headers }, signal: AbortSignal.timeout(3000) });
            const body = await response.json() as { data?: unknown };
            if (!response.ok || !Array.isArray(body.data) || body.data.length > 2000) throw new Error('Invalid channel emote catalog');
            const emotes: ChannelEmoteCatalog['emotes'] = [];
            for (const item of body.data) {
                if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || typeof item.name !== 'string') throw new Error('Invalid channel emote');
                emotes.push({ id: item.id, name: item.name.slice(0, 64) });
            }
            const saved = { emotes, checkedAt: new Date().toISOString(), retryAt: Date.now() + 3600000 };
            await cache.set(key, JSON.stringify(saved), { EX: 86400 });
            return view(saved);
        } catch {
            const saved = { ...(previous || { emotes: [], checkedAt: null }), retryAt: Date.now() + 60000 };
            await cache.set(key, JSON.stringify(saved), { EX: 86400 });
            return view(saved);
        }
    } catch { return unavailable(); }
}
export function getChannelEmoteCatalog(channelID: string): Promise<ChannelEmoteCatalog> {
    let promise = inFlight.get(channelID);
    if (!promise) { promise = loadCatalog(channelID).finally(() => inFlight.delete(channelID)); inFlight.set(channelID, promise); }
    return promise;
}
