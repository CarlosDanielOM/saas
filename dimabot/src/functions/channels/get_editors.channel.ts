import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { getTwitchStreamerHeaderById } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { error as logError } from '../../utils/logger.js';
import { refreshEditorCache } from '../../utils/permissions/roles.js';
import { normalizeEditors, type Editor } from './editor_list.js';

interface GetEditorsResponse {
    error: boolean;
    message?: string;
    editors?: Editor[];
}

export async function getChannelEditors(channelID: string, cache: boolean = false): Promise<GetEditorsResponse> {
    let editorList: Editor[] = [];

    try {
        const cacheClient = await getDragonflyClient('getChannelEditors');
        await TwitchStreamers.getTwitchAccountById(channelID);

        const streamerHeaderResult = await getTwitchStreamerHeaderById(channelID);

        if (streamerHeaderResult.error || !streamerHeaderResult.header) {
            return {
                error: true,
                message: streamerHeaderResult.message
            };
        }

        const streamerHeader = streamerHeaderResult.header;

        const params = new URLSearchParams({
            broadcaster_id: channelID
        });

        const response = await fetch(getTwitchHelixUrl('channels/editors', params.toString()), {
            headers: {
                'Client-Id': streamerHeader['Client-Id'],
                'Authorization': streamerHeader.Authorization,
                'Content-Type': streamerHeader['Content-Type']
            }
        });

        const data = await response.json();

        if (data.error) {
            return {
                error: true,
                message: data.message
            };
         }

         editorList = normalizeEditors(data.data);

         if (cache) {
             // Atomically refresh both canonical editor sets (logins + IDs)
             // and their TTLs, removing any legacy editor key.
             await refreshEditorCache(cacheClient, channelID, editorList);
         }

        return {
            error: false,
            editors: editorList
        };
    } catch (err) {
        await logError({
            function: 'getChannelEditors',
            channelID,
            cache,
            operation: 'get_channel_editors',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            apiEndpoint: 'channels/editors',
            method: 'GET',
            editorsCount: editorList.length
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
