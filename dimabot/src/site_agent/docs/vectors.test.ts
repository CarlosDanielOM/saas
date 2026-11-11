import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fake embeddings service (never the real one) and fake Dragonfly (in memory).
const DIM = 1024;
const batches: number[] = [];
let inFlight = 0;
let maxInFlight = 0;
let failBatchAt = -1;
let failQueries = false;
const queries: string[] = [];

/** Sections that mention ATTACK point one way, everything else another; queries with the marker "zzattackzz" match the first. */
function fakeVector(text: string, query = false): number[] {
    const vector = new Array(DIM).fill(0);
    vector[(query ? text.includes('zzattackzz') : text.includes('ATTACK')) ? 0 : 1] = 1;
    return vector;
}

mock.module('../../utils/ai/lfm2_embeddings/index.js', {
    namedExports: {
        LFM2_EMBEDDING_DIM: DIM,
        generateEmbedding: async (text: string, _model: string, kind: string) => {
            assert.equal(kind, 'query');
            queries.push(text);
            return failQueries ? { error: true, message: 'down' } : { error: false, embedding: fakeVector(text, true) };
        },
        generateEmbeddings: async (texts: string[], _model: string, kind: string) => {
            assert.equal(kind, 'document');
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 2));
            inFlight--;
            if (batches.length === failBatchAt) { batches.push(-texts.length); return { error: true, message: 'oom' }; }
            batches.push(texts.length);
            return { error: false, embeddings: texts.map((text) => fakeVector(text)) };
        },
    },
});
const store = new Map<string, { value: string; ex?: number }>();
mock.module('../../utils/databases/dragonfly.database.js', {
    namedExports: {
        getDragonflyClient: async () => ({
            mGet: async (keys: string[]) => keys.map((key) => store.get(key)?.value ?? null),
            set: async (key: string, value: string, options?: { EX?: number }) => { store.set(key, { value, ex: options?.EX }); return 'OK'; },
        }),
    },
});

const { buildChunks, chunkSection, CHUNK_CHARS, docsVectorsReady, EMBED_BATCH_SIZE, ensureDocsVectors, resetDocsVectors } = await import('./vectors.js');
const { searchDocs } = await import('./search.js');
const { parseDocsExport } = await import('./sections.js');
const { clearDocsCache, parseCorpus } = await import('../../utils/ai/docs_assistant/docs_source.js');
const { clearParsedDocsCache, getParsedDocs } = await import('./source.js');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
let served: Record<string, string>;

beforeEach(() => {
    served = { '/llms-full.txt': fixture('llms-full.en.txt'), '/es/llms-full.txt': fixture('llms-full.es.txt') };
    globalThis.fetch = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path in served ? new Response(served[path]) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    batches.length = 0;
    queries.length = 0;
    maxInFlight = 0;
    failBatchAt = -1;
    failQueries = false;
    resetDocsVectors({ pauseMs: 1 });
});

afterEach(() => {
    globalThis.fetch = realFetch;
    clearDocsCache();
    clearParsedDocsCache();
});

const embedded = () => batches.filter((n) => n > 0).reduce((a, b) => a + b, 0);
const uniqueChunks = async (lang: 'en' | 'es') => new Set(buildChunks(await getParsedDocs(lang)).map((chunk) => chunk.key)).size;

test('chunks stay small and carry page › section › subsection', () => {
    const parsed = parseDocsExport('en', parseCorpus('en', fixture('llms-full.en.txt')).text);
    for (const section of parsed.sections) {
        for (const chunk of chunkSection(section)) {
            const [prefix, ...body] = chunk.split('\n\n');
            assert.ok(prefix.startsWith(section.pageTitle), section.id);
            assert.ok(body.join('\n\n').length <= CHUNK_CHARS, `${section.id}: ${body.join('\n\n').length}`);
        }
    }
    const voices = chunkSection(parsed.sectionById.get('/tts#choose-a-voice-engine')!);
    assert.ok(voices.some((chunk) => chunk.startsWith('Text to Speech › Choose a voice engine › Piper\n\n### Piper')));
    assert.ok(chunkSection(parsed.sectionById.get('/tts#_top')!)[0].startsWith('Text to Speech\n\n'));
    const keys = buildChunks(parsed).map((chunk) => chunk.key);
    for (const key of keys) assert.match(key, /^site_agent:docs:vec:en:[0-9a-f]{24}$/);
});

test('first build embeds every chunk in batches of at most 8 and caches each vector for 30 days', async () => {
    assert.equal(docsVectorsReady('en'), false);
    // Two callers share one build.
    const [a, b] = await Promise.all([ensureDocsVectors('en'), ensureDocsVectors('en')]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.ok(batches.every((size) => size > 0 && size <= EMBED_BATCH_SIZE), `batches: ${batches}`);
    assert.equal(embedded(), await uniqueChunks('en'));
    assert.equal(maxInFlight, 1);
    const keys = [...store.keys()].filter((key) => key.startsWith('site_agent:docs:vec:en:'));
    assert.equal(keys.length, await uniqueChunks('en'));
    for (const key of keys) {
        assert.equal(store.get(key)!.ex, 30 * 86_400);
        assert.equal(Buffer.from(store.get(key)!.value, 'base64').byteLength, DIM * 4);
    }
    assert.equal(docsVectorsReady('en'), true);
    assert.equal(await ensureDocsVectors('en'), true);
    assert.equal(batches.length, Math.ceil(embedded() / EMBED_BATCH_SIZE), 'no second build');
});

test('after a restart vectors come from Dragonfly without calling the embeddings service', async () => {
    assert.equal(await ensureDocsVectors('en'), true);
    assert.deepEqual(batches, []);
});

test('a docs change re-embeds only the changed section', async () => {
    assert.equal(await ensureDocsVectors('en'), true);
    assert.deepEqual(batches, []);
    served['/llms-full.txt'] = fixture('llms-full.en.txt').replace('Turning off **Enable Follow Defense** stops new decisions', 'Turning off **Enable Follow Defense** halts new decisions');
    clearDocsCache();
    const parsed = await getParsedDocs('en');
    const changed = chunkSection(parsed.sectionById.get('/follow-defense#turn-it-off')!).length;
    assert.equal(await ensureDocsVectors('en'), true);
    assert.equal(embedded(), changed);
});

test('semantic results fuse with keywords; semantic-only matches show up when keywords find nothing', async () => {
    // Build both languages first so the other-language fallback starts no background build.
    assert.deepEqual(await Promise.all([ensureDocsVectors('en'), ensureDocsVectors('es')]), [true, true]);
    const parsed = await getParsedDocs('en');
    const attack = parsed.sections.filter((section) => chunkSection(section).some((chunk) => chunk.includes('ATTACK'))).map((section) => section.id);
    assert.ok(attack.length >= 1);
    const response = await searchDocs({ query: 'qqqq zzattackzz', lang: 'en', limit: attack.length });
    assert.equal(response.semantic, true);
    assert.equal(response.lang, 'en');
    assert.deepEqual(response.results.map((result) => result.id).sort(), attack.slice().sort());
    assert.ok(queries.includes('qqqq zzattackzz'));

    // A section that both rankings like comes first.
    const fused = await searchDocs({ query: 'manual controls zzattackzz', lang: 'en', limit: 1 });
    assert.equal(fused.results[0].id, '/follow-defense#manual-controls');
});

test('keyword-only while warming up, when a batch fails, or when the query embedding fails', async () => {
    resetDocsVectors({ pauseMs: 1 });
    store.clear();
    failBatchAt = 2;
    const warming = await searchDocs({ query: 'manual controls', lang: 'en' });
    assert.equal(warming.semantic, false, 'vectors not built yet');
    assert.equal(warming.results[0].id, '/follow-defense#manual-controls');
    assert.equal(await ensureDocsVectors('en'), false, 'the build that search started failed');
    assert.deepEqual(batches.slice(0, 3), [8, 8, -8]);
    assert.equal([...store.keys()].length, 16, 'finished batches are kept');
    const calls = batches.length;
    assert.equal(await ensureDocsVectors('en'), false);
    assert.equal(batches.length, calls, 'no immediate retry after a failure');

    resetDocsVectors({ pauseMs: 1 });
    failBatchAt = -1;
    assert.equal(await ensureDocsVectors('en'), true);
    assert.equal(embedded(), await uniqueChunks('en'), 'the 16 cached vectors were reused, the rest embedded once');
    failQueries = true;
    const down = await searchDocs({ query: 'manual controls', lang: 'en' });
    assert.equal(down.semantic, false);
    assert.equal(down.results[0].id, '/follow-defense#manual-controls');
});

test('both languages build one batch at a time', async () => {
    resetDocsVectors({ pauseMs: 1 });
    store.clear();
    const [en, es] = await Promise.all([ensureDocsVectors('en'), ensureDocsVectors('es')]);
    assert.equal(en && es, true);
    assert.equal(maxInFlight, 1);
    assert.equal(embedded(), (await uniqueChunks('en')) + (await uniqueChunks('es')));
    assert.ok([...store.keys()].some((key) => key.startsWith('site_agent:docs:vec:es:')));
});
