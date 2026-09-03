import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { decrypt } from "../utils/crypto.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import type { ITwitchAccountCache } from '../interfaces/cache/twitch_account.cache.interface.js';
import type { IUsersCache } from '../interfaces/cache/users.cache.interface.js';
import { debug, error, info, warn } from "../utils/logger.js";
import { identifyStreamer } from "../utils/posthog_events.js";

type DragonflyClient = Awaited<ReturnType<typeof getDragonflyClient>>;

const REFRESH_LOCK_TTL_MS = 5000;
const REFRESH_WAIT_TIMEOUT_MS = 4500;
const REFRESH_WAIT_POLL_MS = 150;
const TOKEN_EXPIRY_SKEW_SECONDS = 300;

function sanitizeCachePayload(payload: Record<string, unknown>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'string') {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

// Frames from the token pipeline itself are skipped so `caller` points at the
// real origin of the token request (command, handler, route, worker...).
const TOKEN_PIPELINE_FRAME_MARKERS = ['twitch_streamers.class.', 'tokens.', 'header.'];

function getTokenCaller(): string {
    const frames = new Error().stack?.split('\n').slice(1) ?? [];

    for (const frame of frames) {
        if (frame.includes('node:internal') || frame.includes('node_modules')) continue;
        if (TOKEN_PIPELINE_FRAME_MARKERS.some((marker) => frame.includes(marker))) continue;

        const location = frame.match(/([^\/\\()\s]+\.(?:ts|js)):(\d+):\d+/);
        if (!location) continue;

        const fn = frame.match(/at\s+(?:async\s+)?([\w$.<>]+)/)?.[1] ?? 'anonymous';
        return `${fn} (${location[1]}:${location[2]})`;
    }

    return 'unknown';
}

class TwitchStreamers {
    private cachePromise: ReturnType<typeof getDragonflyClient>;

    constructor() {
        this.cachePromise = getDragonflyClient('TwitchStreamers');
    }

    async getTwitchAccountsFromCache(): Promise<IUsersCache[] | null> {
        try {
            const cache = await this.cachePromise;

            const cachedAccounts = await cache.get('twitch:accounts');
            if(cachedAccounts) {
                return JSON.parse(cachedAccounts) as IUsersCache[];
            }
            
            const keys = await cache.keys('accounts:twitch:*:data');
            let accounts: IUsersCache[] = [];
            for(const key of keys) {
                const account = await cache.hGetAll(key) as unknown as IUsersCache;
                accounts.push(account);
            }
            await cache.set('twitch:accounts', JSON.stringify(accounts), { EX: 3600 });
            return accounts;
        } catch (err) {
            await error({ function: 'TwitchStreamers.getTwitchAccountsFromCache', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return [];
        }
    }

    async getTwitchAccountsFromDB() {
        try {
            const cache = await this.cachePromise;
            
            const result = await UsersSchema.find<IUsers>({ 'accounts.type': 'twitch' }).select('accounts plan_tier polar_sh_customer_id').lean();

            cache.del(`streamers:by:name`);
            await cache.del('twitch:accounts');
            for (const user of result ?? []) {
                const twitchAccount = user.accounts.find((account) => account.type === 'twitch');
                const cacheKey = `accounts:${twitchAccount!.type}:${twitchAccount!.id}:data`;
                const existingExpiresAt = await cache.hGet(cacheKey, 'expires_at');
                const persistedExpiresAt = twitchAccount?.access_token_expires_at ? String(twitchAccount.access_token_expires_at) : undefined;

                const twitchAccountCache: IUsersCache = {
                    id: twitchAccount?.id ?? '',
                    name: twitchAccount?.name ?? '',
                    email: twitchAccount?.email ?? '',
                    plan_tier: user.plan_tier ?? 'free',
                    plan_tier_until: user.plan_tier_until ? new Date(user.plan_tier_until).toDateString() : "",
                    polar_sh_customer_id: user.polar_sh_customer_id ?? '',
                    refresh_token: decrypt(twitchAccount!.refresh_token) ?? '',
                    access_token: decrypt(twitchAccount!.access_token) ?? '',
                    expires_at: existingExpiresAt || persistedExpiresAt,
                    actived: twitchAccount?.actived ? 'true' : 'false',
                    chat_enabled: twitchAccount?.chat_enabled ? 'true' : 'false',
                    has_permissions: twitchAccount?.has_permissions ? 'true' : 'false',
                    up_to_date_permissions: twitchAccount?.up_to_date_permissions ? 'true' : 'false',
                };

                await cache.hSet(cacheKey, sanitizeCachePayload(twitchAccountCache as unknown as Record<string, unknown>));

                await cache.sAdd(`streamers:by:id`, twitchAccount!.id);

                // Identify in PostHog on load (deduped per process; re-fires on rename)
                identifyStreamer(twitchAccount!.id, twitchAccount?.name ?? '');
            }

            info({ message: 'Accounts added to cache' }, { destination: 'console' });
            return result;
        } catch (err) {
            await error({ function: 'TwitchStreamers.getTwitchAccountsFromDB', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return null;
        }
    }

    async getTwitchAccountById(id: string): Promise<IUsersCache | null> {
        try {
            const cache = await this.cachePromise;

            let account = await cache.hGetAll(`accounts:twitch:${id}:data`) as unknown as IUsersCache | null;
            if (!account || !account.id) {
                account = await this.hydrateTwitchAccountById(id);
            }

            if (!account || !account.id) return null;

            return account;
        } catch (err) {
            await error({ function: 'TwitchStreamers.getTwitchAccountById', id, error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return null;
        }
    }

    async getTwitchStreamers(): Promise<string[]> {
        try {
            const cache = await this.cachePromise;
            return await cache.sMembers(`streamers:by:id`);
        } catch (err) {
            await error({ function: 'TwitchStreamers.getTwitchStreamers', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return [];
        }
    }

    async updateTwitchAccountsInCache(): Promise<void | null> {
        try {
            const cache = await this.cachePromise;
            await this.getTwitchAccountsFromDB();
            info({ message: 'Accounts updated in cache' }, { destination: 'console' });
        } catch (err) {
            await error({ function: 'TwitchStreamers.updateTwitchAccountsInCache', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return null;
        }
    }

    private isAccessTokenUsable(token: string | null | undefined, expiresAtRaw: string | null | undefined, skewSeconds = TOKEN_EXPIRY_SKEW_SECONDS): boolean {
        if (!token) return false;
        const expiration = expiresAtRaw ? Number.parseInt(expiresAtRaw, 10) : NaN;
        if (!Number.isFinite(expiration)) return false;
        const now = Math.floor(Date.now() / 1000);
        return now < expiration - skewSeconds;
    }

    private async acquireRefreshLock(cache: DragonflyClient, lockKey: string): Promise<string | null> {
        const lockValue = randomUUID();
        const result = await cache.set(lockKey, lockValue, { NX: true, PX: REFRESH_LOCK_TTL_MS });
        return result === 'OK' ? lockValue : null;
    }

    private async releaseRefreshLock(cache: DragonflyClient, lockKey: string, lockValue: string): Promise<void> {
        try {
            const current = await cache.get(lockKey);
            if (current === lockValue) {
                await cache.del(lockKey);
            }
        } catch {
            // Lock expires on its own (PX TTL); nothing else to do.
        }
    }

    private async waitForRefreshedToken(cache: DragonflyClient, dataKey: string, lockKey: string): Promise<string | null> {
        const deadline = Date.now() + REFRESH_WAIT_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_POLL_MS));

            const token = await cache.hGet(dataKey, 'access_token');
            const expiresAt = await cache.hGet(dataKey, 'expires_at');
            if (this.isAccessTokenUsable(token, expiresAt, 60)) {
                return token!;
            }

            // Winner finished without producing a usable token — stop waiting early.
            const lockHeld = await cache.exists(lockKey);
            if (lockHeld !== 1) break;
        }

        return null;
    }

    private async performTwitchTokenRefresh(id: string, account_type: 'twitch' | 'kick', caller: string): Promise<string | null> {
        const refreshToken = await this.getAccountRefreshTokenById(id, account_type);

        if (!refreshToken) {
            await error({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'refresh_failed', reason: 'refresh_token_not_found' }, { channelId: id, destination: 'cache' });
            return null;
        }

        const { refreshTwitchToken } = await import('../utils/tokens.js');
        const refreshResult = await refreshTwitchToken(refreshToken, id, {
            endpoint: 'token_refresh',
            url: 'https://id.twitch.tv/oauth2/token',
            caller
        });

        if (!refreshResult.token) {
            await error({
                function: 'TwitchStreamers.getAccountTokenById',
                id,
                account_type,
                caller,
                action: 'refresh_failed',
                reason: refreshResult.kind,
                status: refreshResult.status ?? null,
                message: refreshResult.message ?? null
            }, { channelId: id, destination: 'cache' });
            return null;
        }

        await info({
            function: 'TwitchStreamers.getAccountTokenById',
            id,
            account_type,
            caller,
            action: 'token_refreshed_successfully',
            expiresIn: refreshResult.expiresIn
        }, { channelId: id, destination: 'cache' });
        return refreshResult.token;
    }

    async getAccountTokenById(id: string, account_type: 'twitch' | 'kick'): Promise<string | null> {
        const caller = getTokenCaller();
        try {
            const cache = await this.cachePromise;
            const dataKey = `accounts:${account_type}:${id}:data`;

            let token = await cache.hGet(dataKey, 'access_token');
            let expiresAt = await cache.hGet(dataKey, 'expires_at');

            const now = Math.floor(Date.now() / 1000);
            const parsedExpiry = expiresAt ? Number.parseInt(expiresAt, 10) : NaN;
            const secondsUntilExpiry = Number.isFinite(parsedExpiry) ? parsedExpiry - now : null;

            await debug({
                function: 'TwitchStreamers.getAccountTokenById',
                id,
                account_type,
                caller,
                hasToken: !!token,
                hasExpiresAt: !!expiresAt,
                expiresAt: expiresAt || 'not set',
                secondsUntilExpiry
            }, { channelId: id, destination: 'cache' });

            if (token && this.isAccessTokenUsable(token, expiresAt)) {
                await debug({
                    function: 'TwitchStreamers.getAccountTokenById',
                    id,
                    account_type,
                    caller,
                    action: 'returning_cached_token',
                    secondsUntilExpiry
                }, { channelId: id, destination: 'cache' });
                return token;
            }

            await info({
                function: 'TwitchStreamers.getAccountTokenById',
                id,
                account_type,
                caller,
                action: 'token_needs_refresh',
                reason: !token
                    ? 'no_cached_token'
                    : Number.isFinite(parsedExpiry) ? 'near_or_expired' : 'missing_or_invalid_expires_at',
                secondsUntilExpiry,
                skewSeconds: TOKEN_EXPIRY_SKEW_SECONDS
            }, { channelId: id, destination: 'cache' });

            if (account_type !== 'twitch') {
                await error({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'refresh_failed', reason: `refresh_not_implemented_for_${account_type}` }, { channelId: id, destination: 'cache' });
                return null;
            }

            // Distributed lock: only one process/container refreshes a given user's
            // token at a time. Concurrent callers wait for the winner's result instead
            // of firing a duplicate refresh that would consume the rotated refresh token.
            const lockKey = `locks:refresh:${account_type}:${id}`;
            let lockValue = await this.acquireRefreshLock(cache, lockKey);

            if (!lockValue) {
                const winnerToken = await this.waitForRefreshedToken(cache, dataKey, lockKey);
                if (winnerToken) {
                    await debug({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'returned_token_from_concurrent_refresh' }, { channelId: id, destination: 'cache' });
                    return winnerToken;
                }

                // Winner failed or timed out — take over the refresh ourselves, once.
                lockValue = await this.acquireRefreshLock(cache, lockKey);
                if (!lockValue) {
                    await warn({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'refresh_lock_unavailable' }, { channelId: id, destination: 'cache' });
                    return null;
                }

                await info({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'refresh_lock_takeover' }, { channelId: id, destination: 'cache' });
            }

            try {
                // Double-check under the lock: the previous holder may have just refreshed.
                token = await cache.hGet(dataKey, 'access_token');
                expiresAt = await cache.hGet(dataKey, 'expires_at');
                if (this.isAccessTokenUsable(token, expiresAt)) {
                    await debug({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'returned_token_refreshed_before_lock' }, { channelId: id, destination: 'cache' });
                    return token!;
                }

                return await this.performTwitchTokenRefresh(id, account_type, caller);
            } finally {
                await this.releaseRefreshLock(cache, lockKey, lockValue);
            }
        } catch (err) {
            await error({ function: 'TwitchStreamers.getAccountTokenById', id, account_type, caller, action: 'exception', error: err instanceof Error ? err.message : String(err) }, { channelId: id, destination: 'cache' });
            return null;
        }
    }

    async getAccountRefreshTokenById(id: string, account_type: 'twitch' | 'kick'): Promise<string | null> {
        try {
            const cache = await this.cachePromise;
            let refresh_token = await cache.hGet(`accounts:${account_type}:${id}:data`, 'refresh_token');
            if (!refresh_token && account_type === 'twitch') {
                const hydrated = await this.hydrateTwitchAccountById(id);
                refresh_token = hydrated?.refresh_token || null;
            }
            if(!refresh_token) return null;
            return refresh_token;
        } catch (err) {
            await error({ function: 'TwitchStreamers.getAccountRefreshTokenById', id, account_type, error: err instanceof Error ? err.message : String(err) }, { channelId: id, destination: 'both' });
            return null;
        }
    }

    private async hydrateTwitchAccountById(id: string): Promise<IUsersCache | null> {
        try {
            const cache = await this.cachePromise;
            const user = await UsersSchema.findOne({
                'accounts.id': id,
                'accounts.type': 'twitch'
            })
                .select('accounts plan_tier plan_tier_until polar_sh_customer_id')
                .lean<IUsers | null>();

            if (!user) {
                return null;
            }

            const twitchAccount = user.accounts.find((account) => account.type === 'twitch' && account.id === id);
            if (!twitchAccount) {
                return null;
            }

            const cacheKey = `accounts:twitch:${id}:data`;
            const existingExpiresAt = await cache.hGet(cacheKey, 'expires_at');
            const persistedExpiresAt = twitchAccount.access_token_expires_at ? String(twitchAccount.access_token_expires_at) : undefined;

            const accountCache: IUsersCache = {
                id: twitchAccount.id,
                name: twitchAccount.name ?? '',
                email: twitchAccount.email ?? '',
                plan_tier: user.plan_tier ?? 'free',
                plan_tier_until: user.plan_tier_until ? new Date(user.plan_tier_until).toDateString() : '',
                polar_sh_customer_id: user.polar_sh_customer_id ?? '',
                refresh_token: decrypt(twitchAccount.refresh_token) ?? '',
                access_token: decrypt(twitchAccount.access_token) ?? '',
                expires_at: existingExpiresAt || persistedExpiresAt,
                actived: twitchAccount.actived ? 'true' : 'false',
                chat_enabled: twitchAccount.chat_enabled ? 'true' : 'false',
                has_permissions: twitchAccount.has_permissions ? 'true' : 'false',
                up_to_date_permissions: twitchAccount.up_to_date_permissions ? 'true' : 'false'
            };

            await cache.hSet(cacheKey, sanitizeCachePayload(accountCache as unknown as Record<string, unknown>));
            await cache.sAdd('streamers:by:id', id);
            await cache.del('twitch:accounts');

            // Identify in PostHog on first lazy load (deduped per process; re-fires on rename)
            identifyStreamer(twitchAccount.id, twitchAccount.name ?? '');

            return accountCache;
        } catch (err) {
            await error({ function: 'TwitchStreamers.hydrateTwitchAccountById', id, error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            return null;
        }
    }
}

export default new TwitchStreamers();
