/**
 * LFM2.5 Embeddings Client
 *
 * OpenAI-compatible client for the self-hosted
 * `LiquidAI/LFM2.5-Embedding-350M` service (served by the
 * `lfm2.5-embeddings` container in docker-compose).
 *
 * The remote service is implemented in
 * `dimabot/scripts/lfm2_embeddings_server.py` and is fully
 * OpenAI-shaped. The asymmetry between query and document prompts
 * is handled by the `kind` field on each request.
 *
 * Replaces the previous `openrouter/embeddings.ai.ts` callers; the
 * OpenRouter file is kept around as dead code in case anyone wants
 * to swap back.
 */

import { error, debug } from '../../logger.js';
import { createFetchWithRetry } from '../fetch.utils.js';

const DEFAULT_LFM2_EMBEDDINGS_URL = 'http://lfm2.5-embeddings:8080/v1/embeddings';
const DEFAULT_LFM2_TIMEOUT_MS = 10000;
const DEFAULT_LFM2_RETRIES = 2;

const LFM2_EMBEDDINGS_URL = process.env.LFM2_EMBEDDINGS_URL || DEFAULT_LFM2_EMBEDDINGS_URL;
const LFM2_TIMEOUT_MS = Number(process.env.LFM2_EMBEDDINGS_TIMEOUT_MS || DEFAULT_LFM2_TIMEOUT_MS);
const LFM2_RETRIES = Number.isFinite(Number(process.env.LFM2_EMBEDDINGS_RETRIES))
    ? Number(process.env.LFM2_EMBEDDINGS_RETRIES)
    : DEFAULT_LFM2_RETRIES;

const fetchWithRetry = createFetchWithRetry({
    timeout: LFM2_TIMEOUT_MS,
    retries: LFM2_RETRIES,
    // 5xx + 429 are retryable; 4xx (e.g. validation) should fail fast
    retryOn: [429, 500, 502, 503, 504],
});

export type LFM2EmbeddingKind = 'query' | 'document';

export interface ILFM2EmbeddingRequest {
    input: string | string[];
    model?: string;
    kind?: LFM2EmbeddingKind;
    /**
     * When true, skip L2 normalization on the response.
     * Default false (we normalize, matching the dense-retrieve.py
     * reference implementation in the model's card).
     */
    skip_normalize?: boolean;
}

export interface ILFM2EmbeddingData {
    embedding: number[];
    index: number;
    object: string;
}

export interface ILFM2EmbeddingResponse {
    data: ILFM2EmbeddingData[];
    model: string;
    usage?: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

export interface ILFM2EmbeddingError {
    error: {
        message: string;
        type: string;
        code: number;
    };
}

export interface IEmbeddingResult {
    error: boolean;
    message?: string;
    embedding?: number[];
    model?: string;
    tokens?: number;
}

export interface IBatchEmbeddingResult extends IEmbeddingResult {
    embeddings?: number[][];
}

function normaliseEmbeddings(embedding: number[] | undefined, model: string): IEmbeddingResult {
    if (!embedding) {
        return { error: true, message: 'Empty embedding returned from LFM2 service', model };
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
        return { error: true, message: 'Invalid embedding shape', model };
    }
    return { error: false, embedding, model };
}

/**
 * Single-text embedding helper. Mirrors `generateEmbedding(text)` in
 * the previous OpenRouter module so call sites that don't care about
 * the kind can stay one-liners.
 */
export async function generateEmbedding(
    text: string,
    model: string = 'lfm2.5-embedding-350m',
    kind: LFM2EmbeddingKind = 'document',
): Promise<IEmbeddingResult> {
    try {
        const startTime = Date.now();
        const requestBody: ILFM2EmbeddingRequest = {
            input: text,
            model,
            kind,
        };

        const response = await fetchWithRetry(LFM2_EMBEDDINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const duration = Date.now() - startTime;

        if (!response.ok) {
            const errorText = await response.text();
            error({
                message: 'LFM2 embedding API error',
                status: response.status,
                statusText: response.statusText,
                error: errorText,
                model,
                kind,
                duration,
            });
            return {
                error: true,
                message: `LFM2 API error: ${response.status} ${response.statusText}`,
            };
        }

        const responseData: ILFM2EmbeddingResponse | ILFM2EmbeddingError = await response.json();

        if ('error' in responseData) {
            error({
                message: 'LFM2 embedding returned error',
                error: responseData.error,
                model,
                kind,
                duration,
            });
            return { error: true, message: responseData.error.message };
        }

        const embedding = responseData.data[0]?.embedding;
        const result = normaliseEmbeddings(embedding, model);

        if (result.error) {
            return result;
        }

        debug({
            message: 'LFM2 embedding generated',
            model,
            kind,
            dim: embedding!.length,
            duration,
        });

        return {
            error: false,
            embedding,
            model,
            tokens: responseData.usage?.total_tokens,
        };
    } catch (err) {
        error({
            message: 'Error generating LFM2 embedding',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            model,
            kind,
        });
        return { error: true, message: 'Failed to generate embedding' };
    }
}

/**
 * Batch embedding helper. Accepts an array of texts and returns a
 * parallel array of L2-normalized 1024-dim vectors. Mirrors the
 * `generateEmbeddings(texts)` signature from the OpenRouter module.
 */
export async function generateEmbeddings(
    texts: string[],
    model: string = 'lfm2.5-embedding-350m',
    kind: LFM2EmbeddingKind = 'document',
): Promise<IBatchEmbeddingResult> {
    try {
        if (texts.length === 0) {
            return { error: true, message: 'No texts provided' };
        }

        if (texts.length === 1) {
            const result = await generateEmbedding(texts[0], model, kind);
            if (!result.error && result.embedding) {
                return {
                    error: false,
                    embeddings: [result.embedding],
                    model: result.model,
                    tokens: result.tokens,
                };
            }
            return result;
        }

        const startTime = Date.now();
        const requestBody: ILFM2EmbeddingRequest = {
            input: texts,
            model,
            kind,
        };

        const response = await fetchWithRetry(LFM2_EMBEDDINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const duration = Date.now() - startTime;

        if (!response.ok) {
            const errorText = await response.text();
            error({
                message: 'LFM2 batch embedding API error',
                status: response.status,
                statusText: response.statusText,
                error: errorText,
                model,
                kind,
                batchSize: texts.length,
                duration,
            });
            return {
                error: true,
                message: `LFM2 API error: ${response.status} ${response.statusText}`,
            };
        }

        const responseData: ILFM2EmbeddingResponse | ILFM2EmbeddingError = await response.json();

        if ('error' in responseData) {
            error({
                message: 'LFM2 batch embedding returned error',
                error: responseData.error,
                model,
                kind,
                batchSize: texts.length,
                duration,
            });
            return { error: true, message: responseData.error.message };
        }

        const embeddings = responseData.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);

        // Sanity-check the response shape: one vector per input.
        if (embeddings.length !== texts.length) {
            error({
                message: 'LFM2 batch embedding length mismatch',
                expected: texts.length,
                got: embeddings.length,
                model,
                kind,
            });
            return {
                error: true,
                message: `LFM2 returned ${embeddings.length} embeddings for ${texts.length} inputs`,
            };
        }

        return {
            error: false,
            embeddings,
            model,
            tokens: responseData.usage?.total_tokens,
        };
    } catch (err) {
        error({
            message: 'Error generating LFM2 batch embeddings',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            batchSize: texts.length,
            model,
            kind,
        });
        return { error: true, message: 'Failed to generate batch embeddings' };
    }
}

export const LFM2_EMBEDDING_DIM = 1024;
