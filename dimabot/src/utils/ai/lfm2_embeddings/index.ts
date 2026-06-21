// LFM2.5 Embeddings barrel export.
// Use this from callers instead of the openrouter embeddings module.
export {
    generateEmbedding,
    generateEmbeddings,
    LFM2_EMBEDDING_DIM,
} from './lfm2_embeddings.client.js';

export type {
    LFM2EmbeddingKind,
    ILFM2EmbeddingRequest,
    ILFM2EmbeddingResponse,
    ILFM2EmbeddingError,
    IEmbeddingResult,
    IBatchEmbeddingResult,
} from './lfm2_embeddings.client.js';
