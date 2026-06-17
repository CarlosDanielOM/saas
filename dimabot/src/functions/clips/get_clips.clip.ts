import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { error as logError } from "../../utils/logger.js";
import { getTwitchAppHeader } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';

interface TwitchClip {
    id: string;
    url: string;
    embed_url: string;
    broadcaster_id: string;
    creator_id: string;
    video_id: string;
    created_at: string;
    thumbnail_url: string;
    duration: number;
    vod_offset: number | null;
    is_mutable: boolean;
}

interface GetChannelClipsResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
    data?: TwitchClip[];
}

/**
 * Clip system tunables (Grok Build 0.1)
 * - DEFAULT_CLIP_FETCH_AMOUNT: how many clips to request from Twitch when no explicit amount given
 * - CLIP_CACHE_TTL_HOURS: how long to cache the clip list
 * - MAX_RANDOM_REROLLS: how many times showClip will reroll when hitting a recently-shown clip
 * - SHOWN_CLIPS_TTL_SECONDS: retention for the per-target "recently shown" set (24h default)
 */
export const DEFAULT_CLIP_FETCH_AMOUNT = 50;
export const CLIP_CACHE_TTL_HOURS = 5;
export const MAX_RANDOM_REROLLS = 1;
export const SHOWN_CLIPS_TTL_SECONDS = 24 * 60 * 60;

export async function getChannelClips(channelID: string, amount: number | null = null, skip_cache: boolean = false): Promise<GetChannelClipsResponse> {
    try {
        const cacheClient = await getDragonflyClient('getChannelClips');
        const cacheKey = `twitch:${channelID}:clips`;

        if (!skip_cache) {
            const cachedData = await cacheClient.get(cacheKey);
            if (cachedData) {
                const parsedData = JSON.parse(cachedData);
                return {
                    error: false,
                    message: 'Success (from cache)',
                    data: parsedData
                };
            }
        }

        const appHeader = await getTwitchAppHeader();

        const fetchAmount = amount ?? DEFAULT_CLIP_FETCH_AMOUNT;

        const params = new URLSearchParams();
        params.append('broadcaster_id', channelID);

        if (fetchAmount) {
            params.append('first', String(fetchAmount));
        }

        const response = await fetch(getTwitchHelixUrl('clips', params.toString()), {
            headers: appHeader as unknown as Record<string, string>
        });
        const data = await response.json();

        if (data.error) {
            return {
                error: true,
                message: data.message,
                status: data.status,
                type: data.error
            };
        }

        await cacheClient.set(cacheKey, JSON.stringify(data.data), { EX: 60 * 60 * CLIP_CACHE_TTL_HOURS });
        return {
            error: false,
            message: 'Success',
            data: data.data
        };
    } catch (err) {
        await logError({ function: 'getChannelClips',
            channelID,
            amount,
            skip_cache,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        }, { channelId: channelID, destination: 'both' });
        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
