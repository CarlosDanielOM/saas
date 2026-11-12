#!/usr/bin/env node
// Records the reference's moderation rules (dimabot/src/utils/moderation, compiled in the
// reference image at baseline 0c71108e, Node 24) into rules_corpus.json.gz for
// tests/corpus.rs. Never edit the output by hand.
//
// 1. Export the local production copy's settings (read-only) to a scratch file that is never
//    committed (the stored blocked words are streamers' content):
//      eval "$(dima-rust/tools/test-env)"
//      docker exec mongodb mongosh "$DIMA_TEST_MONGO_URI" --quiet --eval \
//        'print(EJSON.stringify(db.getSiblingDB("domdimabot").channel_moderation_settings.find().sort({_id:1}).toArray(), {relaxed:false}))' \
//        > "$SCRATCH/settings.ejson"
// 2. Run offline in the reference image, from the repository root:
//      docker run --rm --network none --user "$(id -u):$(id -g)" -e TZ=UTC -e OBSERVABILITY_DISABLED=true \
//        -v "$PWD/dima-rust/crates/moderation/tests/corpus":/work -v "$SCRATCH":/real:ro -w /app \
//        dimabot-ref:0c71108e node /work/generate.mjs /real/settings.ejson /work/rules_corpus.json.gz
//
// What the imports start: the moderation modules, the permission helpers and, through them,
// mongoose model registrations and the Dragonfly/telemetry modules (constants only: no
// connection is opened, nothing is listening, the container has no network).
//
// The fixture holds synthetic settings and messages (invented, harmless words) with their
// verdicts, and for the 28 stored settings only their ids, revisions and verdicts: messages
// that use a stored word are templates (`{{W:index:transform}}`) the Rust test expands from
// the local copy at test time, and match texts there are recorded as hashes.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const APP = process.env.DIMABOT_APP ?? '/app';
const require = createRequire(`${APP}/package.json`);
const { EJSON } = require('bson');
const mod = (file) => import(`${APP}/dist/utils/moderation/${file}`);
const { evaluateRule } = await mod('rules/index.js');
const { compileBlacklistPattern } = await mod('rules/blacklist.rule.js');
const { findBlacklistMatches } = await mod('advanced.js');
const V = await mod('variations.js');
const { resolveOffenseStep } = await mod('offenses.js');
const { parsePermitArgs } = await mod('permit.js');
const S = await mod('spam.js');
const { categoryQuestions } = await mod('spam_categories.js');
const { foldText } = await mod('normalize.js');
const { ruleExempt, createUserIdentity } = await import(`${APP}/dist/utils/permissions/index.js`);

const [realPath, outPath] = process.argv.slice(2);
if (!realPath || !outPath) throw new Error('usage: generate.mjs <settings.ejson> <out.json.gz>');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const short = (text) => '#' + sha(text).slice(0, 16);
const outcome = (run) => { try { return { ok: run() }; } catch (error) { return { error: String(error?.message ?? error) }; } };

// ---------------------------------------------------------------- Unicode classes and folding
function ranges(test) {
    const out = [];
    let start = -1;
    for (let cp = 0; cp <= 0x110000; cp++) {
        const inside = cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) && test(String.fromCodePoint(cp));
        if (inside && start < 0) start = cp;
        if (!inside && start >= 0) { out.push([start, cp - 1]); start = -1; }
    }
    return out;
}
const unicode = {
    L: ranges((c) => /\p{L}/u.test(c)),
    Lu: ranges((c) => /\p{Lu}/u.test(c)),
    M: ranges((c) => /\p{M}/u.test(c)),
    N: ranges((c) => /\p{N}/u.test(c)),
    fold: [],
};
for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    const folded = foldText(c);
    if (folded !== c) unicode.fold.push([cp, folded]);
}

// ---------------------------------------------------------------- identities
const identities = [
    ['viewer', 1, []], ['sub', 2, ['sub']], ['vip', 3, ['vip']], ['founder', 2, ['founder', 'sub']],
    ['mod', 5, ['mod']], ['editor', 6, ['editor']], ['broadcaster', 10, ['broadcaster']],
].map(([name, level, tags]) => ({ name, level, tags }));
const identityObjects = identities.map(({ name, level, tags }) => createUserIdentity(level, tags, `id-${name}`, name));

// ---------------------------------------------------------------- synthetic settings
let ruleSeq = 0;
const step = (action, timeoutSeconds = 60) => ({ action, timeoutSeconds });
const rule = (type, over = {}) => ({
    id: `rule-${++ruleSeq}`, type, enabled: true,
    firstOffense: step('warn'), secondOffense: step('delete'), thirdOffense: step('timeout', 600),
    reason: 'Synthetic rule', exemptUserLevel: 7, exemptExpression: null,
    capsThresholdMode: 'count', minCapsCount: 8, maxCapsPercentage: 70, minMessageLength: 10,
    allowlistDomains: [], maxEmoteCount: 10, terms: [], patterns: [],
    semantic: { enabled: false, thresholdPercent: 85, policy: '', examples: [], onUncertain: 'allow_and_log' },
    variations: { mode: 'off', entries: [] },
    ...over,
});
const caps = (minCapsCount, minMessageLength, over = {}) => rule('caps', { minCapsCount, minMessageLength, ...over });
const pct = (maxCapsPercentage, minMessageLength) => rule('caps', { capsThresholdMode: 'percentage', maxCapsPercentage, minMessageLength });
const links = (allowlistDomains, over = {}) => rule('links', { allowlistDomains, ...over });
const emotes = (maxEmoteCount) => rule('emote_spam', { maxEmoteCount });
const words = (terms, over = {}) => rule('blacklist', { terms, ...over });
const pattern = (id, source, boundary = 'whole_word', ignoreCase = true) => ({ id, source, boundary, ignoreCase });
const variations = (mode, entries, extra = {}) => ({ ...(mode === undefined ? {} : { mode }), entries, ...extra });
const build = (term, suggestions = []) => V.buildVariation(term, suggestions);

const BASIC_TERMS = ['zorp', 'blarg', 'buy cheap followers', 'free.money', 'c++', '$money'];
const UNICODE_TERMS = ['café', 'naïve', 'кошка', 'σοφός', '🍕pizza', 'ñoño', 'İstanbul', 'straße', '日本語', 'مرحبا', 'שלום', 'éclair'];
const EDGE_TERMS = ['  spaced   term  ', '', '   ', 'tab\tterm', 'ab', 'x', 'ZORP', null, 'line sep', 'nb sp', 'nel\u0085x'];
const MANY_TERMS = ['q'.repeat(100), ...Array.from({ length: 199 }, (_, i) => `word${i}`)];
const LONG_SPELLINGS = Array.from({ length: 40 }, (_, i) => 'longword'.repeat(12) + String(i).padStart(4, 'x'));

const synthetic = [];
const doc = (name, rules, extra = {}) => synthetic.push({
    name,
    settings: {
        _id: { $oid: (synthetic.length + 1).toString(16).padStart(24, '0') },
        channelID: `syn-${synthetic.length + 1}`, channel: name, enabled: true,
        spamProtection: { enabled: true, reviewAllMessages: false, categories: ['spam', 'ads', 'self_promotion'], exemptTags: ['mod', 'editor', 'admin'], thresholdPercent: 85 },
        offenseWindowSeconds: 3600, rules, settingsVersion: 1,
        createdAt: { $date: '2026-01-01T00:00:00.000Z' }, updatedAt: { $date: '2026-01-02T00:00:00.000Z' },
        ...extra,
    },
});
doc('caps-count', [caps(1, 1), caps(5, 5), caps(8, 10), caps(20, 30), caps(500, 1), caps(1, 500)]);
doc('caps-percent', [pct(1, 1), pct(50, 5), pct(70, 10), pct(100, 3), pct(99, 1)]);
doc('caps-fraction', [caps(7.5, 9.5), pct(66.6, 2.5), rule('caps', { capsThresholdMode: 'weird', minCapsCount: 3, minMessageLength: 3 })]);
doc('emotes', [emotes(1), emotes(3), emotes(10), emotes(100), emotes(0)]);
doc('links-none', [links([])]);
doc('links-allow', [links(['twitch.tv']), links(['youtube.com', 'clips.twitch.tv']), links(['Example.COM']), links([''])]);
doc('words-basic', [words(BASIC_TERMS)]);
doc('words-unicode', [words(UNICODE_TERMS)]);
doc('words-edge', [words(EDGE_TERMS)]);
doc('words-many', [words(MANY_TERMS)]);
doc('words-one-each', BASIC_TERMS.concat(UNICODE_TERMS).map((term) => words([term])));
doc('patterns', [words([], { patterns: [pattern('p1', 'r+i+(?:n+i+)*n+'), pattern('p2', 'Zorp', 'anywhere', false), pattern('p3', 'z(?:o|0)+rp(?:s|ed)?'), pattern('p4', '\\d{3,}', 'anywhere')] })]);
doc('patterns-unicode', [words(['blarg'], { patterns: [pattern('u1', '\\p{Lu}{4,}', 'anywhere', false), pattern('u2', 'кош+ка'), pattern('u3', '[😀-🙏]{3}', 'anywhere'), pattern('u4', '(?i)ÉCLAIR', 'whole_word', false), pattern('u5', 'x\\b', 'anywhere')] })]);
doc('pattern-byte', [words(['zorp'], { patterns: [pattern('c1', 'a\\Cb', 'anywhere')] })]);
doc('pattern-invalid', [caps(1, 1), words(['zorp'], { patterns: [pattern('bad', '(')] }), emotes(1)]);
doc('pattern-boundary-other', [words([], { patterns: [{ id: 'b1', source: 'zorp', boundary: 'start', ignoreCase: true }] })]);
const rinn = build('rinn', ['rin', 'ryn']);
const blarg = build('blarg', ['blrg', 'blarge']);
const ab = build('ab');
const cafe = build('café', ['cafe', 'caffe']);
const phrase = build('bad word');
const common = [rinn, blarg, ab, cafe, phrase];
doc('variations-common', [words([], { variations: variations('common', common, { allowSpaces: false }) })]);
doc('variations-common-spaces', [words([], { variations: variations('common', common, { allowSpaces: true }) })]);
doc('variations-broad', [words([], { variations: variations('broad', common, { allowSpaces: false }) })]);
doc('variations-broad-spaces', [words([], { variations: variations('broad', common, { allowSpaces: true }) })]);
doc('variations-precompiled', [words([], { variations: variations('broad', common.map((e) => V.withVariationSpacing(e, true, 'broad')), { allowSpaces: true }) })]);
doc('variations-overrides', [words(['zorp'], { variations: variations('common', common, { overrides: [{ term: 'rinn', source: 'rinn|rynn' }, { term: 'blarg', source: 'bl[a@]rg' }] }) })]);
doc('variations-mode-missing', [words([], { variations: variations(undefined, common) })]);
doc('variations-mode-unknown', [words([], { variations: variations('wildcards', common) })]);
doc('variations-off', [words(['zorp'], { variations: variations('off', common) })]);
doc('variations-too-long', [caps(1, 1), words(['zorp'], { variations: variations('common', [{ ...build('longword'), spellings: LONG_SPELLINGS }], { allowSpaces: true }) })]);
doc('variations-many', [words([], { variations: variations('common', Array.from({ length: 200 }, (_, i) => build(`word${i}`)), { allowSpaces: true }) })]);
doc('variations-caps-rule', [caps(1, 1, { variations: variations('common', [rinn]) }), caps(1, 1, { patterns: [pattern('cp', 'zorp')] })]);
doc('semantic', [words(['zorp'], { semantic: { enabled: true, thresholdPercent: 90, policy: 'No zorp.', examples: [], onUncertain: 'allow_and_log' } }), caps(1, 1, { semantic: { enabled: true, thresholdPercent: 85, policy: 'p', examples: [], onUncertain: 'allow_and_log' } })]);
doc('exemptions', [
    caps(1, 1, { exemptUserLevel: 1 }), caps(1, 1, { exemptUserLevel: 3 }), caps(1, 1, { exemptUserLevel: 5 }),
    caps(1, 1, { exemptUserLevel: 7 }), caps(1, 1, { exemptUserLevel: 10 }),
    caps(1, 1, { exemptExpression: { or: [{ role: 'vip' }, { role: 'sub' }] } }),
    caps(1, 1, { exemptExpression: { foo: 1 } }),
    caps(1, 1, { exemptExpression: { not: { role: 'everyone' } } }),
    caps(1, 1, { exemptExpression: { and: [{ role: 'mod' }, { not: { role: 'vip' } }] } }),
]);
doc('disabled-and-unknown', [caps(1, 1, { enabled: false }), rule('weird', { minCapsCount: 1, minMessageLength: 1 }), words(['zorp'], { enabled: false }), emotes(2)]);
doc('default-order', [caps(8, 10), links([]), emotes(10), words(['zorp', 'blarg'])], { enabled: false });
doc('missing-fields', [
    (() => { const r = caps(1, 1); delete r.minCapsCount; return r; })(),
    (() => { const r = caps(1, 1); delete r.minMessageLength; return r; })(),
    (() => { const r = emotes(1); delete r.maxEmoteCount; return r; })(),
    (() => { const r = words(['zorp']); delete r.variations; delete r.patterns; delete r.semantic; return r; })(),
]);
doc('ladders', [
    caps(1, 1, { firstOffense: step('off'), secondOffense: step('ban', 1), thirdOffense: step('timeout', 1209600) }),
    words(['zorp'], { firstOffense: step('kick', 5), secondOffense: step('timeout', 1), thirdOffense: step('delete', 0) }),
]);
doc('null-domain', [caps(1, 1), links([null, 'twitch.tv']), emotes(1)]);

// ---------------------------------------------------------------- messages
const messages = [];
const seen = new Set();
const add = (text, emoteTexts = []) => {
    const key = JSON.stringify([text, emoteTexts]);
    if (seen.has(key)) return;
    seen.add(key);
    messages.push({ text, emotes: emoteTexts });
};
for (const text of ['', ' ', 'hello', 'gg', 'GG', 'hello there how are you', '!!!', '1234567890', '😀😀😀', 'é', '​',
    'مرحبا بكم في البث', 'שלום לכולם', '日本語のテキストです', 'Hello Мир Κόσμε', '\t\n', 'x', 'X', 'ok ok ok ok ok ok ok ok ok ok']) add(text);
for (const n of [1, 3, 4, 5, 9, 10, 11, 20, 29, 30, 31, 50]) {
    for (const k of new Set([0, 1, Math.floor(n / 2), Math.ceil(n * 0.7) - 1, Math.ceil(n * 0.7), n - 1, n])) {
        if (k < 0 || k > n) continue;
        const letters = 'A'.repeat(k) + 'b'.repeat(n - k);
        add(letters);
        add(Array.from(letters).join(' ') + ' 123 !!');
    }
}
for (const text of ['ÁÉÍÓÚ ÜÑÇ ĤÊĽĻÕ', 'áéíóú üñç ça va très bien', 'ПРИВЕТ МИР КАК ДЕЛА', 'ΑΒΓΔΕΖΗΘ', 'ΟΔΟΣ ΑΣ', 'İSTANBUL ŞEHİR', 'STRASSE ẞ GROSS',
    'ǅǅǅǅǅǅǅǅǅǅ', '𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀', 'ＦＵＬＬＷＩＤＴＨ ＣＡＰＳ', 'ÉÉÉÉÉÉÉÉÉÉ',
    'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿ', 'ᏣᎳᎩ ᏣᎳᎩ ᏣᎳᎩ', 'THIS IS WAY TOO LOUD', 'HELLO how are you today friend', 'GG123!!!????', 'LOL OMG',
    'THIS IS MOSTLY CAPS now ok', 'This is a totally normal sentence with A FEW caps words', 'LOL', 'WHY ARE WE SHOUTING 😀😀']) add(text);
for (const n of [0, 1, 2, 3, 4, 9, 10, 11, 99, 100, 101]) add(Array(n).fill('Kappa').join(' '), Array(n).fill('Kappa'));
add('KAPPA KAPPA KAPPA KAPPA hello there friend', Array(4).fill('KAPPA'));
add('KAPPA KAPPA KAPPA KAPPA HELLO THERE FRIEND', Array(4).fill('KAPPA'));
add('LUL LUL omg LUL', ['LUL', 'LUL', 'LUL']);
add('no emote text here', ['Kappa', 'PogChamp']);
add('PogChamp PogChamp zorp PogChamp', ['PogChamp', 'PogChamp', 'PogChamp']);
add('AAAAA', ['A', 'A']);
add('aaaa', ['aa']);
for (const text of ['check out cool-site.com now', 'go to https://example.com/path?q=1 please', 'visit www.example.org today',
    'v1.2 was great', 'e.g. this', 'nice clip https://www.twitch.tv/dima/clip/abc', 'clips.twitch.tv/awesome-clip',
    'twitch.tv/dima but also scam.xyz/free', 'nottwitch.tv.evil.com', 'HTTPS://EXAMPLE.COM:8080/x', 'https://пример.рф/путь',
    'пример.рф', 'example . com', 'example[.]com', '127.0.0.1', '😀example.com😀', 'example.com', 'EXAMPLE.COM', 'a.b',
    'exаmple.com', 'example．com', 'www.example', 'http://localhost:3000', 'mailto:someone@example.com', 'someone@example.com',
    'my-site.co.uk/path/to?x=1#frag', 'youtube.com/watch?v=1 and youtu.be/x', 'clips.twitch.tv', 'twitch.tv', 'sub.twitch.tv.',
    'example.com.', 'www.twitch.tv', 'https://twitch.tv@evil.com', 'evil.com?twitch.tv', 'https://example.com more',
    'https://example.com\u0085more', 'file.txt', 'v2.0.1', 'node.js rocks', 'hello...world', 'a_b.cd', '-x-.yz', 'ＥＸＡＭＰＬＥ.com',
    'Example.COM/Path', 'example.c0m', 'xn--e1afmkfd.xn--p1ai', 'test.example.com/😀', 'google.com'.repeat(3)]) add(text);
const transforms = [
    (t) => t, (t) => `you are ${t} ok`, (t) => t.toUpperCase(), (t) => `x${t}y`, (t) => `${t}s`, (t) => `${t}1`, (t) => `_${t}_`,
    (t) => `😀${t}😀`, (t) => Array.from(t).join(' '), (t) => t.replace(/\p{L}/u, (c) => c.repeat(3)),
    (t) => t.replace(/[aeiost]/g, (c) => ({ a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' })[c]), (t) => Array.from(t).join('​'),
    (t) => t.normalize('NFD'), (t) => t.normalize('NFC'), (t) => t.replace(/a/g, 'а').replace(/o/g, 'о').replace(/e/g, 'е'),
    (t) => t.replace(/[!-~]/g, (c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)), (t) => `"${t}!"`, (t) => `\n${t}\n`,
    (t) => `${'chat '.repeat(99)}${t}`, (t) => `${t} ${t} ${t}`, (t) => `${t}́`, (t) => `٣${t}`, (t) => `${t}水`,
];
const base = [...new Set([...BASIC_TERMS, ...UNICODE_TERMS, 'spaced term', 'tab term', 'ab', 'x', 'word5', 'word199', 'rinn', 'rin', 'riiin', 'blarg', 'blrg', 'bad word', 'café', 'zorps', 'z0rp', 'longword'])];
for (const term of base) for (const transform of transforms) add(transform(term));
for (const text of ['R I N', 'r 1 n', 'r ! n', 'r i n n', 'rr ii n n', 'r  i   n', 'r\ti\tn', 'R ¡ N N', 'R | N N', 'r 1 ! ¡ | n n', 'r¡nn',
    'r|nn', 'r1!¡|nn', 'bring', 'string', 'spring', 'water in', 'r i ng', 'r i next', 'ár i n', 'r|nning', 'b l a r g', 'bl4rg', 'bl@@rg',
    'w o r d 1 9 9', 'wooord199', 'w0rd5', 'w 0 r d 1 9 9', 'baaadd   wooord', 'b a d   w o r d', 'badword', 'CAAAFE', 'c4f3', 'c a f e',
    '🎉 Rinn!', '🎉 R I N!', 'Don\'t call her Rinn', 'Rinn7', '水Rinn', 'árinn', 'rinnrinn', 'a\u0000b', 'aXb', 'zorp zorped zorps z00rp',
    'кошшшка', 'КОШКА!', 'кошкам', 'ÉCLAIR', 'éclair', 'eclair', 'x', 'xx', 'x y', '123', '12', 'abc1234', 'σοφός ΣΟΦΌΣ σοφοσ',
    'İSTANBUL', 'istanbul', 'STRASSE', 'strasse', 'Straße', '🍕PIZZA', '🍕 pizza', 'pizza']) add(text);
add('word '.repeat(400) + 'zorp');
add('😀'.repeat(500));
add(('zorp '.repeat(100)).trim());
add('a'.repeat(2000));
add('A'.repeat(500));

// Templates over the stored words (real settings only): `{{W:i:x}}`.
const templates = [];
const frames = ['{{W}}', 'hey {{W}} there', 'x{{W}}y', '😀{{W}}!', '{{W}}s', 'pre {{W}}_', `${'chat '.repeat(50)}{{W}}`];
for (let i = 0; i < 12; i++) for (const x of ['n', 'u', 's', 'r', 'l', 'd', 'z']) for (const frame of frames) templates.push({ text: frame.replace('{{W}}', `{{W:${i}:${x}}}`), emotes: [] });
const TRANSFORM = {
    n: (w) => w, u: (w) => w.toUpperCase(), s: (w) => Array.from(w).join(' '), r: (w) => w.replace(/\p{L}/u, (c) => c.repeat(3)),
    l: (w) => w.replace(/[aeiost]/g, (c) => ({ a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' })[c]), d: (w) => w.normalize('NFD'),
    z: (w) => Array.from(w).join('​'),
};
function storedWords(settings) {
    const words = [];
    for (const r of settings.rules || []) if (r.type === 'blacklist') for (const t of r.terms || []) if (typeof t === 'string') words.push(t);
    for (const r of settings.rules || []) for (const e of r.variations?.entries || []) if (typeof e?.term === 'string') words.push(e.term);
    for (const r of settings.rules || []) for (const e of r.variations?.entries || []) for (const s of e?.spellings || []) if (typeof s === 'string') words.push(s);
    return words;
}
function expand(template, words) {
    let ok = true;
    const text = template.replace(/\{\{W:(\d+):([a-z])\}\}/g, (_, i, x) => {
        const word = words[Number(i)];
        if (word === undefined) { ok = false; return ''; }
        return TRANSFORM[x](word);
    });
    return ok ? text : null;
}

// ---------------------------------------------------------------- verdicts
function verdict(settings, message, identity, hide) {
    const input = { text: message.text, emoteCount: message.emotes.length, emoteTexts: message.emotes.filter((t) => typeof t === 'string') };
    const out = [];
    for (const [index, r] of (settings.rules || []).entries()) {
        if (!r.enabled) continue;
        if (ruleExempt(r, identity)) { out.push([index, 'x']); continue; }
        try {
            const advanced = r.type === 'blacklist' && Boolean(V.rulePatterns(r).length || r.variations?.mode && r.variations.mode !== 'off' || r.semantic?.enabled);
            const result = evaluateRule(r, input, r.type === 'blacklist' ? compileBlacklistPattern(r.terms) : undefined);
            let matches = [];
            if (r.type === 'blacklist') matches = findBlacklistMatches(input.text, r.terms, V.rulePatterns(r));
            if (!result.triggered && !matches.length) continue;
            const mode = r.semantic?.enabled ? 'semantic' : V.rulePatterns(r).length ? 'regex' : 'literal';
            V.compileRuleVariations(r);
            out.push([index, 'h', result.triggered ? 1 : 0, hide ? short(result.detail) : result.detail, mode, advanced ? 1 : 0,
                matches.map((m) => [m.matcherID, m.start, m.end, hide ? short(m.text) : m.text])]);
        } catch {
            out.push([index, 'f']);
            break;
        }
    }
    return out;
}
const SUBSET = (index) => index % 8 === 0;
const results = { synthetic: [], real: [] };
for (const [s, { settings }] of synthetic.entries()) {
    for (const [m, message] of messages.entries()) {
        for (const [i, identity] of identityObjects.entries()) {
            if (i > 0 && !SUBSET(m)) continue;
            const v = verdict(settings, message, identity, false);
            if (v.length) results.synthetic.push([s, m, i, v]);
        }
    }
}
const realDocs = EJSON.parse(readFileSync(realPath, 'utf8'), { relaxed: true });
const real = [];
let realCases = 0;
for (const [d, settings] of realDocs.entries()) {
    real.push({ id: String(settings._id), settingsVersion: settings.settingsVersion, updatedAt: settings.updatedAt ? new Date(settings.updatedAt).getTime() : null });
    const words = storedWords(settings);
    const all = [...messages, ...templates.map((t) => { const text = expand(t.text, words); return text === null ? null : { text, emotes: t.emotes }; })];
    for (const [m, message] of all.entries()) {
        if (!message) continue;
        for (const [i, identity] of identityObjects.entries()) {
            if (i > 0 && !SUBSET(m)) continue;
            realCases++;
            const v = verdict(settings, message, identity, true);
            if (v.length) results.real.push([d, m, i, v]);
        }
    }
}
const syntheticCases = synthetic.length * messages.length + synthetic.length * (identities.length - 1) * messages.filter((_, m) => SUBSET(m)).length;

// ---------------------------------------------------------------- tables
const ladder = [];
for (const { settings } of synthetic) for (const r of settings.rules) for (const n of [-1, 0, 1, 2, 3, 4, 100]) ladder.push([r.id, n, resolveOffenseStep(r, n)]);

const permitArgs = [[], [''], ['  '], ['120'], ['0120'], ['0'], ['1'], ['600'], ['601'], ['99999999999999999999999'], ['@@Viewer_1'], ['viewer', '30'],
    ['viewer', 'x'], ['30', 'viewer'], ['a', 'b', 'c'], ['bad-name'], ['a'.repeat(25)], ['a'.repeat(26)], ['Kay'], ['٣٠'], ['ñandú'], ['@'],
    ['viewer', '0'], ['viewer', '601'], ['viewer', '60.5'], ['60.5'], ['-5'], ['+5'], [' viewer ', ' 45 '], ['Viewer', '600'], ['VIEWER'],
    ['İnan'], ['user​'], ['1e3'], ['0x10'], ['viewer', ''], ['', 'viewer'], [' viewer ']];
const permits = permitArgs.map((args) => [args, parsePermitArgs(args)]);

const variationTerms = ['rinn', 'Rinn', 'café', 'bad word', 'a.b', 'ab', 'x', 'straße', 'İstanbul', 'σοφός', 'ΟΔΟΣ', 'кошка', '🍕pizza',
    'abcdefghij'.repeat(10), 'il'.repeat(50), '  Spaced  Out ', 'éclair', 'naïve', '😀'.repeat(60), 'a'.repeat(101), '', 'tab\tterm',
    'c++', '$money', 'word199', 'zorp', 'blarg', '日本語', 'q'.repeat(100)];
const near = (t) => {
    const chars = Array.from(V.variationTerm(t));
    const out = [];
    if (chars.length > 1) out.push(chars.slice(0, -1).join(''));
    out.push(chars.map((c) => ({ a: 'e', e: 'a', i: 'y', o: 'u' })[c] ?? c).join(''));
    out.push(V.variationTerm(t) + 'ing');
    return out;
};
const variationTable = [];
for (const term of variationTerms) {
    for (const suggestions of [[], near(term), ['.*'], ['unrelated words here'], Array(9).fill('x'), [123], [V.variationTerm(term).toUpperCase()]]) {
        const built = outcome(() => V.buildVariation(term, suggestions));
        const spacing = [];
        if (built.ok) for (const allowSpaces of [false, true]) for (const mode of ['common', 'broad']) {
            const spaced = outcome(() => V.withVariationSpacing(built.ok, allowSpaces, mode));
            spacing.push([allowSpaces, mode, spaced.ok ? { source: spaced.ok.pattern.source, same: spaced.ok === built.ok, symbolVersion: spaced.ok.symbolVersion ?? null } : spaced]);
        }
        variationTable.push({ term, suggestions, built, spacing });
    }
}
const termKeys = ['rinn', ' Rinn ', 'Bad \t　 WORD', 'éclair', 'éclair', '😀', 'İ', '"quote"', 'back\\slash', 'ctrl\u0001', 'line ', ''].map((t) => [t, V.variationTerm(t), V.variationKey('chan-1', t), V.variationKey('', t)]);
const rawValues = [undefined, null, true, false, 'true', 1, {}, { mode: 'off' }, { mode: 'common' }, { mode: 'broad' }, { mode: 'wild' }, [], ['a'], { mode: null }];
const validators = {
    mode: rawValues.map((raw) => [raw === undefined ? '__undefined' : raw, outcome(() => V.variationMode(raw))]),
    allowSpaces: rawValues.map((raw) => [raw === undefined ? '__undefined' : raw, outcome(() => V.variationAllowSpaces(raw))]),
    terms: [[' Rinn ', 'rinn', 'fuzz'], Array(200).fill('w'), Array(201).fill('w'), ['ok', ''], ['ok', '  '], ['ok', 5], 'notalist', ['a'.repeat(100)],
        ['a'.repeat(101)], ['😀'.repeat(50)], ['😀'.repeat(51)], ['😀'.repeat(100)], ['Straße', 'STRASSE', 'straße']].map((raw) => [raw, outcome(() => V.variationTerms(raw))]),
    overrides: [
        [[{ term: 'Rinn', source: 'rinn|rynn' }], ['rinn', 'zorp'], 'common'], [[{ term: 'rinn', source: '(' }], ['rinn'], 'common'],
        [[{ term: 'rinn', source: '.*' }], ['rinn'], 'common'], [[{ term: 'rinn', source: '(?=rinn)rinn' }], ['rinn'], 'common'],
        [[{ term: 'rinn', source: '(rinn)\\1' }], ['rinn'], 'common'], [[{ term: 'rinn', source: 'x'.repeat(16001) }], ['rinn'], 'common'],
        [[{ term: 'rinn', source: 'x'.repeat(16000) }], ['rinn'], 'common'], [[{ term: 'other', source: 'other' }], ['rinn'], 'broad'],
        [[{ term: 'rinn', source: 'rinn' }, { term: 'Rinn', source: 'rin' }], ['rinn'], 'broad'], [[{ term: 'rinn', source: 'rinn' }], ['rinn'], 'off'],
        [[], ['rinn'], 'off'], ['x', ['rinn'], 'common'], [[null], ['rinn'], 'common'], [[{ term: 'rinn', source: '   ' }], ['rinn'], 'common'],
        [[{ term: 'rinn', source: 'a\\Cb' }], ['rinn'], 'common'], [[{ term: 'rinn', source: '😀'.repeat(8000) }], ['rinn'], 'common'],
        [[{ term: 'rinn', source: '😀'.repeat(8001) }], ['rinn'], 'common'],
    ].map(([raw, terms, mode]) => [raw, terms, mode, outcome(() => V.variationOverrides(raw, terms, mode))]),
    validate: [[[rinn, blarg], false, 'common'], [[rinn, blarg], true, 'broad'], [[], false, 'common'],
        [[{ ...rinn, term: 'nomatch' }], false, 'common'], [[{ ...rinn, pattern: { ...rinn.pattern, source: 'zzz' } }], false, 'common']]
        .map(([entries, allowSpaces, mode]) => [entries, allowSpaces, mode, outcome(() => V.validateVariations(entries, allowSpaces, mode))]),
};
const museRequest = V.museVariationRequest(['fuzz', 'rinn', 'café']);

const contexts = [[], [{ message: 'Share your channel links below!', isBroadcaster: true }], [{ message: 'dejen sus redes', isBroadcaster: true }],
    [{ message: 'Do not share your channel', isBroadcaster: true }], [{ message: 'share your channel', isBroadcaster: false }],
    [{ message: 'sharechannel', isBroadcaster: true }], [{ message: 'POST   YOUR   TWITCH LINK', isBroadcaster: true }],
    [{ message: 'nunca compartan su canal', isBroadcaster: true }], [{ message: 'comparte tu canal 😀', isBroadcaster: true }],
    [{ message: 'drop social links', isBroadcaster: true }, { message: 'no', isBroadcaster: false }], [{ message: 'ſhare your channel', isBroadcaster: true }],
    [{ message: 'share your channels', isBroadcaster: true }], [{ message: 'not now, share your channel later', isBroadcaster: true }]];
const protections = [{}, { spamProtection: { enabled: false } }, { spamProtection: { enabled: true, reviewAllMessages: true, categories: ['profanity'], thresholdPercent: 90, exemptTags: [] } },
    { spamProtection: { categories: [], exemptTags: ['vip', 'sub'] } }, { spamProtection: { thresholdPercent: 100, exemptTags: ['mod'] } }];
const spam = {
    invitation: contexts.map((ctx) => [ctx, S.broadcasterInvitedPromotion(ctx)]),
    ruleForContext: contexts.flatMap((ctx) => protections.map((p) => [ctx, p, JSON.stringify(S.spamRuleForContext(ctx, p))])),
    protection: protections.map((p) => [p, JSON.stringify(S.spamProtectionSettings(p))]),
    reviewSource: protections.flatMap((p) => [true, false].flatMap((first) => [undefined, 'free', 'premium', 'pro'].map((tier) => [p, first, tier ?? null, S.spamReviewSource(first, p, tier)]))),
    exempt: protections.flatMap((p) => identityObjects.map((identity, i) => [p, i, ruleExempt(S.spamRuleForContext([], p), identity)])),
    markers: [['1', '2'], ['chan', 'user'], ['"', '\\'], ['😀', 'İ'], ['', '']].map(([c, u]) => [c, u, S.chatterMarkerID(c, u)]),
    questions: [[['spam', 'ads', 'self_promotion'], false], [['self_promotion'], true], [['profanity', 'insults'], false], [['unknown'], false], [[], false]]
        .map(([categories, invitation]) => [categories, invitation, JSON.stringify(categoryQuestions(categories, invitation))]),
    defaults: JSON.stringify(S.defaultSpamModerationSettings('chan-1')),
    spamRule: JSON.stringify(S.spamRule),
};

const sources = {};
for (const file of ['rules/index.ts', 'rules/blacklist.rule.ts', 'rules/caps.rule.ts', 'rules/links.rule.ts', 'rules/emote_spam.rule.ts', 'advanced.ts', 'variations.ts', 'offenses.ts', 'permit.ts', 'spam.ts', 'spam_categories.ts', 'normalize.ts']) {
    try { sources[file] = sha(readFileSync(`${APP}/src/utils/moderation/${file}`, 'utf8')); } catch { sources[file] = null; }
}
const corpus = {
    meta: { node: process.version, unicode: process.versions.unicode, syntheticCases, realCases, sources },
    unicode, identities, messages, templates, synthetic, real, results,
    tables: { ladder, permits, variations: variationTable, termKeys, validators, museRequest, spam },
};
writeFileSync(outPath, gzipSync(JSON.stringify(corpus), { level: 9 }));
console.log(JSON.stringify({ messages: messages.length, templates: templates.length, synthetic: synthetic.length, real: real.length, syntheticCases, realCases, syntheticHits: results.synthetic.length, realHits: results.real.length }));
