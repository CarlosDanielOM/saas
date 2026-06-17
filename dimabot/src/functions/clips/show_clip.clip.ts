import { getUserColor } from '../chats/index.js';
import { error as logError } from "../../utils/logger.js";
import { searchGameById } from '../search/index.js';
import { requestClip, checkClipConnection, generateRandomClipID } from './queue.clip.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import {
  MAX_RANDOM_REROLLS,
  SHOWN_CLIPS_TTL_SECONDS
} from './get_clips.clip.js';

interface ClipData {
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
    game_id: string;
    title: string;
    user_id: string;
    user_login: string;
    user_name: string;
    profile_image_url: string;
    description: string;
}

interface ShowClipResponse {
    error?: boolean;
    message?: string;
    status?: number;
    type?: string;
}

export async function showClip(channelID: string, clipData: any[], streamerData: any, streamerChannelData: any, sendToQueue: boolean = false): Promise<ShowClipResponse> {
    try {
        if (!clipData || !streamerData || !streamerChannelData) {
            console.error(`Error in showClip: Missing parameters`, {
                channelID
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                message: 'Missing parameters',
                status: 400,
                type: 'missing_parameters'
            };
        }

        const streamerID = streamerData.id;

        const streamerColorResult = await getUserColor(streamerID);

        if (streamerColorResult.error || !streamerColorResult.color) {
            console.error(`Error in showClip: Failed to get streamer color`, {
                channelID,
                streamerID,
                streamerColorResult
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                message: 'Failed to get streamer color',
                status: streamerColorResult.status,
                type: 'error'
            };
        }

        const streamerColor = streamerColorResult.color;

        // === Grok Build 0.1: smarter non-repetitive clip selection ===
        // Track per-target (the owner of the clips, i.e. streamerData.id).
        // We avoid clips that have been shown to this target within the last 24h (or until full cycle reset).
        const targetChannelID = streamerData.id;
        let effectiveClipList = clipData;

        try {
            const cacheClient = await getDragonflyClient('showClip:shown');
            const shownKey = `twitch:${targetChannelID}:clips:shown`;
            const shownIds: string[] = await cacheClient.sMembers(shownKey);
            const shownSet = new Set(shownIds);

            const notShown = clipData.filter((c: any) => c && c.id && !shownSet.has(String(c.id)));

            if (notShown.length === 0 && clipData.length > 0) {
                // All clips in the current batch have been shown within the window -> reset for this target
                await cacheClient.del(shownKey);
                effectiveClipList = clipData;
            } else if (notShown.length > 0) {
                effectiveClipList = notShown;
            }
        } catch (e) {
            // Cache error reading shown set: fall back gracefully to full list (feature must not break)
            console.error(`showClip: failed to read shown-clips set for target ${targetChannelID}, using full list`, e);
            effectiveClipList = clipData;
        }

        // Pick from effective list with up to MAX_RANDOM_REROLLS reroll attempts
        // Rule: if first random pick hits a recently shown clip, reroll once; if reroll also collides, send it anyway.
        let selectedClip: any = null;
        try {
            const cacheClient = await getDragonflyClient('showClip:pick');
            const shownKey = `twitch:${targetChannelID}:clips:shown`;
            const shownIds: string[] = await cacheClient.sMembers(shownKey);
            const shownSet = new Set(shownIds);

            let attempts = 0;
            while (attempts <= MAX_RANDOM_REROLLS) {
                if (effectiveClipList.length === 0) {
                    effectiveClipList = clipData; // defensive
                }
                const idx = Math.floor(Math.random() * effectiveClipList.length);
                const candidate = effectiveClipList[idx];

                if (!candidate || !candidate.id) {
                    attempts++;
                    continue;
                }

                const isRecentlyShown = shownSet.has(String(candidate.id));

                if (!isRecentlyShown || attempts === MAX_RANDOM_REROLLS) {
                    selectedClip = candidate;
                    break;
                }

                // Collision and we still have a reroll budget -> try again
                attempts++;
            }

            // Absolute fallback
            if (!selectedClip && clipData.length > 0) {
                selectedClip = clipData[Math.floor(Math.random() * clipData.length)];
            }
        } catch (e) {
            console.error(`showClip: reroll selection failed for target ${targetChannelID}, using simple random`, e);
            if (clipData.length > 0) {
                selectedClip = clipData[Math.floor(Math.random() * clipData.length)];
            }
        }

        if (!selectedClip) {
            console.error(`Error in showClip: Clip not found`, {
                channelID
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                message: 'Clip not found',
                status: 404,
                type: 'clip_not_found'
            };
        }

        const duration = selectedClip.duration || null;
        const clipUrl = selectedClip.url || null;

        if (!duration || !clipUrl) {
            console.error(`Error in showClip: Missing clip duration or URL`, {
                channelID
            }, { channelId: channelID, destination: 'both' });
            return {
                error: true,
                message: 'Missing clip duration or URL',
                status: 400,
                type: 'missing_parameters'
            };
        }

        const clipGameResult = await searchGameById(selectedClip.game_id);

        if (clipGameResult.error || !clipGameResult.data) {
            console.error(`Error in showClip: Game data not found, using fallback`, {
                channelID,
                gameID: selectedClip.game_id,
                searchResult: clipGameResult
            }, { channelId: channelID, destination: 'both' });
            const gameData: any = {
                id: selectedClip.game_id,
                name: 'Unknown Game',
                box_art_url: ''
            };

            const connectionResult = await checkClipConnection(channelID);

            if (!connectionResult.connected) {
                console.log(`showClip skipped - OBS not connected for channel ${channelID}`);
                return {
                    error: false,
                    message: 'Skipped - OBS not connected'
                };
            }

            // Grok Build 0.1: record this clip as shown for the *target* (prevents repetition across shoutouts to this streamer)
            try {
                const cacheClient = await getDragonflyClient('showClip:record');
                const shownKey = `twitch:${targetChannelID}:clips:shown`;
                if (selectedClip && selectedClip.id) {
                    await cacheClient.sAdd(shownKey, String(selectedClip.id));
                    await cacheClient.expire(shownKey, SHOWN_CLIPS_TTL_SECONDS);
                }
            } catch (e) {
                console.error(`showClip: failed to record shown clip for target ${targetChannelID}`, e);
            }

            const clipID = generateRandomClipID();

            const clipRequestData = {
                clipID: clipID,
                streamerLogin: streamerData.login,
                duration: duration,
                clipUrl: clipUrl,
                title: streamerChannelData.title,
                game: 'Unknown Game',
                streamer: streamerData.display_name,
                profileImage: streamerData.profile_image_url,
                description: streamerData.description,
                streamerColor: streamerColor,
                timestamp: Date.now()
            };

            await requestClip(channelID, streamerData.login, clipRequestData, sendToQueue);

            return {
                error: false,
                message: sendToQueue ? 'Clip queued and processing' : 'Clip queued'
            };
        }

        let gameData: any;
        if (clipGameResult.data) {
            gameData = clipGameResult.data;
        }

        const connectionResult = await checkClipConnection(channelID);

        if (!connectionResult.connected) {
            console.log(`showClip skipped - OBS not connected for channel ${channelID}`);
            return {
                error: false,
                message: 'Skipped - OBS not connected'
            };
        }

        // Grok Build 0.1: record this clip as shown for the *target* (per-target anti-repetition)
        try {
            const cacheClient = await getDragonflyClient('showClip:record');
            const shownKey = `twitch:${targetChannelID}:clips:shown`;
            if (selectedClip && selectedClip.id) {
                await cacheClient.sAdd(shownKey, String(selectedClip.id));
                await cacheClient.expire(shownKey, SHOWN_CLIPS_TTL_SECONDS);
            }
        } catch (e) {
            console.error(`showClip: failed to record shown clip for target ${targetChannelID}`, e);
        }

        const clipID = generateRandomClipID();

        const clipRequestData = {
            clipID: clipID,
            streamerLogin: streamerData.login,
            duration: duration,
            clipUrl: clipUrl,
            title: streamerChannelData.title,
            game: gameData.name,
            streamer: streamerData.display_name,
            profileImage: streamerData.profile_image_url,
            description: streamerData.description,
            streamerColor: streamerColor,
            timestamp: Date.now()
        };

        await requestClip(channelID, streamerData.login, clipRequestData, sendToQueue);

        return {
            error: false,
            message: sendToQueue ? 'Clip queued and processing' : 'Clip queued'
        };
    } catch (err) {
        await logError({ function: 'showClip',
            channelID,
            clipData,
            streamerData,
            streamerChannelData,
            sendToQueue,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        }, { channelId: channelID, destination: 'both' });
        return {
            error: true,
            message: 'Internal server error',
            type: 'error'
        };
    }
}
