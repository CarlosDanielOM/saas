/**
 * Reads one docs section (or `###` subsection), or a whole page ("topic"), paged at about 12k
 * tokens so a large page never floods the context.
 */
import type { Lang } from '../types.js';
import { fold } from './keyword.js';
import { estimateTokens, INTRO_ANCHOR, langFromId, normalizeDocsId, subsectionText, type DocsPageInfo, type ParsedDocs } from './sections.js';
import { sectionUrl } from './search.js';
import { getParsedDocs } from './source.js';

export const READ_PAGE_TOKENS = 12_000;
const READ_PAGE_CHARS = READ_PAGE_TOKENS * 4;

export type DocsReadScope = 'section' | 'topic';

export interface ReadDocsInput {
    id: string;
    /** Default: 'section' when the id has an anchor, 'topic' when it is a page path. */
    scope?: DocsReadScope;
    /** Used only when the id doesn't say (ids under /es/ are Spanish). */
    lang?: Lang;
    /** 1-based page of a long result. */
    page?: number;
    /**
     * Cap for the whole JSON result in bytes (e.g. the runner's tool result limit). Pages shrink to
     * fit it; without it a page holds about READ_PAGE_TOKENS tokens.
     */
    maxBytes?: number;
}

export interface DocsReadSuccess {
    id: string;
    scope: DocsReadScope;
    lang: Lang;
    /** Page title. */
    title: string;
    /** Section heading (section scope only). */
    section?: string;
    /** For a `###` subsection: the `##` section it belongs to. */
    parent?: string;
    url: string;
    text: string;
    tokens: number;
    /** Topic scope: the page's sections, to read one at a time. */
    sections?: Array<{ id: string; heading: string; tokens: number }>;
    /** Subsections inside this section. */
    subsections?: string[];
    page: number;
    pages: number;
    nextPage?: number;
}

export interface DocsReadError {
    error: 'not_found' | 'page_out_of_range';
    message: string;
    closest?: string[];
}

export type DocsReadResult = DocsReadSuccess | DocsReadError;

/**
 * Splits text into pages of at most `maxChars` (and at most `maxJsonBytes` once JSON-encoded, when
 * the caller has a byte cap), preferring `##` boundaries, then blank lines, then line breaks.
 * Deterministic.
 */
export function paginate(text: string, maxChars = READ_PAGE_CHARS, maxJsonBytes = Infinity): string[] {
    const fits = (part: string) => part.length <= maxChars && (maxJsonBytes === Infinity || Buffer.byteLength(JSON.stringify(part)) <= maxJsonBytes);
    if (fits(text)) return [text];
    const pages: string[] = [];
    let rest = text;
    while (!fits(rest)) {
        let limit = Math.min(maxChars, rest.length);
        while (limit > 500 && !fits(rest.slice(0, limit))) limit = Math.floor(limit * 0.9);
        const window = rest.slice(0, limit + 1);
        let cut = window.lastIndexOf('\n## ');
        if (cut < limit / 2) cut = window.lastIndexOf('\n\n');
        if (cut < limit / 2) cut = window.lastIndexOf('\n');
        if (cut < limit / 2) cut = limit;
        pages.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest.trim()) pages.push(rest.trim());
    return pages;
}

export function topicText(page: DocsPageInfo): string {
    return page.sections.map((section) => (section.level === 1 ? section.text : `## ${section.heading}\n\n${section.text}`)).join('\n\n').trim();
}

function bigrams(text: string): Set<string> {
    const value = fold(text).replace(/[^a-z0-9/#]+/g, ' ');
    const grams = new Set<string>();
    for (let i = 0; i < value.length - 1; i++) grams.add(value.slice(i, i + 2));
    return grams;
}

function similarity(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared++;
    return (2 * shared) / (a.size + b.size);
}

/** Ids that look like the one asked for: the page's own sections first, then similar ids. */
export function closestIds(parsed: ParsedDocs, id: string, limit = 8): string[] {
    const [pageId] = id.split('#');
    const page = parsed.pageById.get(pageId);
    if (page) return [page.id, ...page.sections.filter((section) => section.level === 2).map((section) => section.id)].slice(0, limit + 4);
    const wanted = bigrams(id);
    const candidates = [...parsed.pageById.keys(), ...parsed.sectionById.keys()];
    return candidates
        .map((candidate) => ({ candidate, score: similarity(wanted, bigrams(candidate)) }))
        .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
        .slice(0, limit)
        .map((item) => item.candidate);
}

/** Bytes left for the text once the rest of the result is JSON-encoded (page numbers padded). */
function textBudget(maxBytes: number | undefined, meta: object): number {
    if (maxBytes === undefined) return Infinity;
    const overhead = Buffer.byteLength(JSON.stringify({ ...meta, text: '', tokens: 99_999, page: 999, pages: 999, nextPage: 999 }));
    return Math.max(1_000, maxBytes - overhead);
}

function paged(text: string, requested: number | undefined, budget = Infinity): { text: string; page: number; pages: number; nextPage?: number } | DocsReadError {
    const pages = paginate(text, READ_PAGE_CHARS, budget);
    const page = requested ?? 1;
    if (page < 1 || page > pages.length) {
        return { error: 'page_out_of_range', message: `This result has ${pages.length} page${pages.length === 1 ? '' : 's'}.` };
    }
    return { text: pages[page - 1], page, pages: pages.length, ...(page < pages.length ? { nextPage: page + 1 } : {}) };
}

export function readParsedDocs(parsed: ParsedDocs, input: ReadDocsInput): DocsReadResult {
    const id = normalizeDocsId(input.id);
    const [pageId, anchor] = id.split('#');
    const scope: DocsReadScope = input.scope ?? (anchor ? 'section' : 'topic');

    if (scope === 'topic' || !anchor) {
        const page = parsed.pageById.get(pageId);
        if (!page) return { error: 'not_found', message: `No docs page "${pageId}". Use a page path or section id from search_docs or the docs index.`, closest: closestIds(parsed, id) };
        const meta = {
            id: page.id,
            scope: 'topic' as const,
            lang: parsed.lang,
            title: page.title,
            url: page.url,
            sections: page.sections.map((section) => ({ id: section.id, heading: section.heading, tokens: section.tokens })),
        };
        const part = paged(topicText(page), input.page, textBudget(input.maxBytes, meta));
        if ('error' in part) return part;
        return { ...meta, ...part, tokens: estimateTokens(part.text) };
    }

    const section = parsed.sectionById.get(id);
    if (section) {
        const meta = {
            id: section.id,
            scope: 'section' as const,
            lang: parsed.lang,
            title: section.pageTitle,
            section: section.heading,
            url: sectionUrl(section),
            ...(section.subsections.length ? { subsections: section.subsections.map((sub) => sub.id) } : {}),
        };
        const part = paged(section.text, input.page, textBudget(input.maxBytes, meta));
        if ('error' in part) return part;
        return { ...meta, ...part, tokens: estimateTokens(part.text) };
    }

    const sub = parsed.subsectionById.get(id);
    if (sub) {
        const meta = {
            id: sub.subsection.id,
            scope: 'section' as const,
            lang: parsed.lang,
            title: sub.section.pageTitle,
            section: sub.subsection.heading,
            parent: sub.section.id,
            url: `${sub.section.pageUrl}#${sub.subsection.anchor}`,
        };
        const part = paged(subsectionText(sub.section, sub.subsection), input.page, textBudget(input.maxBytes, meta));
        if ('error' in part) return part;
        return { ...meta, ...part, tokens: estimateTokens(part.text) };
    }

    const hint = anchor === INTRO_ANCHOR ? '' : ' Section ids come from search_docs, the docs index, or the "sections" list of a topic read.';
    return { error: 'not_found', message: `No docs section "${id}".${hint}`, closest: closestIds(parsed, id) };
}

/** `/tts` ↔ `/es/tts` (same page in the other language). */
function otherLanguageId(id: string, to: Lang): string {
    const [pageId, anchor] = id.split('#');
    const path = pageId === '/es' ? '/' : pageId.replace(/^\/es(?=\/)/, '');
    const target = to === 'es' ? (path === '/' ? '/es' : `/es${path}`) : path;
    return anchor ? `${target}#${anchor}` : target;
}

/**
 * Throws only when the docs have never loaded. The id's prefix decides the language (`/es/…` is
 * Spanish); `lang` is the fallback when the id isn't found there, e.g. `/tts#elegir-un-motor-de-voz`
 * with lang 'es' resolves to `/es/tts#elegir-un-motor-de-voz`.
 */
export async function readDocs(input: ReadDocsInput): Promise<DocsReadResult> {
    const id = normalizeDocsId(input.id);
    const idLang = langFromId(id);
    const result = readParsedDocs(await getParsedDocs(idLang), { ...input, id });
    if (!('error' in result) || result.error !== 'not_found' || !input.lang || input.lang === idLang) return result;
    try {
        const other = readParsedDocs(await getParsedDocs(input.lang), { ...input, id: otherLanguageId(id, input.lang) });
        return 'error' in other ? result : other;
    } catch {
        return result;
    }
}
