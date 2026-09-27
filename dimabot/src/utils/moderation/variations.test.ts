import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariation, variationMode, variationTerms, rulePatterns, museVariationRequest, VARIATION_MODEL } from './variations.js';
import { findBlacklistMatches } from './advanced.js';
const matches = (term: string, text: string, variants: string[] = []) => findBlacklistMatches(text, [], [buildVariation(term, variants).pattern]).length > 0;
test('common variants stretch repeated letters while preserving word boundaries and literal punctuation', () => {
    for (const text of ['Rin', 'Riiin', 'Rinnnn', '🎉 Rinn!']) assert.ok(matches('Rinn', text), text);
    for (const text of ['bring', 'string', 'árinn', '水Rinn']) assert.equal(matches('Rinn', text), false, text);
    assert.ok(matches('café', 'CAAAFE'));
    assert.ok(matches('bad word', 'baaadd   wooord'));
    assert.ok(matches('a.b', 'a.b'));
    assert.equal(matches('a.b', 'axb'), false);
    assert.equal(matches('aa', 'a'), false, 'short terms do not expand');
});
test('broader literal spellings compile into bounded patterns and never become regex instructions', () => {
    const variants = ['fcky', 'facky', 'fucky', 'fucking'];
    for (const word of variants) assert.ok(matches('fuck', word, variants));
    assert.equal(matches('fuck', 'firetruck', variants), false);
    assert.throws(() => buildVariation('fuck', ['.*']));
    assert.throws(() => buildVariation('fuck', ['unrelated']));
    assert.throws(() => buildVariation('ab', ['ac']));
    assert.throws(() => buildVariation('fuck', Array(9).fill('fck')));
    assert.equal(matches('a.b', 'anything', ['a.*']), false, 'literal metacharacters escaped');
});
test('multiple words per rule are separate from the ten manually entered patterns', () => {
    const entries = Array.from({ length: 200 }, (_, i) => buildVariation(`word${i}`));
    const patterns = rulePatterns({ variations: { mode: 'common', entries } });
    assert.equal(patterns.length, 1, 'all generated words share one compiled expression');
    assert.ok(findBlacklistMatches('wooord199', [], patterns).length);
    assert.equal(rulePatterns({ variations: { mode: 'off', entries } }).length, 0);
});
test('validate mode and word list; Muse receives only terms with bounded structured generation', () => {
    assert.equal(variationMode(undefined), 'off');
    assert.throws(() => variationMode({ mode: 'wildcards' }));
    assert.throws(() => variationTerms(Array(201).fill('word')));
    assert.deepEqual(variationTerms([' Rinn ', 'rinn', 'fuck']), ['rinn', 'fuck']);
    const request = museVariationRequest(['fuck', 'rinn']);
    assert.equal(request.model, VARIATION_MODEL);
    assert.equal(request.model, 'meta/muse-spark-1.3-contributor');
    assert.equal(request.response_format.type, 'json_schema');
    assert.deepEqual(JSON.parse(request.messages[1].content), { terms: ['fuck', 'rinn'] });
});
