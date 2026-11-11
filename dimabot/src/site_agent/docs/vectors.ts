/**
 * Semantic side of docs search. Each section is cut into chunks of ≤ ~1,600 chars (headings
 * prefixed) and embedded with the shared LFM2.5 service; a section scores as its best chunk.
 *
 * Vectors are cached in memory and in Dragonfly by content hash
 * (`site_agent:docs:vec:<lang>:<hash>`, 30 days), so restarts and docs deploys only embed chunks
 * whose text changed. The embeddings service is shared and memory-capped (it OOM-restarted on a
 * 32-item batch), so builds run in the background, one at a time across languages, in batches of
 * at most 8 with a pause between batches. Until a language is fully embedded, search is
 * keyword-only for it.
 */
import { generateEmbedding, generateEmbeddings, LFM2_EMBEDDING_DIM } from '../../utils/ai/lfm2_embeddings/index.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { debug, warn } from '../../utils/logger.js';
import type { Lang } from '../types.js';
import { getParsedDocs } from './source.js';
import { hashText, type DocsSection, type ParsedDocs } from './sections.js';

export const EMBEDDING_MODEL = 'lfm2.5-embedding-350m';
/** Bump when the chunk text format changes so old vectors are not reused. */
const EMBED_FORMAT = 'docs-chunk-v1';
export const CHUNK_CHARS = 1_600;
export const EMBED_BATCH_SIZE = 8;
const BATCH_PAUSE_MS = 250;
let batchPauseMs = BATCH_PAUSE_MS;
const VECTOR_TTL_SECONDS = 30 * 86_400;
const MGET_GROUP = 50;
/** After a failed build, wait this long before trying again. */
const BUILD_RETRY_MS = 60_000;
/** A query embedding slower than this falls back to keyword-only for that search. */
const QUERY_TIMEOUT_MS = 4_000;
/** After a failed query embedding, skip semantic search for this long. */
const QUERY_RETRY_MS = 30_000;
const QUERY_CACHE_MAX = 200;

export const docsVectorKey = (lang: Lang, hash: string) => `site_agent:docs:vec:${lang}:${hash}`;

export interface DocsChunk {
    /** Index into ParsedDocs.sections. */
    section: number;
    /** Dragonfly key (content hash of the embedded text). */
    key: string;
    text: string;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function splitLong(block: string, max: number): string[] {
    if (block.length <= max) return [block];
    const out: string[] = [];
    let current = '';
    const add = (part: string) => {
        if (current && current.length + 1 + part.length > max) { out.push(current); current = ''; }
        current = current ? `${current}\n${part}` : part;
    };
    for (const line of block.split('\n')) {
        if (!line) add('');
        for (let i = 0; i < line.length; i += max) add(line.slice(i, i + max));
    }
    if (current) out.push(current);
    return out;
}

/** Embedded texts for one section: `Page › Section › Subsection` + up to CHUNK_CHARS of body. */
export function chunkSection(section: DocsSection, max = CHUNK_CHARS): string[] {
    const base = section.level === 1 ? section.pageTitle : `${section.pageTitle} › ${section.heading}`;
    // Split at `###` subsections first so each chunk carries its own subheading.
    const cuts = [0, ...section.subsections.map((sub) => sub.offset).filter((offset) => offset > 0), section.text.length];
    const chunks: string[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const part = section.text.slice(cuts[i], cuts[i + 1]).trim();
        if (!part && chunks.length) continue;
        const sub = section.subsections.find((item) => item.offset === cuts[i] && cuts[i] > 0);
        const prefix = sub ? `${base} › ${sub.heading}` : base;
        let current = '';
        const flush = () => { if (current) chunks.push(`${prefix}\n\n${current}`); current = ''; };
        for (const paragraph of part.split(/\n{2,}/)) {
            for (const block of splitLong(paragraph, max)) {
                if (current && current.length + block.length + 2 > max) flush();
                current = current ? `${current}\n\n${block}` : block;
            }
        }
        flush();
        if (!part && !chunks.length) chunks.push(prefix);
    }
    return chunks;
}

export function buildChunks(parsed: ParsedDocs): DocsChunk[] {
    const chunks: DocsChunk[] = [];
    parsed.sections.forEach((section, index) => {
        for (const text of chunkSection(section)) {
            chunks.push({ section: index, key: docsVectorKey(parsed.lang, hashText(`${EMBEDDING_MODEL}|${EMBED_FORMAT}|${text}`, 24)), text });
        }
    });
    return chunks;
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

interface LangState {
    parsed: ParsedDocs | null;
    chunks: DocsChunk[];
    vectors: Map<string, Float32Array>;
    build: Promise<boolean> | null;
    failedAt: number;
}

const states = new Map<Lang, LangState>();
let queryFailedAt = 0;
const queryCache = new Map<string, Float32Array>();
/** Serializes embedding batches across languages: one request in flight at a time. */
let embedQueue: Promise<unknown> = Promise.resolve();

function stateFor(lang: Lang, parsed: ParsedDocs): LangState {
    let state = states.get(lang);
    if (!state) {
        state = { parsed: null, chunks: [], vectors: new Map(), build: null, failedAt: 0 };
        states.set(lang, state);
    }
    if (state.parsed !== parsed) {
        state.parsed = parsed;
        state.chunks = buildChunks(parsed);
        // Keep vectors of unchanged chunks; drop the rest.
        const live = new Set(state.chunks.map((chunk) => chunk.key));
        for (const key of state.vectors.keys()) if (!live.has(key)) state.vectors.delete(key);
    }
    return state;
}

function isReady(state: LangState): boolean {
    return state.chunks.length > 0 && state.chunks.every((chunk) => state.vectors.has(chunk.key));
}

function encodeVector(vector: Float32Array): string {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decodeVector(raw: string | null | undefined): Float32Array | null {
    if (!raw) return null;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.byteLength !== LFM2_EMBEDDING_DIM * 4) return null;
    // Copy into an aligned buffer.
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = embedQueue.then(task, task);
    embedQueue = run.catch(() => undefined);
    return run;
}

async function loadCached(state: LangState, keys: string[]): Promise<void> {
    try {
        const client = await getDragonflyClient('site-agent-docs');
        for (let i = 0; i < keys.length; i += MGET_GROUP) {
            const group = keys.slice(i, i + MGET_GROUP);
            const values = await client.mGet(group);
            group.forEach((key, index) => {
                const vector = decodeVector(values[index]);
                if (vector) state.vectors.set(key, vector);
            });
        }
    } catch {
        // Cache unavailable: embed what's missing.
    }
}

async function saveCached(entries: Array<[string, Float32Array]>): Promise<void> {
    try {
        const client = await getDragonflyClient('site-agent-docs');
        await Promise.all(entries.map(([key, vector]) => client.set(key, encodeVector(vector), { EX: VECTOR_TTL_SECONDS })));
    } catch {
        // The cache is an optimization.
    }
}

/** Embeds the chunks that have no vector yet. False only when the embeddings service failed. */
async function buildVectors(lang: Lang, state: LangState): Promise<boolean> {
    const missing = () => [...new Map(state.chunks.filter((chunk) => !state.vectors.has(chunk.key)).map((chunk) => [chunk.key, chunk])).values()];
    const cachedKeys = missing().map((chunk) => chunk.key);
    if (cachedKeys.length) await loadCached(state, cachedKeys);

    const todo = missing();
    for (let i = 0; i < todo.length; i += EMBED_BATCH_SIZE) {
        if (i > 0) await sleep(batchPauseMs);
        const batch = todo.slice(i, i + EMBED_BATCH_SIZE);
        const result = await enqueue(() => generateEmbeddings(batch.map((chunk) => chunk.text), EMBEDDING_MODEL, 'document'));
        const embeddings = result.error ? null : result.embeddings;
        if (!embeddings || embeddings.length !== batch.length || embeddings.some((vector) => vector?.length !== LFM2_EMBEDDING_DIM)) {
            void warn({ function: 'siteAgent.docs.buildVectors', message: 'Docs embedding batch failed; keyword search only for now', lang, done: i, total: todo.length, error: result.message }, { destination: 'console' });
            return false;
        }
        const entries = batch.map((chunk, index) => [chunk.key, Float32Array.from(embeddings[index])] as [string, Float32Array]);
        for (const [key, vector] of entries) state.vectors.set(key, vector);
        await saveCached(entries);
    }
    if (todo.length) {
        void debug({ function: 'siteAgent.docs.buildVectors', message: `Docs vectors built (${lang}: ${state.chunks.length} chunks, ${todo.length} embedded)` }, { destination: 'console' });
    }
    return true;
}

/**
 * Makes sure every chunk of the current docs has a vector. Never throws; true when semantic search
 * is ready. One build per language at a time; a failed build waits a minute before the next try.
 */
export async function ensureDocsVectors(lang: Lang): Promise<boolean> {
    let parsed: ParsedDocs;
    try {
        parsed = await getParsedDocs(lang);
    } catch {
        return false;
    }
    const state = stateFor(lang, parsed);
    if (isReady(state)) return true;
    if (state.build) return state.build;
    if (Date.now() - state.failedAt < BUILD_RETRY_MS) return false;
    state.build = buildVectors(lang, state)
        .catch(() => false)
        .then((ok) => {
            if (!ok) state.failedAt = Date.now();
            // The docs may have changed during the build; the next call embeds the rest.
            return ok && isReady(state);
        })
        .finally(() => { state.build = null; });
    return state.build;
}

async function embedQuery(query: string): Promise<Float32Array | null> {
    const cached = queryCache.get(query);
    if (cached) return cached;
    if (Date.now() - queryFailedAt < QUERY_RETRY_MS) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), QUERY_TIMEOUT_MS); });
    try {
        const result = await Promise.race([generateEmbedding(query, EMBEDDING_MODEL, 'query'), timeout]);
        if (!result || result.error || result.embedding?.length !== LFM2_EMBEDDING_DIM) {
            queryFailedAt = Date.now();
            return null;
        }
        const vector = Float32Array.from(result.embedding);
        if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value!);
        queryCache.set(query, vector);
        return vector;
    } catch {
        queryFailedAt = Date.now();
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Cosine similarity of the query to each section (best chunk), or null when vectors are still
 * warming up or the embeddings service fails (keyword-only search). Starts a build if needed.
 */
export async function semanticScores(parsed: ParsedDocs, query: string): Promise<Float64Array | null> {
    const state = states.get(parsed.lang);
    // Only ensureDocsVectors moves a language to newer docs (it always loads the latest parse).
    if (!state || state.parsed !== parsed || !isReady(state)) {
        void ensureDocsVectors(parsed.lang);
        return null;
    }
    const chunks = state.chunks;
    const queryVector = await embedQuery(query);
    if (!queryVector || state.parsed !== parsed) return null;
    const scores = new Float64Array(parsed.sections.length).fill(-Infinity);
    for (const chunk of chunks) {
        const vector = state.vectors.get(chunk.key);
        if (!vector) return null;
        let dot = 0;
        // The service L2-normalizes vectors, so the dot product is the cosine.
        for (let d = 0; d < vector.length; d++) dot += vector[d] * queryVector[d];
        if (dot > scores[chunk.section]) scores[chunk.section] = dot;
    }
    return scores;
}

/** Whether semantic search is ready for a language (for status/tests). */
export function docsVectorsReady(lang: Lang): boolean {
    const state = states.get(lang);
    return Boolean(state && isReady(state));
}

/** Test helper: forget all vectors (like a restart); optionally shorten the pause between batches. */
export function resetDocsVectors(opts: { pauseMs?: number } = {}): void {
    states.clear();
    queryCache.clear();
    queryFailedAt = 0;
    embedQueue = Promise.resolve();
    batchPauseMs = opts.pauseMs ?? BATCH_PAUSE_MS;
}
