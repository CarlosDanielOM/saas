/**
 * Docs index for the system prompt: every page (path, title, size, one-line description) with its
 * section anchors, within INDEX_TOKEN_BUDGET. It sits in the cached prompt prefix, so the output
 * is byte-identical for the same docs (no dates, no ordering from maps or timing).
 *
 * Over budget: drop `###` lists first, then the section lists of the largest pages; page lines
 * always stay (descriptions are shortened only as a last resort).
 */
import { warn } from '../../utils/logger.js';
import type { Lang } from '../types.js';
import { hashText, INTRO_ANCHOR, type DocsPageInfo, type ParsedDocs } from './sections.js';
import { getDocsDescriptions, getParsedDocs } from './source.js';

export const INDEX_TOKEN_BUDGET = 10_000;

/**
 * Stricter than the chars/4 used for sections: the index is mostly ids and short phrases, which
 * tokenize denser than prose (e.g. `set-up-the-speech-overlay` ≈ 8 tokens for 25 chars).
 */
export function estimateIndexTokens(text: string): number {
    return Math.ceil(text.length / 3);
}

export type IndexDetail = 'full' | 'no-subsections' | 'partial-sections' | 'pages-only' | 'short-descriptions';

export interface DocsPromptIndex {
    text: string;
    tokens: number;
    detail: IndexDetail;
}

function formatTokens(tokens: number): string {
    return tokens < 1000 ? `~${Math.max(10, Math.round(tokens / 10) * 10)}` : `~${(tokens / 1000).toFixed(1)}k`;
}

function shorten(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.lastIndexOf(' ', max - 1);
    return `${text.slice(0, cut > max / 2 ? cut : max - 1).replace(/[\s,;:.]+$/, '')}…`;
}

interface RenderOptions { subsections: boolean; withoutSections: Set<string>; descriptionMax: number }

function renderPage(page: DocsPageInfo, description: string, opts: RenderOptions): string {
    const sections = page.sections.filter((section) => section.anchor !== INTRO_ANCHOR);
    const desc = shorten(description.replace(/\s+/g, ' ').trim(), opts.descriptionMax);
    const head = `${page.id} | ${page.title} | ${formatTokens(page.tokens)}${desc ? ` | ${desc}` : ''}`;
    if (!sections.length) return head;
    if (opts.withoutSections.has(page.id)) return `${head} [${sections.length} sections]`;
    const list = sections.map((section) => {
        const subs = opts.subsections ? section.subsections.map((sub) => sub.anchor) : [];
        return subs.length ? `#${section.anchor}(${subs.join(' ')})` : `#${section.anchor}`;
    });
    return `${head}\n  ${list.join(' ')}`;
}

function render(parsed: ParsedDocs, descriptions: Map<string, string>, opts: RenderOptions): string {
    const header = [
        `Docs index (${parsed.lang}, ${parsed.pages.length} pages). Line format: path | title | size in tokens | description, then its section anchors.`,
        'Section id = path + anchor (e.g. /tts#choose-a-voice-engine); anchors in parentheses are subsections (also readable ids).',
        'read_docs reads a section id, or a path for the whole page; search_docs finds sections by topic.',
    ].join('\n');
    const pages = parsed.pages.map((page) => renderPage(page, descriptions.get(page.id) ?? page.description, opts));
    return `${header}\n\n${pages.join('\n')}\n`;
}

/** Pure builder (exported for tests). */
export function buildDocsPromptIndex(parsed: ParsedDocs, descriptions: Map<string, string> = new Map(), budget = INDEX_TOKEN_BUDGET): DocsPromptIndex {
    const opts: RenderOptions = { subsections: true, withoutSections: new Set(), descriptionMax: 400 };
    const fits = (text: string) => estimateIndexTokens(text) <= budget;
    const done = (text: string, detail: IndexDetail): DocsPromptIndex => ({ text, tokens: estimateIndexTokens(text), detail });

    let text = render(parsed, descriptions, opts);
    if (fits(text)) return done(text, 'full');

    opts.subsections = false;
    text = render(parsed, descriptions, opts);
    if (fits(text)) return done(text, 'no-subsections');

    // Largest pages lose their section lists first (ties: path order, so it's deterministic).
    const bySize = parsed.pages.slice().sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1));
    for (const page of bySize) {
        opts.withoutSections.add(page.id);
        text = render(parsed, descriptions, opts);
        if (fits(text)) return done(text, opts.withoutSections.size === parsed.pages.length ? 'pages-only' : 'partial-sections');
    }

    for (const max of [160, 100, 60]) {
        opts.descriptionMax = max;
        text = render(parsed, descriptions, opts);
        if (fits(text)) return done(text, 'short-descriptions');
    }
    // Page lines are always kept, even over budget.
    return done(text, 'short-descriptions');
}

const memo = new Map<Lang, { key: string; index: DocsPromptIndex }>();

/** The index for the system prompt (≤ 10k tokens). Falls back to one line if the docs never loaded. */
export async function getDocsPromptIndex(lang: Lang): Promise<string> {
    let parsed: ParsedDocs;
    try {
        parsed = await getParsedDocs(lang);
    } catch (err) {
        void warn({ function: 'siteAgent.docs.getDocsPromptIndex', message: 'Docs unavailable for the prompt index', lang, error: err instanceof Error ? err.message : String(err) }, { destination: 'console' });
        return 'Docs index unavailable right now. Use search_docs to find docs sections.\n';
    }
    const descriptions = await getDocsDescriptions(lang);
    const key = `${parsed.sourceHash}|${hashText(JSON.stringify([...descriptions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`;
    const cached = memo.get(lang);
    if (cached?.key === key) return cached.index.text;
    const index = buildDocsPromptIndex(parsed, descriptions);
    if (index.tokens > INDEX_TOKEN_BUDGET) {
        void warn({ function: 'siteAgent.docs.getDocsPromptIndex', message: 'Docs index is over budget even with page lines only', lang, tokens: index.tokens }, { destination: 'console' });
    }
    memo.set(lang, { key, index });
    return index.text;
}

/** Test helper. */
export function clearDocsPromptIndexCache(): void {
    memo.clear();
}
