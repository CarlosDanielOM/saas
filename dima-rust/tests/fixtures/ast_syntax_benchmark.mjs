#!/usr/bin/env node
// Emits an offline, dependency-free runner. No evaluator or barrel is imported.
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
const syntaxRoot = resolve(repo, 'dimabot/src/utils/ast_parser');
const modules = {};
const typeSource = readFileSync(resolve(syntaxRoot, 'types.ts'), 'utf8');
const sources = [{ path: 'dimabot/src/utils/ast_parser/types.ts', sha256: createHash('sha256').update(typeSource).digest('hex') }];
for (const name of ['tokenizer', 'registry', 'parser', 'render']) {
    const path = resolve(syntaxRoot, `${name}.ts`);
    const source = readFileSync(path, 'utf8');
    sources.push({ path: `dimabot/src/utils/ast_parser/${name}.ts`, sha256: createHash('sha256').update(source).digest('hex') });
    const result = ts.transpileModule(source, {
        fileName: `${name}.ts`, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    });
    assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    modules[`./${name}.js`] = result.outputText;
}
modules['./evaluator.js'] = 'exports.evaluate = () => { throw new Error("Evaluation is prohibited in syntax benchmarks"); };';

// Shared by emitter and generated runner; each load uses a fresh module cache.
function loadSyntax(moduleSources) {
    const context = vm.createContext({});
    const cache = new Map();
    function load(id) {
        if (cache.has(id)) return cache.get(id).exports;
        assert.ok(Object.hasOwn(moduleSources, id), `Prohibited syntax dependency: ${id}`);
        const module = { exports: {} };
        cache.set(id, module);
        const wrapper = new vm.Script(`(function(exports, require, module) {\n${moduleSources[id]}\n})`, { filename: id });
        wrapper.runInContext(context, { timeout: 1000 })(module.exports, load, module);
        return module.exports;
    }
    return { ...load('./parser.js'), ...load('./render.js') };
}

// Stable JSON-tree fingerprint, outside measured sections. Object keys sort;
// arrays retain order. UTF8 bytes use wrapping FNV-1a, matching the Rust example.
function checksum(value) {
    let hash = 2166136261;
    const feed = text => { for (const b of Buffer.from(text)) hash = Math.imul(hash ^ b, 16777619) >>> 0; };
    const walk = v => {
        if (Array.isArray(v)) { feed('['); v.forEach(walk); feed(']'); }
        else if (v !== null && typeof v === 'object') {
            feed('{');
            for (const key of Object.keys(v).filter(key => v[key] !== undefined).sort()) { feed(key); feed(':'); walk(v[key]); }
            feed('}');
        } else { feed(JSON.stringify(v)); feed(';'); }
    };
    walk(value);
    return hash.toString(16).padStart(8, '0');
}
function compile(api, request) {
    if (request.mode === 'program') {
        const result = api.parse(request.source);
        if (result.error) throw new Error(`${request.name}: ${result.error}`);
        return result.ast;
    }
    return api.scanSourceSegments(request.source).map(segment => {
        if (segment.kind === 'text' || segment.kind === 'unclosed') return segment;
        const result = api.parse(segment.source);
        if (result.error) throw new Error(`${request.name}: ${result.error}`);
        return { kind: 'expr', source: segment.source, ast: result.ast };
    });
}
function fixtures() {
    // Consume the oracle's actual fixture strings; never duplicate its inputs.
    const corpus = JSON.parse(readFileSync(resolve(repo, 'dima-rust/tests/fixtures/ast_syntax_cases.json'), 'utf8'));
    assert.equal(corpus.schemaVersion, 2);
    for (const source of sources) {
        assert.equal(corpus.sources[source.path.split('/').at(-1)], source.sha256,
            `Oracle/source hash mismatch: ${source.path}`);
    }
    const expectedNames = ['short-hi', 'mixed', 'loop', 'plain8000', 'dense100', 'dense500',
        ...[8, 16, 32, 64, 128].map(n => `nested-arrays-${n}`),
        ...[32, 64, 128].map(n => `nested-compute-${n}`)];
    assert.deepEqual(corpus.benchmarks.map(f => f.name).sort(), expectedNames.sort());
    return corpus.benchmarks.map(fixture => ({
        name: fixture.name,
        mode: ['short-hi', 'mixed', 'plain8000', 'dense100', 'dense500'].includes(fixture.name) ? 'template' : 'program',
        source: fixture.source,
        profile: 'improved',
        ...(fixture.generated?.depth === 128 || fixture.name === 'nested-arrays-64' ? {
            excluded_reason: 'Safe persistence boundary: source/AST nesting or serialized JSON containers exceed the hard 128 ceiling; excluded identically from both runners.'
        } : {})
    }));
}

async function runBenchmark(moduleSources, metadata) {
    const args = process.argv.slice(2);
    const index = args.indexOf('--requests');
    const input = index >= 0 ? readFileSync(args[index + 1], 'utf8') : readFileSync(0, 'utf8');
    assert.ok(Buffer.byteLength(input) <= 2000000, 'Requests exceed 2MB');
    const requests = JSON.parse(input);
    assert.equal(requests.version, 1);
    const iterations = requests.iterations ?? 100;
    const batches = requests.batches ?? 5;
    const warmup = requests.warmup ?? 10;
    assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 10000);
    assert.ok(Number.isInteger(batches) && batches >= 1 && batches <= 20);
    assert.ok(Number.isInteger(warmup) && warmup >= 0 && warmup <= 1000);
    assert.ok(requests.fixtures.length > 0 && requests.fixtures.length <= 64);
    assert.deepEqual(requests.sources, metadata, 'Requests/source hash mismatch');
    const api = loadSyntax(moduleSources);
    const output = [];
    const started = performance.now();
    let sink = 0;
    for (const fixture of requests.fixtures) {
        assert.ok(['program', 'template'].includes(fixture.mode));
        assert.ok(['improved', 'typescript_compatible'].includes(fixture.profile));
        assert.ok(fixture.source.length <= 10000);
        if (fixture.excluded_reason) { output.push({ name: fixture.name, excluded_reason: fixture.excluded_reason }); continue; }
        const actual = checksum(compile(api, fixture));
        assert.equal(actual, fixture.expected_checksum, `Semantic checksum: ${fixture.name}`);
        for (let i = 0; i < warmup; i++) {
            sink ^= compile(api, fixture).type === 'root' ? 1 : 2;
            assert.ok(performance.now() - started <= 30000, 'Total walltime exceeded 30s');
        }
        const durations_ns = [];
        for (let b = 0; b < batches; b++) {
            const begin = performance.now();
            for (let i = 0; i < iterations; i++) {
                const value = compile(api, fixture);
                sink ^= Array.isArray(value) ? value.length : value.children.length;
                if ((i & 31) === 0) assert.ok(performance.now() - begin <= 2000, 'Batch walltime exceeded 2s');
            }
            const elapsed = performance.now() - begin;
            assert.ok(elapsed <= 2000, 'Batch walltime exceeded 2s');
            durations_ns.push(Math.round(elapsed * 1e6));
            assert.ok(performance.now() - started <= 30000, 'Total walltime exceeded 30s');
        }
        output.push({ fixture: fixture.name, profile: fixture.profile, method: fixture.mode === 'template' ? 'TS scanSourceSegments + parse each expression' : 'TS parse', iterations, batches, durations_ns, ns_per_op: durations_ns.map(n => n / iterations), checksum: actual });
    }
    console.log(JSON.stringify({ version: 1, runtime: process.version, method: 'syntax compilation; no evaluation or timed JSON serialization', sources: metadata, sink, measurements: output }));
}

const args = process.argv.slice(2);
if (args[0] !== '--emit' || !args[1]) throw new Error('Usage: node ast_syntax_benchmark.mjs --emit DIR');
const output = resolve(args[1]);
mkdirSync(output, { recursive: true });
const api = loadSyntax(modules);
const cases = fixtures().map(f => f.excluded_reason ? f : { ...f, expected_checksum: checksum(compile(api, f)) });
const requests = { version: 1, iterations: 100, batches: 5, warmup: 10, sources, fixtures: cases };
writeFileSync(resolve(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
const runner = `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport vm from 'node:vm';\n${loadSyntax}\n${checksum}\n${compile}\n${runBenchmark}\nawait runBenchmark(${JSON.stringify(modules)}, ${JSON.stringify(sources)});\n`;
writeFileSync(resolve(output, 'ast-syntax-ts-bench.mjs'), runner);
writeFileSync(resolve(output, 'source-hashes.json'), JSON.stringify({ sources, emitter_runtime: process.version, typescript: ts.version }, null, 2) + '\n');
console.log(JSON.stringify({ output, fixtures: cases.length, excluded: cases.filter(f => f.excluded_reason).map(f => f.name), sources }));
