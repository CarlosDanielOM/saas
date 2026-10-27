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
    assert.ok(requests.fixtures.length > 0 && requests.fixtures.length <= 64);
    assert.equal(new Set(requests.fixtures.map(item => item.name)).size, requests.fixtures.length);
    for (const item of requests.fixtures) assert.equal(item.operation, item.input.operation);
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
    const started = performance.now();
    const checkTotal = () => assert.ok(performance.now() - started <= 120000, 'Total exceeded 120 seconds');
    const measurements = [];
    for (const fixture of requests.fixtures) {
        if (fixture.excluded_reason) {
            measurements.push({ fixture: fixture.name, excluded_reason: fixture.excluded_reason });
            continue;
        }
        // Parsing/preparation, exact assertions and checksums are all untimed.
        const prepared = await api.prepareBenchmark(fixture);
        const preflight = projectObservation(prepared.normalize(await prepared.run()));
        assert.deepEqual(preflight, fixture.expected, `Preflight: ${fixture.name}`);
        assert.equal(fingerprint(preflight), fixture.expected_fingerprint_fnv1a_utf8);
        for (let i = 0; i < requests.warmup; i++) { await prepared.run(); checkTotal(); }
        const durations_ns = [];
        const exact_case_outcomes = [];
        let checksum;
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
            checksum = fingerprint(normalized);
            assert.equal(checksum, fixture.expected_fingerprint_fnv1a_utf8);
            exact_case_outcomes.push({ batch, matched: true, fingerprint_fnv1a_utf8: checksum });
            checkTotal();
        }
        const ns_per_op = durations_ns.map(value => value / requests.iterations);
        measurements.push({ fixture: fixture.name, operation: fixture.operation,
            method: 'actual TypeScript prepared evaluation, fresh context/fakehost/RNG per operation',
            preparation: 'source AST/template parsed once outside timed loop',
            iterations: requests.iterations, warmup: requests.warmup, batches: requests.batches,
            durations_ns, ns_per_op, median_ns_per_op: median(ns_per_op),
            fingerprint_fnv1a_utf8: checksum, exact_case_outcomes });
    }
    const ownBytes = readFileSync(fileURLToPath(import.meta.url));
    const runner_sha256_hex = sha256Bytes(ownBytes);
    const request_sha256_hex = sha256Bytes(bytes);
    checkTotal();
    console.log(JSON.stringify({ version: 1, runtime: process.version, profile: requests.profile, fingerprint_encoding: requests.fingerprint_encoding,
        request_sha256_hex, runner_sha256_hex,
        corpus_sha256_hex: requests.corpus_sha256_hex, manifest_sha256_hex: requests.manifest_sha256_hex,
        sources: requests.sources, typescript_version: requests.typescript_version, measurements }));
}

// Shared loader and preparation contract is documented in /tmp during delivery.
// No source VM or evaluator logic is duplicated here.
async function emit(output) {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const oracleModule = await import('./ast_evaluator_reference.mjs');
    const corpusBytes = readFileSync(resolve(repo, 'dimabot/tests/fixtures/ast_evaluator_cases.json'));
    const corpus = JSON.parse(corpusBytes);
    assert.equal(corpus.schemaVersion, 1);
    assert.equal(corpus.profile, 'source-parity');
    const manifestBytes = JSON.stringify({ cases: corpus.cases, benchmarks: corpus.benchmarks });
    assert.equal(sha256Bytes(manifestBytes), corpus.manifestHash);
    const oracle = await oracleModule.createSourceOracle();
    const fixtures = [];
    for (const definition of corpus.benchmarks) {
        const fixture = { name: definition.id, operation: definition.input.operation,
            description: definition.description, input: definition.input, preparation: definition.costs };
        // Real timers/delays and networking cannot be made into throughput wins.
        if (definition.excludedReason) {
            fixtures.push({ ...fixture, excluded_reason: definition.excludedReason });
            continue;
        }
        if (['timer', 'snapshot'].includes(fixture.operation)) {
            fixtures.push({ ...fixture, excluded_reason: 'Timer/snapshot semantics are parity-tested; future-due scheduling is excluded from prepared evaluator throughput.' });
            continue;
        }
        if (fixture.operation === 'render') {
            fixtures.push({ ...fixture, excluded_reason: 'Full renderer includes scanning/parsing each operation. This run measures prepared evaluation; cold compile+render is excluded on both sides.' });
            continue;
        }
        assert.ok(['evaluate', 'parseEvaluate', 'preparedRender'].includes(fixture.operation), `Unsupported workload ${fixture.name}`);
        const run = await oracle.prepareBenchmark(fixture.input);
        const expected = projectObservation(oracle.normalizeObservation(await run()));
        fixtures.push({ ...fixture, expected, expected_fingerprint_fnv1a_utf8: fingerprint(expected) });
    }
    const metadata = { sources: corpus.sourceHashes,
        corpus_sha256_hex: sha256Bytes(corpusBytes), manifest_sha256_hex: corpus.manifestHash };
    const requests = { version: 1, iterations: 50, warmup: 20, batches: 7,
        profile: 'typescript_compatible', fingerprint_encoding: 'json-tree-fnv1a-utf8-f64be-v1', ...metadata,
        typescript_version: JSON.parse(readFileSync(resolve(repo, 'dimabot/node_modules/typescript/package.json'))).version, fixtures };
    validateRequests(requests);
    const transport = await oracleModule.sourceLoaderTransport();
    assert.equal(typeof transport, 'string');
    const runner = `import assert from 'node:assert/strict';\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n${sha256Bytes}\n${fingerprint}\n${projectObservation}\n${median}\n${validateRequests}\n${runBenchmark}\nconst oracle = await (${transport})();\nconst api = { async prepareBenchmark(fixture) { const run = await oracle.prepareBenchmark(fixture.input); return { run, normalize: oracle.normalizeObservation }; } };\nawait runBenchmark(api, ${JSON.stringify(metadata)});\n`;
    mkdirSync(output, { recursive: true });
    const requestBytes = JSON.stringify(requests, null, 2) + '\n';
    writeFileSync(resolve(output, 'requests.json'), requestBytes);
    writeFileSync(resolve(output, 'ast-evaluator-ts-bench.mjs'), runner);
    const provenance = { ...metadata, request_sha256_hex: sha256Bytes(requestBytes),
        runner_sha256_hex: sha256Bytes(runner), emitter_sha256_hex: sha256Bytes(readFileSync(fileURLToPath(import.meta.url))),
        emitter_runtime: process.version, typescript_version: requests.typescript_version };
    writeFileSync(resolve(output, 'source-hashes.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log(JSON.stringify({ output, fixtures: fixtures.length,
        excluded: fixtures.filter(item => item.excluded_reason).map(item => ({ name: item.name, reason: item.excluded_reason })),
        ...provenance }));
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--emit') throw new Error('Usage: node ast_evaluator_benchmark.mjs --emit DIR');
await emit(resolve(args[1]));
