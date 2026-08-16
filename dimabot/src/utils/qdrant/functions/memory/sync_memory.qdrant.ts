import { generateEmbedding } from '../../../ai/lfm2_embeddings/index.js';
import { getQdrantConnection } from '../../../databases/qdrant.database.js';
import { error, debug } from '../../../logger.js';

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

export async function upsertChannelMemoryEmbedding(params: IUpsertChannelMemoryParams): Promise<IUpsertChannelMemoryResult> {
    try {
        if (!Number.isInteger(params.qdrantPointID) || params.qdrantPointID < 0 || !params.memoryId || !params.channelID) {
            return {
                error: true,
                message: 'Missing or invalid qdrantPointID, memoryId, or channelID'
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

        const qdrantClient = await getQdrantConnection('upsertChannelMemoryEmbedding');
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

export async function deleteChannelMemoryEmbedding(qdrantPointID: number, channelID?: string): Promise<IDeleteChannelMemoryResult> {
    try {
        if (!Number.isInteger(qdrantPointID) || qdrantPointID < 0) {
            return {
                error: true,
                message: 'Missing or invalid qdrantPointID'
            };
        }

        const qdrantClient = await getQdrantConnection('deleteChannelMemoryEmbedding');
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
