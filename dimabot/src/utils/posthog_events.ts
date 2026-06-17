import { PostHog } from 'posthog-node';

// PostHog client initialized with the project API key
// Host is the US PostHog instance
const posthog = new PostHog('phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP', {
    host: 'https://us.i.posthog.com',
    flushInterval: 1000,
    flushAt: 20,
});

/**
 * Identify a streamer (channel) in PostHog.
 * This associates properties with the channelID distinct ID.
 */
export function identifyStreamer(channelID: string, channelName: string): void {
    posthog.identify({
        distinctId: channelID,
        properties: {
            channel_name: channelName,
        },
    });
}

/**
 * Track a command execution event in PostHog.
 */
export function trackCommand(params: {
    channelID: string;
    channelName: string;
    command: string;
    status: 'success' | 'error';
    userID: string;
    username: string;
    arguments?: string;
    errorMessage?: string;
}): void {
    posthog.capture({
        distinctId: params.channelID,
        event: 'command_executed',
        properties: {
            channel_id: params.channelID,
            channel_name: params.channelName,
            command: params.command,
            status: params.status,
            user_id: params.userID,
            username: params.username,
            arguments: params.arguments ?? null,
            error_message: params.errorMessage ?? null,
        },
    });
}

/**
 * Track a TTS/speech execution event in PostHog.
 */
export function trackTts(params: {
    channelID: string;
    channelName: string;
    source: 'chat-command' | 'ast';
    ttsType: string;
    characters: number;
    message: string;
    status: 'success' | 'error';
    mode?: string;
    provider?: string;
    userID: string;
    username: string;
    errorMessage?: string;
}): void {
    posthog.capture({
        distinctId: params.channelID,
        event: 'tts_executed',
        properties: {
            channel_id: params.channelID,
            channel_name: params.channelName,
            source: params.source,
            tts_type: params.ttsType,
            characters: params.characters,
            message: params.message,
            status: params.status,
            mode: params.mode ?? null,
            provider: params.provider ?? null,
            user_id: params.userID,
            username: params.username,
            error_message: params.errorMessage ?? null,
        },
    });
}

/**
 * Shutdown the PostHog client gracefully.
 * Call this during application shutdown.
 */
export async function shutdownPosthog(): Promise<void> {
    await posthog.shutdown();
}