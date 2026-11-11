import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The command simulator loads modules that need a secret; the embeddings service and Dragonfly are fakes.
process.env.SECRET_KEY ??= 'knowledge-test-secret';
const DOC_TITLES = /^(DomDimaBot Docs|AST Syntax & Data|Built-in commands|Follow Defense|Plans|Text to Speech|Docs de DomDimaBot|Sintaxis y Datos de AST|Comandos integrados|Planes|Texto a voz)( ›|\n)/;
const docBatches: number[] = [];
mock.module('../../utils/ai/lfm2_embeddings/index.js', {
    namedExports: {
        LFM2_EMBEDDING_DIM: 1024,
        generateEmbedding: async () => ({ error: false, embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)) }),
        generateEmbeddings: async (texts: string[]) => {
            // Docs chunks start with their page title; the AST catalog has its own batches.
            if (texts.every((text) => DOC_TITLES.test(text))) docBatches.push(texts.length);
            return { error: false, embeddings: texts.map((_, n) => Array.from({ length: 1024 }, (__, i) => (i === n % 1024 ? 1 : 0))) };
        },
    },
});
const store = new Map<string, string>();
mock.module('../../utils/databases/dragonfly.database.js', {
    namedExports: {
        getDragonflyClient: async () => ({
            get: async (key: string) => store.get(key) ?? null,
            mGet: async (keys: string[]) => keys.map((key) => store.get(key) ?? null),
            set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
        }),
    },
});

const { knowledgeTools, readDocsTool, searchAstFunctionsAgentTool, searchDocsTool, testCommandAgentTool, warmKnowledge } = await import('./knowledge.js');
const { ToolInputError } = await import('../types.js');
const { SITE_AGENT_LIMITS } = await import('../config.js');
const { docsVectorsReady, ensureDocsVectors, resetDocsVectors } = await import('../docs/vectors.js');
type ToolContext = import('../types.js').ToolContext;

const fixture = (name: string) => readFileSync(new URL(`../docs/fixtures/${name}`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;

before(() => {
    const files: Record<string, string> = {
        '/llms-full.txt': fixture('llms-full.en.txt'), '/es/llms-full.txt': fixture('llms-full.es.txt'),
        '/llms.txt': fixture('llms.en.txt'), '/es/llms.txt': fixture('llms.es.txt'),
    };
    globalThis.fetch = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path in files ? new Response(files[path]) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    resetDocsVectors({ pauseMs: 1 });
});
after(() => { globalThis.fetch = realFetch; });

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        channelId: '533538623', channelLogin: 'cdom201', requester: { id: '533538623', login: 'cdom201', displayName: 'cdom201' },
        role: 'owner', plan: 'premium', lang: 'en', sessionId: 's1', turnId: 't1', callId: 'c1', userMessage: 'hi', page: null,
        signal: new AbortController().signal, can: async () => true, ...overrides,
    };
}

test('four knowledge tools, open to everyone with assistant access', () => {
    assert.deepEqual(knowledgeTools.map((tool) => tool.name), ['search_docs', 'read_docs', 'search_ast_functions', 'test_command']);
    for (const tool of knowledgeTools) {
        assert.equal(tool.kind, 'knowledge');
        assert.deepEqual(tool.permissions, []);
        assert.equal(tool.minPlan, undefined);
        assert.equal((tool.parameters as { type: string }).type, 'object');
        assert.ok(Array.isArray((tool.parameters as { required?: string[] }).required), tool.name);
        assert.match(tool.name, /^[a-z_]+$/);
        assert.ok(tool.description.length > 200, tool.name);
        assert.equal(tool.apply, undefined);
    }
    assert.match(readDocsTool.description, /\/tts#choose-a-voice-engine/);
    assert.match(searchDocsTool.description, /read the section with read_docs/);
    assert.match(String((testCommandAgentTool.parameters as { properties: Record<string, { description: string }> }).properties.plan.description), /this channel's plan/);
});

test('validation turns bad arguments into model-readable ToolInputErrors', () => {
    assert.deepEqual(searchDocsTool.validate({ query: ' follow bots ' }), { query: 'follow bots', limit: 5, lang: undefined });
    assert.deepEqual(searchDocsTool.validate({ query: 'tts', limit: '3', lang: 'es' }), { query: 'tts', limit: 3, lang: 'es' });
    for (const bad of [{}, { query: 'x' }, { query: 'tts', limit: 11 }, { query: 'tts', lang: 'fr' }, 'tts', [1]]) {
        assert.throws(() => searchDocsTool.validate(bad), ToolInputError, JSON.stringify(bad));
    }
    assert.deepEqual(readDocsTool.validate({ id: '/tts#piper' }), { id: '/tts#piper', scope: undefined, page: undefined });
    for (const bad of [{}, { id: '/tts', scope: 'page' }, { id: '/tts', page: 0 }, { id: 'x'.repeat(301) }]) {
        assert.throws(() => readDocsTool.validate(bad), ToolInputError, JSON.stringify(bad));
    }
    assert.throws(() => searchAstFunctionsAgentTool.validate({}), /query is required/);
    assert.throws(() => testCommandAgentTool.validate({ body: '!cc dice $(random 6)' }), (err) => err instanceof ToolInputError && /only the response body/.test(err.message));
    assert.throws(() => testCommandAgentTool.validate({}), ToolInputError);
    assert.throws(() => testCommandAgentTool.validate({ body: 'hi', plan: 'gold' }), ToolInputError);
    assert.equal(testCommandAgentTool.validate({ body: 'hi' }).plan, undefined);
});

test('status labels in English and Mexican Spanish', async () => {
    assert.equal(searchDocsTool.label({ query: 'x', limit: 5 }, 'en'), 'Searching the docs…');
    assert.equal(searchDocsTool.label({ query: 'x', limit: 5 }, 'es'), 'Buscando en la documentación…');
    assert.equal(testCommandAgentTool.label({}, 'en'), 'Testing the command…');
    assert.equal(testCommandAgentTool.label({}, 'es'), 'Probando el comando…');
    assert.equal(searchAstFunctionsAgentTool.label({ query: 'x', limit: 5 }, 'es'), 'Buscando funciones de comandos…');
    // Before the docs load, the label comes from the id; afterwards from the real heading.
    assert.equal(readDocsTool.label({ id: '/tts#choose-a-voice-engine' }, 'en'), 'Reading: Choose a voice engine…');
    await searchDocsTool.run({ query: 'tts', limit: 1 }, ctx());
    assert.equal(readDocsTool.label({ id: '/tts#chat-command-s' }, 'en'), 'Reading: Chat command: !s…');
    assert.equal(readDocsTool.label({ id: '/tts' }, 'es'), 'Leyendo: Text to Speech…');
    assert.equal(readDocsTool.label({ id: '/tts#nope-2' }, 'en'), 'Reading: Nope…');
});

test('search_docs and read_docs answer in the user\'s language with short summaries', async () => {
    const search = await searchDocsTool.run({ query: '¿Qué incluyen Premium y Pro?', limit: 3 }, ctx({ lang: 'es' }));
    assert.equal(search.type, 'result');
    if (search.type !== 'result') return;
    const response = search.result as { results: Array<{ id: string }>; lang: string; semantic: boolean };
    assert.equal(response.lang, 'es');
    assert.equal(response.results[0].id, '/es/plans#_top');
    assert.equal(search.summary, '3 resultados');

    const read = await readDocsTool.run({ id: '/es/plans#límites' }, ctx({ lang: 'es' }));
    assert.equal(read.type === 'result' && read.summary, 'Límites');
    // Results always fit the runner's tool result cap (pages instead of a cut).
    for (const id of ['/tts', '/es/tts', '/commands/built-in']) {
        for (let page = 1, pages = 1; page <= pages; page++) {
            const outcome = await readDocsTool.run({ id, page }, ctx());
            assert.ok(outcome.type === 'result');
            if (outcome.type !== 'result') return;
            const result = outcome.result as { pages: number };
            pages = result.pages;
            assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SITE_AGENT_LIMITS.toolResultBytes, `${id} page ${page}`);
        }
    }
    const missing = await readDocsTool.run({ id: '/plans#prices' }, ctx());
    assert.ok(missing.type === 'result' && missing.summary === 'Not found');
    assert.ok(missing.type === 'result' && (missing.result as { closest: string[] }).closest.includes('/plans#monthly-plans'));
});

test('search_ast_functions reuses the docs assistant catalog search', async () => {
    const outcome = await searchAstFunctionsAgentTool.run({ query: 'tts.skip', limit: 3 }, ctx({ lang: 'es' }));
    assert.equal(outcome.type, 'result');
    if (outcome.type !== 'result') return;
    assert.equal((outcome.result as { matches: Array<{ name: string }> }).matches[0].name, 'tts.skip');
    assert.equal(outcome.summary, '1 función');
});

test('test_command runs the safe simulation on the channel\'s plan unless told otherwise', async () => {
    const body = '%(*wins 1) saved %(*wins)';
    const onFree = await testCommandAgentTool.run(testCommandAgentTool.validate({ body }), ctx({ plan: 'free' }));
    assert.equal(onFree.type, 'result');
    if (onFree.type !== 'result') return;
    const free = onFree.result as { untrusted_data: { runs: Array<{ reply: string }> }; note: string };
    assert.equal(free.untrusted_data.runs[0].reply, 'saved', 'database variables need Premium or Pro');
    assert.match(free.note, /recorded, not performed/);
    assert.equal(onFree.summary, 'Tested (1 run)');

    const onPro = await testCommandAgentTool.run(testCommandAgentTool.validate({ body, plan: 'pro' }), ctx({ plan: 'free', lang: 'es' }));
    assert.ok(onPro.type === 'result');
    if (onPro.type !== 'result') return;
    assert.equal((onPro.result as { untrusted_data: { runs: Array<{ reply: string }> } }).untrusted_data.runs[0].reply, 'saved 1');
    assert.equal(onPro.summary, 'Probado (1 ejecución)');
});

test('warmKnowledge builds docs vectors for both languages once, even when called repeatedly', async () => {
    // Let builds started by earlier searches finish, then start from an empty cache.
    await ensureDocsVectors('en');
    await ensureDocsVectors('es');
    store.clear();
    docBatches.length = 0;
    resetDocsVectors({ pauseMs: 1 });
    warmKnowledge();
    warmKnowledge();
    for (let i = 0; i < 400 && !(docsVectorsReady('en') && docsVectorsReady('es')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(docsVectorsReady('en') && docsVectorsReady('es'), true);
    const docKeys = [...store.keys()].filter((key) => key.startsWith('site_agent:docs:vec:'));
    assert.ok(docKeys.some((key) => key.includes(':en:')) && docKeys.some((key) => key.includes(':es:')));
    assert.ok(docBatches.length > 0 && docBatches.every((size) => size <= 8), `docs batches: ${docBatches}`);
    assert.equal(docBatches.reduce((a, b) => a + b, 0), docKeys.length, 'each chunk embedded once');
    warmKnowledge();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(docBatches.reduce((a, b) => a + b, 0), docKeys.length, 'warm again = no new embedding');
});
