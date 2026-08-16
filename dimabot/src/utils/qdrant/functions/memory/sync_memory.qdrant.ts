import { generateEmbedding } from '../../../ai/lfm2_embeddings/index.js';
import { getQdrantConnection } from '../../../databases/qdrant.database.js';
import { error, debug } from '../../../logger.js';
import { qdrantPointBelongsToMemory } from '../../qdrant_point_id.js';

const COLLECTION_NAME = 'twitch_channel_memories';

export interface IUpsertChannelMemoryParams {
    qdrantPointID: number;
    memoryId: string;
    channelID: string;
    memoryType?: string;
    status?: string;
    risk?: string;
    confidence?: number;
    subjectScope?: string;
    subjectUsername?: string;
    subjectUserID?: string;
    content: string;
    summary: string;
    createdAtUnix?: number;
    updatedAtUnix?: number;
}

export interface IUpsertChannelMemoryResult {
    error: boolean;
    message?: string;
}

export interface IDeleteChannelMemoryResult {
    error: boolean;
    message?: string;
}

function buildEmbeddingInput(summary: string | undefined, content: string | undefined): string {
    const cleanSummary = String(summary || '').trim();
    const cleanContent = String(content || '').trim();
    return `${cleanSummary}\n${cleanContent}`.trim();
}

async function retrievePointPayload(
    qdrantClient: { retrieve: Function },
    qdrantPointID: number
): Promise<Record<string, unknown> | null> {
    const points = await qdrantClient.retrieve(COLLECTION_NAME, {
        ids: [qdrantPointID],
        with_payload: true,
        with_vector: false
    });
    if (!Array.isArray(points) || points.length === 0) {
        return null;
    }
    const payload = points[0]?.payload;
    return payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
}

export async function upsertChannelMemoryEmbedding(params: IUpsertChannelMemoryParams): Promise<IUpsertChannelMemoryResult> {
    try {
        if (!Number.isInteger(params.qdrantPointID) || params.qdrantPointID < 0 || !params.memoryId || !params.channelID) {
            return {
                error: true,
                message: 'Missing or invalid qdrantPointID, memoryId, or channelID'
            };
        }

        const qdrantClient = await getQdrantConnection('upsertChannelMemoryEmbedding');
        const existingPayload = await retrievePointPayload(qdrantClient, params.qdrantPointID);
        if (existingPayload && !qdrantPointBelongsToMemory(existingPayload, params.memoryId, params.channelID)) {
            return {
                error: true,
                message: 'Qdrant point ID collision detected; refusing to overwrite another memory'
            };
        }

        const embeddingInput = buildEmbeddingInput(params.summary, params.content);
        if (!embeddingInput) {
            return {
                error: true,
                message: 'Memory content is empty'
            };
        }

        const embeddingResult = await generateEmbedding(embeddingInput, 'lfm2.5-embedding-350m', 'document');
        if (embeddingResult.error || !embeddingResult.embedding) {
            return {
                error: true,
                message: embeddingResult.message || 'Failed to generate memory embedding'
            };
        }

        await qdrantClient.upsert(COLLECTION_NAME, {
            wait: true,
            points: [
                {
                    id: params.qdrantPointID,
                    vector: embeddingResult.embedding,
                    payload: {
                        memory_id: params.memoryId,
                        channel_id: params.channelID,
                        memory_type: params.memoryType,
                        status: params.status,
                        risk: params.risk,
                        confidence: params.confidence,
                        subject_scope: params.subjectScope,
                        subject_username: params.subjectUsername || '',
                        subject_user_id: params.subjectUserID || '',
                        content: params.content,
                        summary: params.summary,
                        created_at: params.createdAtUnix,
                        updated_at: params.updatedAtUnix
                    }
                }
            ]
        });

        debug({
            message: 'Channel memory embedding upserted',
            memoryId: params.memoryId,
            qdrantPointID: params.qdrantPointID,
            channelID: params.channelID,
            status: params.status,
            type: params.memoryType
        }, { destination: 'cache' });

        return { error: false };
    } catch (err) {
        await error({
            function: 'upsertChannelMemoryEmbedding',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            memoryId: params.memoryId,
            channelID: params.channelID
        }, { channelId: params.channelID, destination: 'both' });

        return {
            error: true,
            message: 'Failed to upsert channel memory embedding'
        };
    }
}

export async function deleteChannelMemoryEmbedding(
    qdrantPointID: number,
    channelID: string,
    memoryID?: string
): Promise<IDeleteChannelMemoryResult> {
    try {
        if (!Number.isInteger(qdrantPointID) || qdrantPointID < 0) {
            return {
                error: true,
                message: 'Missing or invalid qdrantPointID'
            };
        }

        const qdrantClient = await getQdrantConnection('deleteChannelMemoryEmbedding');
        const existingPayload = await retrievePointPayload(qdrantClient, qdrantPointID);
        if (!existingPayload) {
            return { error: false };
        }
        if (memoryID && !qdrantPointBelongsToMemory(existingPayload, memoryID, channelID)) {
            return {
                error: true,
                message: 'Qdrant point ID collision detected; refusing to delete another memory'
            };
        }
        await qdrantClient.delete(COLLECTION_NAME, {
            wait: true,
            points: [qdrantPointID]
        });

        return { error: false };
    } catch (err) {
        await error({
            function: 'deleteChannelMemoryEmbedding',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            qdrantPointID
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Failed to delete channel memory embedding'
        };
    }
}


export async function deleteChannelMemoryEmbeddingsByChannel(
    channelID: string
): Promise<IDeleteChannelMemoryResult> {
    try {
        if (!channelID) {
            return { error: true, message: 'Missing channelID' };
        }
        const qdrantClient = await getQdrantConnection('deleteChannelMemoryEmbeddingsByChannel');
        await qdrantClient.delete(COLLECTION_NAME, {
            wait: true,
            filter: {
                must: [
                    { key: 'channel_id', match: { value: channelID } }
                ]
            }
        });
        return { error: false };
    } catch (err) {
        await error({
            function: 'deleteChannelMemoryEmbeddingsByChannel',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: channelID, destination: 'both' });
        return {
            error: true,
            message: 'Failed to delete channel memory embeddings'
        };
    }
}
