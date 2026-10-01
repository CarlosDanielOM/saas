import assert from 'node:assert/strict';
import test from 'node:test';
import { compileKeywordIndex, KeywordIndexCache, matchKeywords, normalizeKeyword, validateKeyword, type KeywordEntry } from './keywords.js';

const entry = (text: string, matchMode: KeywordEntry['matchMode'], id = text): KeywordEntry => ({ id, text, matchMode });

test('whole words, capitalization, punctuation, unicode, and repeated words', () => {
    const index = compileKeywordIndex([entry('f', 'anywhere'), entry('hormiga', 'anywhere'), entry('éxito', 'anywhere')]);
    assert.deepEqual(matchKeywords(index, 'failure hormiguero'), []);
    assert.deepEqual(matchKeywords(index, 'F! f f').map(row => row.id), ['f']);
    assert.deepEqual(matchKeywords(index, 'vi una HORMIGA hoy').map(row => row.id), ['hormiga']);
    assert.deepEqual(matchKeywords(index, '¡ÉXITO!').map(row => row.id), ['éxito']);
    assert.deepEqual(matchKeywords(index, 'éxitosa'), []);
});

test('start/exact rules, phrases, leading whitespace, and independent matches', () => {
    const index = compileKeywordIndex([entry('f', 'start'), entry('f', 'exact', 'exact'), entry('hola mundo', 'anywhere')]);
    assert.deepEqual(matchKeywords(index, ' f ').map(row => row.id), ['f', 'exact']);
    assert.deepEqual(matchKeywords(index, 'f otra falla').map(row => row.id), ['f']);
    assert.deepEqual(matchKeywords(index, 'otra falla f'), []);
    assert.deepEqual(matchKeywords(index, '¡hola mundo!').map(row => row.id), ['hola mundo']);
    assert.deepEqual(matchKeywords(index, 'hola mundoso'), []);
});

test('validation rejects commands, regexes, empty keywords and unsupported modes', () => {
    for (const text of ['', '!f', 'a.*', 'a'.repeat(61)]) assert.throws(() => validateKeyword(text, { matchMode: 'start' }));
    assert.throws(() => validateKeyword('f', { matchMode: 'regex' }));
    assert.deepEqual(validateKeyword('hola mundo', { matchMode: 'anywhere' }), { matchMode: 'anywhere' });
    assert.equal(normalizeKeyword('  HOLA   Mundo '), 'hola mundo');
});

test('simultaneous loads share one request and empty indexes stay cached', async () => {
    let reads = 0;
    const cache = new KeywordIndexCache(async () => { reads++; await Promise.resolve(); return []; });
    await Promise.all(Array.from({ length: 50 }, () => cache.get('channel')));
    await cache.get('channel');
    assert.equal(reads, 1);
});

test('invalidation discards an obsolete in-flight load and retries from shared storage', async () => {
    let resolve!: (rows: KeywordEntry[]) => void;
    let reads = 0;
    const cache = new KeywordIndexCache(async () => {
        if (++reads === 1) return new Promise<KeywordEntry[]>(done => resolve = done);
        return [entry('new', 'start')];
    });
    const stale = cache.get('channel');
    cache.invalidate('channel');
    resolve([entry('old', 'start')]);
    assert.deepEqual([...await stale].map(([word]) => word), ['new']);
    assert.equal(reads, 2);
});

test('failed cold load is retried and local TTL/capacity bound memory', async () => {
    let reads = 0;
    const cache = new KeywordIndexCache(async () => {
        if (++reads === 1) throw new Error('shared cache unavailable');
        return [];
    }, 0, 1);
    await assert.rejects(cache.get('a'));
    await cache.get('a'); await cache.get('a');
    assert.equal(reads, 3);
    const bounded = new KeywordIndexCache(async () => { reads++; return []; }, 60_000, 1);
    await bounded.get('a'); await bounded.get('b'); await bounded.get('a');
    assert.equal(reads, 6);
});
