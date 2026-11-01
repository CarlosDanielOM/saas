import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { executeHelixStreamerRequestWith401Retry } from '../../utils/twitch_helix_retry.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { error as logError } from '../../utils/logger.js';
import { refreshEditorCache } from '../../utils/permissions/roles.js';
import { normalizeEditors, type Editor } from './editor_list.js';

interface GetEditorsResponse {
    error: boolean;
    message?: string;
    editors?: Editor[];
    type?: 'auth_required' | 'transient';
    status?: number;
}

export async function getChannelEditors(channelID: string, cache: boolean = false): Promise<GetEditorsResponse> {
    let editorList: Editor[] = [];

    try {
        const cacheClient = await getDragonflyClient('getChannelEditors');
        const params = new URLSearchParams({ broadcaster_id: channelID });
        const url = getTwitchHelixUrl('channels/editors', params.toString());
        const request = await executeHelixStreamerRequestWith401Retry({
            channelID, operation: 'get_channel_editors', requestUrl: url, requestMethod: 'GET',
            executeRequest: (headers) => fetch(url, { headers, signal: AbortSignal.timeout(10000) })
        });
        if (request.error || !request.response) {
            return { error: true, type: 'transient', status: request.status, message: request.message || 'Twitch editor lookup unavailable' };
        }
        const response = request.response;
        const data = await response.json();
        if (!response.ok || data.error) {
            return {
                error: true, type: response.status === 401 || response.status === 403 ? 'auth_required' : 'transient',
                status: response.status, message: data.message || `Twitch editor lookup failed (${response.status})`
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
            message: 'Internal server error',
            type: 'transient'
        };
    }
}
