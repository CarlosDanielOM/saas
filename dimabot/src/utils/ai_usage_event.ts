import { randomUUID } from 'node:crypto';

export const AI_USAGE_SCHEMA_VERSION = 1 as const;
export const AI_USAGE_PRICING_VERSION = 'legacy-polar-math-v1' as const;

export type AiUsageEntryKind = 'usage' | 'adjustment';
export type AiUsageCategory =
    | 'tts'
    | 'ai_chat'
    | 'ai_agent'
    | 'memory'
    | 'clip_recommendation'
    | 'credit_adjustment'
    | 'other';
export type AiUsageUnit = 'characters' | 'tokens' | 'minutes';
export type AiUsageResourceType = 'speech' | 'voice_preview' | 'llm_generation' | 'vod_analysis';

export interface AiUsageContextInput {
    entryId?: string;
    requestId?: string;
    parentRequestId?: string;
    entryKind?: AiUsageEntryKind;
    category?: AiUsageCategory;
    operation?: string;
    source?: string;
    provider?: string;
    model?: string;
    channelID?: string;
    quantity?: number;
    unit?: AiUsageUnit;
    resourceType?: AiUsageResourceType;
    resourceId?: string;
}

export interface AiUsageContext {
    schemaVersion: typeof AI_USAGE_SCHEMA_VERSION;
    pricingVersion: typeof AI_USAGE_PRICING_VERSION;
    entryId: string;
    requestId: string;
    parentRequestId?: string;
    entryKind: AiUsageEntryKind;
    category: AiUsageCategory;
    operation: string;
    source: string;
    provider: string;
    model?: string;
    channelID?: string;
    quantity?: number;
    unit?: AiUsageUnit;
    resourceType?: AiUsageResourceType;
    resourceId?: string;
}

export interface PolarUsageMetadataShape {
    schema_version: number;
    pricing_version: string;
    entry_id: string;
    request_id: string;
    parent_request_id?: string;
    entry_kind: AiUsageEntryKind;
    category: AiUsageCategory;
    operation: string;
    usage_source: string;
    provider: string;
    model?: string;
    channel_id?: string;
    quantity?: number;
    unit?: AiUsageUnit;
    resource_type?: AiUsageResourceType;
    resource_id?: string;
}

interface Classification {
    entryKind: AiUsageEntryKind;
    category: AiUsageCategory;
    operation: string;
    source: string;
    provider: string;
}

function classifyLegacyReason(reason: string): Classification {
    switch (reason) {
        case 'tts_fish':
            return { entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'tts_queue', provider: 'fish' };
        case 'messages':
            return { entryKind: 'usage', category: 'ai_chat', operation: 'message', source: 'chat', provider: 'openrouter' };
        case 'harness_tools':
            return { entryKind: 'usage', category: 'ai_chat', operation: 'tool_reasoning', source: 'chat', provider: 'openrouter' };
        case 'harness_end':
            return { entryKind: 'usage', category: 'ai_chat', operation: 'final_response', source: 'chat', provider: 'openrouter' };
        case 'planner':
            return { entryKind: 'usage', category: 'ai_agent', operation: 'plan', source: 'code_execution', provider: 'openrouter' };
        case 'coding_agent':
            return { entryKind: 'usage', category: 'ai_agent', operation: 'generate_code', source: 'code_execution', provider: 'openrouter' };
        case 'stream_summary':
            return { entryKind: 'usage', category: 'memory', operation: 'stream_summary', source: 'stream_offline', provider: 'openrouter' };
        case 'weekly_summary':
            return { entryKind: 'usage', category: 'memory', operation: 'weekly_summary', source: 'weekly_maintenance', provider: 'openrouter' };
        case 'monthly_summary':
            return { entryKind: 'usage', category: 'memory', operation: 'monthly_summary', source: 'monthly_maintenance', provider: 'openrouter' };
        case 'vod_clip_recommendation':
            return { entryKind: 'usage', category: 'clip_recommendation', operation: 'analyze_vod', source: 'clip_recommendation', provider: 'openrouter' };
        case 'Free benefits':
            return { entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'activation', provider: 'polar' };
        default:
            return { entryKind: 'usage', category: 'other', operation: reason || 'usage', source: 'backend', provider: 'unknown' };
    }
}

function optionalFinite(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalText(value: string | undefined): string | undefined {
    const normalized = String(value || '').trim();
    return normalized || undefined;
}

export function createAiUsageContext(reason: string, input: AiUsageContextInput = {}): AiUsageContext {
    const classified = classifyLegacyReason(reason);
    const entryId = optionalText(input.entryId) || `aiu_${randomUUID()}`;

    return {
        schemaVersion: AI_USAGE_SCHEMA_VERSION,
        pricingVersion: AI_USAGE_PRICING_VERSION,
        entryId,
        requestId: optionalText(input.requestId) || entryId,
        ...(optionalText(input.parentRequestId) ? { parentRequestId: optionalText(input.parentRequestId) } : {}),
        entryKind: input.entryKind || classified.entryKind,
        category: input.category || classified.category,
        operation: optionalText(input.operation) || classified.operation,
        source: optionalText(input.source) || classified.source,
        provider: optionalText(input.provider) || classified.provider,
        ...(optionalText(input.model) ? { model: optionalText(input.model) } : {}),
        ...(optionalText(input.channelID) ? { channelID: optionalText(input.channelID) } : {}),
        ...(optionalFinite(input.quantity) !== undefined ? { quantity: optionalFinite(input.quantity) } : {}),
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        ...(optionalText(input.resourceId) ? { resourceId: optionalText(input.resourceId) } : {})
    };
}

export function toPolarUsageMetadata(context: AiUsageContext): PolarUsageMetadataShape {
    return {
        schema_version: context.schemaVersion,
        pricing_version: context.pricingVersion,
        entry_id: context.entryId,
        request_id: context.requestId,
        ...(context.parentRequestId ? { parent_request_id: context.parentRequestId } : {}),
        entry_kind: context.entryKind,
        category: context.category,
        operation: context.operation,
        usage_source: context.source,
        provider: context.provider,
        ...(context.model ? { model: context.model } : {}),
        ...(context.channelID ? { channel_id: context.channelID } : {}),
        ...(context.quantity !== undefined ? { quantity: context.quantity } : {}),
        ...(context.unit ? { unit: context.unit } : {}),
        ...(context.resourceType ? { resource_type: context.resourceType } : {}),
        ...(context.resourceId ? { resource_id: context.resourceId } : {})
    };
}

export function enrichPolarUsageMetadata<T extends object>(
    accountingMetadata: T,
    context: AiUsageContext
): T & PolarUsageMetadataShape {
    return {
        ...accountingMetadata,
        ...toPolarUsageMetadata(context)
    };
}
