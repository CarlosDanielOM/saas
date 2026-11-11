// Golden recordings of what Mongoose 8 (on the Node driver) really sends to MongoDB and stores,
// for the `dima_store::mongo` write helpers and JSON renderer.
//
//   eval "$(dima-rust/tools/test-env)"
//   DIMABOT_DIR=/path/to/a/dimabot/checkout/with/node_modules \
//     node dima-rust/crates/store/tests/mongo_golden/record.mjs
//
// DIMABOT_DIR defaults to the `dimabot/` directory of this repository; a git worktree without
// `node_modules` must point it at a checkout that has them (production versions: mongoose 8.24.3,
// mongodb 6.x, bson 6.x). The script refuses to run against other Mongoose versions.
//
// It creates a throwaway database `dima_test_store_golden_<random>`, drops it at the end, and writes
// `golden.json` next to this file (one case per line, so a regeneration diff shows what changed).
//
// What is recorded per case:
//   - `seed`: documents inserted with the raw driver before the operation (no Mongoose involved);
//   - `intent`: what the caller asked Mongoose to do (filter, update, options, document, changes);
//   - `commands`: every write command Mongoose sent, with the driver envelope removed, as the
//     driver serialised it (re-read with `promoteValues: false`, so int32/int64/double stay exact);
//   - `result`: the document `findOneAndUpdate` returned (raw, before hydration), when relevant;
//   - `stored`: the whole collection afterwards, sorted by `_id`.
// Everything is canonical Extended JSON.
//
// Normalisation (applied to commands, result and stored documents, never to seed or intent):
//   - Dates: every date that falls inside the window in which the case ran (read from the clock just
//     before and just after it) is "now" and is replaced by the sentinel NOW_MS below. Fixtures use
//     fixed dates years away from the recording time, so they are never touched. The Rust tests
//     pass NOW_MS as the current time to the helpers, so their output needs no date normalisation.
//   - ObjectIds: an ObjectId that does not appear in the case's seed or intent was generated (by
//     Mongoose for `_id` and sub-document ids, or by the server for upserts). Each one is replaced by
//     `ffffffffffffffff` followed by an 8-digit counter, numbered by first appearance while walking
//     commands, then result, then stored documents, keys in stored order. The Rust tests apply the
//     same function to their own output, so ids are compared by where they appear, not by value.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dimabotDir = process.env.DIMABOT_DIR || resolve(here, '../../../../../dimabot');
const require = createRequire(join(dimabotDir, 'package.json'));
const mongoose = require('mongoose');
const mongooseRequire = createRequire(require.resolve('mongoose'));
const mongodbForMongoose = mongooseRequire('mongodb');
const BSON = mongooseRequire('bson');
const { EJSON, ObjectId, Long, Int32, Double, Decimal128, Binary, BSONRegExp, Timestamp, MinKey, MaxKey, Code, BSONSymbol, UUID } = BSON;

if (mongoose.version !== '8.24.3') throw new Error(`expected mongoose 8.24.3, found ${mongoose.version}`);
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');

const NOW_MS = Date.UTC(2001, 1, 3, 4, 5, 6, 789);
const GENERATED_PREFIX = 'ffffffffffffffff';
const dbName = `dima_test_store_golden_${randomInt(1e9)}`;

const { Schema } = mongoose;

// ---------------------------------------------------------------- schemas
//
// The option matrix of `ledger/mongo.md`: timestamps in both naming styles and none, `versionKey`
// on and off, ObjectId and string `_id`, `minimize` on and off, literal and computed defaults,
// nested objects, arrays of sub-documents with and without `_id`, single nested sub-documents,
// Map and Mixed fields, `trim` setters and `immutable` paths. The Rust tests declare the same
// collections with `dima_store::mongo::CollectionSpec` (see `tests/mongo_golden.rs`).

const ItemSub = new Schema({
    label: { type: String, trim: true },
    n: { type: Number, default: 1 },
    at: Date,
}, { _id: true });
const PlainSub = new Schema({ label: String, on: { type: Boolean, default: false } }, { _id: false });
const OptsSub = new Schema({
    enabled: { type: Boolean, default: true },
    mode: { type: String, default: 'start' },
    list: { type: [String], default: () => ['a', 'b'] },
}, { _id: false });

const schemas = {
    // timestamps createdAt/updatedAt, __v, ObjectId _id, minimize on.
    camel: new Schema({
        name: { type: String, trim: true },
        key: { type: String, immutable: true },
        count: { type: Number, default: 0 },
        score: Number,
        tags: [String],
        items: [ItemSub],
        plain: [PlainSub],
        nested: {
            a: { type: String, default: 'x' },
            b: Number,
            deep: { c: { type: Boolean, default: false } },
        },
        opts: { type: OptsSub, default: () => ({ enabled: true }) },
        meta: { type: Schema.Types.Mixed, default: () => ({}) },
        blob: Schema.Types.Mixed,
        vars: { type: Map, of: String },
        leaseUntil: { type: Date, default: () => new Date(0) },
        seenAt: { type: Date, default: Date.now },
        flag: { type: Boolean, default: null },
    }, { timestamps: true }),

    // timestamps created_at/updated_at, __v, users-like accounts with sub-document _id.
    snake: new Schema({
        channelID: { type: String, required: true },
        status: { type: String, default: 'active' },
        total: { type: Number, default: 0 },
        ended_at: { type: Date, default: null },
        settings: {
            enabled: { type: Boolean, default: true },
            mode: { type: String, default: 'auto' },
        },
        history: [{ _id: false, at: Date, v: Number }],
        accounts: [new Schema({
            type: { type: String, default: 'twitch' },
            id: { type: String, default: null },
            token: {
                iv: { type: String, default: null },
                content: { type: String, default: null },
            },
            active: { type: Boolean, default: true },
        })],
        responses: { type: Array, default: [] },
        variables: { type: Map, of: String, default: {} },
    }, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }),

    // no timestamps, no __v, string _id (the shape of 39 collections), epoch-ms numbers.
    plain: new Schema({
        _id: { type: String, required: true },
        channelID: { type: String, immutable: true },
        dueAt: { type: Number, default: 0 },
        payload: Schema.Types.Mixed,
        state: {
            seq: { type: Number, default: 0 },
            ids: [String],
        },
        expiresAt: Date,
        label: { type: String, trim: true, default: '' },
    }, { versionKey: false }),

    // minimize off (custom_widgets, custom_widget_store, site_agent_changes), timestamps, no __v.
    nomin: new Schema({
        _id: { type: String, required: true },
        config: { type: Schema.Types.Mixed, default: () => ({}) },
        extra: { type: Schema.Types.Mixed, default: {} },
        meta: { a: String, b: { c: String } },
        list: [String],
    }, { minimize: false, timestamps: true, versionKey: false }),

    // no timestamps option, hand-written createdAt/updatedAt with Date.now defaults (admins, events).
    hand: new Schema({
        name: String,
        enabled: { type: Boolean, default: true },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
    }),
};

const collections = {
    camel: 'golden_camels', snake: 'golden_snakes', plain: 'golden_plains', nomin: 'golden_nomins', hand: 'golden_hands',
};
const models = {};

// ---------------------------------------------------------------- fixtures

const T1 = new Date('2020-01-02T03:04:05.006Z');
const T2 = new Date('2021-06-07T08:09:10.011Z');
const OID = (n) => new ObjectId(n.toString(16).padStart(24, '0'));
const oid1 = OID(1), oid2 = OID(2), oid3 = OID(3), oid4 = OID(4), oid9 = OID(9);
const sub1 = OID(0x101), sub2 = OID(0x102);

const camelSeed = () => ({
    _id: oid1, name: 'seed', key: 'k1', count: 5, score: 1.5, tags: ['a'],
    items: [{ label: 'i1', n: 2, _id: sub1 }, { label: 'i2', n: 3, _id: sub2 }],
    plain: [{ label: 'p1', on: true }],
    nested: { a: 'na', b: 7, deep: { c: true } },
    opts: { enabled: false, mode: 'exact', list: ['z'] },
    meta: { k: 'v' }, vars: { one: '1' },
    leaseUntil: new Date(0), seenAt: T1, flag: null,
    createdAt: T1, updatedAt: T1, __v: 3,
});
// A document written by an older release: several defaulted paths are missing (gh-2558).
const camelSparseSeed = () => ({ _id: oid2, name: 'sparse', tags: [], createdAt: T1, updatedAt: T1, __v: 0 });
const snakeSeed = () => ({
    _id: oid1, channelID: 'c1', status: 'active', total: 10, ended_at: null,
    settings: { enabled: true, mode: 'auto' }, history: [{ at: T1, v: 1 }],
    accounts: [{ _id: sub1, type: 'twitch', id: '111', token: { iv: 'iv', content: 'ct' }, active: true }],
    responses: ['r'], variables: { x: 'y' },
    created_at: T1, updated_at: T1, __v: 0,
});
const plainSeed = () => ({ _id: 'p1', channelID: 'c1', dueAt: 1700000000000, payload: { deep: [1, { two: 2 }] }, state: { seq: 4, ids: ['a'] }, expiresAt: T2, label: 'l' });
const nominSeed = () => ({ _id: 'n1', config: { theme: {} }, extra: {}, meta: { a: 'x', b: {} }, list: [], createdAt: T1, updatedAt: T1 });
const handSeed = () => ({ _id: oid1, name: 'h', enabled: true, createdAt: T1, updatedAt: T1, __v: 0 });

// Text that must survive untouched: emoji, combining marks, right-to-left, zero-width joiner.
const TEXT = 'héllo 👋🏽 ñ ç مرحبا שלום e\u0301 👨‍👩‍👧';

// ---------------------------------------------------------------- cases
//
// `op` names the Mongoose call; everything else is its arguments. Values are cloned (through
// Extended JSON) before each call, because Mongoose mutates the update objects it is given.

const cases = [
    // ---- create / new + save / insertMany
    { name: 'create_camel_minimal', schema: 'camel', op: 'create', doc: { name: 'only name' } },
    { name: 'create_camel_full', schema: 'camel', op: 'create', doc: {
        tags: ['b', 'c'], name: '  padded  ', zzz: 'unknown path is dropped', count: 3, score: 2.5,
        items: [{ label: '  first ', at: T2 }, { n: 9 }], plain: [{ label: 'p' }],
        nested: { b: 2 }, opts: { mode: 'exact' }, meta: { k: 1 }, blob: { any: ['thing', 1] },
        vars: { a: 'b' }, key: 'kk', flag: true,
    } },
    { name: 'create_camel_explicit_id_and_timestamps', schema: 'camel', op: 'create', doc: { _id: oid9, name: 'n', createdAt: T1, updatedAt: T2 } },
    { name: 'create_camel_empty_objects', schema: 'camel', op: 'create', doc: { meta: {}, blob: {}, nested: { deep: {} }, opts: {}, tags: [], items: [] } },
    { name: 'create_camel_nested_full', schema: 'camel', op: 'create', doc: { nested: { deep: { c: true }, b: 1, a: 'given' } } },
    { name: 'create_camel_nulls', schema: 'camel', op: 'create', doc: { name: null, score: null, nested: null, opts: null, meta: null, seenAt: null, tags: null } },
    { name: 'create_camel_text', schema: 'camel', op: 'create', doc: { name: `  ${TEXT}\u00a0`, meta: { [TEXT]: TEXT, 'a b': { 'ключ': '值' } }, vars: { 'emoji👋': TEXT } } },
    { name: 'new_save_camel', schema: 'camel', op: 'newSave', doc: { name: 'via new', count: 1 } },
    { name: 'create_snake', schema: 'snake', op: 'create', doc: { channelID: 'c9', accounts: [{ id: '42' }, { type: 'kick', token: { iv: 'i' } }], history: [{ v: 1 }] } },
    { name: 'create_snake_with_variables', schema: 'snake', op: 'create', doc: { channelID: 'c8', variables: {}, responses: [] , settings: { mode: 'manual' } } },
    { name: 'create_plain', schema: 'plain', op: 'create', doc: { _id: 'p9', channelID: 'c', label: '  trimmed ' } },
    { name: 'create_plain_full', schema: 'plain', op: 'create', doc: { payload: { z: 1, a: [] }, _id: 'p8', expiresAt: T2, state: { ids: ['x'] }, dueAt: 1700000000123 } },
    { name: 'create_nomin', schema: 'nomin', op: 'create', doc: { _id: 'n9' } },
    { name: 'create_nomin_empty_values', schema: 'nomin', op: 'create', doc: { _id: 'n8', config: { a: {} }, meta: { b: {} }, list: [] } },
    { name: 'create_hand', schema: 'hand', op: 'create', doc: { name: 'admin' } },
    { name: 'insert_many_camel', schema: 'camel', op: 'insertMany', docs: [{ name: 'm1' }, { name: 'm2', count: 2, items: [{ label: 'x' }] }] },
    { name: 'insert_many_plain', schema: 'plain', op: 'insertMany', docs: [{ _id: 'pm1' }, { _id: 'pm2', state: { seq: 1 } }] },

    // ---- updateOne / updateMany without upsert
    { name: 'update_set', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { score: 3, 'nested.b': 8 } } },
    { name: 'update_bare_fields', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { name: '  yo ', $inc: { count: 1 }, score: 4 } },
    { name: 'update_caller_sets_updated_at', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { updatedAt: T2, score: 1 } } },
    { name: 'update_caller_bare_updated_at', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { updatedAt: T2, $set: { score: 1 } } },
    { name: 'update_caller_sets_created_at', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { createdAt: T2, score: 1 } } },
    { name: 'update_caller_bare_created_at', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { createdAt: T2, count: 2 } },
    { name: 'update_current_date', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $currentDate: { updatedAt: true }, $set: { score: 1 } } },
    { name: 'update_pipeline', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: [{ $set: { count: { $add: ['$count', 1] } } }, { $unset: 'blob' }] },
    { name: 'update_pipeline_no_timestamps', schema: 'plain', seed: [plainSeed()], op: 'updateOne', filter: { _id: 'p1' }, update: [{ $set: { dueAt: 5 } }] },
    { name: 'update_operators', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $unset: { score: 1, blob: '' }, $addToSet: { tags: 'z' }, $max: { count: 99 }, $min: { 'nested.b': 1 }, $rename: { 'nested.deep': 'nested.deeper' } } },
    { name: 'update_pull_and_mul', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $pull: { tags: 'a', items: { n: { $gte: 3 } } }, $mul: { score: 2 }, $pop: { plain: 1 } } },
    { name: 'update_push_primitive', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { tags: 'p' } } },
    { name: 'update_push_primitive_array_value', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { tags: ['p', 'q'] } } },
    { name: 'update_push_each_slice', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { tags: { $each: ['p', 'q'], $slice: -2 } } } },
    { name: 'update_push_subdoc_with_id', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { items: { label: '  new ' } } } },
    { name: 'update_push_subdocs_each', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { items: { $each: [{ n: 5 }, { label: 'b', _id: oid4 }], $slice: -10 } } } },
    { name: 'update_push_subdoc_without_id', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $push: { plain: { label: 'q' } } } },
    { name: 'update_add_to_set_subdoc', schema: 'snake', seed: [snakeSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $addToSet: { accounts: { id: '7' } } } },
    { name: 'update_set_subdoc_array', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { items: [{ label: ' a ' }, { n: 2, _id: oid4 }] } } },
    { name: 'update_set_array_element_path', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { 'plain.0.label': '  e0 ', 'items.$[el].label': ' f ' } }, options: { arrayFilters: [{ 'el.n': 3 }] } },
    { name: 'update_set_positional', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1, 'items._id': sub2 }, update: { $set: { 'items.$.label': ' pos ' } } },
    { name: 'update_set_single_nested', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { opts: { mode: 'anywhere' } } } },
    { name: 'update_set_single_nested_path', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { 'opts.mode': 'exact' } } },
    { name: 'update_set_nested_object', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { nested: { b: 1 } } } },
    { name: 'update_set_empty_objects', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { meta: {}, blob: {} } } },
    { name: 'update_set_map_key', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { 'vars.two': '2', vars2: 'unknown' } } },
    { name: 'update_set_map_whole', schema: 'snake', seed: [snakeSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { variables: { k: 'v', [TEXT]: TEXT } } } },
    { name: 'update_set_immutable', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { key: 'changed', score: 0 } } },
    { name: 'update_set_immutable_no_timestamps', schema: 'plain', seed: [plainSeed()], op: 'updateOne', filter: { _id: 'p1' }, update: { $set: { channelID: 'other', dueAt: 9 } } },
    { name: 'update_unknown_paths_dropped', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { nope: 1, 'nested.nope': 2 }, $inc: { nope2: 1 } } },
    { name: 'update_no_timestamps', schema: 'plain', seed: [plainSeed()], op: 'updateOne', filter: { _id: 'p1' }, update: { $set: { label: ` ${TEXT} `, 'state.seq': 5 } } },
    { name: 'update_no_timestamps_empty', schema: 'plain', seed: [plainSeed()], op: 'updateOne', filter: { _id: 'p1' }, update: { $set: {} } },
    { name: 'update_timestamps_empty', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1 }, update: {} },
    { name: 'update_hand_written_timestamps', schema: 'hand', seed: [handSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { name: 'x' } } },
    { name: 'update_snake', schema: 'snake', seed: [snakeSeed()], op: 'updateOne', filter: { _id: oid1 }, update: { $set: { status: 'ended', ended_at: T2 }, $inc: { total: 1 } } },
    { name: 'update_nomin_empty', schema: 'nomin', seed: [nominSeed()], op: 'updateOne', filter: { _id: 'n1' }, update: { $set: { config: {}, 'meta.b': {} } } },
    { name: 'update_many', schema: 'camel', seed: [camelSeed(), camelSparseSeed()], op: 'updateMany', filter: {}, update: { $set: { flag: false } } },
    { name: 'update_by_string_id', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { _id: oid1.toHexString() }, update: { $set: { score: 2 } } },
    { name: 'update_in_string_ids', schema: 'camel', seed: [camelSeed(), camelSparseSeed()], op: 'updateMany', filter: { _id: { $in: [oid1.toHexString(), oid2.toHexString()] } }, update: { $inc: { count: 1 } } },

    // ---- upserts
    { name: 'upsert_insert_camel', schema: 'camel', op: 'updateOne', filter: { name: 'up' }, update: { $set: { score: 1 } }, options: { upsert: true } },
    { name: 'upsert_match_camel', schema: 'camel', seed: [camelSeed()], op: 'updateOne', filter: { name: 'seed' }, update: { $set: { score: 1 } }, options: { upsert: true } },
    { name: 'upsert_filter_operators_and_nested', schema: 'camel', op: 'updateOne', filter: { count: { $gt: 1 }, 'nested.a': 'fa', items: { $size: 0 } }, update: { $set: { 'nested.b': 2, 'vars.k': 'v' } }, options: { upsert: true } },
    { name: 'upsert_caller_set_on_insert', schema: 'camel', op: 'updateOne', filter: { name: 'soi' }, update: { $setOnInsert: { createdAt: T1, __v: 7, count: 2, flag: true }, $set: { score: 1 } }, options: { upsert: true } },
    { name: 'upsert_caller_created_at_in_set', schema: 'camel', op: 'updateOne', filter: { name: 'cas' }, update: { $set: { createdAt: T1, updatedAt: T2 } }, options: { upsert: true } },
    { name: 'upsert_version_in_inc', schema: 'camel', op: 'updateOne', filter: { name: 'vinc' }, update: { $inc: { __v: 1, count: 1 } }, options: { upsert: true } },
    { name: 'upsert_immutable_in_set', schema: 'camel', op: 'updateOne', filter: { name: 'imm' }, update: { $set: { key: 'k', score: 3 } }, options: { upsert: true } },
    { name: 'upsert_immutable_bare', schema: 'plain', op: 'updateOne', filter: { _id: 'pi' }, update: { channelID: 'c', dueAt: 1 }, options: { upsert: true } },
    { name: 'upsert_push_and_nested_parent', schema: 'camel', op: 'updateOne', filter: { name: 'pp' }, update: { $push: { items: { label: 'x' } }, $set: { nested: { a: 'set' }, opts: { mode: 'm' } } }, options: { upsert: true } },
    { name: 'upsert_plain_string_id', schema: 'plain', op: 'updateOne', filter: { _id: 'p5' }, update: { $set: { 'state.seq': 2 }, $setOnInsert: { channelID: 'c5' } }, options: { upsert: true } },
    { name: 'upsert_plain_empty_update', schema: 'plain', op: 'updateOne', filter: { _id: 'p6', channelID: 'c6' }, update: {}, options: { upsert: true } },
    { name: 'upsert_plain_no_defaults', schema: 'plain', op: 'updateOne', filter: { _id: 'p7' }, update: { $set: { label: 'x' } }, options: { upsert: true, setDefaultsOnInsert: false } },
    { name: 'upsert_snake', schema: 'snake', op: 'updateOne', filter: { channelID: 'cs', status: 'active' }, update: { $set: { total: 1 }, $push: { history: { v: 2, at: T1 } } }, options: { upsert: true } },
    { name: 'upsert_nomin', schema: 'nomin', op: 'updateOne', filter: { _id: 'nu' }, update: { $set: { 'meta.a': 'v' } }, options: { upsert: true } },
    { name: 'upsert_hand', schema: 'hand', op: 'updateOne', filter: { name: 'hu' }, update: { $set: { enabled: false } }, options: { upsert: true } },
    { name: 'upsert_many_camel', schema: 'camel', op: 'updateMany', filter: { name: 'many' }, update: { $set: { score: 1 } }, options: { upsert: true } },
    { name: 'upsert_text_filter', schema: 'camel', op: 'updateOne', filter: { name: TEXT }, update: { $set: { [`vars.${'clé'}`]: TEXT } }, options: { upsert: true } },

    // ---- findOneAndUpdate / findByIdAndUpdate
    { name: 'find_one_and_update_default_before', schema: 'camel', seed: [camelSeed()], op: 'findOneAndUpdate', filter: { _id: oid1 }, update: { $inc: { count: 1 } } },
    { name: 'find_one_and_update_new', schema: 'camel', seed: [camelSeed()], op: 'findOneAndUpdate', filter: { _id: oid1 }, update: { $inc: { count: 1 } }, options: { new: true } },
    { name: 'find_one_and_update_return_after', schema: 'snake', seed: [snakeSeed()], op: 'findOneAndUpdate', filter: { channelID: 'c1' }, update: { $set: { status: 'x' } }, options: { returnDocument: 'after' } },
    { name: 'find_one_and_update_upsert_new', schema: 'camel', op: 'findOneAndUpdate', filter: { name: 'fu' }, update: { $set: { score: 1 } }, options: { upsert: true, new: true } },
    { name: 'find_one_and_update_upsert_before', schema: 'plain', op: 'findOneAndUpdate', filter: { _id: 'pf' }, update: { $set: { dueAt: 2 } }, options: { upsert: true } },
    { name: 'find_one_and_update_empty_no_timestamps', schema: 'plain', seed: [plainSeed()], op: 'findOneAndUpdate', filter: { _id: 'p1' }, update: {} },
    { name: 'find_by_id_and_update_string', schema: 'camel', seed: [camelSeed()], op: 'findByIdAndUpdate', id: oid1.toHexString(), update: { $set: { score: 9 } }, options: { new: true } },

    // ---- bulkWrite
    { name: 'bulk_write_mixed', schema: 'camel', seed: [camelSeed()], op: 'bulkWrite', ops: [
        { updateOne: { filter: { name: 'bulk-up' }, update: { $set: { score: 1 }, $setOnInsert: { flag: true } }, upsert: true } },
        { updateOne: { filter: { _id: oid1 }, update: { $inc: { count: 2 } } } },
        { updateMany: { filter: { name: 'bulk-many' }, update: { $set: { score: 2 } }, upsert: true } },
        { insertOne: { document: { name: 'bulk-ins', items: [{ label: 'i' }] } } },
    ] },
    { name: 'bulk_write_plain', schema: 'plain', op: 'bulkWrite', ops: [
        { updateOne: { filter: { _id: 'pb1' }, update: { $set: { dueAt: 1 } }, upsert: true } },
        { updateMany: { filter: { _id: 'pb2' }, update: { $set: { dueAt: 2 } }, upsert: true } },
    ] },

    // ---- save of a loaded document
    { name: 'save_no_change', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [] },
    { name: 'save_scalar', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'score', value: 7 }, { set: 'name', value: '  renamed ' }] },
    { name: 'save_same_value', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'score', value: 1.5 }] },
    { name: 'save_unset', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ unset: 'score' }, { set: 'blob', value: null }] },
    { name: 'save_push', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ push: 'tags', values: ['n1', 'n2'] }] },
    { name: 'save_push_subdoc', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ push: 'items', values: [{ label: ' s ' }] }, { set: 'score', value: 0 }] },
    { name: 'save_replace_array', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'tags', value: ['r'] }] },
    { name: 'save_array_element', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'items.1.label', value: 'changed' }] },
    { name: 'save_nested_and_mixed', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'nested.b', value: 1 }, { set: 'meta', value: { x: { y: 1 } } }] },
    { name: 'save_empty_object_minimize', schema: 'camel', seed: [camelSeed()], op: 'save', id: oid1, changes: [{ set: 'meta', value: {} }] },
    { name: 'save_empty_object_no_minimize', schema: 'nomin', seed: [nominSeed()], op: 'save', id: 'n1', changes: [{ set: 'config', value: {} }] },
    { name: 'save_sparse_defaults', schema: 'camel', seed: [camelSparseSeed()], op: 'save', id: oid2, changes: [{ set: 'score', value: 1 }] },
    { name: 'save_sparse_defaults_no_change', schema: 'camel', seed: [camelSparseSeed()], op: 'save', id: oid2, changes: [] },
    { name: 'save_no_version_key', schema: 'plain', seed: [plainSeed()], op: 'save', id: 'p1', changes: [{ push: 'state.ids', values: ['b'] }, { set: 'dueAt', value: 3 }] },
    { name: 'save_snake_push_account', schema: 'snake', seed: [snakeSeed()], op: 'save', id: oid1, changes: [{ push: 'accounts', values: [{ id: '9', type: 'kick' }] }] },
];

// ---------------------------------------------------------------- capture and normalisation

const WRITE_COMMANDS = new Set(['insert', 'update', 'findAndModify', 'delete']);
const ENVELOPE = new Set(['lsid', '$db', '$clusterTime', 'txnNumber', '$readPreference', 'writeConcern', 'startTransaction', 'autocommit', 'apiVersion', 'readConcern']);
let capturing = null;

const exact = (value) => BSON.deserialize(BSON.serialize({ v: value }), { promoteValues: false, promoteLongs: false, promoteBuffers: false }).v;

function strip(command) {
    const out = {};
    for (const [key, value] of Object.entries(command)) if (!ENVELOPE.has(key)) out[key] = value;
    return out;
}

const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function collectIds(value, out) {
    if (value instanceof ObjectId) out.add(value.toHexString());
    else if (Array.isArray(value)) value.forEach((v) => collectIds(v, out));
    else if (isPlain(value)) Object.values(value).forEach((v) => collectIds(v, out));
    return out;
}

function normaliser(inputIds, t0, t1) {
    const generated = new Map();
    const walk = (value) => {
        if (value instanceof Date) {
            const ms = value.getTime();
            return ms >= t0 && ms <= t1 ? new Date(NOW_MS) : value;
        }
        if (value instanceof ObjectId) {
            const hex = value.toHexString();
            if (inputIds.has(hex)) return value;
            if (!generated.has(hex)) generated.set(hex, GENERATED_PREFIX + String(generated.size + 1).padStart(8, '0'));
            return new ObjectId(generated.get(hex));
        }
        if (Array.isArray(value)) return value.map(walk);
        if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
        return value;
    };
    return walk;
}

const ejson = (value) => JSON.parse(EJSON.stringify(value, { relaxed: false }));
// Deep clone through Extended JSON: Dates and ObjectIds survive, numbers become plain numbers.
const clone = (value) => EJSON.parse(EJSON.stringify(value, { relaxed: false }), { relaxed: true });

async function storedDocs(collection) {
    return collection.find({}, { sort: { _id: 1 }, promoteValues: false, promoteLongs: false, promoteBuffers: false }).toArray();
}

async function runCase(spec) {
    const Model = models[spec.schema];
    const collection = mongoose.connection.db.collection(collections[spec.schema]);
    await collection.deleteMany({});
    if (spec.seed?.length) await collection.insertMany(clone(spec.seed));

    const intent = Object.fromEntries(Object.entries(spec).filter(([k]) => !['name', 'schema', 'seed'].includes(k)));
    const commands = [];
    let result = null;
    const t0 = Date.now() - 1;
    capturing = commands;
    try {
        const a = clone(intent);
        switch (spec.op) {
            case 'create': await Model.create(a.doc); break;
            case 'newSave': await new Model(a.doc).save(); break;
            case 'insertMany': await Model.insertMany(a.docs); break;
            case 'updateOne': await Model.updateOne(a.filter, a.update, a.options ?? {}); break;
            case 'updateMany': await Model.updateMany(a.filter, a.update, a.options ?? {}); break;
            case 'findOneAndUpdate': result = await Model.findOneAndUpdate(a.filter, a.update, a.options ?? {}).lean(); break;
            case 'findByIdAndUpdate': result = await Model.findByIdAndUpdate(a.id, a.update, a.options ?? {}).lean(); break;
            case 'bulkWrite': await Model.bulkWrite(a.ops); break;
            case 'save': {
                capturing = null;
                const doc = await Model.findById(a.id);
                capturing = commands;
                for (const change of a.changes) {
                    if ('set' in change) doc.set(change.set, change.value);
                    else if ('unset' in change) doc.set(change.unset, undefined);
                    else if ('push' in change) doc.get(change.push).push(...change.values);
                    else throw new Error(`unknown change ${JSON.stringify(change)}`);
                }
                await doc.save();
                break;
            }
            default: throw new Error(`unknown op ${spec.op}`);
        }
    } finally {
        capturing = null;
    }
    const t1 = Date.now() + 1;
    if (result != null) result = exact(result);
    const stored = await storedDocs(collection);
    const inputIds = collectIds(spec.seed ?? [], collectIds(intent, new Set()));
    const walk = normaliser(inputIds, t0, t1);
    const normalised = { commands: commands.map(walk), result: result == null ? null : walk(result), stored: stored.map(walk) };
    return {
        name: spec.name,
        schema: spec.schema,
        collection: collections[spec.schema],
        seed: ejson(spec.seed ?? []),
        intent: ejson(intent),
        commands: ejson(normalised.commands),
        result: normalised.result == null ? null : ejson(normalised.result),
        stored: ejson(normalised.stored),
    };
}

// ---------------------------------------------------------------- ObjectId casting (rule 3)

const castInputs = [
    '0123456789abcdef01234567', '0123456789ABCDEF01234567', '0123456789abcdef0123456', '0123456789abcdef012345678',
    'zzzzzzzzzzzzzzzzzzzzzzzz', '', ' 0123456789abcdef01234567', '0123456789abcdef01234567 ', 'abcdefghijkl',
    'aaaaaaaaaaaa', '👋👋👋👋👋👋', 'ééééééééééé', 'null', 'undefined', '000000000000000000000000', '[object Object]',
];

async function recordCasts() {
    const Model = models.camel;
    const rows = [];
    for (const input of castInputs) {
        const row = { input };
        try {
            const q = Model.findOne({ _id: input });
            q.cast(Model);
            const cast = q.getFilter()._id;
            row.cast = cast instanceof ObjectId ? cast.toHexString() : { unexpected: String(cast) };
        } catch (error) {
            row.cast = { error: error.name };
        }
        row.typesObjectIdIsValid = mongoose.Types.ObjectId.isValid(input);
        row.isValidObjectId = mongoose.isValidObjectId(input);
        row.isObjectIdOrHexString = mongoose.isObjectIdOrHexString(input);
        try {
            row.newObjectId = new mongoose.Types.ObjectId(input).toHexString();
        } catch (error) {
            row.newObjectId = { error: error.name };
        }
        rows.push(row);
    }
    return rows;
}

// ---------------------------------------------------------------- numbers (rules 20 to 23)

async function recordNumbers() {
    const collection = mongoose.connection.db.collection('golden_numbers');
    const values = [0, -0, 1, -1, 2147483647, 2147483648, -2147483648, -2147483649, 0.5, -1.25, 1e21, 2 ** 53, 2 ** 53 + 2,
        Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity];
    await collection.insertOne({ _id: 'js', values });
    const written = (await collection.findOne({ _id: 'js' }, { promoteValues: false })).values;

    // What Node reads back from int64 values, and what Mongoose makes of them in a Number path.
    const longs = ['0', '-1', '2147483648', '9007199254740991', '9007199254740992', '9007199254740993', '-9007199254740993', '9223372036854775807'];
    await collection.insertOne({ _id: 'longs', values: longs.map((s) => Long.fromString(s)) });
    const raw = (await collection.findOne({ _id: 'longs' })).values;
    const NumberHolder = mongoose.model('GoldenNumberHolder', new Schema({ _id: String, n: Number }, { versionKey: false }), 'golden_number_holders');
    const reads = [];
    for (const [i, s] of longs.entries()) {
        await NumberHolder.collection.insertOne({ _id: `l${i}`, n: Long.fromString(s) });
        const lean = (await NumberHolder.findById(`l${i}`).lean()).n;
        let hydrated;
        try {
            hydrated = (await NumberHolder.findById(`l${i}`)).n;
        } catch (error) {
            hydrated = { error: error.name };
        }
        reads.push({
            stored: s,
            driver: { type: raw[i] instanceof Long ? 'Long' : typeof raw[i], json: JSON.stringify(raw[i]) },
            lean: { type: lean instanceof Long ? 'Long' : typeof lean, json: JSON.stringify(lean) },
            hydrated: { type: hydrated instanceof Long ? 'Long' : typeof hydrated, json: JSON.stringify(hydrated) },
        });
    }
    // Mongoose writes of a Number path: casts strings and rewrites the value through the JS writer.
    await NumberHolder.create({ _id: 'w1', n: 5 });
    await NumberHolder.create({ _id: 'w2', n: 2 ** 31 });
    await NumberHolder.create({ _id: 'w3', n: '7' });
    const mongooseWrites = ejson(await NumberHolder.collection.find({ _id: { $in: ['w1', 'w2', 'w3'] } }, { sort: { _id: 1 }, promoteValues: false }).toArray());
    return {
        jsNumbers: values.map((v, i) => ({ input: Object.is(v, -0) ? '-0' : String(v), stored: ejson(written[i]) })),
        int64Reads: reads,
        mongooseWrites,
    };
}

// ---------------------------------------------------------------- JSON for HTTP (rules 24, 25)

async function recordJson() {
    const collection = mongoose.connection.db.collection('golden_json');
    const doc = {
        _id: new ObjectId('0123456789abcdef01234567'),
        string: TEXT,
        emptyString: '',
        int32: new Int32(42),
        negInt32: new Int32(-7),
        double: new Double(1.5),
        integralDouble: new Double(3),
        negZero: new Double(-0),
        bigDouble: new Double(1e21),
        smallDouble: new Double(1e-7),
        nan: new Double(NaN),
        inf: new Double(Infinity),
        negInf: new Double(-Infinity),
        int64Small: Long.fromNumber(5),
        int64Safe: Long.fromString('9007199254740992'),
        int64Big: Long.fromString('9007199254740993'),
        int64Max: Long.fromString('9223372036854775807'),
        int64Min: Long.fromString('-9223372036854775808'),
        bool: true,
        falseBool: false,
        nullValue: null,
        date: new Date('2026-11-11T10:00:00.123Z'),
        oldDate: new Date('1969-12-31T23:59:59.999Z'),
        farDate: new Date(8.64e15),
        decimal: Decimal128.fromString('1234.5600'),
        decimalNeg: Decimal128.fromString('-0.000001'),
        decimalNaN: Decimal128.fromString('NaN'),
        binary: new Binary(Buffer.from([0, 1, 2, 250, 255]), 0),
        binaryEmpty: new Binary(Buffer.alloc(0), 0),
        binaryUser: new Binary(Buffer.from('hi'), 128),
        uuid: new UUID('0123456789abcdef0123456789abcdef'),
        regex: /a.b\/c/gimsu,
        bsonRegex: new BSONRegExp('^x\\d$', 'ilmsux'),
        timestamp: new Timestamp({ t: 1700000000, i: 7 }),
        minKey: new MinKey(),
        maxKey: new MaxKey(),
        code: new Code('function () { return 1; }'),
        codeWithScope: new Code('x', { x: 1 }),
        symbol: new BSONSymbol('sym'),
        undefinedValue: undefined,
        nested: { [TEXT]: [1, 'two', { three: new Int32(3) }], 'a.b': 1, $dollar: 2, 'quote"key': '\\"\n\t\u0001\u2028' },
        emptyObject: {},
        emptyArray: [],
        arrayOfMixed: [null, new Int32(1), new Double(2.5), 'x', [new Long(1, 0)], { k: new Date(0) }],
    };
    await collection.insertOne(doc, { ignoreUndefined: false, serializeFunctions: false });
    // Express `res.json(body)` is `JSON.stringify(body)` with its default settings (no replacer,
    // no spacing, no escaping); a `.lean()` read hands it the driver's default deserialisation.
    const leanRead = await collection.findOne({ _id: doc._id });
    const LeanModel = mongoose.model('GoldenJson', new Schema({}, { strict: false }), 'golden_json');
    const viaMongoose = await LeanModel.findById(doc._id).lean();
    const stored = await collection.findOne({ _id: doc._id }, { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true });
    // A stored pattern JavaScript cannot compile makes the whole Node read throw.
    await collection.insertOne({ _id: 'bad-regex', r: new BSONRegExp('^x[', 'i') });
    let invalidRegexRead;
    try {
        await collection.findOne({ _id: 'bad-regex' });
        invalidRegexRead = { ok: true };
    } catch (error) {
        invalidRegexRead = { error: error.name };
    }
    return {
        invalidRegexRead,
        document: ejson(stored),
        driverJson: JSON.stringify(leanRead),
        mongooseLeanJson: JSON.stringify(viaMongoose),
        // `undefined` in a raw insert is dropped by the Node serialiser unless ignoreUndefined is
        // false; record which keys made it to the server.
        storedKeys: Object.keys(stored),
    };
}

// ---------------------------------------------------------------- duplicate key and transactions

async function recordErrors() {
    const collection = mongoose.connection.db.collection('golden_errors');
    await collection.createIndex({ eventKey: 1 }, { unique: true, name: 'eventKey_1' });
    await collection.insertOne({ _id: 'a', eventKey: 'k' });
    let duplicate;
    try {
        await collection.insertOne({ _id: 'b', eventKey: 'k' });
    } catch (error) {
        duplicate = { name: error.name, code: error.code, keyPattern: error.keyPattern, keyValue: error.keyValue, message: error.message.replace(dbName, '<db>') };
    }
    let transaction;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await collection.insertOne({ _id: 'c', eventKey: 'other' }, { session });
        });
        transaction = { ok: true };
    } catch (error) {
        transaction = { name: error.name, code: error.code, message: error.message };
    } finally {
        await session.endSession();
    }
    return { duplicate, transaction };
}

// ---------------------------------------------------------------- main

await mongoose.connect(uri, { monitorCommands: true, dbName, autoIndex: false });
const client = mongoose.connection.getClient();
client.on('commandStarted', (event) => {
    if (capturing && WRITE_COMMANDS.has(event.commandName)) capturing.push(strip(exact(event.command)));
});
for (const [name, schema] of Object.entries(schemas)) models[name] = mongoose.model(`Golden_${name}`, schema, collections[name]);

const output = { meta: {}, cases: [] };
try {
    const server = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    output.meta = {
        node: process.version,
        mongoose: mongoose.version,
        mongodbDriver: mongodbForMongoose.MongoClient ? require(join(dirname(mongooseRequire.resolve('mongodb')), '..', 'package.json')).version : null,
        bson: require(join(dirname(mongooseRequire.resolve('bson')), '..', 'package.json')).version,
        server: server.version,
        nowMs: NOW_MS,
        generatedPrefix: GENERATED_PREFIX,
    };
    for (const spec of cases) output.cases.push(await runCase(spec));
    output.objectIdCasts = await recordCasts();
    output.numbers = await recordNumbers();
    output.json = await recordJson();
    output.errors = await recordErrors();
} finally {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
}

const lines = Object.entries(output).map(([key, value]) => {
    const body = Array.isArray(value) ? `[\n${value.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]` : JSON.stringify(value);
    return ` ${JSON.stringify(key)}: ${body}`;
});
writeFileSync(join(here, 'golden.json'), `{\n${lines.join(',\n')}\n}\n`);
console.log(`recorded ${output.cases.length} cases, ${output.cases.reduce((n, c) => n + c.commands.length, 0)} commands`);
