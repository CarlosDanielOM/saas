// Golden vectors for `dima-core`, produced by real Node with the production packages.
//
//   node dima-rust/crates/core/tests/vectors/generate.mjs
//       Writes the JSON files next to this script. Deterministic: fixed inputs, a seeded
//       generator, fixed clocks (Date.now is replaced), and test keys only.
//
//   node dima-rust/crates/core/tests/vectors/generate.mjs --verify-rust <file>
//       Second step of the JWT round trip: `tools/cargo test -p dima-core --test vectors` writes
//       the tokens Rust signed (plus the options and clock it used) to a file under cargo's
//       CARGO_TARGET_TMPDIR and prints its path; this checks every one with `jsonwebtoken.verify`
//       and exits non-zero on any disagreement.
//
// Packages come from dimabot/node_modules (the versions production runs). A worktree without
// node_modules can point at another checkout with DIMABOT_NODE_MODULES=/path/to/node_modules.
// Functions that live in TypeScript sources (crypto.ts, the EventSub check, the DimaFX extension
// verifier, the lookup keys) are transcribed below verbatim apart from type annotations.
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modules = process.env.DIMABOT_NODE_MODULES || resolve(here, '../../../../../dimabot/node_modules');
const require = createRequire(join(modules, 'noop.js'));
const jwt = require('jsonwebtoken');
const ms = createRequire(require.resolve('jsonwebtoken'))('ms');
const dotenv = require('dotenv');
const { Webhook } = require('standardwebhooks');

const versions = {
    node: process.version,
    jsonwebtoken: require('jsonwebtoken/package.json').version,
    ms: createRequire(require.resolve('jsonwebtoken'))('ms/package.json').version,
    dotenv: require('dotenv/package.json').version,
    standardwebhooks: require('standardwebhooks/package.json').version,
};

const realNow = Date.now;
const withNow = (now, fn) => {
    Date.now = () => now;
    try { return fn(); } finally { Date.now = realNow; }
};
const attempt = (fn) => {
    try { return { ok: fn() }; } catch (error) { return { error: error.message, error_name: error.name }; }
};

// ---------------------------------------------------------------- helpers

const view = new DataView(new ArrayBuffer(8));
const bits = (x) => { view.setFloat64(0, x); return view.getBigUint64(0).toString(16).padStart(16, '0'); };
const fromBits = (b) => { view.setBigUint64(0, BigInt.asUintN(64, b)); return view.getFloat64(0); };
const MASK = (1n << 64n) - 1n;
let seed = 0xc0de_d1ca_0000_0001n;
const next64 = () => {
    seed = (seed + 0x9e3779b97f4a7c15n) & MASK;
    let z = seed;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
};
const randomBytes = (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i += 8) {
        const word = next64();
        for (let j = 0; j < 8 && i + j < n; j++) out[i + j] = Number((word >> BigInt(56 - 8 * j)) & 0xffn);
    }
    return out;
};
const b64url = (data) => Buffer.from(data).toString('base64url');

const write = (name, data) => {
    const fields = Object.entries({ versions, ...data }).map(([key, value]) => {
        const body = Array.isArray(value) ? `[\n${value.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]` : JSON.stringify(value);
        return ` ${JSON.stringify(key)}: ${body}`;
    });
    writeFileSync(join(here, name), `{\n${fields.join(',\n')}\n}\n`);
};

// ---------------------------------------------------------------- --verify-rust

if (process.argv[2] === '--verify-rust') {
    const rows = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    let failures = 0;
    for (const row of rows) {
        const key = row.key_base64 !== undefined ? Buffer.from(row.key_base64, 'base64') : row.key;
        const result = withNow(row.now_ms, () => attempt(() => jwt.verify(row.token, key, row.options)));
        const same = result.ok !== undefined && JSON.stringify(result.ok) === JSON.stringify(row.payload);
        if (!same) {
            failures += 1;
            console.error(`MISMATCH ${row.name}: node says ${JSON.stringify(result)}, rust payload ${JSON.stringify(row.payload)}`);
        }
    }
    console.log(`${rows.length - failures}/${rows.length} Rust-signed tokens accepted by jsonwebtoken ${versions.jsonwebtoken} with the same payload`);
    process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------- environment idioms

const inputs = [undefined, '', ' ', '0', '-0', '1', 'false', 'False', 'FALSE', 'true', 'TRUE', '1e3', '0x10', '0b11', '0o17',
    'abc', '  12  ', '  7 ﻿', 'Infinity', '-Infinity', '1.5', '-5', '100.5', '2147483647', '2147483648', '1e10',
    '9007199254740991', '9007199254740993', '12px', ' a , B ,,c ', 'https://x.test//', '{"a":1,"b":[true,null]}', '[1,2]',
    '"text"', '{bad json}', ' ', 'null', '.5', '5.', '+3', '1_000'];

const timerDelay = (after) => {
    const timer = setTimeout(() => {}, after);
    const delay = timer._idleTimeout;
    clearTimeout(timer);
    return delay;
};
process.removeAllListeners('warning'); // TimeoutOverflowWarning for the overflow cases

const idioms = {
    number: (x) => Number(x),
    number_or: (x) => Number(x || 50),
    number_or_else: (x) => Number(x) || 7,
    number_nullish: (x) => Number(x ?? 7),
    max_number_or: (x) => Math.max(60, Number(x || 300)),
    max_number_or_else: (x) => Math.max(1000, Number(x) || 60000),
    max_floor_number_or_else: (x) => Math.max(2, Math.floor(Number(x) || 3)),
    clamp_number_or: (x) => Math.max(1, Math.min(1000, Number(x || 100))),
    clamp_number_or_reversed: (x) => Math.min(1, Math.max(0, Number(x || 0.25))),
    finite_max_nullish: (x) => { const n = Number(x ?? 60000); return Number.isFinite(n) ? Math.max(60000, n) : 60000; },
    finite_max_or: (x) => { const n = Number(x || 5000); return Number.isFinite(n) ? Math.max(1000, n) : 5000; },
    finite_number: (x) => (Number.isFinite(Number(x)) ? Number(x) : 2),
    safe_integer_setting: (x) => {
        const value = Number(x ?? 1000);
        if (!Number.isSafeInteger(value) || value < 250 || value > 2_147_483_647) throw new Error('Invalid X');
        return value;
    },
    parse_int_decimal: (x) => parseInt(x, 10),
    timer_delay_ms: (x) => timerDelay(Number(x || 1000)),
    is_true: (x) => x === 'true',
    not_false: (x) => x !== 'false',
    not_false_ignore_case: (x) => x?.toLowerCase() !== 'false',
    truthy: (x) => !!x,
    string_or: (x) => String(x || 'def'),
    non_empty: (x) => x || null,
    trimmed: (x) => x?.trim() ?? null,
    trimmed_or: (x) => x?.trim() || 'def',
    or_undefined_text: (x) => `${x}`,
    strip_trailing_slashes: (x) => (x ?? '').replace(/\/+$/, ''),
    comma_list: (x) => (x || 'a.com,www.a.com').split(',').map((v) => v.trim()),
    json_value: (x) => { try { return { value: JSON.parse(x) }; } catch { return null; } },
};
const envRows = [];
for (const [idiom, fn] of Object.entries(idioms)) {
    for (const input of inputs) {
        let out;
        try {
            const value = fn(input);
            out = typeof value === 'number' ? { number: bits(value) } : { value };
        } catch (error) {
            out = { error: error.message };
        }
        envRows.push({ idiom, input: input ?? null, ...out });
    }
}
write('env.json', { rows: envRows });

// ---------------------------------------------------------------- dotenv

const dotenvSamples = [
    [
        '﻿# comment line',
        'BASIC=basic',
        'EMPTY=',
        "EMPTY_SINGLE_QUOTES=''",
        'EMPTY_DOUBLE_QUOTES=""',
        'EMPTY_BACKTICKS=``',
        "SINGLE_QUOTES='single_quotes'",
        "SINGLE_QUOTES_SPACED='    single quotes    '",
        'DOUBLE_QUOTES="double_quotes"',
        'DOUBLE_QUOTES_SPACED="    double quotes    "',
        "DOUBLE_QUOTES_INSIDE_SINGLE='double \"quotes\" work inside single quotes'",
        'SINGLE_QUOTES_INSIDE_DOUBLE="single \'quotes\' work inside double quotes"',
        'BACKTICKS=`backticks`',
        "DOUBLE_AND_SINGLE_INSIDE_BACKTICKS=`double \"quotes\" and single 'quotes' work`",
        'EXPAND_NEWLINES="expand\\nnew\\nlines and \\r returns"',
        'DONT_EXPAND_UNQUOTED=dontexpand\\nnewlines',
        "DONT_EXPAND_SQUOTED='dontexpand\\nnewlines'",
        '# COMMENTS=work',
        'INLINE_COMMENTS=inline comments # work #very #well',
        "INLINE_COMMENTS_SINGLE_QUOTES='inline comments outside of #singlequotes' # work",
        'INLINE_COMMENTS_DOUBLE_QUOTES="inline comments outside of #doublequotes" # work',
        'INLINE_COMMENTS_BACKTICKS=`inline comments outside of #backticks` # work',
        'INLINE_COMMENTS_SPACE=a#number sign. no space required.',
        'EQUAL_SIGNS=equals==',
        'RETAIN_INNER_QUOTES={"foo": "bar"}',
        "RETAIN_INNER_QUOTES_AS_STRING='{\"foo\": \"bar\"}'",
        'TRIM_SPACE_FROM_UNQUOTED=    some spaced out string    ',
        'USERNAME=therealnerdybeast@example.tld',
        '    SPACED_KEY = parsed',
        'export EXPORTED=yes',
        'export   EXPORT_SPACES   =   also',
        'exportNOT=glued',
        'COLON: colon value',
        'COLON_NOSPACE:nospace',
        'dotted.key=dot',
        'dash-key=dash',
        'KEY WITH SPACE=nope',
        '=novalue',
        'MULTI_DOUBLE="first',
        'second\\"still',
        'third"',
        "MULTI_SINGLE='a",
        "b'",
        'MULTI_BACKTICK=`x',
        'y`',
        'UNTERMINATED="never closed',
        'NEXT_AFTER_UNTERMINATED=ok',
        "ESCAPED_QUOTE='it\\'s'",
        "ESCAPED_DOUBLE=\"say \\\"hi\\\"\"",
        "TRAILING_JUNK='quoted' junk",
        "TWO_QUOTED='a' 'b'",
        'DUP=first',
        'DUP=second',
        '__proto__=polluted',
        'constructor=ok',
        'TAB_VALUE=\ttabbed\t',
        'UNICODE=héllo wörld 😀 مرحبا',
        'NBSP_VALUE= nbsp ',
        'HASH_IN_VALUE=abc#def',
        'EMPTY_COMMENT=# just comment',
        'QUOTE_THEN_COMMENT="value"#comment',
        'DOUBLE_ESCAPES="a\\\\nb"',
        'ONLY_SPACES=   ',
        'NUMERIC=42',
        '123=numeric key',
        'LAST=no newline at end',
    ].join('\n'),
    '﻿BOM=1\r\nCRLF=2\r\nLONE_CR=3\rAFTER_CR=4\n\n\n  \n   INDENTED_AFTER_BLANKS=5\r\n',
    'A=1#c\nB = "x" # c\nC=\'y\' \'z\'\nD=`a\\`b`\nE="a\\"b"\nF= "spaced quote"\nG=\'\nH=after\n',
    'LS=a NEXT_LS=b\nPS=c NEXT_PS=d\nQ="multi line"\nR=\'x \'\n',
    'K1=v1 K2=v2\nK3:\nK4=\n=\nK5= # only comment\nK6=`unterminated\nK7="a"b"\nK8=\'"mixed"\'\n',
    'export\nexport=\nexport =x\nexport  A=1\n  export B=2\n',
    '',
    '\n\n\n',
    'NO_EQUALS\nX=1',
];
write('dotenv.json', { samples: dotenvSamples.map((text) => ({ text, parsed: Object.entries(dotenv.parse(text)) })) });

// ---------------------------------------------------------------- cipher (utils/crypto.ts)

const ALGORITHM = 'aes-256-ctr';
const keyBuffer = (secret) => Buffer.from(secret.padEnd(32), 'utf-8');
function encrypt(secret, text, iv) {
    if (!text) return { iv: '', content: '' };
    const cipher = createCipheriv(ALGORITHM, keyBuffer(secret), iv);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return { iv: iv.toString('hex'), content: encrypted.toString('hex') };
}
function decrypt(secret, hash) {
    if (!hash || !hash.iv || !hash.content) return null;
    const decipher = createDecipheriv(ALGORITHM, keyBuffer(secret), Buffer.from(hash.iv, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(hash.content, 'hex')), decipher.final()]);
    return decrypted.toString();
}

const KEY = 'dima-test-secret-key';
const OTHER_KEY = 'another-test-key';
const keyCases = ['short', 'k'.repeat(31), 'k'.repeat(32), 'k'.repeat(33), `${'k'.repeat(30)}é`, 'é'.repeat(16),
    `${'k'.repeat(28)}😀`, `${'k'.repeat(30)}😀`, 'ü', ' leading and trailing ', KEY]
    .map((secret) => ({ secret, ...attempt(() => { createCipheriv(ALGORITHM, keyBuffer(secret), Buffer.alloc(16)); return true; }) }));
const plaintexts = ['', 'a', 'twitch-access-token-abc123', 'héllo wörld 😀 مرحبا', 'x'.repeat(100), 'long '.repeat(200)];
const encryptCases = [];
for (const text of plaintexts) {
    const iv = randomBytes(16);
    encryptCases.push({ text, iv: iv.toString('hex'), stored: encrypt(KEY, text, iv) });
}
for (const ivHex of ['ffffffffffffffffffffffffffffffff', '0000000000000000fffffffffffffffe', '00000000000000000000000000000000']) {
    const text = 'counter wrap '.repeat(5);
    encryptCases.push({ text, iv: ivHex, stored: encrypt(KEY, text, Buffer.from(ivHex, 'hex')) });
}
const good = encryptCases[2].stored;
const decryptCases = [
    good,
    { iv: good.iv.toUpperCase(), content: good.content.toUpperCase() },
    { iv: good.iv, content: good.content.slice(0, -1) },
    { iv: good.iv, content: `${good.content.slice(0, 10)}zz${good.content.slice(12)}` },
    { iv: `${good.iv}a`, content: good.content },
    { iv: `${good.iv}zz`, content: good.content },
    { iv: good.iv.slice(0, 30), content: good.content },
    { iv: `zz${good.iv}`, content: good.content },
    { iv: good.iv, content: 'zz' },
    { iv: '', content: good.content },
    { iv: good.iv, content: '' },
    encryptCases[3].stored,
].map((stored) => ({ key: KEY, stored, ...attempt(() => decrypt(KEY, stored)) }));
decryptCases.push({ key: OTHER_KEY, stored: encryptCases[3].stored, ...attempt(() => decrypt(OTHER_KEY, encryptCases[3].stored)) });
decryptCases.push({ key: OTHER_KEY, stored: encryptCases[5].stored, ...attempt(() => decrypt(OTHER_KEY, encryptCases[5].stored)) });
write('cipher.json', { key: KEY, keys: keyCases, encrypt: encryptCases, decrypt: decryptCases });

// ---------------------------------------------------------------- digests and encodings

const digestInputs = ['', 'abc', 'héllo wörld 😀', 'a'.repeat(1000), '\u0000￿', 'line\nbreak', 'Ünïcödé ✓'];
const digests = digestInputs.map((input) => {
    const row = { input };
    for (const alg of ['sha256', 'sha1', 'md5']) {
        for (const enc of ['hex', 'base64', 'base64url']) row[`${alg}_${enc}`] = createHash(alg).update(input).digest(enc);
    }
    return row;
});
const hmacKeys = ['', 'key', 'k'.repeat(100), 'ключ 🔑'];
const hmacs = [];
for (const key of hmacKeys) for (const input of digestInputs) {
    hmacs.push({ key, input, hex: createHmac('sha256', key).update(input).digest('hex'),
        base64url: createHmac('sha256', key).update(input).digest('base64url') });
}
const base64Inputs = ['QUJD', 'QUJ', 'QU', 'Q', 'QUJD=', 'QU=JD', 'Q U J D', 'QU\nJD', 'QU*JD', 'QUJD====QUJD', '-_-_', '+/+/',
    'QR==', 'QUI=x', 'QU.JD', 'QUJDRA', '=QUJD', 'QUJ=D', 'é QUJD', '', 'AAAA', '////', '____', 'YQ', 'YWI', 'YW Jj'];
const hexInputs = ['', '0a', '0A', 'abc', 'zz12', '12zz34', 'a', 'deadBEEF', '0x12', ' 12', '12 34', 'éé'];
write('digest.json', {
    digests, hmacs,
    base64: base64Inputs.map((input) => ({ input, hex: Buffer.from(input, 'base64').toString('hex'),
        url_hex: Buffer.from(input, 'base64url').toString('hex') })),
    hex: hexInputs.map((input) => ({ input, hex: Buffer.from(input, 'hex').toString('hex') })),
    encode: [[], [0], [0xfb, 0xff], [0xfb, 0xff, 0xbf], [1, 2, 3, 4, 5]].map((bytes) => ({ bytes,
        base64: Buffer.from(bytes).toString('base64'), base64url: Buffer.from(bytes).toString('base64url'),
        hex: Buffer.from(bytes).toString('hex'), latin1: Buffer.from(bytes).toString('latin1') })),
});

// ---------------------------------------------------------------- lookup keys and signed tokens

const SECRET_KEY = 'dima-test-secret-key';
const overlayToken = (channelID) => createHmac('sha256', SECRET_KEY).update(`dimafx-overlay:${channelID}`).digest('hex');
function authorizeDimafxOverlay(channelID, token) {
    if (!/^\w+$/.test(channelID) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(overlayToken(channelID), 'hex'));
}
const traceSignature = (traceparent) => createHmac('sha256', SECRET_KEY).update(traceparent).digest('hex');
function traceTrusted(traceparent, signature) {
    const expected = traceSignature(traceparent);
    return expected.length > 0 && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
const sha256hex = (v) => createHash('sha256').update(v).digest('hex');
const sha256url = (v) => createHash('sha256').update(v).digest('base64url');
const subjects = ['', '203.0.113.7', 'user-1', 'Straße', '😀'];
const jsonValues = [
    ['follow-defense-state', '12345', ['version', 3]],
    ['follow-defense-state', '12345', ['legacy', 1700000000000]],
    { b: 1, a: [1.5, -0, 1e21, 0.1, 'x'], 2: 'two', 1: null, nested: { 'é': '😀', ' ': 'ls' } },
    [1e-7, 123456789.123, -1e300, true, false, null, 'quote " backslash \\ control \u0001'],
];
const channelIDs = ['123456', 'abc_DEF', 'not-word', '', 'café'];
const overlay = channelIDs.map((channel) => ({ channel, token: overlayToken(channel) }));
const authorizeCases = [
    ['123456', overlayToken('123456')], ['123456', overlayToken('123456').toUpperCase()], ['123456', overlayToken('654321')],
    ['not-word', overlayToken('not-word')], ['123456', overlayToken('123456').slice(1)], ['abc_DEF', overlayToken('abc_DEF')],
].map(([channel, token]) => ({ channel, token, ok: authorizeDimafxOverlay(channel, token) }));
const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
const traceCases = [traceSignature(traceparent), traceSignature(traceparent).toUpperCase(), '', 'é'.repeat(64), traceSignature('other')]
    .map((signature) => ({ traceparent, signature, ...attempt(() => traceTrusted(traceparent, signature)) }));
write('keys.json', {
    secret_key: SECRET_KEY,
    token_hash: subjects.map((input) => ({ input, hex: sha256hex(input), base64url: sha256url(input) })),
    rate_limit: subjects.map((subject) => ({ scope: 'docs-assistant:minute', subject,
        key: `ratelimit:docs-assistant:minute:${sha256url(subject)}` })),
    billing: ['cus_123', '', 'ÿ'].map((customer) => ({ customer,
        key: `billing:credit-packs:context:v1:${sha256hex(customer).slice(0, 20)}` })),
    credit_gift: [['64b7f0c2a1b2c3d4e5f60718', 'REQ-ABC'], ['u', 'İstanbul-ΣΑΣ'], ['u', '']]
        .map(([user, request]) => ({ user, request, id: sha256hex(`${user}:${request.toLowerCase()}`) })),
    json_sha256: jsonValues.map((value) => ({ json: JSON.stringify(value), hex: sha256hex(JSON.stringify(value)) })),
    object_id: jsonValues.slice(0, 2).map((value) => ({ identity: JSON.stringify(value), hex: sha256hex(JSON.stringify(value)).slice(0, 24) })),
    qdrant: [['memory', 'abc', 1700000000000], ['chat', '42', 1.5], ['x', 'y', 1e21], ['x', 'y', -0], ['ns', 'ü', 123456789.123], ['ns', 'e', 0.1 + 0.2]]
        .map(([ns, entity, timestamp]) => ({ ns, entity, timestamp: bits(timestamp),
            id: parseInt(createHash('md5').update(`${ns}:${entity}:${timestamp}`).digest('hex').substring(0, 8), 16) })),
    overlay, authorize: authorizeCases, trace: traceCases,
});

// ---------------------------------------------------------------- radix text (Math.random().toString(36))

const radixRows = [];
for (let i = 0; i < 200; i++) {
    const x = fromBits((1023n << 52n) | (next64() >> 12n)) - 1; // the values Math.random returns
    radixRows.push({ x: bits(x), base36: x.toString(36), base16: x.toString(16), base2: x.toString(2) });
}
for (let i = 0; i < 40; i++) {
    let x;
    do { x = fromBits(next64()); } while (!Number.isFinite(x));
    radixRows.push({ x: bits(x), base36: x.toString(36), base16: x.toString(16), base2: x.toString(2) });
}
for (const x of [0, -0, 0.5, 1, 255.5, -255.5, 1e21, 2 ** 53, 2 ** 53 + 2, 1e-7, 5e-324, Number.MAX_VALUE, 0.1, 1 / 3, 123.456, 35.99999999999999]) {
    radixRows.push({ x: bits(x), base36: x.toString(36), base16: x.toString(16), base2: x.toString(2) });
}
write('radix.json', { rows: radixRows });

// ---------------------------------------------------------------- JWT

const NOW = 1_762_819_200_000; // 2025-11-11T00:00:00Z, the fixed clock for every JWT vector
const ACTIVATION_SECRET = 'dev-insecure-do-not-use-in-prod';
const msInputs = ['1h', '12h', '15m', '2.5 HRS', '-.5d', '100', '1y', '1.', 'h', '1 hour ', '1 hour', '  1h', '1e3', '1.5h', '-1h',
    '10 Milliseconds', '3 weeks', '2 yrs', '7 mins', '1  s', '+1h', '1hr', '1hrs', '1msec', 'x'.repeat(101), `${'1'.repeat(99)}s`,
    '0.000001s', '1ſ', '1K'];
const msRows = msInputs.map((input) => { const value = ms(input); return { input, ms: value === undefined ? null : bits(value) }; });

const keyOf = (spec) => (spec.base64 !== undefined ? Buffer.from(spec.base64, 'base64') : spec.text);
const SECRET_B64 = randomBytes(32).toString('base64');
const signCases = [
    ['activation', { sub: '64b7f0c2a1b2c3d4e5f60718', login: 'streamer' }, { text: ACTIVATION_SECRET }, { expiresIn: '1h' }],
    ['asset-12h', { owner: '123456' }, { text: SECRET_KEY }, { algorithm: 'HS256', audience: 'asset-preview', subject: 'asset-1', expiresIn: '12h' }],
    ['asset-15m', { owner: '123456' }, { text: SECRET_KEY }, { algorithm: 'HS256', audience: 'asset-preview', subject: 'asset-2', expiresIn: '15m' }],
    ['hs384', { a: 1 }, { text: 'k' }, { algorithm: 'HS384' }],
    ['hs512', { a: 1 }, { text: 'k' }, { algorithm: 'HS512', expiresIn: 60 }],
    ['iat-given', { iat: 1.5, x: 'y' }, { text: 'k' }, { expiresIn: '1.5h', notBefore: '2 days' }],
    ['iat-zero', { iat: 0 }, { text: 'k' }, { expiresIn: 10 }],
    ['all-options', { data: [1, 'two', null] }, { text: 'k' }, { expiresIn: '1y', notBefore: -30, issuer: 'dima', jwtid: 'j-1', keyid: 'kid-1', subject: 's', audience: 'aud' }],
    ['no-timestamp', { iat: 5, a: 1 }, { text: 'k' }, { noTimestamp: true, expiresIn: '1h' }],
    ['integer-keys', { b: 1, 2: 'two', a: 3, 1: 'one' }, { text: 'k' }, {}],
    ['unicode', { name: 'héllo 😀 مرحبا', ' ': 'ls' }, { text: 'ключ 🔑' }, { expiresIn: '-1h' }],
    ['base64-key', { channel_id: '1' }, { base64: SECRET_B64 }, {}],
    ['float-exp', { a: 1 }, { text: 'k' }, { expiresIn: '0.0001s' }],
    ['err-exp-conflict', { exp: 1 }, { text: 'k' }, { expiresIn: '1h' }],
    ['err-nbf-conflict', { nbf: 1 }, { text: 'k' }, { notBefore: '1h' }],
    ['err-iat-type', { iat: '1' }, { text: 'k' }, {}],
    ['err-exp-type', { exp: null }, { text: 'k' }, {}],
    ['err-empty-key', { a: 1 }, { text: '' }, {}],
    ['err-bad-span', { a: 1 }, { text: 'k' }, { expiresIn: 'soon' }],
    ['err-empty-span', { a: 1 }, { text: 'k' }, { expiresIn: '' }],
    ['err-sub-conflict', { sub: 'x' }, { text: 'k' }, { subject: 'y' }],
    ['err-aud-conflict', { aud: 'x' }, { text: 'k' }, { audience: 'y' }],
];
const sign = signCases.map(([name, payload, key, options]) => ({ name, payload, key, options, now_ms: NOW,
    ...withNow(NOW, () => attempt(() => jwt.sign(payload, keyOf(key), options))) }));

const enc = (value) => b64url(typeof value === 'string' ? value : JSON.stringify(value));
const craft = (header, payload, key, alg = 'sha256') => {
    const input = `${enc(header)}.${enc(payload)}`;
    return `${input}.${createHmac(alg, key).update(input).digest('base64url')}`;
};
const signed = (payload, key, options = {}) => withNow(NOW, () => jwt.sign(payload, key, options));
const valid = signed({ sub: 'u', login: 'l' }, 'k', { expiresIn: '1h' });
const [vh, vp, vs] = valid.split('.');
const nowSecs = Math.floor(NOW / 1000);
const H = { alg: 'HS256', typ: 'JWT' };
const verifyCases = [
    ['valid-default', valid, { text: 'k' }, undefined],
    ['valid-hs256-only', valid, { text: 'k' }, { algorithms: ['HS256'] }],
    ['activation-real', signed({ sub: 'id', login: 'l' }, ACTIVATION_SECRET, { expiresIn: '1h' }), { text: ACTIVATION_SECRET }, undefined],
    ['wrong-key', valid, { text: 'K' }, undefined],
    ['tampered-signature', `${vh}.${vp}.${vs.slice(0, -1)}${vs.endsWith('A') ? 'B' : 'A'}`, { text: 'k' }, undefined],
    ['tampered-payload', `${vh}.${enc({ sub: 'admin', login: 'l' })}.${vs}`, { text: 'k' }, undefined],
    ['non-canonical-signature', `${vh}.${vp}.${vs}A`, { text: 'k' }, undefined],
    ['expired-at-exp', signed({ a: 1, iat: nowSecs - 60 }, 'k', { expiresIn: 60 }), { text: 'k' }, undefined],
    ['valid-before-exp', signed({ a: 1, iat: nowSecs - 59 }, 'k', { expiresIn: 60 }), { text: 'k' }, undefined],
    ['expired-tolerated', signed({ a: 1, iat: nowSecs - 60 }, 'k', { expiresIn: 60 }), { text: 'k' }, { clockTolerance: 5 }],
    ['expired-ignored', signed({ a: 1, iat: nowSecs - 600 }, 'k', { expiresIn: 60 }), { text: 'k' }, { ignoreExpiration: true }],
    ['not-before-future', signed({ a: 1 }, 'k', { notBefore: 10 }), { text: 'k' }, undefined],
    ['not-before-ignored', signed({ a: 1 }, 'k', { notBefore: 10 }), { text: 'k' }, { ignoreNotBefore: true }],
    ['not-before-now', signed({ a: 1 }, 'k', { notBefore: 0 }), { text: 'k' }, undefined],
    ['hs384-vs-hs256-only', signed({ a: 1 }, 'k', { algorithm: 'HS384' }), { text: 'k' }, { algorithms: ['HS256'] }],
    ['hs512-default', signed({ a: 1 }, 'k', { algorithm: 'HS512' }), { text: 'k' }, undefined],
    ['alg-none-unsigned', `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ a: 1 })}.`, { text: 'k' }, undefined],
    ['alg-none-signed', craft({ alg: 'none', typ: 'JWT' }, { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['alg-rs256', craft({ alg: 'RS256', typ: 'JWT' }, { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['alg-lowercase', craft({ alg: 'hs256', typ: 'JWT' }, { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['alg-missing', craft({ typ: 'JWT' }, { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['empty', '', { text: 'k' }, undefined],
    ['two-parts', `${vh}.${vp}`, { text: 'k' }, undefined],
    ['four-parts', `${valid}.x`, { text: 'k' }, undefined],
    ['bad-chars', `${vh}.${vp}=.${vs}`, { text: 'k' }, undefined],
    ['empty-header', `.${vp}.${vs}`, { text: 'k' }, undefined],
    ['header-not-json', craft('not json', { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['header-null', craft('null', { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['header-string', craft('"HS256"', { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['header-latin1', craft('{"alg":"HS256","typ":"JWT","x":"\u00e9"}', { a: 1 }, 'k'), { text: 'k' }, undefined],
    ['payload-not-json-typ', craft(H, 'not json', 'k'), { text: 'k' }, undefined],
    ['payload-not-json-no-typ', craft({ alg: 'HS256' }, 'plain text', 'k'), { text: 'k' }, undefined],
    ['payload-number-no-typ', craft({ alg: 'HS256' }, '123', 'k'), { text: 'k' }, undefined],
    ['payload-array-typ', craft(H, [1, 2], 'k'), { text: 'k' }, undefined],
    ['payload-json-string-typ', craft(H, JSON.stringify(JSON.stringify({ a: 1 })), 'k'), { text: 'k' }, undefined],
    ['payload-lone-surrogate', craft(H, '{"a":"\\ud800x"}', 'k'), { text: 'k' }, undefined],
    ['exp-string', craft(H, { exp: '9999999999' }, 'k'), { text: 'k' }, undefined],
    ['exp-null', craft(H, { exp: null }, 'k'), { text: 'k' }, undefined],
    ['nbf-string', craft(H, { nbf: '1' }, 'k'), { text: 'k' }, undefined],
    ['exp-float', craft(H, { exp: nowSecs + 0.5 }, 'k'), { text: 'k' }, undefined],
    ['audience-ok', signed({ owner: '1' }, SECRET_KEY, { audience: 'asset-preview', subject: 'a', expiresIn: '15m' }), { text: SECRET_KEY }, { algorithms: ['HS256'], audience: 'asset-preview' }],
    ['audience-wrong', signed({ owner: '1' }, SECRET_KEY, { audience: 'other', expiresIn: '15m' }), { text: SECRET_KEY }, { algorithms: ['HS256'], audience: 'asset-preview' }],
    ['audience-missing', signed({ owner: '1' }, SECRET_KEY, {}), { text: SECRET_KEY }, { algorithms: ['HS256'], audience: 'asset-preview' }],
    ['audience-array-claim', craft(H, { aud: ['x', 'asset-preview'] }, 'k'), { text: 'k' }, { audience: 'asset-preview' }],
    ['audience-list-option', craft(H, { aud: 'b' }, 'k'), { text: 'k' }, { audience: ['a', 'b'] }],
    ['audience-list-miss', craft(H, { aud: 'c' }, 'k'), { text: 'k' }, { audience: ['a', 'b'] }],
    ['issuer-ok', craft(H, { iss: 'dima' }, 'k'), { text: 'k' }, { issuer: 'dima' }],
    ['issuer-wrong', craft(H, { iss: 'x' }, 'k'), { text: 'k' }, { issuer: ['dima', 'other'] }],
    ['subject-wrong', craft(H, { sub: 'x' }, 'k'), { text: 'k' }, { subject: 'y' }],
    ['jwtid-wrong', craft(H, { jti: 'x' }, 'k'), { text: 'k' }, { jwtid: 'y' }],
    ['nonce-ok', craft(H, { nonce: 'n' }, 'k'), { text: 'k' }, { nonce: 'n' }],
    ['nonce-blank-option', craft(H, { nonce: 'n' }, 'k'), { text: 'k' }, { nonce: '  ' }],
    ['max-age-ok', craft(H, { iat: nowSecs - 10 }, 'k'), { text: 'k' }, { maxAge: '1m' }],
    ['max-age-exceeded', craft(H, { iat: nowSecs - 60 }, 'k'), { text: 'k' }, { maxAge: 60 }],
    ['max-age-no-iat', craft(H, { a: 1 }, 'k'), { text: 'k' }, { maxAge: '1h' }],
    ['max-age-bad', craft(H, { iat: nowSecs }, 'k'), { text: 'k' }, { maxAge: 'soon' }],
    ['max-age-iat-zero', craft(H, { iat: 0 }, 'k'), { text: 'k' }, { maxAge: 5 }],
    ['empty-key-signed', valid, { text: '' }, { algorithms: ['HS256'] }],
    ['empty-key-unsigned', `${vh}.${vp}.`, { text: '' }, { algorithms: ['HS256'] }],
    ['base64-key', signed({ channel_id: '1' }, Buffer.from(SECRET_B64, 'base64')), { base64: SECRET_B64 }, { algorithms: ['HS256'] }],
    ['duplicate-claims', craft(H, '{"sub":"a","sub":"b"}', 'k'), { text: 'k' }, undefined],
];
const verify = verifyCases.map(([name, token, key, options]) => ({ name, token, key, options: options ?? null, now_ms: NOW,
    ...withNow(NOW, () => attempt(() => jwt.verify(token, keyOf(key), options))) }));

// DimaFX extension verifier (dimafx/server/src/middleware/twitch-extension-auth.ts), transcribed.
function getSigningSecrets(secret) {
    if (!secret) return [];
    const candidates = [Buffer.from(secret, 'base64'), Buffer.from(secret, 'base64url'), Buffer.from(secret, 'utf8')];
    return candidates.filter((candidate, index) => candidate.length > 0 && candidates.findIndex((other) => other.equals(candidate)) === index);
}
function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64');
}
function decodeUnverified(token) {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    try { return JSON.parse(base64UrlDecode(parts[1]).toString('utf8')); } catch { return null; }
}
function verifyTwitchJwt(token, signingSecrets) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const signedPayload = `${parts[0]}.${parts[1]}`;
    const actualSignature = base64UrlDecode(parts[2]);
    for (const signingSecret of signingSecrets) {
        const expectedSignature = createHmac('sha256', signingSecret).update(signedPayload).digest();
        if (expectedSignature.length === actualSignature.length && timingSafeEqual(expectedSignature, actualSignature)) {
            const payload = decodeUnverified(token);
            if (!payload) return null;
            if (payload.exp && payload.exp * 1000 < Date.now()) return null;
            return payload;
        }
    }
    return null;
}
const extSecrets = [SECRET_B64, 'not base64 at all!', 'c2VjcmV0', 'a-_b'];
const extKeyRows = extSecrets.map((secret) => ({ secret, keys: getSigningSecrets(secret).map((key) => key.toString('hex')) }));
const extKey = Buffer.from(SECRET_B64, 'base64');
const ext = (payload, header = { alg: 'HS256', typ: 'JWT' }, key = extKey) => craft(header, payload, key);
const extToken = ext({ channel_id: '1', user_id: '2', role: 'viewer', exp: nowSecs + 60 });
const [eh, ep, es] = extToken.split('.');
const extCases = [
    [SECRET_B64, extToken],
    [SECRET_B64, ext({ channel_id: '1' })],
    [SECRET_B64, ext({ channel_id: '1', exp: nowSecs - 1 })],
    [SECRET_B64, ext({ channel_id: '1', exp: nowSecs })],
    [SECRET_B64, ext({ channel_id: '1', exp: 0 })],
    [SECRET_B64, ext({ channel_id: '1', exp: 'abc' })],
    [SECRET_B64, ext({ channel_id: '1', exp: String(nowSecs - 5) })],
    [SECRET_B64, ext({ channel_id: '1', exp: [nowSecs - 5] })],
    [SECRET_B64, ext({ channel_id: '1', exp: true })],
    [SECRET_B64, ext({ channel_id: '1', exp: {} })],
    [SECRET_B64, ext('null')],
    [SECRET_B64, ext('0')],
    [SECRET_B64, ext('"text"')],
    [SECRET_B64, ext([1])],
    [SECRET_B64, ext({ channel_id: '1' }, { alg: 'HS384' })],
    [SECRET_B64, ext({ channel_id: '1' }, 'not json')],
    [SECRET_B64, ext({ channel_id: '1' }, 'null')],
    [SECRET_B64, ext({ channel_id: '1' }, { alg: 'HS256' }, Buffer.from('wrong'))],
    [SECRET_B64, ext({ channel_id: '1' }, { alg: 'HS256' }, Buffer.from(SECRET_B64, 'utf8'))],
    [SECRET_B64, `${eh}.${ep}.${es}A`],
    [SECRET_B64, `${eh}.${ep}.${es.slice(0, -2)}`],
    [SECRET_B64, `${eh}.${ep}`],
    [SECRET_B64, `${eh}..${es}`],
    [SECRET_B64, `${eh}.${ep}.${es}.x`],
    ['not base64 at all!', ext({ channel_id: '9' }, { alg: 'HS256' }, Buffer.from('not base64 at all!', 'utf8'))],
    ['', extToken],
].map(([secret, token]) => ({ secret, token, now_ms: NOW,
    ...withNow(NOW, () => attempt(() => verifyTwitchJwt(token, getSigningSecrets(secret)))) }));

write('jwt.json', { ms: msRows, sign, verify, extension_keys: extKeyRows, extension: extCases });

// ---------------------------------------------------------------- webhooks

// bot/eventsub.twitch.ts, transcribed.
const getHmac = (secret, messageId, timestamp, body) => createHmac('sha256', secret).update(messageId).update(timestamp).update(body).digest('hex');
function verifyMessage(hmac, verifySignature) {
    if (!hmac || !verifySignature || hmac.length !== verifySignature.length) return false;
    return timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
}
const EVENTSUB_SECRET = 'eventsub-test-secret';
const bodies = [Buffer.from('{"subscription":{"type":"channel.follow"}}'), Buffer.from(''), Buffer.from([0xff, 0xfe, 0x00, 0x7b]),
    Buffer.from('{"emoji":"😀"}')];
const eventsubSign = [];
for (const secret of [EVENTSUB_SECRET, '']) for (const body of bodies) {
    const id = 'f1c2a387-161a-49f9-a165-0f21d7a4e1c4';
    const timestamp = '2025-11-11T00:00:00.123456789Z';
    eventsubSign.push({ secret, id, timestamp, body: body.toString('base64'), signature: `sha256=${getHmac(secret, id, timestamp, body)}` });
}
const goodSig = eventsubSign[0].signature;
const eventsubVerify = [goodSig, goodSig.toUpperCase(), '', 'sha256=', `${goodSig.slice(0, -1)}é`, `${goodSig}0`, goodSig.replace('sha256=', 'sha1=')]
    .map((signature) => ({ secret: EVENTSUB_SECRET, id: eventsubSign[0].id, timestamp: eventsubSign[0].timestamp, body: eventsubSign[0].body,
        signature, ...attempt(() => verifyMessage(eventsubSign[0].signature, signature)) }));

const POLAR_SECRET = 'polar_whs_test_secret_✓';
const webhook = new Webhook(Buffer.from(POLAR_SECRET, 'utf-8').toString('base64'));
const nowSecsWh = Math.floor(NOW / 1000);
const polarBody = Buffer.from('{"type":"order.paid","data":{"id":"ord_1","amount":500}}');
const whSign = [['msg_1', nowSecsWh, polarBody], ['msg_é', nowSecsWh - 7, Buffer.from('not json')], ['m', nowSecsWh, Buffer.from([0xc3, 0x28, 0x7b, 0x7d])]]
    .map(([id, ts, body]) => ({ id, timestamp: ts, body: body.toString('base64'), signature: webhook.sign(id, new Date(ts * 1000), body) }));
const sig = whSign[0].signature;
const headerCases = [
    ['valid', 'msg_1', String(nowSecsWh), sig, polarBody],
    ['multiple', 'msg_1', String(nowSecsWh), `v1,bogus v2,x ${sig}`, polarBody],
    ['extra-comma', 'msg_1', String(nowSecsWh), `${sig},extra`, polarBody],
    ['comma-space-joined', 'msg_1', String(nowSecsWh), `v1,bogus, ${sig}`, polarBody],
    ['wrong-version', 'msg_1', String(nowSecsWh), sig.replace('v1,', 'v2,'), polarBody],
    ['version-only', 'msg_1', String(nowSecsWh), 'v1', polarBody],
    ['tampered-body', 'msg_1', String(nowSecsWh), sig, Buffer.from('{"type":"order.paid"}')],
    ['wrong-id', 'msg_2', String(nowSecsWh), sig, polarBody],
    ['old-edge', 'msg_1', String(nowSecsWh - 300), webhook.sign('msg_1', new Date((nowSecsWh - 300) * 1000), polarBody), polarBody],
    ['too-old', 'msg_1', String(nowSecsWh - 301), sig, polarBody],
    ['new-edge', 'msg_1', String(nowSecsWh + 300), webhook.sign('msg_1', new Date((nowSecsWh + 300) * 1000), polarBody), polarBody],
    ['too-new', 'msg_1', String(nowSecsWh + 301), sig, polarBody],
    ['timestamp-suffix', 'msg_1', `${nowSecsWh}abc`, sig, polarBody],
    ['timestamp-space', 'msg_1', ` ${nowSecsWh}`, sig, polarBody],
    ['timestamp-float', 'msg_1', `${nowSecsWh}.9`, sig, polarBody],
    ['timestamp-garbage', 'msg_1', 'soon', sig, polarBody],
    ['missing-timestamp', 'msg_1', '', sig, polarBody],
    ['missing-id', '', String(nowSecsWh), sig, polarBody],
    ['missing-signature', 'msg_1', String(nowSecsWh), '', polarBody],
    ['not-json-body', 'msg_é', String(nowSecsWh - 7), whSign[1].signature, Buffer.from('not json')],
    ['invalid-utf8-body', 'm', String(nowSecsWh), whSign[2].signature, Buffer.from([0xc3, 0x28, 0x7b, 0x7d])],
];
const polarVerify = headerCases.map(([name, id, ts, signature, body]) => ({ name, id, timestamp: ts, signature, body: body.toString('base64'), now_ms: NOW,
    ...withNow(NOW, () => attempt(() => { webhook.verify(body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature }); return true; })) }));
write('webhook.json', { eventsub_sign: eventsubSign, eventsub_verify: eventsubVerify, polar_secret: POLAR_SECRET, polar_sign: whSign, polar_verify: polarVerify });

console.log(`wrote env, dotenv, cipher, digest, keys, radix, jwt and webhook vectors (${JSON.stringify(versions)})`);
