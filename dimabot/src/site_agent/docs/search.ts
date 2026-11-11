/**
 * Hybrid docs search: BM25F keyword ranking + embedding similarity, fused with reciprocal rank
 * fusion. Keyword-only (`semantic: false`) while the vectors warm up or the embeddings service
 * fails. If the requested language has no keyword match at all, the other language is tried.
 */
import type { Lang } from '../types.js';
import { KeywordIndex, makeSnippet, queryTerms, type KeywordHit } from './keyword.js';
import { INTRO_ANCHOR, type DocsSection, type ParsedDocs } from './sections.js';
import { getParsedDocs } from './source.js';
import { semanticScores } from './vectors.js';

export const RRF_K = 60;
/** How deep each ranking goes into the fusion. */
const FUSION_DEPTH = 40;
export const MAX_SEARCH_LIMIT = 10;

export interface DocsSearchResult {
    id: string;
    /** Page title. */
    page: string;
    /** Section heading (the page title for the page intro). */
    section: string;
    url: string;
    snippet: string;
    tokens: number;
}

export interface DocsSearchResponse {
    results: DocsSearchResult[];
    /** Language the results are in (the other one when the requested language had no match). */
    lang: Lang;
    semantic: boolean;
}

const keywordIndexes = new WeakMap<ParsedDocs, KeywordIndex>();

export function keywordIndexFor(parsed: ParsedDocs): KeywordIndex {
    let index = keywordIndexes.get(parsed);
    if (!index) {
        index = new KeywordIndex(parsed.sections);
        keywordIndexes.set(parsed, index);
    }
    return index;
}

/** Reciprocal rank fusion of rankings (lists of item ids, best first). Ties keep first-list order. */
export function reciprocalRankFusion(rankings: readonly (readonly number[])[], k = RRF_K): Array<{ index: number; score: number }> {
    const scores = new Map<number, { score: number; first: number }>();
    rankings.forEach((ranking, list) => {
        ranking.forEach((index, rank) => {
            const entry = scores.get(index) ?? { score: 0, first: list * 1e6 + rank };
            entry.score += 1 / (k + rank + 1);
            scores.set(index, entry);
        });
    });
    return [...scores.entries()]
        .sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first)
        .map(([index, entry]) => ({ index, score: entry.score }));
}

export function sectionUrl(section: DocsSection): string {
    return section.anchor === INTRO_ANCHOR ? section.pageUrl : `${section.pageUrl}#${section.anchor}`;
}

function toResult(section: DocsSection, terms: string[], index: KeywordIndex): DocsSearchResult {
    return {
        id: section.id,
        page: section.pageTitle,
        section: section.heading,
        url: sectionUrl(section),
        snippet: makeSnippet(section.text, terms, (term) => index.idf(term)),
        tokens: section.tokens,
    };
}

interface Ranked { keyword: KeywordHit[]; order: number[]; semantic: boolean }

async function rank(parsed: ParsedDocs, query: string, useSemantic: boolean): Promise<Ranked> {
    const index = keywordIndexFor(parsed);
    const keyword = index.search(query, FUSION_DEPTH);
    const scores = useSemantic ? await semanticScores(parsed, query) : null;
    if (!scores) return { keyword, order: keyword.map((hit) => hit.index), semantic: false };
    const semanticOrder = [...scores.keys()].filter((i) => Number.isFinite(scores[i])).sort((a, b) => scores[b] - scores[a] || a - b).slice(0, FUSION_DEPTH);
    const fused = reciprocalRankFusion([keyword.map((hit) => hit.index), semanticOrder]);
    return { keyword, order: fused.map((item) => item.index), semantic: true };
}

/** Search one parsed language (no fallback). Exposed for tests and offline evaluation. */
export async function searchParsedDocs(parsed: ParsedDocs, query: string, limit: number, opts: { semantic?: boolean } = {}): Promise<DocsSearchResponse & { keywordMatches: number }> {
    const ranked = await rank(parsed, query, opts.semantic !== false);
    const index = keywordIndexFor(parsed);
    const terms = queryTerms(query).map((item) => item.term);
    return {
        results: ranked.order.slice(0, limit).map((i) => toResult(parsed.sections[i], terms, index)),
        lang: parsed.lang,
        semantic: ranked.semantic,
        keywordMatches: ranked.keyword.length,
    };
}

export interface SearchDocsInput {
    query: string;
    lang: Lang;
    /** 1–10, default 5. */
    limit?: number;
}

/** Throws only when the docs have never loaded (no copy at all). */
export async function searchDocs({ query, lang, limit = 5 }: SearchDocsInput): Promise<DocsSearchResponse> {
    const size = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit) || 5));
    const primary = await searchParsedDocs(await getParsedDocs(lang), query, size);
    if (primary.keywordMatches > 0) return strip(primary);

    // Nothing matched by keyword in this language: the question may be in the other language.
    const other: Lang = lang === 'en' ? 'es' : 'en';
    try {
        const fallback = await searchParsedDocs(await getParsedDocs(other), query, size);
        if (fallback.keywordMatches > 0) return strip(fallback);
    } catch {
        // Other language unavailable: keep the primary results.
    }
    return strip(primary);
}

function strip(response: DocsSearchResponse & { keywordMatches: number }): DocsSearchResponse {
    return { results: response.results, lang: response.lang, semantic: response.semantic };
}
