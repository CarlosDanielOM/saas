#!/usr/bin/env node
// Inventory of dimabot unit tests and ops behaviour checks for the Rust migration.
//
// Usage (from anywhere):  node dima-rust/tools/ledger/tests_inventory.mjs [--repo <root>]
// Writes: dima-rust/ledger/tests.json (per-file records + totals).
// dima-rust/ledger/tests.md is written by hand from this output (see its "How verified" section).
//
// Read-only on the source tree. Parses with the TypeScript compiler API (syntax only, no type check).
// All classifications are static heuristics; every record carries the evidence that produced it.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(argVal('--repo') ?? path.join(HERE, '../../..'));
const OUT = argVal('--out') ?? path.join(REPO, 'dima-rust/ledger/tests.json');
const require = createRequire(import.meta.url);
const ts = require(path.join(REPO, 'dimabot/node_modules/typescript'));

const SRC = path.join(REPO, 'dimabot/src');
const CHECKS = path.join(REPO, 'ops/checks');
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
const srcRel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');
const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

function walk(dir, filter, out = [], skip = new Set(['node_modules', 'dist', '.git', 'target'])) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, filter, out, skip);
        else if (filter(p)) out.push(p);
    }
    return out;
}

function parse(file, text) {
    const kind = /\.(mjs|js|cjs)$/.test(file) ? ts.ScriptKind.JS : file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const strValue = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

// ============================================================================ Part A: dimabot/src tests
const CODE_RE = /\.(ts|tsx|mts|mjs|js)$/;
const allSrc = walk(SRC, (p) => CODE_RE.test(p) && !p.endsWith('.d.ts'));
const HELPER_RE = /\.(test-data|test-helper|fixture|test_util|testutil)\.ts$/;
const TESTNAME_RE = /\.(test|spec|specs)\.(ts|tsx|mjs|js)$/;

function resolveSpec(fromFile, spec) {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    const stem = base.replace(/\.(js|mjs|cjs|ts|mts|tsx)$/, '');
    const cands = [base, stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.mjs', stem + '.js',
        path.join(base, 'index.ts'), path.join(base, 'index.js')];
    for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
}

// Parse every source file once: imports (static, dynamic, re-export), mock.module specifiers, test calls.
const info = new Map();
for (const file of allSrc) {
    const text = read(file);
    const sf = parse(file, text);
    const imports = []; // {spec, resolved, kind, line}
    const mocked = []; // {spec, resolved, line}
    const mockMethods = []; // {target, method, line}
    const tests = { test: 0, describe: 0, subtests: 0, skipped: 0, todo: 0, dynamic: 0, conditionalSkip: 0, names: [] };
    let usesNodeTest = false;
    const visit = (node, depth) => {
        if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
            const spec = strValue(node.moduleSpecifier);
            if (spec === 'node:test') usesNodeTest = true;
            if (spec) imports.push({ spec, kind: node.importClause?.isTypeOnly || node.isTypeOnly ? 'type' : 'static', line: lineOf(sf, node) });
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const arg0 = node.arguments[0];
            if (callee.kind === ts.SyntaxKind.ImportKeyword && strValue(arg0)) {
                imports.push({ spec: strValue(arg0), kind: 'dynamic', line: lineOf(sf, node) });
            } else if (ts.isIdentifier(callee) && callee.text === 'require' && strValue(arg0)) {
                imports.push({ spec: strValue(arg0), kind: 'require', line: lineOf(sf, node) });
            } else if (ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression) === false
                && callee.name.text === 'module' && /(^|\.)mock$/.test(callee.expression.getText(sf)) && strValue(arg0)) {
                mocked.push({ spec: strValue(arg0), line: lineOf(sf, node) });
            } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'module'
                && /mock$/.test(callee.expression.getText(sf)) && strValue(arg0)) {
                mocked.push({ spec: strValue(arg0), line: lineOf(sf, node) });
            } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'method' && /mock$/.test(callee.expression.getText(sf))) {
                mockMethods.push({ target: arg0?.getText(sf).slice(0, 60), method: strValue(node.arguments[1]) ?? node.arguments[1]?.getText(sf).slice(0, 40), line: lineOf(sf, node) });
            }
            // test / it / describe / suite (+ .skip/.only/.todo), t.test subtests
            let name, mod;
            if (ts.isIdentifier(callee) && ['test', 'it', 'describe', 'suite'].includes(callee.text)) name = callee.text;
            else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
                const obj = callee.expression.text, prop = callee.name.text;
                if (['test', 'it', 'describe', 'suite'].includes(obj) && ['skip', 'only', 'todo'].includes(prop)) { name = obj; mod = prop; }
                else if (prop === 'test' && !['node', 'assert'].includes(obj) && node.arguments.length >= 1 && (strValue(arg0) !== undefined || ts.isTemplateExpression(arg0))) { name = 'subtest'; }
            }
            if (name && node.arguments.length >= 1 && (strValue(arg0) !== undefined || ts.isTemplateExpression(arg0) || ts.isFunctionLike(arg0) || name === 'subtest')) {
                // dynamic if inside a loop or callback that is not itself a describe/test body
                let p = node.parent, dynamic = false;
                while (p && p !== sf) {
                    if (ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) { dynamic = true; break; }
                    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ['forEach', 'map', 'flatMap'].includes(p.expression.name.text)) { dynamic = true; break; }
                    if (ts.isFunctionDeclaration(p)) { dynamic = true; break; }
                    p = p.parent;
                }
                const opts = node.arguments.find((a) => ts.isObjectLiteralExpression(a));
                const skipProp = opts?.properties.find((pr) => pr.name && ['skip', 'todo'].includes(pr.name.getText(sf)));
                if (name === 'describe' || name === 'suite') tests.describe++;
                else if (name === 'subtest') tests.subtests++;
                else {
                    tests.test++;
                    if (dynamic) tests.dynamic++;
                    if (mod === 'skip') tests.skipped++;
                    if (mod === 'todo') tests.todo++;
                    if (skipProp) {
                        const init = skipProp.initializer?.getText(sf) ?? '';
                        if (init === 'true' || /^['"`]/.test(init)) tests.skipped++; else tests.conditionalSkip++;
                    }
                }
            }
        }
        ts.forEachChild(node, (c) => visit(c, depth + 1));
    };
    visit(sf, 0);
    for (const i of imports) i.resolved = resolveSpec(file, i.spec);
    for (const m of mocked) m.resolved = resolveSpec(file, m.spec);
    info.set(file, { text, sf, imports, mocked, mockMethods, tests, usesNodeTest, lines: countLines(text) });
}

const isTestFile = (f) => !HELPER_RE.test(f) && (TESTNAME_RE.test(f) || (info.get(f).usesNodeTest && info.get(f).tests.test > 0));
const isHelper = (f) => HELPER_RE.test(f) || (!TESTNAME_RE.test(f) && !info.get(f).usesNodeTest && /\/(fixtures?)\//.test(srcRel(f)) && /\.(ts|mjs)$/.test(f));
const testFiles = allSrc.filter(isTestFile).sort();
const helperFiles = allSrc.filter((f) => !isTestFile(f) && isHelper(f)).sort();
const testSupport = new Set([...testFiles, ...helperFiles]);
// helpers referenced only via new URL()/spawn
const lateHelpers = ['scripts/run_test_lua.script.mjs'].map((r) => path.join(SRC, r));

// Mechanism detectors (regex over source text). Each returns [name, evidence lines].
function findLines(text, re) {
    const out = [];
    text.split('\n').forEach((l, i) => { if (re.test(l)) out.push(i + 1); });
    return out;
}
const DETECTORS = [
    ['mock.module', /\bmock\.module\(/],
    ['mock.method', /\bmock\.method\(/],
    ['mock.fn', /\bmock\.fn\(/],
    ['mock.timers', /\bmock\.timers\b/],
    ['mock.getter/setter', /\bmock\.(getter|setter|property)\(/],
    ['fetch override', /globalThis\.fetch\s*=(?!=)|mock\.method\(\s*globalThis\s*,\s*['"]fetch['"]/],
    ['Date.now override', /Date\.now\s*=(?!=)/],
    ['process.env mutation', /process\.env(\.[A-Z0-9_]+|\[[^\]]+\])\s*=(?!=)|delete process\.env/],
    ['in-process HTTP server (loopback)', /\.listen\(\s*0\b|createServer\(/],
    ['temp-dir filesystem', /mkdtemp|tmpdir\(\)|os\.tmpdir/],
    ['child process', /\b(spawnSync|spawn|execFileSync|execFile|execSync|fork)\(/],
    ['dependency-injection fakes', /\b(deps|dependencies|Deps|store|repo|repository|clock|now|fetchImpl|fetcher|sleep|random|rng|io|ports|hooks|adapter|loader|client|redis|db|model|query|publish|emit|send|request|logger)\s*:\s*(async\s+)?(\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\b)/],
    ['fake/stub objects', /\b(fake|Fake|stub|Stub|FakeRedis|fakeRedis|memoryStore|InMemory)[A-Za-z]*\b/],
];
const SERVICE_DETECTORS = [
    ['real MongoDB (mongoose.connect/createConnection)', /mongoose\.(connect|createConnection)\(|new MongoClient\(/],
    ['real Redis/Dragonfly (redis createClient)', /\bcreateClient\(\s*\{\s*url|\bcreateClient\(\s*\{[^}]*url/],
    ['env-gated external service', /process\.env\.[A-Z0-9_]*(TEST_[A-Z_]*(URI|URL)|_URI|_URL)\b.*\n?.*skip|skip:\s*!?[a-z]*(url|uri|Url|Uri)/],
    ['host binary (ffmpeg/ffprobe)', /\bffmpeg|ffprobe/],
];

function directDeps(file) {
    const i = info.get(file);
    const mockedSet = new Set(i.mocked.map((m) => m.resolved).filter(Boolean));
    return { deps: i.imports.filter((x) => x.resolved && x.kind !== 'type').map((x) => x.resolved), mockedSet };
}
function closure(start, excluded) {
    const seen = new Set();
    const stack = [...start];
    while (stack.length) {
        const f = stack.pop();
        if (seen.has(f) || excluded.has(f) || !info.has(f)) continue;
        seen.add(f);
        for (const d of info.get(f).imports) if (d.resolved && d.kind !== 'type') stack.push(d.resolved);
    }
    return seen;
}

// ---- non-ASCII / JS-string-semantics scan
const CTX = [
    ['length', /\.length\b|byteLength|maxLength|max_length|MAX_[A-Z_]*(LEN|CHARS|LENGTH)|LIMIT|limit/],
    ['slice/truncate', /\.(slice|substring|substr|charAt|charCodeAt|codePointAt|at)\(|truncat|ellips|…|\.\.\.'|padStart|padEnd|\.split\(''\)|\[\.\.\.|Array\.from\(/],
    ['sort/collation', /localeCompare|\.sort\(|Intl\.Collator|toSorted/],
    ['case mapping', /to(Locale)?(Upper|Lower)Case/],
    ['normalization', /\.normalize\(|NFKC|NFC|NFD|diacritic|accent/i],
    ['regex/unicode classes', /\\p\{|\/[gimsuy]*u[gimsuy]*[,;)\s]|\\w|\\b/],
    ['segmenter/grapheme', /Segmenter|grapheme/i],
];
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]|\\u\{1F|\\u[dD][89abAB][0-9a-fA-F]{2}/u;
const NONASCII_RE = /[^\x00-\x7F]|\\u00[89a-fA-F][0-9a-fA-F]|\\u0[1-9a-fA-F][0-9a-fA-F]{2}|\\u[1-9a-fA-F][0-9a-fA-F]{3}|\\u\{[0-9a-fA-F]{3,6}\}|\\x[89a-fA-F][0-9a-fA-F]|String\.fromCodePoint|fromCharCode/;
function unicodeScan(file) {
    const lines = info.get(file).text.split('\n');
    const hits = [];
    let plainNonAscii = 0;
    lines.forEach((l, idx) => {
        if (!NONASCII_RE.test(l)) return;
        // ignore pure comments
        const trimmed = l.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        const window = lines.slice(Math.max(0, idx - 3), idx + 4).join('\n');
        const cats = CTX.filter(([, re]) => re.test(window)).map(([n]) => n);
        const emoji = EMOJI_RE.test(l);
        if (cats.length) hits.push({ line: idx + 1, emoji_or_surrogate: emoji, categories: cats, snippet: trimmed.slice(0, 160) });
        else plainNonAscii++;
    });
    return { hits, plainNonAscii };
}

const testRecords = [];
const directlyImported = new Map(); // src file -> [test files]
const reached = new Map();
for (const file of [...testFiles, ...helperFiles]) {
    const i = info.get(file);
    const { mockedSet } = directDeps(file);
    const relImports = i.imports.filter((x) => x.resolved && x.kind !== 'type');
    const underTest = [...new Set(relImports.map((x) => x.resolved).filter((r) => !testSupport.has(r) && !mockedSet.has(r)))];
    const helpers = [...new Set(relImports.map((x) => x.resolved).filter((r) => testSupport.has(r)))];
    if (/run_test_lua|follow_defense_state\.test-helper/.test(i.text)) helpers.push(...lateHelpers.filter((h) => i.text.includes('run_test_lua')));
    for (const u of underTest) { if (!directlyImported.has(u)) directlyImported.set(u, []); directlyImported.get(u).push(file); }
    for (const r of closure(relImports.map((x) => x.resolved), mockedSet)) { if (!testSupport.has(r)) { if (!reached.has(r)) reached.set(r, 0); reached.set(r, reached.get(r) + 1); } }
    const mechanisms = {};
    for (const [name, re] of DETECTORS) { const ls = findLines(i.text, re); if (ls.length) mechanisms[name] = ls.slice(0, 12); }
    // helper-implied mechanisms
    const helperNames = helpers.map(srcRel);
    if (helperNames.some((h) => /follow_defense_state\.test-helper/.test(h)) || /run_test_lua/.test(i.text)) mechanisms['lua-redis-wasm (real Lua scripts, Redis commands mocked)'] = findLines(i.text, /runFollowDefenseStateLua|run_test_lua|TEST_LUA|test-helper/).slice(0, 6);
    if (helperNames.some((h) => /fake_store\.testutil/.test(h))) mechanisms['fake Mongoose store (fake_store.testutil)'] = findLines(i.text, /fake_store/).slice(0, 4);
    if (helperNames.some((h) => /route_harness\.test_util/.test(h))) mechanisms['route harness (express on loopback, fake auth)'] = findLines(i.text, /route_harness/).slice(0, 4);
    if (helperNames.some((h) => /test_context\.test_util/.test(h))) mechanisms['site-agent test context (fakes)'] = findLines(i.text, /test_context/).slice(0, 4);
    const service = {};
    for (const [name, re] of SERVICE_DETECTORS) { const ls = findLines(i.text, re); if (ls.length) service[name] = ls.slice(0, 8); }
    // the env-gated detector is multi-line; recheck simply
    if (/skip:\s*(!|mongoUri|url|.*\?)/.test(i.text) && /process\.env\.[A-Z0-9_]*(URI|URL)/.test(i.text)) service['env-gated external service'] = findLines(i.text, /process\.env\.[A-Z0-9_]*(URI|URL)|skip:/).slice(0, 6);
    else delete service['env-gated external service'];
    // ffmpeg only counts if the test actually executes it
    if (service['host binary (ffmpeg/ffprobe)'] && !/hasDecoder|spawnSync\(['"]ff|execFileSync\(['"]ff|which ff/.test(i.text)) delete service['host binary (ffmpeg/ffprobe)'];
    // DI heuristic is noisy: only keep it when no stronger mechanism exists, but record either way
    let classification;
    const strong = Object.keys(mechanisms).filter((k) => !['fake/stub objects', 'dependency-injection fakes', 'process.env mutation'].includes(k));
    if (Object.keys(service).length) classification = 'SERVICE';
    else if (strong.length || mechanisms['dependency-injection fakes'] || mechanisms['fake/stub objects']) classification = 'MOCKED';
    else if (mechanisms['process.env mutation']) classification = 'MOCKED';
    else classification = 'PURE';
    const isHelperFile = helperFiles.includes(file);
    const uni = unicodeScan(file);
    const segs = srcRel(file).split('/');
    testRecords.push({
        file: rel(file),
        role: isHelperFile ? 'helper' : 'test',
        dir: segs.length > 2 ? segs.slice(0, 2).join('/') : segs[0].includes('.') ? '(root)' : segs[0],
        lines: i.lines,
        modules_under_test: underTest.map(srcRel).sort(),
        test_helpers: [...new Set(helperNames)].sort(),
        mocked_modules: [...new Set(i.mocked.map((m) => (m.resolved ? srcRel(m.resolved) : m.spec)))].sort(),
        mocked_methods: i.mockMethods.slice(0, 20).map((m) => `${m.target}.${m.method}@${m.line}`),
        external_packages: [...new Set(i.imports.filter((x) => !x.spec.startsWith('.') && !x.spec.startsWith('node:') && x.kind !== 'type').map((x) => x.spec))].sort(),
        cases: { test: i.tests.test, subtests: i.tests.subtests, describe: i.tests.describe, generated_in_loops_or_helpers: i.tests.dynamic, skipped: i.tests.skipped, conditional_skip: i.tests.conditionalSkip, todo: i.tests.todo },
        classification: isHelperFile ? `HELPER(${classification})` : classification,
        mechanisms: Object.fromEntries(Object.entries(mechanisms).map(([k, v]) => [k, v])),
        service_needs: service,
        unicode_semantics: uni.hits,
        non_ascii_lines_without_string_ops: uni.plainNonAscii,
    });
}

// Coverage: non-test source files > 150 lines not directly imported by any test.
const uncovered = [];
for (const file of allSrc) {
    if (testSupport.has(file) || isTestFile(file) || file.endsWith('.simulate.ts')) continue;
    const i = info.get(file);
    if (i.lines <= 150) continue;
    if (directlyImported.has(file)) continue;
    uncovered.push({ file: srcRel(file), lines: i.lines, transitively_loaded_by_tests: reached.get(file) ?? 0 });
}
uncovered.sort((a, b) => b.lines - a.lines);
const nonTestBig = allSrc.filter((f) => !testSupport.has(f) && !isTestFile(f) && info.get(f).lines > 150).length;

// ============================================================================ Part B: ops/checks
const TARGET_NAMES = ['analytics', 'api', 'bot', 'cron', 'piper', 'embeddings', 'dimafx-server', 'dimadb', 'hoststats', 'site', 'admin', 'docs'];
const topChecks = fs.readdirSync(CHECKS, { withFileTypes: true }).filter((e) => e.isFile() && /\.(mjs|py|sh)$/.test(e.name)).map((e) => e.name).sort();
const topOther = fs.readdirSync(CHECKS, { withFileTypes: true }).filter((e) => e.isFile() && !/\.(mjs|py|sh)$/.test(e.name)).map((e) => e.name).sort();
const fixtureDirs = fs.readdirSync(CHECKS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

// Docs: command blocks naming a target and a --check
const mdFiles = walk(REPO, (p) => p.endsWith('.md'), [], new Set(['node_modules', 'dist', '.git', 'target', '.angular', '.astro', 'archives', 'datasets']));
const docRefs = new Map(); // check basename -> [{target, doc, fixtures:[], testEnv, deps:[]}]
for (const md of mdFiles) {
    const text = read(md);
    // units: fenced code blocks and paragraphs
    const units = text.split(/\n```[^\n]*\n|\n\s*\n/);
    for (const u of units) {
        if (!u.includes('--check')) continue;
        const joined = u.replace(/\\\n\s*/g, ' ');
        const tm = [...joined.matchAll(/verify\s+([a-z][a-z-]*?)-(?:<[^>]*>|[0-9a-f]{12}\b|\$\{?[A-Za-z_]+\}?|RUN|\.\.\.)/g)].map((m) => m[1]).filter((t) => TARGET_NAMES.includes(t));
        const checks = [...joined.matchAll(/--check\s+["']?(?:\S*?\/)?(?:ops\/checks\/)?([A-Za-z0-9_.-]+\.(?:mjs|py|sh))/g)].map((m) => m[1]);
        if (!checks.length) continue;
        const fixtures = [...new Set([...joined.matchAll(/ops\/checks\/([A-Za-z0-9_.-]+(?:-fixtures|_global))\b/g)].map((m) => m[1]))];
        const testEnv = [...new Set([...joined.matchAll(/--test-env\s+(\S+)/g)].map((m) => m[1].replace(/[`'"]/g, '')))];
        const deps = [...new Set([...joined.matchAll(/--dependency\s+(mongo|redis|postgres)/g)].map((m) => m[1]))];
        for (const c of checks) {
            if (!docRefs.has(c)) docRefs.set(c, []);
            docRefs.get(c).push({ targets: [...new Set(tm)], doc: rel(md), fixtures, testEnv, deps });
        }
    }
}

function headerComment(text) {
    const m = text.match(/^(?:#![^\n]*\n)?\s*((?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n)+|"""[\s\S]*?"""|(?:#[^\n]*\n)+))/);
    return m ? m[1] : '';
}
function constStrings(sf) {
    const map = {};
    const visit = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            const v = strValue(n.initializer);
            if (v !== undefined) map[n.name.text] = v;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return map;
}
function evalTemplate(node, consts) {
    if (strValue(node) !== undefined) return strValue(node);
    if (ts.isTemplateExpression(node)) {
        let s = node.head.text;
        for (const span of node.templateSpans) {
            const e = span.expression;
            if (ts.isIdentifier(e) && consts[e.text] !== undefined) s += consts[e.text]; else s += '${' + e.getText() + '}';
            s += span.literal.text;
        }
        return s;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = evalTemplate(node.left, consts), r = evalTemplate(node.right, consts);
        if (l !== undefined && r !== undefined) return l + r;
    }
    if (ts.isIdentifier(node) && consts[node.text] !== undefined) return consts[node.text];
    return undefined;
}
const APP_PATH_RE = /^(\/app\/(dist|src|test|server|scripts)\/|\.?\/?dist\/(workers|server|bot|utils|schemas|scripts)\/)/;
const APP_PATH_INLINE = /['"`](\/app\/(?:dist|src|test)\/[^'"`\s]*|(?:\.\/)?dist\/(?:workers|server|bot|utils|schemas|scripts|domain_events|widgets)\/[^'"`\s]*)['"`]/g;

// Analyse one JS module's use of application modules
function appUsage(file, text) {
    const sf = parse(file, text);
    const consts = constStrings(sf);
    const modules = new Map(); // path -> {names:Set, via:Set, lines:[]}
    const add = (p, via, names, line) => {
        const key = p.replace(/^\.\//, '/app/').replace(/^dist\//, '/app/dist/');
        if (!modules.has(key)) modules.set(key, { names: new Set(), via: new Set(), lines: [] });
        const m = modules.get(key);
        m.via.add(via); names.forEach((n) => m.names.add(n)); if (m.lines.length < 6) m.lines.push(line);
    };
    const nsBindings = new Map(); // identifier -> module path
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
            const spec = strValue(node.moduleSpecifier);
            if (spec && APP_PATH_RE.test(spec)) {
                const names = [];
                const c = node.importClause;
                if (c?.name) names.push('default');
                if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text));
                if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) nsBindings.set(c.namedBindings.name.text, spec);
                add(spec, 'import', names, lineOf(sf, node));
            }
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const a0 = node.arguments[0];
            const s0 = a0 ? evalTemplate(a0, consts) : undefined;
            if (callee.kind === ts.SyntaxKind.ImportKeyword && s0 && APP_PATH_RE.test(s0)) {
                const names = [];
                let p = node.parent;
                while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
                if (p && ts.isVariableDeclaration(p)) {
                    if (ts.isObjectBindingPattern(p.name)) p.name.elements.forEach((e) => names.push((e.propertyName ?? e.name).getText(sf)));
                    else if (ts.isIdentifier(p.name)) nsBindings.set(p.name.text, s0);
                } else if (p && ts.isPropertyAccessExpression(p)) names.push(p.name.text);
                add(s0, 'dynamic import', names, lineOf(sf, node));
            } else if (ts.isIdentifier(callee) && ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'execSync'].includes(callee.text)) {
                // spawn(node, ['/app/dist/x.js']) or spawn('node', ['--test', ...])
                const argsText = node.arguments.map((a) => a.getText(sf)).join(' ');
                const arr = node.arguments.find((a) => ts.isArrayLiteralExpression(a));
                const vals = arr ? arr.elements.map((e) => evalTemplate(e, consts)).filter(Boolean) : [];
                const strs = [s0, ...vals].filter(Boolean);
                const appPaths = strs.filter((s) => APP_PATH_RE.test(s));
                const isTest = strs.includes('--test') || /--test/.test(argsText);
                for (const ap of appPaths) add(ap, /\.test\.js$/.test(ap) || isTest ? 'runs compiled node:test file' : 'spawns app entrypoint/script', [], lineOf(sf, node));
                if (!appPaths.length) {
                    for (const m of argsText.matchAll(APP_PATH_INLINE)) add(m[1], 'spawns app entrypoint/script', [], lineOf(sf, node));
                }
            } else if (ts.isPropertyAccessExpression(callee) || ts.isIdentifier(callee)) {
                const fname = ts.isIdentifier(callee) ? callee.text : callee.name.text;
                if (/^(readFile|readFileSync|readdir|readdirSync|stat|statSync|existsSync|access|createReadStream)$/.test(fname) && s0 && APP_PATH_RE.test(s0)) add(s0, 'reads compiled/app file', [], lineOf(sf, node));
                if (fname === 'require' && s0 && APP_PATH_RE.test(s0)) add(s0, 'require', [], lineOf(sf, node));
            }
        } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && nsBindings.has(node.expression.text)) {
            const mp = nsBindings.get(node.expression.text);
            const key = mp.replace(/^\.\//, '/app/').replace(/^dist\//, '/app/dist/');
            if (modules.has(key)) modules.get(key).names.add(node.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    // anything else that mentions an app path textually (e.g. inside arrays passed around)
    for (const m of text.matchAll(APP_PATH_INLINE)) {
        const key = m[1].replace(/^\.\//, '/app/').replace(/^dist\//, '/app/dist/');
        if (![...modules.keys()].some((k) => k === key)) add(m[1], 'path literal (other use)', [], text.slice(0, m.index).split('\n').length);
    }
    return modules;
}

function modulePurpose(p, names, via) {
    if (via.has('runs compiled node:test file')) return 'runs compiled unit test';
    if (via.has('spawns app entrypoint/script')) return /workers\/|cron\.index/.test(p) ? 'spawns app worker/entrypoint' : /scripts\//.test(p) ? 'spawns app script (migration/maintenance)' : 'spawns app entrypoint';
    if (via.has('reads compiled/app file') && via.size === 1) return 'reads app file';
    if (via.has('path literal (other use)') && via.size === 1) return 'path literal';
    if (/\/schemas?\/|\.schema\.js$|\/models?\//.test(p)) return 'schema/model (seed/read via Mongoose)';
    if (/utils\/databases\//.test(p)) return 'db connection helper';
    const ns = [...names];
    if (ns.length && ns.every((n) => /^[A-Z0-9_]+$|Key$|Keys$|KEY|Prefix$|PREFIX|^default$/.test(n)) && !ns.includes('default')) return 'constants/key builders';
    return 'calls internal functions';
}

const PROVIDER_HOST_RE = /\b(?:[a-z0-9-]+\.)+(?:tv|sh|ai|com|io|net|org|audio|dev|cloud|test|invalid|local|co)\b/g;
const HOST_NOISE = /^(example\.(com|test|org)|www\.w3\.org|schemas\.|json-schema|github\.com|domdimabot\.com|docs\.domdimabot\.com|.*\.domdimabot\.com|localhost)$/;
function mockInfo(texts) {
    const all = texts.join('\n');
    const mech = [];
    if (/globalThis\.fetch\s*=(?!=)/.test(all)) mech.push('globalThis.fetch override');
    if (/\b(page|context)\.route\(|routeFromHAR|route\.fulfill/.test(all)) mech.push('Playwright route interception');
    if (/routeWebSocket|WebSocketRoute/.test(all)) mech.push('Playwright WebSocket routing');
    if (/createServer\(|\.listen\(\s*0|\.listen\(\s*\d{4}/.test(all)) mech.push('local fake HTTP/socket server in check');
    if (/mock\.module|mock\.method/.test(all)) mech.push('node:test mock in preload');
    if (/Module\._load|register\(|registerHooks|resolve\s*\(\s*specifier/.test(all)) mech.push('module loader hook');
    const hosts = [...new Set((all.match(PROVIDER_HOST_RE) || []).filter((h) => !HOST_NOISE.test(h) && !/\.(js|mjs|json|ts|png|svg|css|html|py|md|wav|mp3|webp|jpg|ttf|woff2?)$/.test(h) && !/^(node|process|assert|console|page|context|res|req|url|fs|path)\./.test(h)))].sort();
    return { mechanisms: mech, hosts: hosts.slice(0, 30) };
}

function inferTarget(name, text, header, doc, appMods, kind, envNames = []) {
    const ev = [];
    const targets = new Set();
    for (const d of doc) for (const t of d.targets) { targets.add(t); ev.push(`docs:${d.doc}`); }
    const st = [...text.matchAll(/SAAS_TARGET\s*(?:===|!==|==|,)\s*['"]([a-z-]+)['"]/g)].map((m) => m[1]).filter((t) => TARGET_NAMES.includes(t));
    const st2 = [...text.matchAll(/\[\s*((?:'[a-z-]+'\s*,?\s*)+)\]\.includes\(\s*process\.env\.SAAS_TARGET/g)].flatMap((m) => m[1].match(/[a-z-]+/g));
    for (const t of [...st, ...st2]) if (TARGET_NAMES.includes(t)) { targets.add(t); ev.push('SAAS_TARGET branch'); }
    const hm = [...header.matchAll(/verify\s+([a-z-]+?)-(?:<|[0-9a-f]{12}|RUN)/g)].map((m) => m[1]);
    const hm2 = [...header.matchAll(/\b(API|api|bot|Bot|cron|Cron|site|admin|Admin|docs|Docs|piper|embeddings|analytics|hoststats|dimadb|dimafx-server)\b (?:candidate|check|target|image|container|behaviou?r|bundle|preview|panel)\b/g)].map((m) => m[1].toLowerCase());
    if (/\bdimasite\b/.test(header)) hm2.push('site');
    for (const m of header.matchAll(/\b((?:api|bot|cron)(?:\s*(?:\/|,|and|or)\s*(?:api|bot|cron))+)\b/gi)) hm2.push(...m[1].toLowerCase().match(/api|bot|cron/g));
    for (const m of header.matchAll(/\b(api|bot|cron)\s+(?:and|or)\s+(api|bot|cron)\s+candidates?/gi)) hm2.push(m[1].toLowerCase(), m[2].toLowerCase());
    if (/docker exec[^\n]*dima-bot/.test(header)) hm2.push('bot');
    if (/docker exec[^\n]*dima-server/.test(header)) hm2.push('api');
    for (const t of [...hm, ...hm2]) if (TARGET_NAMES.includes(t)) { targets.add(t); ev.push('header'); }
    if (!targets.size) {
        const pv = /SAAS_PREVIEW_URL/.test(text);
        const lname = name.toLowerCase();
        const frontend = (pv || kind === 'BROWSER') && !appMods.size && !/TTS_OVERLAY_HTML|SAAS_CLIP_HTML|routes\/public\//.test(text);
        if (frontend) {
            const segs = [...text.matchAll(/goto\(\s*(?:`\$\{\s*\w+\s*\}|\w+\s*\+\s*['"`])\/([a-z0-9-]+)/g)].map((m) => m[1]);
            const ADMIN_ONLY = ['users', 'channels', 'read-tool', 'email-test', 'access-denied'];
            const siteOnly = /admin-hub/.test(lname) || segs.some((x) => ['admin-hub', 'mocks', 'tip', 'commands', 'landing'].includes(x)) || /\$\{\s*(streamer|login|channel)\s*\}\//.test(text);
            if (siteOnly && !/(^admin-|-admin(-browser)?\.mjs$)/.test(lname)) { targets.add('site'); ev.push('site-only route (streamer/admin-hub/mocks/tip)'); }
            else if (segs.some((x) => ADMIN_ONLY.includes(x)) || /admin\/dist|admin candidate|admin bundle|served admin|admin site/i.test(text)) { targets.add('admin'); ev.push('admin-only route/admin bundle reference'); }
            else if (/(^admin-|-admin(-browser)?\.mjs$)/.test(lname) && !siteOnly) { targets.add('admin'); ev.push('name:*-admin / admin-* (no site-only route)'); }
            else if (/docs|llms|_visuals/.test(lname) || /\bdocs?\b/i.test(header)) { targets.add('docs'); ev.push('name/header:docs + SAAS_PREVIEW_URL'); }
            else { targets.add('site'); ev.push('frontend preview (default site; no admin-only route)'); }
        }
        else if (envNames.some((e) => TARGET_NAMES.includes(e))) { envNames.filter((e) => TARGET_NAMES.includes(e)).forEach((e) => targets.add(e)); ev.push('test-env file name'); }
        else if (/cron\.index|native-cron-fixture|cron-boot|\/app\/dist\/workers\/|dima-cron|cron_index/.test(text)) { targets.add('cron'); ev.push('content:cron supervisor/workers'); }
        else if (/\bpg\b'|from 'pg'|\/app\/src\/infrastructure|:3210\b/.test(text)) { targets.add('analytics'); ev.push('content:analytics'); }
        else if (/:3211\b|hoststats/.test(lname + text.slice(0, 2000))) { targets.add('hoststats'); ev.push('content:hoststats'); }
        else if (/^piper/.test(lname)) { targets.add('piper'); ev.push('name'); }
        else if (/^embeddings/.test(lname)) { targets.add('embeddings'); ev.push('name'); }
        else if (/dimadb/.test(lname)) { targets.add('dimadb'); ev.push('name'); }
        else if (/dimafx-server|dimafx\.test-env|:8080\b/.test(lname + text.slice(0, 3000)) && !pv) { targets.add('dimafx-server'); ev.push('content:dimafx-server'); }
        else if (/TTS_OVERLAY_HTML|SAAS_CLIP_HTML|routes\/public\//.test(text)) { targets.add('api'); ev.push('content:static HTML served by the API image'); }
        else if ((pv || kind === 'BROWSER') && !appMods.size) {
            const segs = [...text.matchAll(/goto\(\s*(?:`\$\{\s*\w+\s*\}|\w+\s*\+\s*['"`])\/([a-z0-9-]+)/g)].map((m) => m[1]);
            const ADMIN_ONLY = ['observability', 'users', 'channels', 'read-tool', 'email-test', 'access-denied'];
            if (segs.some((x) => ADMIN_ONLY.includes(x)) || /['"`]\/observability|admin\/dist|admin candidate|admin bundle|served admin/i.test(text)) { targets.add('admin'); ev.push('admin-only route/admin bundle reference'); }
            else if (/docs|llms|_visuals/.test(lname) || /\bdocs?\b/i.test(header)) { targets.add('docs'); ev.push('name/header:docs + SAAS_PREVIEW_URL'); }
            else { targets.add('site'); ev.push('frontend preview (default site; no admin-only route)'); }
        } else if (/127\.0\.0\.1:3000|localhost:3000|PUBLIC_API_URL|\/app\/dist\/server\//.test(text)) { targets.add('api'); ev.push('content:api loopback/server modules'); }
        else if (/\/app\/dist\/bot\/|dist\/bot\/index/.test(text)) { targets.add('bot'); ev.push('content:bot modules'); }
        else if (/(^|-)bot(-|\.)/.test(lname)) { targets.add('bot'); ev.push('name:bot'); }
        else if (/(^|-)(cron|worker|workers)(-|\.)/.test(lname)) { targets.add('cron'); ev.push('name:cron/worker'); }
        else if (appMods.size) { targets.add('api'); ev.push('weak:imports /app/dist only (assumed api; api/bot/cron share one dimabot image)'); }
    }
    return { targets: [...targets].sort(), evidence: [...new Set(ev)] };
}

function findFixtureDir(name, text, header, doc, isFrontend = false) {
    const found = new Set();
    for (const d of doc) d.fixtures.forEach((f) => found.add(f));
    for (const m of (header + '\n' + text.slice(0, 4000)).matchAll(/(?:ops\/checks\/)?([A-Za-z0-9_.-]+-fixtures|ast_global)\b/g)) if (fixtureDirs.includes(m[1])) found.add(m[1]);
    found.inferred = false;
    if (!found.size && !isFrontend && !/-(suite|site|admin)\.mjs$/.test(name)) {
        found.inferred = true;
        const stem = name.replace(/\.(mjs|py|sh)$/, '');
        const cands = [stem, stem.replace(/s$/, ''), stem.replace(/-(api|browser|site|rust|worker|cron|bot|admin|docs|production|ui|backend|runtime|e2e|live|provider|regressions)$/, ''), stem.replace(/-[a-z]+$/, ''), stem.replace(/-[a-z]+-[a-z]+$/, '')];
        for (const c of cands) { if (fixtureDirs.includes(c + '-fixtures')) { found.add(c + '-fixtures'); break; } if (fixtureDirs.includes(c)) { found.add(c); break; } }
    }
    const out = [...found];
    out.inferred = found.inferred && out.length > 0;
    return out;
}

const checkRecords = [];
const fixtureUse = new Map();
for (const name of topChecks) {
    const file = path.join(CHECKS, name);
    const text = read(file);
    const header = headerComment(text);
    const doc = docRefs.get(name) ?? [];
    // saas-ops rejects --fixtures/--test-env/--dependency for website targets (saas_ops.py verify): frontend checks run on the host
    const isFrontend = (/SAAS_PREVIEW_URL|playwright|chromium/.test(text)) && !/\/app\/(dist|package\.json)/.test(text);
    const fixtures = findFixtureDir(name, text, header, doc, isFrontend);
    fixtures.forEach((f) => { if (!fixtureUse.has(f)) fixtureUse.set(f, []); fixtureUse.get(f).push(name); });
    // fixture files: code inside the candidate (preloads, helpers)
    const fixtureFiles = fixtures.flatMap((d) => walk(path.join(CHECKS, d), () => true));
    const fixtureCode = fixtureFiles.filter((f) => /\.(mjs|js|py|sh)$/.test(f));
    const testEnvFiles = new Set();
    for (const d of doc) d.testEnv.forEach((t) => testEnvFiles.add(t.replace(/^.*ops\/checks\//, '')));
    for (const m of header.matchAll(/--test-env\s+(\S+)/g)) testEnvFiles.add(m[1].replace(/^.*ops\/checks\//, '').replace(/[`'".,]+$/, ''));
    if (!isFrontend) for (const f of fixtureFiles) if (/(^|\/)test-env[^/]*\.json$|env\.json$/.test(f)) testEnvFiles.add(path.relative(CHECKS, f));
    if (isFrontend) testEnvFiles.clear();
    const envs = [...testEnvFiles].map((t) => { const p = path.join(CHECKS, t); return fs.existsSync(p) ? { file: t, json: JSON.parse(read(p)) } : { file: t, missing: true }; });
    const preloads = [...new Set(envs.flatMap((e) => (e.json?.NODE_OPTIONS ?? '').match(/--import[= ](\S+)/g) ?? []).map((s) => s.replace(/--import[= ]/, '')))];
    // dependencies
    const deps = new Set();
    const depsAllowed = !isFrontend;
    const depEv = [];
    for (const d of doc) d.deps.forEach((x) => { deps.add(x); depEv.push('docs'); });
    for (const m of header.matchAll(/--dependency\s+(mongo|redis|postgres)/g)) { deps.add(m[1]); depEv.push('header'); }
    const envText = JSON.stringify(envs.map((e) => e.json ?? {}));
    if (/mongodb:\/\/mongo|MONGO_URI|getMongoDBConnection|mongoose|\bMongoClient\b|require\('mongodb'\)/.test(text + envText) && !/SAAS_PREVIEW_URL/.test(text.slice(0, 1500))) { if (!deps.has('mongo')) depEv.push('inferred mongo'); deps.add('mongo'); }
    if (/redis:\/\/redis|DRAGONFLY_HOST|getDragonflyClient|createClient\(/.test(text + envText) && !/SAAS_PREVIEW_URL/.test(text.slice(0, 1500))) { if (!deps.has('redis')) depEv.push('inferred redis'); deps.add('redis'); }
    if (/from 'pg'|postgres:\/\/|POSTGRES|PG_/.test(text + envText)) { if (!deps.has('postgres')) depEv.push('inferred postgres'); deps.add('postgres'); }
    // app usage in the check itself and in fixture code (preloads/behaviour modules executed in the candidate)
    const ownMods = /\.mjs$/.test(name) ? appUsage(file, text) : new Map();
    if (/\.(py|sh)$/.test(name)) for (const m of text.matchAll(/['"`](\/app\/(?:dist|src)\/[^'"`\s]*)['"`]/g)) ownMods.set(m[1], { names: new Set(), via: new Set(['path literal (other use)']), lines: [] });
    const fixtureMods = new Map();
    for (const f of fixtureCode.filter((f) => /\.(mjs|js)$/.test(f))) {
        for (const [k, v] of appUsage(f, read(f))) {
            if (!fixtureMods.has(k)) fixtureMods.set(k, { names: new Set(), via: new Set(), files: new Set() });
            const fm = fixtureMods.get(k); v.names.forEach((n) => fm.names.add(n)); v.via.forEach((n) => fm.via.add(n)); fm.files.add(path.relative(CHECKS, f));
        }
    }
    const imageNodeModules = [...new Set([...text.matchAll(/createRequire\(\s*['"]\/app\/package\.json['"]\s*\)\s*(?:\(\s*['"]([^'"]+)['"]|)/g)].map((m) => m[1]).filter(Boolean))];
    // also `const require = createRequire('/app/package.json'); require('x')`
    if (/createRequire\(\s*['"]\/app\/package\.json['"]\s*\)/.test(text)) for (const m of text.matchAll(/\brequire\(\s*['"]([a-z@][^'"]*)['"]\s*\)/g)) imageNodeModules.push(m[1]);
    for (const m of text.matchAll(/['"]\/app\/node_modules\/([^/'"]+(?:\/[^/'"]+)?)/g)) imageNodeModules.push(m[1].startsWith('@') ? m[1] : m[1].split('/')[0]);
    const browser = /playwright|chromium|axe-core/.test(text);
    const appMods = new Map([...ownMods]);
    let kind;
    const usesPreview = /SAAS_PREVIEW_URL/.test(text);
    const containerTarget = !usesPreview;
    if (browser) kind = 'BROWSER';
    else if (ownMods.size || [...fixtureMods.values()].some((v) => [...v.via].some((x) => x !== 'path literal (other use)'))) kind = 'IMPORTS-APP';
    else if (/\.(py)$/.test(name) && usesPreview) kind = 'BLACK-BOX';
    else if (/fetch\(|http:\/\/|WebSocket|socket\.io|createConnection|MongoClient|createClient|urlopen|urllib|net\.connect/.test(text)) kind = 'BLACK-BOX';
    else kind = 'OTHER';
    // browser API mode
    let browserApi;
    if (browser) {
        const routes = /\.route\(|routeWebSocket/.test(text);
        const live = /127\.0\.0\.1:3000|SAAS_API_URL|API_BASE|PUBLIC_API_URL/.test(text) && !routes;
        browserApi = routes ? 'mocked (Playwright route interception)' : live ? 'needs live backend' : 'no API traffic (static bundle)';
        if (ownMods.size) browserApi += '; also imports app modules';
    }
    const other = [];
    if (kind === 'OTHER' || kind === 'BLACK-BOX') {
        if (/readFileSync\(|readFile\(/.test(text) && /\/root\/saas|repo|\.\.\/\.\.\//.test(text)) other.push('reads repository source');
        if (/npm (test|run)|node --test/.test(text)) other.push('runs a test runner');
    }
    const mocks = mockInfo([text, ...fixtureCode.filter((f) => /\.(mjs|js)$/.test(f)).map(read)]);
    if (preloads.length) mocks.mechanisms.unshift('NODE_OPTIONS --import preload inside the app process');
    const target = inferTarget(name, text, header, doc, new Map([...ownMods, ...fixtureMods]), kind, envs.map((e) => path.basename(e.file).replace(/-?env\.json$|\.test-env\.json$|test-env\.json$/, '')));
    const passGroups = (text.match(/console\.log\(\s*[`'"]PASS|\bpass\(|print\(\s*f?["']PASS|ok\(['"`]/g) || []).length;
    const asserts = (text.match(/\bassert(\.[a-zA-Z]+)?\(|\bexpect\(|\bassert\s/g) || []).length;
    const toObj = (m) => [...m].map(([k, v]) => ({ module: k, names: [...v.names].sort(), via: [...v.via].sort(), purpose: modulePurpose(k, v.names, v.via), ...(v.files ? { fixture_files: [...v.files].sort() } : { lines: v.lines }) }));
    checkRecords.push({
        file: 'ops/checks/' + name,
        lines: countLines(text),
        targets: target.targets,
        target_evidence: target.evidence,
        kind,
        browser_api: browserApi,
        other_notes: other,
        header: header.replace(/\s+/g, ' ').trim().slice(0, 300),
        fixtures_dirs: fixtures,
        fixtures_inferred_from_name: !!fixtures.inferred,
        fixture_files: fixtureFiles.map((f) => path.relative(CHECKS, f)).sort(),
        test_env: envs.map((e) => ({ file: e.file, keys: e.json ? Object.keys(e.json) : [], node_options: e.json?.NODE_OPTIONS })),
        preload_hooks: preloads,
        dependencies: depsAllowed ? [...deps].sort() : [],
        frontend_host_check: isFrontend,
        dependency_evidence: [...new Set(depEv)],
        image_node_modules: [...new Set(imageNodeModules)].sort(),
        app_modules: toObj(ownMods),
        fixture_app_modules: toObj(fixtureMods),
        mocks,
        documented_in: [...new Set(doc.map((d) => d.doc))],
        coverage: { pass_groups: passGroups, asserts },
        container_check: containerTarget,
    });
}

// Second pass: suite runners (spawn/import other checks) and shared helper modules
const byName = new Map(checkRecords.map((r) => [r.file.slice('ops/checks/'.length), r]));
for (const r of checkRecords) {
    const name = r.file.slice('ops/checks/'.length);
    const text = read(path.join(CHECKS, name));
    const header = headerComment(text);
    const children = new Set();
    for (const other of byName.keys()) {
        if (other === name) continue;
        const stem = other.replace(/\.(mjs|py|sh)$/, '');
        if (new RegExp(`['"\`/]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.mjs)?['"\`]`).test(text)) children.add(other);
    }
    for (const m of text.matchAll(/([A-Za-z0-9_-]+-)\$\{\w+\}\.mjs/g)) {
        const arr = text.match(/\[\s*((?:'[a-z0-9-]+'\s*,?\s*)+)\]/);
        if (arr) for (const v of arr[1].match(/[a-z0-9-]+/g)) if (byName.has(m[1] + v + '.mjs')) children.add(m[1] + v + '.mjs');
    }
    const importedOnly = [...children].filter((c) => new RegExp(`import[^;]*${c.replace('.', '\\.')}`).test(text) && !/spawn|execFile|import\(pathToFileURL/.test(text));
    const runsChildren = /spawn|execFile|spawnSync|pathToFileURL|await import\(/.test(text) && children.size;
    r.role = /not a check itself|Shared helpers|^\/\/ Fake Studio backends/m.test(header) || name === 'native-cron-fixture.mjs' ? 'helper' : runsChildren && r.coverage.asserts <= 3 ? 'suite' : 'check';
    r.runs_or_imports_checks = [...children].sort();
}
for (let pass = 0; pass < 3; pass++) for (const r of checkRecords) if (r.role === 'suite' && !r.targets.length) {
    const t = new Set(r.runs_or_imports_checks.flatMap((c) => byName.get(c)?.targets ?? []));
    if (t.size) { r.targets = [...t].sort(); r.target_evidence.push('union of child checks'); }
}
for (const r of checkRecords) if (!r.targets.length) {
    if (/stripTypeScriptTypes|\.\.\/\.\.\/admin\/src|new URL\('\.\.\/\.\.\/'/.test(read(path.join(REPO, r.file)))) { r.targets = ['repo-source']; r.target_evidence.push('reads repository source on the host; no candidate'); }
    else if (r.kind === 'BROWSER') { r.targets = ['site']; r.target_evidence.push('browser default'); }
}

// Bucket IMPORTS-APP checks by how hard they are to make black-box.
const SEED_PURPOSES = new Set(['schema/model (seed/read via Mongoose)', 'db connection helper', 'constants/key builders', 'path literal', 'reads app file']);
const SETUP_NAME = /^(encrypt|decrypt|journalDomainEvent|ingestDomainEvent|populateAdminCache|addAdminToRoleCache|clearChannelRoleCache|invalidate\w*|upsert\w*|createDefault\w*|buildDefault\w*|\w*Key|\w*Keys|get(MongoDBConnection|DragonflyClient)|default)$/;
for (const r of checkRecords) {
    const text = read(path.join(REPO, r.file));
    r.talks_to_candidate_network = /127\.0\.0\.1:(3000|8080|5000|3210|3211|80)\b|localhost:(3000|8080)|PUBLIC_API_URL|INTERNAL_API_URL|socket\.io-client|new WebSocket\(|\bio\(\s*['"`]http/.test(text);
    if (r.kind !== 'IMPORTS-APP') continue;
    const mods = [...r.app_modules, ...r.fixture_app_modules.map((m) => ({ ...m, from_fixture: true }))];
    const internals = [];
    for (const m of mods) {
        if (m.purpose !== 'calls internal functions') continue;
        const names = m.names.length ? m.names : ['(namespace/unknown)'];
        const real = names.filter((n) => !SETUP_NAME.test(n));
        if (real.length) internals.push({ module: m.module.replace('/app/dist/', ''), names: real, from_fixture: !!m.from_fixture });
    }
    const purposes = new Set(mods.map((m) => m.purpose));
    const setupOnlyInternals = mods.some((m) => m.purpose === 'calls internal functions') && !internals.length;
    let bucket;
    if ([...purposes].every((p) => SEED_PURPOSES.has(p))) bucket = 'A seed/connect only';
    else if (setupOnlyInternals && [...purposes].every((p) => SEED_PURPOSES.has(p) || p === 'calls internal functions')) bucket = 'B seed + setup helpers (encrypt, journal/ingest event, cache keys)';
    else if (!internals.length && [...purposes].some((p) => p.startsWith('spawns'))) bucket = 'E spawns app worker/script/entrypoint';
    else if (!internals.length && purposes.has('runs compiled unit test')) bucket = 'D runs compiled node:test files from /app/dist';
    else if (internals.every((i) => i.from_fixture) && internals.length) bucket = 'F internals only in NODE_OPTIONS preload/fixture (boot hooks)';
    else bucket = 'C drives internals in-process';
    r.imports_app_bucket = bucket;
    r.internal_calls = internals;
    r.runs_compiled_tests = mods.filter((m) => m.purpose === 'runs compiled unit test').map((m) => m.module.replace('/app/dist/', ''));
    r.spawns_app = mods.filter((m) => m.purpose.startsWith('spawns')).map((m) => m.module.replace('/app/dist/', ''));
}

// Which uncovered sources are at least imported in-process by a behaviour check (black-box coverage is not computable statically)
const checkImports = new Map();
for (const r of checkRecords) for (const m of [...r.app_modules, ...r.fixture_app_modules]) {
    const k = m.module.replace(/^\/app\/dist\//, '').replace(/\.js$/, '');
    if (!checkImports.has(k)) checkImports.set(k, new Set());
    checkImports.get(k).add(r.file);
}
for (const u of uncovered) u.imported_by_checks = [...(checkImports.get(u.file.replace(/\.(ts|tsx|mts|js|mjs)$/, '')) ?? [])].map((f) => f.slice('ops/checks/'.length)).sort();
// Backend targets ordered by behaviour covered (PASS groups, then asserts, then size)
const backendTargetChecks = Object.fromEntries(['api', 'bot', 'cron'].map((t) => [t, checkRecords
    .filter((r) => r.role === 'check' && r.targets.includes(t))
    .sort((a, b) => b.coverage.pass_groups - a.coverage.pass_groups || b.coverage.asserts - a.coverage.asserts || b.lines - a.lines)
    .map((r) => ({ file: r.file, kind: r.kind, bucket: r.imports_app_bucket ?? null, pass_groups: r.coverage.pass_groups, asserts: r.coverage.asserts, lines: r.lines, deps: r.dependencies, preload: r.preload_hooks.length > 0, shared_with: r.targets.filter((x) => x !== t) }))]));

const fixtureRecords = fixtureDirs.map((d) => ({ dir: 'ops/checks/' + d, files: walk(path.join(CHECKS, d), () => true).map((f) => path.relative(path.join(CHECKS, d), f)).sort(), used_by: fixtureUse.get(d) ?? [] }));

// ============================================================================ Part C: ops/tests
const opsTests = fs.readdirSync(path.join(REPO, 'ops/tests')).sort().map((n) => {
    const t = read(path.join(REPO, 'ops/tests', n));
    return { file: 'ops/tests/' + n, lines: countLines(t), cases: (t.match(/^\s*def test_\w+|^\s*(await\s+)?test\(/gm) || []).length };
});

// ============================================================================ totals
const by = (arr, key) => arr.reduce((acc, r) => { const k = typeof key === 'function' ? key(r) : r[key]; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const testsOnly = testRecords.filter((r) => r.role === 'test');
const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
const dirTotals = {};
for (const r of testsOnly) {
    const d = (dirTotals[r.dir] ??= { files: 0, test_calls: 0, PURE: 0, MOCKED: 0, SERVICE: 0 });
    d.files++; d.test_calls += r.cases.test; d[r.classification]++;
}
const out = {
    generated_at: new Date().toISOString(),
    generator: 'dima-rust/tools/ledger/tests_inventory.mjs',
    totals: {
        dimabot_test_files: testsOnly.length,
        dimabot_helper_files: testRecords.length - testsOnly.length,
        by_classification: by(testsOnly, 'classification'),
        test_calls: sum(testsOnly, (r) => r.cases.test),
        subtests: sum(testsOnly, (r) => r.cases.subtests),
        describe_groups: sum(testsOnly, (r) => r.cases.describe),
        test_calls_generated_in_loops_or_helpers: sum(testsOnly, (r) => r.cases.generated_in_loops_or_helpers),
        skipped_static: sum(testsOnly, (r) => r.cases.skipped),
        conditional_skip: sum(testsOnly, (r) => r.cases.conditional_skip),
        files_with_unicode_semantics_hits: testsOnly.filter((r) => r.unicode_semantics.length).length,
        unicode_semantics_hits: sum(testsOnly, (r) => r.unicode_semantics.length),
        by_dir: dirTotals,
        mechanism_files: Object.fromEntries(Object.entries(testsOnly.flatMap((r) => Object.keys(r.mechanisms)).reduce((a, k) => { a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1])),
        nontest_source_files_over_150_lines: nonTestBig,
        nontest_over_150_not_directly_imported: uncovered.length,
        nontest_over_150_not_even_transitively_loaded: uncovered.filter((u) => !u.transitively_loaded_by_tests).length,
        checks: topChecks.length,
        checks_by_kind: by(checkRecords, 'kind'),
        checks_by_role: by(checkRecords, (r) => r.role),
        imports_app_buckets: by(checkRecords.filter((r) => r.kind === 'IMPORTS-APP'), 'imports_app_bucket'),
        checks_by_target: by(checkRecords, (r) => r.targets.join('+') || '(unknown)'),
        check_other_files: topOther,
        fixture_dirs: fixtureDirs.length,
        checks_with_preload_hooks: checkRecords.filter((r) => r.preload_hooks.length).length,
    },
    dimabot_tests: testRecords,
    dimabot_uncovered_sources: uncovered,
    checks: checkRecords,
    backend_target_checks: backendTargetChecks,
    check_fixture_dirs: fixtureRecords,
    ops_tests: opsTests,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out.totals, null, 1));
