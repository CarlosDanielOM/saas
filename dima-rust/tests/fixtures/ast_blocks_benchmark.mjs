#!/usr/bin/env node
// Source-backed emitter only. Generated runner has no npm/runtime dependencies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(repo, 'dimabot/package.json'));
const ts = require('typescript');
const allowed = [
    ...['types', 'validate', 'normalize', 'to_source', 'from_ast', 'index'].map(n => `ast_blocks/${n}.js`),
    ...['types', 'tokenizer', 'registry', 'parser', 'render'].map(n => `ast_parser/${n}.js`),
];
const modules = {};
const sources = {};
const hash = text => createHash('sha256').update(text).digest('hex');
for (const id of allowed) {
    const path = `dimabot/src/utils/${id.replace(/\.js$/, '.ts')}`;
    const source = readFileSync(resolve(repo, path), 'utf8');
    sources[id.replace(/\.js$/, '.ts')] = hash(source);
    const result = ts.transpileModule(source, {
        fileName: path, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    modules[id] = result.outputText;
}
function loadBlocks(moduleSources) {
    const cache = new Map();
    const context = vm.createContext({});
    function load(id) {
        // Parser imports evaluator for an unused method: never load its source.
        if (id === 'ast_parser/evaluator.js') return { evaluate() { throw new Error('Evaluator prohibited'); } };
        assert.ok(Object.hasOwn(moduleSources, id), `Prohibited dependency: ${id}`);
        if (cache.has(id)) return cache.get(id).exports;
        const module = { exports: {} };
        cache.set(id, module);
        const localRequire = dependency => {
            assert.ok(dependency.startsWith('.'), `External dependency prohibited: ${dependency}`);
            const parts = `${id.slice(0, id.lastIndexOf('/'))}/${dependency}`.split('/');
            const normalized = [];
            for (const part of parts) {
                if (part === '..') normalized.pop();
                else if (part !== '.' && part) normalized.push(part);
            }
            return load(normalized.join('/'));
        };
        new vm.Script(`(function(exports, require, module){\n${moduleSources[id]}\n})`, { filename: id })
            .runInContext(context, { timeout: 1000 })(module.exports, localRequire, module);
        return module.exports;
    }
    return load('ast_blocks/index.js');
}
// Object order independent FNV-1a over UTF8. Used only before/after timing.
function checksum(value) {
    let hash = 2166136261;
    const feed = text => { for (const b of Buffer.from(text)) hash = Math.imul(hash ^ b, 16777619) >>> 0; };
    const walk = v => {
        if (Array.isArray(v)) { feed('['); v.forEach(walk); feed(']'); }
        else if (v !== null && typeof v === 'object') {
            feed('{');
            for (const key of Object.keys(v).filter(k => v[k] !== undefined).sort()) { feed(key); feed(':'); walk(v[key]); }
            feed('}');
        } else { feed(JSON.stringify(v)); feed(';'); }
    };
    walk(value);
    return hash.toString(16).padStart(8, '0');
}
function withoutIds(value) {
    // Copy VM arrays into this realm before strict semantic comparison.
    if (Array.isArray(value)) return Array.from(value, withoutIds);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key, v]) => key !== 'id' && v !== undefined).map(([key, v]) => [key, withoutIds(v)]));
    return value;
}
function operation(api, fixture) {
    try {
        return { value: fixture.operation === 'import' ? api.importCommandText(fixture.input) : api.compileBlocks(fixture.input) };
    } catch (error) { return { error }; }
}
function semantics(result, operationName) {
    if (result.error) return { outcome: 'error', message: result.error.message };
    const value = result.value;
    return operationName === 'import'
        ? { outcome: 'imported', root: withoutIds(value.root), advancedCount: value.advancedCount }
        : { outcome: 'compiled', root: withoutIds(value.root), text: value.text };
}
function consume(result) {
    if (result.error) return result.error.message.length;
    return result.value.root.children.length + (result.value.text?.length ?? result.value.advancedCount);
}
function runBenchmark(moduleSources, metadata) {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--requests'), 'Usage: runner [--requests PATH]');
    const input = readFileSync(args.length ? args[1] : 0, 'utf8');
    assert.ok(Buffer.byteLength(input) <= 2000000, 'Requests exceed 2MB');
    const requests = JSON.parse(input);
    assert.equal(requests.version, 1);
    assert.equal(requests.profile, 'typescript_compatible');
    assert.deepEqual(requests.sources, metadata.sources, 'Source hashes differ');
    assert.equal(requests.corpus_hash, metadata.corpus_hash, 'Exact JSON-file hash differs');
    assert.equal(requests.manifest_corpus_hash, metadata.manifest_corpus_hash, 'Manifest hash differs');
    const { iterations, batches, warmup } = requests;
    assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 500);
    assert.ok(Number.isInteger(batches) && batches >= 1 && batches <= 10);
    assert.ok(Number.isInteger(warmup) && warmup >= 0 && warmup <= 100);
    assert.ok(requests.fixtures.length >= 1 && requests.fixtures.length <= 64);
    const api = loadBlocks(moduleSources);
    const measurements = [];
    const started = performance.now();
    let sink = 0;
    for (const fixture of requests.fixtures) {
        assert.ok(['import', 'compile'].includes(fixture.operation));
        if (fixture.excluded_reason) { measurements.push({ fixture: fixture.name, operation: fixture.operation, excluded_reason: fixture.excluded_reason }); continue; }
        const actual = semantics(operation(api, fixture), fixture.operation);
        assert.deepEqual(actual, fixture.expected, fixture.name);
        const actualChecksum = checksum(actual);
        assert.equal(actualChecksum, fixture.expected_checksum, fixture.name);
        for (let i = 0; i < warmup; i++) {
            sink ^= consume(operation(api, fixture));
            assert.ok(performance.now() - started <= 120000, 'Total exceeds 120s');
        }
        const durations_ns = [];
        for (let batch = 0; batch < batches; batch++) {
            const begin = performance.now();
            for (let i = 0; i < iterations; i++) {
                sink ^= consume(operation(api, fixture));
                if ((i & 15) === 0) assert.ok(performance.now() - begin <= 5000, 'Batch exceeds 5s');
            }
            const elapsed = performance.now() - begin;
            assert.ok(elapsed <= 5000, 'Batch exceeds 5s');
            durations_ns.push(Math.round(elapsed * 1e6));
            assert.ok(performance.now() - started <= 120000, 'Total exceeds 120s');
        }
        // Revalidate after measurements as well; IDs are never overwritten in import.
        assert.deepEqual(semantics(operation(api, fixture), fixture.operation), fixture.expected, fixture.name);
        measurements.push({ fixture: fixture.name, operation: fixture.operation, iterations, batches,
            durations_ns, ns_per_op: durations_ns.map(n => n / iterations), checksum: actualChecksum });
    }
    console.log(JSON.stringify({ version: 1, runtime: process.version, build_profile: 'TypeScript transpiled ES2022',
        profile: requests.profile, typescript_version: requests.typescript_version,
        sources: requests.sources, corpus_hash: requests.corpus_hash, manifest_corpus_hash: requests.manifest_corpus_hash, requests_checksum: checksum(requests),
        iterations, batches, warmup, method: 'separate full public import / borrowed compile operations; no evaluation',
        sink, measurements }));
}

const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--emit', 'Usage: node ast_blocks_benchmark.mjs --emit DIR');
const corpusBytes = readFileSync(resolve(repo, 'dima-rust/tests/fixtures/ast_blocks_cases.json'), 'utf8');
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.schemaVersion, 1);
assert.deepEqual(sources, corpus.sources, 'Regenerate source oracle before benchmark emit');
assert.ok(corpus.benchmarks.length > 0 && corpus.benchmarks.length <= 32);
const api = loadBlocks(modules);
const fixtures = [];
// Canonical IDs only for PREPARED compile inputs, outside measured operations.
// Timed imports retain their actual random IDs and never rewrite them.
function preparedIds(value) {
    let seq = 0;
    const walk = item => {
        if (Array.isArray(item)) return item.map(walk);
        if (!item || typeof item !== 'object') return item;
        const out = {};
        if (typeof item.id === 'string') out.id = `b${++seq}`;
        for (const [key, child] of Object.entries(item)) if (key !== 'id') out[key] = walk(child);
        return out;
    };
    return walk(value);
}
for (const definition of corpus.benchmarks) {
    assert.equal(typeof definition.timingPair, 'boolean');
    if (!definition.timingPair) {
        fixtures.push({ name: definition.name, operation: 'compile', input: null,
            excluded_reason: `Oracle separate-verification definition (${definition.input.kind}); no same-behavior timing pair.` });
        continue;
    }
    if (definition.input.kind === 'compile-tree-spec') {
        assert.equal(definition.input.treeSpec, 'empty-ternary');
        const fixture = { name: definition.name, operation: 'compile', input: definition.input.input };
        fixture.expected = semantics(operation(api, fixture), fixture.operation);
        fixture.expected_checksum = checksum(fixture.expected);
        fixtures.push(fixture);
        continue;
    }
    assert.equal(definition.input.kind, 'import');
    assert.equal(typeof definition.input.text, 'string');
    for (const operationName of ['import', 'compile']) {
        const imported = operation(api, { operation: 'import', input: definition.input.text });
        if (operationName === 'compile' && imported.error) {
            fixtures.push({ name: definition.name, operation: operationName, input: null,
                excluded_reason: 'Source import rejects the input; there is no source-valid root to compile.' });
            continue;
        }
        const input = operationName === 'import' ? definition.input.text : preparedIds(imported.value.root);
        const fixture = { name: definition.name, operation: operationName, input };
        fixture.expected = semantics(operation(api, fixture), operationName);
        fixture.expected_checksum = checksum(fixture.expected);
        fixtures.push(fixture);
    }
}
const requests = { version: 1, iterations: 50, batches: 7, warmup: 20, profile: 'typescript_compatible',
    sources, corpus_hash: hash(corpusBytes), manifest_corpus_hash: corpus.corpusHash, typescript_version: ts.version, fixtures };
const output = resolve(args[1]);
mkdirSync(output, { recursive: true });
const requestText = JSON.stringify(requests) + '\n';
assert.ok(Buffer.byteLength(requestText) <= 2000000);
writeFileSync(resolve(output, 'requests.json'), requestText);
const runner = `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport vm from 'node:vm';\n${loadBlocks}\n${checksum}\n${withoutIds}\n${operation}\n${semantics}\n${consume}\n${runBenchmark}\nrunBenchmark(${JSON.stringify(modules)}, ${JSON.stringify({ sources, corpus_hash: requests.corpus_hash, manifest_corpus_hash: requests.manifest_corpus_hash })});\n`;
writeFileSync(resolve(output, 'ast-blocks-ts-bench.mjs'), runner);
writeFileSync(resolve(output, 'source-hashes.json'), JSON.stringify({ sources, corpus_hash: requests.corpus_hash, manifest_corpus_hash: requests.manifest_corpus_hash,
    requests_sha256: hash(requestText), emitter_runtime: process.version, typescript: ts.version }, null, 2) + '\n');
console.log(JSON.stringify({ output, requests: fixtures.length, excluded: fixtures.filter(f => f.excluded_reason).map(f => `${f.name}:${f.operation}`) }));
