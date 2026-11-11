// Golden vectors for `dima-text`, produced by real Node (no dependencies).
//
//   node dima-rust/crates/text/tests/vectors/generate.mjs
//
// Writes the JSON files next to this script. Deterministic: fixed inputs and a
// seeded generator, and the process time zone is forced to UTC (the services
// run in UTC, so "local time" in Date.parse is UTC). Numbers are stored as the
// 16 hex digits of their IEEE-754 bits so NaN, -0 and every last bit survive.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'UTC';
if (new Date(2026, 0, 1).getTimezoneOffset() !== 0) throw new Error('time zone must be UTC');

const here = dirname(fileURLToPath(import.meta.url));
const meta = { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode, cldr: process.versions.cldr };
// One vector per line, so a regeneration diff shows exactly which vectors changed.
const write = (name, data) => {
    const fields = Object.entries({ meta, ...data }).map(([key, value]) => {
        const body = Array.isArray(value) ? `[\n${value.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]` : JSON.stringify(value);
        return ` ${JSON.stringify(key)}: ${body}`;
    });
    writeFileSync(join(here, name), `{\n${fields.join(',\n')}\n}\n`);
};

// ---------------------------------------------------------------- helpers

const view = new DataView(new ArrayBuffer(8));
const bits = (x) => { view.setFloat64(0, x); return view.getBigUint64(0).toString(16).padStart(16, '0'); };
const fromBits = (b) => { view.setBigUint64(0, BigInt.asUintN(64, b)); return view.getFloat64(0); };

const MASK = (1n << 64n) - 1n;
let seed = 0x5eed_d1ca_7e57_0001n;
const next64 = () => {
    seed = (seed + 0x9e3779b97f4a7c15n) & MASK;
    let z = seed;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
};
const randInt = (n) => Number(next64() % BigInt(n));
const pick = (list) => list[randInt(list.length)];
const randomDouble = () => {
    for (;;) {
        const x = fromBits(next64());
        if (Number.isFinite(x)) return x;
    }
};
const unique = (list) => [...new Map(list.map((x) => [Object.is(x, -0) ? '-0' : typeof x === 'number' ? bits(x) : JSON.stringify(x), x])).values()];

// ---------------------------------------------------------------- numbers

const special = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    Number.EPSILON, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53, 2 ** 53 + 2, 2 ** 64, 2 ** 31, 2 ** 32, -(2 ** 31),
    2.2250738585072014e-308, 2.225073858507201e-308, 1.1125369292536007e-308, 4.9406564584124654e-324 * 3];

const toStringInputs = unique([
    ...special,
    ...Array.from({ length: 21 }, (_, i) => i), ...Array.from({ length: 21 }, (_, i) => -i),
    ...Array.from({ length: 25 }, (_, i) => 10 ** i), ...Array.from({ length: 25 }, (_, i) => 10 ** -i),
    ...Array.from({ length: 25 }, (_, i) => -(10 ** i)),
    1e21, 1e21 * (1 + Number.EPSILON), 1e21 * (1 - Number.EPSILON / 2), 999999999999999900000, 999999999999999999999, 123456789012345680000,
    1.2345e21, 1.2345e20, 1e-6, 1e-7, 1.5e-7, 9.999999e-7, 0.000001, 0.0000012345, 1.2345e-7, 0.00001, 1e-5, 1.0000000000000001e-6,
    9.999999999999999e-7, 1e100, 1e-100, 1.7976931348623157e308, 1e308, 1e-308, 1e-323, 3e-323,
    0.1, 0.2, 0.3, 0.1 + 0.2, 1 / 3, 2 / 3, 0.5, 0.25, 0.125, 1.5, Math.PI, Math.E, -Math.PI, 100 / 3, 1.005, 1.45, 8.345, 0.07,
    123.456, -123.456, 4.35, 1234.5678, 5e-7, 5e-6, 123e-20, 1.1, 2.2, 3.3, 9007199254740993, 18014398509481984, 0.000123,
    ...Array.from({ length: 64 }, (_, i) => 2 ** (i * 17 - 540)),
    ...Array.from({ length: 30 }, (_, i) => 2 ** (i - 15) * 3),
]);
while (toStringInputs.length < 330) toStringInputs.push(randomDouble());
for (let i = 0; i < 60; i++) toStringInputs.push(randInt(2 ** 30) / 10 ** randInt(12) * (randInt(2) ? 1 : -1));
for (let i = 0; i < 20; i++) toStringInputs.push(fromBits(BigInt(randInt(2 ** 31)) * BigInt(randInt(2 ** 21) + 1)));
// Every power of two, and halfway cases where two shortest candidates are equally close
// (V8 then takes the even digit): N + 0.25 and N + 0.75 near 2^50, N + 0.5 near 2^52, and kin.
for (let e = -1074; e <= 1023; e++) toStringInputs.push(2 ** e);
for (let i = 0; i < 60; i++) {
    const base = 2 ** (48 + randInt(5)) + randInt(2 ** 30);
    toStringInputs.push(base + pick([0.25, 0.75, 0.5, 0.125, 0.375, 0.625, 0.875]), -(base + 0.25));
}
toStringInputs.push(1e15 + 0.3, 2 ** 50 + 0.25, 2 ** 50 + 0.75, 2 ** 49 + 0.125, 4503599627370495.5, 2 ** -25, 2 ** -24, 2 ** -26);

const toFixedInputs = unique([0, -0, NaN, Infinity, -Infinity, 0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.125, 0.375, -0.125, 1.005, 1.45,
    8.345, 1.255, 10.235, 1.0005, 123.456, 0.000001, 1e-10, 1e20, 1e21, -1e21, 9.995, 99.995, 0.045, -0.0001, 0.0001, 5e-324,
    Number.MAX_VALUE, 999999999999999900000, 0.1, 0.2, 0.3, 0.1 + 0.2, 1 / 3, 2 / 3, Math.PI, 42, -42, 1234.5678, 0.00049999999,
    0.0005, 0.0015, 2.675, 1.0049999999999999, 4.35, 17.385, 1e-7, 123456789.98765433, 2 ** 53, 2 ** 70]);
for (let i = 0; i < 25; i++) toFixedInputs.push(randInt(2 ** 30) / 10 ** randInt(9) * (randInt(2) ? 1 : -1));
for (let i = 0; i < 5; i++) toFixedInputs.push(randomDouble());
const toFixed = [];
for (const x of toFixedInputs) for (const digits of [0, 1, 2, 3, 4, 6]) toFixed.push([bits(x), digits, x.toFixed(digits)]);
for (const x of [0.5, 1e-10, 123.456, 5e-324, Number.MAX_VALUE, 0.1, -0.0001, 1.005, 2 ** -30])
    for (const digits of [10, 20, 50, 100]) toFixed.push([bits(x), digits, x.toFixed(digits)]);

const localeInputs = unique([0, -0, NaN, Infinity, -Infinity, 1, 12, 123, 999, 1000, 1001, 9999, 10000, 12345, 123456, 1234567,
    1000000, 1e9, 1e21, 1e22, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 1.0005, 0.0005, 0.0004999, 1234.5678, 2.0005, 999.9995,
    9999.9995, 99999.9995, 0.1 + 0.2, -1234.5, -0.0001, -0.0005, 1e-7, 5e-324, 0.1, 1.5, 2.5, 1.2345, 1.2355, -1000, -12345, -1e6,
    1.0045, 1.0055, 0.9995, 12345.6789, 1e15 + 0.3, 2 ** 53, 2 ** 70, 1.23e-3, 123456789.987654, 2 ** 50 + 0.25, 2 ** 50 + 0.75,
    2 ** 49 + 0.0625, 2 ** 48 + 0.0625, 1125899906842624.125]);
for (let i = 0; i < 40; i++) localeInputs.push(randInt(2 ** 31) / 10 ** randInt(7) * (randInt(3) ? 1 : -1));
const formats = ['en-US', 'en', 'es-ES', 'es'].map((locale) => new Intl.NumberFormat(locale));
const locale = localeInputs.map((x) => {
    const [enUs, en, esEs, es] = formats.map((f) => f.format(x));
    if (enUs !== en || enUs !== x.toLocaleString('en-US') || esEs !== es) throw new Error(`locale variants differ for ${x}`);
    return [bits(x), enUs, esEs];
});

const ws = '\t\n\v\f\r \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}';
const numberStrings = [
    '', ' ', '\t\n', ws, '0', '-0', '+0', '1', '+1', '-1', ' 12 ', '\u{a0}12\u{feff}', `${ws}42${ws}`, '1.', '.5', '-.5', '+.5', '.',
    '+', '-', '1e3', '1E3', '1e+3', '1e-3', '1e', 'e3', '1e3.5', '1.2.3', '1.e5', '.e5', '-.e5', '0x10', '0X10', '-0x10', '+0x10',
    '0x', '0xg', '0x1g', '0b101', '0B2', '0b', '0o17', '0o8', '0O17', '0o', '00x10', 'Infinity', '-Infinity', '+Infinity',
    'infinity', 'INFINITY', 'inf', 'Inf', 'NaN', 'nan', '-NaN', '1_000', '1,000', '007', '08', '0.0000001', '-00.5',
    '123456789012345678901234567890', '1e400', '-1e400', '1e-400', '-1e-400', '2.2250738585072011e-308', '4.9e-324', '2.4e-324',
    '2.5e-324', '0x' + 'f'.repeat(20), '0x20000000000001', '0x20000000000003', '0x20000000000002', '0x' + 'f'.repeat(300),
    '0x' + 'f'.repeat(256), '0x' + 'f'.repeat(255), '0x1' + '0'.repeat(255), '0b' + '1'.repeat(60), '0b' + '1'.repeat(54),
    '0o' + '7'.repeat(30), '0x0000000000000000000000001', '\u{2028} 5 \u{2029}', '\u0085 5', '5\u0085', '5\u{180e}', '\u{180e}5',
    '１２', '١٢', '12px', '  0x1F  ', '0x1F.5', '- 1', '--1', '+-1', '1 2', '0o1706467650045030172466317145567324',
    '9007199254740993', '9007199254740992.5', '0.1', '.1e1', '1e+', '1e-', '+.e1', '0e0', '-0e0', '0.0e-5', '1' + '0'.repeat(400),
    '0.' + '0'.repeat(400) + '1', '1'.repeat(30) + '.' + '1'.repeat(30), '\u{2000}5\u{3000}', '0x-1', '0xFFFFFFFF', '0b-1', 'true',
    'null', '[]', '1\u0000', '\u00005', '١', '5.', '-5.', '+5.',
];
const parseNumber = numberStrings.map((s) => [s, bits(Number(s))]);

const parseIntCases = [];
for (const s of ['', '   ', '0', '-0', '+0', '12', '-12', '+12', ' 12abc', '12.9', '-12.9', '0x1F', '0X1f', '  -0x1F', '+0x1F', '0x',
    '0xg', '0x1g', '1e3', '0b11', '0o17', '08', '010', 'Infinity', '-Infinity', 'abc', 'zz', 'ZZ', 'z1', '123abc', '\u{a0} 42',
    '\u0085 42', '\u{feff}42', '\u{2028}-7', '- 7', '--7', '9007199254740993', '123456789012345678901234567890',
    '1'.repeat(400), '0'.repeat(400) + '5', '0'.repeat(30) + '123', '7'.repeat(25), 'ff', 'FF', 'fF', '11', '1010',
    '１２', '١٢', '0x' + 'f'.repeat(300), '0x' + '1'.repeat(16), '0x1' + '0'.repeat(13) + '8', '10000000000000000000000001']) {
    for (const radix of [undefined, 0, 2, 8, 10, 16, 36, 7, 1, 37, 3, 5, 32]) {
        parseIntCases.push([s, radix ?? 0, bits(parseInt(s, radix))]);
    }
}
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
for (let i = 0; i < 120; i++) {
    const radix = 2 + randInt(35);
    const length = 1 + randInt(i < 60 ? 14 : 60);
    let s = (randInt(4) === 0 ? '-' : '') + Array.from({ length }, () => alphabet[randInt(radix < 10 ? radix : radix + (radix - 10))] ?? '0').join('');
    if (randInt(5) === 0) s += pick(['x', '.5', ' 1', 'g', '!']);
    parseIntCases.push([s, radix, bits(parseInt(s, radix))]);
}

const parseFloatCases = ['', ' ', ' 1.5abc', '-.5e-3abc', '1e', '1e+', '1e+5x', '.e5', '.', '-', '+-1', 'Infinityx', '-Infinity',
    '+Infinity', 'infinity', 'Infinit', '0x10', '1.2.3', '  \n\t 42', '\u0085 42', `${ws}7.5${ws}`, '1_0', '-0', '+0', '-0.0', '1e1000',
    '-1e1000', '1e-1000', '00012', '3.14abc', '5e-324', '2.4703282292062327e-324', '2.4703282292062328e-324', '.5', '5.', '-.5',
    '1e5.5', '1E5', '1e-5', '123456789012345678901234567890', '0.1', '1' + '0'.repeat(400), '0.' + '0'.repeat(400) + '1', 'NaN',
    'abc', '١', '１', '  +.1e+1e2', '1e-7', '-1e-7', '9007199254740993', '1.7976931348623157e308', '1.7976931348623159e308',
    '4.9406564584124654e-324', '1.e1', '+.5', '-.e1', '0e', '0e1', '7e2x', '\u{feff}3'];
const parseFloat_ = parseFloatCases.map((s) => [s, bits(parseFloat(s))]);

const roundInputs = unique([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, -0.49999999999999994, -0.5000000000000001,
    0.5000000000000001, 4503599627370495.5, 4503599627370496, 4503599627370497, 9007199254740991, -4503599627370495.5, -0, 0, NaN,
    Infinity, -Infinity, 1e300, -1e300, 5e-324, -5e-324, 0.1, -0.1, 0.9, -0.9, 1.4999999999999998, -1.4999999999999998, 123.5,
    -123.5, 2 ** 52 + 1, -(2 ** 52) - 1, 0.7, -0.7]);
for (let i = 0; i < 40; i++) roundInputs.push(randInt(2 ** 20) / 2 ** randInt(8) * (randInt(2) ? 1 : -1));
const mathRound = roundInputs.map((x) => [bits(x), bits(Math.round(x))]);

const stringOfInputs = ['null', 'true', 'false', '0', '-0', '-0.0', '1.5', '1e21', '1e-7', '18446744073709551615',
    '123456789012345678901234567890', '"text"', '""', '"😀 ñ"', '[]', '[null]', '[null,null]', '[1,null,2]', '[[1,2],[3,[4,null]]]',
    '[[],[]]', '[[[]]]', '{}', '{"a":1}', '[{},{"b":2}]', '["a",true,false,null,1.25]', '[[null],[null,[null]]]', '[1e21,1e-7,-0]',
    '["x,y",["z"]]', '9007199254740993', '-9223372036854775808', '0.1', '[0.1,0.2,0.30000000000000004]', '[""]', '["",""]',
    '[" "]', '[[[[[[[[[[1]]]]]]]]]]'];
const stringOf = stringOfInputs.map((text) => [text, String(JSON.parse(text))]);

write('numbers.json', {
    to_string: toStringInputs.map((x) => [bits(x), String(x)]),
    to_fixed: toFixed,
    locale,
    parse_number: parseNumber,
    parse_int: parseIntCases,
    parse_float: parseFloat_,
    math_round: mathRound,
    string_of: stringOf,
});

// ---------------------------------------------------------------- whitespace

const whitespace = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (String.fromCodePoint(cp).trim() === '') whitespace.push(cp);
}
const trimInputs = ['', ' ', 'a', ' a ', `${ws}a b${ws}`, '\u0085a\u0085', '\u{180e}a\u{180e}', '\u{200b}a\u{200b}', '\u{feff}hello\u{a0}',
    '\u{2028}\u{2029}x\u{3000}', ' 😀 ', '\t\n\r\v\fx\f\v\r\n\t', 'a \u0085', '\u{a0}\u0085\u{a0}', `${ws}`, 'ñ  ', '  ש  '];
write('whitespace.json', {
    whitespace,
    trim: trimInputs.map((s) => [s, s.trim(), s.trimStart(), s.trimEnd()]),
});

// ---------------------------------------------------------------- JSON

const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
};
const rebuilt = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);

let controls = '';
for (let c = 0; c < 0x20; c++) controls += String.fromCharCode(c);
const jsonValues = [
    null, true, false, 0, -0, 1, -1, 1.5, 0.1, 0.1 + 0.2, 1e21, 1e-7, 1e-6, 1e300, 5e-324, Number.MAX_SAFE_INTEGER, 2 ** 64, 123456789,
    '', 'plain', controls, '\u007f\u0080\u009f', '"quoted" and \\back\\slash/', '\u{2028}\u{2029}', '😀👍🏽👨\u{200d}👩\u{200d}👧', '𐐀𝄞\u{10ffff}', '\u{feff}\u{fffd}\u{ffff}',
    'ñ á é ü Ñ', 'שלום עולם', 'e\u{301}', '</script>', [], {}, [[]], [{}], [null, 1, 'a', [true, { x: [] }]],
    { a: 1, b: [1, 2, { c: '\n' }], d: { e: { f: { g: null } } } },
    { 'ключ': 'значение', '😀': '😀', '': 'empty key', ' ': 'space', 'a\nb': 'newline key' },
    { z: 1, y: 2, x: 3, Z: 4, _: 5, '~': 6, 'é': 7, 'e': 8, '𐐀': 9, '\u{e000}': 10, 'ab': 11, 'a': 12, 'B': 13 },
    Array.from({ length: 20 }, (_, i) => ({ id: i, v: i / 7, s: String.fromCodePoint(0x1f600 + i) })),
];
const jsonTexts = [
    '{"b":1,"2":2,"a":3,"1":4,"-1":5,"01":6,"4294967294":7,"4294967295":8,"1.5":9,"10":10,"0":11," 3":12}',
    '{"a":1,"b":2,"a":3}',
    '{"outer":{"9":"nine","x":{"3":3,"y":0,"2":2}},"1":[{"b":0,"0":0}]}',
    '[1.0,2.50,-0,-0.0,1E2,1e+2,0.000001,0.0000001,100000000000000000000,1000000000000000000000,1.7976931348623157e308]',
    '"\\u0000\\u001f\\u0020\\u007f\\ud83d\\ude00\\u2028\\/"',
    '{"text":"line\\nbreak\\ttab\\r\\b\\f","emoji":"\\ud83d\\ude00","bom":"\\ufeff"}',
    '[18446744073709551615,-9223372036854775808,9007199254740993,123456789012345678901234567890]',
    '{"4294967293":"a","4294967296":"b","9007199254740993":"c","00":"d","-0":"e","0":"f"}',
    '{"\\u00e9":1,"e\\u0301":2,"E":3,"\\ud800\\udc00":4,"\\uffff":5}',
    '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]',
];
for (const v of jsonValues) jsonTexts.push(JSON.stringify(v));
const stringify = jsonTexts.map((input) => {
    const value = JSON.parse(input);
    return { input, expected: JSON.stringify(value), sorted: stableJson(value), rebuilt: rebuilt(value) };
});

const wellFormed = (value) => {
    if (typeof value === 'string') return value.toWellFormed();
    if (Array.isArray(value)) return value.map(wellFormed);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toWellFormed(), wellFormed(v)]));
    return value;
};
const sanitizeInputs = [
    '"\\ud800"', '"\\udc00"', '"\\uD83D\\uDE00"', '"\\ud83d\\ude00"', '"\\ud83d"', '"\\ude00"', '"\\ude00\\ud83d"', '"a\\ud83db"',
    '"\\ud83d\\ud83d\\ude00"', '"\\ud83d\\u0041"', '"\\\\ud800"', '"\\\\\\ud800"', '"\\\\\\\\ud800"', '{"\\ud800":"\\udfff"}',
    '["\\uDBFF\\uDFFF","\\uDBFF","x\\uDFFFy"]', '"plain"', '{"a":[1,2,"\\n"]}', '"\\u00e9\\ud800\\u00e9"', '"\\udbff\\udbff\\udfff"',
    '"😀"', '"\\ud83d😀"', '"\\uD800\\\\uDC00"', '"end\\ud800"', '"\\uDc00\\uD800\\uDC00"', '[]',
];
const sanitize = sanitizeInputs.map((input) => ({ input, expected: JSON.stringify(wellFormed(JSON.parse(input))) }));

write('json.json', { stringify, sanitize });

// ---------------------------------------------------------------- dates

const MAX_TIME = 8.64e15;
const isoInputs = [0, 1, -1, 120, 999, 1000, -1000, 86399999, 86400000, -86400000, 951782400000, 1794409445123, 1709164800000,
    253402300799999, 253402300800000, -62167219200000, -62167219200001, -62198755200000, -62135596800000, MAX_TIME, -MAX_TIME,
    MAX_TIME + 1, -MAX_TIME - 1, 8.64e15 - 1, -8.64e15 + 1, -377705116800000, -377705116800001, 1e15, -1e15, 4102444800000,
    951868800000, 951782399999, 978307200000, 946684799999];
for (let i = 0; i < 40; i++) isoInputs.push((randInt(2 ** 31) * 4096 + randInt(4096)) * (randInt(2) ? 1 : -1));
const iso = isoInputs.map((ms) => [ms, Math.abs(ms) <= MAX_TIME ? new Date(ms).toISOString() : null]);

const supported = [
    // ES date-time string format, as V8 parses it.
    '2026-11-11', '2026-11', '2026', '+002026-11-11', '-000001-01-01', '+000000-01-01', '2026-11-11T15:04', '2026-11-11T15:04:05',
    '2026-11-11T15:04:05Z', '2026-11-11T15:04:05.1Z', '2026-11-11T15:04:05.12Z', '2026-11-11T15:04:05.123Z', '2026-11-11T15:04:05.1239Z',
    '2023-07-19T14:56:51.634234626Z', '2026-11-11T15:04:05+01:00', '2026-11-11T15:04:05-0130', '2026-11-11T15:04:05+01',
    '2026-11-11t15:04:05z', '2026-11-11T24:00:00Z', '2026-11-11T24:00:01Z', '2026-11-11T24:00', '2026-11-11T24:00:00.000Z',
    '2026-11-11T24:00:00.001Z', '2026-02-30', '2026-02-29', '2024-02-29', '2026-13-01', '2026-00-01', '2026-11-00', '2026-11-32',
    '2026-11-11T15:60Z', '2026-11-11T15:04:60Z', '2026-11-11T25:00Z', '2026-11-11T15Z', '2026-11-11T15:04:05.Z',
    '2026-11-11T15:04:05.123+00:00', '2026-11-11T15:04:05 Z', '2026-11-11TZ', '2026-11-11T15:04Z', '2026-11-11T15:04+05:30',
    '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z',
    '2026-11-11T15:04:05.000000000000Z', '2026-11-11T15:04:05.0001234567891Z', '2026-11-11T15:04:05.9999999999Z',
    '2026-11-11T15:04:05,123Z', '2026-11-11T15:04:05+24:00', '2026-11-11T15:04:05+23:59', '2026-11-11T15:04:05-00:00',
    '2026-11-11T15:04:05+0000', '2026-11-11T15:04:05+2400', '2026-11-11T15:04:05+0060', '2026-11-11T15:04:05+1:00',
    '1970-01-01T00:00:00.000+00:00', '1969-12-31T23:59:59.999Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z',
    '+010000-01-01T00:00:00Z', '-000000-01-01T00:00:00Z', '2026-11-11T15:04:05.123456Z', '2026-11-11T15:04:05.5-08:00',
    '2026-11-11T15:04:05Zjunk', '2026-11-11T15:04:05.', '2026-11-11T', '2026-11-11T1', '2026-11-11T15:4', '2026-11-11T15:04:5',
 '', 'abc', '2026-11-11T15:04:05+01:00:00', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00Z',
    '2026T10:00', '2026-11T10:00Z', '2026-11-11T15:04:05.123-23:59', '2026-11-11T09:30+0930', '-271821-04-20', '+275760-09-13',
    '+275760-09-13T00:00:00.000+00:01', '-271821-04-19T23:59:59.999-00:01', '+999999-12-31', '-999999-01-01',
    // HTTP-date forms (RFC 9110: IMF-fixdate, RFC 850, asctime).
    'Wed, 21 Oct 2015 07:28:00 GMT', 'Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994',
    'Sun Nov 6 08:49:37 1994', 'Mon, 06 Nov 1994 08:49:37 GMT', '06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37 UTC',
    'Sun, 06 Nov 1994 08:49:37 UT', 'Sun, 06 Nov 1994 08:49:37 Z', 'Sun, 06 Nov 1994 08:49:37 +0000', 'Sun, 06 Nov 1994 08:49:37 -0130',
    'Sun, 06 Nov 1994 08:49:37 +0530', 'Sun, 6 Nov 1994 08:49:37 GMT', 'Thu, 01 Jan 1970 00:00:00 GMT', 'Sun, 06 Nov 2094 08:49:37 GMT',
    'Sunday, 06-Nov-49 08:49:37 GMT', 'Sunday, 06-Nov-50 08:49:37 GMT', 'Sunday, 06-Nov-1994 08:49:37 GMT', 'Sun, 31 Feb 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994 25:49:37 GMT', 'Sun, 06 Nov 1994 24:00:00 GMT', 'Sun, 06 Nov 1994 24:00:01 GMT', 'Sun, 06 Nov 1994 08:49 GMT',
    'sun, 06 nov 1994 08:49:37 gmt', 'SUN, 06 NOV 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37', 'Sun, 06 Nov 1994 08:60:37 GMT',
 'Sun, 32 Nov 1994 08:49:37 GMT', 'Sun, 00 Nov 1994 08:49:37 GMT', 'Fri, 31 Dec 1999 23:59:59 GMT',
    'Sat, 01 Jan 2000 00:00:00 GMT', 'Tue, 29 Feb 2028 12:00:00 GMT', 'Thursday, 01-Jan-70 00:00:00 GMT', 'Thu Jan  1 00:00:00 1970',
    'Mon Feb 29 12:34:56 2016', 'Sun, 06 Foo 1994 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994 GMT',
    'Wed, 11 Nov 2026 15:04:05 GMT', 'Wednesday, 11-Nov-26 15:04:05 GMT', 'Wed Nov 11 15:04:05 2026',
    'Sun, 06 Nov 1994 08:49:37 +9999', 'Sun, 06 Nov 1994 08:49:37 -2400', 'Sun, 06 Nov 94 08:49:37 GMT', 'Sun Nov 06 08:49:37 1994',
    'Sun, 06 Nov 0094 08:49:37 GMT', 'Sun, 06 Nov 1994 00:00 GMT', 'Sun, 06 Nov 1994 23:59:59 GMT', 'Sat, 31 Dec 1949 23:59:59 GMT',
];
const parse = supported.map((s) => [s, Number.isFinite(Date.parse(s)) ? Date.parse(s) : null]);
// Inputs V8's lenient legacy parser accepts that `parse_date` deliberately does not.
const unsupported = [' 2026-11-11', '2026-11-11 ', '2026-11-11 15:04:05', '2026-11-11 15:04:05Z', '2026-1-1', '002026-11-11',
    '+2026-11-11', '-000000-01-01', '0', '123', 'November 11, 2026', '11/11/2026', '2026/11/11', 'Wed Nov 11 2026',
    'Wed Nov 11 2026 15:04:05 GMT+0000 (Coordinated Universal Time)', 'Sun, 06 Nov 1994 08:49:37 EST', 'Sun, 06 Nov 1994 8:49:37 GMT',
    'Sun, 06 November 1994 08:49:37 GMT', '2026-11-1', '2026-1', 'Sun, 06 Nov 1994 08:49:60 GMT',
    'Sun, 06 Nov 1994 08:49:37 GMT junk', 'Funday, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37 GMT+0100'];
const parseUnsupported = unsupported.map((s) => [s, Number.isFinite(Date.parse(s)) ? Date.parse(s) : null]);

const utcCases = [[2026, 10, 11, 15, 4, 5, 123], [1970, 0, 1, 0, 0, 0, 0], [1970, 0, 1, 0, 0, 0, -1], [2026, 12, 1, 0, 0, 0, 0],
    [2026, -1, 1, 0, 0, 0, 0], [2026, -13, 1, 0, 0, 0, 0], [2026, 0, 0, 0, 0, 0, 0], [2026, 0, -400, 0, 0, 0, 0], [2026, 1, 29, 0, 0, 0, 0],
    [2024, 1, 29, 0, 0, 0, 0], [2026, 0, 1, 24, 0, 0, 0], [2026, 0, 1, -1, 0, 0, 0], [2026, 0, 1, 0, 60, 0, 0], [2026, 0, 1, 0, 0, -61, 0],
    [2026, 0, 1, 1000, 1000, 1000, 1000], [99, 0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0], [100, 0, 1, 0, 0, 0, 0], [-1, 0, 1, 0, 0, 0, 0],
    [-100, 0, 1, 0, 0, 0, 0], [275760, 8, 13, 0, 0, 0, 0], [275760, 8, 13, 0, 0, 0, 1], [-271821, 3, 20, 0, 0, 0, 0],
    [-271821, 3, 19, 23, 59, 59, 999], [1000000, 0, 1, 0, 0, 0, 0], [1000001, 0, 1, 0, 0, 0, 0], [1970, 10000000, 1, 0, 0, 0, 0],
    [1970, 10000001, 1, 0, 0, 0, 0], [1970, -10000000, 1, 0, 0, 0, 0], [1970, -10000001, 1, 0, 0, 0, 0], [1000000, -12000000, 1, 0, 0, 0, 0],
    [2000, 0, 1, 0, 0, 0, 8.64e15], [2000, 0, 1e8, 0, 0, 0, 0], [2000, 0, -1e8, 0, 0, 0, 0], [2000, 0, 1, 1e9, 0, 0, 0],
    [1600, 1, 29, 0, 0, 0, 0], [1900, 1, 29, 0, 0, 0, 0], [2100, 1, 29, 0, 0, 0, 0], [-400, 1, 29, 0, 0, 0, 0], [-401, 1, 29, 0, 0, 0, 0],
    [2026, 120, 1, 0, 0, 0, 0], [2026, 0, 1, 0, 0, 0, -86400000], [1969, 11, 31, 23, 59, 59, 999], [1, 0, 1, 0, 0, 0, 0]];
for (let i = 0; i < 30; i++) utcCases.push([1900 + randInt(300), randInt(30) - 9, randInt(70) - 20, randInt(50) - 10, randInt(130) - 30, randInt(130) - 30, randInt(3000) - 1000]);
const utc = utcCases.map((f) => { const t = Date.UTC(...f); return [f, Number.isFinite(t) ? t : null]; });

const fieldInputs = [...isoInputs.filter((ms) => Math.abs(ms) <= MAX_TIME), 1794355200000, 1794441599999, 1794441600000];
const fields = fieldInputs.map((ms) => {
    const d = new Date(ms);
    return [ms, [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), d.getUTCDay()]];
});

const localeTimes = [0, 1794355200000, 1794355200999, 1794398400000, 1794398399999, 1794401999999, 1794402000000, 1794409445123,
    1794441599999, 1794358506000, 1794394745000, 1709164800000, 951782400000, 978307199999, -1, -62198755200000, -62167219200000,
    -62135596800000, -62135596800001, 253402300799999, 253402300800000, MAX_TIME, -MAX_TIME, MAX_TIME + 1, -MAX_TIME - 1, -86400001,
    -377705116800000, 1e12, 1.5e12];
for (let i = 0; i < 25; i++) localeTimes.push(randInt(2 ** 31) * 2048 + randInt(2048));
const localeString = localeTimes.map((ms) => [ms, Math.abs(ms) <= MAX_TIME ? new Date(ms).toLocaleString('en-US', { timeZone: 'UTC' }) : null]);

// `toDateString()` prints local time. The services run in UTC, so pin the zone for this section
// (everything above is zone-independent, and nothing below formats dates).
process.env.TZ = 'UTC';
const dateString = localeTimes.map((ms) => [ms, Math.abs(ms) <= MAX_TIME ? new Date(ms).toDateString() : null]);

write('dates.json', { iso, parse, parse_unsupported: parseUnsupported, utc, fields, locale_string: localeString, date_string: dateString });

// ---------------------------------------------------------------- ordering

const pairs = (list, compare) => {
    let out = '';
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const c = compare(list[i], list[j]);
        out += c < 0 ? '<' : c > 0 ? '>' : '=';
    }
    return out;
};
const defaultCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const utf16Strings = ['', 'a', 'A', 'ab', 'a\u0000', 'b', 'z', '~', '\u007f', '\u0080', 'é', 'ñ', '\u{7ff}', '\u{800}', '\u{d7ff}',
    '\u{e000}', '\u{f8ff}', 'ﬁ', '\u{feff}', 'Ａ', '\u{fffd}', '\u{ffff}', '😀', '😁', '😀a', '😀\u{e000}', '😀\u{ffff}', '𐐀', '\u{10000}',
    '\u{10ffff}', '\u{1f600}\u{1f601}', 'a😀', 'a\u{e000}', 'a\u{ffff}', 'a𐐀', '\u{20000}', '\u{e0001}', 'x\u{10ffff}', 'x\u{ffff}', 'x\u{d7ff}',
    'Z', 'aa', 'aA', 'Aa', '1', '10', '2', '-', '[', '"', '\u{2028}', '👍🏽', '👍', '中', '中文', '\u{2f800}'];
const sortedUtf16 = [...utf16Strings].sort();

const collationStrings = ['a', 'A', 'b', 'B', 'ab', 'Ab', 'aB', 'AB', 'á', 'Á', 'à', 'â', 'ä', 'å', 'æ', 'e', 'é', 'É', 'e\u{301}', 'è', 'ê',
    'ë', 'n', 'ñ', 'Ñ', 'n\u{303}', 'o', 'ó', 'u', 'ü', 'ú', 'z', 'Z', 'ch', 'cz', 'ç', 'll', 'lz', 'árbol', 'arbol', 'Árbol', 'arco',
    'añejo', 'anejo', 'año', 'ano', 'zapato', 'Zapato', 'niño', 'nino', 'ninos', 'niña', 'canción', 'cancion', 'pingüino', 'pinguino',
    'España', 'espana', 'Estados', '0', '1', '2', '9', '10', '01', '1a', 'a1', 'a10', 'a2', '-', '_', ' ', '!', '?', '.', ',', ':', ';',
    '"', "'", '(', ')', '[', ']', '{', '}', '@', '#', '$', '%', '&', '*', '+', '=', '/', '\\', '|', '~', '^', '`', 'a b', 'a-b', 'a_b',
    'ab-', 'a.b', 'a,b', 'ß', 'ss', 'SS', 'ſ', 'ı', 'i', 'I', 'İ', 'œ', 'oe', 'ø', 'ð', 'þ', 'th', 'Ω', 'ω', 'α', 'а', 'я', 'ж', 'ア',
    'あ', '中', '한', 'ע', 'ا', '😀', '👍', '👍🏽', '€', '£', '$5', '5$', 'null', 'Null', 'NULL', 'true', 'prod', 'Prod', 'active',
    'canceled', 'trialing', 'past_due', '\u{a0}a', '\u{feff}a', 'a\u0000', '', '\u{301}', 'ﬁ', 'fi', 'Ａ', 'ｂ', '²', '2', 'Ⅳ', 'iv',
    'x\u{ffff}', 'x\u{e000}', 'x😀', 'login_1', 'login_10', 'login_2', 'Login', 'user.name', 'username', 'user-name', 'user_name'];
const ids = ['3f2a9c1e-7b4d-4e8f-a1c2-0d9e8f7a6b5c', '3F2A9C1E-7B4D-4E8F-A1C2-0D9E8F7A6B5C', '3f2a9c1e-7b4d-4e8f-a1c2-0d9e8f7a6b5d',
    '03f2a9c1-e7b4-d4e8-fa1c-20d9e8f7a6b5', 'a3f2a9c1-e7b4-d4e8-fa1c-20d9e8f7a6b5', 'sub_01J8Z3', 'sub_01j8z3', 'ben_9', 'ben_10'];
const jsonArrays = [];
for (const id of ids) {
    jsonArrays.push(JSON.stringify([id, 'prod_123', 'active', null, '2026-11-11T00:00:00.000Z', null, null]));
    jsonArrays.push(JSON.stringify([id, 'prod_123', 'trialing', '2026-12-11T00:00:00.000Z', null, '2026-11-11T00:00:00.000Z', null]));
    jsonArrays.push(JSON.stringify([id, 'ben_7']));
}
jsonArrays.push('["3f2a…","prod","active",null]', '["3f2a…","prod","active","x"]', '["3f2a","prod"]', '["3f2a-","prod"]', '[]', '[null]',
    '["a"]', '["A"]', '["a",null]', '["a","b"]', '["a\\"b"]');
const collationPairs = [...collationStrings, ...jsonArrays];
const spanishText = ['El niño comió piña', 'el nino comio pina', 'El Niño', 'él', 'el', 'Él', 'ÉL', 'acción', 'accion', 'acciones', 'árbol',
    'Ángel', 'angel', 'ángulo', 'ñandú', 'nandu', 'Ñu', 'nu', 'ojalá', 'ojala', 'cigüeña', 'ciguena', 'ChileNo', 'chileno', 'Chile',
    'llave', 'lluvia', 'luz', 'Lima', 'zorro', 'Zúrich', 'zurich', 'año nuevo', 'año-nuevo', 'añonuevo', 'pequeño', 'pequeno'];
const randomAlphabet = [...'aAbBcCeEnNoOzZ019 -_.,é É ñÑüÜáß', '😀', '👍🏽', '\u{e000}', '\u{ffff}', '𐐀'];
const randomStrings = Array.from({ length: 160 }, () => Array.from({ length: 1 + randInt(6) }, () => pick(randomAlphabet)).join(''));
// The TypeScript calls localeCompare without a locale, so it uses the process default, which is
// en-US in production (no LANG in the container). Pin it so the vectors do not follow this shell.
const collatorSort = (list) => [...list].sort((a, b) => a.localeCompare(b, 'en-US'));

write('order.json', {
    utf16: { strings: utf16Strings, pairs: pairs(utf16Strings, defaultCompare), sorted: sortedUtf16 },
    utf16_random: { strings: randomStrings, sorted: [...randomStrings].sort() },
    collation: { strings: collationPairs, pairs: pairs(collationPairs, (a, b) => a.localeCompare(b, 'en-US')) },
    collation_sorted: [collationStrings, spanishText, jsonArrays, randomStrings].map((list) => ({ input: list, sorted: collatorSort(list) })),
});

// ---------------------------------------------------------------- characters, UTF-16, case, normalisation

const encoder = new TextEncoder();
const texts = ['', 'a', 'hello', 'ñandú', 'é', 'e\u{301}', '😀', 'a😀b', '😀😀', '👍🏽', '👨\u{200d}👩\u{200d}👧\u{200d}👦', '🇪🇸🇲🇽', 'שלום', 'مرحبا بالعالم',
    'abc שלום def', '\u{202e}evil\u{202c}', 'ก\u{e48}า', '각', '\u{1100}\u{1161}\u{11a8}', '𐐀𝄞', '\u{10ffff}', '中文字符', 'Z\u{324}\u{354}\u{367}\u{311}\u{313}ä\u{356}\u{32d}\u{308}\u{307}l\u{36e}\u{312}\u{36b}ǧ\u{317}\u{35a}\u{31a}o\u{319}\u{314}\u{36e}\u{307}\u{350}\u{307}',
    'x\u0000y', '\u{feff}\u{fffd}', 'a\u{2028}b', 'mixed 😀 ñ ש 中 👍🏽!'];
const utf16 = texts.map((text) => {
    const boundaries = [];
    let byte = 0;
    let unit = 0;
    for (const ch of text) {
        boundaries.push([byte, unit]);
        byte += encoder.encode(ch).length;
        unit += ch.length;
    }
    boundaries.push([byte, unit]);
    const budgets = [];
    for (let n = 0; n <= text.length + 1; n++) {
        let cut = text.slice(0, n);
        const last = cut.charCodeAt(cut.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
        budgets.push([n, cut]);
    }
    return { text, chars: [...text].length, utf16: text.length, boundaries, budgets };
});

const lower = [];
const upper = [];
const nfcSingles = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    if (s.toLowerCase() !== s) lower.push([cp, s.toLowerCase()]);
    if (s.toUpperCase() !== s) upper.push([cp, s.toUpperCase()]);
    if (s.normalize('NFC') !== s) nfcSingles.push([cp, s.normalize('NFC')]);
}
const caseStrings = ['straße', 'STRASSE', 'İstanbul', 'ıi', 'ΣΑΣ', 'ΟΔΟΣ', 'ὈΔΥΣΣΕΎΣ', 'Σ', 'aΣ', 'aΣb', 'aΣ.', 'a.Σ', 'aΣ\u{301}', 'ΑΣ😀',
    'ŉ', 'ǰ', 'ΐ', 'ﬃ', 'ﬆ', 'ᾳ', 'ᾼ', 'Ꭰ', 'ꭰ', 'ა', 'Ა', 'ǅ', 'ǆ', 'Ǆ', 'ß', 'ẞ', 'ǈ', 'Ⅻ', 'ⓐ', '𐐀𐐨', 'Ñandú', 'ÁRBOL', 'mIxEd 😀 Case',
    'KELVIN \u{212a}', 'ohm \u{2126}', 'Å\u{212b}', 'ŀ', 'ĳ', 'Ĳ'];
const nfcStrings = ['', 'abc', 'e\u{301}', 'n\u{303}', 'A\u{30a}', 'Å', '\u{212b}', 'a\u{323}\u{302}', 'a\u{302}\u{323}', 'ệ', 'e\u{323}\u{302}',
    '\u{1100}\u{1161}\u{11a8}', '\u{1100}\u{1161}', '각', 'q\u{307}\u{323}', '\u{958}', 'ﬁ', 'Ω\u{301}', '\u{2126}', 'el nin\u{303}o comio\u{301}',
    '😀\u{301}', 'a\u{301}\u{301}', '\u{301}a', 'ḍ\u{307}', 'd\u{323}\u{307}', 'd\u{307}\u{323}', '\u{f73}', '\u{1d15e}', 'Á\u{301}'];
write('text.json', {
    utf16,
    lower,
    upper,
    case_strings: caseStrings.map((s) => [s, s.toLowerCase(), s.toUpperCase()]),
    nfc_singles: nfcSingles,
    nfc_strings: nfcStrings.map((s) => [s, s.normalize('NFC')]),
});

console.log('wrote numbers.json whitespace.json json.json dates.json order.json text.json');
