import { getTwitchHelixUrl } from '../utils/links.js';
import type { DimaBadge } from './types.js';

export type BadgeLookup = ReadonlyMap<string, Pick<DimaBadge, 'title' | 'images'>>;
interface CacheEntry { badges: BadgeLookup; expiresAt: number }
interface BadgeCacheDependencies {
  fetch: typeof fetch;
  header: () => Promise<Record<string, string>>;
  now: () => number;
}

/** Channel badges override global versions of the same set. Failed refreshes keep the last good data. */
export function createBadgeCache(deps: BadgeCacheDependencies) {
  let global: CacheEntry | undefined;
  const channels = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<BadgeLookup>>();
  function save(key: string, entry: CacheEntry) {
    if (key === 'global') { global = entry; return; }
    channels.delete(key);
    channels.set(key, entry);
    if (channels.size > 500) channels.delete(channels.keys().next().value!);
  }
  function read(key: string): Promise<BadgeLookup> {
    const cached = key === 'global' ? global : channels.get(key);
    if (cached && cached.expiresAt > deps.now()) {
      save(key, cached);
      return Promise.resolve(cached.badges);
    }
    const active = inFlight.get(key);
    if (active) return active;
    const request = (async () => {
      let badges = cached?.badges ?? new Map();
      let ttl = key === 'global' ? 6 * 60 * 60_000 : 60 * 60_000;
      try {
        const url = key === 'global' ? getTwitchHelixUrl('chat/badges/global')
          : getTwitchHelixUrl('chat/badges', new URLSearchParams({ broadcaster_id: key }).toString());
        const response = await deps.fetch(url, { headers: await deps.header(), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Twitch badge lookup failed (${response.status})`);
        const body = await response.json() as { data?: { set_id: string; versions: { id: string; title: string; image_url_1x: string; image_url_2x: string; image_url_4x: string }[] }[] };
        if (!Array.isArray(body.data)) throw new Error('Invalid Twitch badge lookup');
        const next = new Map<string, Pick<DimaBadge, 'title' | 'images'>>();
        for (const set of body.data) for (const badge of set.versions) {
          next.set(`${set.set_id}/${badge.id}`, { title: badge.title,
            images: { '1x': badge.image_url_1x, '2x': badge.image_url_2x, '4x': badge.image_url_4x } });
        }
        badges = next;
      } catch { ttl = 60_000; }
      save(key, { badges, expiresAt: deps.now() + ttl });
      return badges;
    })();
    inFlight.set(key, request);
    void request.finally(() => inFlight.delete(key)).catch(() => {});
    return request;
  }
  return async (channel: string): Promise<BadgeLookup> => {
    const [all, local] = await Promise.all([read('global'), read(channel)]);
    return new Map([...all, ...local]);
  };
}

export const getBadgeLookup = createBadgeCache({
  fetch: (...args) => fetch(...args), now: Date.now,
  header: async () => {
    const { getTwitchAppHeader } = await import('../utils/header.js');
    return { ...await getTwitchAppHeader() };
  }
});
