import { PostHog } from 'posthog-node';
import { AI_USAGE_SCHEMA_VERSION, type AiUsageContext } from './ai_usage_event.js';

// PostHog client initialized with the project API key
// Host is the US PostHog instance
const posthog = new PostHog('phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP', {
    host: 'https://us.i.posthog.com',
    flushInterval: 1000,
    flushAt: 20,
});

// Tracks the last channel_name identified per channelID in this process so
// identify() is only sent on first sight, after a restart, or on an actual
// rename — never per chat message / command / event.
const identifiedStreamers = new Map<string, string>();

/**
 * Identify a streamer (channel) in PostHog.
 * This associates properties with the channelID distinct ID.
 * No-op if this process already identified the channel with the same name.
 */
export function identifyStreamer(channelID: string, channelName: string): void {
    if (!channelID || !channelName) return;
    if (identifiedStreamers.get(channelID) === channelName) return;

    identifiedStreamers.set(channelID, channelName);
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
            user_id: params.userID || params.channelID,
            username: params.username || params.channelName,
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
            user_id: params.userID || params.channelID,
            username: params.username || params.channelName,
            error_message: params.errorMessage ?? null,
        },
    });
}

export function trackAiUsageRecorded(params: {
    context: AiUsageContext;
    credits: number;
    reason: string;
    polarCostAmount?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}): void {
    const { context } = params;
    posthog.capture({
        distinctId: context.channelID || `billing:${context.requestId}`,
        event: 'ai_usage_recorded',
        properties: {
            $insert_id: context.entryId,
            schema_version: context.schemaVersion,
            pricing_version: context.pricingVersion,
            entry_id: context.entryId,
            request_id: context.requestId,
            parent_request_id: context.parentRequestId ?? null,
            entry_kind: context.entryKind,
            category: context.category,
            operation: context.operation,
            source: context.source,
            provider: context.provider,
            model: context.model ?? null,
            channel_id: context.channelID ?? null,
            credits: params.credits,
            reason: params.reason,
            polar_cost_amount: params.polarCostAmount ?? null,
            quantity: context.quantity ?? null,
            unit: context.unit ?? null,
            resource_type: context.resourceType ?? null,
            resource_id: context.resourceId ?? null,
            input_tokens: params.inputTokens ?? null,
            output_tokens: params.outputTokens ?? null,
            total_tokens: params.totalTokens ?? null,
        },
    });
}

export function trackAiOperation(params: {
    requestId: string;
    channelID: string;
    category: string;
    operation: string;
    source: string;
    lifecycle: 'queued' | 'completed' | 'failed';
    requestedProvider?: string;
    actualProvider?: string;
    fallbackReason?: string;
    errorCode?: string;
    resourceType?: string;
    resourceId?: string;
    latencyMs?: number;
}): void {
    posthog.capture({
        distinctId: params.channelID,
        event: 'ai_operation',
        properties: {
            $insert_id: `${params.requestId}:${params.operation}:${params.lifecycle}`,
            schema_version: AI_USAGE_SCHEMA_VERSION,
            request_id: params.requestId,
            channel_id: params.channelID,
            category: params.category,
            operation: params.operation,
            source: params.source,
            lifecycle: params.lifecycle,
            requested_provider: params.requestedProvider ?? null,
            actual_provider: params.actualProvider ?? null,
            fallback_reason: params.fallbackReason ?? null,
            error_code: params.errorCode ?? null,
            resource_type: params.resourceType ?? null,
            resource_id: params.resourceId ?? null,
            latency_ms: params.latencyMs ?? null,
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
