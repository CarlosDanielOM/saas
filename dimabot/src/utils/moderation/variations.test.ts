import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariation, withVariationSpacing, variationAllowSpaces, variationMode, variationTerms, variationOverrides, rulePatterns, museVariationRequest, VARIATION_MODEL } from './variations.js';
import { findBlacklistMatches } from './advanced.js';
const matches = (term: string, text: string, variants: string[] = []) => findBlacklistMatches(text, [], [buildVariation(term, variants).pattern]).length > 0;
test('edited variations replace generated matching in both modes and reset cleanly', () => {
    for (const mode of ['common', 'broad'] as const) {
        const entries = [buildVariation('rinn', ['rin']), buildVariation('fuck', ['fcky'])];
        const overrides = variationOverrides([{ term: 'Rinn', source: 'rinn|rynn' }], ['rinn', 'fuck'], mode);
        const patterns = rulePatterns({ variations: { mode, entries, overrides } });
        assert.ok(findBlacklistMatches('RYNN', [], patterns).length);
        assert.equal(findBlacklistMatches('rin', [], patterns).length, 0, 'generated pattern is replaced');
        assert.equal(findBlacklistMatches('bring', [], patterns).length, 0);
        assert.ok(findBlacklistMatches('fcky', [], patterns).length, 'other words unaffected');
        assert.ok(findBlacklistMatches('rin', [], rulePatterns({ variations: { mode, entries, overrides: [] } })).length);
    }
    for (const source of ['(', '.*', '(?=rinn)rinn', '(rinn)\\1', 'x'.repeat(16001)]) {
        assert.throws(() => variationOverrides([{ term: 'rinn', source }], ['rinn'], 'common'));
    }
    assert.throws(() => variationOverrides([{ term: 'other', source: 'other' }], ['rinn'], 'broad'));
    assert.throws(() => variationOverrides([{ term: 'rinn', source: 'rinn' }, { term: 'Rinn', source: 'rin' }], ['rinn'], 'broad'));
    assert.throws(() => variationOverrides([{ term: 'rinn', source: 'rinn' }], ['rinn'], 'off'));
});
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

test('optional spaces catch separated letters and substitutions without removing message boundaries', () => {
    const entry = buildVariation('rinn', ['rin', 'r1n', 'r!n']);
    for (const mode of ['common', 'broad'] as const) {
        const patterns = (allowSpaces: boolean) => rulePatterns({ variations: { mode, entries: [entry], allowSpaces } });
        for (const text of ['R I N', 'r 1 n', 'r ! n', 'r i n n', 'rr ii n n', 'r  i   n', 'r\ti\tn']) {
            assert.equal(findBlacklistMatches(text, [], patterns(false)).length, 0, text);
            assert.ok(findBlacklistMatches(text, [], patterns(true)).length, text);
        }
        for (const text of ['rin', 'RINNN', 'r1n']) assert.ok(findBlacklistMatches(text, [], patterns(true)).length, text);
        for (const text of ['bring', 'string', 'ár i n', 'r i ng', 'water in', 'r i next']) assert.equal(findBlacklistMatches(text, [], patterns(true)).length, 0, text);
        const text = '🎉 R I N!';
        const [match] = findBlacklistMatches(text, [], patterns(true));
        assert.equal(text.slice(match.start, match.end), 'R I N');
        const custom = rulePatterns({ variations: { mode, entries: [entry], allowSpaces: true, overrides: [{ term: 'rinn', source: 'rinn|rynn' }] } });
        assert.equal(findBlacklistMatches('R I N', [], custom).length, 0, 'custom regex is never rewritten');
    }
    const spaced = withVariationSpacing(entry, true);
    assert.equal(withVariationSpacing(spaced, false).pattern.source, entry.pattern.source, 'cached spelling compilation is reversible');
    assert.equal(withVariationSpacing(spaced, true), spaced, 'saved expressions are reused on the chat loop');
    const phrase = withVariationSpacing(buildVariation('bad word'), true);
    assert.ok(findBlacklistMatches('b a d   w o r d', [], [phrase.pattern]).length);
    assert.equal(findBlacklistMatches('badword', [], [phrase.pattern]).length, 0, 'phrase separator stays required');
    const long = 'abcdefghij'.repeat(10);
    const longEntry = withVariationSpacing(buildVariation(long, Array.from({ length: 8 }, (_, i) => long.slice(0, -1) + i)), true);
    assert.ok(longEntry.pattern.source.length <= 16000);
    assert.doesNotThrow(() => variationOverrides([{ term: long, source: longEntry.pattern.source }], [long], 'broad'));
    const many = rulePatterns({ variations: { mode: 'common', allowSpaces: true, entries: Array.from({ length: 200 }, (_, i) => buildVariation(`word${i}`)) } });
    assert.ok(findBlacklistMatches('w o r d 1 9 9', [], many).length);
    assert.equal(variationAllowSpaces(undefined), false);
    for (const raw of ['true', 1, null]) assert.throws(() => variationAllowSpaces(raw));
});
