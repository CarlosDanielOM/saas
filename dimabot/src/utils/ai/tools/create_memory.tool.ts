/**
 * Create Memory Tool
 * 
 * Allows the chat AI to proactively save memories during conversations,
 * rather than waiting for the stream summary runner.
 */

import { createOrUpdateChannelMemory } from '../memory/memory.service.js';
import { getChannelLearningConfig } from '../memory/memory.service.js';
import type { IStreamerData } from './index.js';
import { error, debug } from '../../logger.js';

export interface CreateMemoryToolResult {
    success: boolean;
    confirmed: boolean;
    pending: boolean;
    message: string;
    memoryId?: string;
    error?: string;
}

interface CreateMemoryArgs {
    type: 'boundary' | 'preference' | 'known_user_fact' | 'channel_lore' | 'running_joke';
    content: string;
    summary: string;
    risk?: 'low' | 'medium' | 'high';
    username?: string;
}

interface ToolContext {
    channelID: string;
    streamer: IStreamerData;
    username?: string;
    tags?: Record<string, any>;
}

export async function execute(
    args: CreateMemoryArgs,
    context: ToolContext
): Promise<CreateMemoryToolResult> {
    const { channelID, streamer, username: triggeredBy, tags } = context;
    const { type, content, summary, risk = 'low', username } = args;

    try {
        // Get learning config to use streamer's threshold values
        const learningConfig = await getChannelLearningConfig(channelID);
        
        // Use createMinConfidence as the confidence value (streamer can customize this)
        const confidence = learningConfig.createMinConfidence;

        // Get the triggering user's info and message for evidence
        const triggeringUsername = triggeredBy || tags?.username || tags?.chatter_user_name || 'unknown';
        const triggeringMessage = tags?.message || tags?.text || content;
        const timestamp = Math.floor(Date.now() / 1000);

        // Determine subject scope
        const subjectScope = username ? 'user' : 'channel';

        // Call createOrUpdateChannelMemory
        const result = await createOrUpdateChannelMemory({
            channelID,
            channelName: streamer?.name,
            type,
            risk,
            confidence, // Use streamer's threshold value
            subject: {
                scope: subjectScope,
                username: username || ''
            },
            content,
            summary,
            evidence: [
                {
                    source: 'chat',
                    username: triggeringUsername,
                    message: triggeringMessage,
                    timestamp
                }
            ],
            createdBy: {
                source: 'chat',
                username: triggeringUsername
            }
        });

        if (result.error) {
            return {
                success: false,
                confirmed: false,
                pending: false,
                message: 'Failed to save memory',
                error: result.message
            };
        }

        // Determine if memory was auto-confirmed or pending
        const memory = result.memory;
        const wasConfirmed = memory?.status === 'confirmed';

        await debug({
            message: '[Create Memory Tool] Memory creation result',
            channelID,
            type,
            confidence,
            autoConfirmThreshold: learningConfig.autoConfirmThreshold,
            wasConfirmed,
            memoryStatus: memory?.status
        }, { channelId: channelID, destination: 'console' });

        // Return result with appropriate message for AI to use
        if (wasConfirmed) {
            return {
                success: true,
                confirmed: true,
                pending: false,
                message: 'Memory Saved successfully ✅',
                memoryId: String(memory?._id || '')
            };
        } else {
            return {
                success: true,
                confirmed: false,
                pending: true,
                message: 'Memory under pending review 📝',
                memoryId: String(memory?._id || '')
            };
        }

    } catch (err) {
        await error({
            function: 'createMemoryTool.execute',
            error: err instanceof Error ? err.message : String(err),
            channelID
        }, { channelId: channelID, destination: 'both' });

        return {
            success: false,
            confirmed: false,
            pending: false,
            message: 'Failed to save memory',
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
