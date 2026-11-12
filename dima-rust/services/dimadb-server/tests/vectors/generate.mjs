// Records what the reference does with documents, using the reference's own packages
// (dimadb/server/node_modules: mongodb 6.20 with bson 6.10.4), so the Rust port can be tested
// against real output instead of a reading of the source.
//
//   TZ=UTC node dima-rust/services/dimadb-server/tests/vectors/generate.mjs
//
// Writes ejson.json next to this file:
// - "read": BSON bytes (hex) as the driver reads them (`BSON.deserialize` with the driver's read
//   options), then `EJSON.serialize` and `JSON.stringify`, which is what the console's
//   `/api/mongo/:id/docs` and `/doc` send. `id` is `String(doc._id)` (the `id` field), and `error`
//   the message when the reference throws.
// - "write": request JSON text, then `EJSON.deserialize` and the driver's `BSON.serialize`, which
//   is the document `insertOne` / `replaceOne` store (or the 400 message).
// - "filter": the same for the `filter` query (`parseFilter`).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '../../../../../dimadb/server');
const require = createRequire(join(serverDir, 'index.mjs'));
const { BSON } = require('mongodb');
const {
  Binary, Code, DBRef, Decimal128, Double, EJSON, Int32, Long, MaxKey, MinKey, ObjectId,
  BSONRegExp, BSONSymbol, Timestamp, UUID,
} = BSON;

const READ_OPTIONS = {
  promoteLongs: true, promoteValues: true, promoteBuffers: false, bsonRegExp: false,
  useBigInt64: false, fieldsAsRaw: undefined, raw: false, enableUtf8Validation: true,
};
const WRITE_OPTIONS = { checkKeys: false, serializeFunctions: false, ignoreUndefined: false };

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const oid = new ObjectId('6650a1b2c3d4e5f601234567');

// Raw BSON builders for types bson cannot write from JavaScript values (undefined, DBPointer,
// duplicate keys).
function cstring(text) { return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]); }
function element(type, name, payload) { return Buffer.concat([Buffer.from([type]), cstring(name), payload]); }
function doc(elements) {
  const body = Buffer.concat([...elements, Buffer.from([0])]);
  const size = Buffer.alloc(4);
  size.writeInt32LE(body.length + 4);
  return Buffer.concat([size, body]);
}
function int32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; }
function str(text) { const s = cstring(text); return Buffer.concat([int32(s.length), s]); }

const reads = [];
function read(name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(BSON.serialize(value, WRITE_OPTIONS));
  const entry = { name, bson: hex(bytes) };
  try {
    const parsed = BSON.deserialize(bytes, READ_OPTIONS);
    entry.json = JSON.stringify(EJSON.serialize(parsed));
    entry.id = parsed?._id == null ? '' : String(parsed._id);
  } catch (error) {
    entry.error = error.message;
  }
  reads.push(entry);
}

read('strings', {
  _id: oid, ascii: 'hello', empty: '', emoji: '🍕 pizza 👋🏽', combining: 'é ñ',
  rtl: 'مرحبا שלום', controls: 'a\u0000b\u0001\t\n\r"\\/', separators: '  ', bom: '﻿x',
});
read('int32', { _id: 'i32', zero: new Int32(0), neg: new Int32(-1), max: new Int32(2147483647), min: new Int32(-2147483648) });
read('int64', {
  _id: 'i64', zero: Long.fromNumber(0), five: Long.fromNumber(5), neg: Long.fromNumber(-7),
  safe: Long.fromString('9007199254740991'), two53: Long.fromString('9007199254740992'),
  above: Long.fromString('9007199254740993'), negAbove: Long.fromString('-9007199254740993'),
  max: Long.MAX_VALUE, min: Long.MIN_VALUE, big: Long.fromString('1234567890123456789'),
});
read('double', {
  _id: 'dbl', zero: new Double(0), negZero: new Double(-0), one: new Double(1), half: new Double(1.5),
  tenth: new Double(0.1), big: new Double(1e21), bigger: new Double(123456789012345680000),
  small: new Double(1e-7), tiny: new Double(5e-324), max: new Double(1.7976931348623157e308),
  nan: new Double(NaN), inf: new Double(Infinity), ninf: new Double(-Infinity),
  third: new Double(1 / 3), neg: new Double(-2.5e-10), int53: new Double(9007199254740993),
});
read('decimal128', {
  _id: 'dec',
  values: ['1.0', '-0', '0', 'NaN', 'Infinity', '-Infinity', '1E+10', '0.000001', '0.0000001',
    '1.23E-40', '1234567890123456789012345678901234', '-1.5', '100', '1E+3', '12345.6789E-20',
    '9.999999999999999999999999999999999E+6144'].map((s) => Decimal128.fromString(s)),
});
read('objectid', { _id: oid, ref: new ObjectId('000000000000000000000000') });
read('dates', {
  _id: 'dates', epoch: new Date(0), beforeEpoch: new Date(-1), whole: new Date('2026-11-11T10:00:00.000Z'),
  millis: new Date('2026-11-11T10:00:00.123Z'), y9999: new Date(253402300799999),
  limit: new Date(253402318800000), justBelow: new Date(253402318799999), old: new Date('1900-01-01T00:00:00Z'),
  far: new Date(8.64e15),
});
read('date beyond the JavaScript range', doc([element(0x09, '_id', Buffer.from('0040b2bac9e0e1ff', 'hex').reverse()),
  element(0x09, 'over', (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(8640000000000001n); return b; })())]));
read('binary', {
  _id: 'bin', empty: new Binary(Buffer.alloc(0)), bytes: new Binary(Buffer.from([0, 1, 2, 250, 255])),
  uuid: new Binary(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), 4),
  uuidShort: new Binary(Buffer.from('0123', 'hex'), 4), legacyUuid: new Binary(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), 3),
  md5: new Binary(Buffer.from('d41d8cd98f00b204e9800998ecf8427e', 'hex'), 5), user: new Binary(Buffer.from('hi'), 0x80),
  old: new Binary(Buffer.from('abc'), 2), sensitive: new Binary(Buffer.from('x'), 8),
});
read('regex plain', { _id: 're', a: new BSONRegExp('^a.c$', 'i'), b: new BSONRegExp('a/b', ''), c: new BSONRegExp('', 'm'),
  d: new BSONRegExp('x\ny', ''), e: new BSONRegExp('[/]', 'im'), f: new BSONRegExp('\\/', ''), g: new BSONRegExp('é😀', 'u'),
  h: new BSONRegExp('a b', 'x'), i: new BSONRegExp('a b\rc', 'l') });
read('regex with s option', { _id: 're2', a: new BSONRegExp('a.b', 's') });
read('timestamp', { _id: 'ts', a: new Timestamp({ t: 1, i: 2 }), max: new Timestamp({ t: 4294967295, i: 4294967295 }), zero: new Timestamp({ t: 0, i: 0 }) });
read('keys', { _id: 'keys', z: 1, '10': 'ten', '2': 'two', a: 'a', '0': 'zero', '-1': 'm', '01': 'lead', '4294967294': 'max', '4294967295': 'over', '1.5': 'f', 'ключ': 'k', '🍕': 'p', '': 'empty', nested: { b: 1, '1': 2, arr: [{ '3': 'x', y: 'z' }] } });
read('proto key', doc([element(0x02, '_id', str('proto')), element(0x02, '__proto__', str('x')), element(0x10, 'a', int32(1))]));
read('duplicate keys', doc([element(0x02, '_id', str('dup')), element(0x10, 'a', int32(1)), element(0x10, 'b', int32(2)), element(0x10, 'a', int32(3))]));
read('minmax code symbol', { _id: 'misc', min: new MinKey(), max: new MaxKey(), code: new Code('function () { return 1; }'),
  scoped: new Code('x + y', { x: new Int32(1), y: { z: new Date(0) } }), sym: new BSONSymbol('sym'), t: true, f: false, n: null });
read('dbref', { _id: 'ref', a: new DBRef('coll', oid), b: new DBRef('coll', 'text-id', 'otherdb'),
  c: new DBRef('coll', new Int32(5), undefined, { extra: 1, more: 'x' }) });
read('dbref shapes', doc([element(0x02, '_id', str('refs')),
  element(0x03, 'flipped', doc([element(0x07, '$id', oid.id), element(0x02, '$ref', str('c'))])),
  element(0x03, 'nullid', doc([element(0x02, '$ref', str('c')), element(0x0a, '$id', Buffer.alloc(0))])),
  element(0x03, 'numref', doc([element(0x10, '$ref', int32(1)), element(0x10, '$id', int32(1))])),
  element(0x03, 'otherdollar', doc([element(0x02, '$ref', str('c')), element(0x10, '$id', int32(1)), element(0x10, '$x', int32(1))])),
  element(0x03, 'numdb', doc([element(0x02, '$ref', str('c')), element(0x10, '$id', int32(1)), element(0x10, '$db', int32(1))])),
  element(0x03, 'lonedollar', doc([element(0x02, '$where', str('x'))])),
]));
read('undefined and dbpointer', doc([element(0x02, '_id', str('legacy')), element(0x06, 'undef', Buffer.alloc(0)),
  element(0x0c, 'ptr', Buffer.concat([str('db.coll'), oid.id])),
  element(0x04, 'arr', doc([element(0x06, '0', Buffer.alloc(0)), element(0x10, '1', int32(1))]))]));
read('arrays', { _id: 'arr', empty: [], mixed: [1, 'a', null, [true], { x: 1 }], deep: [[[[1]]]] });
for (const [name, id] of [['id int32', new Int32(5)], ['id double', new Double(2.5)], ['id long', Long.fromString('9007199254740993')],
  ['id date', new Date('2026-11-11T10:00:00Z')], ['id object', { a: 1 }], ['id array', [1, 2]], ['id bool', true],
  ['id binary', new Binary(Buffer.from('ab'))], ['id uuid', new Binary(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), 4)],
  ['id decimal', Decimal128.fromString('1.5')], ['id null', null], ['id negzero', new Double(-0)], ['id big double', new Double(1e21)],
  ['id regex', new BSONRegExp('a', 'i')], ['id timestamp', new Timestamp({ t: 1, i: 2 })], ['id minkey', new MinKey()],
  ['id code', new Code('x')], ['id symbol', new BSONSymbol('s')], ['id empty string', ''], ['id emoji', '🍕']]) {
  read(name, { _id: id, v: 1 });
}

const writes = [];
function write(name, text) {
  const entry = { name, text };
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    const decoded = EJSON.deserialize(value);
    entry.bson = hex(BSON.serialize(decoded, WRITE_OPTIONS));
  } catch (error) {
    entry.error = error.message;
  }
  writes.push(entry);
}

write('numbers', '{"int":1,"neg":-1,"intMax":2147483647,"over":2147483648,"intMin":-2147483648,"under":-2147483649,"float":1.5,"one":1.0,"negZero":-0,"negZeroF":-0.0,"zeroF":0.0,"e":1e2,"big":9007199254740993,"huge":1e300,"tiny":5e-324,"neg53":-9007199254740992}');
write('ejson numbers', '{"i":{"$numberInt":"7"},"l":{"$numberLong":"5"},"lBig":{"$numberLong":"9007199254740993"},"lMax":{"$numberLong":"9223372036854775807"},"d":{"$numberDouble":"2.0"},"dHalf":{"$numberDouble":"2.5"},"nan":{"$numberDouble":"NaN"},"inf":{"$numberDouble":"Infinity"},"ninf":{"$numberDouble":"-Infinity"},"dNegZero":{"$numberDouble":"-0.0"},"dec":{"$numberDecimal":"1.10"},"decNaN":{"$numberDecimal":"NaN"},"decNeg":{"$numberDecimal":"-0"},"iText":{"$numberInt":"12abc"},"lNeg":{"$numberLong":"-42"}}');
write('bad numberLong', '{"l":{"$numberLong":"12x"}}');
write('long numberLong', '{"l":{"$numberLong":"123456789012345678901"}}');
write('bad decimal', '{"d":{"$numberDecimal":"abc"}}');
write('oid', '{"_id":{"$oid":"6650a1b2c3d4e5f601234567"},"o":{"$oid":"6650A1B2C3D4E5F601234567"}}');
write('bad oid', '{"o":{"$oid":"xyz"}}');
write('dates', '{"iso":{"$date":"2026-11-11T10:00:00Z"},"ms":{"$date":"2026-11-11T10:00:00.123Z"},"num":{"$date":1700000000000},"long":{"$date":{"$numberLong":"-1"}},"offset":{"$date":"2026-11-11T12:00:00+02:00"},"bad":{"$date":"not a date"},"day":{"$date":"2026-11-11"}}');
write('bad date type', '{"d":{"$date":true}}');
write('binary', '{"b":{"$binary":{"base64":"AAEC+v8=","subType":"00"}},"u":{"$binary":{"base64":"ASNFZ4mrze8BI0VniavN7w==","subType":"04"}},"x":{"$binary":{"base64":"aGk=","subType":"80"}},"uuid":{"$uuid":"01234567-89ab-cdef-0123-456789abcdef"},"legacy":{"$binary":"aGk=","$type":"00"}}');
write('regex', '{"r":{"$regularExpression":{"pattern":"^a/b$","options":"mi"}},"old":{"$regex":"x","$options":"si"}}');
write('bad regex option', '{"r":{"$regularExpression":{"pattern":"a","options":"g"}}}');
write('timestamp', '{"t":{"$timestamp":{"t":1,"i":2}}}');
write('min max code symbol', '{"min":{"$minKey":1},"max":{"$maxKey":1},"code":{"$code":"x"},"scoped":{"$code":"y","$scope":{"a":1}},"sym":{"$symbol":"s"},"undef":{"$undefined":true}}');
write('dbref', '{"r":{"$ref":"c","$id":{"$oid":"6650a1b2c3d4e5f601234567"}},"d":{"$ref":"c","$id":1,"$db":"x","extra":true},"flip":{"$id":"a","$ref":"c"},"other":{"$ref":"c","$id":1,"$other":2}}');
write('keys and text', '{"b":1,"10":"ten","2":"two","a":"a","ключ":"🍕","emoji 👋":{"z":1,"1":2},"rtl":"مرحبا","comb":"e\\u0301"}');
write('dollar keys', '{"$set":{"a":1}}');
write('nested dollar keys', '{"a":{"$foo":1,"b":2},"c":[{"$x":1}]}');
write('null byte key', '{"a\\u0000b":1}');
write('arrays and null', '{"a":[1,2.5,"x",null,true,{"$oid":"6650a1b2c3d4e5f601234567"}],"n":null}');
write('date as long object', '{"d":{"$date":{"$numberLong":"1700000000000"}}}');
write('first dollar key wins', '{"x":{"$foo":1,"$numberInt":"3"}}');
write('date with other keys', '{"x":{"$date":"2026-11-11T10:00:00Z","extra":1}}');
write('oid with other keys', '{"x":{"$oid":"6650a1b2c3d4e5f601234567","extra":1}}');
write('null dollar value skipped', '{"x":{"$oid":null,"$numberInt":"4"}}');
write('id null', '{"_id":null,"a":1}');
write('date out of range', '{"d":{"$date":{"$numberLong":"8640000000000001"}}}');
write('date number string', '{"d":{"$date":"1700000000000"}}');
write('numberInt text', '{"a":{"$numberInt":"  42"},"b":{"$numberInt":"0x10"},"c":{"$numberInt":"9999999999"},"d":{"$numberInt":""}}');
write('numberDouble text', '{"a":{"$numberDouble":"1e400"},"b":{"$numberDouble":"  3.5abc"},"c":{"$numberDouble":"x"}}');

const filters = [];
for (const [name, text] of [['empty', '{}'], ['eq', '{"a":1}'], ['oid', '{"_id":{"$oid":"6650a1b2c3d4e5f601234567"}}'],
  ['gt date', '{"at":{"$gt":{"$date":"2026-01-01T00:00:00Z"}}}'], ['regex', '{"name":{"$regex":"^a","$options":"i"}}'],
  ['in', '{"n":{"$in":[1,2.5,{"$numberLong":"9007199254740993"}]}}'], ['array', '[]'], ['number', '5'], ['string', '"x"'],
  ['null', 'null']]) {
  const entry = { name, text };
  try {
    const parsed = EJSON.deserialize(JSON.parse(text));
    entry.keys = parsed !== null && typeof parsed === 'object' ? Object.keys(parsed).length : null;
    entry.bson = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? hex(BSON.serialize(parsed, WRITE_OPTIONS)) : null;
  } catch (error) {
    entry.error = error.message;
  }
  filters.push(entry);
}

writeFileSync(join(here, 'ejson.json'), `${JSON.stringify({ generator: 'generate.mjs', node: process.version, reads, writes, filters }, null, 1)}\n`);
console.log(`reads=${reads.length} writes=${writes.length} filters=${filters.length}`);
