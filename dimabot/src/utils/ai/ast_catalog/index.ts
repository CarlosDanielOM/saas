import catalogJson from './ast-catalog.json' with { type: 'json' };
import type { AstCatalog, AstCatalogEntry } from './types.js';
import { buildEntryEmbeddingText } from './build_catalog.js';
import { generateEmbedding, generateEmbeddings, LFM2_EMBEDDING_DIM } from '../lfm2_embeddings/index.js';
import { debug, error } from '../../logger.js';

const catalog = catalogJson as unknown as AstCatalog;

export interface AstCatalogSearchOptions {
    /** Which consumer is searching. Defaults to 'action' (chat AI). */
    surface?: 'action' | 'authoring';
    /** Hide entries that require a higher user level. Defaults to 1. */
    maxUserLevel?: number;
    /** Max matches to return. Defaults to 3. */
    limit?: number;
}

export interface AstCatalogSearchResult {
    matches: AstCatalogEntry[];
    vectorSearchUsed: boolean;
}

const entries = catalog.entries;
const nameIndex = new Map<string, AstCatalogEntry>();
for (const entry of entries) {
    nameIndex.set(entry.name.toLowerCase(), entry);
    for (const alias of entry.aliases) {
        nameIndex.set(alias.toLowerCase(), entry);
    }
}

let vectors: Float32Array[] | null = null;
let vectorBuildPromise: Promise<boolean> | null = null;
let lastFailedAttempt = 0;
const RETRY_INTERVAL_MS = 30_000;
const BATCH_SIZE = 32;

function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

async function buildVectors(): Promise<boolean> {
    const texts = entries.map((entry) => buildEntryEmbeddingText(entry));
    const collected: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const result = await generateEmbeddings(batch, catalog.model || undefined, 'document');
        if (result.error || !result.embeddings || result.embeddings.length !== batch.length) {
            return false;
        }
        collected.push(...result.embeddings);
    }

    vectors = collected.map((embedding) => Float32Array.from(embedding));
    return true;
}

/**
 * Builds the in-memory vector index lazily. Never throws. Returns true when
 * the vector index is ready, false when only keyword matching is available.
 * Failed attempts are retried at most once per RETRY_INTERVAL_MS.
 */
export function ensureAstCatalogVectors(): Promise<boolean> {
    if (vectors && vectors.length === entries.length) {
        return Promise.resolve(true);
    }
    if (vectorBuildPromise) {
        return vectorBuildPromise;
    }
    if (Date.now() - lastFailedAttempt < RETRY_INTERVAL_MS) {
        return Promise.resolve(false);
    }

    vectorBuildPromise = buildVectors()
        .then((ok) => {
            if (ok) {
                debug({
                    function: 'astCatalog.ensureVectors',
                    message: `AST catalog vector index ready (${entries.length} entries, dim ${LFM2_EMBEDDING_DIM})`
                }, { destination: 'console' });
            } else {
                lastFailedAttempt = Date.now();
                error({
                    function: 'astCatalog.ensureVectors',
                    message: 'AST catalog embedding failed; falling back to keyword search'
                }, { destination: 'console' });
            }
            return ok;
        })
        .catch((err) => {
            lastFailedAttempt = Date.now();
            error({
                function: 'astCatalog.ensureVectors',
                message: 'AST catalog embedding threw; falling back to keyword search',
                error: err instanceof Error ? err.message : String(err)
            }, { destination: 'console' });
            return false;
        })
        .finally(() => {
            vectorBuildPromise = null;
        });

    return vectorBuildPromise;
}

export function getAstCatalog(): AstCatalog {
    return catalog;
}

function normalizeLookup(raw: string): string {
    let text = raw.trim().toLowerCase();
    if (text.startsWith('$(') && text.endsWith(')')) {
        text = text.slice(2, -1).trim();
    }
    return text.split(/\s+/)[0] ?? '';
}

/** Exact lookup by canonical name or alias. Returns undefined when unknown. */
export function findAstCatalogEntry(name: string): AstCatalogEntry | undefined {
    return nameIndex.get(normalizeLookup(name));
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordHits(entry: AstCatalogEntry, query: string): number {
    let hits = 0;
    for (const keyword of entry.keywords) {
        if (!keyword) continue;
        const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
        if (pattern.test(query)) {
            hits++;
        }
    }
    return hits;
}

/**
 * Hybrid search: exact name > name containment > keyword overlap > cosine.
 * Works with or without the vector index (keyword-only fallback).
 */
export async function searchAstCatalog(
    rawQuery: string,
    options: AstCatalogSearchOptions = {}
): Promise<AstCatalogSearchResult> {
    const surface = options.surface ?? 'action';
    const maxUserLevel = options.maxUserLevel ?? 1;
    const limit = Math.max(1, Math.min(10, options.limit ?? 3));
    const query = rawQuery.trim().toLowerCase();

    if (!query) {
        return { matches: [], vectorSearchUsed: false };
    }

    const candidates = entries.filter(
        (entry) => entry.surfaces.includes(surface) && entry.minUserLevel <= maxUserLevel
    );

    const exact = nameIndex.get(normalizeLookup(rawQuery));
    if (exact && candidates.includes(exact)) {
        return { matches: [exact], vectorSearchUsed: Boolean(vectors) };
    }

    const vectorsReady = vectors && vectors.length === entries.length;
    let queryVector: Float32Array | null = null;

    if (vectorsReady) {
        const embeddingResult = await generateEmbedding(rawQuery, catalog.model || undefined, 'query');
        if (!embeddingResult.error && embeddingResult.embedding) {
            queryVector = Float32Array.from(embeddingResult.embedding);
        }
    }

    const scored = candidates.map((entry) => {
        const entryIndex = entries.indexOf(entry);
        const name = entry.name.toLowerCase();

        let score = 0;
        if (name === query || entry.aliases.some((alias) => alias.toLowerCase() === query)) {
            score += 100;
        }
        if (query.length >= 4 && query.includes(name)) {
            score += 10;
        }
        score += Math.min(keywordHits(entry, query), 4) * 2;
        if (queryVector && vectors && vectors[entryIndex]) {
            score += cosine(queryVector, vectors[entryIndex]);
        }

        return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    const matches = scored
        .filter((item) => item.score > 0)
        .slice(0, limit)
        .map((item) => item.entry);

    return { matches, vectorSearchUsed: Boolean(queryVector) };
}
