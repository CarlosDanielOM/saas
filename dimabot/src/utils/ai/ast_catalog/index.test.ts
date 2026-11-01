import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Fake embeddings service (records batch sizes) and fake Dragonfly (in memory).
const batches: number[] = [];
const store = new Map<string, string>();
let ttl = 0;

mock.module('../lfm2_embeddings/index.js', {
    namedExports: {
        LFM2_EMBEDDING_DIM: 1024,
        generateEmbedding: async () => ({ embedding: Array(1024).fill(0.5) }),
        generateEmbeddings: async (texts: string[]) => {
            batches.push(texts.length);
            return { embeddings: texts.map((_, i) => Array.from({ length: 1024 }, (__, d) => (i + d) % 7 / 7)) };
        },
    },
});
mock.module('../../databases/dragonfly.database.js', {
    namedExports: {
        getDragonflyClient: async () => ({
            get: async (key: string) => store.get(key) ?? null,
            set: async (key: string, value: string, options?: { EX?: number }) => { store.set(key, value); ttl = options?.EX ?? 0; return 'OK'; },
        }),
    },
});

// A query string gives each test a fresh module instance (like a new process).
const freshCatalog = (tag: string) => import(`./index.js?${tag}`) as Promise<typeof import('./index.js')>;

test('builds the catalog index in batches of 32 and caches it in Dragonfly', async () => {
    const catalog = await freshCatalog('first');
    assert.equal(await catalog.ensureAstCatalogVectors(), true);
    const total = catalog.getAstCatalog().entries.length;
    assert.equal(batches.reduce((a, b) => a + b, 0), total);
    assert.deepEqual(batches, Array.from({ length: Math.ceil(total / 32) }, (_, i) => Math.min(32, total - i * 32)));
    const [key] = [...store.keys()];
    assert.match(key, /^ast_catalog:vectors:v1:[0-9a-f]{24}$/);
    assert.equal(ttl, 30 * 86_400);
    assert.equal(Buffer.from(store.get(key)!, 'base64').byteLength, total * 1024 * 4);
});

test('a fresh process loads the cached index without calling the embeddings service', async () => {
    batches.length = 0;
    const fresh = await freshCatalog('second');
    assert.equal(await fresh.ensureAstCatalogVectors(), true);
    assert.deepEqual(batches, [], 'no embedding calls');
    const { matches, vectorSearchUsed } = await fresh.searchAstCatalog('skip the current tts message', { surface: 'authoring', maxUserLevel: 10, limit: 3 });
    assert.equal(vectorSearchUsed, true);
    assert.ok(matches.length > 0);
});

test('a corrupt cache entry is ignored and rebuilt', async () => {
    for (const key of store.keys()) store.set(key, Buffer.from('short').toString('base64'));
    batches.length = 0;
    const third = await freshCatalog('third');
    assert.equal(await third.ensureAstCatalogVectors(), true);
    assert.ok(batches.length > 0, 'rebuilt from the embeddings service');
});
