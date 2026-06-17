import { getTwitchBotHeader } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { error as logError } from '../../utils/logger.js';

// Bot's own user ID - used as the moderator performing pin actions
// This is the DimaBot account and should be left alone
const DEFAULT_MODERATOR_ID = '698614112';
const MIN_PIN_DURATION_SECONDS = 30;
const MAX_PIN_DURATION_SECONDS = 1800;

export type PinnedMessageFragmentType = 'text' | 'emote' | 'cheermote' | 'mention';

export interface PinnedMessageCheermote {
    prefix: string;
    bits: number;
    tier: number;
}

export interface PinnedMessageEmote {
    id: string;
    emote_set_id: string;
    owner_id: string;
    format: string[];
}

export interface PinnedMessageMention {
    user_id: string;
    user_login: string;
    user_name: string;
}

export interface PinnedMessageFragment {
    type: PinnedMessageFragmentType;
    text: string;
    cheermote: PinnedMessageCheermote | null;
    emote: PinnedMessageEmote | null;
    mention: PinnedMessageMention | null;
}

export interface PinnedMessageContent {
    text: string;
    fragments: PinnedMessageFragment[];
}

export interface PinnedChatMessage {
    message_id: string;
    broadcaster_id: string;
    sender_user_id: string;
    sender_user_login: string;
    sender_user_name: string;
    pinned_by_user_id: string;
    pinned_by_user_login: string;
    pinned_by_user_name: string;
    message: PinnedMessageContent;
    starts_at: string;
    ends_at: string | null;
    updated_at: string;
}

export interface PinnedChatMessagesResponse {
    error: boolean;
    message: string;
    status: number;
    type?: string;
    data?: PinnedChatMessage[];
}

export interface PinnedChatMessageMutationResponse {
    error: boolean;
    message: string;
    status: number;
    type?: string;
}

interface TwitchApiPayload<T> {
    data?: T;
    error?: string;
    message?: string;
    status?: number;
}

async function readTwitchPayload<T>(response: Response): Promise<TwitchApiPayload<T>> {
    const responseText = await response.text();
    if (!responseText) {
        return {
            error: 'empty_response',
            message: 'Twitch API returned an empty response',
            status: response.status
        };
    }

    try {
        return JSON.parse(responseText) as TwitchApiPayload<T>;
    } catch {
        return {
            error: 'parse_error',
            message: 'Failed to parse Twitch response',
            status: response.status
        };
    }
}

function buildPinnedMessageParams(
    broadcasterID: string,
    moderatorID: string,
    messageID?: string,
    durationSeconds?: number
): URLSearchParams {
    const params = new URLSearchParams({
        broadcaster_id: broadcasterID,
        moderator_id: moderatorID
    });

    if (messageID) {
        params.set('message_id', messageID);
    }

    if (durationSeconds !== undefined) {
        params.set('duration_seconds', durationSeconds.toString());
    }

    return params;
}

function validatePinDuration(durationSeconds?: number): PinnedChatMessageMutationResponse | null {
    if (durationSeconds === undefined) {
        return null;
    }

    if (
        !Number.isInteger(durationSeconds)
        || durationSeconds < MIN_PIN_DURATION_SECONDS
        || durationSeconds > MAX_PIN_DURATION_SECONDS
    ) {
        return {
            error: true,
            message: `durationSeconds must be an integer between ${MIN_PIN_DURATION_SECONDS} and ${MAX_PIN_DURATION_SECONDS}`,
            status: 400,
            type: 'validation_error'
        };
    }

    return null;
}

function validateMessageID(messageID: string): PinnedChatMessageMutationResponse | null {
    if (!messageID || typeof messageID !== 'string' || messageID.trim() === '') {
        return {
            error: true,
            message: 'messageID is required and must be a non-empty string',
            status: 400,
            type: 'validation_error'
        };
    }
    return null;
}

async function getBotHeaders(functionName: string, channelID: string, moderatorID: string) {
    const botHeaderResult = await getTwitchBotHeader();

    if (botHeaderResult.error || !botHeaderResult.header) {
        await logError({
            function: functionName,
            channelID,
            moderatorID,
            operation: 'get_twitch_bot_header',
            error: botHeaderResult.message
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true as const,
            message: botHeaderResult.message,
            status: 403,
            type: 'error'
        };
    }

    return {
        error: false as const,
        headers: botHeaderResult.header as unknown as Record<string, string>
    };
}

/**
 * Gets the currently pinned chat message for a channel.
 * Uses Twitch Helix API endpoint: GET /chat/pins
 *
 * @param channelID - The broadcaster's channel ID
 * @param moderatorID - The moderator ID performing the action (defaults to bot's own ID)
 * @returns Response containing the pinned message data or error details
 */
export async function getPinnedChatMessage(
    channelID: string,
    moderatorID: string = DEFAULT_MODERATOR_ID
): Promise<PinnedChatMessagesResponse> {
    try {
        const headerResult = await getBotHeaders('getPinnedChatMessage', channelID, moderatorID);
        if (headerResult.error) {
            return {
                error: true,
                message: headerResult.message,
                status: headerResult.status,
                type: 'error'
            };
        }

        const params = buildPinnedMessageParams(channelID, moderatorID);
        const response = await fetch(getTwitchHelixUrl('chat/pins', params.toString()), {
            method: 'GET',
            headers: headerResult.headers,
            signal: AbortSignal.timeout(10000)
        });

        const payload = await readTwitchPayload<PinnedChatMessage[]>(response);

        if (!response.ok || payload.error) {
            await logError({
                function: 'getPinnedChatMessage',
                channelID,
                moderatorID,
                operation: 'get_pinned_chat_message',
                error: payload.message || 'Twitch API error',
                twitchError: payload.error,
                twitchMessage: payload.message,
                apiEndpoint: 'chat/pins',
                method: 'GET',
                responseStatus: response.status
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: payload.message || 'Failed to get pinned chat message',
                status: response.status,
                type: payload.error
            };
        }

        return {
            error: false,
            message: 'Pinned chat message retrieved',
            status: response.status,
            data: payload.data || []
        };
    } catch (err) {
        await logError({
            function: 'getPinnedChatMessage',
            channelID,
            moderatorID,
            operation: 'get_pinned_chat_message',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            apiEndpoint: 'chat/pins',
            method: 'GET'
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}

/**
 * Pins a chat message in the channel.
 * Uses Twitch Helix API endpoint: PUT /chat/pins
 *
 * @param channelID - The broadcaster's channel ID
 * @param messageID - The message ID to pin
 * @param durationSeconds - Optional pin duration (30-1800 seconds). If not provided, uses channel default
 * @param moderatorID - The moderator ID performing the action (defaults to bot's own ID)
 * @returns Success or error response
 */
export async function pinChatMessage(
    channelID: string,
    messageID: string,
    durationSeconds?: number,
    moderatorID: string = DEFAULT_MODERATOR_ID
): Promise<PinnedChatMessageMutationResponse> {
    const durationValidation = validatePinDuration(durationSeconds);
    if (durationValidation) {
        return durationValidation;
    }

    const messageIDValidation = validateMessageID(messageID);
    if (messageIDValidation) {
        return messageIDValidation;
    }

    try {
        const headerResult = await getBotHeaders('pinChatMessage', channelID, moderatorID);
        if (headerResult.error) {
            return headerResult;
        }

        const params = buildPinnedMessageParams(channelID, moderatorID, messageID, durationSeconds);
        const response = await fetch(getTwitchHelixUrl('chat/pins', params.toString()), {
            method: 'PUT',
            headers: headerResult.headers,
            signal: AbortSignal.timeout(10000)
        });

        if (response.status === 204) {
            return {
                error: false,
                message: 'Chat message pinned',
                status: 204,
                type: 'success'
            };
        }

        const payload = await readTwitchPayload<unknown>(response);

        await logError({
            function: 'pinChatMessage',
            channelID,
            moderatorID,
            messageID,
            durationSeconds,
            operation: 'pin_chat_message',
            error: payload.message || 'Failed to pin chat message',
            twitchError: payload.error,
            twitchMessage: payload.message,
            apiEndpoint: 'chat/pins',
            method: 'PUT',
            responseStatus: response.status
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: payload.message || 'Failed to pin chat message',
            status: response.status,
            type: payload.error
        };
    } catch (err) {
        await logError({
            function: 'pinChatMessage',
            channelID,
            moderatorID,
            messageID,
            durationSeconds,
            operation: 'pin_chat_message',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            apiEndpoint: 'chat/pins',
            method: 'PUT'
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}

/**
 * Updates the duration of a pinned chat message.
 * Uses Twitch Helix API endpoint: PATCH /chat/pins
 *
 * @param channelID - The broadcaster's channel ID
 * @param messageID - The pinned message ID to update
 * @param durationSeconds - New pin duration (30-1800 seconds)
 * @param moderatorID - The moderator ID performing the action (defaults to bot's own ID)
 * @returns Success or error response
 */
export async function updatePinnedChatMessage(
    channelID: string,
    messageID: string,
    durationSeconds?: number,
    moderatorID: string = DEFAULT_MODERATOR_ID
): Promise<PinnedChatMessageMutationResponse> {
    const durationValidation = validatePinDuration(durationSeconds);
    if (durationValidation) {
        return durationValidation;
    }

    const messageIDValidation = validateMessageID(messageID);
    if (messageIDValidation) {
        return messageIDValidation;
    }

    try {
        const headerResult = await getBotHeaders('updatePinnedChatMessage', channelID, moderatorID);
        if (headerResult.error) {
            return headerResult;
        }

        const params = buildPinnedMessageParams(channelID, moderatorID, messageID, durationSeconds);
        const response = await fetch(getTwitchHelixUrl('chat/pins', params.toString()), {
            method: 'PATCH',
            headers: headerResult.headers,
            signal: AbortSignal.timeout(10000)
        });

        if (response.status === 204) {
            return {
                error: false,
                message: 'Pinned chat message updated',
                status: 204,
                type: 'success'
            };
        }

        const payload = await readTwitchPayload<unknown>(response);

        await logError({
            function: 'updatePinnedChatMessage',
            channelID,
            moderatorID,
            messageID,
            durationSeconds,
            operation: 'update_pinned_chat_message',
            error: payload.message || 'Failed to update pinned chat message',
            twitchError: payload.error,
            twitchMessage: payload.message,
            apiEndpoint: 'chat/pins',
            method: 'PATCH',
            responseStatus: response.status
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: payload.message || 'Failed to update pinned chat message',
            status: response.status,
            type: payload.error
        };
    } catch (err) {
        await logError({
            function: 'updatePinnedChatMessage',
            channelID,
            moderatorID,
            messageID,
            durationSeconds,
            operation: 'update_pinned_chat_message',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            apiEndpoint: 'chat/pins',
            method: 'PATCH'
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}

/**
 * Unpins a chat message from the channel.
 * Uses Twitch Helix API endpoint: DELETE /chat/pins
 *
 * @param channelID - The broadcaster's channel ID
 * @param messageID - The pinned message ID to unpin
 * @param moderatorID - The moderator ID performing the action (defaults to bot's own ID)
 * @returns Success or error response
 */
export async function unpinChatMessage(
    channelID: string,
    messageID: string,
    moderatorID: string = DEFAULT_MODERATOR_ID
): Promise<PinnedChatMessageMutationResponse> {
    const messageIDValidation = validateMessageID(messageID);
    if (messageIDValidation) {
        return messageIDValidation;
    }

    try {
        const headerResult = await getBotHeaders('unpinChatMessage', channelID, moderatorID);
        if (headerResult.error) {
            return headerResult;
        }

        const params = buildPinnedMessageParams(channelID, moderatorID, messageID);
        const response = await fetch(getTwitchHelixUrl('chat/pins', params.toString()), {
            method: 'DELETE',
            headers: headerResult.headers,
            signal: AbortSignal.timeout(10000)
        });

        if (response.status === 204) {
            return {
                error: false,
                message: 'Chat message unpinned',
                status: 204,
                type: 'success'
            };
        }

        const payload = await readTwitchPayload<unknown>(response);

        await logError({
            function: 'unpinChatMessage',
            channelID,
            moderatorID,
            messageID,
            operation: 'unpin_chat_message',
            error: payload.message || 'Failed to unpin chat message',
            twitchError: payload.error,
            twitchMessage: payload.message,
            apiEndpoint: 'chat/pins',
            method: 'DELETE',
            responseStatus: response.status
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: payload.message || 'Failed to unpin chat message',
            status: response.status,
            type: payload.error
        };
    } catch (err) {
        await logError({
            function: 'unpinChatMessage',
            channelID,
            moderatorID,
            messageID,
            operation: 'unpin_chat_message',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            apiEndpoint: 'chat/pins',
            method: 'DELETE'
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}
