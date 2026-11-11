/**
 * Test helper: answers a real Mongoose model's queries from memory (no database). Supports the
 * filters the write tools use: equality (dotted paths, `null` = missing), `$ne`, `$lt`, `$in`, `$exists`, RegExp, `$or`,
 * sort/skip/limit/select/lean chains, updates with `$set`/`$inc`/`$unset`/`$setOnInsert` (dotted
 * paths), `upsert`, unique keys and `doc.$where` on save. Write filters are evaluated, so a
 * compare-and-set that misses really writes nothing. Import it only from tests.
 */
import { mock } from 'node:test';
import mongoose from 'mongoose';

export type Raw = Record<string, any>;

const isObjectId = (value: unknown) => Boolean(value && typeof (value as { toHexString?: unknown }).toHexString === 'function');

/** Deep copy that keeps ObjectIds (structuredClone drops their prototype). */
export function clone(raw: Raw): Raw {
    const out: Raw = {};
    for (const [key, value] of Object.entries(raw)) {
        out[key] = isObjectId(value) ? value : value instanceof Date ? new Date(value) : value && typeof value === 'object' ? structuredClone(value) : value;
    }
    return out;
}

function comparable(value: unknown): unknown {
    if (isObjectId(value)) return String(value);
    if (value instanceof Date) return value.getTime();
    return value;
}

export function fieldMatches(value: unknown, condition: unknown): boolean {
    if (condition instanceof RegExp) return typeof value === 'string' && condition.test(value);
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !isObjectId(condition) && !(condition instanceof Date)) {
        const ops = condition as Raw;
        if ('$ne' in ops) return comparable(value) !== comparable(ops.$ne) && !(value === undefined && ops.$ne === undefined);
        if ('$lt' in ops) return (comparable(value) as number | string) < (comparable(ops.$lt) as number | string);
        if ('$lte' in ops) return value !== null && value !== undefined && (comparable(value) as number) <= (comparable(ops.$lte) as number);
        if ('$in' in ops) return (ops.$in as unknown[]).some((item) => item === null ? value === null || value === undefined : comparable(item) === comparable(value));
        if ('$exists' in ops) return (value !== undefined) === Boolean(ops.$exists);
        return JSON.stringify(value) === JSON.stringify(condition);
    }
    if (condition === null) return value === null || value === undefined;
    return comparable(value) === comparable(condition);
}

function get(raw: Raw, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Raw)[key] : undefined), raw);
}

export function matches(raw: Raw, filter: Raw, defaults: Raw = {}): boolean {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === '$or') return (condition as Raw[]).some((part) => matches(raw, part, defaults));
        const value = get(raw, key);
        // `null` matches a missing field like MongoDB does, even when the model has a default for it.
        return fieldMatches(value === undefined && key in defaults && condition !== null ? defaults[key] : value, condition);
    });
}

function setPathValue(raw: Raw, path: string, value: unknown): void {
    const keys = path.split('.');
    let node = raw;
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[keys[keys.length - 1]] = value === undefined ? undefined : clone({ value }).value;
}

/** Applies a MongoDB-style update in place: plain fields and `$set` (dotted paths), `$inc`, `$unset`, and `$setOnInsert` on inserts. */
export function applyUpdate(raw: Raw, update: Raw, inserting = false): void {
    for (const [key, value] of Object.entries(update)) if (!key.startsWith('$')) setPathValue(raw, key, value);
    for (const [key, value] of Object.entries(update.$set ?? {})) setPathValue(raw, key, value);
    for (const [key, value] of Object.entries(update.$inc ?? {})) setPathValue(raw, key, (Number(get(raw, key)) || 0) + Number(value));
    for (const key of Object.keys(update.$unset ?? {})) setPathValue(raw, key, undefined);
    if (inserting) for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) setPathValue(raw, key, value);
}

/** Equality fields of a filter (what an upsert copies into the new document). */
function filterSeed(filter: Raw): Raw {
    const seed: Raw = {};
    for (const [key, value] of Object.entries(filter)) {
        const operator = value && typeof value === 'object' && !isObjectId(value) && !(value instanceof Date) && !Array.isArray(value);
        if (!key.startsWith('$') && !operator && !(value instanceof RegExp) && value !== null) setPathValue(seed, key, value);
    }
    return seed;
}

export interface QueryOptions { sort?: Raw; skip?: number; limit?: number; lean?: boolean }

/** Thenable query: select/maxTimeMS are no-ops, lean returns plain objects, sort/skip/limit apply to arrays. */
export function chain<T>(run: (opts: QueryOptions) => T | Promise<T>) {
    const opts: QueryOptions = {};
    const query: any = {
        select: () => query, maxTimeMS: () => query,
        lean: () => { opts.lean = true; return query; },
        sort: (sort: Raw) => { opts.sort = sort; return query; },
        skip: (skip: number) => { opts.skip = skip; return query; },
        limit: (limit: number) => { opts.limit = limit; return query; },
        exec: async () => run(opts),
        then: (resolve: (value: T) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(() => run(opts)).then(resolve, reject),
        catch: (reject: (error: unknown) => unknown) => Promise.resolve().then(() => run(opts)).catch(reject),
    };
    return query;
}

function sortRows(rows: Raw[], sort?: Raw): Raw[] {
    if (!sort) return rows;
    return rows.slice().sort((a, b) => {
        for (const [key, direction] of Object.entries(sort)) {
            const x = comparable(a[key]) as any;
            const y = comparable(b[key]) as any;
            if (x === y) continue;
            return (x > y ? 1 : -1) * (direction === -1 ? -1 : 1);
        }
        return 0;
    });
}

export type WriteOp = 'findOneAndUpdate' | 'updateOne' | 'findOneAndDelete' | 'save' | 'create';

export interface FakeStore {
    store: Map<string, Raw>;
    seed(fields: Raw): Raw;
    /** Next query throws (database down). */
    failNext(): void;
    /**
     * Runs right before the next write query (to simulate someone else's edit in between). With
     * `when`, it waits for the first write it returns true for (e.g. skip an upsert that comes first).
     */
    beforeNextWrite(fn: () => void, when?: (op: WriteOp, filter: Raw, update?: Raw) => boolean): void;
}

/**
 * Stubs the model's statics and `save` with an in-memory collection. `unique` lists key sets the
 * collection keeps unique (inserts that repeat one throw a MongoDB-like duplicate key error, code 11000).
 */
export function installFakeModel(model: any, options: { defaults?: Raw; base?: Raw; unique?: string[][] } = {}): FakeStore {
    const store = new Map<string, Raw>();
    let fail = false;
    let hook: { fn: () => void; when?: (op: WriteOp, filter: Raw, update?: Raw) => boolean } | null = null;
    const defaults = options.defaults ?? {};
    const find = (filter: Raw) => {
        if (fail) { fail = false; throw new Error('database down'); }
        return [...store.values()].filter((raw) => matches(raw, filter, defaults));
    };
    const runHook = (op: WriteOp, filter: Raw, update?: Raw) => {
        if (!hook || (hook.when && !hook.when(op, filter, update))) return;
        const { fn } = hook;
        hook = null;
        fn();
    };
    const hydrate = (raw: Raw | undefined | null) => raw ? model.hydrate(clone(raw)) : null;
    const out = (raw: Raw | undefined | null, opts: QueryOptions) => raw ? (opts.lean ? clone(raw) : hydrate(raw)) : null;
    const checkUnique = (raw: Raw) => {
        for (const keys of options.unique ?? []) {
            const clash = [...store.values()].some((other) => String(other._id) !== String(raw._id)
                && keys.every((key) => comparable(get(other, key)) === comparable(get(raw, key))));
            if (clash) throw Object.assign(new Error(`E11000 duplicate key error (${keys.join(', ')})`), { code: 11000 });
        }
    };
    /** Saves in place, so tests holding a stored row see later writes. */
    const put = (doc: any) => {
        const raw = doc.toObject();
        const existing = store.get(String(raw._id));
        if (!existing) { checkUnique(raw); store.set(String(raw._id), raw); return raw; }
        for (const key of Object.keys(existing)) if (!(key in raw)) delete existing[key];
        Object.assign(existing, raw);
        return existing;
    };
    /** Upsert insert: the filter's equality fields plus the update, with the model's defaults. */
    const insertFrom = (filter: Raw, update: Raw) => {
        const seed = filterSeed(filter);
        applyUpdate(seed, update, true);
        return put(new model(seed));
    };

    mock.method(model, 'findOne', (filter: Raw) => chain((opts) => out(find(filter)[0], opts)));
    mock.method(model, 'find', (filter: Raw) => chain((opts) => {
        const rows = sortRows(find(filter), opts.sort).slice(opts.skip ?? 0);
        return (opts.limit ? rows.slice(0, opts.limit) : rows).map((raw) => out(raw, opts));
    }));
    mock.method(model, 'exists', (filter: Raw) => chain(() => { const raw = find(filter)[0]; return raw ? { _id: raw._id } : null; }));
    mock.method(model, 'countDocuments', (filter: Raw) => chain(() => find(filter).length));
    mock.method(model, 'findOneAndUpdate', (filter: Raw, update: Raw, writeOptions: { upsert?: boolean } = {}) => chain((opts) => {
        runHook('findOneAndUpdate', filter, update);
        const raw = find(filter)[0];
        if (!raw) return writeOptions?.upsert ? out(insertFrom(filter, update), opts) : null;
        // Like MongoDB: an update that would repeat a unique key writes nothing and throws.
        const next = clone(raw);
        applyUpdate(next, update);
        checkUnique(next);
        applyUpdate(raw, update);
        return out(raw, opts);
    }));
    mock.method(model, 'updateOne', (filter: Raw, update: Raw, writeOptions: { upsert?: boolean } = {}) => chain(() => {
        runHook('updateOne', filter, update);
        const raw = find(filter)[0];
        if (!raw) {
            if (!writeOptions?.upsert) return { matchedCount: 0, modifiedCount: 0 };
            insertFrom(filter, update);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        applyUpdate(raw, update);
        return { matchedCount: 1, modifiedCount: 1 };
    }));
    mock.method(model, 'findOneAndDelete', (filter: Raw) => chain((opts) => {
        runHook('findOneAndDelete', filter);
        const raw = find(filter)[0];
        if (!raw) return null;
        store.delete(String(raw._id));
        return out(raw, opts);
    }));
    mock.method(model, 'create', async (fields: Raw) => {
        runHook('create', fields);
        const doc = new model(fields);
        put(doc);
        return doc;
    });
    mock.method(model.prototype, 'save', async function (this: any) {
        runHook('save', { _id: this._id, ...(this.$where ?? {}) });
        const existing = store.get(String(this._id));
        // Like Mongoose: an update of a stored document adds `doc.$where` to its filter.
        if (existing && this.$where && !matches(existing, this.$where)) {
            throw new (mongoose.Error.DocumentNotFoundError as unknown as new (filter: unknown, model: string, numAffected: number, result: unknown) => Error)({ _id: this._id, ...this.$where }, model.modelName, 0, {});
        }
        put(this);
        return this;
    });

    return {
        store,
        seed(fields: Raw) {
            const doc = new model({ ...(options.base ?? {}), ...fields });
            const raw = put(doc);
            if ('blocks' in fields) { raw.blocks = fields.blocks; }
            return raw;
        },
        failNext() { fail = true; },
        beforeNextWrite(fn, when) { hook = { fn, when }; },
    };
}

/** Minimal Dragonfly client for the code paths the tools touch. */
export function fakeRedis() {
    const deleted: string[] = [];
    const locks = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    const client = {
        deleted,
        del: async (key: string) => { deleted.push(key); return 1; },
        get: async () => null,
        set: async (key: string, value: string, opts?: { NX?: boolean }) => {
            if (opts?.NX && locks.has(key)) return null;
            locks.set(key, value);
            return 'OK';
        },
        eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
            if (locks.get(opts.keys[0]) === opts.arguments[0]) locks.delete(opts.keys[0]);
            return 1;
        },
        sIsMember: async (key: string, member: string) => sets.get(key)?.has(member) ?? false,
        sAdd: async (key: string, member: string) => { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key)!.add(member); return 1; },
        hSet: async () => 1,
        hDel: async () => 1,
        reset() { deleted.length = 0; locks.clear(); sets.clear(); },
    };
    return client;
}
