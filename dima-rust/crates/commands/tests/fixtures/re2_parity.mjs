#!/usr/bin/env node
// Records what the reference's `re2` package (the engine of `utils/moderation/advanced.ts` and
// `variations.ts`) does with streamer-written patterns, into re2_parity_cases.json. The Rust
// test `tests/patterns.rs` replays the recording; never edit the JSON by hand.
//
// Run offline in the reference image (the application and its `node_modules`, with `re2` built
// for Node 24, are under /app), from the repository root:
//   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD":/work -w /app \
//     dimabot-ref:0c71108e node /work/dima-rust/crates/commands/tests/fixtures/re2_parity.mjs
//
// Single patterns run through `new RE2(source, 'u' | 'iu')` exactly as `compilePattern` builds
// them (the whole-word wrapper included); the combined variation rule runs through the
// reference's own `rulePatterns` and `findBlacklistMatches` from the compiled application.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const APP = process.env.DIMABOT_APP ?? '/app';
const require = createRequire(`${APP}/package.json`);
const RE2 = require('re2');
const { rulePatterns, buildVariation, withVariationSpacing } = await import(`${APP}/dist/utils/moderation/variations.js`);
const { findBlacklistMatches } = await import(`${APP}/dist/utils/moderation/advanced.js`);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const WHOLE_WORD = (source) => `(^|[^\\p{L}\\p{N}])(${source})($|[^\\p{L}\\p{N}])`;
// One text every grid pattern also runs on: ASCII, accented and other scripts, emoji, a
// combining mark, right-to-left text, every kind of line break, astral letters, folding
// specials (Kelvin sign, long s, sharp s, title case, final sigma).
const PROBE = 'aA1_ éÉ e\u0301 ñ Ωω σς 😀👍🏽 x\ny\r\nz\u2028w\u0085v ٣ قال 𐐨𐐀 ǅ ß ẞ \u212a ſ İı -.,;:!?@#$%^&*()[]{}<>|\\/"\'`~+= \t\f\v\0';

const cases = [];
// [source, ignoreCase, texts, wholeWord?]
const add = (source, ignoreCase, texts, wholeWord = false) => {
    for (const text of [].concat(texts)) cases.push({ source, ignoreCase, text, wholeWord });
};
// A grid pattern: its own texts, the probe text, both cases of the `i` flag.
const grid = (source, texts = []) => {
    for (const ignoreCase of [false, true]) add(source, ignoreCase, [...[].concat(texts), PROBE]);
};

// ---- 1. The cases recorded before (dima-rust/tests/fixtures/re2_parity.mjs). ----
[
    ['\\d+', false, '٣٤ 12'], ['\\D+', false, '12٣x'], ['\\w+', false, 'éa_1'], ['\\W+', false, 'ab é!'],
    ['\\s', false, 'a\u00a0b c'], ['\\S+', false, '  ñx'], ['[\\d]+', false, 'x٣9'], ['[^\\W]+', false, 'é_z'],
    ['[\\w-]+', false, 'é-a_b'], ['[^\\d\\s]+', false, '1 ab2'], ['\\bcat\\b', false, 'écat'], ['\\Bat', false, 'cat at'],
    ['[[]', false, 'a[b'], ['[]a]', false, 'x]'], ['[a&&b]+', false, '&&'], ['[~~]+', false, 'a~~'],
    ['[a--b]+', false, 'x-a'], ['[[:digit:]]+', false, 'ab12'], ['[\\]]', false, 'a]'], ['[\\[\\]]+', false, '[]'],
    ['hola', true, '¡HOLA!'], ['árbol', true, 'ÁRBOL'], ['k', true, '\u212a'], ['\\w', true, '\u212a'],
    ['s', true, 'ſ'], ['σ', true, 'ς'], ['ß', true, 'SS'], ['i', true, 'İ'], ['spam', false, 'SPAM'],
    ['\\p{L}+', false, '12ñandú'], ['\\p{N}+', false, 'a٣4'], ['\\P{L}+', false, 'ab12'], ['\\pL+', false, '1ab'],
    ['\\u00e9', false, 'é'], ['\\x41', false, 'A'], ['\\u{1F600}', false, '😀'], ['😀+', false, 'a😀😀'],
    ['\\p{Emoji}', false, '😀'], ['\\p{Greek}+', false, 'aαβ'],
    ['\\/', false, '/'], ['\\-', false, '-'], ['\\<', false, '<'], ['\\>', false, '>'], ['\\!', false, '!'],
    ['\\@', false, '@'], ['\\#', false, '#'], ['\\ ', false, ' '], ['\\.', false, 'a.'], ['\\cJ', false, '\n'],
    ['\\0', false, '\0'], ['\\t', false, '\t'], ['\\n', false, '\n'], ['\\e', false, 'e'], ['\\z', false, 'z'],
    ['a{', false, 'a{'], ['a{1', false, 'a{1'], ['a{,2}', false, 'a{,2}'], ['}', false, '}'], ['a{2}', false, 'aaa'],
    ['x{2,}', false, 'xxx'], ['x{1,2}?', false, 'xx'], ['[{}]+', false, '{}'],
    ['^a', false, 'b\na'], ['a$', false, 'a\nb'], ['.', false, '\r'], ['.', false, '\u2028'], ['.', false, '\n'],
    ['a.c', false, 'a😀c'], ['a|ab', false, 'ab'], ['(?<n>ab)', false, 'ab'], ['(?:ab)+', false, 'ababx'],
    ['(?i)ab', false, 'AB'], ['(?s).', false, '\n'], ['(a+)+$', false, 'aaaa'],
    ['(a)\\1', false, 'aa'], ['a(?=b)', false, 'ab'], ['(?<=a)b', false, 'ab'], ['a(?!b)', false, 'ac'],
    ['[\\b]', false, '\b'], ['(', false, '('], ['a**', false, 'aa'], ['a*+', false, 'aa'], ['a+*', false, 'aa'],
    ['a*?', false, 'aa'], ['a??', false, 'a'], ['a*??', false, 'aa'], ['a{2}*', false, 'aa'], ['a{2}{3}', false, 'aaaaaa'],
    ['a{2}?', false, 'aaa'], ['(a*)*', false, 'aa'], ['*a', false, 'a'], ['a|*', false, 'a'], ['a\\**', false, 'a**'],
    ['[*]*', false, '**'], ['(?:a)?', false, 'a'], ['[z-a]', false, 'a'], ['\\k<n>', false, 'k'],
    ['f+r+e+e+\\s*v+b+u+c+k+s+', true, 'FREEE  vbuckss now'], ['[a@4]ss', true, 'cl@ss'],
    ['(?:https?://)?\\S+\\.(?:com|net)', true, 'visit spam.net'], ['b[i1!]tch', true, 'B1TCH'],
    ['s+p+a+m+', true, 'sssppaam'], ['\\d{3}-\\d{4}', false, 'call 555-1234'],
    ['spam', true, 'spammer spam!', true], ['spam', true, 'nospam', true], ['spam', true, 'é spam é', true],
    ['spam', true, 'ñspam', true], ['spam', true, '😀spam', true], ['ab|abc', true, 'abc', true],
].forEach(([source, ignoreCase, text, wholeWord]) => add(source, ignoreCase, text, wholeWord));

// ---- 2. The cases written from RE2's documentation (syntax.txt, parse.cc), now recorded. ----
[
    ['a{1000}', false, 'a'], ['a{1001}', false, 'a'], ['a{2,1001}', false, 'a'], ['a{1001,}', false, 'a'],
    ['(?:a{2}){500}', false, 'a'], ['(?:a{2}){501}', false, 'a'], ['((a{10}){10}){10}', false, 'a'],
    ['((a{10}){10}){11}', false, 'a'], ['(a{10}|b{200}){5}', false, 'b'], ['(a{10}|b{200}){6}', false, 'b'],
    ['(a{1000}){0,1}', false, 'b'], ['(?:a{1000})*', false, 'b'], ['x{0}y', false, 'y'],
    ['(?x)a b', false, 'ab'], ['(?u)a', false, 'a'], ['(?R)a', false, 'a'], ['(?ii)a', false, 'A'],
    ['(?i-i)a', false, 'A'], ['(?-i)a', true, 'A'], ['(?)a', false, 'a'], ['(?-)a', false, 'a'],
    ['(?i-)a', false, 'a'], ['(?i-:a)', false, 'a'], ['(?--i)a', false, 'a'], ['(?sm:^.$)', false, 'x\n\ny'],
    ['(?s:a.b)', false, 'a\nb'], ['(?m)^b', false, 'a\nb'], ['(?U)a+', false, 'aaa'], ['(?#comment)a', false, 'a'],
    ['(?P=n)', false, 'a'],
    ['\\Qa.b\\E', false, 'axb a.b'], ['\\Q(*)', false, '(*)'], ['\\Qa\\E+', false, 'aaa'], ['[\\Q]', false, 'Q'],
    ['a\\E', false, 'a'],
    ['\\012', false, 'a\nb'], ['\\101', false, 'A'], ['\\0', false, '\0'], ['[\\060-\\071]+', false, 'x42'],
    ['\\1', false, 'a'], ['(a)\\18', false, 'a'], ['\\8', false, '8'],
    ['\\p{Greek}+', false, 'aαβ'], ['\\p{^Greek}', false, 'αa'], ['\\PL', false, 'a1'], ['\\p{greek}', false, 'α'],
    ['\\p{sc=Greek}', false, 'α'], ['\\pl', false, 'a'], ['\\p{L u}', false, 'A'],
    ['\\U0001F600', false, '😀'], ['\\C', false, 'a'], ['\\Z', false, 'a'],
    ['\\b{start}', false, 'a{start}'], ['\\B{start}', false, 'a{start}'], ['\\P{^Greek}+', false, 'aαβ'],
    ['[\\p{^L}]+', false, 'ab12'],
    ['[[:digit:]a&&b]+', false, 'x&&9'], ['[[:^alpha:]]+', false, 'ab12'], ['[^]a]+', false, ']ab'], ['[a-]+', false, 'x-a'],
    ['😀+', true, 'a😀😀b'], ['e\u0301', false, 'cafe\u0301'], ['é', false, 'cafe\u0301'], ['مرحبا', false, 'قال مرحبا!'],
    ['\u200f', false, 'a\u200fb'], ['𐐀', true, '𐐨'], ['.', false, '𐐀'], ['\\w', false, '𐐀a'], ['\\p{L}', false, '😀𐐀'],
].forEach(([source, ignoreCase, text]) => add(source, ignoreCase, text));

// ---- 3. Named groups (item 1 of P2-COMMANDS-b). ----
for (const source of [
    '(?P<word>spam)|(?P<word>scam)', '(?<word>spam)|(?<word>scam)', '(?P<n>a)(?P<m>b)', '(?<n>a)|(?<m>b)',
    '(?P<a1_>a)', '(?P<1a>a)', '(?<_>a)', '(?<é>a)', '(?<٣>a)', '(?<a\u0301>a)', '(?<Ⅻ>a)', '(?<²>a)',
    '(?<a‿b>a)', '(?<😀>a)', '(?<a.b>a)', '(?<a-b>a)', '(?<a b>a)', '(?<a[b]>a)', '(?<>a)', '(?P<>a)',
    '(?P<n', '(?P<n>a', '(?P>a)', "(?'n'a)", '(?P<n>(?P<m>a)b)', '(?P<n>a)+', '(?P<n>a){2}',
    '(?P<n>a)|(?P<N>b)', '(?<n>a)(?:(?<o>b)|(?<p>c))', '(?<n>a)\\k<n>', '(?P<n>a)(?P=n)',
]) {
    for (const ignoreCase of [false, true]) {
        add(source, ignoreCase, ['spam scam', 'ab', 'xaab', 'aa', 'ABC']);
        add(source, ignoreCase, ['spam scam', 'x ab y', 'a'], true);
    }
}

// ---- 4. A wide grid. ----
// Classes.
for (const source of [
    '[a-z]+', '[^a-z]+', '[A-Z]', '[a-c-e]+', '[-a]+', '[a\\-z]+', '[\\^a]+', '[é-ü]+', '[😀-😂]+', '[\\s\\S]',
    '[.]', '[$^]+', '[\\d\\w]+', '[\\W]', '[^\\s]+', '[^\\S]', '[\\p{Lu}]+', '[^\\p{L}]+', '[\\pN]+',
    '[[:alpha:]]+', '[[:^space:]]+', '[[:word:]]+', '[[:upper:]]+', '[[:lower:]]', '[[:punct:]]+',
    '[[:alnum:]]+', '[[:xdigit:]]+', '[[:blank:]]', '[[:cntrl:]]', '[[:graph:]]+', '[[:print:]]+',
    '[[:ascii:]]+', '[[:foo:]]', '[[:alpha]', '[a-\\d]', '[\\d-z]', '[a-]', '[]', '[^]', '[^]]', '[\\]a]+',
    '[a\\]]+', '[\\x41-\\x5a]+', '[\\u0041-\\u005A]+', '[\\u{1F600}-\\u{1F64F}]+', '[\\0-\\x1f]+',
    '[\\t\\n]', '[\\cA-\\cZ]', '[ab&&bc]', '[a||b]', '[\\p{Greek}\\d]+', '[^\\p{Greek}a]+', '[ä]', '[aä]+',
    '[\\-]', '[a-a]', '[\\.-\\/]+', '[\\w&&\\d]', '[\\b]', '[\\B]', '[\\A]', '[\\z]', '[\\Q]', '[\\C]',
]) grid(source, ['ABC xyz-é', '[]^$.-']);
// Anchors, with and without multi-line mode.
for (const source of [
    '^', '$', '^a', 'a$', '^$', '\\A', '\\z', '\\Aa', 'a\\z', '(?m)^', '(?m)$', '(?m)^y', '(?m)x$',
    '(?m)^z', '(?m)a$', '(?m)\\Ay', '(?m)x\\z', '(?m:^y)', '(?-m)^y', '(?m)(?-m:^y)', '^^a', 'a$$',
    '(?m)^$', 'x$\\n', '(?m)x$\\ny', '(?s)x.^', 'a^b', 'a\\Ab', '(?m)\\z',
]) grid(source, ['x\ny', 'x\r\ny', 'a\n', '\na', 'a\nb\n']);
// Case folding on non-ASCII text.
for (const source of [
    'é', 'É', 'ÉCOLE', 'σ', 'Σ', 'ς', 'ǅ', 'ǆ', 'Ǆ', 'ﬀ', 'ff', 'ß', 'ẞ', 'ss', 'Ж', 'ж', 'Ꭰ', 'ꭰ', '𐐀', '𐐨',
    'k', 'K', '\u212a', 'å', 'Å', '\u212b', 'µ', 'μ', 'Μ', 'ı', 'I', 'i', 'İ', 'ſ', 's', 'S', 'ǈ', 'ϑ', 'θ',
    '[a-z]+', '[A-Z]+', '[k-l]', '[r-t]', '\\p{Lu}', '\\p{Ll}', '\\p{Lt}', '[^a-z]', '[^k]', 'straße',
    'ΣΊΣΥΦΟΣ', 'ñandú', 'ÑANDÚ', 'Ǆemal',
]) grid(source, ['ÉCOLE école Straße STRASSE ΣΊΣΥΦΟΣ σίσυφος Ñandú ǅemal Ǆ ǆ ﬀ ff Ꭰꭰ']);
// `\b`, `\B`, `\w`, `\W` next to accented letters, digits of other scripts and emoji.
for (const source of [
    '\\b', '\\B', '\\bé', 'é\\b', '\\ba', 'a\\b', '\\b😀', '😀\\b', '\\B😀', '\\w+', '\\W+', '\\w\\b',
    '\\bnaïve\\b', 'na\\Bïve', '\\b\\w+\\b', '\\B\\w', '\\w\\B', 'e\\b', '\\b\u0301', '\\b٣', '_\\b',
    '\\b_', '(?i)\\w+', '\\bx\\b', '(?s)\\b.', 'k\\b',
]) grid(source, ['naïve café', 'é a😀b', 'cafe\u0301 x', 'a٣b _a_', '😀😀', '\u212a\u212a k']);
// Dot and line breaks.
for (const source of [
    '.', '.+', '(?s).', '(?s).+', 'a.b', '(?s)a.b', '[^a]', '[^a]+', '.$', '(?m).$', '^.', '(?-s).',
    '(?s:.)(?-s:.)', '\\r\\n', '\\N', '.{2}', '(?s).{3}',
]) grid(source, ['a\nb', 'a\r\nb', 'a\u2028b', 'a\u0085b', '\n', '\r']);
// Lazy and greedy counts.
for (const source of [
    'a{2,4}', 'a{2,4}?', 'a{2,}?', 'a+?', 'a*?b', 'a??b', '(?U)a+', '(?U)a+?', '(?U)a{2,4}', '(?U)a{2,4}?',
    'a{0}', 'a{0,0}', 'a{,3}', 'a{3,2}', 'a{ 2}', 'a{2 }', 'a{2,3,4}', 'a{-1}', 'a{1000,1000}', 'a{01}',
    'a{0001}', 'a{2}{2}', '(?:a{2}){2}', 'a{2}+', 'a{2}?', 'a{2}??', '(ab)*?c', '(ab)+?', '(a|ab)(c|bcd)',
    '(a+)(b+)?', 'x*', 'x+x+', '(?:a?){3}', 'a{1,1000}', '😀{2}', 'é+?', '(?U)(?-U:a+)',
]) grid(source, ['aaaaab', 'abababc', 'abcd', 'a{,3} a{ 2}', '😀😀😀 ééé']);
// Escapes: every printable ASCII character after a backslash, outside and inside a class.
for (let code = 0x21; code < 0x7f; code++) {
    const ch = String.fromCharCode(code);
    add(`\\${ch}`, false, [ch, `a${ch}b`, PROBE]);
    add(`[\\${ch}]`, false, [ch, PROBE]);
}
for (const source of [
    '\\a', '\\f', '\\v', '\\r', '\\x7', '\\x7g', '\\x{41}', '\\x{1F600}', '\\x{110000}', '\\x{}', '\\u004',
    '\\u{}', '\\u{110000}', '\\u{41', '\\uD83D\\uDE00', '\\ud83d', '\\cA', '\\ca', '\\c1', '\\c', '\\c@',
    '\\c[', '\\pN', '\\p{Han}', '\\p{Latin}', '\\p{Any}', '\\p{Cyrillic}+', '\\p{Lu}', '\\p{Nd}', '\\p{Sm}',
    '\\p{Zs}', '\\p{Cc}', '\\p{Mn}', '\\p{Emoji_Presentation}', '\\p{Extended_Pictographic}', '\\p{Script=Greek}',
    '\\p{Letter}', '\\p{L', '\\p{}', '\\p', '\\P{^L}', '\\p{^^L}', '\\o{12}', '\\h', '\\G', '\\K', '\\R', '\\X',
    '\\12', '\\00', '\\000', '\\0000', '\\08', '\\400', '\\777', '\\377', '\\99', 'a\\', '\\Q', '\\Q\\E',
    '\\Qa\\Eb\\Qc', '\\Q\\\\E', '\\Qa\\\\Eb', '\\Q[a]\\E+', '\\Qé😀\\E', '(\\Qa)b\\E)', '[\\Qab\\E]',
    '\\E', 'a\\Eb', '\\Q\\Q\\E', '\\x{41}\\u{42}',
]) grid(source, ['\x07\f\v\r A😀 \x01 \x1b é 中 Ω Я 12 ٣ + \u00a0']);
// Flags.
for (const source of [
    '(?i)a', '(?i:a)b', '(?-i:a)', '(?i)(?-i)a', '(?im-s:a.$)', '(?ims)a', '(?U)', '(?i)', '(?:)', '(?)',
    '(?i)é', '(?i:ÉCOLE)', 'a(?i)b', '(?i)a|b', '(a(?i)b)c', '(?s-i:.)', '(?smU-i:a.+)', '(?I)a', '(?J)a',
    '(?n)a', '(?c)a', '(?=a)', '(?!a)', '(?<!a)b', '(?>a)', '(?|a)', '(?1)', '(?R)', '(?&n)', '(*ACCEPT)',
    '(?^)a', '(?^i)a', '(?a)a', '(?d)a', '(?l)a',
]) grid(source, ['aA éÉ ab aB AB école ÉCOLE a\nb']);
// Hostile shapes that must compile bounded or fail.
for (const source of [
    '(x+x+)+y', '(a|a)*c', '(((a*)*)*)*b', '(?:a{1000}){1}', '(?:(?:a{10}){10}){10}', '\\p{L}{1000}',
    '[\\s\\S]{1000}', '(?:\\w{100}){10}', '.{1000}', '(?:.{100}){10}',
]) add(source, true, ['x'.repeat(50), 'a'.repeat(40) + 'c']);

// Property names and sets as the package rewrites them, surrogate escapes, POSIX names, and
// the package's naive idea of being inside a class.
for (const source of [
    '\\p{gc=Lu}', '\\p{General_Category=Letter}', '\\p{gc=Letter}', '\\p{scx=Greek}', '\\p{scx=Grek}',
    '\\p{Script_Extensions=Hira}', '\\p{scx=Hani}+', '\\P{scx=Greek}', '\\p{scx=greek}', '\\p{Script=greek}',
    '\\P{sc=Greek}', '\\p{^sc=Greek}', '[\\p{sc=Greek}]+', '[^\\p{scx=Greek}]+', '\\p{Uppercase_Letter}',
    '\\p{Cased_Letter}', '\\p{LC}', '\\p{ASCII}+', '\\P{ASCII}+', '[^\\P{ASCII}]+', '[\\P{ASCII}]+', '\\p{^Emoji}',
    '\\p{gc=Emoji}', '\\p{Alpha}+', '\\p{AHex}+', '\\p{Lowercase}+', '\\P{Lowercase}+', '\\p{Lower}',
    '\\p{White_Space}+', '\\p{Any}', '[\\p{Any}]', '\\P{Any}', '\\p{^Any}', '\\pé', '\\p{^}', '\\p{^L}+', '\\P{^L}+',
    '\\p{Latn}', '\\p{Latin}+', '\\p{C}', '\\P{C}', '\\p{Cs}', '[\\p{Cs}a]', '\\p{Cn}', '\\p{Co}', '\\p{Yi}',
    '\\p{Assigned}', '\\p{Emoji_Modifier}', '\\p{Regional_Indicator}+', '\\p{Beria_Erfe}', '\\p{scx=Sidt}',
    '[[:alpha:]\\p{Emoji}]+', '\\Q[\\E\\p{Emoji}', '[]\\p{Emoji}]+', '\\Q\\p{Emoji}\\E', '[\\p{Emoji}-z]',
    '[a-\\p{Emoji}]', '[\\p{Emoji}]+', '[^\\p{Emoji}]+', '[\\P{Emoji}a]', '\\Qa/b\\E', '\\Q(?<n>a)\\E',
    '\\Q\\u0041\\E', '\\Q\\cA\\E', '[[:alpha] :]', '[[:alpha:]', '[[:alpha:]-z]', '[a-[:alpha:]]',
    '\\uD83D[\\uDE00-\\uDE4F]', '[\\uD800-\\uDFFF]', '[\\u0041-\\uD83D]+', '[\\uD83D-\\uFFFF]', '[^\\uD83D]',
    '[\\uD83D]', '\\x{D800}', '\\x{110000}', '\\x{10FFFF}', '\\uFFFF', '\\u{10FFFF}', '\\u00411', '\\u{d83d}',
    '[\\x{D800}-\\x{E000}]', '\\ud83d\\ude00+', '\\u{1F600}\\u{1F601}',
]) grid(source, ['ks K ſ αβγ ひらがな 漢字 😀🇪🇸 \u0378 \ue000 A1 [] :]', 'aA-z{}']);

// ---- 5. Unicode in the source and the text. ----
for (const source of [
    '😀', '👍🏽', '👍', '🏽', '\u0301', 'e\u0301', 'é', 'قال', 'ق', '\u200f', '[😀👍]+', '[^😀]', '😀{2,}',
    '(?:😀|👍)+', '𐐨+', '[𐐀-𐐿]+', '中文', '[一-龥]+', '\\p{Han}+', '\\p{Arabic}+', '\\p{Hebrew}+', 'שלום',
]) grid(source, ['😀😀 👍🏽 cafe\u0301 café قال مرحبا שלום 中文字 𐐨𐐀']);

// ---- 6. Whole-word patterns (compilePattern's wrapper). ----
for (const source of [
    'spam', 's+p+a+m+', '\\Qspam', '\\Qspam\\E', '\\Q)(\\E', 'a)|(b', '(?i)SPAM', 'spam|spammer',
    'spammer|spam', '\\bspam', 'spam\\b', '^spam', 'spam$', '(?m)^spam$', 'sp(a)m', '(?P<w>spam)', '😀', 'é',
    '\\d+', '\\w+', '.', '.+', 'x*', '(?:)', '\\s*spam', ' spam', 'é+', 'ñ', '٣', '\u0301', '[^a]', '\\S+',
    'a{0}', 'spam(?i)', '(?s).', 'spam\\z', '\\Aspam',
]) {
    for (const ignoreCase of [false, true]) add(source, ignoreCase, [
        'spam', 'no spam here', 'spammer spam!', 'nospam', 'é spam é', 'ñspam', '😀spam', ' spam', 'SPAM',
        'x\nspam\ny', 'a)(b', '😀 é ñ ٣ 12', 'cafe\u0301', '', PROBE,
    ], true);
}

// ---- 7. Combined variation rules: `rulePatterns` and `findBlacklistMatches` (item 2). ----
const alternations = [];
// `components` become overrides of distinct terms; `generated` are terms built by buildVariation.
const addRule = (name, { components = [], generated = [], mode = 'common', allowSpaces = false }, texts) => {
    const overrides = components.map((source, index) => ({ term: `term${index}`, source }));
    const entries = [
        ...overrides.map(({ term }) => buildVariation(term)),
        ...generated.map(([term, spellings]) => buildVariation(term, spellings)),
    ];
    const rule = { variations: { mode, entries, overrides, allowSpaces } };
    let patterns;
    try { patterns = rulePatterns(rule); } catch (error) { patterns = String(error.message); }
    const combined = Array.isArray(patterns) ? patterns.at(-1) : null;
    // The components as rulePatterns joins them (overrides, or the recompiled generated source).
    const parts = entries.map(entry => overrides.find(item => item.term === entry.term)?.source
        ?? withVariationSpacing(entry, allowSpaces, mode).pattern.source);
    if (combined && combined.source !== `(?:${parts.map(part => `(?:${part})`).join('|')})`) throw new Error(`unexpected combination in ${name}`);
    const results = [].concat(texts).map(text => {
        try {
            const match = findBlacklistMatches(text, [], [combined])[0];
            return { text, expected: match ? [match.start, match.end] : null };
        } catch {
            return { text, expected: 'error' };
        }
    });
    alternations.push({ name, components: parts, results });
};
addRule('priority by order', { components: ['ab', 'abc', 'a'] }, ['abc', 'ab abc', 'a', 'x abc ab']);
addRule('the first match wins even when empty', { components: ['x*', 'spam'] }, ['spam', ' spam', 'x spam', '']);
addRule('the wrapper prefers ^ over a guard character', { components: ['spam', ' spam'] }, [' spam', 'spam', 'a spam']);
addRule('the guard character comes before a later start', { components: ['b', ' a'] }, [' a b', 'b a', ' a', '- b']);
addRule('flags stay inside their component', { components: ['(?-i)SPAM', 'scam(?-i)', '(?s)a.b', 'x'] }, ['spam', 'SPAM', 'SCAM', 'a\nb', 'x']);
addRule('anchors inside components', { components: ['^spam', 'scam$', '(?m)^ham$'] }, ['spam', 'a spam', 'scam', 'scam b', 'a\nham\nb']);
addRule('the same group name in two components', { components: ['(?P<w>spam)', '(?P<w>scam)'] }, ['spam', 'scam']);
addRule('different group names', { components: ['(?P<w>spam)', '(?P<v>scam)', '(sc)(am)'] }, ['spam', 'scam']);
addRule('an unterminated \\Q swallows the rest', { components: ['\\Qspam', 'scam'] }, ['spam', 'scam']);
addRule('a terminated \\Q', { components: ['\\Qsp.m\\E', 'scam'] }, ['sp.m', 'spam', 'scam']);
addRule('an unterminated \\Q in the last component', { components: ['scam', '\\Qspam'] }, ['spam', 'scam']);
addRule('emoji and accents', { components: ['😀+', 'é+', 'cafe\u0301'] }, ['a 😀😀 b', 'éé', 'cafe\u0301', 'ñ é']);
addRule('generated variations', { generated: [['spam', ['spm', 'spamm']], ['free vbucks', ['fre vbucks']], ['ab', []]] },
    ['SSSPAM now', 'fre   vbuckss', 'ab', 'abab', 'x spm y']);
addRule('generated variations with spaces', { generated: [['spam', ['spm']], ['scam', []]], allowSpaces: true },
    ['s p a m', 'sc a m', 'spam']);
addRule('broad generated variations', { generated: [['spam', ['spm']], ['toast', []]], mode: 'broad' },
    ['5p4m', 'T0@57', '$$pam']);
// Over the old 256 KiB cap: 200 components of about 1,500 characters each.
const long = Array.from({ length: 200 }, (_, index) => `(?:${Array.from({ length: 60 }, (_, word) =>
    `w${index}x${word}[é3]+z`).join('|')})`);
addRule('200 long components over 256 KiB', { components: long }, ['hello w199x59ééz and', 'w0x0éz', 'w100x7333z', 'nothing']);
// Valid alone but too large for RE2's memory budget once combined.
const wide = Array.from({ length: 200 }, (_, index) => `${String.fromCharCode(97 + (index % 26))}[ab]{1000}[cd]{1000}[ef]{1000}`);
addRule('valid components too large together', { components: wide }, ['a' + 'a'.repeat(1000) + 'c'.repeat(1000) + 'e'.repeat(1000)]);

// ---- The name tables the translator needs, from the package's own sources. ----
// Written to src/patterns/re2_names.rs: RE2's Unicode groups and POSIX classes (what RE2 itself
// accepts after `\p` and in `[:name:]`), and the `re2` package's binary properties, script
// extensions and long general-category names (what it rewrites before RE2 sees the pattern).
const RE2_DIR = `${APP}/node_modules/re2`;
const read = (path) => readFileSync(`${RE2_DIR}/${path}`, 'utf8');
const between = (text, start, end) => {
    const from = text.indexOf(start);
    if (from < 0) throw new Error(`missing ${start}`);
    return text.slice(from, text.indexOf(end, from));
};
const groupNames = (text) => [...text.matchAll(/^\s*\{ "((?:[^"\\]|\\.)+)", [+-]1,/gm)].map(match => match[1]);
const tableNames = (text) => [...text.matchAll(/^\s*\{"([^"]+)", kRanges_/gm)].map(match => match[1]);
const unicodeGroups = read('vendor/re2/re2/unicode_groups.cc');
const perlGroups = read('vendor/re2/re2/perl_groups.cc');
const properties = read('lib/unicode_properties.h');
const patternCc = read('lib/pattern.cc');
const tables = {
    RE2_UNICODE_GROUPS: groupNames(between(unicodeGroups, 'const UGroup unicode_groups[]', '};')),
    RE2_POSIX_GROUPS: groupNames(between(perlGroups, 'const UGroup posix_groups[]', '};')),
    JS_BINARY_PROPERTIES: tableNames(between(properties, 'kBinaryProperties[]', '};')),
    JS_SCRIPT_EXTENSIONS: tableNames(between(properties, 'kScriptExtensions[]', '};')),
};
const longCategories = [...between(patternCc, 'unicodeClasses', '};').matchAll(/\{"(\w+)", "(\w+)"\}/g)]
    .map(match => [match[1], match[2]]);
if (Object.values(tables).some(names => names.length < 10) || longCategories.length < 30) throw new Error('name tables not found');
const rustString = (text) => JSON.stringify(text);
const tableFile = [
    '// Generated by tests/fixtures/re2_parity.mjs from the `re2` package in the reference image; do not',
    '// edit by hand. Sources (sha256):',
    ...['vendor/re2/re2/unicode_groups.cc', 'vendor/re2/re2/perl_groups.cc', 'lib/unicode_properties.h', 'lib/pattern.cc']
        .map(path => `//   ${path} ${createHash('sha256').update(read(path)).digest('hex')}`),
    `// re2 ${require('re2/package.json').version}`,
    '',
    ...Object.entries(tables).flatMap(([name, names]) => [
        `pub(super) const ${name}: &[&str] = &[`,
        ...names.map(item => `    ${rustString(item)},`),
        '];',
    ]),
    'pub(super) const JS_LONG_CATEGORIES: &[(&str, &str)] = &[',
    ...longCategories.map(([long, short]) => `    (${rustString(long)}, ${rustString(short)}),`),
    '];',
    '',
].join('\n');
writeFileSync(new URL('../../src/patterns/re2_names.rs', import.meta.url), tableFile);

// ---- Record. ----
const run = ({ source, ignoreCase, text, wholeWord }) => {
    const flags = ignoreCase ? 'iu' : 'u';
    try {
        const match = new RE2(wholeWord ? WHOLE_WORD(source) : source, flags).exec(text);
        if (!match) return null;
        if (!wholeWord) return [match.index, match.index + match[0].length];
        const start = match.index + (match[1]?.length ?? 0);
        return [start, start + match[2].length];
    } catch {
        return 'error';
    }
};
const seen = new Set();
const unique = cases.filter(item => {
    const key = JSON.stringify(item);
    return !seen.has(key) && seen.add(key);
});
const recorded = unique.map(item => ({ ...item, expected: run(item) }));
// What saving checks first: `new RE2(source, flags).test('')`.
const validation = [];
const validated = new Set();
for (const { source, ignoreCase } of unique) {
    const key = JSON.stringify([source, ignoreCase]);
    if (validated.has(key)) continue;
    validated.add(key);
    let result;
    try { result = new RE2(source, ignoreCase ? 'iu' : 'u').test('') ? 'empty' : 'ok'; } catch { result = 'error'; }
    validation.push({ source, ignoreCase, result });
}
const output = {
    generator: 'dima-rust/crates/commands/tests/fixtures/re2_parity.mjs',
    node: process.version,
    re2: require('re2/package.json').version,
    sources: Object.fromEntries(['src/utils/moderation/advanced.ts', 'src/utils/moderation/variations.ts']
        .map(path => [path, sha256(`${APP}/${path}`)])),
    cases: recorded,
    validation,
    alternations,
};
// One case per line, so a re-recording diffs line by line.
const json = Object.entries(output).map(([key, value]) => `${JSON.stringify(key)}: ${Array.isArray(value)
    ? `[\n${value.map(item => JSON.stringify(item)).join(',\n')}\n]` : JSON.stringify(value)}`);
writeFileSync(new URL('./re2_parity_cases.json', import.meta.url), `{\n${json.join(',\n')}\n}\n`);
console.log(`wrote ${recorded.length} cases, ${validation.length} validations, ${alternations.length} combined rules`);
