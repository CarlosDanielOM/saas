/**
 * Keyword side of docs search: BM25F over sections with three fields (page title, headings, body).
 * Text is lowercased, accent-folded and lightly stemmed so "voces"/"voz" stay apart but
 * "comandos"/"comando", "follows"/"follow", "replies"/"reply" meet. Bot syntax survives as its own
 * tokens: `$(user)`, `%(deaths)`, `#(other)`, `!cc`, `&t`, `&p1`, `tts.skip`.
 */
import type { DocsSection } from './sections.js';

const STOPWORDS = new Set([
    // English
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'been', 'it', 'its', 'i', 'me',
    'my', 'you', 'your', 'we', 'our', 'us', 'do', 'does', 'did', 'how', 'what', 'which', 'who', 'can', 'could', 'would', 'should',
    'will', 'so', 'that', 'this', 'these', 'those', 'there', 'here', 'at', 'by', 'from', 'as', 'if', 'then', 'than', 'but',
    'have', 'has', 'had', 'get', 'want', 'about', 'into', 'their', 'them', 'they', 'he', 'she', 'his', 'her', 'also', 'just',
    'any', 'some', 'such', 'too', 'very', 'when', 'where', 'why', 'please', 'im', 'dont',
    // Request verbs that say nothing about the topic ("make a command that tells the viewer what they got").
    'make', 'makes', 'made', 'got', 'tell', 'tells', 'give', 'gives', 'let', 'lets', 'need', 'way', 'thing', 'something',
    // Spanish (accents folded)
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'o', 'u', 'e', 'en', 'con', 'por', 'para',
    'que', 'como', 'cual', 'cuales', 'cuando', 'donde', 'quien', 'es', 'son', 'ser', 'estar', 'esta', 'este', 'esto', 'estos',
    'estas', 'ese', 'esa', 'eso', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'se', 'te', 'le', 'les', 'lo', 'nos', 'yo', 'ella',
    'pero', 'si', 'mas', 'muy', 'ya', 'puedo', 'puede', 'puedan', 'hay', 'tengo', 'quiero', 'debo', 'podrias', 'sobre', 'tambien',
    'hacer', 'haga', 'darme', 'dame', 'dio', 'algo', 'otro', 'otra',
]);

/**
 * How streamers describe a feature → the words the docs use for it. Applied to queries only, at
 * EXPANSION_WEIGHT, so keyword search still lands on the right page while vectors warm up.
 * Plain words; they are folded and stemmed when loaded, like everything else. Keep it small.
 */
const GLOSSARY: Record<string, string[]> = {
    aloud: ['tts', 'speech'], speak: ['tts', 'speech'], voz: ['tts'], voces: ['tts'], hablar: ['tts'], lea: ['tts'], leer: ['tts'],
    dice: ['random'], die: ['random'], roll: ['random'], dado: ['random', 'aleatorio'], dados: ['random', 'aleatorio'],
    coin: ['random'], flip: ['random'], moneda: ['random', 'aleatorio'], azar: ['random', 'aleatorio'],
    death: ['counter', 'count'], deaths: ['counter', 'count'], muerte: ['contador', 'contar'], muertes: ['contador', 'contar'], muerto: ['contador', 'contar'],
    points: ['reward', 'redemption'], puntos: ['recompensa', 'canje'],
    sound: ['trigger'], sounds: ['trigger'], sonido: ['trigger'], sonidos: ['trigger'],
};
export const EXPANSION_WEIGHT = 0.5;

/** Lowercase + strip accents. Keeps the string length for Latin text (NFD + drop marks). */
export function fold(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
}

/** Tiny stemmer for English and Spanish plurals and a few verb endings. Same rules for docs and queries. */
export function stem(word: string): string {
    if (word.length < 4 || /\d/.test(word)) return word;
    let w = word;
    if (w.endsWith('ies')) w = `${w.slice(0, -3)}i`;
    else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
    else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    else if (w.length > 3 && w.endsWith('y')) w = `${w.slice(0, -1)}i`;
    return w;
}

export interface TokenHit {
    term: string;
    start: number;
    end: number;
}

const TOKEN = /([$%#])\(\s*([a-z0-9_]+(?:\.[a-z0-9_]+)*)|([!&])([a-z][a-z0-9_]*)|[a-z0-9_]+(?:\.[a-z0-9_]+)*/g;

function pushWord(out: TokenHit[], word: string, start: number, end: number): void {
    if (word.length < 2 || STOPWORDS.has(word)) return;
    out.push({ term: stem(word), start, end });
}

/** Terms with their offsets in the (already folded) text. */
export function tokenizeFolded(folded: string): TokenHit[] {
    const out: TokenHit[] = [];
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(folded); match; match = TOKEN.exec(folded)) {
        const start = match.index;
        const end = start + match[0].length;
        if (match[1]) {
            // $(user), %(deaths), #(other): the syntax token plus its name parts.
            out.push({ term: `${match[1]}(${match[2]})`, start, end });
            if (match[2].includes('.')) out.push({ term: match[2], start, end });
            for (const part of match[2].split(/[._]/)) pushWord(out, part, start, end);
        } else if (match[3]) {
            // !cc, &t, &p1
            out.push({ term: `${match[3]}${match[4]}`, start, end });
            pushWord(out, match[4], start, end);
        } else if (match[0].includes('.')) {
            // tts.skip, math.floor
            out.push({ term: match[0], start, end });
            for (const part of match[0].split('.')) pushWord(out, part, start, end);
        } else {
            pushWord(out, match[0], start, end);
        }
    }
    return out;
}

export function tokenize(text: string): string[] {
    return tokenizeFolded(fold(text)).map((hit) => hit.term);
}

export interface QueryTerm { term: string; weight: number }

const STEMMED_GLOSSARY = new Map<string, string[]>();
for (const [word, targets] of Object.entries(GLOSSARY)) {
    const key = stem(fold(word));
    STEMMED_GLOSSARY.set(key, [...new Set([...(STEMMED_GLOSSARY.get(key) ?? []), ...targets.flatMap(tokenize)])]);
}

/** Distinct query terms (weight 1) plus glossary expansions (EXPANSION_WEIGHT) not already present. */
export function queryTerms(query: string): QueryTerm[] {
    const terms = [...new Set(tokenize(query))];
    const out: QueryTerm[] = terms.map((term) => ({ term, weight: 1 }));
    const seen = new Set(terms);
    for (const term of terms) {
        for (const extra of STEMMED_GLOSSARY.get(term) ?? []) {
            if (seen.has(extra)) continue;
            seen.add(extra);
            out.push({ term: extra, weight: EXPANSION_WEIGHT });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// BM25F
// ---------------------------------------------------------------------------

const FIELDS = [
    { name: 'title', weight: 2, b: 0.4 },
    { name: 'heading', weight: 3, b: 0.4 },
    { name: 'body', weight: 1, b: 0.75 },
] as const;
const K1 = 1.2;
/** Share of the page's own score added to each of its sections (topic-level relevance). */
export const PAGE_PRIOR = 0.5;

type FieldTexts = [title: string, heading: string, body: string];
interface Posting { doc: number; tf: [number, number, number] }

/** BM25F over documents with three fields (title, headings, body). */
export class Bm25F {
    private readonly postings = new Map<string, Posting[]>();
    private readonly lengths: Array<[number, number, number]> = [];
    private readonly averages: [number, number, number] = [0, 0, 0];
    readonly size: number;

    constructor(docs: readonly FieldTexts[]) {
        this.size = docs.length;
        docs.forEach((texts, doc) => {
            const fields = texts.map(tokenize);
            const counts = new Map<string, [number, number, number]>();
            fields.forEach((terms, field) => {
                for (const term of terms) {
                    const tf = counts.get(term) ?? [0, 0, 0];
                    tf[field]++;
                    counts.set(term, tf);
                }
            });
            this.lengths.push([fields[0].length, fields[1].length, fields[2].length]);
            for (const [term, tf] of counts) {
                const list = this.postings.get(term) ?? [];
                list.push({ doc, tf });
                this.postings.set(term, list);
            }
        });
        for (let field = 0; field < 3; field++) {
            const total = this.lengths.reduce((sum, lengths) => sum + lengths[field], 0);
            this.averages[field] = this.size ? Math.max(1, total / this.size) : 1;
        }
    }

    idf(term: string): number {
        const df = this.postings.get(term)?.length ?? 0;
        return Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
    }

    scores(terms: readonly QueryTerm[]): Map<number, { score: number; matched: string[] }> {
        const out = new Map<number, { score: number; matched: string[] }>();
        for (const { term, weight } of terms) {
            const list = this.postings.get(term);
            if (!list) continue;
            const idf = this.idf(term) * weight;
            for (const { doc, tf } of list) {
                let weighted = 0;
                FIELDS.forEach((field, index) => {
                    if (!tf[index]) return;
                    const norm = 1 - field.b + field.b * (this.lengths[doc][index] / this.averages[index]);
                    weighted += (field.weight * tf[index]) / norm;
                });
                const hit = out.get(doc) ?? { score: 0, matched: [] };
                hit.score += idf * (weighted / (K1 + weighted));
                hit.matched.push(term);
                out.set(doc, hit);
            }
        }
        return out;
    }
}

export interface KeywordHit {
    index: number;
    score: number;
    /** Query terms found in the section. */
    matched: string[];
}

/**
 * Section ranking: the section's own BM25F score plus PAGE_PRIOR × its page's score, so a section
 * of the page that is about the question beats a stray mention elsewhere.
 */
export class KeywordIndex {
    private readonly sections: Bm25F;
    private readonly pages: Bm25F;
    private readonly pageOf: number[];
    readonly size: number;

    constructor(sections: readonly DocsSection[]) {
        this.size = sections.length;
        const pageIds: string[] = [];
        const pageTexts = new Map<string, FieldTexts>();
        this.pageOf = sections.map((section) => {
            const headings = [section.level === 2 ? section.heading : '', ...section.subsections.map((sub) => sub.heading)].join('\n');
            const page = pageTexts.get(section.pageId);
            if (page) {
                page[1] += `\n${headings}`;
                page[2] += `\n${section.text}`;
            } else {
                pageTexts.set(section.pageId, [section.pageTitle, headings, section.text]);
                pageIds.push(section.pageId);
            }
            return pageIds.indexOf(section.pageId);
        });
        this.sections = new Bm25F(sections.map((section) => [
            section.pageTitle,
            [section.level === 2 ? section.heading : '', ...section.subsections.map((sub) => sub.heading)].join('\n'),
            section.text,
        ]));
        this.pages = new Bm25F(pageIds.map((id) => pageTexts.get(id)!));
    }

    idf(term: string): number {
        return this.sections.idf(term);
    }

    search(query: string, limit = 50): KeywordHit[] {
        const terms = queryTerms(query);
        const own = this.sections.scores(terms);
        const pages = this.pages.scores(terms);
        const hits: KeywordHit[] = [];
        for (const [index, hit] of own) {
            hits.push({ index, score: hit.score + PAGE_PRIOR * (pages.get(this.pageOf[index])?.score ?? 0), matched: hit.matched });
        }
        return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit);
    }
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/** ~`size` chars of `text` around the densest cluster of query terms (start of text when none match). */
export function makeSnippet(text: string, terms: readonly string[], idf: (term: string) => number, size = 300): string {
    const folded = fold(text);
    // NFD folding keeps offsets for Latin text; fall back to the start if it ever doesn't.
    const wanted = new Set(terms);
    const hits = folded.length === text.length ? tokenizeFolded(folded).filter((hit) => wanted.has(hit.term)) : [];
    let start = 0;
    if (hits.length) {
        let best = -1;
        for (const hit of hits) {
            const from = Math.max(0, hit.start - 60);
            const seen = new Set<string>();
            for (const other of hits) if (other.start >= from && other.end <= from + size) seen.add(other.term);
            const score = [...seen].reduce((sum, term) => sum + idf(term), 0);
            if (score > best) { best = score; start = from; }
        }
    }
    let end = Math.min(text.length, start + size);
    if (start > 0) {
        const space = text.lastIndexOf(' ', start);
        if (space > start - 20 && space >= 0) start = space + 1;
    }
    if (end < text.length) {
        const space = text.lastIndexOf(' ', end);
        if (space > end - 30) end = space;
    }
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
