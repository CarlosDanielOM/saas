/**
 * Loads the published docs (the docs site's own `llms-full.txt` export) for the docs assistant.
 *
 * The API reads them from the docs container on the shared Docker network, so every
 * docs deploy reaches the assistant within CACHE_MS without copying files around.
 * A failed refresh keeps serving the last good copy.
 */
import { warn } from '../../logger.js';

export type DocsLanguage = 'en' | 'es';

export const DOCS_SITE = 'https://docs.domdimabot.com';
const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface DocsPage {
    title: string;
    url: string;
}

export interface DocsCorpus {
    language: DocsLanguage;
    text: string;
    /** Canonical page URL → title. */
    pages: Map<string, DocsPage>;
    fetchedAt: number;
}

const cache = new Map<DocsLanguage, DocsCorpus>();
const inflight = new Map<DocsLanguage, Promise<DocsCorpus>>();

function sourceBase(): string {
    // Override only for isolated tests; production reads the docs container directly.
    return (process.env.DOCS_ASSISTANT_SOURCE_URL || 'http://dimadocs').replace(/\/+$/, '');
}

/** Turn `https://docs.domdimabot.com/tts/index.txt` into the page URL `https://docs.domdimabot.com/tts/`. */
export function toPageUrl(url: string): string {
    return url.replace(/\/index\.txt(?=$|[#?])/, '/');
}

export function parseCorpus(language: DocsLanguage, raw: string, fetchedAt = Date.now()): DocsCorpus {
    // Point internal links at the HTML pages so the model cites pages people can read.
    const text = raw.replace(/https:\/\/docs\.domdimabot\.com\/((?:[\w-]+\/)*)index\.txt/g, `${DOCS_SITE}/$1`);
    const pages = new Map<string, DocsPage>();
    const lines = text.split('\n');
    let title = '';
    for (const line of lines) {
        if (line.startsWith('# ')) title = line.slice(2).trim();
        const match = /^Source: (https:\/\/docs\.domdimabot\.com\/\S*)$/.exec(line);
        if (match && title) pages.set(match[1], { title, url: match[1] });
    }
    return { language, text, pages, fetchedAt };
}

async function download(language: DocsLanguage): Promise<DocsCorpus> {
    const url = `${sourceBase()}/${language === 'es' ? 'es/' : ''}llms-full.txt`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Docs export returned ${response.status}`);
    const corpus = parseCorpus(language, await response.text());
    if (corpus.pages.size === 0) throw new Error('Docs export has no pages');
    return corpus;
}

export async function getDocsCorpus(language: DocsLanguage): Promise<DocsCorpus> {
    const cached = cache.get(language);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;

    let pending = inflight.get(language);
    if (!pending) {
        pending = download(language)
            .then((corpus) => { cache.set(language, corpus); return corpus; })
            .finally(() => inflight.delete(language));
        inflight.set(language, pending);
    }
    try {
        return await pending;
    } catch (err) {
        if (!cached) throw err;
        await warn({
            function: 'docsAssistant.getDocsCorpus', message: 'Docs refresh failed; using the last good copy',
            language, ageMs: Date.now() - cached.fetchedAt, error: err instanceof Error ? err.message : String(err),
        }, { destination: 'console' });
        // Retry again on the next request rather than hammering on every call.
        cached.fetchedAt = Date.now() - CACHE_MS + 30_000;
        return cached;
    }
}

/** Test helper. */
export function clearDocsCache(): void {
    cache.clear();
    inflight.clear();
}
