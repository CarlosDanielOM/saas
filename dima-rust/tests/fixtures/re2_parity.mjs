#!/usr/bin/env node
// Regenerates re2_parity_cases.rs from dimabot's node `re2`, the engine the
// TypeScript moderation helpers use. Run from the repository root:
//   node dima-rust/tests/fixtures/re2_parity.mjs
// The Rust test `re2_compat::tests::matches_node_re2_corpus` compares against it.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(new URL('../../../dimabot/package.json', import.meta.url));
const RE2 = require('re2');

const WHOLE_WORD = (source) => `(^|[^\\p{L}\\p{N}])(${source})($|[^\\p{L}\\p{N}])`;

// [source, ignoreCase, text, wholeWord?]
const cases = [
    // Perl classes are ASCII in RE2.
    ['\\d+', false, '٣٤ 12'], ['\\D+', false, '12٣x'], ['\\w+', false, 'éa_1'], ['\\W+', false, 'ab é!'],
    ['\\s', false, 'a b c'], ['\\S+', false, '  ñx'], ['[\\d]+', false, 'x٣9'], ['[^\\W]+', false, 'é_z'],
    ['[\\w-]+', false, 'é-a_b'], ['[^\\d\\s]+', false, '1 ab2'], ['\\bcat\\b', false, 'écat'], ['\\Bat', false, 'cat at'],
    // Class syntax that differs between JavaScript and the regex crate.
    ['[[]', false, 'a[b'], ['[]a]', false, 'x]'], ['[a&&b]+', false, '&&'], ['[~~]+', false, 'a~~'],
    ['[a--b]+', false, 'x-a'], ['[[:digit:]]+', false, 'ab12'], ['[\\]]', false, 'a]'], ['[\\[\\]]+', false, '[]'],
    // Case folding.
    ['hola', true, '¡HOLA!'], ['árbol', true, 'ÁRBOL'], ['k', true, 'K'], ['\\w', true, 'K'],
    ['s', true, 'ſ'], ['σ', true, 'ς'], ['ß', true, 'SS'], ['i', true, 'İ'], ['spam', false, 'SPAM'],
    // Unicode properties and escapes.
    ['\\p{L}+', false, '12ñandú'], ['\\p{N}+', false, 'a٣4'], ['\\P{L}+', false, 'ab12'], ['\\pL+', false, '1ab'],
    ['\\u00e9', false, 'é'], ['\\x41', false, 'A'], ['\\u{1F600}', false, '😀'], ['😀+', false, 'a😀😀'],
    ['\\p{Emoji}', false, '😀'], ['\\p{Greek}+', false, 'aαβ'],
    // Escapes and literals.
    ['\\/', false, '/'], ['\\-', false, '-'], ['\\<', false, '<'], ['\\>', false, '>'], ['\\!', false, '!'],
    ['\\@', false, '@'], ['\\#', false, '#'], ['\\ ', false, ' '], ['\\.', false, 'a.'], ['\\cJ', false, '\n'],
    ['\\0', false, '\0'], ['\\t', false, '\t'], ['\\n', false, '\n'], ['\\e', false, 'e'], ['\\z', false, 'z'],
    ['a{', false, 'a{'], ['a{1', false, 'a{1'], ['a{,2}', false, 'a{,2}'], ['}', false, '}'], ['a{2}', false, 'aaa'],
    ['x{2,}', false, 'xxx'], ['x{1,2}?', false, 'xx'], ['[{}]+', false, '{}'],
    // Anchors, dot, alternation, groups.
    ['^a', false, 'b\na'], ['a$', false, 'a\nb'], ['.', false, '\r'], ['.', false, ' '], ['.', false, '\n'],
    ['a.c', false, 'a😀c'], ['a|ab', false, 'ab'], ['(?<n>ab)', false, 'ab'], ['(?:ab)+', false, 'ababx'],
    ['(?i)ab', false, 'AB'], ['(?s).', false, '\n'], ['(a+)+$', false, 'aaaa'],
    // Unsupported constructs.
    ['(a)\\1', false, 'aa'], ['a(?=b)', false, 'ab'], ['(?<=a)b', false, 'ab'], ['a(?!b)', false, 'ac'],
    ['[\\b]', false, '\b'], ['(', false, '('], ['a**', false, 'aa'], ['a*+', false, 'aa'], ['a+*', false, 'aa'],
    ['a*?', false, 'aa'], ['a??', false, 'a'], ['a*??', false, 'aa'], ['a{2}*', false, 'aa'], ['a{2}{3}', false, 'aaaaaa'],
    ['a{2}?', false, 'aaa'], ['(a*)*', false, 'aa'], ['*a', false, 'a'], ['a|*', false, 'a'], ['a\\**', false, 'a**'],
    ['[*]*', false, '**'], ['(?:a)?', false, 'a'], ['[z-a]', false, 'a'], ['\\k<n>', false, 'k'],
    // Typical moderation patterns.
    ['f+r+e+e+\\s*v+b+u+c+k+s+', true, 'FREEE  vbuckss now'], ['[a@4]ss', true, 'cl@ss'],
    ['(?:https?://)?\\S+\\.(?:com|net)', true, 'visit spam.net'], ['b[i1!]tch', true, 'B1TCH'],
    ['s+p+a+m+', true, 'sssppaam'], ['\\d{3}-\\d{4}', false, 'call 555-1234'],
    // Whole-word guard from compilePattern; match[2] is reported.
    ['spam', true, 'spammer spam!', true], ['spam', true, 'nospam', true], ['spam', true, 'é spam é', true],
    ['spam', true, 'ñspam', true], ['spam', true, '😀spam', true], ['ab|abc', true, 'abc', true],
];

const results = cases.map(([source, ignoreCase, text, wholeWord = false]) => {
    const pattern = wholeWord ? WHOLE_WORD(source) : source;
    let expected;
    try {
        const match = new RE2(pattern, ignoreCase ? 'iu' : 'u').exec(text);
        if (!match) expected = null;
        else if (wholeWord) {
            const start = match.index + (match[1]?.length ?? 0);
            expected = [start, start + match[2].length];
        } else expected = [match.index, match.index + match[0].length];
    } catch {
        expected = 'error';
    }
    return { source, ignoreCase, text, wholeWord, expected };
});

// Rust string literal with every non-printable or non-ASCII character escaped.
const rust = (text) => '"' + [...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') return '\\' + ch;
    return code >= 0x20 && code < 0x7f ? ch : `\\u{${code.toString(16)}}`;
}).join('') + '"';
const expected = (value) => value === 'error' ? 'Expected::Error'
    : value === null ? 'Expected::NoMatch' : `Expected::Match(${value[0]}, ${value[1]})`;
const lines = results.map(({ source, ignoreCase, text, wholeWord, expected: value }) =>
    `    (${rust(source)}, ${ignoreCase}, ${rust(text)}, ${wholeWord}, ${expected(value)}),`);
writeFileSync(new URL('./re2_parity_cases.rs', import.meta.url),
    '// Generated by re2_parity.mjs from node `re2`; do not edit by hand.\n'
    + '// (source, ignore_case, text, whole_word, expected UTF-16 range)\n'
    + '&[\n' + lines.join('\n') + '\n]\n');
console.log(`wrote ${results.length} cases`);
