import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The embeddings service is never called from tests: here it is down, so search is keyword-only.
let embedCalls = 0;
mock.module('../../utils/ai/lfm2_embeddings/index.js', {
    namedExports: {
        LFM2_EMBEDDING_DIM: 1024,
        generateEmbedding: async () => { embedCalls++; return { error: true, message: 'down' }; },
        generateEmbeddings: async () => { embedCalls++; return { error: true, message: 'down' }; },
    },
});
mock.module('../../utils/databases/dragonfly.database.js', {
    namedExports: { getDragonflyClient: async () => ({ mGet: async (keys: string[]) => keys.map(() => null), set: async () => 'OK' }) },
});

const { fold, KeywordIndex, makeSnippet, queryTerms, stem, tokenize } = await import('./keyword.js');
const { reciprocalRankFusion, searchDocs, searchParsedDocs } = await import('./search.js');
const { parseDocsExport } = await import('./sections.js');
const { clearDocsCache } = await import('../../utils/ai/docs_assistant/docs_source.js');
const { clearParsedDocsCache } = await import('./source.js');
const { resetDocsVectors } = await import('./vectors.js');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const en = parseDocsExport('en', fixture('llms-full.en.txt'));
const es = parseDocsExport('es', fixture('llms-full.es.txt'));
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    clearDocsCache();
    clearParsedDocsCache();
    resetDocsVectors();
});

test('tokenizer keeps bot syntax, folds accents, drops stopwords and stems plurals', () => {
    assert.deepEqual(tokenize('Use $(user) and %(deaths) with !cc, &t, &p1 and $(tts.skip)'), [
        'use', '$(user)', 'user', '%(deaths)', 'death', '!cc', 'cc', '&t', '&p1', 'p1', '$(tts.skip)', 'tts.skip', 'tts', 'skip',
    ]);
    assert.deepEqual(tokenize('¿Cómo funciona la canción?'), ['funciona', 'cancion']);
    assert.equal(fold('Créditos de IA'), 'creditos de ia');
    for (const [a, b] of [['comandos', 'comando'], ['voices', 'voice'], ['follows', 'followed'], ['replies', 'reply'], ['muertes', 'muerte'], ['límites', 'limite']]) {
        assert.equal(stem(fold(a)), stem(fold(b)), `${a} ~ ${b}`);
    }
    assert.equal(stem('tts'), 'tts');
    assert.equal(stem('status'), 'status');
});

test('glossary adds docs words at half weight', () => {
    assert.deepEqual(queryTerms('read chat aloud'), [
        { term: 'read', weight: 1 }, { term: 'chat', weight: 1 }, { term: 'aloud', weight: 1 }, { term: 'tts', weight: 0.5 }, { term: 'speech', weight: 0.5 },
    ]);
    assert.ok(queryTerms('un dado del 1 al 6').some((t) => t.term === 'random' && t.weight === 0.5));
});

const top = (parsed: typeof en, query: string, n = 3) => new KeywordIndex(parsed.sections).search(query, n).map((hit) => parsed.sections[hit.index].id);

test('BM25 ranks the right sections for real user questions', () => {
    // Real questions from the Phase 0 set (questions.json) whose answers are in the fixture pages.
    assert.ok(top(en, 'How do I make the bot read chat aloud?').some((id) => id.startsWith('/tts') || id === '/commands/built-in#text-to-speech'));
    assert.equal(top(en, 'How do I make the bot read chat aloud?')[0], '/tts#_top');
    assert.ok(top(en, 'How do I stop follow bots?').every((id) => id.startsWith('/follow-defense')));
    assert.equal(top(en, 'What do Premium and Pro include?')[0], '/plans#_top');
    assert.equal(top(en, 'How do i make it so each viewer can have their own voice for tts with points?')[0], '/tts#ast-functions');
    // Spanish, accents in the question and the docs.
    assert.equal(top(es, '¿Qué incluyen Premium y Pro?')[0], '/es/plans#_top');
    assert.equal(top(es, 'quiero que el bot lea el chat en voz alta')[0], '/es/tts#_top');
    assert.ok(top(es, '¿Cómo freno los bots de follow?').every((id) => id.startsWith('/es/follow-defense')));
    // Exact syntax tokens.
    assert.equal(top(en, '$(tts.fish)')[0].startsWith('/tts'), true);
    assert.deepEqual(top(en, 'zzzz qqqq'), []);
});

test('reciprocal rank fusion: items in both lists win, ties keep the first list order', () => {
    const fused = reciprocalRankFusion([[1, 2, 3], [3, 4, 1]]);
    assert.deepEqual(fused.map((item) => item.index), [1, 3, 2, 4]);
    assert.ok(Math.abs(fused[0].score - (1 / 61 + 1 / 63)) < 1e-12);
    assert.deepEqual(reciprocalRankFusion([[5], [6]]).map((item) => item.index), [5, 6]);
    assert.deepEqual(reciprocalRankFusion([[], []]), []);
});

test('snippets show ~300 chars around the best match', () => {
    const section = en.sectionById.get('/follow-defense#manual-controls')!;
    const index = new KeywordIndex(en.sections);
    const snippet = makeSnippet(section.text, queryTerms('stop attack mode').map((t) => t.term), (term) => index.idf(term));
    assert.match(snippet, /Stop Attack Mode/);
    assert.ok(snippet.length <= 302, `${snippet.length}`);
    assert.doesNotMatch(snippet, /\n/);
    const long = 'intro '.repeat(100) + 'the magicword is here ' + 'outro '.repeat(100);
    const around = makeSnippet(long, ['magicword'], () => 1);
    assert.match(around, /^….*magicword.*…$/);
    assert.equal(makeSnippet('Short text.', ['nothing'], () => 1), 'Short text.');
});

test('searchParsedDocs returns ids, urls with anchors, snippets and token sizes', async () => {
    const response = await searchParsedDocs(en, 'emotion tags for fish voices', 3, { semantic: false });
    assert.equal(response.semantic, false);
    const first = response.results[0];
    assert.equal(first.id, '/tts#voice-tags-fish-audio-only');
    assert.equal(first.url, 'https://docs.domdimabot.com/tts/#voice-tags-fish-audio-only');
    assert.equal(first.page, 'Text to Speech');
    assert.equal(first.section, 'Voice tags (Fish Audio only)');
    assert.equal(first.tokens, en.sectionById.get(first.id)!.tokens);
    const intro = (await searchParsedDocs(en, 'aloud', 5, { semantic: false })).results.find((r) => r.id === '/tts#_top')!;
    assert.equal(intro.url, 'https://docs.domdimabot.com/tts/', 'page intro links to the page itself');
});

function serveDocs() {
    const files: Record<string, string> = { '/llms-full.txt': fixture('llms-full.en.txt'), '/es/llms-full.txt': fixture('llms-full.es.txt') };
    globalThis.fetch = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path in files ? new Response(files[path]) : new Response('nope', { status: 404 });
    }) as typeof fetch;
}

test('searchDocs: keyword-only while the embeddings service is down; other language when nothing matches', async () => {
    serveDocs();
    const spanish = await searchDocs({ query: 'Filtros de mensajes', lang: 'es', limit: 2 });
    assert.equal(spanish.lang, 'es');
    assert.equal(spanish.semantic, false);
    assert.equal(spanish.results.length, 2);
    assert.ok(spanish.results.every((r) => r.id.startsWith('/es/')));

    // "threshold" only appears in the English docs (Spanish says "umbral").
    const fallback = await searchDocs({ query: 'threshold', lang: 'es' });
    assert.equal(fallback.lang, 'en');
    assert.equal(fallback.results[0].id, '/follow-defense#attack-threshold');

    const none = await searchDocs({ query: 'qqqqzzzz', lang: 'en', limit: 50 });
    assert.deepEqual(none.results, []);
    // Vectors were requested in the background (and failed): no retry storm.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = embedCalls;
    await searchDocs({ query: 'tts', lang: 'en' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(embedCalls, calls, 'a failed build waits before trying again');
});

test('searchDocs throws only when the docs never loaded', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await assert.rejects(searchDocs({ query: 'tts', lang: 'en' }), /503/);
});
