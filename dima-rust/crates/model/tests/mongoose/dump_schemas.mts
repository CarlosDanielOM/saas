// Dumps what Mongoose itself reports for every model in the `dima-model` registry, so that
// `tests/schema_drift.rs` can compare each hand-written `Schema` with it. No database is opened.
//
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//     /path/to/dima-rust/crates/model/tests/mongoose/dump_schemas.mts \
//     /path/to/dima-rust/crates/model/tests/mongoose/schemas.json
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` (production Mongoose 8.24.3); its `src/`
// must be the frozen reference. TZ=UTC because production runs without a time zone (UTC) and some
// defaults read the calendar day.
//
// Computed defaults are evaluated at FIXED_MS: `Date` is replaced before the schema files are
// imported, so `Date.now` and `new Date()` inside a default return that instant. The Rust test
// builds its defaults at the same instant.
//
// Output per model: the schema tree in the shape of `dima_store::mongo::schema::Schema` (fields in
// declaration order, kinds, defaults, trim, immutable, sub-schema options), the `select: false`
// paths, every validator (required, enum, min, max, maxlength, user defined), and the declared
// indexes as `schema.indexes()` returns them.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// One entry per collection module of the registry: the schema file and the model name.
const MODELS: Array<[string, string]> = [
    ['src/schemas/users.schema.ts', 'users'],
];

export const FIXED_MS = Date.UTC(2026, 10, 11, 10, 20, 30, 456);
const RealDate = Date;
class FixedDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(FIXED_MS);
        else super(...(args as [any]));
    }
    static now() {
        return FIXED_MS;
    }
}
// Mongoose resolves `type: Date` by the constructor's name.
Object.defineProperty(FixedDate, 'name', { value: 'Date' });
(globalThis as any).Date = FixedDate;

const out = process.argv[2];
if (!out) throw new Error('usage: dump_schemas.mts <out.json>');
if (process.env.TZ !== 'UTC') throw new Error('run with TZ=UTC (production has no time zone)');
const root = process.cwd();
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
if (mongoose.version !== '8.24.3') throw new Error(`expected mongoose 8.24.3, found ${mongoose.version}`);
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);
const { EJSON } = await import(pathToFileURL(path.join(root, 'node_modules/bson/lib/bson.cjs')).href);

for (const [file] of MODELS) await import(pathToFileURL(path.join(root, file)).href);

const ejson = (value: any) => JSON.parse(EJSON.stringify(value, { relaxed: false }));

function valueType(instance: string): string | null {
    return ['String', 'Number', 'Date', 'Boolean', 'ObjectId'].includes(instance) ? instance : null;
}

// The default as declared: `function` is the user's declaration (`typeof options.default`), not
// Mongoose's internal wrapping; `value` is what Mongoose produces for a new document at FIXED_MS.
function describeDefault(schemaType: any): any {
    const options = schemaType.options ?? {};
    if (schemaType.defaultValue === undefined) return undefined;
    let value;
    try {
        value = schemaType.getDefault(undefined, true);
    } catch (error) {
        value = { error: String(error) };
    }
    if (value === undefined) return undefined;
    if (value && typeof value === 'object' && typeof value.toObject === 'function') value = value.toObject();
    if (value instanceof Map) value = Object.fromEntries(value);
    if (Array.isArray(value)) value = [...value];
    const declared = 'default' in options && options.default !== undefined;
    return {
        function: declared ? typeof options.default === 'function' : false,
        implicit: !declared,
        value: ejson({ v: value === null ? null : value }).v,
    };
}

function describeField(name: string, schemaType: any, schema: any, prefix: string): any {
    const options = schemaType.options ?? {};
    const field: any = { name };
    const instance = schemaType.instance;
    if (schemaType.$isSingleNested) {
        field.kind = 'subdocument';
        field.schema = describeSchema(schemaType.schema, false);
    } else if (schemaType.$isMongooseDocumentArray) {
        field.kind = 'documentArray';
        field.schema = describeSchema(schemaType.schema, false);
    } else if (instance === 'Array') {
        const caster = schemaType.caster;
        const type = caster ? valueType(caster.instance) : null;
        if (type) {
            field.kind = 'array';
            field.type = type;
        } else {
            field.kind = 'mixedArray';
        }
    } else if (instance === 'Map') {
        field.kind = 'map';
        const sub = schemaType.$__schemaType;
        if (sub?.schema) field.of = { kind: 'subdocuments', schema: describeSchema(sub.schema, false) };
        else if (sub && valueType(sub.instance)) field.of = { kind: 'values', type: sub.instance };
        else field.of = { kind: 'mixed' };
    } else if (instance === 'Mixed') {
        field.kind = 'mixed';
    } else if (valueType(instance)) {
        field.kind = 'value';
        field.type = instance;
    } else {
        field.kind = `unsupported:${instance}`;
    }
    const def = describeDefault(schemaType);
    if (def) field.default = def;
    if (options.trim) field.trim = true;
    if (options.immutable) field.immutable = true;
    return field;
}

/// The schema as a tree of fields in declaration order (nested plain objects rebuilt from the
/// flat paths), without the paths Mongoose adds itself (auto `_id`, timestamps, version key).
function describeSchema(schema: any, topLevel: boolean): any {
    const options = schema.options;
    const timestamps = options.timestamps;
    const implicit = new Set<string>();
    let id = 'none';
    const idPath = schema.paths._id;
    if (idPath) {
        id = idPath.options?.auto === true ? 'auto' : 'declared';
        if (id === 'auto') implicit.add('_id');
    }
    let tsNames: any = null;
    if (timestamps) {
        tsNames = {
            createdAt: timestamps === true ? 'createdAt' : (timestamps.createdAt ?? 'createdAt'),
            updatedAt: timestamps === true ? 'updatedAt' : (timestamps.updatedAt ?? 'updatedAt'),
        };
        implicit.add(tsNames.createdAt);
        implicit.add(tsNames.updatedAt);
    }
    if (options.versionKey) implicit.add(options.versionKey);

    const fields: any[] = [];
    const nestedNodes = new Map<string, any[]>();
    const childrenOf = (parent: string) => (parent === '' ? fields : nestedNodes.get(parent)!);
    schema.eachPath((fullPath: string, schemaType: any) => {
        if (fullPath.includes('.$*')) return;
        if (implicit.has(fullPath)) return;
        const parts = fullPath.split('.');
        let parent = '';
        for (let i = 0; i < parts.length - 1; i++) {
            const nestedPath = parts.slice(0, i + 1).join('.');
            if (!nestedNodes.has(nestedPath)) {
                const node = { name: parts[i], kind: 'nested', fields: [] as any[] };
                childrenOf(parent).push(node);
                nestedNodes.set(nestedPath, node.fields);
            }
            parent = nestedPath;
        }
        childrenOf(parent).push(describeField(parts[parts.length - 1], schemaType, schema, parent));
    });
    const description: any = {
        id,
        timestamps: tsNames,
        versionKey: topLevel ? (options.versionKey === false ? null : options.versionKey) : null,
        minimize: options.minimize !== false,
        fields,
    };
    return description;
}

function hiddenPaths(schema: any): string[] {
    const hidden: string[] = [];
    schema.eachPath((fullPath: string, schemaType: any) => {
        if (schemaType.options?.select === false) hidden.push(fullPath);
    });
    return hidden;
}

/// Every validator, walking into single nested and document array sub-schemas
/// (`config.$.label.EN` style paths for array elements).
function validators(schema: any, prefix: string, out: any[]) {
    schema.eachPath((fullPath: string, schemaType: any) => {
        if (fullPath.includes('.$*')) return;
        const at = prefix + fullPath;
        for (const v of schemaType.validators ?? []) {
            const row: any = { path: at, type: v.type };
            if (v.type === 'required') row.conditional = typeof schemaType.originalRequiredValue === 'function';
            if (v.type === 'enum') row.values = v.enumValues;
            if (v.type === 'min') row.min = v.min;
            if (v.type === 'max') row.max = v.max;
            if (v.type === 'maxlength') row.maxlength = v.maxlength;
            if (v.type === 'minlength') row.minlength = v.minlength;
            if (v.type === 'user defined') row.message = typeof v.message === 'string' ? v.message : String(v.message);
            out.push(row);
        }
        if (schemaType.$isSingleNested) validators(schemaType.schema, `${at}.`, out);
        if (schemaType.$isMongooseDocumentArray) validators(schemaType.schema, `${at}.$.`, out);
    });
    return out;
}

const models: any = {};
for (const [file, name] of MODELS) {
    const model = mongoose.models[name];
    if (!model) throw new Error(`model ${name} not registered by ${file}`);
    models[model.collection.collectionName] = {
        model: name,
        file,
        schema: describeSchema(model.schema, true),
        hidden: hiddenPaths(model.schema),
        validators: validators(model.schema, '', []),
        indexes: model.schema.indexes().map(([key, options]: any) => ({ key: Object.entries(key), options })),
    };
}

writeFileSync(out, `${JSON.stringify({ mongoose: mongoose.version, fixedMs: FIXED_MS, models }, null, 1)}\n`);
console.log(`dumped ${Object.keys(models).length} models to ${out}`);
process.exit(0);
