/**
 * Parsed docs per language, rebuilt only when the export text changes, plus the page descriptions
 * from the docs indexes (`llms.txt`, `/es/llms.txt`).
 *
 * The export itself comes from the docs assistant's loader (5-minute cache, last good copy on
 * failure); it hands back the same object until it refreshes, so most calls skip even the hash.
 */
import { getDocsCorpus, type DocsCorpus } from '../../utils/ai/docs_assistant/docs_source.js';
import { warn } from '../../utils/logger.js';
import type { Lang } from '../types.js';
import { hashText, pageIdFromUrl, parseDocsExport, type ParsedDocs } from './sections.js';

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const parsedCache = new Map<Lang, { corpus: DocsCorpus; parsed: ParsedDocs }>();

export async function getParsedDocs(lang: Lang): Promise<ParsedDocs> {
    const corpus = await getDocsCorpus(lang);
    const cached = parsedCache.get(lang);
    if (cached?.corpus === corpus) return cached.parsed;
    if (cached && hashText(corpus.text, 24) === cached.parsed.sourceHash) {
        cached.corpus = corpus;
        return cached.parsed;
    }
    const parsed = parseDocsExport(lang, corpus.text);
    parsedCache.set(lang, { corpus, parsed });
    return parsed;
}

/** Last parsed docs without waiting (null before the first load). For status labels. */
export function peekParsedDocs(lang: Lang): ParsedDocs | null {
    return parsedCache.get(lang)?.parsed ?? null;
}

// ---------------------------------------------------------------------------
// llms.txt descriptions
// ---------------------------------------------------------------------------

interface DescriptionsEntry { descriptions: Map<string, string>; fetchedAt: number }

const descriptionCache = new Map<Lang, DescriptionsEntry>();
const descriptionInflight = new Map<Lang, Promise<DescriptionsEntry>>();

function sourceBase(): string {
    // Same override as the docs export loader (isolated tests only).
    return (process.env.DOCS_ASSISTANT_SOURCE_URL || 'http://dimadocs').replace(/\/+$/, '');
}

/** `- [Title](https://docs.domdimabot.com/tts/index.txt): Description` → page id → description. */
export function parseLlmsIndex(text: string): Map<string, string> {
    const descriptions = new Map<string, string>();
    for (const match of text.matchAll(/^- \[[^\]]+\]\((https:\/\/docs\.domdimabot\.com\/\S*?)\)(?::\s*(.+))?$/gm)) {
        const description = (match[2] ?? '').trim();
        if (description && !descriptions.has(pageIdFromUrl(match[1]))) descriptions.set(pageIdFromUrl(match[1]), description);
    }
    return descriptions;
}

async function downloadDescriptions(lang: Lang): Promise<DescriptionsEntry> {
    const response = await fetch(`${sourceBase()}/${lang === 'es' ? 'es/' : ''}llms.txt`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Docs index returned ${response.status}`);
    const descriptions = parseLlmsIndex(await response.text());
    if (descriptions.size === 0) throw new Error('Docs index has no pages');
    return { descriptions, fetchedAt: Date.now() };
}

/**
 * Page id → one-line description from llms.txt. Never throws: on failure it keeps the last good
 * copy, or returns an empty map (callers fall back to the description in the export, which is
 * the same text today).
 */
export async function getDocsDescriptions(lang: Lang): Promise<Map<string, string>> {
    const cached = descriptionCache.get(lang);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.descriptions;
    let pending = descriptionInflight.get(lang);
    if (!pending) {
        pending = downloadDescriptions(lang)
            .then((entry) => { descriptionCache.set(lang, entry); return entry; })
            .finally(() => descriptionInflight.delete(lang));
        descriptionInflight.set(lang, pending);
    }
    try {
        return (await pending).descriptions;
    } catch (err) {
        void warn({
            function: 'siteAgent.docs.getDocsDescriptions', message: 'Docs index (llms.txt) refresh failed',
            lang, hasCopy: Boolean(cached), error: err instanceof Error ? err.message : String(err),
        }, { destination: 'console' });
        // Try again in 30 s rather than on every call.
        const kept = cached ?? { descriptions: new Map<string, string>(), fetchedAt: 0 };
        kept.fetchedAt = Date.now() - CACHE_MS + 30_000;
        descriptionCache.set(lang, kept);
        return kept.descriptions;
    }
}

/** Test helper. */
export function clearParsedDocsCache(): void {
    parsedCache.clear();
    descriptionCache.clear();
    descriptionInflight.clear();
}
