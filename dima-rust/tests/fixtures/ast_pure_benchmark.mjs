#!/usr/bin/env node
// Source-backed offline benchmark emitter. Only the lead runs timed workloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Encodings are named deliberately: byte SHA256 is never a tree fingerprint.
function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function fingerprint(value) {
    let hash = 2166136261;
    const feed = text => {
        for (const byte of Buffer.from(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    };
    const walk = item => {
        if (Array.isArray(item)) { feed('['); item.forEach(walk); feed(']'); }
        else if (item !== null && typeof item === 'object') {
            feed('{');
            for (const key of Object.keys(item).sort()) { feed(key); feed(':'); walk(item[key]); }
            feed('}');
        } else if (typeof item === 'number') { const bits = Buffer.allocUnsafe(8); bits.writeDoubleBE(item); feed(`f64:${bits.toString('hex')}`); feed(';'); }
        else { feed(JSON.stringify(item)); feed(';'); }
    };
    walk(value);
    return hash.toString(16).padStart(8, '0');
}
// Narrow cross-runtime projection, outside all measurements. Raw source corpus
// retains these diagnostics. Ordinary JS object property order remains exact.
function projectObservation(value) {
    const result = structuredClone(value);
    const canonicalAst = node => {
        if (node?.type === 'object') {
            node.value.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
            node.value.forEach(entry => canonicalAst(entry[1]));
        } else if (node?.type === 'array') node.value.forEach(canonicalAst);
    };
    result.host.events = result.host.events.filter(event => event.value[0].value !== 'cache.client'
        && !(event.value[0].value === 'console.error' && event.value[1].value === 'AST timer scheduling failed'));
    for (const event of result.host.events) if (event.value[0].value === 'timer.schedule') canonicalAst(event.value[2]);
    for (const timer of result.host.timers) canonicalAst(timer.value.find(entry => entry[0] === 'body')[1]);
    return result;
}
// Classification derives from prepared literal inputs, never timing outcomes.
function workloadClass(input) {
    const node = input.ast;
    if (!['upper', 'lower', 'title', 'capitalize'].includes(node?.name)) return { group: 'other' };
    assert.equal(node.type, 'function');
    assert.ok(node.args.every(arg => arg.type === 'literal' && typeof arg.value === 'string'));
    const text = node.args.map(arg => arg.value).join(' ');
    const firstUnicode = text.search(/[^\x00-\x7f]/);
    const size = text.length <= 128 ? 'short' : 'long';
    return { group: 'case', function: node.name, character_set: firstUnicode < 0 ? 'ascii' : 'mixed_unicode', size,
        scenario: firstUnicode < 0 ? `ascii_${size}` : firstUnicode > 128 ? 'unicode_tail' : 'unicode_mixed' };
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function validateRequests(requests) {
    assert.equal(requests.version, 1);
    assert.equal(requests.profile, 'typescript_compatible');
    assert.equal(requests.fingerprint_encoding, 'json-tree-fnv1a-utf8-f64be-v1');
    assert.ok(Number.isInteger(requests.iterations) && requests.iterations >= 1 && requests.iterations <= 100000);
    assert.ok(Number.isInteger(requests.warmup) && requests.warmup >= 0 && requests.warmup <= 1000);
    assert.ok(Number.isInteger(requests.batches) && requests.batches >= 1 && requests.batches <= 20);
    if (requests.iterations !== 50) assert.ok(requests.iteration_reason?.length, 'Nonstandard iteration count requires a reason');
    assert.ok(requests.fixtures.length > 0 && requests.fixtures.length <= 32);
    assert.equal(new Set(requests.fixtures.map(item => item.name)).size, requests.fixtures.length);
    const coverage = new Set();
    for (const item of requests.fixtures) {
        assert.equal(item.operation, item.input.operation);
        assert.equal(item.input.pureBuiltins, true);
        assert.deepEqual(item.workload_class, workloadClass(item.input));
        assert.ok(['evaluate', 'parseEvaluate', 'preparedRender'].includes(item.operation));
        assert.equal(item.excluded_reason, undefined, 'No pure workloads silently excluded');
        assert.ok(item.expected && item.expected_fingerprint_fnv1a_utf8);
        const c = item.workload_class;
        if (c.group === 'case') coverage.add(`${c.function}/${c.scenario}`);
    }
    for (const fn of ['upper', 'lower', 'title', 'capitalize']) {
        for (const scenario of ['ascii_short', 'ascii_long', 'unicode_mixed', 'unicode_tail']) {
            assert.ok(coverage.has(`${fn}/${scenario}`), `Missing case workload ${fn}/${scenario}`);
        }
    }
}

// This function is embedded in the standalone runner with the ACTUAL source
// loader/factory. It never imports the production function index or services.
async function runBenchmark(api, metadata) {
    const args = process.argv.slice(2);
    assert.ok(args.length === 2 && args[0] === '--requests', 'Usage: --requests PATH');
    const bytes = readFileSync(args[1]);
    assert.ok(bytes.length <= 4000000, 'Requests exceed 4MB');
    const requests = JSON.parse(bytes);
    validateRequests(requests);
    assert.deepEqual(requests.sources, metadata.sources);
    assert.equal(requests.corpus_sha256_hex, metadata.corpus_sha256_hex);
    assert.equal(requests.manifest_sha256_hex, metadata.manifest_sha256_hex);
    assert.equal(sha256Bytes(bytes), metadata.request_sha256_hex, 'Frozen request bytes changed');
    const started = performance.now();
    const checkTotal = () => assert.ok(performance.now() - started <= 120000, 'Total exceeded 120 seconds');
    const measurements = [];
    for (const fixture of requests.fixtures) {
        // Parsing/preparation, exact assertions and checksums are all untimed.
        const prepared = await api.prepareBenchmark(fixture);
        const preflight = projectObservation(prepared.normalize(await prepared.run()));
        assert.deepEqual(preflight, fixture.expected, `Preflight: ${fixture.name}`);
        assert.equal(fingerprint(preflight), fixture.expected_fingerprint_fnv1a_utf8);
        for (let i = 0; i < requests.warmup; i++) { await prepared.run(); checkTotal(); }
        const durations_ns = [];
        const exact_case_outcomes = [];
        let checksum, postflight;
        for (let batch = 0; batch < requests.batches; batch++) {
            let last;
            const begin = performance.now();
            for (let i = 0; i < requests.iterations; i++) {
                last = await prepared.run();
                assert.ok(performance.now() - begin <= 5000, 'Batch exceeded five seconds');
                checkTotal();
            }
            const elapsed = performance.now() - begin;
            assert.ok(elapsed <= 5000, 'Batch exceeded five seconds');
            durations_ns.push(Math.round(elapsed * 1e6));
            // Full normalization, JSON-tree walking and assertion after timing.
            const normalized = projectObservation(prepared.normalize(last));
            assert.deepEqual(normalized, fixture.expected, `Postflight: ${fixture.name}, batch ${batch}`);
            postflight = normalized;
            checksum = fingerprint(normalized);
            assert.equal(checksum, fixture.expected_fingerprint_fnv1a_utf8);
            exact_case_outcomes.push({ batch, matched: true, fingerprint_fnv1a_utf8: checksum });
            checkTotal();
        }
        const ns_per_op = durations_ns.map(value => value / requests.iterations);
        measurements.push({ fixture: fixture.name, operation: fixture.operation, workload_class: fixture.workload_class, description: fixture.description,
            method: 'actual TypeScript prepared evaluation, fresh context/fakehost/RNG per operation',
            preparation: fixture.preparation,
            iterations: requests.iterations, warmup: requests.warmup, batches: requests.batches,
            durations_ns, ns_per_op, median_ns_per_op: median(ns_per_op),
            preflight, postflight, fingerprint_fnv1a_utf8: checksum, exact_case_outcomes });
    }
    const ownBytes = readFileSync(fileURLToPath(import.meta.url));
    const runner_sha256_hex = sha256Bytes(ownBytes);
    const request_sha256_hex = sha256Bytes(bytes);
    checkTotal();
    console.log(JSON.stringify({ version: 1, runtime: process.version, build_profile: 'source', implementation_variant: 'typescript', profile: requests.profile, fingerprint_encoding: requests.fingerprint_encoding,
        request_sha256_hex, runner_sha256_hex,
        corpus_sha256_hex: requests.corpus_sha256_hex, manifest_sha256_hex: requests.manifest_sha256_hex,
        sources: requests.sources, typescript_version: requests.typescript_version, measurements }));
}

// Shared loader and preparation contract is documented in /tmp during delivery.
// No source VM or evaluator logic is duplicated here.
async function emit(output) {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const oracleModule = await import('./ast_pure_reference.mjs');
    const corpusBytes = readFileSync(resolve(repo, 'dima-rust/tests/fixtures/ast_pure_cases.json'));
    const corpus = JSON.parse(corpusBytes);
    assert.equal(corpus.schemaVersion, 1);
    assert.equal(corpus.profile, 'source-parity');
    const manifestBytes = JSON.stringify({ cases: corpus.cases, benchmarks: corpus.benchmarks });
    assert.equal(sha256Bytes(manifestBytes), corpus.manifestHash);
    const oracle = await oracleModule.createSourceOracle();
    const fixtures = [];
    for (const definition of corpus.benchmarks) {
        const fixture = { name: definition.id, operation: definition.input.operation,
            description: definition.description, input: definition.input, preparation: definition.costs, workload_class: workloadClass(definition.input) };
        assert.ok(['evaluate', 'parseEvaluate', 'preparedRender'].includes(fixture.operation), `Unsupported workload ${fixture.name}`);
        const run = await oracle.prepareBenchmark(fixture.input);
        const expected = projectObservation(oracle.normalizeObservation(await run()));
        assert.deepEqual(expected, projectObservation(definition.source), `Frozen benchmark source: ${definition.id}`);
        assert.deepEqual(projectObservation(oracle.normalizeObservation(await run())), expected, `Fresh state: ${definition.id}`);
        fixtures.push({ ...fixture, expected, expected_fingerprint_fnv1a_utf8: fingerprint(expected) });
    }
    const metadata = { sources: corpus.sourceHashes,
        corpus_sha256_hex: sha256Bytes(corpusBytes), manifest_sha256_hex: corpus.manifestHash };
    const requests = { version: 1, iterations: 50, warmup: 20, batches: 7,
        profile: 'typescript_compatible', fingerprint_encoding: 'json-tree-fnv1a-utf8-f64be-v1', ...metadata,
        typescript_version: JSON.parse(readFileSync(resolve(repo, 'dimabot/node_modules/typescript/package.json'))).version, fixtures };
    validateRequests(requests);
    // Lock offline replay to the complete request bytes; no fitted subsets.
    const requestBytes = JSON.stringify(requests) + '\n';
    assert.ok(Buffer.byteLength(requestBytes) <= 4000000, 'Requests exceed 4MB');
    metadata.request_sha256_hex = sha256Bytes(requestBytes);
    const transport = await oracleModule.sourceLoaderTransport();
    assert.equal(typeof transport, 'string');
    const runner = `import assert from 'node:assert/strict';\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n${sha256Bytes}\n${fingerprint}\n${projectObservation}\n${workloadClass}\n${median}\n${validateRequests}\n${runBenchmark}\nconst oracle = await (${transport})();\nconst api = { async prepareBenchmark(fixture) { const run = await oracle.prepareBenchmark(fixture.input); return { run, normalize: oracle.normalizeObservation }; } };\nawait runBenchmark(api, ${JSON.stringify(metadata)});\n`;
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'requests.json'), requestBytes);
    writeFileSync(resolve(output, 'ast-pure-ts-bench.mjs'), runner);
    const provenance = { ...metadata, request_sha256_hex: sha256Bytes(requestBytes),
        runner_sha256_hex: sha256Bytes(runner), emitter_sha256_hex: sha256Bytes(readFileSync(fileURLToPath(import.meta.url))),
        emitter_runtime: process.version, typescript_version: requests.typescript_version };
    writeFileSync(resolve(output, 'source-hashes.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log(JSON.stringify({ output, fixtures: fixtures.length,
        ...provenance }));
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--emit') throw new Error('Usage: node ast_pure_benchmark.mjs --emit DIR');
await emit(resolve(args[1]));
