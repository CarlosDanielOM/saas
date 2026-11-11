/**
 * Splits the docs export (`llms-full.txt`) into pages and `##` sections with the same anchors the
 * docs site uses, so a section id doubles as a link: `/tts#choose-a-voice-engine` →
 * https://docs.domdimabot.com/tts/#choose-a-voice-engine.
 *
 * Export shape (one block per page, separated by `---`):
 *
 *     # Page title
 *
 *     One-line description.
 *
 *     Source: https://docs.domdimabot.com/tts/
 *     Language: en
 *     Documentation index: https://docs.domdimabot.com/llms.txt
 *
 *     Intro… ## Section … ### Subsection …
 *
 * Token estimate everywhere in this folder: `Math.ceil(chars / 4)` (good enough for English and
 * Spanish prose; markdown tables are compacted first so their padding doesn't count).
 */
import { createHash } from 'node:crypto';
import type { Lang } from '../types.js';

export const DOCS_ORIGIN = 'https://docs.domdimabot.com';
/** Anchor Starlight gives the page title; we use it for the text before the first `##`. */
export const INTRO_ANCHOR = '_top';

export interface DocsSubsection {
    id: string;
    anchor: string;
    heading: string;
    level: number;
    /** Offset of the heading line in the parent section's text. */
    offset: number;
}

export interface DocsSection {
    /** `<page path>#<anchor>`, e.g. `/tts#choose-a-voice-engine` or `/es/tts#elegir-un-motor-de-voz`. */
    id: string;
    lang: Lang;
    pageId: string;
    pageTitle: string;
    /** Page URL as the docs site serves it (trailing slash). */
    pageUrl: string;
    anchor: string;
    /** `##` heading text (the page title for the intro). */
    heading: string;
    /** 1 = page intro, 2 = `##` section. */
    level: 1 | 2;
    /** Markdown body without the `##` line; `###` lines stay in it. */
    text: string;
    /** Content hash of page title + heading + text (16 hex chars). */
    hash: string;
    tokens: number;
    subsections: DocsSubsection[];
}

export interface DocsPageInfo {
    /** Page path without the trailing slash: `/tts`, `/es/tts`, `/` (English home), `/es`. */
    id: string;
    lang: Lang;
    title: string;
    url: string;
    /** The description paragraph under the title in the export. */
    description: string;
    sections: DocsSection[];
    tokens: number;
}

export interface ParsedDocs {
    lang: Lang;
    /** Hash of the export text this was parsed from. */
    sourceHash: string;
    pages: DocsPageInfo[];
    sections: DocsSection[];
    sectionById: Map<string, DocsSection>;
    pageById: Map<string, DocsPageInfo>;
    /** `###` (and deeper) ids → their parent section. */
    subsectionById: Map<string, { section: DocsSection; subsection: DocsSubsection }>;
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function hashText(text: string, length = 16): string {
    return createHash('sha256').update(text).digest('hex').slice(0, length);
}

// ---------------------------------------------------------------------------
// Anchors (github-slugger, which Astro/Starlight use for heading ids)
// ---------------------------------------------------------------------------

/**
 * github-slugger's `slug()`: lowercase, drop everything that is not a letter, mark, number,
 * connector (`_`), hyphen or space, then spaces → hyphens. Accents stay (`créditos-de-ia`), runs
 * are not collapsed (`a & b` → `a--b`). Checked against every page of the live docs site.
 */
export function slugify(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** Per-page slugger: repeated headings get `-1`, `-2`, … like github-slugger's class. */
export class HeadingSlugger {
    private readonly occurrences = new Map<string, number>();

    slug(text: string): string {
        const original = slugify(text);
        let result = original;
        while (this.occurrences.has(result)) {
            const next = (this.occurrences.get(original) ?? 0) + 1;
            this.occurrences.set(original, next);
            result = `${original}-${next}`;
        }
        this.occurrences.set(result, 0);
        return result;
    }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
        if (code[0] === '#') {
            const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(value) ? String.fromCodePoint(value) : match;
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

/** The text a heading renders to (what the slugger sees): no links, code ticks, emphasis or escapes. */
export function headingPlainText(markdown: string): string {
    return decodeEntities(markdown)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(^|[^\p{L}\p{N}])(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
        .trim();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `https://docs.domdimabot.com/es/tts/` → `/es/tts`; the home page is `/`. */
export function pageIdFromUrl(url: string): string {
    const path = url.startsWith(DOCS_ORIGIN) ? url.slice(DOCS_ORIGIN.length) : url;
    const trimmed = path.replace(/[#?].*$/, '').replace(/\/index\.txt$/, '/').replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function langFromId(id: string): Lang {
    return id === '/es' || id.startsWith('/es/') || id.startsWith('/es#') ? 'es' : 'en';
}

/** Markdown tables in the export are padded for alignment; the padding is pure token cost. */
function compactLine(line: string): string {
    if (!line.startsWith('|')) return line;
    return line.replace(/ {2,}/g, ' ').replace(/-{4,}/g, '---');
}

function cleanText(lines: string[]): string {
    return lines.map(compactLine).join('\n').replace(/&#x20;/g, ' ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const SOURCE = /^Source: (https:\/\/docs\.domdimabot\.com\/\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface FenceState { marker: string | null }

/** Tracks fenced code blocks so `# comments` in code never count as headings. */
function updateFence(state: FenceState, line: string): boolean {
    const match = FENCE.exec(line);
    if (state.marker) {
        if (match && match[1][0] === state.marker[0] && match[1].length >= state.marker.length && line.trim() === match[1]) state.marker = null;
        return true;
    }
    if (match) {
        state.marker = match[1];
        return true;
    }
    return false;
}

/** A `# Title` line starts a page only when a `Source:` line follows before any other heading. */
function pageSourceAfter(lines: string[], start: number): number {
    for (let i = start + 1; i < Math.min(lines.length, start + 12); i++) {
        if (SOURCE.test(lines[i])) return i;
        if (lines[i].startsWith('#') || lines[i].trim() === '---') return -1;
    }
    return -1;
}

interface RawSection { anchor: string; heading: string; level: 1 | 2; lines: string[]; subsections: Array<{ anchor: string; heading: string; level: number; line: number }> }
interface RawPage { title: string; url: string; description: string; sections: RawSection[]; slugger: HeadingSlugger }

export function parseDocsExport(lang: Lang, raw: string): ParsedDocs {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const pages: RawPage[] = [];
    const fence: FenceState = { marker: null };
    let page: RawPage | null = null;
    let section: RawSection | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const inFence = updateFence(fence, line);
        const heading = inFence ? null : HEADING.exec(line);

        if (heading && heading[1].length === 1) {
            const sourceLine = pageSourceAfter(lines, i);
            if (sourceLine >= 0) {
                const title = heading[2].trim();
                const description = lines.slice(i + 1, sourceLine).map((text) => text.trim()).filter(Boolean).join(' ');
                const url = SOURCE.exec(lines[sourceLine])![1];
                page = { title, url, description, sections: [], slugger: new HeadingSlugger() };
                section = { anchor: INTRO_ANCHOR, heading: title, level: 1, lines: [], subsections: [] };
                if (description) section.lines.push(description, '');
                page.sections.push(section);
                pages.push(page);
                // Skip the export's metadata lines under Source.
                i = sourceLine;
                while (i + 1 < lines.length && /^(Language|Documentation index): /.test(lines[i + 1])) i++;
                continue;
            }
        }
        if (!page || !section) continue;

        if (heading) {
            const level = heading[1].length;
            const anchor = page.slugger.slug(headingPlainText(heading[2]));
            if (level === 2) {
                section = { anchor, heading: heading[2].trim(), level: 2, lines: [], subsections: [] };
                page.sections.push(section);
                continue;
            }
            if (level >= 3) section.subsections.push({ anchor, heading: heading[2].trim(), level, line: section.lines.length });
        }
        section.lines.push(line);
    }

    const parsed: ParsedDocs = {
        lang,
        sourceHash: hashText(raw, 24),
        pages: [],
        sections: [],
        sectionById: new Map(),
        pageById: new Map(),
        subsectionById: new Map(),
    };

    for (const rawPage of pages) {
        // Drop the `---` page separator at the end of the last section.
        const last = rawPage.sections[rawPage.sections.length - 1];
        while (last.lines.length && /^\s*(---)?\s*$/.test(last.lines[last.lines.length - 1])) last.lines.pop();

        const pageId = pageIdFromUrl(rawPage.url);
        const info: DocsPageInfo = { id: pageId, lang, title: rawPage.title, url: rawPage.url, description: rawPage.description, sections: [], tokens: 0 };
        for (const rawSection of rawPage.sections) {
            const subsections: DocsSubsection[] = [];
            // Offsets of subsection headings in the cleaned text: clean line by line and measure.
            const cleanedLines = rawSection.lines.map(compactLine);
            const text = cleanText(rawSection.lines);
            let searchFrom = 0;
            for (const sub of rawSection.subsections) {
                const found = text.indexOf(cleanedLines[sub.line].trim(), searchFrom);
                const offset = found >= 0 ? found : searchFrom;
                searchFrom = offset + 1;
                subsections.push({ id: `${pageId}#${sub.anchor}`, anchor: sub.anchor, heading: sub.heading, level: sub.level, offset });
            }
            if (rawSection.level === 2 || text) {
                const item: DocsSection = {
                    id: `${pageId}#${rawSection.anchor}`,
                    lang,
                    pageId,
                    pageTitle: rawPage.title,
                    pageUrl: rawPage.url,
                    anchor: rawSection.anchor,
                    heading: rawSection.heading,
                    level: rawSection.level,
                    text,
                    hash: hashText(`${rawPage.title}\n${rawSection.heading}\n${text}`),
                    tokens: estimateTokens(text),
                    subsections,
                };
                info.sections.push(item);
                info.tokens += item.tokens;
                parsed.sections.push(item);
                parsed.sectionById.set(item.id, item);
                for (const sub of subsections) parsed.subsectionById.set(sub.id, { section: item, subsection: sub });
            }
        }
        parsed.pages.push(info);
        parsed.pageById.set(pageId, info);
    }
    return parsed;
}

/** Text of one `###` subsection: from its heading to the next heading of the same or a higher level. */
export function subsectionText(section: DocsSection, subsection: DocsSubsection): string {
    const next = section.subsections.find((other) => other.offset > subsection.offset && other.level <= subsection.level);
    return section.text.slice(subsection.offset, next ? next.offset : undefined).trim();
}

/** `https://docs.domdimabot.com/tts/#piper`, `tts#piper`, `/tts/#piper` → `/tts#piper`. */
export function normalizeDocsId(raw: string): string {
    let text = raw.trim();
    if (text.startsWith(DOCS_ORIGIN)) text = text.slice(DOCS_ORIGIN.length);
    const hashAt = text.indexOf('#');
    const path = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const anchor = hashAt >= 0 ? text.slice(hashAt + 1) : '';
    let decoded = anchor;
    try { decoded = decodeURIComponent(anchor); } catch { /* keep as typed */ }
    const pageId = pageIdFromUrl(path.startsWith('/') ? path : `/${path}`);
    return decoded ? `${pageId}#${decoded.toLowerCase()}` : pageId;
}
