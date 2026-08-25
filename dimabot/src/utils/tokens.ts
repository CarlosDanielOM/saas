import { getDragonflyClient } from "./databases/dragonfly.database.js";
import TwitchStreamers from "../classes/twitch_streamers.class.js";
import UsersSchema, { type IUsers } from "../schemas/users.schema.js";
import { encrypt } from "./crypto.js";
import { getTwitchOAuthUrl } from "./links.js";
import { cacheOAuthTokenRefreshFailure } from "./oauth_debug_cache.js";

const BOT_USER_ID = '698614112';
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_RETRY_BACKOFF_MS = [400, 900];
let count = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RefreshFailureKind = 'transient_failure' | 'permanent_failure';

interface RefreshTwitchTokenResult {
    token: string | null;
    refreshToken: string | null;
    expiresIn: number | null;
    kind: 'success' | RefreshFailureKind;
    status?: number;
    message?: string;
}

function getRefreshFailureMessage(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
        return '';
    }

    const source = payload as Record<string, unknown>;
    const values = [source.message, source.error_description, source.error]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return values.join(' | ');
}

function isPermanentRefreshFailure(status: number, payload: unknown): boolean {
    const normalizedMessage = getRefreshFailureMessage(payload).toLowerCase();

    if (!(status === 400 || status === 401)) {
        return false;
    }

    return [
        'invalid refresh token',
        'invalid refresh',
        'invalid grant',
        'authorization grant is invalid',
        'revoked',
        'authorization has been revoked'
    ].some((fragment) => normalizedMessage.includes(fragment));
}

async function invalidateStoredTwitchTokens(userId: string): Promise<void> {
    const cache = await getDragonflyClient('Tokens');
    const nullToken = {
        iv: null,
        content: null
    };

    await UsersSchema.findOneAndUpdate(
        { 'accounts.id': userId },
        {
            $set: {
                'accounts.$.refresh_token': nullToken,
                'accounts.$.access_token': nullToken,
                'accounts.$.access_token_expires_at': null,
                'accounts.$.has_permissions': false,
                'accounts.$.up_to_date_permissions': false
            }
        }
    );

    await cache.hSet(`accounts:twitch:${userId}:data`, {
        access_token: '',
        refresh_token: '',
        expires_at: '',
        has_permissions: 'false',
        up_to_date_permissions: 'false'
    });
}

// @deprecated This function is deprecated. Tokens are now refreshed automatically when needed via smart refresh system.
export const refreshAllTokens = async () => {
    count++;
    const cache = await getDragonflyClient('Tokens');
    await TwitchStreamers.updateTwitchAccountsInCache();
    const twitchStreamers = await TwitchStreamers.getTwitchStreamers();

    const promises = twitchStreamers.map(async streamer => {
        try {
            let account = await TwitchStreamers.getTwitchAccountById(streamer);
            if(!account) return null;

            if(!account.refresh_token) {
                console.log('Refresh token is null for ', {streamer});
                return null;
            }

            const refreshResult = await refreshTwitchToken(account.refresh_token, account.id);

            if(!refreshResult.token) {
                if (refreshResult.kind === 'permanent_failure') {
                    await cache.sRem(`streamers:by:id`, account.id);
                    await cache.sRem(`streamers:by:name`, account.name);
                    await TwitchStreamers.updateTwitchAccountsInCache();
                }

                return console.error(`Error refreshing token for ${account.id} ${account.name}: ${refreshResult.message || refreshResult.kind}`);
            }

            account.access_token = refreshResult.token!;
            account.refresh_token = refreshResult.refreshToken!;

            await cache.hSet(`accounts:twitch:${account.id}:data`, 'refresh_token', account.refresh_token);

            await cache.hSet(`accounts:twitch:${account.id}:data`, 'access_token', account.access_token);

            const encryptedToken = encrypt(account.access_token);
            const encryptedRefreshToken = encrypt(account.refresh_token);

            await UsersSchema.findOneAndUpdate({'accounts.id': account.id}, {$set: {'accounts.$.refresh_token': encryptedRefreshToken, 'accounts.$.access_token': encryptedToken}})
        } catch (error) {
            console.error(`Error refreshing token for ${streamer}: ${error}`);
            return null;
        }
    });
}

export const refreshTwitchToken = async (
    refresh_token: string,
    user_id: string,
    context?: { endpoint?: string; url?: string }
): Promise<RefreshTwitchTokenResult> => {
    try {
        const cache = await getDragonflyClient('Tokens');

        // URLSearchParams already URL-encodes values — do NOT encodeURIComponent here.
        const params = new URLSearchParams({
            client_id: process.env.CLIENT_ID!,
            client_secret: process.env.CLIENT_SECRET!,
            grant_type: 'refresh_token',
            refresh_token
        });

        // Send credentials in the POST body, never in the URL query string.
        // Retry transient failures (network errors, Twitch 5xx) so a single blip
        // does not surface as an auth error to the user.
        let twitchRefreshResponse: Response | null = null;
        let responseText = '';

        for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt++) {
            try {
                twitchRefreshResponse = await fetch(getTwitchOAuthUrl('token'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: params.toString()
                });
                responseText = await twitchRefreshResponse.text();
            } catch (fetchError) {
                twitchRefreshResponse = null;
                responseText = '';
                console.error(`Network error refreshing Twitch token for ${user_id} (attempt ${attempt + 1}/${REFRESH_MAX_ATTEMPTS}):`, {
                    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    timestamp: new Date().toISOString()
                });
            }

            const retryable = !twitchRefreshResponse || twitchRefreshResponse.status >= 500;
            if (!retryable || attempt === REFRESH_MAX_ATTEMPTS - 1) break;

            await sleep(REFRESH_RETRY_BACKOFF_MS[attempt] ?? 900);
        }

        if (!twitchRefreshResponse) {
            return {
                token: null,
                refreshToken: null,
                expiresIn: null,
                kind: 'transient_failure',
                message: 'Network error while refreshing Twitch token'
            };
        }

        let refreshTokenData: Record<string, unknown> = {};

        try {
            refreshTokenData = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
        } catch (parseError) {
            console.error(`Error parsing Twitch token refresh response for ${user_id}:`, {
                error: parseError instanceof Error ? parseError.message : String(parseError),
                status: twitchRefreshResponse.status,
                body: responseText,
                timestamp: new Date().toISOString()
            });

            return {
                token: null,
                refreshToken: null,
                expiresIn: null,
                kind: 'transient_failure',
                status: twitchRefreshResponse.status,
                message: 'Failed to parse Twitch token refresh response'
            };
        }

        const hasOAuthError = !twitchRefreshResponse.ok || Boolean(refreshTokenData.error);
        if (hasOAuthError) {
            const message = getRefreshFailureMessage(refreshTokenData) || `HTTP ${twitchRefreshResponse.status}`;
            const failureKind: RefreshFailureKind = isPermanentRefreshFailure(twitchRefreshResponse.status, refreshTokenData)
                ? 'permanent_failure'
                : 'transient_failure';

            console.error(`Error refreshing Twitch token for ${user_id}: ${message}`, {
                status: twitchRefreshResponse.status,
                failureKind,
                response: refreshTokenData,
                timestamp: new Date().toISOString()
            });

            await cacheOAuthTokenRefreshFailure({
                timestamp: new Date().toISOString(),
                userID: user_id,
                refreshTokenPrefix: refresh_token.slice(0, 8),
                failureKind,
                failureReason: message,
                status: twitchRefreshResponse.status,
                responseBody: responseText,
                endpoint: context?.endpoint || 'unknown',
                // Never store the full request URL here — it carries client_secret
                // and the complete refresh token in the query string.
                url: context?.url || getTwitchOAuthUrl('token')
            });

            if (failureKind === 'permanent_failure') {
                // Compare-before-invalidate: only wipe the stored tokens if the refresh
                // token that just failed is still the one we have stored. If another
                // process already rotated it (concurrent refresh), the stored
                // credentials are valid — reuse them instead of logging the user out.
                const storedRefreshToken = await TwitchStreamers.getAccountRefreshTokenById(user_id, 'twitch');

                if (storedRefreshToken && storedRefreshToken !== refresh_token) {
                    const storedAccessToken = await cache.hGet(`accounts:twitch:${user_id}:data`, 'access_token');
                    const storedExpiresAtRaw = await cache.hGet(`accounts:twitch:${user_id}:data`, 'expires_at');
                    const storedExpiresAt = storedExpiresAtRaw ? Number.parseInt(storedExpiresAtRaw, 10) : NaN;
                    const now = Math.floor(Date.now() / 1000);

                    if (storedAccessToken && Number.isFinite(storedExpiresAt) && now < storedExpiresAt - 60) {
                        console.info(`Refresh token for ${user_id} was already rotated by a concurrent refresh; returning stored access token`);
                        return {
                            token: storedAccessToken,
                            refreshToken: storedRefreshToken,
                            expiresIn: storedExpiresAt - now,
                            kind: 'success'
                        };
                    }

                    return {
                        token: null,
                        refreshToken: null,
                        expiresIn: null,
                        kind: 'transient_failure',
                        status: twitchRefreshResponse.status,
                        message: `${message} (stored token already rotated by a concurrent refresh)`
                    };
                }

                await invalidateStoredTwitchTokens(user_id);
            }

            return {
                token: null,
                refreshToken: null,
                expiresIn: null,
                kind: failureKind,
                status: twitchRefreshResponse.status,
                message
            };
        }

        const token = typeof refreshTokenData.access_token === 'string' ? refreshTokenData.access_token : null;
        const refreshToken = typeof refreshTokenData.refresh_token === 'string' ? refreshTokenData.refresh_token : null;
        const expiresIn = typeof refreshTokenData.expires_in === 'number' ? refreshTokenData.expires_in : 7200;

        if (!token || !refreshToken) {
            console.error(`Twitch token refresh returned incomplete payload for ${user_id}`, {
                status: twitchRefreshResponse.status,
                response: refreshTokenData,
                timestamp: new Date().toISOString()
            });

            return {
                token: null,
                refreshToken: null,
                expiresIn: null,
                kind: 'transient_failure',
                status: twitchRefreshResponse.status,
                message: 'Twitch token refresh returned incomplete payload'
            };
        }

        const encryptedToken = encrypt(token);
        const encryptedRefreshToken = encrypt(refreshToken);
        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

        // Update database
        const userDoc = await UsersSchema.findOne({ 'accounts.id': user_id }) as IUsers;
        if (!userDoc) {
            console.error(`User not found for ${user_id}`);
            return {
                token: null,
                refreshToken: null,
                expiresIn: null,
                kind: 'transient_failure',
                message: 'User not found while storing refreshed token'
            };
        }

        await UsersSchema.findOneAndUpdate(
            { 'accounts.id': user_id },
            {
                $set: {
                    'accounts.$.refresh_token': encryptedRefreshToken,
                    'accounts.$.access_token': encryptedToken,
                    'accounts.$.access_token_expires_at': expiresAt,
                    'accounts.$.has_permissions': true,
                    'accounts.$.up_to_date_permissions': true
                }
            }
        );

        // Update cache in a single multi-field write (access_token expires, refresh_token doesn't)
        await cache.hSet(`accounts:twitch:${user_id}:data`, {
            access_token: token,
            refresh_token: refreshToken,
            expires_at: String(expiresAt),
            has_permissions: 'true',
            up_to_date_permissions: 'true'
        });
        
        return {
            token,
            refreshToken,
            expiresIn,
            kind: 'success'
        };
    } catch (error) {
        console.error(`Error refreshing Twitch token for ${user_id}: ${error}`);
        return {
            token: null,
            refreshToken: null,
            expiresIn: null,
            kind: 'transient_failure',
            message: error instanceof Error ? error.message : String(error)
        };
    }
};

export const getNewTwitchAppToken = async () => {
    try {
        const cache = await getDragonflyClient('Tokens');

        let params = new URLSearchParams({
            client_id: process.env.CLIENT_ID!,
            client_secret: process.env.CLIENT_SECRET!,
            grant_type: 'client_credentials',
        });

        const twitchAppResponse = await fetch(getTwitchOAuthUrl('token'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        const appTokenData = await twitchAppResponse.json();

        if(!appTokenData.access_token) {
            console.error(`Error getting new Twitch app token: ${appTokenData.message}`);
            return null;
        }

        await cache.set('app:twitch:token', String(appTokenData.access_token), {EX: Number(appTokenData.expires_in)});

        return appTokenData;
    } catch (error) {
        console.error(`Error getting new Twitch app token internal error: ${error}`);
        return null;
    }
}

export const getAppToken = async (platform: 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'spotify'): Promise<string | null> => {
    try {
        const cache = await getDragonflyClient('Tokens');
        const token = await cache.get(`app:${platform}:token`);
        if(token) return token;

        const appToken = await getNewTwitchAppToken();
        if(!appToken) return null;

        await cache.set(`app:twitch:token`, String(appToken.access_token), {EX: Number(appToken.expires_in)});
        return appToken.access_token;
    } catch (error) {
        console.error(`Error getting ${platform} app token: ${error}`);
        return null;
    }
}

export const getBotToken = async (): Promise<string | null> => {
    try {
        const token = await TwitchStreamers.getAccountTokenById(BOT_USER_ID, 'twitch');
        
        if (token) {
            const cache = await getDragonflyClient('Tokens');
            await cache.hSet('app:twitch:bot', 'access_token', token);
        }
        
        return token;
    } catch (error) {
        console.error(`Error getting bot token: ${error}`);
        return null;
    }
};
