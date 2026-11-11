import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearDocsCache, parseCorpus } from '../../utils/ai/docs_assistant/docs_source.js';
import { buildDocsPromptIndex, clearDocsPromptIndexCache, estimateIndexTokens, getDocsPromptIndex, INDEX_TOKEN_BUDGET } from './prompt_index.js';
import { parseDocsExport } from './sections.js';
import { clearParsedDocsCache, parseLlmsIndex } from './source.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;

/** Serves the fixtures as the docs container would; `fail` lists paths that return 503. */
function serveDocs(fail: string[] = []) {
    const files: Record<string, string> = {
        '/llms-full.txt': fixture('llms-full.en.txt'), '/es/llms-full.txt': fixture('llms-full.es.txt'),
        '/llms.txt': fixture('llms.en.txt'), '/es/llms.txt': fixture('llms.es.txt'),
    };
    globalThis.fetch = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (fail.includes(path) || !(path in files)) return new Response('nope', { status: 503 });
        return new Response(files[path]);
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = realFetch;
    clearDocsCache();
    clearParsedDocsCache();
    clearDocsPromptIndexCache();
});

const en = parseDocsExport('en', fixture('llms-full.en.txt'));
const enDescriptions = parseLlmsIndex(fixture('llms.en.txt'));

test('full index lists every page with its description and section anchors', () => {
    const index = buildDocsPromptIndex(en, enDescriptions);
    assert.equal(index.detail, 'full');
    assert.ok(index.tokens <= INDEX_TOKEN_BUDGET);
    assert.equal(index.tokens, estimateIndexTokens(index.text));
    for (const page of en.pages) assert.match(index.text, new RegExp(`^${page.id.replace(/[/]/g, '\\/')} \\| ${page.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| ~`, 'm'), page.id);
    assert.match(index.text, /^\/tts \| Text to Speech \| ~[\d.]+k \| Set up the speech overlay, pick a voice engine/m);
    assert.match(index.text, /#choose-a-voice-engine\(piper kokoro fish-audio find-and-save-fish-voices use-a-fish-voice-in-a-command\)/);
    assert.match(index.text, /#chat-command-s/);
    assert.doesNotMatch(index.text, /#_top/, 'intros are implied, not listed');
});

test('index is byte-identical for the same docs, whatever the description map order', () => {
    const shuffled = new Map([...enDescriptions].reverse());
    const a = buildDocsPromptIndex(en, enDescriptions).text;
    const b = buildDocsPromptIndex(parseDocsExport('en', fixture('llms-full.en.txt')), shuffled).text;
    assert.equal(a, b);
});

test('over budget: drop ### lists, then section lists of the largest pages; page lines always stay', () => {
    const full = buildDocsPromptIndex(en, enDescriptions);
    const noSubs = buildDocsPromptIndex(en, enDescriptions, full.tokens - 1);
    assert.equal(noSubs.detail, 'no-subsections');
    assert.doesNotMatch(noSubs.text, /\(piper/);
    assert.match(noSubs.text, /#choose-a-voice-engine/);

    const partial = buildDocsPromptIndex(en, enDescriptions, noSubs.tokens - 1);
    assert.equal(partial.detail, 'partial-sections');
    const largest = en.pages.slice().sort((x, y) => y.tokens - x.tokens)[0];
    assert.match(partial.text, new RegExp(`^${largest.id.replace(/\//g, '\\/')} \\|.*\\[\\d+ sections\\]$`, 'm'), 'the largest page lost its list first');
    assert.ok(partial.tokens <= noSubs.tokens - 1);

    const tiny = buildDocsPromptIndex(en, enDescriptions, 50);
    for (const page of en.pages) assert.ok(tiny.text.includes(`\n${page.id} | ${page.title} |`), `${page.id} kept`);
    assert.equal(tiny.detail, 'short-descriptions');
    assert.doesNotMatch(tiny.text, /\n {2}#/);
});

test('real docs size stays well under the budget with full detail', () => {
    // Both fixture languages together are ~a third of the real export; the real index is ~4.4k (en) / 5.1k (es).
    const es = buildDocsPromptIndex(parseDocsExport('es', fixture('llms-full.es.txt')), parseLlmsIndex(fixture('llms.es.txt')));
    assert.equal(es.detail, 'full');
    assert.match(es.text, /^\/es\/tts \| Texto a voz \| /m);
    assert.match(es.text, /#créditos-de-ia-y-respaldos/);
});

test('getDocsPromptIndex reads llms.txt descriptions and falls back to the export text identically', async () => {
    serveDocs();
    const live = await getDocsPromptIndex('en');
    // The loader points `.../index.txt` links at the HTML pages before parsing.
    const loaded = parseDocsExport('en', parseCorpus('en', fixture('llms-full.en.txt')).text);
    assert.equal(live, buildDocsPromptIndex(loaded, enDescriptions).text);
    assert.equal(await getDocsPromptIndex('en'), live, 'memoized');

    clearDocsCache(); clearParsedDocsCache(); clearDocsPromptIndexCache();
    serveDocs(['/llms.txt']);
    assert.equal(await getDocsPromptIndex('en'), live, 'export descriptions are the same text, so the prompt prefix does not change');
});

test('getDocsPromptIndex never throws when the docs are down', async () => {
    serveDocs(['/llms-full.txt', '/llms.txt']);
    assert.match(await getDocsPromptIndex('en'), /Docs index unavailable/);
});
