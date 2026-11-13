import { getDragonflyClient } from '../../../utils/databases/dragonfly.database.js';
import type { FeedFilters } from './types.js';

/**
 * Turns a viewer's login into their Twitch id before the feed is searched, so every store is searched by
 * id (logins change and most stores index only the id). Same Helix lookup as `GET /users?username=`
 * (`getTwitchUserByLogin`), plus what that helper lacks for a page that must answer quickly: a cache and a
 * short timeout. An unknown login is cached briefly; an unreachable Twitch is not cached at all.
 */
const CACHE_PREFIX = 'admin-feed:login:';
const FOUND_TTL_SECONDS = 6 * 3600;
const UNKNOWN_TTL_SECONDS = 10 * 60;
const UNKNOWN = '-';
export const LOGIN_LOOKUP_TIMEOUT_MS = 1500;

/** The id for a login, null when Twitch has no such user; throws when Twitch could not answer. */
export type LoginLookup = (login: string) => Promise<string | null>;

export const twitchLoginLookup: LoginLookup = async (login) => {
    // Loaded on first use: the helper pulls in the token store and Helix headers.
    const { getTwitchUserByLogin } = await import('../../../functions/users/get_user_by_login.users.js');
    const result = await getTwitchUserByLogin(login);
    if (!result.error && result.data && /^\d{1,20}$/.test(String(result.data.id))) return String(result.data.id);
    if (result.error && result.message === 'User not found') return null;
    throw new Error('Twitch did not answer the login lookup');
};

interface Cache {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export interface ResolveOptions { lookup?: LoginLookup; cache?: Cache | null; timeoutMs?: number }

/** The viewer's id, or null when the login is unknown or the lookup failed or took too long. Never throws. */
export async function resolveViewerLogin(login: string, options: ResolveOptions = {}): Promise<string | null> {
    const lookup = options.lookup ?? twitchLoginLookup;
    const timeoutMs = options.timeoutMs ?? LOGIN_LOOKUP_TIMEOUT_MS;
    const key = `${CACHE_PREFIX}${login}`;
    let cache: Cache | null = null;
    try {
        cache = options.cache !== undefined ? options.cache : await getDragonflyClient('admin-feed');
        const cached = cache ? await cache.get(key) : null;
        if (cached) return cached === UNKNOWN ? null : cached;
    } catch {
        cache = null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const id = await Promise.race([
            lookup(login),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('login lookup timed out')), timeoutMs); timer.unref?.(); })
        ]);
        await cache?.set(key, id ?? UNKNOWN, { EX: id ? FOUND_TTL_SECONDS : UNKNOWN_TTL_SECONDS }).catch(() => null);
        return id;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** With a login and no id, search by the login's id when it resolves; otherwise keep the login (stores that cannot search by it report `partial`). */
export async function withViewerId(filters: FeedFilters, options?: ResolveOptions): Promise<FeedFilters> {
    if (filters.actorID || !filters.actorLogin) return filters;
    const actorID = await resolveViewerLogin(filters.actorLogin, options);
    if (!actorID) return filters;
    const { actorLogin: _login, ...rest } = filters;
    return { ...rest, actorID };
}
