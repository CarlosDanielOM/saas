// Dumps every Mongoose model registered by dimabot as JSON (no DB connection is opened).
// Run from dimabot/: npx tsx ../dima-rust/tools/ledger/mongo_schemas.ts <out.json> <file-list>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const [out, list] = process.argv.slice(2);
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const files = readFileSync(list, 'utf8').split('\n').filter(Boolean);
const fileOf: Record<string, string> = {};
const importErrors: Record<string, string> = {};
for (const f of files) {
  const before = new Set(Object.keys(mongoose.models));
  try { await import(pathToFileURL(path.join(root, f)).href); }
  catch (e: any) { importErrors[f] = String(e?.message ?? e).slice(0, 300); }
  for (const m of Object.keys(mongoose.models)) if (!before.has(m)) fileOf[m] = f;
}

const fnDesc = (v: any) => typeof v === 'function' ? `[function ${v.name || 'anonymous'}]` : v;
const OPT_KEYS = ['required','default','enum','min','max','minlength','maxlength','minLength','maxLength','match','validate','select','get','set','index','unique','sparse','expires','ref','lowercase','uppercase','trim','immutable','alias','of','_id','transform','text','auto'];
function optDesc(o: any) {
  const r: any = {};
  for (const k of OPT_KEYS) {
    if (!(k in o) || o[k] === undefined) continue;
    let v = o[k];
    if (k === 'default') {
      if (typeof v === 'function') r.default = { computed: true, fn: (v.name || 'anonymous'), src: v.toString().slice(0, 160) };
      else r.default = v instanceof Date ? { date: v.toISOString() } : JSON.parse(JSON.stringify(v ?? null));
      continue;
    }
    if (k === 'enum') { r.enum = Array.isArray(v) ? v : (v?.values ?? v); continue; }
    if (k === 'validate') { r.validate = Array.isArray(v) ? v.map((x: any) => typeof x === 'function' ? fnDesc(x) : { message: x?.message, validator: fnDesc(x?.validator) }) : (typeof v === 'function' ? fnDesc(v) : { message: v?.message, validator: fnDesc(v?.validator) }); continue; }
    if (k === 'of') { r.of = describeType(v); continue; }
    if (typeof v === 'function') { r[k] = fnDesc(v); continue; }
    if (v instanceof RegExp) { r[k] = String(v); continue; }
    if (Array.isArray(v) && typeof v[0] !== 'object') { r[k] = v; continue; }
    try { r[k] = JSON.parse(JSON.stringify(v)); } catch { r[k] = String(v); }
  }
  return r;
}
function describeType(t: any): any {
  if (t == null) return null;
  if (typeof t === 'function') return t.schemaName || t.name;
  if (t instanceof mongoose.Schema) return { subschema: describeSchema(t) };
  if (typeof t === 'object' && 'type' in t) return describeType(t.type);
  return typeof t;
}
function describePath(p: any): any {
  const d: any = { instance: p.instance, ...optDesc(p.options ?? {}) };
  if (p.validators?.length) {
    const custom = p.validators.filter((v: any) => !['required','enum','min','max','minlength','maxlength','regexp'].includes(v.type));
    if (custom.length) d.customValidators = custom.map((v: any) => ({ type: v.type, message: typeof v.message === 'string' ? v.message : undefined, fn: v.validator?.toString().slice(0, 200) }));
  }
  if (p.getters?.length) d.getters = p.getters.map((g: any) => g.toString().slice(0, 120));
  if (p.setters?.length) d.setters = p.setters.map((g: any) => g.toString().slice(0, 120));
  if (p.schema && (p.instance === 'Embedded' || p.$isSingleNested)) d.subdocument = describeSchema(p.schema);
  if (p.instance === 'Array' || p.$isMongooseArray || p.$isMongooseDocumentArray) {
    if (p.schema) { d.itemsSubdocument = describeSchema(p.schema); }
    else if (p.caster) d.items = { instance: p.caster.instance, ...optDesc(p.caster.options ?? {}), ...(p.caster.instance === 'Array' && p.caster.caster ? { items: { instance: p.caster.caster.instance } } : {}) };
  }
  if (p.instance === 'Map') {
    const sub = p.$__schemaType;
    d.mapOf = sub ? (sub.schema ? { subdocument: describeSchema(sub.schema) } : { instance: sub.instance, ...optDesc(sub.options ?? {}) }) : 'Mixed';
  }
  return d;
}
function describeSchema(s: any): any {
  const paths: any = {};
  s.eachPath((name: string, p: any) => { if (!name.includes('.$*')) paths[name] = describePath(p); });
  const o = s.options;
  return {
    options: {
      strict: o.strict, strictQuery: o.strictQuery, timestamps: o.timestamps ?? false, versionKey: o.versionKey, minimize: o.minimize, _id: o._id, id: o.id,
      collection: o.collection, collation: o.collation, autoIndex: o.autoIndex, autoCreate: o.autoCreate, typeKey: o.typeKey !== 'type' ? o.typeKey : undefined,
      toJSON: o.toJSON ? Object.fromEntries(Object.entries(o.toJSON).map(([k, v]) => [k, fnDesc(v)])) : undefined,
      toObject: o.toObject ? Object.fromEntries(Object.entries(o.toObject).map(([k, v]) => [k, fnDesc(v)])) : undefined,
      capped: o.capped, timeseries: o.timeseries, discriminatorKey: o.discriminatorKey !== '__t' ? o.discriminatorKey : undefined, optimisticConcurrency: o.optimisticConcurrency || undefined,
    },
    paths,
    nested: Object.keys(s.nested ?? {}),
    virtuals: Object.keys(s.virtuals ?? {}).filter(v => v !== 'id'),
    statics: Object.keys(s.statics ?? {}),
    methods: Object.keys(s.methods ?? {}),
    hooks: {
      pre: [...(s.s.hooks._pres?.entries?.() ?? [])].map(([k, arr]: any) => [k, arr.filter((h: any) => !h.fn?.$__isBuiltin && !h.fn?._mongooseInternal).map((h: any) => h.fn?.toString().slice(0, 100))]).filter(([, a]: any) => a.length),
      post: [...(s.s.hooks._posts?.entries?.() ?? [])].map(([k, arr]: any) => [k, arr.map((h: any) => h.fn?.toString().slice(0, 100))]).filter(([, a]: any) => a.length),
    },
    plugins: (s.plugins ?? []).map((p: any) => p.fn?.name || 'anonymous'),
  };
}

// Attribute each model to the file whose model(...) call names it (imports register models transitively).
const defFile: Record<string, string> = {};
for (const f of files) {
  const src = readFileSync(path.join(root, f), 'utf8');
  const re = /\bmodel\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g;
  let m; while ((m = re.exec(src))) defFile[m[1]] ??= `${f}:${src.slice(0, m.index).split('\n').length}`;
}
const models: any = {};
for (const [name, m] of Object.entries<any>(mongoose.models)) {
  models[name] = {
    file: defFile[name] ?? fileOf[name] ?? null,
    modelName: name,
    collection: m.collection.collectionName,
    discriminators: m.discriminators ? Object.keys(m.discriminators) : undefined,
    indexes: m.schema.indexes().map(([key, opts]: any) => ({ key, ...JSON.parse(JSON.stringify(opts ?? {})) })),
    schema: describeSchema(m.schema),
  };
}
writeFileSync(out, JSON.stringify({ mongooseVersion: mongoose.version, modelCount: Object.keys(models).length, importErrors, models }, null, 2));
console.log('models', Object.keys(models).length, 'importErrors', Object.keys(importErrors).length);
process.exit(0);
