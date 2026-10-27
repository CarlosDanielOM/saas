#!/usr/bin/env node
// Source-backed ast_blocks fixtures for the dima-rust pure port.
//
//   node dimabot/tests/fixtures/ast_blocks_reference.mjs          # deterministic write
//   node dimabot/tests/fixtures/ast_blocks_reference.mjs --check  # byte compare, no write
//
// The oracle runs the actual TypeScript modules in an isolated VM:
//   dimabot/src/utils/ast_blocks/{types,validate,normalize,to_source,from_ast,index}.ts
//   dimabot/src/utils/ast_parser/{types,tokenizer,registry,parser,render}.ts
// No other runtime module is reachable. render.ts imports the evaluator, so the
// loader substitutes a throw-only stub; the fixture asserts it was never used.
// The ast_parser barrel, function registry, services, environment, clock and
// network are not imported. from_ast.idMaker is the only Math.random consumer
// in the allowed set; the VM's Math.random is a seeded LCG so oracle IDs for
// imports are reproducible. Import expectations are additionally canonicalized
// by pre-order traversal (n1, n2, ...) so Rust never depends on opaque salts.
//
// `source` always stores the unmodified (deterministic) TypeScript result.
// `expected` is the Rust-facing contract. Source-parity cases match the source;
// approved node-limit / import-fallback cases are classified explicitly and
// never rewrite `source`. See /tmp/ast-blocks-fixture-contract.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const cli = process.argv.slice(2);
assert.ok(
    cli.length === 0 || (cli.length === 1 && cli[0] === '--check'),
    'Usage: node ast_blocks_reference.mjs [--check]'
);
const checkOnly = cli[0] === '--check';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(repo, 'dimabot/package.json'));
const ts = require('typescript');
const blocksRoot = resolve(repo, 'dimabot/src/utils/ast_blocks');
const parserRoot = resolve(repo, 'dimabot/src/utils/ast_parser');
const testPath = resolve(blocksRoot, 'ast_blocks.test.ts');
const fixtureUrl = new URL('ast_blocks_cases.json', import.meta.url);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const RELATIVE = {
    [resolve(blocksRoot, 'types.ts')]: 'ast_blocks/types.ts',
    [resolve(blocksRoot, 'validate.ts')]: 'ast_blocks/validate.ts',
    [resolve(blocksRoot, 'normalize.ts')]: 'ast_blocks/normalize.ts',
    [resolve(blocksRoot, 'to_source.ts')]: 'ast_blocks/to_source.ts',
    [resolve(blocksRoot, 'from_ast.ts')]: 'ast_blocks/from_ast.ts',
    [resolve(blocksRoot, 'index.ts')]: 'ast_blocks/index.ts',
    [resolve(parserRoot, 'types.ts')]: 'ast_parser/types.ts',
    [resolve(parserRoot, 'tokenizer.ts')]: 'ast_parser/tokenizer.ts',
    [resolve(parserRoot, 'registry.ts')]: 'ast_parser/registry.ts',
    [resolve(parserRoot, 'parser.ts')]: 'ast_parser/parser.ts',
    [resolve(parserRoot, 'render.ts')]: 'ast_parser/render.ts'
};
const allowed = new Set(Object.keys(RELATIVE));

const sources = {};
let legacyTestHash = null;
let evaluatorCalls = 0;

// Deterministic IDs only: the isolated VM has no access to the host clock,
// environment, filesystem or network. The only Math.random user is idMaker.
const context = vm.createContext({});
vm.runInContext(`
    globalThis.__astBlocksRng = 0;
    Math.random = function () {
        globalThis.__astBlocksRng =
            (Math.imul(globalThis.__astBlocksRng, 1664525) + 1013904223) >>> 0;
        return globalThis.__astBlocksRng / 4294967296;
    };
`, context);
function resetIds(seed = 0x5eed1234) {
    vm.runInContext(`globalThis.__astBlocksRng = ${seed >>> 0};`, context);
}

const testDefinitions = [];
const legacyAssertions = [];
const currentTest = { name: null };
function testStub(name, fn) {
    testDefinitions.push({ name, fn });
}
const recordingAssert = {
    equal(actual, expected, message) {
        assert.equal(actual, expected, message);
        legacyAssertions.push({ test: currentTest.name, kind: 'equal', actual: json(actual), expected: json(expected) });
    },
    notEqual(actual, expected, message) {
        assert.notEqual(actual, expected, message);
        legacyAssertions.push({ test: currentTest.name, kind: 'notEqual', actual: json(actual), expected: json(expected) });
    },
    deepEqual(actual, expected, message) {
        assert.deepEqual(actual, expected, message);
        legacyAssertions.push({ test: currentTest.name, kind: 'deepEqual', actual: json(actual), expected: json(expected) });
    },
    ok(value, message) {
        assert.ok(value, message);
        legacyAssertions.push({ test: currentTest.name, kind: 'ok', actual: json(value) });
    },
    throws(fn, expected, message) {
        let thrown;
        try { fn(); } catch (error) { thrown = error; }
        assert.ok(thrown, message ?? 'expected the call to throw');
        if (expected instanceof RegExp) {
            assert.match(thrown.message, expected, message);
        } else if (typeof expected === 'function') {
            if (expected.prototype) assert.ok(thrown instanceof expected, message ?? 'wrong error class');
            else assert.ok(expected(thrown), message ?? 'error predicate failed');
        }
        legacyAssertions.push({
            test: currentTest.name,
            kind: 'throws',
            thrown: {
                name: thrown.name,
                message: thrown.message,
                ...(thrown.blockId === undefined ? {} : { blockId: thrown.blockId })
            }
        });
    }
};

const cache = new Map();
function load(absPath) {
    const abs = resolve(absPath);
    if (abs === resolve(parserRoot, 'evaluator.ts')) {
        return {
            evaluate() {
                evaluatorCalls += 1;
                throw new Error('Evaluation is prohibited in ast_blocks fixtures');
            }
        };
    }
    assert.ok(allowed.has(abs) || abs === testPath, `Prohibited module ${abs}`);
    if (cache.has(abs)) return cache.get(abs).exports;
    const source = readFileSync(abs, 'utf8');
    const rel = RELATIVE[abs] ?? 'ast_blocks/ast_blocks.test.ts';
    if (abs === testPath) legacyTestHash = sha256(source);
    else sources[rel] = sha256(source);
    const compiled = ts.transpileModule(source, {
        fileName: rel,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    });
    const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `${rel} does not transpile: ${errors.map((d) => d.messageText).join('; ')}`);
    if (abs !== testPath) {
        for (const match of compiled.outputText.matchAll(/require\("([^"]+)"\)/g)) {
            assert.ok(match[1].startsWith('.'), `External import prohibited: ${match[1]} (${rel})`);
        }
    }
    const mod = { exports: {} };
    cache.set(abs, mod);
    const localRequire = (id) => {
        if (id === 'node:assert/strict') return { default: recordingAssert };
        if (id === 'node:test') return { default: testStub };
        assert.ok(id.startsWith('.'), `External import prohibited: ${id}`);
        return load(resolve(dirname(abs), id.replace(/\.js$/, '.ts')));
    };
    new vm.Script(`(function(exports, require, module){\n${compiled.outputText}\n})`, { filename: rel })
        .runInContext(context, { timeout: 1000 })(mod.exports, localRequire, mod);
    return mod.exports;
}

for (const abs of Object.keys(RELATIVE)) load(abs);
assert.equal(Object.keys(sources).length, 11, 'expected exactly 11 hashed TypeScript sources');

const api = load(resolve(blocksRoot, 'index.ts'));
const validateApi = load(resolve(blocksRoot, 'validate.ts'));
const normalizeApi = load(resolve(blocksRoot, 'normalize.ts'));
const toSourceApi = load(resolve(blocksRoot, 'to_source.ts'));
const fromAstApi = load(resolve(blocksRoot, 'from_ast.ts'));
const parserApi = load(resolve(parserRoot, 'parser.ts'));
const registryApi = load(resolve(parserRoot, 'registry.ts'));
const renderApi = load(resolve(parserRoot, 'render.ts'));

// Baseline facts. The TypeScript source is the 4000-node behaviour; Rust raises
// only the validated node ceiling to 7500. Depth and command text are unchanged.
assert.equal(validateApi.MAX_BLOCK_NODES, 4000);
assert.equal(validateApi.MAX_BLOCK_DEPTH, 48);
assert.equal(api.MAX_COMMAND_TEXT, 10000);
assert.equal(typeof parserApi.parse, 'function');
assert.equal(typeof registryApi.SyntaxRegistry?.get, 'function');
assert.equal(typeof renderApi.scanSourceSegments, 'function');

// The only Math.random use in the allowed source set must be from_ast.idMaker.
const randomUsers = Object.keys(RELATIVE)
    .map((abs) => [RELATIVE[abs], readFileSync(abs, 'utf8')])
    .filter(([, text]) => text.includes('Math.random'))
    .map(([rel]) => rel);
assert.deepEqual(randomUsers, ['ast_blocks/from_ast.ts'], 'unexpected Math.random consumer');
resetIds();
const deterministicA = [fromAstApi.idMaker('t')(), fromAstApi.idMaker('u')()];
resetIds();
const deterministicB = [fromAstApi.idMaker('t')(), fromAstApi.idMaker('u')()];
assert.deepEqual(deterministicA, deterministicB, 'oracle ID factory is not deterministic');

const cases = [];
const caseNames = new Set();
const seenTags = new Set();
let caseSeq = 0;
const slug = (text) => String(text)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'empty';

function addCase({ operation, key, input, source, expected, parity = 'source-parity', approved, tags = [], description }) {
    caseSeq += 1;
    const name = `${String(caseSeq).padStart(4, '0')}-${operation}-${slug(key)}`;
    assert.ok(!caseNames.has(name), `duplicate case name ${name}`);
    caseNames.add(name);
    for (const tag of tags) seenTags.add(tag);
    cases.push({
        name,
        operation,
        input: json(input),
        source: json(source),
        expected: json(expected),
        parity,
        ...(approved ? { approved: json(approved) } : {}),
        ...(description ? { description } : {}),
        tags: [...new Set(tags)].sort()
    });
}

function capture(fn) {
    try {
        return { ok: true, value: json(fn()) };
    } catch (error) {
        return {
            ok: false,
            error: {
                name: error.name,
                message: error.message,
                ...(error.blockId === undefined ? {} : { blockId: error.blockId })
            }
        };
    }
}

function readSource(input) { resetIds(); return capture(() => api.readBlockRoot(input)); }
function compileSource(input) { resetIds(); return capture(() => api.compileBlocks(input)); }
function importSource(text) { resetIds(); return capture(() => api.importCommandText(text)); }

function expectedRead(source) {
    return source.ok ? { outcome: 'root', root: source.value } : { outcome: 'error', error: source.error };
}
function expectedCompile(source) {
    return source.ok
        ? { outcome: 'compiled', root: source.value.root, text: source.value.text }
        : { outcome: 'error', error: source.error };
}
function canonicalizeIds(value) {
    let seq = 0;
    const walk = (item) => {
        if (Array.isArray(item)) return item.map(walk);
        if (item && typeof item === 'object') {
            const out = {};
            if (typeof item.id === 'string') out.id = `n${++seq}`;
            for (const [key, child] of Object.entries(item)) {
                if (key === 'id') continue;
                out[key] = walk(child);
            }
            return out;
        }
        return item;
    };
    return walk(value);
}
function expectedImport(source) {
    return source.ok
        ? {
            outcome: 'imported',
            root: canonicalizeIds(source.value.root),
            advancedCount: source.value.advancedCount,
            canonicalization: 'import-ids'
        }
        : { outcome: 'error', error: source.error };
}

function addRead(key, input, tags = [], options = {}) {
    input = json(input);
    const source = readSource(input);
    addCase({
        operation: 'read', key, input, source,
        expected: options.expected ?? expectedRead(source),
        parity: options.parity, approved: options.approved, tags,
        description: options.description
    });
}
function addCompile(key, input, tags = [], options = {}) {
    input = json(input);
    const source = compileSource(input);
    addCase({
        operation: 'compile', key, input, source,
        expected: options.expected ?? expectedCompile(source),
        parity: options.parity, approved: options.approved, tags,
        description: options.description
    });
}
function addImport(key, text, tags = [], options = {}) {
    const source = importSource(text);
    addCase({
        operation: 'import', key, input: { text }, source,
        expected: options.expected ?? expectedImport(source),
        parity: options.parity, approved: options.approved, tags,
        description: options.description
    });
}

// ---------------------------------------------------------------------------
// Deterministic tree builders (oracle input, exact supplied ids).
// ---------------------------------------------------------------------------
let idSeq = 0;
const nid = (prefix = 'u') => `${prefix}${++idSeq}`;
const lit = (value = '') => ({ id: nid('l'), type: 'literal', value });
const raw = (source = '$(x)') => ({ id: nid('r'), type: 'raw', source });
const fn = (name = 'say', args = []) => ({ id: nid('f'), type: 'function', name, args });
const cmd = (commandName = 'so', args = []) => ({ id: nid('c'), type: 'commandRef', commandName, args });
const getVar = (name = 'v', storage = 'memory', extra = {}) => ({ id: nid('g'), type: 'getVar', name, storage, ...extra });
const setVar = (name = 'v', value = lit('1'), storage = 'memory', extra = {}) => ({ id: nid('s'), type: 'setVar', name, storage, value, ...extra });
const exists = (name = 'v', storage = 'memory', extra = {}) => ({ id: nid('e'), type: 'exists', name, storage, ...extra });
const delVar = (name = 'v', storage = 'memory', extra = {}) => ({ id: nid('d'), type: 'deleteVar', name, storage, ...extra });
const binary = (left, operator, right) => ({ id: nid('b'), type: 'binary', operator, left, right });
const unary = (operator, argument) => ({ id: nid('n'), type: 'unary', operator, argument });
const ternary = (test, consequent, alternate) => ({ id: nid('t'), type: 'ternary', test, consequent, alternate });
const template = (...parts) => ({ id: nid('tp'), type: 'template', parts });
const arrayLit = (items = [], accessor) => ({ id: nid('a'), type: 'arrayLiteral', items, ...(accessor === undefined ? {} : { accessor }) });
const loopVar = (name = 'i') => ({ id: nid('lv'), type: 'loopVar', name });
const loopAssign = (name, operator, value) => ({ id: nid('la'), type: 'loopAssign', name, operator, ...(value === undefined ? {} : { value }) });
const forLoop = (fields) => ({ id: nid('fl'), type: 'forLoop', ...fields });
const group = (...children) => ({ id: nid('grp'), type: 'group', children });
const root = (...children) => ({ id: nid('root'), type: 'root', children });

const STORAGES = ['memory', 'cache', 'cacheUser', 'db', 'dbUser'];
const BINARY_OPS = ['+', '-', '*', '/', '%', '==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>'];
const UNARY_OPS = ['+', '-'];
const LOOP_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '++', '--'];
const ACCESSOR_TYPES = ['array', 'append', 'random', 'length', 'clear', 'index', 'setIndex', 'remove'];
const ACCESSOR_NODES = new Set(['index', 'setIndex', 'remove']);
const accessor = (type) => (ACCESSOR_NODES.has(type) ? { type, index: lit('0') } : { type });
const unaryChain = (count, leaf = 'x') => {
    let node = lit(leaf);
    for (let i = 0; i < count; i += 1) node = unary('+', node);
    return node;
};

function countNodes(value) {
    let count = 0;
    const walk = (item) => {
        if (Array.isArray(item)) return item.forEach(walk);
        if (!item || typeof item !== 'object') return;
        if (typeof item.id === 'string' && typeof item.type === 'string' && item.type !== 'root') count += 1;
        for (const [key, child] of Object.entries(item)) if (key !== 'id') walk(child);
    };
    walk(value);
    return count;
}

// ---------------------------------------------------------------------------
// read: valid 17 node kinds + root, unknown fields, ids, names, limits.
// ---------------------------------------------------------------------------
addRead('root-empty', root(), ['type:root']);
addRead('root-unknown-fields', { ...root(), extra: true }, ['type:root', 'unknown-fields']);
addRead('literal-basic', root(lit('hello world')), ['type:literal']);
addRead('literal-unknown-field', root({ ...lit('x'), extra: 1 }), ['type:literal', 'unknown-fields']);
addRead('literal-missing-value-defaults-empty', root({ id: 'lv1', type: 'literal' }), ['type:literal', 'defaults']);
addRead('literal-null-value-defaults-empty', root({ id: 'lv2', type: 'literal', value: null }), ['type:literal', 'defaults']);
addRead('literal-number-value-rejected', root({ id: 'lv3', type: 'literal', value: 1 }), ['type:literal', 'malformed']);
addRead('literal-length-10000', root(lit('x'.repeat(10000))), ['type:literal', 'limit:10000']);
addRead('literal-length-10001', root(lit('x'.repeat(10001))), ['type:literal', 'limit:10001']);
addRead('raw-root', root(raw('$(foo)')), ['type:raw']);
addRead('raw-nested-rejected', root(fn('say', [raw('$(foo)')])), ['type:raw', 'raw-not-top-level']);
addRead('raw-missing-source', root({ id: 'raw-missing', type: 'raw' }), ['type:raw', 'malformed']);
addRead('raw-length-10001', root(raw('x'.repeat(10001))), ['type:raw', 'limit:10001']);
addRead('function-basic', root(fn('say', [lit('hi'), lit('there')])), ['type:function']);
addRead('function-no-args', root({ ...fn('user'), args: undefined }), ['type:function', 'defaults']);
addRead('function-args-null', root({ ...fn('user'), args: null }), ['type:function', 'defaults']);
addRead('function-args-not-array', root({ ...fn('user'), args: 'x' }), ['type:function', 'malformed']);
addRead('function-name-missing', root({ id: 'fmiss', type: 'function', args: [] }), ['type:function', 'malformed']);
addRead('function-name-80', root(fn('a'.repeat(80))), ['type:function', 'limit:80']);
addRead('function-name-81', root(fn('a'.repeat(81))), ['type:function', 'limit:81']);
addRead('command-ref-basic', root(cmd('so', [lit('raid')])), ['type:commandRef']);
addRead('command-ref-bang-stripped', root(cmd('!so')), ['type:commandRef', 'bang']);
addRead('command-ref-double-bang', root(cmd('!!so')), ['type:commandRef', 'bang']);
addRead('command-ref-length-60', root(cmd('a'.repeat(60))), ['type:commandRef', 'limit:60']);
addRead('command-ref-length-61', root(cmd('a'.repeat(61))), ['type:commandRef', 'limit:61']);
addRead('command-ref-bang-plus-59-length-60', root(cmd(`!${'a'.repeat(59)}`)),
    ['type:commandRef', 'bang', 'command:cap-before-strip', 'limit:60']);
addRead('command-ref-bang-plus-60-length-61', root(cmd(`!${'a'.repeat(60)}`)),
    ['type:commandRef', 'bang', 'command:cap-before-strip', 'limit:61']);
addRead('command-ref-trailing-lf-pushes-over', root(cmd(`${'a'.repeat(60)}\n`)),
    ['type:commandRef', 'command:cap-before-strip', 'limit:61', 'anchor:absolute', 'terminator:LF']);
addRead('command-ref-whitespace-0085', root(cmd('a\u0085b')), ['type:commandRef', 'whitespace:0085']);
addRead('command-ref-nbsp', root(cmd('a\u00a0b')), ['type:commandRef', 'whitespace:nbsp']);
addRead('command-ref-parenthesis', root(cmd('a(b')), ['type:commandRef', 'malformed']);
addRead('command-ref-quote', root(cmd('a"b')), ['type:commandRef', 'malformed']);
for (const storage of STORAGES) {
    addRead(`getvar-${storage}`, root(getVar('points', storage)), ['type:getVar', `storage:${storage}`]);
    addRead(`exists-${storage}`, root(exists('points', storage)), ['type:exists', `storage:${storage}`]);
    addRead(`deletevar-${storage}`, root(delVar('points', storage, { accessor: { type: 'clear' } })), ['type:deleteVar', `storage:${storage}`, 'accessor:clear']);
    addRead(`setvar-${storage}`, root(setVar('points', lit('1'), storage)), ['type:setVar', `storage:${storage}`]);
}
for (const type of ['array', 'index', 'random', 'length']) {
    addRead(`getvar-accessor-${type}`, root(getVar('list', 'memory', { accessor: accessor(type) })),
        ['type:getVar', `accessor:${type}`]);
    addRead(`exists-accessor-${type}`, root(exists('list', 'memory', { accessor: accessor(type) })),
        ['type:exists', `accessor:${type}`]);
}
for (const type of ['clear', 'remove']) {
    addRead(`deletevar-accessor-${type}`, root(delVar('list', 'memory', { accessor: accessor(type) })),
        ['type:deleteVar', `accessor:${type}`]);
}
for (const type of ['append', 'setIndex']) {
    addRead(`setvar-accessor-${type}`, root(setVar('list', lit('1'), 'memory', { accessor: accessor(type) })),
        ['type:setVar', `accessor:${type}`]);
}
for (const type of ['index', 'random', 'length']) {
    addRead(`array-accessor-${type}`, root(arrayLit([lit('1')], accessor(type))),
        ['type:arrayLiteral', `accessor:${type}`]);
}
addRead('getvar-accessor-invalid', root(getVar('v', 'memory', { accessor: { type: 'append' } })),
    ['type:getVar', 'accessor:invalid']);
addRead('deletevar-accessor-invalid', root(delVar('v', 'memory', { accessor: { type: 'array' } })),
    ['type:deleteVar', 'accessor:invalid']);
addRead('setvar-accessor-invalid', root(setVar('v', lit('1'), 'memory', { accessor: { type: 'array' } })),
    ['type:setVar', 'accessor:invalid']);
addRead('accessor-missing-index', root(getVar('v', 'memory', { accessor: { type: 'index' } })),
    ['type:getVar', 'accessor:index', 'malformed']);
addRead('getvar-selector-dropped-memory', root(getVar('v', 'memory', { userSelector: { id: 'sel-bad', type: 'nope' } })),
    ['type:getVar', 'selector:dropped']);
addRead('getvar-selector-cacheuser', root(getVar('v', 'cacheUser', { userSelector: fn('touser') })),
    ['type:getVar', 'selector:cacheUser']);
addRead('getvar-selector-dbuser', root(getVar('v', 'dbUser', { userSelector: fn('touser') })),
    ['type:getVar', 'selector:dbUser']);
addRead('getvar-selector-dbuser-invalid', root(getVar('v', 'dbUser', { userSelector: { id: 'sel-bad2', type: 'nope' } })),
    ['type:getVar', 'selector:dbUser', 'malformed']);
for (const operator of BINARY_OPS) {
    addRead(`binary-${operator}`, root(binary(lit('1'), operator, lit('2'))),
        ['type:binary', `binary:${operator}`]);
}
addRead('binary-invalid-operator', root(binary(lit('1'), '&&', lit('2'))), ['type:binary', 'malformed']);
addRead('binary-missing-left', root({ id: 'bmiss', type: 'binary', operator: '+', right: lit('1') }),
    ['type:binary', 'malformed']);
addRead('binary-null-right', root({ ...binary(lit('1'), '+', lit('2')), right: null }),
    ['type:binary', 'malformed']);
for (const operator of UNARY_OPS) {
    addRead(`unary-${operator}`, root(unary(operator, lit('1'))), ['type:unary', `unary:${operator}`]);
}
addRead('unary-invalid-operator', root(unary('!', lit('1'))), ['type:unary', 'malformed']);
addRead('ternary-basic', root(ternary(lit('1'), lit('2'), lit('3'))), ['type:ternary']);
addRead('ternary-empty-branches', root(ternary(lit('1'), null, null)),
    ['type:ternary', 'ternary:empty', 'synthetic-children']);
addRead('ternary-missing-test', root({ id: 'tmiss', type: 'ternary', consequent: null, alternate: null }),
    ['type:ternary', 'malformed']);
addRead('template-basic', root(template(lit('hi '), fn('user'))), ['type:template']);
addRead('template-missing-parts', root({ id: 'tpmiss', type: 'template' }), ['type:template', 'defaults']);
addRead('template-parts-null', root({ ...template(), parts: null }), ['type:template', 'defaults']);
addRead('array-literal-basic', root(arrayLit([lit('1'), lit('two words')])), ['type:arrayLiteral']);
addRead('array-literal-missing-items', root({ id: 'amiss', type: 'arrayLiteral' }),
    ['type:arrayLiteral', 'defaults']);
for (const operator of LOOP_OPS) {
    addRead(`loopassign-${operator}`, root(loopAssign('i', operator, ['++', '--'].includes(operator) ? undefined : lit('1'))),
        ['type:loopAssign', `loopOp:${operator}`]);
}
addRead('loopassign-increment-ignores-value', root(loopAssign('i', '++', fn('say'))),
    ['type:loopAssign', 'loopOp:++']);
addRead('loopassign-invalid-operator', root(loopAssign('i', '**', lit('1'))),
    ['type:loopAssign', 'malformed']);
addRead('loopvar-basic', root(loopVar('i')), ['type:loopVar']);
addRead('loopvar-length-32', root(loopVar('a'.repeat(32))), ['type:loopVar', 'limit:32']);
addRead('loopvar-length-33', root(loopVar('a'.repeat(33))), ['type:loopVar', 'limit:33']);
addRead('forloop-range', root(forLoop({
    loopVar: 'i', mode: 'range',
    init: loopAssign('i', '=', lit('0')),
    condition: binary(loopVar('i'), '<', lit('3')),
    update: loopAssign('i', '++'),
    body: [fn('say', [lit('ping'), loopVar('i')])]
})), ['type:forLoop', 'mode:range']);
addRead('forloop-foreach', root(forLoop({
    loopVar: 'x', mode: 'foreach', iterable: getVar('list', 'memory', { accessor: { type: 'array' } }), body: [fn('say', [loopVar('x')])]
})), ['type:forLoop', 'mode:foreach']);
addRead('forloop-foreach-ignores-range-fields', root(forLoop({
    loopVar: 'x', mode: 'foreach', iterable: getVar('list', 'memory', { accessor: { type: 'array' } }),
    init: lit('ignored'), condition: lit('ignored'), update: lit('ignored'), body: []
})), ['type:forLoop', 'mode:foreach', 'optional-fields']);
addRead('forloop-invalid-mode', root(forLoop({
    loopVar: 'i', mode: 'while', init: lit('1'), condition: lit('1'), update: lit('1'), body: []
})), ['type:forLoop', 'malformed']);
addRead('group-basic', root(group(lit('a'), fn('user'), lit('b'))), ['type:group']);
addRead('group-missing-children', root({ id: 'grmiss', type: 'group' }), ['type:group', 'defaults']);
addRead('unknown-type', root({ id: 'uunknown', type: 'nope' }), ['malformed']);
addRead('broken-block', root(null), ['malformed']);

// IDs: preserve valid, repair invalid/duplicates with s+base36 exactly.
for (const [label, id] of [
    ['valid-1', 'a'], ['valid-hyphen', 'a-b'], ['valid-underscore', '_'],
    ['valid-64', 'a'.repeat(64)], ['invalid-65', 'a'.repeat(65)],
    ['invalid-unicode', 'é'], ['invalid-space', 'a b'], ['invalid-dollar', '$x'],
    ['invalid-newline', 'a\n'], ['invalid-astral', '𐐀']
]) {
    addRead(`id-${label}`, root({ id, type: 'literal', value: 'x' }), ['ids', `id:${label}`]);
}
addRead('id-root-missing', { type: 'root', children: [lit('x')] }, ['ids', 'id:missing']);
addRead('id-child-missing', { id: 'r', type: 'root', children: [{ type: 'literal', value: 'x' }] }, ['ids', 'id:missing']);
addRead('id-duplicates', {
    id: 'same', type: 'root',
    children: [{ id: 'same', type: 'literal', value: 'a' }, { id: 'same', type: 'function', name: 'user', args: [] }]
}, ['ids', 'id:duplicate']);
addRead('id-repair-skips-taken-s1', {
    id: 'dup', type: 'root',
    children: [{ id: 's1', type: 'literal', value: 'a' }, { id: 'dup', type: 'literal', value: 'b' }]
}, ['ids', 'id:collision']);

// Names: Unicode L/N and UTF-16 length, probed from the real engine.
for (const [label, name] of [
    ['ascii', 'abc'], ['leading-digit', '123'], ['underscore', '_x'], ['accented', 'é'],
    ['greek', 'Ω'], ['astral-letter', '𐐀'], ['astral-digit', '𝟘'],
    ['combining-0345', '\u0345'], ['nbsp', '\u00a0'], ['space', 'a b'],
    ['length-64', 'a'.repeat(64)], ['length-65', 'a'.repeat(65)],
    ['astral-32', '𐐀'.repeat(32)], ['astral-33', '𐐀'.repeat(33)]
]) {
    addRead(`varname-${label}`, root(getVar(name)), ['names', 'names:var', `varname:${label}`]);
}
for (const [label, name] of [
    ['ascii', 'i'], ['underscore', '_i'], ['digit-start', '1i'], ['unicode', 'é'],
    ['length-32', 'a'.repeat(32)], ['length-33', 'a'.repeat(33)]
]) {
    addRead(`loopname-${label}`, root(loopVar(name)), ['names', 'names:loop', `loopname:${label}`]);
}
for (const [label, name] of [
    ['ascii', 'say'], ['dots', 'a.b.c'], ['underscore', '_x'], ['hyphen', 'a-b'],
    ['unicode', 'é'], ['empty', ''], ['length-80', 'a'.repeat(80)], ['length-81', 'a'.repeat(81)]
]) {
    addRead(`functionname-${label}`, root(fn(name)), ['names', 'names:function', `functionname:${label}`]);
}

// JS anchors are probed, not assumed. Each ID/var/loop/function `$`-anchored
// regex is tested with a final LF, CR, LS and PS; all reject in this engine.
const TERMINATORS = { LF: '\n', CR: '\r', LS: '\u2028', PS: '\u2029' };
for (const [label, terminator] of Object.entries(TERMINATORS)) {
    addRead(`anchor-id-${label}`, root({ id: `abc${terminator}`, type: 'literal', value: 'x' }),
        ['ids', 'anchor:absolute', `terminator:${label}`]);
    addRead(`anchor-var-${label}`, root(getVar(`abc${terminator}`)),
        ['names', 'names:var', 'anchor:absolute', `terminator:${label}`]);
    addRead(`anchor-loop-${label}`, root(loopVar(`i${terminator}`)),
        ['names', 'names:loop', 'anchor:absolute', `terminator:${label}`]);
    addRead(`anchor-function-${label}`, root(fn(`say${terminator}`)),
        ['names', 'names:function', 'anchor:absolute', `terminator:${label}`]);
    addRead(`anchor-command-${label}`, root(cmd(`so${terminator}`)),
        ['names', 'names:command', 'anchor:absolute', `terminator:${label}`]);
}

// Depth: 47 unary wrappers put the leaf at depth 48 (accept); 48 put it at 49.
addRead('depth-47-accepts', root(unaryChain(47)), ['depth', 'depth:48']);
addRead('depth-48-rejects', root(unaryChain(48)), ['depth', 'depth:49']);
addRead('depth-group-47', root(group(unaryChain(46))), ['depth', 'depth:48']);
addRead('depth-group-48', root(group(unaryChain(47))), ['depth', 'depth:49']);

// ---------------------------------------------------------------------------
// read: malformed required fields, nesting rules, selectors, per-type ids.
// ---------------------------------------------------------------------------
const malformedRead = [
    ['function-missing-name', { id: 'mr-fn1', type: 'function', args: [] }],
    ['function-null-name', { id: 'mr-fn2', type: 'function', name: null, args: [] }],
    ['function-args-object', { id: 'mr-fn3', type: 'function', name: 'say', args: {} }],
    ['command-ref-missing-name', { id: 'mr-cr1', type: 'commandRef', args: [] }],
    ['command-ref-null-name', { id: 'mr-cr2', type: 'commandRef', commandName: null, args: [] }],
    ['getvar-missing-name', { id: 'mr-gv1', type: 'getVar', storage: 'memory' }],
    ['getvar-null-name', { id: 'mr-gv2', type: 'getVar', name: null, storage: 'memory' }],
    ['getvar-missing-storage', { id: 'mr-gv3', type: 'getVar', name: 'v' }],
    ['getvar-invalid-storage', { id: 'mr-gv4', type: 'getVar', name: 'v', storage: 'disk' }],
    ['exists-missing-storage', { id: 'mr-ex1', type: 'exists', name: 'v' }],
    ['deletevar-number-name', { id: 'mr-dv1', type: 'deleteVar', name: 7, storage: 'memory' }],
    ['setvar-missing-value', { id: 'mr-sv1', type: 'setVar', name: 'v', storage: 'memory' }],
    ['setvar-null-value', { id: 'mr-sv2', type: 'setVar', name: 'v', storage: 'memory', value: null }],
    ['setvar-number-value', { id: 'mr-sv3', type: 'setVar', name: 'v', storage: 'memory', value: 1 }],
    ['binary-missing-operator', { id: 'mr-bi1', type: 'binary', left: { id: 'mr-bi1l', type: 'literal', value: '1' }, right: { id: 'mr-bi1r', type: 'literal', value: '2' } }],
    ['binary-null-operator', { id: 'mr-bi2', type: 'binary', operator: null, left: { id: 'mr-bi2l', type: 'literal', value: '1' }, right: { id: 'mr-bi2r', type: 'literal', value: '2' } }],
    ['binary-missing-left', { id: 'mr-bi3', type: 'binary', operator: '+', right: { id: 'mr-bi3r', type: 'literal', value: '2' } }],
    ['binary-missing-right', { id: 'mr-bi4', type: 'binary', operator: '+', left: { id: 'mr-bi4l', type: 'literal', value: '1' } }],
    ['unary-missing-operator', { id: 'mr-un1', type: 'unary', argument: { id: 'mr-un1a', type: 'literal', value: '1' } }],
    ['unary-missing-argument', { id: 'mr-un2', type: 'unary', operator: '+' }],
    ['unary-null-argument', { id: 'mr-un3', type: 'unary', operator: '+', argument: null }],
    ['ternary-missing-test', { id: 'mr-te1', type: 'ternary', consequent: null, alternate: null }],
    ['template-parts-object', { id: 'mr-tp1', type: 'template', parts: {} }],
    ['array-items-object', { id: 'mr-ar1', type: 'arrayLiteral', items: {} }],
    ['loopvar-missing-name', { id: 'mr-lv1', type: 'loopVar' }],
    ['loopvar-null-name', { id: 'mr-lv2', type: 'loopVar', name: null }],
    ['loopassign-missing-operator', { id: 'mr-la1', type: 'loopAssign', name: 'i' }],
    ['loopassign-missing-value', { id: 'mr-la2', type: 'loopAssign', name: 'i', operator: '=' }],
    ['forloop-missing-loopvar', { id: 'mr-fl1', type: 'forLoop', mode: 'range', init: { id: 'mr-fl1a', type: 'literal', value: '0' }, condition: { id: 'mr-fl1b', type: 'literal', value: '1' }, update: { id: 'mr-fl1c', type: 'literal', value: '1' }, body: [] }],
    ['forloop-missing-mode', { id: 'mr-fl2', type: 'forLoop', loopVar: 'i', init: { id: 'mr-fl2a', type: 'literal', value: '0' }, condition: { id: 'mr-fl2b', type: 'literal', value: '1' }, update: { id: 'mr-fl2c', type: 'literal', value: '1' }, body: [] }],
    ['forloop-missing-init', { id: 'mr-fl3', type: 'forLoop', loopVar: 'i', mode: 'range', condition: { id: 'mr-fl3b', type: 'literal', value: '1' }, update: { id: 'mr-fl3c', type: 'literal', value: '1' }, body: [] }],
    ['forloop-missing-condition', { id: 'mr-fl4', type: 'forLoop', loopVar: 'i', mode: 'range', init: { id: 'mr-fl4a', type: 'literal', value: '0' }, update: { id: 'mr-fl4c', type: 'literal', value: '1' }, body: [] }],
    ['forloop-missing-update', { id: 'mr-fl5', type: 'forLoop', loopVar: 'i', mode: 'range', init: { id: 'mr-fl5a', type: 'literal', value: '0' }, condition: { id: 'mr-fl5b', type: 'literal', value: '1' }, body: [] }],
    ['forloop-foreach-missing-iterable', { id: 'mr-fl6', type: 'forLoop', loopVar: 'x', mode: 'foreach', body: [] }],
    ['group-children-object', { id: 'mr-gr1', type: 'group', children: {} }],
    ['literal-value-object', { id: 'mr-li1', type: 'literal', value: {} }],
    ['root-children-object', { id: 'mr-root1', type: 'root', children: {} }]
];
for (const [label, node] of malformedRead) {
    addRead(`malformed-${label}`, root(node), ['malformed', `malformed:${label}`]);
}
addRead('nested-raw-in-group-rejected', root(group(raw('$(x)'))), ['type:raw', 'raw-not-top-level', 'type:group']);
addRead('nested-raw-in-template-rejected', root(template(raw('$(x)'))), ['type:raw', 'raw-not-top-level', 'type:template']);
addRead('nested-raw-in-array-rejected', root(arrayLit([raw('$(x)')])), ['type:raw', 'raw-not-top-level', 'type:arrayLiteral']);
for (const type of ['exists', 'setVar', 'deleteVar']) {
    const node = type === 'setVar'
        ? setVar('v', lit('1'), 'dbUser', { userSelector: fn('touser') })
        : (type === 'exists' ? exists('v', 'dbUser', { userSelector: fn('touser') }) : delVar('v', 'dbUser', { userSelector: fn('touser'), accessor: { type: 'clear' } }));
    addRead(`selector-${type}-dbuser`, root(node), ['selector:dbUser', `type:${type}`]);
}
addRead('selector-setvar-memory-dropped', root(setVar('v', lit('1'), 'memory', { userSelector: { id: 'bad-sel', type: 'nope' } })),
    ['selector:dropped', 'type:setVar']);

// Per-type id repair and unknown-field dropping.
const sampleByType = {
    literal: () => ({ id: 'sample-literal', type: 'literal', value: 'x' }),
    raw: () => ({ id: 'sample-raw', type: 'raw', source: '$(x)' }),
    function: () => ({ id: 'sample-function', type: 'function', name: 'say', args: [] }),
    commandRef: () => ({ id: 'sample-commandRef', type: 'commandRef', commandName: 'so', args: [] }),
    getVar: () => ({ id: 'sample-getVar', type: 'getVar', name: 'v', storage: 'memory' }),
    setVar: () => ({ id: 'sample-setVar', type: 'setVar', name: 'v', storage: 'memory', value: { id: 'sample-setVar-v', type: 'literal', value: '1' } }),
    exists: () => ({ id: 'sample-exists', type: 'exists', name: 'v', storage: 'memory' }),
    deleteVar: () => ({ id: 'sample-deleteVar', type: 'deleteVar', name: 'v', storage: 'memory' }),
    binary: () => ({ id: 'sample-binary', type: 'binary', operator: '+', left: { id: 'sample-binary-l', type: 'literal', value: '1' }, right: { id: 'sample-binary-r', type: 'literal', value: '2' } }),
    unary: () => ({ id: 'sample-unary', type: 'unary', operator: '+', argument: { id: 'sample-unary-a', type: 'literal', value: '1' } }),
    ternary: () => ({ id: 'sample-ternary', type: 'ternary', test: { id: 'sample-ternary-t', type: 'literal', value: '1' }, consequent: { id: 'sample-ternary-c', type: 'literal', value: '2' }, alternate: { id: 'sample-ternary-a', type: 'literal', value: '3' } }),
    template: () => ({ id: 'sample-template', type: 'template', parts: [{ id: 'sample-template-p', type: 'literal', value: 'x' }] }),
    arrayLiteral: () => ({ id: 'sample-arrayLiteral', type: 'arrayLiteral', items: [{ id: 'sample-arrayLiteral-i', type: 'literal', value: '1' }] }),
    loopVar: () => ({ id: 'sample-loopVar', type: 'loopVar', name: 'i' }),
    loopAssign: () => ({ id: 'sample-loopAssign', type: 'loopAssign', name: 'i', operator: '++' }),
    forLoop: () => ({ id: 'sample-forLoop', type: 'forLoop', loopVar: 'i', mode: 'range', init: { id: 'sample-forLoop-i', type: 'literal', value: '0' }, condition: { id: 'sample-forLoop-c', type: 'literal', value: '1' }, update: { id: 'sample-forLoop-u', type: 'literal', value: '1' }, body: [] }),
    group: () => ({ id: 'sample-group', type: 'group', children: [{ id: 'sample-group-c', type: 'literal', value: 'x' }] })
};
for (const [type, build] of Object.entries(sampleByType)) {
    addRead(`id65-${type}`, root({ ...build(), id: 'x'.repeat(65) }), ['ids', 'id:65', `type:${type}`]);
    addRead(`unknown-field-${type}`, root({ ...build(), unknown: { nested: true } }), ['unknown-fields', `type:${type}`]);
}
function specNodeCount(spec) {
    let count = spec.literals;
    if (spec.tail === 'getVarIndex') count += 2;
    if (spec.tail === 'emptyTernary') count += 1 + 1 + 2;
    return count;
}
function materializeTreeSpec(spec) {
    const children = [];
    for (let i = 1; i <= spec.literals; i += 1) children.push({ id: `g${i}`, type: 'literal', value: '' });
    if (spec.tail === 'getVarIndex') {
        const base = spec.literals;
        children.push({
            id: `g${base + 1}`, type: 'getVar', name: 'v', storage: 'memory',
            accessor: { type: 'index', index: { id: `g${base + 2}`, type: 'literal', value: '0' } }
        });
    }
    if (spec.tail === 'emptyTernary') {
        children.push({
            id: `g${spec.literals + 1}`, type: 'ternary',
            test: { id: `g${spec.literals + 2}`, type: 'literal', value: '1' },
            consequent: null, alternate: null
        });
    }
    return { id: 'g-root', type: 'root', children };
}
function addQuotaRead(key, spec, options = {}) {
    const nodes = specNodeCount(spec);
    const input = { treeSpec: 'flat-nodes', ...spec };
    let source;
    if (nodes <= 4001) {
        resetIds();
        const actual = capture(() => api.readBlockRoot(materializeTreeSpec(spec)));
        source = {
            summary: true, materialized: true, validatedNodes: nodes,
            outcome: actual.ok ? 'accepted' : 'error',
            ...(actual.ok ? {} : { error: actual.error })
        };
        if (actual.ok) assert.equal(countNodes(actual.value), nodes, `spec/node count drift for ${key}`);
    } else {
        source = {
            summary: true, materialized: false, validatedNodes: nodes,
            reason: 'TypeScript MAX_BLOCK_NODES=4000; tree not materialized'
        };
    }
    const accepted = nodes <= 7500;
    addCase({
        operation: 'read',
        key,
        input,
        source,
        expected: accepted
            ? { outcome: 'accepted', validatedNodes: nodes }
            : { outcome: 'error', error: { name: 'Error', message: 'Too many blocks (limit 7500).' } },
        parity: nodes <= 4000 ? 'source-parity' : 'approved-node-limit',
        approved: nodes > 4000 ? {
            item: 'limits',
            change: 'MAX_BLOCK_NODES 4000 -> 7500',
            sourceLimit: 4000,
            rustLimit: 7500
        } : undefined,
        tags: ['quota', `nodes:${nodes}`, ...(options.tags ?? [])],
        description: options.description
    });
}
for (const nodes of [4000, 4001, 5000, 7499, 7500, 7501]) {
    addQuotaRead(`literals-${nodes}`, { literals: nodes, tail: 'none' },
        { description: `${nodes} literal root children; the root is excluded.` });
}
addQuotaRead('accessor-wrapper-7500', { literals: 7498, tail: 'getVarIndex' },
    { tags: ['accessor:index'], description: 'getVar plus its index node = 7500; the accessor wrapper is not a node.' });
addQuotaRead('accessor-wrapper-7501', { literals: 7499, tail: 'getVarIndex' },
    { tags: ['accessor:index'], description: 'getVar plus its index node = 7501 and rejects.' });
addQuotaRead('synthetic-ternary-7500', { literals: 7496, tail: 'emptyTernary' },
    { tags: ['ternary:empty', 'synthetic-children'], description: '7496 literals + ternary + test + two synthetic empty children = 7500.' });
addQuotaRead('synthetic-ternary-7501', { literals: 7497, tail: 'emptyTernary' },
    { tags: ['ternary:empty', 'synthetic-children'], description: 'Synthetic empty ternary children push this to 7501.' });
addQuotaRead('synthetic-ternary-source-4000', { literals: 3996, tail: 'emptyTernary' },
    { tags: ['ternary:empty', 'synthetic-children'], description: 'Source-scale proof that synthetic children count: exactly 4000.' });
addQuotaRead('synthetic-ternary-source-4001', { literals: 3997, tail: 'emptyTernary' },
    { tags: ['ternary:empty', 'synthetic-children'], description: 'Source rejects at 4001; approved Rust limit accepts 4001.' });
addQuotaRead('root-excluded-4001', { literals: 4001, tail: 'none' },
    { description: 'Root is excluded: 4001 children reject under source, accept under 7500.' });

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------
function addNormalize(key, node, tags = []) {
    node = json(node);
    resetIds();
    const source = capture(() => normalizeApi.normalizeValue(node));
    addCase({
        operation: 'normalize', key, input: { scope: 'value', node }, source,
        expected: source.ok ? { outcome: 'root', root: source.value } : { outcome: 'error', error: source.error },
        tags: ['normalize:value', ...tags]
    });
}
function addNormalizeRoot(key, input, tags = []) {
    input = json(input);
    resetIds();
    const source = capture(() => normalizeApi.normalizeRoot(input));
    addCase({
        operation: 'normalize', key, input: { scope: 'root', root: input }, source,
        expected: source.ok ? { outcome: 'root', root: source.value } : { outcome: 'error', error: source.error },
        tags: ['normalize:root', ...tags]
    });
}
addNormalizeRoot('root-flattens-groups', root(lit('a'), group(lit('b'), fn('user')), lit('c')), ['type:group']);
addNormalizeRoot('root-flattens-templates', root(template(lit('a'), fn('user')), lit('b')), ['type:template']);
addNormalizeRoot('root-merges-literals', root(lit('a'), lit('b'), lit('')), ['merge']);
addNormalizeRoot('root-drops-empty-literals', root(lit(''), lit(''), fn('user')), ['merge']);
addNormalizeRoot('root-keeps-raw', root(raw('$(x)'), lit(' tail')), ['type:raw']);
addNormalizeRoot('root-empty', root(), ['empty']);
addNormalize('value-literal', lit('hi'), ['type:literal']);
addNormalize('value-raw', raw('$(x)'), ['type:raw']);
addNormalize('value-group-becomes-template', group(lit('hi '), fn('user')), ['type:group', 'type:template']);
addNormalize('value-template-all-literal-becomes-literal', template(lit('a'), lit('b')), ['type:template', 'merge']);
addNormalize('value-template-empty-becomes-literal', template(), ['type:template', 'empty']);
addNormalize('value-template-mixed', template(lit('hi '), fn('user'), lit('!')), ['type:template', 'type:function']);
addNormalize('value-template-nested-groups', template(group(lit('a')), group(lit('b'))), ['type:template', 'type:group', 'merge']);
addNormalize('value-function', fn('say', [group(lit('a'), lit('b'))]), ['type:function']);
addNormalize('value-command-ref', cmd('so', [group(lit('a'), fn('user'))]), ['type:commandRef']);
addNormalize('value-getvar-selector', getVar('v', 'dbUser', { userSelector: group(fn('touser')), accessor: { type: 'index', index: group(lit('0')) } }),
    ['type:getVar', 'selector:dbUser', 'accessor:index']);
addNormalize('value-exists-accessor', exists('v', 'memory', { accessor: { type: 'length' } }), ['type:exists', 'accessor:length']);
addNormalize('value-deletevar-accessor', delVar('v', 'memory', { accessor: { type: 'remove', index: group(lit('0')) } }),
    ['type:deleteVar', 'accessor:remove']);
addNormalize('value-setvar', setVar('v', group(lit('1')), 'db', { accessor: { type: 'append' } }),
    ['type:setVar', 'accessor:append']);
addNormalize('value-binary', binary(group(lit('1')), '+', group(lit('2'))), ['type:binary']);
addNormalize('value-unary', unary('-', group(lit('1'))), ['type:unary']);
addNormalize('value-ternary', ternary(group(lit('1')), group(lit('2')), group(lit('3'))), ['type:ternary']);
addNormalize('value-array-literal', arrayLit([group(lit('a')), group(lit('b'))], { type: 'index', index: group(lit('0')) }),
    ['type:arrayLiteral', 'accessor:index']);
addNormalize('value-loopvar', loopVar('i'), ['type:loopVar']);
addNormalize('value-loopassign', loopAssign('i', '=', group(lit('1'))), ['type:loopAssign']);
addNormalize('value-loopassign-increment', loopAssign('i', '++'), ['type:loopAssign', 'loopOp:++']);
addNormalize('value-forloop-body-group', forLoop({
    loopVar: 'i', mode: 'range', init: group(lit('0')), condition: group(lit('1')), update: group(loopAssign('i', '++')),
    body: [group(fn('say', [lit('a')]), lit('b'))]
}), ['type:forLoop', 'type:group', 'mode:range']);
addNormalize('value-forloop-foreach', forLoop({
    loopVar: 'x', mode: 'foreach', iterable: group(getVar('list', 'memory', { accessor: { type: 'array' } })), body: []
}), ['type:forLoop', 'mode:foreach']);

// ---------------------------------------------------------------------------
// compile: every block kind, operators, escaping, limits, errors.
// ---------------------------------------------------------------------------
addCompile('plain-text', root(lit('Hello '), fn('user'), lit('! :) welcome   back')), ['text']);
addCompile('empty-root', root(), ['empty']);
addCompile('literal-start-token-dollar', root(lit('type $(user) to see')), ['escaping', 'token:$(']);
addCompile('literal-start-token-percent', root(lit('%del(x)')), ['escaping', 'token:%del(']);
addCompile('literal-start-token-star', root(lit('*(x)')), ['escaping', 'token:*(']);
addCompile('literal-start-token-caret', root(lit('^(x)')), ['escaping', 'token:^(']);
addCompile('literal-start-token-hash', root(lit('#(x)')), ['escaping', 'token:#(']);
addCompile('literal-start-token-percent-paren', root(lit('%(x)')), ['escaping', 'token:%(']);
addCompile('literal-backslash-before-dollar-rejected', root(lit('price \\$5')), ['escaping', 'error:literal-escape']);
addCompile('literal-apostrophe', root(lit("don't panic")), ['escaping']);
addCompile('literal-newline-tab', root(lit('a\nb\tc')), ['escaping']);
addCompile('literal-double-quote', root(lit('say "hi"')), ['escaping']);
addCompile('literal-quoted-bare', root(fn('say', [lit('hello there'), lit('-5'), lit('ok')])), ['quoted']);
addCompile('raw-top-level', root(raw('$(foo)')), ['type:raw']);
addCompile('raw-not-expression', root(raw('just text')), ['type:raw', 'error:invalid-raw']);
addCompile('raw-nested-rejected', root(fn('say', [raw('$(x)')])), ['type:raw', 'error:raw-not-top-level']);
for (const operator of BINARY_OPS) {
    addCompile(`binary-${operator}`, root(binary(lit('1'), operator, lit('2'))), ['type:binary', `binary:${operator}`]);
}
for (const operator of UNARY_OPS) {
    addCompile(`unary-${operator}`, root(unary(operator, lit('1'))), ['type:unary', `unary:${operator}`]);
}
addCompile('ternary-basic', root(ternary(binary(fn('user'), '==', lit('cdom201')), lit('yes'), lit('no'))), ['type:ternary']);
addCompile('ternary-empty-branches', root(ternary(lit('1'), null, null)), ['type:ternary', 'ternary:empty']);
addCompile('group-at-top-spreads', root(group(lit('a'), fn('user'), lit('b'))), ['type:group']);
addCompile('group-inside-argument-becomes-template', root(fn('say', [group(lit('Hi '), fn('user'))])), ['type:group', 'type:template']);
addCompile('template-mixed', root(template(lit('Hi '), fn('user'))), ['type:template']);
addCompile('template-all-literal', root(template(lit('a'), lit('b'))), ['type:template', 'merge']);
addCompile('array-literal-basic', root(arrayLit([lit('one'), lit('two words')])), ['type:arrayLiteral']);
addCompile('array-literal-index', root(arrayLit([lit('one')], { type: 'index', index: lit('0') })), ['type:arrayLiteral', 'accessor:index']);
addCompile('array-literal-random', root(arrayLit([lit('one')], { type: 'random' })), ['type:arrayLiteral', 'accessor:random']);
addCompile('array-literal-length', root(arrayLit([lit('one')], { type: 'length' })), ['type:arrayLiteral', 'accessor:length']);
for (const storage of STORAGES) {
    addCompile(`getvar-${storage}`, root(getVar('points', storage)), ['type:getVar', `storage:${storage}`]);
    addCompile(`exists-${storage}`, root(exists('points', storage)), ['type:exists', `storage:${storage}`]);
    addCompile(`deletevar-${storage}`, root(delVar('points', storage, { accessor: { type: 'clear' } })),
        ['type:deleteVar', `storage:${storage}`, 'accessor:clear']);
    addCompile(`setvar-${storage}`, root(setVar('points', lit('1'), storage)), ['type:setVar', `storage:${storage}`]);
}
addCompile('getvar-dbuser-selector', root(getVar('points', 'dbUser', { userSelector: fn('touser') })),
    ['type:getVar', 'selector:dbUser']);
addCompile('setvar-list-append', root(setVar('list', arrayLit([lit('one'), lit('two words')]), 'memory', { accessor: { type: 'append' } })),
    ['type:setVar', 'accessor:append']);
addCompile('deletevar-remove', root(delVar('list', 'db', { accessor: { type: 'remove', index: lit('0') } })),
    ['type:deleteVar', 'accessor:remove']);
addCompile('getvar-index', root(getVar('list', 'memory', { accessor: { type: 'index', index: lit('0') } })),
    ['type:getVar', 'accessor:index']);
addCompile('getvar-random', root(getVar('list', 'cache', { accessor: { type: 'random' } })),
    ['type:getVar', 'accessor:random']);
addCompile('getvar-length', root(getVar('list', 'memory', { accessor: { type: 'length' } })),
    ['type:getVar', 'accessor:length']);
addCompile('loop-range', root(forLoop({
    loopVar: 'i', mode: 'range', init: loopAssign('i', '=', lit('0')), condition: binary(loopVar('i'), '<', lit('3')),
    update: loopAssign('i', '++'), body: [fn('say', [lit('ping'), loopVar('i')])]
})), ['type:forLoop', 'mode:range']);
addCompile('loop-foreach', root(forLoop({
    loopVar: 'x', mode: 'foreach', iterable: getVar('list', 'memory', { accessor: { type: 'array' } }),
    body: [fn('say', [loopVar('x')])]
})), ['type:forLoop', 'mode:foreach']);
for (const operator of LOOP_OPS) {
    addCompile(`loopassign-${operator}`, root(loopAssign('i', operator, ['++', '--'].includes(operator) ? undefined : lit('1'))),
        ['type:loopAssign', `loopOp:${operator}`]);
}
addCompile('bad-var-name', root(getVar('bad name')), ['error:invalid-name']);
addCompile('bad-function-name', root(fn('123')), ['error:invalid-name']);
addCompile('bad-function-name-dot', root(fn('a..b')), ['error:invalid-name']);
addCompile('bad-loop-name', root(loopVar('1i')), ['error:invalid-name']);
addCompile('missing-block-id-points-at-parent', root({ id: 'empty-if', type: 'binary', operator: '==', left: null, right: lit('x') }),
    ['error:block-id']);
addCompile('unknown-block-type', root({ id: 'u1', type: 'nope' }), ['error:unknown-type']);
addCompile('root-without-children', { type: 'root' }, ['error:broken-root']);
addCompile('id-duplicate-repair', {
    id: 'r', type: 'root', children: [{ id: 'same', type: 'literal', value: 'a ' }, { id: 'same', type: 'function', name: 'user', args: [] }]
}, ['ids', 'id:duplicate']);
addCompile('literal-output-10000', root(lit('a'.repeat(10000))), ['limit:10000']);
addCompile('literal-output-10001', root(lit('a'.repeat(10001))), ['limit:10001', 'error:output-limit']);
addCompile('astral-output-10000', root(lit('𐐀'.repeat(5000))), ['limit:10000', 'utf16']);
addCompile('astral-output-10002', root(lit('𐐀'.repeat(5001))), ['limit:10002', 'utf16']);
addCompile('late-output-limit', root(...Array.from({ length: 50 }, () => fn('say', [lit('"'.repeat(1000))]))),
    ['limit:output', 'error:output-limit']);
// Named approved provenance regressions: the TS source reports the top-level
// block (function/binary) for a nested literal round-trip failure. Rust may
// point at the offending literal child. The message and the source blockId stay
// untouched; only these named cases carry an explicit expected blockId.
function addProvenanceCompile(key, input, childId, tags) {
    input = json(input);
    const source = compileSource(input);
    assert.equal(source.ok, false, `${key}: expected a source error`);
    assert.equal(typeof source.error.blockId, 'string', `${key}: source error needs a blockId`);
    assert.notEqual(source.error.blockId, childId, `${key}: source and approved provenance should differ`);
    addCase({
        operation: 'compile', key, input, source,
        expected: { outcome: 'error', error: { ...source.error, blockId: childId } },
        parity: 'approved-provenance',
        approved: {
            item: 6,
            change: 'error blockId points at the offending literal child',
            sourceBlockId: source.error.blockId,
            expectedBlockId: childId,
            messageUnchanged: true
        },
        tags: ['approved:provenance', ...tags]
    });
}
{
    const literal = { id: 'prov-lit-interp', type: 'literal', value: '${1}' };
    addProvenanceCompile('literal-interpolation-guard', {
        id: 'prov-root', type: 'root',
        children: [{ id: 'prov-fn', type: 'function', name: 'say', args: [literal] }]
    }, literal.id, ['error:roundtrip', 'type:literal']);
}
{
    const literal = { id: 'prov-lit-binary', type: 'literal', value: '${1}' };
    addProvenanceCompile('binary-literal-interpolation-guard', {
        id: 'prov-root-2', type: 'root',
        children: [{
            id: 'prov-binary', type: 'binary', operator: '+',
            left: literal, right: { id: 'prov-right', type: 'literal', value: '1' }
        }]
    }, literal.id, ['error:roundtrip', 'type:binary', 'type:literal']);
}
addCompile('raw-then-text', root(raw('$(foo)'), lit(' tail')), ['type:raw']);

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------
const unchangedImports = [
    '$(user) hugs $(touser) <3',
    '*($(random 6) == 0 ? "BANG! ${$(user)} is out" : "click... survives")',
    '%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)',
    'Thanks for the raid $(raid.channel)! #(so $(raid.channel))',
    '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })',
    '*(for #x in %(list[]) { $(say #x) })',
    '^(*seen) &t %del(##tmp(&p1)) *(-1 + 2)',
    'Hello plain text',
    'type \\$(user) to see',
    '$(say "hello")',
    '$(foo-bar)',
    '$(ok.name)',
    '$(say %[%(]) )',
    '$(say %[%(]) ) tail',
    'hi %(pen $(randomuser) extra) bye',
    'hi $(foo',
    '',
    '$(say one two three)',
    '*(1 + 2 * 3)',
    '~=$only',
    '%(**) %(##x) %(*x) %(#x) %(x)',
    '%[one, "two words", 3]',
    '%[1,2,3][random]',
    '%[1,2,3][0]',
    '%[1,2,3][].length',
    '$(touser) and ^(*seen) and %del(*tmp)',
    '*(+1 - -2)',
    '*(1 == 2 ? "yes" : "no")'
];
for (const text of unchangedImports) {
    addImport(`unchanged-${text}`, text, ['import:unchanged']);
}
addImport('empty-text', '', ['import:empty']);
addImport('text-length-10000', 'a'.repeat(10000), ['limit:10000']);
addImport('text-length-10001', 'a'.repeat(10001), ['limit:10001', 'error:text-limit']);
addImport('nested-functions-47-accepts', '$(s '.repeat(47) + 'x' + ')'.repeat(47), ['depth', 'depth:48']);
addImport('nested-functions-48-fallback', '$(s '.repeat(48) + 'x' + ')'.repeat(48), ['depth', 'depth:49', 'fallback:depth'], {
    expected: {
        outcome: 'imported',
        root: canonicalizeIds({ id: 'canon-root', type: 'root', children: [{ id: 'canon-raw', type: 'raw', source: '$(s '.repeat(48) + 'x' + ')'.repeat(48) }] }),
        advancedCount: 1,
        canonicalization: 'import-ids',
        resaveTextEqualsInput: true
    },
    parity: 'approved-invariant',
    approved: {
        item: 5,
        change: 'import fallback to original expression bytes under save limits',
        reason: 'candidate depth 49 > 48'
    }
});
addImport('empty-function-name-fallback', '$(123)', ['fallback:name'], {
    expected: {
        outcome: 'imported',
        root: canonicalizeIds({ id: 'canon-root', type: 'root', children: [{ id: 'canon-raw', type: 'raw', source: '$(123)' }] }),
        advancedCount: 1,
        canonicalization: 'import-ids',
        resaveTextEqualsInput: true
    },
    parity: 'approved-invariant',
    approved: {
        item: 5,
        change: 'import fallback to original expression bytes under save limits',
        reason: 'candidate function name is invalid under typed validation'
    }
});
addImport('invalid-var-name-source-raw', '$(say %(*bad-name))', ['fallback:name']);

// Output-expansion and node-quota fallbacks: invariants only (algorithm not final).
function addCompactImport(key, text, tags, description) {
    resetIds();
    const source = importSource(text);
    assert.ok(source.ok, `${key}: source import should not throw: ${JSON.stringify(source.error)}`);
    const summary = {
        summary: true,
        textUnits: text.length,
        advancedCount: source.value.advancedCount,
        nodeCount: countNodes(source.value.root),
        rootChildTypes: source.value.root.children.map((child) => child.type)
    };
    addCase({
        operation: 'import', key, input: { text }, source: summary,
        expected: {
            outcome: 'invariants',
            invariants: {
                rawPiecesAreOriginalBytes: true,
                rawPiecesConcatenateToInput: true,
                advancedCountMatchesRawChildren: true,
                typedValidation: { maxNodes: 7500, maxDepth: 48, names: 'typed validation rules' },
                resaveWithinUnits: 10000
            }
        },
        parity: 'approved-import-fallback',
        approved: {
            item: 5,
            change: 'global import fallback under node/depth/name/format and save-output limits',
            sourceAdvancedCount: source.value.advancedCount,
            sourceNodeCount: summary.nodeCount
        },
        tags: ['approved:import-fallback', 'summary', ...tags],
        description
    });
}
addCompactImport(
    'output-expansion-ternaries-1100',
    '*(1?2:3)'.repeat(1100),
    ['fallback:output'],
    'Source imports 4401 nodes (< 7500) but canonical save expands past 10000 units; affected expressions fall back to raw.'
);
addCompactImport(
    'wide-array-2498-items-near-node-limit',
    '*(%[' + '1+1,'.repeat(2497) + '1+1])',
    ['nodes:near-limit', 'fallback:output'],
    'Source imports 7495 nodes (below 7500, depth 3) but canonical save expands past 10000 units; output fallback keeps original expression bytes.'
);

// ---------------------------------------------------------------------------
// stored
// ---------------------------------------------------------------------------
function addStored(key, input, tags = []) {
    input = json(input);
    resetIds();
    const source = capture(() => api.storedBlocks(input));
    addCase({
        operation: 'stored', key, input: { root: input }, source,
        expected: source.ok
            ? { outcome: 'stored', value: source.value, keys: ['v', 'root'] }
            : { outcome: 'error', error: source.error },
        tags: ['stored', ...tags]
    });
}
addStored('empty-root', root(), ['type:root']);
addStored('literal', root(lit('hi')), ['type:literal']);
addStored('function-with-argument', root(fn('say', [lit('hi')])), ['type:function']);
addStored('all-storages', root(...STORAGES.map((storage) => getVar('v', storage))), STORAGES.map((s) => `storage:${s}`));
addStored('ternary-valid-branches', root(ternary(lit('1'), lit('2'), lit('3'))), ['type:ternary']);
addStored('raw', root(raw('$(x)')), ['type:raw']);
addStored('loop', root(forLoop({
    loopVar: 'i', mode: 'range', init: loopAssign('i', '=', lit('0')), condition: binary(loopVar('i'), '<', lit('3')),
    update: loopAssign('i', '++'), body: [fn('say', [loopVar('i')])]
})), ['type:forLoop']);

// ---------------------------------------------------------------------------
// structural_eq (TypeScript blockShape parity)
// ---------------------------------------------------------------------------
function addStructural(key, left, right, tags = []) {
    const pair = json({ left, right });
    resetIds();
    const equal = normalizeApi.blockShape(pair.left) === normalizeApi.blockShape(pair.right);
    addCase({
        operation: 'structural_eq', key, input: pair, source: { equal },
        expected: { outcome: 'comparison', equal },
        tags: ['structural', ...tags]
    });
}
addStructural('same-node', lit('x'), lit('x'), ['type:literal']);
addStructural('same-shape-different-ids', { id: 'a', type: 'literal', value: 'x' }, { id: 'b', type: 'literal', value: 'x' }, ['ids']);
addStructural('different-literal-value', lit('x'), lit('y'), ['type:literal']);
addStructural('binary-same-operator', binary(lit('1'), '+', lit('2')), binary(lit('1'), '+', lit('2')), ['type:binary']);
addStructural('binary-different-operator', binary(lit('1'), '+', lit('2')), binary(lit('1'), '-', lit('2')), ['type:binary']);
addStructural('argument-order-matters', fn('say', [lit('a'), lit('b')]), fn('say', [lit('b'), lit('a')]), ['type:function']);
addStructural('key-order-irrelevant', { type: 'literal', value: 'x', id: 'a' }, { id: 'b', value: 'x', type: 'literal' }, ['keys']);
addStructural('absent-vs-undefined-optional', { id: 'a', type: 'getVar', name: 'v', storage: 'memory' }, { id: 'b', type: 'getVar', name: 'v', storage: 'memory', accessor: undefined }, ['optional']);
addStructural('accessor-difference', getVar('v', 'memory', { accessor: { type: 'array' } }), getVar('v', 'memory', { accessor: { type: 'random' } }), ['accessor:array', 'accessor:random']);
addStructural('storage-difference', getVar('v', 'memory'), getVar('v', 'cache'), ['storage:memory', 'storage:cache']);
addStructural('raw-source-difference', raw('$(a)'), raw('$(b)'), ['type:raw']);
addStructural('template-vs-literal', template(lit('a'), lit('b')), lit('ab'), ['type:template', 'type:literal']);
addStructural('group-vs-template', group(lit('a')), template(lit('a')), ['type:group', 'type:template']);
addStructural('nested-difference', fn('say', [fn('inner', [lit('a')])]), fn('say', [fn('inner', [lit('b')])]), ['nested']);
addStructural('root-same', root(lit('a'), fn('user')), root(lit('a'), fn('user')), ['type:root']);
addStructural('root-child-count', root(lit('a')), root(lit('a'), lit('b')), ['type:root']);

// ---------------------------------------------------------------------------
// 2026-10-25 review regressions (3 regressions / 4 inputs). These append after
// all prior cases so earlier case names stay stable. Source outcomes are the
// actual isolated-oracle results; Rust failure/fix behaviour is not fitted.
// ---------------------------------------------------------------------------
function addExactFallbackRegression(key, text, expectedRoot, tags, reason) {
    const source = importSource(text);
    assert.ok(source.ok, `${key}: source import threw`);
    resetIds();
    const save = capture(() => api.compileBlocks(source.value.root));
    assert.equal(save.ok, false, `${key}: expected the source save to fail`);
    addCase({
        operation: 'import', key, input: { text }, source,
        expected: {
            outcome: 'imported',
            root: canonicalizeIds(expectedRoot),
            advancedCount: 1,
            canonicalization: 'import-ids',
            resaveTextEqualsInput: true
        },
        parity: 'approved-invariant',
        approved: {
            item: 5,
            change: 'import fallback to original expression bytes under save limits',
            reason,
            sourceAdvancedCount: source.value.advancedCount,
            sourceRootChildTypes: source.value.root.children.map((child) => child.type),
            sourceSaveOutcome: save.error
        },
        tags: ['approved:import-fallback', 'regression:review-20261025', ...tags]
    });
}

// (a) 9605-unit source imports a 9600-unit literal; TS canonical save needs
// 12000 units. Fallback keeps the one original expression byte-exact.
addExactFallbackRegression(
    'review-output-expansion-2400',
    '*("' + '$(x)'.repeat(2400) + '")',
    { id: 'canon-root', type: 'root', children: [{ id: 'canon-raw', type: 'raw', source: '*("' + '$(x)'.repeat(2400) + '")' }] },
    ['fallback:output', 'regression:2400-dollar-expressions'],
    'source canonical save errors OutputLimit 12000; the affected top-level expression falls back to its original bytes'
);

// (b) Exact Rust raw-string content bytes: *("\\")$(user). TS imports a
// single-backslash literal plus the function, then fails literal escaping.
// Only the first 7-byte expression becomes raw; the function is preserved.
const reviewBytes = String.fromCharCode(42, 40, 34, 92, 92, 34, 41, 36, 40, 117, 115, 101, 114, 41);
addExactFallbackRegression(
    'review-partial-raw-backslash',
    reviewBytes,
    {
        id: 'canon-root', type: 'root', children: [
            { id: 'canon-raw', type: 'raw', source: reviewBytes.slice(0, 7) },
            { id: 'canon-function', type: 'function', name: 'user', args: [] }
        ]
    },
    ['fallback:format', 'type:literal', 'type:function', 'regression:backslash-before-expression'],
    'source normalizes the first expression to a single backslash literal and its save fails LiteralEscape; only that original 7-byte expression becomes raw'
);

// (c) 47 function wrappers place the leaf literal at depth 48: TS succeeds.
{
    const leaf = { id: 'review-depth-lit', type: 'literal', value: 'two words' };
    let node = leaf;
    for (let i = 0; i < 47; i += 1) node = { id: `review-depth-f${i}`, type: 'function', name: 's', args: [node] };
    const input = { id: 'review-depth-root', type: 'root', children: [node] };
    const source = compileSource(input);
    assert.equal(source.ok, true, 'expected the 47-wrapper source compile to succeed');
    assert.equal(source.value.text.length, 246, 'expected the 246-unit source text');
    addCase({
        operation: 'compile', key: 'review-47-functions-depth-48', input, source,
        expected: expectedCompile(source),
        parity: 'source-parity',
        tags: ['regression:review-20261025', 'depth', 'depth:48', 'type:function', 'type:literal']
    });
}

// (d) Two top-level literals total 10001 units: TS OutputLimit with no blockId.
// Any Rust error id/path is additive and is asserted by the integration test.
{
    const input = {
        id: 'review-output-root', type: 'root',
        children: [
            { id: 'review-output-a', type: 'literal', value: 'a'.repeat(5000) },
            { id: 'review-output-b', type: 'literal', value: 'b'.repeat(5001) }
        ]
    };
    const source = compileSource(input);
    assert.equal(source.ok, false, 'expected the two-literal source compile to fail');
    assert.equal(source.error.message, 'This command is too long (10001 of 10000 characters).');
    assert.equal(source.error.blockId, undefined, 'source OutputLimit has no blockId');
    addCase({
        operation: 'compile', key: 'review-output-limit-two-literals', input, source,
        expected: { outcome: 'error', error: source.error },
        parity: 'source-parity',
        tags: ['regression:review-20261025', 'limit:10001', 'error:output-limit']
    });
}

// ---------------------------------------------------------------------------
// Existing TypeScript unit tests: run the real file and record facts/IDs.
// ---------------------------------------------------------------------------
load(testPath);
assert.equal(testDefinitions.length, 12, `expected 12 existing unit tests, found ${testDefinitions.length}`);
for (const definition of testDefinitions) {
    currentTest.name = definition.name;
    definition.fn();
}
currentTest.name = null;
assert.equal(legacyAssertions.length > 0, true, 'no legacy assertions recorded');

// ---------------------------------------------------------------------------
// Manifest metadata, coverage, benchmarks.
// ---------------------------------------------------------------------------
const byOperation = {};
const byParity = {};
for (const item of cases) {
    byOperation[item.operation] = (byOperation[item.operation] ?? 0) + 1;
    byParity[item.parity] = (byParity[item.parity] ?? 0) + 1;
}
const BLOCK_TYPES = [
    'literal', 'raw', 'function', 'commandRef', 'getVar', 'setVar', 'exists', 'deleteVar',
    'binary', 'unary', 'ternary', 'template', 'arrayLiteral', 'loopVar', 'loopAssign', 'forLoop', 'group'
];
const requiredTags = [
    'type:root',
    ...BLOCK_TYPES.map((type) => `type:${type}`),
    ...BINARY_OPS.map((op) => `binary:${op}`),
    ...UNARY_OPS.map((op) => `unary:${op}`),
    ...LOOP_OPS.map((op) => `loopOp:${op}`),
    ...STORAGES.map((storage) => `storage:${storage}`),
    ...ACCESSOR_TYPES.map((type) => `accessor:${type}`),
    'mode:range', 'mode:foreach', 'ternary:empty', 'type:group', 'type:template',
    'escaping', 'selector:cacheUser', 'selector:dbUser', 'ids', 'names:var', 'names:loop',
    'names:function', 'quota', 'depth:48', 'depth:49', 'limit:10000', 'limit:10001',
    'fallback:depth', 'fallback:name', 'fallback:output', 'nodes:near-limit',
    'approved:provenance', 'command:cap-before-strip', 'anchor:absolute'
];
const missingTags = requiredTags.filter((tag) => !seenTags.has(tag));
assert.deepEqual(missingTags, [], `required coverage missing: ${missingTags.join(', ')}`);

const coverage = {
    blockTypes: BLOCK_TYPES,
    binaryOps: BINARY_OPS,
    unaryOps: UNARY_OPS,
    loopAssignOps: LOOP_OPS,
    storages: STORAGES,
    accessors: ACCESSOR_TYPES,
    parityClasses: Object.keys(byParity).sort(),
    probeFacts: {
        jsIdFinalLineTerminator: 'probed: ID anchor rejects LF, CR, LS and PS suffixes (absolute, not final-terminator tolerant)',
        jsNameAnchorTerminators: 'probed: var/function/loop anchors reject LF, CR, LS and PS suffixes; command names reject them as whitespace',
        jsUnicodeLetterU0345: 'probed rejected: U+0345 is Mn, not \\p{L}',
        jsUnicodeAstralLetters: 'probed accepted by \\p{L}; 32 astral letters fit the 64 UTF-16-unit cap, 33 do not',
        jsUnicodeAstralDigit: 'probed accepted by \\p{N} (U+1D7D8)',
        jsWhitespaceU0085: 'probed not JS \\s, so it is allowed in command names',
        jsWhitespaceNbsp: 'probed JS \\s, so it is rejected in command names',
        jsUtf16Length: 'JS .length and Rust encode_utf16().count() agree: astral characters count as two units',
        loneSurrogates: 'excluded: unpaired UTF-16 surrogates are not representable as Rust String/&str JSON facts'
    }
};

const benchmarks = [
    {
        name: 'typical-mixed',
        description: 'Typical chat reply: plain text, functions and an escaped start token.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: 'Hello $(user)! Thanks $(touser) type \\$(x) to see.' }
    },
    {
        name: 'plain',
        description: 'Plain text only, no expressions.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: 'welcome back chat, stay hydrated   ' }
    },
    {
        name: 'dense100',
        description: '100 short function expressions.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(say hi)'.repeat(100) }
    },
    {
        name: 'dense500',
        description: '500 short function expressions.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(say hi)'.repeat(500) }
    },
    {
        name: 'unique-expressions',
        description: 'Mixed distinct expressions (variables, loops, arrays, ternaries).',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(user) %(*deaths) ^(*seen) %[1,2,3][random] *(1?2:3)' }
    },
    {
        name: 'canonical-quotes',
        description: 'Already canonical quoted function arguments.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(say "hello there" "ok")' }
    },
    {
        name: 'noncanonical-quotes',
        description: 'Quoted and unquoted spellings that canonicalize to the same meaning.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(say    "hello"   there)' }
    },
    {
        name: 'loop',
        description: 'Range loop with a variable body.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })' }
    },
    {
        name: 'array',
        description: 'Array literal with a random accessor.',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '%[one, "two words", 3][random]' }
    },
    {
        name: 'deep40',
        description: '40 nested function expressions (below the depth boundary).',
        category: 'paired-timing', timingPair: true,
        input: { kind: 'import', text: '$(s '.repeat(40) + 'x' + ')'.repeat(40) }
    },
    {
        name: 'invalid-oversize',
        description: 'Compile input whose text exceeds 10000 units; error path only.',
        category: 'separate-verification', timingPair: false,
        input: { kind: 'compile-tree-spec', treeSpec: 'literal-length', length: 10001 }
    },
    {
        name: 'id-repair',
        description: 'Read input with duplicate/invalid ids; repair path only.',
        category: 'separate-verification', timingPair: false,
        input: { kind: 'read-tree-spec', treeSpec: 'duplicate-ids', literals: 100 }
    },
    {
        name: 'normalize-wide',
        description: 'Normalize a wide (<=4000 node) group/literal tree; normalize path only.',
        category: 'separate-verification', timingPair: false,
        input: { kind: 'normalize-tree-spec', treeSpec: 'wide-groups', literals: 1000 }
    },
    {
        name: 'empty-ternaries',
        description: 'Compile a tree with synthetic empty ternary branches.',
        category: 'paired-timing', timingPair: true,
        input: {
            kind: 'compile-tree-spec', treeSpec: 'empty-ternary',
            input: {
                id: 'bench-root', type: 'root', children: [{
                    id: 'bench-ternary', type: 'ternary', test: { id: 'bench-test', type: 'literal', value: '1' },
                    consequent: null, alternate: null
                }]
            }
        }
    }
];
assert.equal(benchmarks.length, 14);
assert.equal(new Set(benchmarks.map((benchmark) => benchmark.name)).size, 14);
assert.ok(benchmarks.filter((benchmark) => !benchmark.timingPair).every((benchmark) => benchmark.category === 'separate-verification'));

const manifest = {
    schemaVersion: 1,
    fixtureId: 'ast-blocks-20261025',
    description: 'Source-backed TypeScript-compatible ast_blocks fixtures for the dima-rust pure port.',
    contract: {
        oracle: 'actual TypeScript modules loaded in an isolated VM',
        evaluator: 'throw-only stub; never called',
        sourceFiles: 11,
        limits: { tsMaxBlockNodes: 4000, rustMaxBlockNodes: 7500, maxBlockDepth: 48, maxCommandText: 10000 },
        idPolicy: 'validation ids exact; import ids canonicalized by pre-order traversal',
        errorPolicy: 'source keeps TS name/message/blockId; Rust code/path are additive and not asserted as TS facts'
    },
    sources,
    legacyTestSource: {
        path: 'dimabot/src/utils/ast_blocks/ast_blocks.test.ts',
        sha256: legacyTestHash,
        names: testDefinitions.map((definition) => definition.name),
        assertions: legacyAssertions
    },
    baseline: {
        tsMaxBlockNodes: validateApi.MAX_BLOCK_NODES,
        rustMaxBlockNodes: 7500,
        maxBlockDepth: validateApi.MAX_BLOCK_DEPTH,
        maxCommandText: api.MAX_COMMAND_TEXT,
        nodeLimit: 'approved hardening: validated nodes 4000 -> 7500',
        depthAndTextLimits: 'unchanged'
    },
    counts: {
        total: cases.length,
        uniqueNames: caseNames.size,
        byOperation,
        byParity
    },
    coverage,
    benchmarks,
    knownLimitations: [
        'Import fallback IDs/order/tree shape are intentionally not asserted; only the approved invariants are.',
        'Import expectations use canonical n1.. IDs; source keeps deterministic opaque oracle IDs.',
        'The TypeScript oracle has no error code or JSON pointer fields; no fixture invents them.',
        'Quota/oversize trees use compact treeSpec inputs and source summaries to keep the JSON bounded.',
        'Evaluator, functions registry, services, environment, network and clock are never loaded.',
        'Benchmark entries are definitions only; no timing result or Rust benchmark is claimed.',
        'Rust default is TypeScript-compatible; approved import fallback is the only import difference from the TS source.',
        'Unicode regex behaviour is pinned to the probed Node engine; Unicode version changes could alter edge cases.',
        'Unpaired UTF-16 surrogate strings are outside Rust String/&str JSON and are excluded; astral pair counting is covered.',
        'Command-name length is capped before the leading ! is stripped, matching the TS source order (verified by cases).',
        'storedBlocks in TS is an unvalidated passthrough; stored parity cases use read-validated typed trees only. Invalid/null branches are outside the Rust typed StoredBlocks API.',
        'An import candidate cannot reach 7500 nodes under the 10000-unit text cap without also exceeding depth 48 (flat grammar max ~7499); node quota is enforced by typed read validation, while import fallback covers depth/name/format/output. A 7499-node wide case covers the near-limit path.'
    ],
    corpusHash: null,
    cases
};
manifest.corpusHash = sha256(JSON.stringify({ ...manifest, corpusHash: undefined }));
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
    const existing = readFileSync(fixtureUrl, 'utf8');
    if (existing !== output) {
        console.error('ast_blocks_cases.json is stale; regenerate without --check.');
        process.exitCode = 1;
    } else {
        console.log('ast_blocks_cases.json is up to date');
    }
} else {
    writeFileSync(fixtureUrl, output);
    console.log(JSON.stringify({
        output: fixtureUrl.pathname,
        cases: cases.length,
        uniqueNames: caseNames.size,
        byOperation,
        byParity,
        corpusHash: manifest.corpusHash,
        legacyTests: testDefinitions.length,
        evaluatorCalls
    }, null, 2));
}
assert.equal(evaluatorCalls, 0, 'evaluator stub was called');
