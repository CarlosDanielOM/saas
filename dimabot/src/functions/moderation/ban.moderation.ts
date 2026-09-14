import { getTwitchBotHeader } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';

interface TwitchBanData {
    broadcaster_id: string;
    moderator_id: string;
    user_id: string;
    created_at: string;
    end_time?: string;
    reason?: string;
}

export interface BanResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
    data?: TwitchBanData;
    rateLimitRemaining?: number;
    rateLimitResetAt?: number;
    retryAfterMs?: number;
}

export function banRateLimitHeaders(headers: Headers, now = Date.now()): Pick<BanResponse, 'rateLimitRemaining' | 'rateLimitResetAt' | 'retryAfterMs'> {
    const number = (name: string) => {
        const raw = headers.get(name);
        const value = raw === null || !raw.trim() ? NaN : Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const reset = number('Ratelimit-Reset');
    const retry = headers.get('Retry-After');
    const seconds = number('Retry-After');
    const retryDate = retry ? Date.parse(retry) : NaN;
    return {
        rateLimitRemaining: number('Ratelimit-Remaining'),
        rateLimitResetAt: reset === undefined ? undefined : reset * 1000,
        retryAfterMs: seconds !== undefined ? seconds * 1000 : Number.isFinite(retryDate) ? Math.max(0, retryDate - now) : undefined
    };
}

export async function ban(channelID: string, userID: string, moderatorID: string, duration: number | null = null, reason: string | null = null, signal?: AbortSignal): Promise<BanResponse> {
    try {
        const botHeaderResult = await getTwitchBotHeader();
        signal?.throwIfAborted();

        if (botHeaderResult.error || !botHeaderResult.header) {
            return {
                error: true,
                message: botHeaderResult.message,
                status: 403,
                type: 'permission_error'
            };
        }

        const botHeader = botHeaderResult.header;

        const params = new URLSearchParams({
            broadcaster_id: channelID,
            moderator_id: moderatorID
        });

        const bodyData = {
            data: {
                user_id: userID
            }
        };

        if (duration) {
            (bodyData.data as any).duration = duration;
        }

        if (reason) {
            (bodyData.data as any).reason = reason;
        }

        const response = await fetch(getTwitchHelixUrl('moderation/bans', params.toString()), {
            method: 'POST',
            signal,
            headers: botHeader as unknown as Record<string, string>,
            body: JSON.stringify(bodyData)
        });

        const limits = banRateLimitHeaders(response.headers);
        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.error) {
            return {
                error: true,
                message: data.message || response.statusText || 'Twitch ban request failed',
                status: response.status,
                type: data.error,
                ...limits
            };
        }

        return {
            error: false,
            message: 'Success',
            status: response.status,
            data: data.data?.[0],
            ...limits
        };
    } catch (error) {
        console.error(`Error in ban:`, {
            channelID,
            userID,
            moderatorID,
            duration,
            reason,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return {
            error: true,
            message: 'Internal server error',
            type: 'error'
        };
    }
}
