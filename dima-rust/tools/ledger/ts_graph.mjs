#!/usr/bin/env node
// Module dependency graph of dimabot/src + proposed Rust work packages.
//
// Usage (from anywhere):  node dima-rust/tools/ledger/ts_graph.mjs [--repo <root>] [--ts <path to typescript>]
// Writes: dima-rust/ledger/modules.json and dima-rust/ledger/modules.md
//
// Read-only on the source tree. Parses with the TypeScript compiler API (syntax only, no type check).
// Re-run after source changes; the package rules (PACKAGE_RULES below) assign new files automatically
// and the script fails loudly if any non-test file ends up in zero or several packages.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(argVal('--repo') ?? path.join(HERE, '../../..'));
const SRC_REL = 'dimabot/src';
const SRC = path.join(REPO, SRC_REL);
const OUT_DIR = path.join(REPO, 'dima-rust/ledger');
const require = createRequire(import.meta.url);
const ts = require(argVal('--ts') ?? path.join(REPO, 'dimabot/node_modules/typescript'));

// ---------------------------------------------------------------- file discovery
const CODE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mjs|js)$|\.(test-data|test-helper|fixture|test_util)\.ts$/;

function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else if (CODE_EXT.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
const srcRel = (relPath) => relPath.slice(SRC_REL.length + 1);

const absFiles = walk(SRC).sort();
const files = new Map(); // repo-relative path -> record
for (const abs of absFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    const p = rel(abs);
    const ext = path.extname(p).slice(1);
    files.set(p, {
        path: p,
        lang: ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext,
        loc: text.split('\n').filter((l) => l.trim() !== '').length,
        isTest: TEST_RE.test(p),
        _text: text,
        _abs: abs,
    });
}

// ---------------------------------------------------------------- import resolution
const BUILTINS = new Set(require('node:module').builtinModules);
function packageName(spec) {
    if (spec.startsWith('node:')) return spec.split('/')[0] === 'node:test' ? 'node:test' : 'node:' + spec.slice(5).split('/')[0];
    if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) return 'node:' + spec.split('/')[0];
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
function resolveRelative(fromAbs, spec) {
    const base = path.resolve(path.dirname(fromAbs), spec);
    const cands = [];
    const m = base.match(/\.(js|jsx|mjs|cjs)$/);
    if (m) {
        const stem = base.slice(0, -m[0].length);
        if (m[1] === 'mjs') cands.push(stem + '.mts');
        if (m[1] === 'cjs') cands.push(stem + '.cts');
        cands.push(stem + '.ts', stem + '.tsx');
    }
    cands.push(base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx'));
    for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
}

// ---------------------------------------------------------------- per-file parse
const unresolved = []; // {from, spec, kind, reason}
function stringOf(node) {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
}
function literalsIn(node) {
    const out = [];
    const visit = (n) => { const s = stringOf(n); if (s !== null) out.push(s); else ts.forEachChild(n, visit); };
    visit(node);
    return out;
}
const isImportMetaUrl = (n) => n && ts.isPropertyAccessExpression(n) && n.name.text === 'url' &&
    ts.isMetaProperty(n.expression) && n.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

function nodeName(n) {
    if (!n) return '?';
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isPropertyAccessExpression(n)) return nodeName(n.expression) + '.' + n.name.text;
    if (ts.isCallExpression(n)) return nodeName(n.expression) + '()';
    if (ts.isElementAccessExpression(n)) return nodeName(n.expression) + '[]';
    if (ts.isParenthesizedExpression(n)) return nodeName(n.expression);
    if (ts.isAwaitExpression(n)) return 'await ' + nodeName(n.expression);
    if (ts.isNonNullExpression(n) || ts.isAsExpression(n)) return nodeName(n.expression);
    return ts.SyntaxKind[n.kind];
}

function parseFile(rec) {
    const kind = rec.lang === 'tsx' ? ts.ScriptKind.TSX : rec.lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(rec._abs, rec._text, ts.ScriptTarget.Latest, true, kind);
    const edges = []; // {spec, type: bool, kind}
    const add = (spec, typeOnly, edgeKind) => edges.push({ spec, typeOnly, kind: edgeKind });
    const side = { topLevelAwait: false, topLevelCalls: [], mutableState: [], singletons: [], timers: [], processHooks: [], mongooseModels: [], mongooseSchemaDecls: [], routers: [], constTables: [] };

    const visit = (node, depthFn) => {
        if (ts.isImportDeclaration(node)) {
            const spec = stringOf(node.moduleSpecifier);
            const c = node.importClause;
            let typeOnly = false;
            if (c) {
                if (c.isTypeOnly) typeOnly = true;
                else if (!c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) &&
                    c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)) typeOnly = true;
            }
            add(spec, typeOnly, c ? 'import' : 'side-effect-import');
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const spec = stringOf(node.moduleSpecifier);
            let typeOnly = node.isTypeOnly;
            if (!typeOnly && node.exportClause && ts.isNamedExports(node.exportClause) &&
                node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly)) typeOnly = true;
            add(spec, typeOnly, 're-export');
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            add(stringOf(node.moduleReference.expression), node.isTypeOnly, 'import-equals');
        } else if (ts.isImportTypeNode(node)) {
            const arg = node.argument;
            const spec = arg && ts.isLiteralTypeNode(arg) ? stringOf(arg.literal) : null;
            add(spec, true, 'import-type-node');
        } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const spec = stringOf(node.arguments[0]);
                if (spec !== null) add(spec, false, 'dynamic-import');
                else {
                    // Computed specifier: accept it only when it is built from relative literals resolved
                    // against import.meta.url (e.g. new URL(cond ? './a.ts' : './a.js', import.meta.url).href).
                    const lits = node.arguments[0] ? literalsIn(node.arguments[0]).filter((s) => /^\.\.?\//.test(s)) : [];
                    const pick = lits.find((s) => /\.tsx?$/.test(s)) ?? lits.find((s) => /\.js$/.test(s));
                    const viaMetaUrl = node.arguments[0] && node.arguments[0].getText(sf).includes('import.meta.url');
                    if (pick && viaMetaUrl) add(pick, false, 'dynamic-import-computed');
                    else unresolved.push({ from: rec.path, spec: node.arguments[0]?.getText(sf).slice(0, 160), kind: 'dynamic-import', reason: 'non-literal specifier' });
                }
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1) {
                const spec = stringOf(node.arguments[0]);
                if (spec !== null) add(spec, false, 'require');
                else unresolved.push({ from: rec.path, spec: node.arguments[0]?.getText(sf).slice(0, 160), kind: 'require', reason: 'non-literal specifier' });
            }
        } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' &&
            node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
            // new URL('./x.ts' | cond ? './x.ts' : './x.js', import.meta.url): runtime file reference (worker thread / fork).
            const lits = literalsIn(node.arguments[0]).filter((s) => /^\.\.?\//.test(s));
            const tsLit = lits.find((s) => /\.tsx?$/.test(s)) ?? lits.find((s) => /\.js$/.test(s));
            if (tsLit) add(tsLit, false, 'runtime-url');
        }
        ts.forEachChild(node, (c) => visit(c));
    };
    visit(sf);

    // top-level side effects / module state
    const hasTopAwait = (n, inFn) => {
        let found = false;
        const v = (x, fn) => {
            if (found) return;
            const isFn = ts.isFunctionLike(x) || ts.isClassLike(x);
            if (!fn && (ts.isAwaitExpression(x) || (ts.isForOfStatement(x) && x.awaitModifier))) { found = true; return; }
            ts.forEachChild(x, (c) => v(c, fn || isFn));
        };
        v(n, inFn);
        return found;
    };
    const usesMongoose = edges.some((e) => e.spec === 'mongoose');
    const SCHEMA_DECL = /\.(index|pre|post|virtual|plugin|method|methods|static|statics|loadClass|set|path|add)$/;
    for (const st of sf.statements) {
        if (hasTopAwait(st, false)) side.topLevelAwait = true;
        if (ts.isExpressionStatement(st)) {
            let e = st.expression;
            if (ts.isAwaitExpression(e)) e = e.expression;
            if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
                const name = nodeName(e.expression);
                if (/^process\.on|^process\.once/.test(name)) side.processHooks.push(name);
                else if (/^setInterval|^setTimeout/.test(name)) side.timers.push(name);
                else if (usesMongoose && (SCHEMA_DECL.test(name) || /^add[A-Z]\w*Fields$/.test(name))) side.mongooseSchemaDecls.push(name);
                else side.topLevelCalls.push(name);
            } else if (ts.isBinaryExpression(e) || ts.isVoidExpression(e)) {
                side.topLevelCalls.push(nodeName(ts.isVoidExpression(e) ? e.expression : e.left) + (ts.isBinaryExpression(e) ? ' =' : ''));
            }
        } else if (ts.isVariableStatement(st)) {
            const isLet = (st.declarationList.flags & ts.NodeFlags.Let) || !(st.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using));
            for (const d of st.declarationList.declarations) {
                const nm = d.name.getText(sf);
                if (isLet) side.mutableState.push(nm);
                let init = d.initializer;
                while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression?.(init))) init = init.expression;
                if (!init) continue;
                if (ts.isNewExpression(init)) {
                    const cls = nodeName(init.expression);
                    if (/^(Map|Set|WeakMap|WeakSet|Array)$/.test(cls)) {
                        if (isLet) continue;
                        if (/^[A-Z0-9_]+$/.test(nm)) side.constTables.push(`${nm} (${cls})`); // constant lookup table
                        else side.mutableState.push(`${nm} (${cls})`);
                    } else if (/(^|\.)Schema$/.test(cls)) side.mongooseSchemaDecls.push(`${nm} = new ${cls}`);
                    else side.singletons.push(`${nm} = new ${cls}`);
                } else if (ts.isCallExpression(init)) {
                    const cn = nodeName(init.expression);
                    if (/^setInterval|^setTimeout/.test(cn)) side.timers.push(`${nm} = ${cn}`);
                    else if (usesMongoose && /(^|\.)model$/.test(cn)) side.mongooseModels.push(nm);
                    else if (/(^|\.)Router$/.test(cn)) side.routers.push(nm);
                    else if (/(createClient|connect|Redis|mongoose\.model|model|express|Router|createServer|initTelemetry|startTelemetry|new)/i.test(cn) && !/^(Symbol|Object\.freeze|z\.|String|Number|Boolean|BigInt)/.test(cn))
                        side.singletons.push(`${nm} = ${cn}(...)`);
                } else if (ts.isAwaitExpression(init)) {
                    side.singletons.push(`${nm} = ${nodeName(init)}`);
                }
            }
        }
    }
    for (const k of Object.keys(side)) if (Array.isArray(side[k])) side[k] = [...new Set(side[k])];
    return { edges, side };
}

// ---------------------------------------------------------------- build graph
const valueEdges = new Map(); // path -> Set(path)
const typeEdges = new Map();
for (const rec of files.values()) {
    const { edges, side } = parseFile(rec);
    rec.sideEffects = side;
    const imports = new Set(), typeImports = new Set(), externals = new Set(), typeExternals = new Set();
    const runtimeRefs = new Set(), nonCodeImports = new Set(), requireEdges = new Set();
    for (const e of edges) {
        if (e.spec == null) { unresolved.push({ from: rec.path, spec: null, kind: e.kind, reason: 'non-literal specifier' }); continue; }
        if (e.spec.startsWith('.') || e.spec.startsWith('/')) {
            const abs = resolveRelative(rec._abs, e.spec);
            if (!abs) { unresolved.push({ from: rec.path, spec: e.spec, kind: e.kind, reason: 'file not found' }); continue; }
            const target = rel(abs);
            if (!files.has(target)) {
                if (!target.startsWith(SRC_REL + '/') || !CODE_EXT.test(target)) nonCodeImports.add(target);
                else unresolved.push({ from: rec.path, spec: e.spec, kind: e.kind, reason: 'resolved outside parsed set: ' + target });
                continue;
            }
            if (e.kind === 'runtime-url' || e.kind === 'dynamic-import-computed') runtimeRefs.add(target);
            if (e.kind === 'require') requireEdges.add(target);
            if (e.typeOnly) typeImports.add(target); else imports.add(target);
        } else {
            (e.typeOnly ? typeExternals : externals).add(packageName(e.spec));
        }
    }
    for (const v of imports) typeImports.delete(v); // a value edge subsumes a type edge
    for (const v of externals) typeExternals.delete(v);
    rec.imports = [...imports].sort();
    rec.typeImports = [...typeImports].sort();
    rec.externals = [...externals].sort();
    rec.typeExternals = [...typeExternals].sort();
    if (runtimeRefs.size) rec.runtimeRefs = [...runtimeRefs].sort();
    if (requireEdges.size) rec.requireImports = [...requireEdges].sort();
    if (nonCodeImports.size) rec.nonCodeImports = [...nonCodeImports].sort();
    valueEdges.set(rec.path, imports);
    typeEdges.set(rec.path, new Set([...imports, ...typeImports]));
}
for (const rec of files.values()) { rec.importedBy = 0; rec.importedByValue = 0; rec.importedByNonTest = 0; }
for (const rec of files.values()) {
    for (const t of new Set([...rec.imports, ...rec.typeImports])) {
        const tr = files.get(t);
        tr.importedBy++;
        if (!rec.isTest) tr.importedByNonTest++;
        if (rec.imports.includes(t)) tr.importedByValue++;
    }
}

// ---------------------------------------------------------------- entries + reachability
const P = (s) => `${SRC_REL}/${s}`;
const entries = []; // {id, path, process}
entries.push({ id: 'api', path: P('server/index.ts'), process: 'api' });
entries.push({ id: 'bot', path: P('bot/index.ts'), process: 'bot' });
entries.push({ id: 'cron:supervisor', path: P('workers/cron.index.ts'), process: 'cron' });
{
    // Read the WORKERS array from the supervisor (AST), not a hard-coded list.
    const rec = files.get(P('workers/cron.index.ts'));
    const sf = ts.createSourceFile(rec._abs, rec._text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found = [];
    const visit = (n) => {
        if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'WORKERS' && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
            for (const el of n.initializer.elements) {
                if (!ts.isObjectLiteralExpression(el)) continue;
                const o = {};
                for (const pr of el.properties) if (ts.isPropertyAssignment(pr)) o[pr.name.getText(sf)] = stringOf(pr.initializer);
                found.push(o);
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found.length) throw new Error('WORKERS array not found in workers/cron.index.ts');
    for (const w of found) entries.push({ id: `cron:${w.name}`, path: `dimabot/${w.sourceEntry}`, process: 'cron', enabledEnv: w.enabledEnv ?? null, distEntry: w.distEntry });
    // Every workers/*.worker.ts must be registered; report extras as their own (unregistered) entries.
    for (const p of files.keys()) {
        if (/^dimabot\/src\/workers\/[^/]+\.worker\.ts$/.test(p) && !found.some((w) => `dimabot/${w.sourceEntry}` === p))
            entries.push({ id: `cron:UNREGISTERED:${path.basename(p, '.worker.ts')}`, path: p, process: 'cron' });
    }
}
for (const p of files.keys()) {
    const m = p.match(/^dimabot\/src\/scripts\/([^/]+)\.script\.(ts|mjs|js)$/);
    if (m) entries.push({ id: `script:${m[1]}`, path: p, process: 'script' });
}
for (const e of entries) if (!files.has(e.path)) throw new Error('entry file missing: ' + e.path);

function reach(start, edgeMap) {
    const seen = new Set([start]); const stack = [start];
    while (stack.length) { const c = stack.pop(); for (const n of edgeMap.get(c) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); } }
    return seen;
}
for (const rec of files.values()) { rec.reachableFrom = []; rec.reachableFromWithTypes = []; }
for (const e of entries) {
    for (const p of reach(e.path, valueEdges)) files.get(p).reachableFrom.push(e.id);
    for (const p of reach(e.path, typeEdges)) files.get(p).reachableFromWithTypes.push(e.id);
}
const procOf = (ids) => {
    const s = new Set();
    for (const id of ids) {
        if (id === 'api') s.add('api'); else if (id === 'bot') s.add('bot'); else if (id.startsWith('cron:')) s.add('cron'); else if (id.startsWith('script:')) s.add('script');
    }
    return s;
};
for (const rec of files.values()) {
    rec.processes = [...procOf(rec.reachableFrom)].sort();
    rec.processesWithTypes = [...procOf(rec.reachableFromWithTypes)].sort();
    rec.orphan = rec.reachableFrom.length === 0 && !rec.isTest;
    rec.orphanEvenWithTypes = rec.reachableFromWithTypes.length === 0 && !rec.isTest;
    rec.looksLikeTest = !rec.isTest && (rec.externals.includes('node:test') || rec.sideEffects.topLevelCalls.some((c) => /^(describe|it|test)$/.test(c)));
    rec.testOnly = !rec.isTest && rec.orphan && [...files.values()].some((o) => o.isTest && (o.imports.includes(rec.path) || o.typeImports.includes(rec.path)));
}

// ---------------------------------------------------------------- SCC (Tarjan, iterative) + layers
function scc(nodes, edgeMap) {
    let index = 0; const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], comps = [];
    for (const root of nodes) {
        if (idx.has(root)) continue;
        const work = [[root, 0]];
        idx.set(root, index); low.set(root, index); index++; stack.push(root); onStack.add(root);
        while (work.length) {
            const frame = work[work.length - 1];
            const [v] = frame;
            const nbrs = [...(edgeMap.get(v) ?? [])].filter((n) => nodes.has(n));
            if (frame[1] < nbrs.length) {
                const w = nbrs[frame[1]++];
                if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w); work.push([w, 0]); }
                else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
            } else {
                work.pop();
                if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
                if (low.get(v) === idx.get(v)) {
                    const comp = []; let w;
                    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
                    comps.push(comp.sort());
                }
            }
        }
    }
    return comps;
}
const nonTest = new Set([...files.values()].filter((r) => !r.isTest).map((r) => r.path));
const allPaths = new Set(files.keys());
const compsAll = scc(nonTest, typeEdges);          // value + type edges, non-test files
const compsValue = scc(nonTest, valueEdges);       // value edges only
const valueCycleKey = new Map();
for (const c of compsValue) if (c.length > 1) for (const p of c) valueCycleKey.set(p, c);
const cycles = compsAll.filter((c) => c.length > 1).map((c, i) => {
    const valueSubcycles = compsValue.filter((v) => v.length > 1 && v.every((p) => c.includes(p)));
    return { id: `C${String(i + 1).padStart(2, '0')}`, size: c.length, loc: c.reduce((s, p) => s + files.get(p).loc, 0),
        files: c, valueOnlySubcycles: valueSubcycles };
}).sort((a, b) => b.size - a.size || b.loc - a.loc).map((c, i) => ({ ...c, id: `C${String(i + 1).padStart(2, '0')}` }));
const testCycles = scc(allPaths, typeEdges).filter((c) => c.length > 1 && c.some((p) => files.get(p).isTest));
const compOf = new Map();
compsAll.forEach((c, i) => c.forEach((p) => compOf.set(p, i)));
const compDepth = new Map();
function depthOf(ci) {
    if (compDepth.has(ci)) return compDepth.get(ci);
    compDepth.set(ci, 0);
    let d = 0;
    for (const p of compsAll[ci]) for (const n of typeEdges.get(p)) {
        if (!nonTest.has(n)) continue;
        const cj = compOf.get(n);
        if (cj !== ci) d = Math.max(d, depthOf(cj) + 1);
    }
    compDepth.set(ci, d);
    return d;
}
const layers = {};
for (const p of [...nonTest].sort()) { layers[p] = depthOf(compOf.get(p)); files.get(p).layer = layers[p]; }
for (const c of cycles) for (const p of c.files) files.get(p).cycle = c.id;


// ================================================================ PACKAGE DECOMPOSITION (proposal)
// Ordered rules, first match wins. A rule maps a non-test file to an area (package id prefix) and a proposed
// Rust crate. `scc` rules match every file of the import cycle (value+type edges) that contains the anchor file,
// so a cycle always lands in one crate. Areas larger than MAX_PKG are cut into consecutive packages
// (files ordered by directory, then layer, then path; cuts prefer directory boundaries).
const MIN_PKG = 400, TARGET_PKG = 900, MAX_PKG = 1200;
const CRATES = {
    'dima-core': 'Logger, env, crypto, URL builders, DB connections (Mongo, Dragonfly), telemetry/metrics. No domain logic.',
    'dima-model': 'Mongo schemas/document types plus the small pure types and constants the schemas and contracts depend on.',
    'dima-email': 'Transactional email service and templates (React Email in TS today).',
    'dima-twitch': 'Twitch auth/tokens, streamer cache, Helix client wrappers (functions/**), EventSub subscription management.',
    'dima-events': 'Domain event runtime: contracts, identity, producers, store, wakeups, durable cron-job intents.',
    'dima-billing': 'Plans, Polar.sh, credits, AI usage ledger/receipts, referrals.',
    'dima-analytics': 'Stream sessions/analytics/timeline, site analytics, raid analytics, follow ledger.',
    'dima-tts': 'TTS text normalisation, voices, providers (Fish, Kokoro, Piper).',
    'dima-ai': 'LLM clients (OpenRouter, MiniMax, embeddings), Qdrant, AI memory, clip recommendations.',
    'dima-commands': 'Command model below the engine: command/cooldown classes, permissions/roles, availability, timers policy, chat moderation rules.',
    'dima-platform': 'Shared server-side services that realtime and the API both call: OAuth catalog/service, HTTP auth middleware, pet settings, media library, TTS usage.',
    'dima-engine': 'Command engine: AST tokenizer/parser/evaluator, function registry, AI tools + OpenRouter chat, chat delivery, follow defense (the 61-file cycle and what only it uses).',
    'dima-realtime': 'Overlays, widgets, widget feed, pets, goals, duel, roulette, DimaFX, websocket hub, media/TTS queues.',
    'dima-chat': 'Built-in chat commands and Twitch chat/EventSub handlers (bot logic; today also reachable from the API).',
    'dima-services': 'API-side services (AI personality, command blocks/mutations, EventSub config, moderation/TTS settings, overlay services) and API-only helpers.',
    'dima-site-agent': 'Dashboard site agent and docs assistant (LLM tool runners, docs index, write tools).',
    'dima-event-handlers': 'Domain event consumers: registry, consumer runtime and the per-feature event mappers (they call every feature).',
    'dima-api': 'BINARY api: HTTP server bootstrap, routes, OAuth routes.',
    'dima-bot': 'BINARY bot: bot process entry and its EventSub websocket client.',
    'dima-cron': 'BINARY cron: supervisor, native Rust index bridge, every worker entry and cron-only helpers.',
    'dima-scripts': 'BINARIES: one-off CLI scripts (migrations, backfills, smoke tests).',
};
// Intended layering (a crate may depend only on crates listed before it). Imports that break it are reported.
const CRATE_ORDER = Object.keys(CRATES);
const R = (re, area, crate) => ({ re, area, crate });
const SCC = (anchor, area, crate) => ({ scc: anchor, area, crate });
const RULES = [
    // --- cycles first (whole SCC -> one crate)
    SCC('utils/ast_parser/evaluator.ts', 'engine', 'dima-engine'),
    SCC('server/websocket.ts', 'rt-hub', 'dima-realtime'),
    SCC('utils/ai_usage_ledger.ts', 'billing-usage', 'dima-billing'),
    SCC('utils/cron_jobs_queue.ts', 'events-jobs', 'dima-events'),
    SCC('utils/domain_event_consumer.ts', 'evh', 'dima-event-handlers'),
    SCC('domain_events/domain_event_contracts.ts', 'events-core', 'dima-events'),
    SCC('domain_events/domain_event_producers.ts', 'events-core', 'dima-events'),
    SCC('classes/twitch_streamers.class.ts', 'tw-auth', 'dima-twitch'),
    SCC('goals/twitch-store.ts', 'rt-goals', 'dima-realtime'),
    SCC('goals/model.ts', 'model-rt', 'dima-model'),
    SCC('utils/moderation/advanced.ts', 'model-mod', 'dima-model'),
    // --- explicit placements that override the directory rules below
    R(/^domain_events\/twitch_eventsub_events\.ts$/, 'events-core', 'dima-events'),
    R(/^utils\/domain_event_execution\.ts$/, 'evh', 'dima-event-handlers'),
    R(/^utils\/tts\/tts_status\.ts$/, 'model-types', 'dima-model'),
    R(/^utils\/(ai_usage_event|posthog_events)\.ts$/, 'core', 'dima-core'),
    R(/^utils\/(eventsub_reconciliation|eventsub_reconciliation_policy)\.ts$/, 'cron-lib', 'dima-cron'),
    R(/^utils\/eventsub_access\.ts$/, 'svc-util', 'dima-services'),
    R(/^utils\/account_deletion\.ts$/, 'api-auth', 'dima-api'),
    R(/^server\/services\/pet_settings\.service\.ts$/, 'rt-pets', 'dima-realtime'),
    R(/^server\/services\/tts\/voice_preview\.service\.ts$/, 'rt-hub', 'dima-realtime'),
    R(/^functions\/promo\//, 'chat-cmd', 'dima-chat'),
    R(/^classes\/pubsub_manager\.class\.ts$/, 'core', 'dima-core'),
    // --- core
    R(/^utils\/observability\/|^utils\/performance\//, 'core-obs', 'dima-core'),
    R(/^utils\/databases\/|^utils\/(logger|dev|env|crypto|links|pollyfills|notifications|shared_chat_origin|command_cooldown|bits_message|plan_cache_fence|overlay-token|s3|opentelemetry_posthog|posthog_events)\.ts$|^utils\/twitch\/|^utils\/permissions\/error_rate_limit\.ts$|^interfaces\/tbd\/|^functions\/s3\/|^utils\/ai\/openrouter\/app_attribution\.util\.ts$/, 'core', 'dima-core'),
    // --- model (schemas + the pure types/constants they and the event contracts import)
    R(/^schemas\//, 'model', 'dima-model'),
    R(/^interfaces\//, 'model-types', 'dima-model'),
    R(/^domain_events\/domain_event\.types\.ts$/, 'model-types', 'dima-model'),
    R(/^utils\/(availability\/schema|ast_blocks\/types|keywords|permissions\/expression|permissions\/roles|moderation\/spam_categories|moderation\/normalize|moderation\/rules\/blacklist\.rule|chat_notification_defaults|eventsub_bits_config|raid_direction|tts\/expressive_tts_tags\.util|tts\/kokoro_voices\.util)\.ts$|^pets\/(moods|mood_warnings)\.ts$|^middleware\/channel_permissions\.ts$/, 'model-types', 'dima-model'),
    R(/^goals\/twitch\.ts$|^overlays\/(interaction-model|live-events-model|controls)\.ts$|^roulette\/(model|action-model)\.ts$|^widget_feed\/(signals|types)\.ts$/, 'model-rt', 'dima-model'),
    // --- email
    R(/^utils\/email\//, 'email', 'dima-email'),
    // --- twitch
    R(/^utils\/(tokens|header|twitch_helix_retry|oauth_debug_cache|twitch_emotes|badges)\.ts$|^classes\/pubsub_manager\.class\.ts$/, 'tw-auth', 'dima-twitch'),
    R(/^utils\/eventsub[^/]*\.ts$/, 'tw-eventsub', 'dima-twitch'),
    R(/^functions\/(chats|clips|users|search|triggers)\//, 'tw-helix-chat', 'dima-twitch'),
    R(/^functions\/(channels|moderation|polls|predictions|redemptions|promo)\//, 'tw-helix-chan', 'dima-twitch'),
    // --- events runtime vs. handlers
    R(/^domain_events\/(domain_event_consumers|[a-z_]+_events|polar_entitlements)\.ts$/, 'evh', 'dima-event-handlers'),
    R(/^domain_events\//, 'events-core', 'dima-events'),
    R(/^utils\/(domain_events|domain_event_[a-z_]+|durable_cron_jobs)\.ts$/, 'events-core', 'dima-events'),
    // --- billing
    R(/^utils\/(billing|credit_packs)\.ts$/, 'billing-plan', 'dima-billing'),
    R(/^utils\/(referral|referral_ledger|paid_order_reward|polar_account_cancellation|credit_gifts|credit_gift_provider|ai_credit_sources|free_credit_reset)\.ts$/, 'billing-credit', 'dima-billing'),
    R(/^utils\/ai_usage_(?!dashboard|queries)[a-z_]+\.ts$/, 'billing-usage', 'dima-billing'),
    // --- analytics
    R(/^utils\/(stream_analytics)\.ts$/, 'an-stream', 'dima-analytics'),
    R(/^utils\/(stream_activity|stream_timeline|stream_session_event_projection|siteanalytics|raid_analytics|raid_subscriptions)\.ts$|^utils\/ai\/(memory\/stream_memory_queue|clip_recommendations\/clip_recommendations_queue)\.ts$/, 'an-site', 'dima-analytics'),
    R(/^utils\/(follow_ledger|follow_ledger_queue|follow_defense_baseline)\.ts$/, 'an-follow', 'dima-analytics'),
    // --- tts
    R(/^server\/services\/tts\//, 'tts-providers', 'dima-tts'),
    R(/^utils\/tts\//, 'tts', 'dima-tts'),
    // --- ai
    R(/^utils\/qdrant\/|^config\/qdrant\//, 'ai-qdrant', 'dima-ai'),
    R(/^utils\/ai\/memory\//, 'ai-memory', 'dima-ai'),
    R(/^utils\/ai\/clip_recommendations\//, 'ai-clips', 'dima-ai'),
    R(/^utils\/ai\/docs_assistant\//, 'sa-docs', 'dima-site-agent'),
    R(/^utils\/ai\/openrouter\/(index|messages\.ai|miyuloot\.ai)\.ts$/, 'engine-ai', 'dima-engine'),
    R(/^utils\/ai\//, 'ai-llm', 'dima-ai'),
    R(/^classes\/embedding_batcher\.class\.ts$/, 'ai-llm', 'dima-ai'),
    // --- command model (below engine)
    R(/^classes\//, 'cmd-core', 'dima-commands'),
    R(/^utils\/availability\/|^utils\/permissions\/|^utils\/(command_cooldown_write|keyword_cache|timer_policy|ast_variable_migration|speech)\.ts$/, 'cmd-core', 'dima-commands'),
    R(/^utils\/moderation\/defaults\.ts$/, 'chat', 'dima-chat'),
    R(/^utils\/moderation\//, 'cmd-mod', 'dima-commands'),
    // --- engine-adjacent
    R(/^utils\/ast_blocks\/|^utils\/ast_parser\//, 'engine-blocks', 'dima-engine'),
    R(/^handlers\/special_parser\.userlevel\.ts$|^utils\/follow_defense\.ts$/, 'engine-blocks', 'dima-engine'),
    // --- platform services (called by realtime and API)
    R(/^server\/oauth\/(catalog|service)\.ts$|^middleware\/(auth|admin)\.middleware\.ts$|^middleware\/(types|optional\.middleware|index|workspace-owner\.middleware)\.ts$/, 'platform-auth', 'dima-platform'),
    R(/^server\/services\/(pet_settings|media_library|dimafx-fulfillment)\.service\.ts$|^utils\/(tts_usage|video|thumbnail_generator)\.ts$/, 'platform-svc', 'dima-platform'),
    // --- realtime features
    R(/^server\/oauth\/desktop-websocket\.ts$|^server\/services\/(dimafx|dimafx-overlay|duel-overlay|roulette-overlay|widgets-overlay)\.service\.ts$/, 'rt-hub', 'dima-realtime'),
    R(/^overlays\//, 'rt-overlay', 'dima-realtime'),
    R(/^pets\//, 'rt-pets', 'dima-realtime'),
    R(/^custom_widgets\//, 'rt-cwidget', 'dima-realtime'),
    R(/^widgets\/|^widget_feed\//, 'rt-widgets', 'dima-realtime'),
    R(/^goals\/|^duel\/|^roulette\/|^bits_rules\//, 'rt-games', 'dima-realtime'),
    R(/^desktop_ai\/|^assets\//, 'rt-desktop', 'dima-realtime'),
    // --- API services + API-only helpers
    R(/^server\/services\//, 'svc', 'dima-services'),
    R(/^utils\/(account_deletion|dashboard_activity|dashboard_insights|dimafx_data|media_cleanup|twitch_reward_body\.util|chat_event_catalog|eventsub_access|fs|rate_limit|cache|domain_event_health|ai_usage_dashboard|ai_usage_queries|ai_credit_display|timer_cache)\.ts$/, 'svc-util', 'dima-services'),
    // --- site agent
    R(/^site_agent\/tools\/write\//, 'sa-write', 'dima-site-agent'),
    R(/^site_agent\/tools\//, 'sa-tools', 'dima-site-agent'),
    R(/^site_agent\//, 'sa-core', 'dima-site-agent'),
    // --- chat (commands + handlers)
    R(/^commands\//, 'chat-cmd', 'dima-chat'),
    R(/^handlers\//, 'chat', 'dima-chat'),
    // --- binaries
    R(/^server\/(index|server)\.ts$/, 'api-app', 'dima-api'),
    R(/^server\/oauth\//, 'api-app', 'dima-api'),
    R(/^server\/routes\/(admin|admin-tools|admin_site)\.route\.ts$/, 'api-admin', 'dima-api'),
    R(/^server\/routes\/(auth|email-auth|email-test|user|validation|twitch)\.route\.ts$/, 'api-auth', 'dima-api'),
    R(/^server\/routes\/(billing|referral|reward|bits-rules)\.route\.ts$|^server\/routes\/webhooks\//, 'api-billing', 'dima-api'),
    R(/^server\/routes\/(trigger|command|timer|file|media|asset-library)\.route\.ts$/, 'api-cmd', 'dima-api'),
    R(/^server\/routes\/(dashboard|analytics|stream-summary|stream_timeline|clip-recommendations|clip|memories|site|observability|eventsub|aiPersonality|docs-assistant|site-agent)\.route\.ts$/, 'api-data', 'dima-api'),
    R(/^server\/routes\/(follow_defense|moderation|speech)\.route\.ts$/, 'api-settings', 'dima-api'),
    R(/^server\/routes\/(overlay-studio|overlay|pet|roulette|duel-widget|widgets|goals)\.route\.ts$|^server\/routes\/public\//, 'api-overlay', 'dima-api'),
    R(/^bot\//, 'bot', 'dima-bot'),
    R(/^workers\/(cron\.index|cron_native_bridge)\.ts$/, 'cron-sup', 'dima-cron'),
    R(/^workers\//, 'cron-workers', 'dima-cron'),
    R(/^utils\/(temporary_roles_announcements|timer_runtime)\.ts$/, 'cron-lib', 'dima-cron'),
    R(/^scripts\//, 'scripts', 'dima-scripts'),
    R(/^utils\/migrations\//, 'scripts', 'dima-scripts'),
];
const BINARIES = { api: 'dima-api', bot: 'dima-bot', cron: 'dima-cron', script: 'dima-scripts' };

// assign
const sccMembers = new Map(); // anchor -> Set
for (const r of RULES) if (r.scc) {
    const ap = P(r.scc);
    if (!files.has(ap)) throw new Error('scc anchor missing: ' + r.scc);
    const ci = compOf.get(ap);
    sccMembers.set(r.scc, new Set(compsAll[ci]));
}
const assignment = new Map(); // path -> {area, crate, rule}
const unassigned = [];
for (const p of [...nonTest].sort()) {
    const s = srcRel(p);
    const hits = RULES.filter((r) => r.scc ? sccMembers.get(r.scc).has(p) : r.re.test(s));
    if (!hits.length) { unassigned.push(p); continue; }
    assignment.set(p, { area: hits[0].area, crate: hits[0].crate });
}
if (unassigned.length) {
    console.error('Files matched by no package rule (add a rule):\n  ' + unassigned.join('\n  '));
    process.exitCode = 2;
    for (const p of unassigned) assignment.set(p, { area: 'unassigned', crate: 'UNASSIGNED' });
}

// chunk areas into packages
const areaFiles = new Map();
for (const [p, a] of assignment) { if (!areaFiles.has(a.area)) areaFiles.set(a.area, []); areaFiles.get(a.area).push(p); }
const packages = [];
const dirOf = (p) => path.posix.dirname(p);
for (const [area, list] of [...areaFiles].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || files.get(a).layer - files.get(b).layer || a.localeCompare(b));
    const crate = assignment.get(list[0]).crate;
    const total = list.reduce((s, p) => s + files.get(p).loc, 0);
    const chunks = [];
    if (total <= MAX_PKG) chunks.push(list);
    else {
        const nChunks = Math.max(1, Math.round(total / TARGET_PKG));
        const target = total / nChunks;
        let cur = [], curLoc = 0;
        for (let i = 0; i < list.length; i++) {
            const p = list[i], loc = files.get(p).loc;
            if (loc > MAX_PKG) { // a single big file is its own package
                if (cur.length) { chunks.push(cur); cur = []; curLoc = 0; }
                chunks.push([p]);
                continue;
            }
            const dirChange = cur.length && dirOf(cur[cur.length - 1]) !== dirOf(p);
            if (cur.length && (curLoc + loc > MAX_PKG || (curLoc >= target) || (dirChange && curLoc >= target * 0.75))) {
                chunks.push(cur); cur = []; curLoc = 0;
            }
            cur.push(p); curLoc += loc;
        }
        if (cur.length) {
            const curTotal = cur.reduce((s, p) => s + files.get(p).loc, 0);
            const last = chunks[chunks.length - 1];
            const lastLoc = last ? last.reduce((s, p) => s + files.get(p).loc, 0) : 0;
            // fold a small tail into the previous chunk when that stays within MAX_PKG
            if (last && curTotal < MIN_PKG && lastLoc + curTotal <= MAX_PKG && !(last.length === 1 && lastLoc > MAX_PKG)) last.push(...cur);
            else chunks.push(cur);
        }
    }
    chunks.forEach((c, i) => packages.push({ id: `P-${area}-${String(i + 1).padStart(2, '0')}`, area, areas: [area], crate, files: c }));
}
// Merge pass: a package under MIN_PKG joins the package of the same crate it is most connected to
// (import edges either way; same area counts 0.5), if the result stays <= MERGE_MAX. Unconnected ones stay small.
const MERGE_MAX = 1350;
const pkLoc = (pk) => pk.files.reduce((t, p) => t + files.get(p).loc, 0);
for (let changed = true; changed;) {
    changed = false;
    for (const sp of packages.filter((pk) => pkLoc(pk) < MIN_PKG).sort((a, b) => pkLoc(a) - pkLoc(b))) {
        if (!packages.includes(sp)) continue;
        const spSet = new Set(sp.files);
        let best = null, bestScore = 0;
        for (const o of packages) {
            if (o === sp || o.crate !== sp.crate) continue;
            const ol = pkLoc(o);
            if (ol > MAX_PKG || ol + pkLoc(sp) > MERGE_MAX) continue;
            const oSet = new Set(o.files);
            let score = sp.areas.some((a) => o.areas.includes(a)) ? 0.5 : 0;
            for (const p of o.files) for (const t of [...files.get(p).imports, ...files.get(p).typeImports]) if (spSet.has(t)) score++;
            for (const p of sp.files) for (const t of [...files.get(p).imports, ...files.get(p).typeImports]) if (oSet.has(t)) score++;
            if (score > bestScore || (score === bestScore && best && ol < pkLoc(best))) { best = o; bestScore = score; }
        }
        if (best && bestScore >= 0.5) {
            best.files.push(...sp.files);
            best.areas = [...new Set([...best.areas, ...sp.areas])];
            packages.splice(packages.indexOf(sp), 1);
            changed = true;
        }
    }
}
{
    const counters = new Map();
    for (const pk of packages) {
        pk.files.sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || files.get(a).layer - files.get(b).layer || a.localeCompare(b));
        const n = (counters.get(pk.area) ?? 0) + 1; counters.set(pk.area, n);
        pk.id = `P-${pk.area}-${String(n).padStart(2, '0')}`;
    }
}
const pkgOf = new Map();
for (const pk of packages) for (const p of pk.files) {
    if (pkgOf.has(p)) throw new Error('file in two packages: ' + p);
    pkgOf.set(p, pk.id);
}
// exactly-once check
const coverage = { nonTestFiles: nonTest.size, assignedFiles: pkgOf.size, missing: [...nonTest].filter((p) => !pkgOf.has(p)),
    duplicates: packages.flatMap((pk) => pk.files).length - new Set(packages.flatMap((pk) => pk.files)).size };
if (coverage.missing.length || coverage.duplicates || coverage.assignedFiles !== coverage.nonTestFiles) throw new Error('package coverage check failed: ' + JSON.stringify(coverage));
const nonTestLoc = [...nonTest].reduce((s, p) => s + files.get(p).loc, 0);
coverage.nonTestLoc = nonTestLoc;
coverage.packagedLoc = packages.reduce((s, pk) => s + pk.files.reduce((t, p) => t + files.get(p).loc, 0), 0);
if (coverage.packagedLoc !== nonTestLoc) throw new Error('package LOC mismatch');

// Crate layering: CRATE_ORDER lists crates bottom-up. An import from a crate to one later in the order is a
// back-edge: it must be broken (trait, callback, moving a type down) before the crates can form a DAG.
const crateRank = (c) => { const i = CRATE_ORDER.indexOf(c); if (i < 0) throw new Error('crate missing from CRATES: ' + c); return i; };
const backEdges = [];
for (const [p, a] of assignment) {
    for (const [t, typeOnly] of [...files.get(p).imports.map((t) => [t, false]), ...files.get(p).typeImports.map((t) => [t, true])]) {
        const b = assignment.get(t);
        if (b && b.crate !== a.crate && crateRank(b.crate) > crateRank(a.crate)) backEdges.push({ from: p, to: t, typeOnly, fromCrate: a.crate, toCrate: b.crate });
    }
}
const isBack = new Set(backEdges.map((e) => e.from + '|' + e.to));
// package metadata, deps, waves (waves ignore back-edges: they are assumed broken first, and are listed)
const s0 = (p) => p.replace(SRC_REL + '/', '');
const pkgById = new Map(packages.map((pk) => [pk.id, pk]));
for (const pk of packages) {
    pk.loc = pk.files.reduce((s, p) => s + files.get(p).loc, 0);
    const procs = new Set(), deps = new Set(), typeDeps = new Set();
    for (const p of pk.files) {
        for (const pr of files.get(p).processes) procs.add(pr);
        for (const t of files.get(p).imports) if (pkgOf.has(t) && pkgOf.get(t) !== pk.id && !isBack.has(p + '|' + t)) deps.add(pkgOf.get(t));
        for (const t of files.get(p).typeImports) if (pkgOf.has(t) && pkgOf.get(t) !== pk.id && !isBack.has(p + '|' + t)) typeDeps.add(pkgOf.get(t));
    }
    for (const d of deps) typeDeps.delete(d);
    pk.processes = [...procs].sort();
    pk.dependsOn = [...deps].sort();
    pk.typeDependsOn = [...typeDeps].sort();
    pk.oversized = pk.loc > MAX_PKG;
    pk.undersized = pk.loc < MIN_PKG;
    pk.cycles = [...new Set(pk.files.map((p) => files.get(p).cycle).filter(Boolean))];
    pk.backEdges = backEdges.filter((e) => pkgOf.get(e.from) === pk.id).map((e) => `${s0(e.from)} -> ${s0(e.to)}${e.typeOnly ? ' (type)' : ''} [${pkgOf.get(e.to)}]`);
}
const pkgEdges = new Map(packages.map((pk) => [pk.id, new Set([...pk.dependsOn, ...pk.typeDependsOn])]));
const pkgComps = scc(new Set(pkgEdges.keys()), pkgEdges);
const pkgCompOf = new Map(); pkgComps.forEach((c, i) => c.forEach((id) => pkgCompOf.set(id, i)));
const pkgCompWave = new Map();
function waveOf(ci) {
    if (pkgCompWave.has(ci)) return pkgCompWave.get(ci);
    pkgCompWave.set(ci, 0);
    let w = 0;
    for (const id of pkgComps[ci]) for (const d of pkgEdges.get(id)) { const cj = pkgCompOf.get(d); if (cj !== ci) w = Math.max(w, waveOf(cj) + 1); }
    pkgCompWave.set(ci, w);
    return w;
}
const pkgCycles = pkgComps.filter((c) => c.length > 1).map((c) => c.sort());
for (const pk of packages) {
    pk.wave = waveOf(pkgCompOf.get(pk.id));
    const c = pkgComps[pkgCompOf.get(pk.id)];
    if (c.length > 1) pk.packageCycle = c;
}
// purpose: area description + dominant directory
const AREA_PURPOSE = {
    'engine': 'Command engine cycle (AST evaluator/registry/functions, AI tools, chat delivery, follow-defense queue, raid sessions)',
    'engine-blocks': 'AST block model (blocks <-> source), validation and simulation outside the cycle',
    'rt-hub': 'Realtime hub cycle: websocket server, overlay live state, TTS/clip/DimaFX queues, pet runtime',
    'rt-overlay': 'Overlay model, store, publish, interactions', 'rt-pets': 'Pet admission, moods, mouth analysis, TTS lane',
    'rt-cwidget': 'Custom widget format, session, media', 'rt-widgets': 'Widgets model/events and widget feed publisher',
    'rt-games': 'Goals, duel, roulette, bits rules', 'rt-goals': 'Goal Twitch store + overlay interactions cycle',
    'rt-desktop': 'Desktop AI execution/activity and asset library',
    'billing-usage': 'AI usage ledger, receipts, backfill queue, Polar.sh client (cycle C03)',
    'billing-plan': 'Plan tiers, entitlements and credit packs', 'billing-credit': 'Credits, gifts, referrals, paid-order rewards',
    'events-core': 'Domain event contracts, identity, producers and per-feature event mappers',
    'events-consume': 'Domain event consumer runtime and consumer registry', 'events-jobs': 'Durable cron-job intents and queue',
    'tw-auth': 'Twitch app/bot/user tokens, streamer cache, Helix headers/retry, emotes/badges',
    'tw-eventsub': 'EventSub subscription management and reconciliation',
    'tw-helix-chat': 'Helix wrappers: chat, clips, users, search, triggers', 'tw-helix-chan': 'Helix wrappers: channels, moderation, polls, predictions, redemptions, promo',
    'core': 'Logger, env, crypto, URL builders, DB connections, small shared helpers', 'core-obs': 'Telemetry, runtime and native worker metrics',
    'model': 'Mongo schemas and document types', 'model-types': 'Pure types/helpers the schemas depend on',
    'model-mod': 'Moderation settings schema + advanced/variation rules (cycle C04)',
    'an-stream': 'Stream session analytics (single large file)', 'an-site': 'Site analytics, PostHog events, stream activity/timeline, raid analytics',
    'an-follow': 'Follow ledger and follow-defense detection',
    'ai-qdrant': 'Qdrant collections and chat/memory vector functions', 'ai-memory': 'AI memory service, stream memory and stream summaries',
    'ai-clips': 'VOD clip recommendation runner and client', 'ai-docs': 'Docs assistant', 'ai-llm': 'LLM clients, prompts, embeddings, threading, sandbox',
    'cmd': 'Built-in chat commands', 'cmd-core': 'Command class, cooldowns, permissions/roles, timers, keyword cache', 'cmd-mod': 'Chat moderation rules, spam, semantic moderation',
    'tts': 'TTS text normalisation, voices, sessions, deadlines', 'tts-providers': 'TTS providers (Fish, Kokoro, Piper) and voice preview',
    'chat': 'Twitch chat / EventSub handlers (message, moderation, redemptions, raids...)',
    'sa-core': 'Site agent runner, context, store, docs index, LLM client', 'sa-tools': 'Site agent read/effect tools',
    'sa-write': 'Site agent write tools (commands, timers, settings)', 'email': 'Email service and templates',
    'api-app': 'API process bootstrap and Express app', 'api-oauth': 'OAuth provider + HTTP middleware', 'api-admin': 'Admin routes',
    'api-auth': 'Auth, user and validation routes', 'api-billing': 'Billing, referral, reward, bits-rules routes and Polar webhook',
    'api-cmd': 'Trigger, command, timer, file/media routes', 'api-data': 'Dashboard, analytics, memories, clips, site, agent routes',
    'api-settings': 'Follow defense, moderation, speech routes', 'api-overlay': 'Overlay, pet, widget, roulette routes',
    'api-svc': 'API services (AI personality, commands, EventSub config, moderation/TTS settings)', 'api-svc-rt': 'API services for DimaFX and overlays',
    'api-util': 'API-only helpers (dashboard, media cleanup, account deletion, usage dashboards)',
    'bot': 'Bot process entry + EventSub websocket client', 'cron-sup': 'Cron supervisor + native Rust index bridge',
    'cron-workers': 'Cron worker entry files', 'scripts': 'One-off CLI scripts and data migrations',
};
for (const pk of packages) pk.purpose = pk.areas.map((a) => AREA_PURPOSE[a] ?? a).join('; plus ');

// crate graph
const crateNames = [...new Set(packages.map((pk) => pk.crate))];
const crateDeps = new Map(crateNames.map((c) => [c, new Set()]));     // without back-edges
const crateDepsAll = new Map(crateNames.map((c) => [c, new Set()]));  // with back-edges
const crateEdgeFiles = new Map(); // "a->b" -> [[from,to]]
for (const [p, a] of assignment) for (const t of [...files.get(p).imports, ...files.get(p).typeImports]) {
    const b = assignment.get(t); if (!b || b.crate === a.crate) continue;
    if (!isBack.has(p + '|' + t)) crateDeps.get(a.crate).add(b.crate);
    crateDepsAll.get(a.crate).add(b.crate);
    const k = `${a.crate}->${b.crate}`; if (!crateEdgeFiles.has(k)) crateEdgeFiles.set(k, []); crateEdgeFiles.get(k).push([p, t]);
}
const crateCycles = scc(new Set(crateNames), crateDepsAll).filter((c) => c.length > 1);       // as the code is today
const crateCyclesAfterBreak = scc(new Set(crateNames), crateDeps).filter((c) => c.length > 1); // must be empty
if (crateCyclesAfterBreak.length) throw new Error('crate graph still cyclic without back-edges: ' + JSON.stringify(crateCyclesAfterBreak));
const crateLinkedBy = new Map(crateNames.map((c) => [c, new Set()]));
for (const [p, a] of assignment) for (const pr of files.get(p).processes) crateLinkedBy.get(a.crate).add(pr);
// cycle-vs-crate consistency
const cyclesCrossingCrates = cycles.filter((c) => new Set(c.files.map((p) => assignment.get(p).crate)).size > 1).map((c) => c.id);

// ================================================================ OUTPUT: modules.json
const records = [...files.values()].map((r) => ({
    path: r.path, lang: r.lang, loc: r.loc, isTest: r.isTest,
    imports: r.imports, typeImports: r.typeImports, externals: r.externals, typeExternals: r.typeExternals,
    importedBy: r.importedBy, importedByNonTest: r.importedByNonTest, importedByValue: r.importedByValue,
    reachableFrom: r.reachableFrom, reachableFromWithTypes: r.reachableFromWithTypes, processes: r.processes,
    orphan: r.orphan, ...(r.orphan ? { orphanKind: r.orphanEvenWithTypes ? (r.testOnly ? 'test-only' : 'unreachable') : 'type-only' } : {}),
    ...(r.isTest ? {} : { layer: r.layer, package: pkgOf.get(r.path), crate: assignment.get(r.path).crate }),
    ...(r.cycle ? { cycle: r.cycle } : {}), ...(r.looksLikeTest ? { looksLikeTest: true } : {}),
    ...(r.runtimeRefs ? { runtimeRefs: r.runtimeRefs } : {}), ...(r.requireImports ? { requireImports: r.requireImports } : {}),
    ...(r.nonCodeImports ? { nonCodeImports: r.nonCodeImports } : {}),
    sideEffects: Object.fromEntries(Object.entries(r.sideEffects).filter(([, v]) => Array.isArray(v) ? v.length : v)),
}));
const json = {
    generatedBy: 'dima-rust/tools/ledger/ts_graph.mjs', generatedAt: new Date().toISOString(), root: SRC_REL,
    typescriptVersion: ts.version,
    notes: {
        edges: 'imports = value edges (static import, export-from, side-effect import, dynamic import(), require(), new URL(./x, import.meta.url) runtime refs). typeImports = edges where every specifier is type-only (import type / export type / all-`type` named specifiers / import("x").T type nodes) and no value edge to the same file exists.',
        orphan: 'orphan = non-test file not reachable from any entry by value imports. orphanKind: type-only (reachable only through type imports), test-only (only tests import it), unreachable.',
        layers: 'Topological depth over value+type edges among non-test files, after collapsing cycles (SCCs). Layer 0 = no internal dependencies.',
        processes: 'api / bot / cron / script, derived from reachableFrom (value edges).',
    },
    entries: entries.map((e) => ({ id: e.id, path: e.path, process: e.process, ...(e.enabledEnv ? { enabledEnv: e.enabledEnv } : {}) })),
    totals: { files: files.size, loc: [...files.values()].reduce((s, r) => s + r.loc, 0), nonTestFiles: nonTest.size, nonTestLoc },
    cycles, testCycles, layers, unresolved,
    packages: packages.map((pk) => ({ id: pk.id, crate: pk.crate, purpose: pk.purpose, loc: pk.loc, wave: pk.wave, processes: pk.processes,
        dependsOn: pk.dependsOn, typeDependsOn: pk.typeDependsOn, ...(pk.backEdges.length ? { backEdges: pk.backEdges } : {}), ...(pk.packageCycle ? { packageCycle: pk.packageCycle } : {}),
        ...(pk.cycles.length ? { containsFileCycles: pk.cycles } : {}), ...(pk.oversized ? { oversized: true } : {}),
        files: pk.files.map((p) => ({ path: p, loc: files.get(p).loc })) })),
    crates: crateNames.sort().map((c) => ({ name: c, description: CRATES[c] ?? '', loc: packages.filter((pk) => pk.crate === c).reduce((s, pk) => s + pk.loc, 0),
        packages: packages.filter((pk) => pk.crate === c).map((pk) => pk.id), dependsOn: [...crateDeps.get(c)].sort(), processes: [...crateLinkedBy.get(c)].sort() })),
    crateOrder: CRATE_ORDER, crateCycles, crateBackEdges: backEdges, packageCycles: pkgCycles, coverage,
    modules: records,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'modules.json'), JSON.stringify(json, null, 1) + '\n');

// ================================================================ OUTPUT: modules.md
const L = [];
const s = (p) => p.replace(SRC_REL + '/', '');
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const fmt = (n) => n.toLocaleString('en-US');
const nt = [...files.values()].filter((r) => !r.isTest);
L.push('# dimabot/src module graph and work-package proposal', '');
L.push(`Generated by \`node dima-rust/tools/ledger/ts_graph.mjs\` (TypeScript ${ts.version} parser, syntax only) on ${json.generatedAt.slice(0, 10)}. Machine-readable data: \`dima-rust/ledger/modules.json\`.`);
L.push('Paths in tables are relative to `dimabot/src/` unless they start with `dimabot/`. LOC = non-blank lines. Reachability uses value imports only unless stated.', '');
const orphans_ = nt.filter((r) => r.orphan);
const all3 = nt.filter((r) => ['api', 'bot', 'cron'].every((x) => r.processes.includes(x)));
const buckets_ = new Map([['shared by all 3', [all3.length, sum(all3.map((r) => r.loc))]]]);
L.push('## Headlines', '');
L.push(`- ${nonTest.size} non-test files / ${fmt(nonTestLoc)} LOC to migrate (+ ${files.size - nonTest.size} test files / ${fmt(json.totals.loc - nonTestLoc)} LOC). ${orphans_.length} orphans (${fmt(sum(orphans_.map((r) => r.loc)))} LOC), of which ${orphans_.filter((r) => r.orphanEvenWithTypes && !r.testOnly).length} are unreachable dead-code candidates.`);
L.push(`- ${cycles.length} import cycles; ${cycles[0].id} alone is ${cycles[0].size} files / ${fmt(cycles[0].loc)} LOC (command engine + Helix wrappers + chat delivery). ${packages.length} packages in ${CRATE_ORDER.length} crates, ${Math.max(...packages.map((p) => p.wave)) + 1} waves; ${backEdges.length} imports must be inverted for the crate graph to be a DAG.`);
L.push(`- ${buckets_.get('shared by all 3')?.[0] ?? 0} files (${fmt(buckets_.get('shared by all 3')?.[1] ?? 0)} LOC) are loaded by api, bot and cron alike; the API also loads the bot's chat handlers and commands.`, '');
L.push('## Totals', '');
L.push(`- Files parsed: **${files.size}** (${fmt(json.totals.loc)} LOC); non-test **${nonTest.size}** (${fmt(nonTestLoc)} LOC); test/fixture **${files.size - nonTest.size}** (${fmt(json.totals.loc - nonTestLoc)} LOC).`);
L.push(`- Non-TS files included: ${[...files.values()].filter((r) => !['ts', 'tsx'].includes(r.lang)).map((r) => '`' + s(r.path) + '` (' + r.lang + ', ' + r.loc + ')').join(', ')}.`);
L.push(`- Entries: ${entries.length} (api, bot, cron supervisor, ${entries.filter((e) => e.id.startsWith('cron:') && e.id !== 'cron:supervisor').length} cron workers, ${entries.filter((e) => e.process === 'script').length} scripts). Cycles: ${cycles.length}. Max layer: ${Math.max(...nt.map((r) => r.layer))}.`, '');
L.push('### Per top-level directory', '', '| dir | files | LOC | test files | test LOC |', '|---|---:|---:|---:|---:|');
const dirs = new Map();
for (const r of files.values()) { const d = s(r.path).includes('/') ? s(r.path).split('/')[0] : '(root)'; if (!dirs.has(d)) dirs.set(d, [0, 0, 0, 0]); const a = dirs.get(d); if (r.isTest) { a[2]++; a[3] += r.loc; } else { a[0]++; a[1] += r.loc; } }
for (const [d, a] of [...dirs].sort((x, y) => y[1][1] - x[1][1])) L.push(`| ${d} | ${a[0]} | ${fmt(a[1])} | ${a[2]} | ${fmt(a[3])} |`);
L.push('', '### Per process (non-test files, value reachability)', '');
L.push('`cron` = union of the supervisor and all workers. Scripts are counted separately and do not change the api/bot/cron bucket.', '');
const bucket = (r) => {
    const ps = r.processes.filter((p) => p !== 'script');
    if (!ps.length) return r.processes.includes('script') ? 'scripts only' : 'reached by no entry (orphan)';
    if (ps.length === 3) return 'shared by all 3';
    if (ps.length === 2) return `shared by 2 (${ps.join('+')})`;
    return `${ps[0]} only`;
};
const buckets = new Map();
for (const r of nt) { const b = bucket(r); if (!buckets.has(b)) buckets.set(b, [0, 0]); buckets.get(b)[0]++; buckets.get(b)[1] += r.loc; }
L.push('| bucket | files | LOC |', '|---|---:|---:|');
const order = ['api only', 'bot only', 'cron only', 'shared by 2 (api+bot)', 'shared by 2 (api+cron)', 'shared by 2 (bot+cron)', 'shared by all 3', 'scripts only', 'reached by no entry (orphan)'];
for (const b of [...order, ...[...buckets.keys()].filter((k) => !order.includes(k))]) if (buckets.has(b)) L.push(`| ${b} | ${buckets.get(b)[0]} | ${fmt(buckets.get(b)[1])} |`);
L.push('', 'Closure size per entry (files / LOC reachable by value imports, including the entry):', '');
L.push('| entry | file | enabled by env | files | LOC |', '|---|---|---|---:|---:|');
for (const e of entries) {
    const rs = nt.filter((r) => r.reachableFrom.includes(e.id));
    L.push(`| ${e.id} | ${s(e.path)} | ${e.enabledEnv ?? ''} | ${rs.length} | ${fmt(sum(rs.map((r) => r.loc)))} |`);
}
// orphans
const orphans = nt.filter((r) => r.orphan).sort((a, b) => a.path.localeCompare(b.path));
const okind = (r) => r.orphanEvenWithTypes ? (r.testOnly ? 'test-only' : 'unreachable') : 'type-only';
L.push('', `### Orphans: ${orphans.length} files, ${fmt(sum(orphans.map((r) => r.loc)))} LOC`, '');
L.push('No entry reaches these by value imports. `type-only` files are reached only through type imports (pure type modules: not dead, but they have no runtime code to port beyond types). `test-only` files are imported only by tests. `unreachable` files are the real dead-code candidates.', '');
for (const k of ['unreachable', 'test-only', 'type-only']) {
    const g = orphans.filter((r) => okind(r) === k);
    L.push(`- **${k}**: ${g.length} files, ${fmt(sum(g.map((r) => r.loc)))} LOC`);
}
const testLike = nt.filter((r) => r.looksLikeTest);
L.push(`- Test-like files that the test patterns miss (they import \`node:test\` or call \`describe/it\` at top level; counted as non-test everywhere in this ledger): ${testLike.map((r) => '`' + s(r.path) + '` (' + r.loc + ')').join(', ') || 'none'}.`);
L.push('', '| file | LOC | kind | imported by (non-test) |', '|---|---:|---|---:|');
for (const r of orphans.sort((a, b) => okind(a).localeCompare(okind(b)) || a.path.localeCompare(b.path))) L.push(`| ${s(r.path)} | ${r.loc} | ${okind(r)} | ${r.importedByNonTest} |`);
// cycles
L.push('', `### Import cycles (value + type edges, non-test files): ${cycles.length}`, '');
L.push('A cycle is a strongly connected component with more than one file. "value-only sub-cycles" are the parts that stay cyclic when type-only imports are ignored (type-only edges can usually be broken by moving types down).', '');
for (const c of cycles) {
    L.push(`- **${c.id}** — ${c.size} files, ${fmt(c.loc)} LOC, proposed crate \`${assignment.get(c.files[0]).crate}\`; value-only sub-cycles: ${c.valueOnlySubcycles.length ? c.valueOnlySubcycles.map((v) => v.length + ' files').join(', ') : 'none (type edges only)'}`);
    L.push('  - ' + c.files.map((p) => `${s(p)} (${files.get(p).loc})`).join(', '));
}
if (testCycles.length) L.push('', `Cycles that include test files: ${testCycles.length} (${testCycles.map((c) => c.map(s).join(' <-> ')).join('; ')}).`);
// unresolved + runtime refs
L.push('', '### Unresolved and non-standard edges', '');
if (!unresolved.length) L.push('- Unresolved: none.');
for (const u of unresolved) L.push(`- Unresolved: \`${s(u.from)}\` ${u.kind} \`${u.spec}\` — ${u.reason}.`);
for (const r of files.values()) if (r.runtimeRefs && !r.isTest) L.push(`- Runtime file reference (worker thread / computed import, counted as a value edge): \`${s(r.path)}\` -> ${r.runtimeRefs.map((x) => '`' + s(x) + '`').join(', ')}.`);
for (const r of files.values()) if (r.requireImports) L.push(`- CommonJS \`require()\` inside an ESM module (throws ReferenceError at runtime under Node ESM): \`${s(r.path)}\` -> ${r.requireImports.map((x) => '`' + s(x) + '`').join(', ')}.`);
for (const r of files.values()) if (r.nonCodeImports) L.push(`- Non-code import: \`${s(r.path)}\` -> ${r.nonCodeImports.map((x) => '`' + x + '`').join(', ')}.`);
L.push('- Process-level spawns that are not imports (not edges): `workers/cron.index.ts` spawns each worker as its own Node process; `workers/cron_native_bridge.ts` spawns the Rust binary `/usr/local/bin/cron_index`; `workers/domain_events.worker.ts` forks itself once per consumer (`--consumer=<id>`) through `utils/domain_event_execution.ts`; `pets/mouth_analysis.ts` starts `pets/mouth_curves.worker.ts` as a worker thread.');
// fan-in / largest
L.push('', '## Top 60 most-imported files (fan-in)', '');
L.push('`in` = distinct importing files (value or type), `in(non-test)` excludes tests, `in(value)` counts value edges only.', '');
L.push('| # | file | LOC | in | in(non-test) | in(value) | layer | processes | package |', '|---:|---|---:|---:|---:|---:|---:|---|---|');
[...files.values()].filter((r) => !r.isTest).sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)).slice(0, 60)
    .forEach((r, i) => L.push(`| ${i + 1} | ${s(r.path)} | ${r.loc} | ${r.importedBy} | ${r.importedByNonTest} | ${r.importedByValue} | ${r.layer} | ${r.processes.join('+') || '-'} | ${pkgOf.get(r.path)} |`));
L.push('', '## 40 largest files', '');
L.push('| # | file | LOC | test | layer | processes | cycle | package |', '|---:|---|---:|---|---:|---|---|---|');
[...files.values()].sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path)).slice(0, 40)
    .forEach((r, i) => L.push(`| ${i + 1} | ${s(r.path)} | ${r.loc} | ${r.isTest ? 'yes' : ''} | ${r.layer ?? ''} | ${r.processes.join('+') || '-'} | ${r.cycle ?? ''} | ${pkgOf.get(r.path) ?? ''} |`));
// externals
L.push('', '## External packages (non-test files)', '');
const extCount = new Map();
for (const r of nt) { for (const e of r.externals) { if (!extCount.has(e)) extCount.set(e, [0, 0]); extCount.get(e)[0]++; } for (const e of r.typeExternals) { if (!extCount.has(e)) extCount.set(e, [0, 0]); extCount.get(e)[1]++; } }
L.push('`value` = files importing it at runtime, `type` = files importing only its types.', '');
L.push('| package | value | type |', '|---|---:|---:|');
for (const [e, [v, t]] of [...extCount].sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))) L.push(`| ${e} | ${v} | ${t} |`);

// decomposition
L.push('', '## Proposed decomposition (PROPOSAL — the lead decides)', '');
L.push(`${packages.length} packages in ${crateNames.length} crates, ${Math.max(...packages.map((p) => p.wave)) + 1} waves. Target ${MIN_PKG}–${MAX_PKG} LOC per package; areas are defined by ordered rules in \`ts_graph.mjs\` (\`RULES\`), and areas over ${MAX_PKG} LOC are cut into consecutive packages along directory boundaries.`);
L.push('Every import cycle is assigned whole to one crate by an anchor rule (`SCC(...)`), so file cycles never cross crates' + (cyclesCrossingCrates.length ? ` — EXCEPT ${cyclesCrossingCrates.join(', ')}` : ' (checked: 0 cycles cross a crate boundary)') + '.', '');
L.push('**Coverage check (run by the script, it aborts on failure):** every non-test file is matched by a rule, the packages are built from that assignment, a `Map` from file to package throws on a second insertion, and the script asserts ' +
    `assigned files (${coverage.assignedFiles}) = non-test files (${coverage.nonTestFiles}), missing = ${coverage.missing.length}, duplicates = ${coverage.duplicates}, packaged LOC (${fmt(coverage.packagedLoc)}) = non-test LOC (${fmt(coverage.nonTestLoc)}).`, '');
L.push('Waves: wave 0 packages depend on no other package; wave N depends only on waves < N. Packages that import each other (package-level cycles, all inside one crate) share a wave and must be built together or have their cycle broken first. Dependencies count value and type imports, because Rust needs the types.', '');
L.push('### Crates', '');
L.push('| crate | role | LOC | packages | depends on crates | linked by |', '|---|---|---:|---:|---|---|');
const crateOrder = Object.keys(CRATES).filter((c) => crateNames.includes(c));
for (const c of crateOrder) {
    const j = json.crates.find((x) => x.name === c);
    L.push(`| \`${c}\` | ${CRATES[c]} | ${fmt(j.loc)} | ${j.packages.length} | ${j.dependsOn.map((d) => '`' + d + '`').join(', ') || '—'} | ${j.processes.join(', ') || '—'} |`);
}
L.push('', 'Binaries (crates whose files are reachable from that process by value imports, i.e. what each binary would have to link):', '');
for (const [proc, bin] of Object.entries(BINARIES)) {
    const linked = crateOrder.filter((c) => crateLinkedBy.get(c).has(proc));
    L.push(`- **${bin}** (${proc}): ${linked.map((c) => '`' + c + '`').join(', ')}`);
}
L.push('', '### Waves at a glance', '', '| wave | packages | LOC |', '|---:|---|---:|');
const maxWave = Math.max(...packages.map((p) => p.wave));
for (let w = 0; w <= maxWave; w++) { const ps = packages.filter((p) => p.wave === w); L.push(`| ${w} | ${ps.map((p) => p.id).join(', ')} | ${fmt(sum(ps.map((p) => p.loc)))} |`); }
L.push('', '### Packages', '');
for (const c of crateOrder) {
    const ps = packages.filter((p) => p.crate === c).sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
    L.push(`#### \`${c}\` — ${fmt(sum(ps.map((p) => p.loc)))} LOC, ${ps.length} packages`, '');
    for (const pk of ps) {
        const flags = [pk.oversized ? `**single file over ${MAX_PKG} LOC: flag for splitting**` : '', pk.undersized ? 'small (<400 LOC; kept as a cohesive unit)' : '',
            pk.packageCycle ? `**package cycle with ${pk.packageCycle.filter((x) => x !== pk.id).join(', ')}**` : '', pk.cycles.length ? `contains file cycle ${pk.cycles.join(', ')}` : ''].filter(Boolean);
        L.push(`- **${pk.id}** — ${pk.purpose}. ${fmt(pk.loc)} LOC, wave ${pk.wave}, processes: ${pk.processes.join('+') || 'none (orphan/type-only)'}${flags.length ? '; ' + flags.join('; ') : ''}.`);
        L.push(`  - depends on: ${pk.dependsOn.join(', ') || '—'}${pk.typeDependsOn.length ? `; types only: ${pk.typeDependsOn.join(', ')}` : ''}`);
        if (pk.backEdges.length) L.push(`  - back-edges to break (excluded from waves): ${pk.backEdges.join('; ')}`);
        L.push(`  - files: ${pk.files.map((p) => `${s(p)} (${files.get(p).loc})`).join(', ')}`);
    }
    L.push('');
}

// risks
L.push('## Risks seen in the graph', '');
L.push('### Cycles that do not map to a crate DAG', '');
L.push(`- **As the code is today the proposed crates are ${crateCycles.length ? 'NOT' : ''} a DAG.** ${crateCycles.length ? `${crateCycles.length} crate cycle(s): ${crateCycles.map((c) => c.map((x) => '`' + x + '`').join(', ')).join(' / ')}.` : ''} The crate order in \`CRATE_ORDER\` (bottom-up: ${CRATE_ORDER.map((c) => '`' + c + '`').join(' < ')}) is violated by exactly **${backEdges.length} imports** (${backEdges.filter((e) => e.typeOnly).length} of them type-only). Removing them makes the crate graph acyclic (the script asserts this). Waves above assume these are broken first:`, '');
L.push('| from (crate) | imports (crate) | type-only | suggested fix |', '|---|---|---|---|');
const fixHint = (e) => e.typeOnly ? 'move the type down into the importing crate or `dima-model`' : 'invert with a trait/callback owned by the lower crate, or move the called function down';
for (const e of backEdges) L.push(`| ${s(e.from)} (\`${e.fromCrate}\`) | ${s(e.to)} (\`${e.toCrate}\`) | ${e.typeOnly ? 'yes' : 'no'} | ${fixHint(e)} |`);
L.push('', 'Placement choices made to get here (the rules carry them): pure leaf types used by schemas/contracts were moved into `dima-model` (e.g. `utils/raid_direction.ts`, `utils/tts/expressive_tts_tags.util.ts`, `middleware/channel_permissions.ts`, `domain_events/domain_event.types.ts`, realtime model files `goals/twitch.ts`, `overlays/*-model.ts`, `roulette/model.ts`, `widget_feed/signals.ts`); the domain-event mappers and consumer runtime sit in `dima-event-handlers` near the top because they call every feature; `server/oauth/{catalog,service}.ts`, HTTP auth middleware and a few services that realtime code calls sit in `dima-platform` below realtime; `utils/ai/openrouter/{index,messages.ai,miyuloot.ai}.ts` sit in `dima-engine` because they wrap `ai.ts`, which is in the engine cycle.');
L.push('', `- File cycles: ${cycles.length}; the largest (${cycles[0]?.id}, ${cycles[0]?.size} files, ${fmt(cycles[0]?.loc ?? 0)} LOC) is the command engine: the AST evaluator calls Helix wrappers and chat delivery, which call back into the special parser/evaluator. In Rust this needs one crate or an explicit trait boundary (e.g. an \`EngineHost\` trait implemented by the chat layer).`);
L.push(`- Package-level cycles (inside a crate, created by cutting areas into packages): ${pkgCycles.length}${pkgCycles.length ? ' — ' + pkgCycles.map((c) => c.join(' <-> ')).join('; ') : ''}.`);
// side effects
const se = (k) => nt.filter((r) => r.sideEffects[k]?.length || r.sideEffects[k] === true);
L.push('', '### Modules with side effects at import time', '');
const tla = se('topLevelAwait');
L.push(`- Top-level \`await\` (${tla.length} files): ${tla.map((r) => '`' + s(r.path) + '`').join(', ') || 'none'}.`);
const ROUTE_CALL = /^(router|\w+Route|\w+ApiRoute)\.(get|post|put|patch|delete|use|all)$/;
const isScriptEntry = (r) => entries.some((e) => e.process === 'script' && e.path === r.path);
const interestingCalls = (r) => r.sideEffects.topLevelCalls.filter((c) => !ROUTE_CALL.test(c));
const calls = nt.filter((r) => interestingCalls(r).length && !isScriptEntry(r));
const routeFiles = nt.filter((r) => r.sideEffects.topLevelCalls.some((c) => ROUTE_CALL.test(c)));
const scriptRunners = nt.filter((r) => isScriptEntry(r) && r.sideEffects.topLevelCalls.length);
const models = nt.filter((r) => r.sideEffects.mongooseModels.length || r.sideEffects.mongooseSchemaDecls.length);
L.push(`- Mongoose: ${models.length} files build schemas and register models at import (\`new Schema\`, \`schema.index/pre/...\`, \`model(...)\`; ${sum(nt.map((r) => r.sideEffects.mongooseModels.length))} models). Model registration is an import side effect: a model exists in a process only if some import chain loads its file (see orphan schemas above). Listed per file in modules.json (\`sideEffects.mongooseModels\`).`);
L.push(`- Express routers created at module level: ${nt.filter((r) => r.sideEffects.routers.length).length} files (normal; not listed).`);
L.push(`- Express route registration at import (\`router.get(...)\` etc.): ${routeFiles.length} files (normal; not listed). CLI scripts that run \`dotenv.config()\` / \`run()\` at import: ${scriptRunners.length} (expected for entries; not listed).`);
L.push(`- Other top-level statements that run on import (${calls.length} files; registration-on-import and process bootstrap are the ones to model explicitly in Rust):`);
for (const r of calls) L.push(`  - \`${s(r.path)}\` (${r.processes.join('+') || 'orphan'}): ${interestingCalls(r).slice(0, 8).map((x) => '`' + x + '`').join(', ')}${interestingCalls(r).length > 8 ? ', …' : ''}`);
const hooks = nt.filter((r) => r.sideEffects.processHooks.length || r.sideEffects.timers.length);
L.push(`- Process hooks / timers registered at top level (${hooks.length} files): ${hooks.map((r) => '`' + s(r.path) + '` (' + [...r.sideEffects.processHooks, ...r.sideEffects.timers].join(', ') + ')').join('; ') || 'none'}.`);
L.push('', '### Singletons and module-level mutable state', '');
L.push('Each Node process today has its own copy of these. If two processes are merged into one Rust binary, or tasks run concurrently in one runtime, this state becomes shared and needs explicit ownership (an `Arc<…>` service passed in, or per-task state).', '');
const stateful = nt.filter((r) => r.sideEffects.singletons.length || r.sideEffects.mutableState.length || r.sideEffects.timers.length).sort((a, b) => b.processes.length - a.processes.length || a.path.localeCompare(b.path));
L.push(`${stateful.length} files hold module-level singletons (non-Mongoose \`new X\`, client factories) or mutable state (\`let\`/\`var\`, non-constant Map/Set). UPPER_CASE constant lookup tables, Mongoose schemas/models and Express routers are excluded. Files reachable from 2+ processes first:`, '');
L.push('| file | processes | singletons | mutable state (`let`/`var`, top-level Map/Set) |', '|---|---|---|---|');
for (const r of stateful) L.push(`| ${s(r.path)} | ${r.processes.join('+') || '-'} | ${r.sideEffects.singletons.map((x) => '`' + x.replace(/\|/g, '\\|') + '`').join(', ')} | ${r.sideEffects.mutableState.map((x) => '`' + x.replace(/\|/g, '\\|') + '`').join(', ')} |`);
L.push('', '### Shared in-memory assumptions between processes', '');
const apiReachesBot = nt.filter((r) => r.processes.includes('api') && /^dimabot\/src\/(handlers|commands)\//.test(r.path));
L.push(`- The API process reaches ${apiReachesBot.length} bot-side files (handlers/commands) by value imports (${fmt(sum(apiReachesBot.map((r) => r.loc)))} LOC), e.g. ${apiReachesBot.slice(0, 8).map((r) => '`' + s(r.path) + '`').join(', ')}. Any module state in them exists twice (once per process) today.`);
const sharedState = stateful.filter((r) => r.processes.filter((p) => p !== 'script').length >= 2);
const reachers = (rp_) => files.get(P(rp_)).reachableFrom;
L.push(`- AST function registry: \`utils/ast_parser/evaluator.ts\` keeps module-level \`functionRegistry\`/\`functionMetadataRegistry\` Maps filled by \`registerAllFunctions()\` (\`utils/ast_parser/functions/index.ts\`). \`createSpecialExecutionContext\` in \`handlers/special_parser.handler.ts\` calls it with defaults, which also starts the restore-moderator \`setInterval\` loop (\`startRestoreModeratorWorker\`, \`utils/ast_parser/functions/moderation.functions.ts\`) once per process. The special parser is reachable from: ${reachers('handlers/special_parser.handler.ts').join(', ')}. So the API, the bot and several cron workers can each run that loop; only \`utils/ast_parser/simulate.ts\` opts out. A Rust port must decide which single process owns it.`);
const wk = entries.filter((e) => e.id.startsWith('cron:') && e.id !== 'cron:supervisor').map((e) => ({ e, n: nt.filter((r) => r.reachableFrom.includes(e.id)), self: files.get(e.path).loc }));
const heavy = wk.filter((w) => sum(w.n.map((r) => r.loc)) > 20000);
L.push(`- Worker closures: ${heavy.length} of ${wk.length} cron workers pull more than 20k LOC by value imports even when the worker file itself is small (${heavy.map((w) => `${w.e.id} ${w.self} -> ${fmt(sum(w.n.map((r) => r.loc)))}`).join('; ')}). They reach the command engine / realtime crates through shared helpers, so a Rust cron binary would link nearly everything unless those paths are cut.`);
L.push('- Process-local queues and timers live in modules shared by several processes (e.g. `pets/readiness.ts`, `desktop_ai/updates.ts`, `overlays/ad-schedule.ts`, `goals/twitch-store.ts` in the table above). Each Node process has its own copy today; cross-process coordination goes through Dragonfly pub/sub (`classes/pubsub_manager.class.ts`) and Mongo.');
L.push(`- ${sharedState.length} stateful modules are loaded by 2+ processes (table above). Caches among them are per-process and coherent only through Dragonfly/Mongo; a Rust port must not assume a process-local cache is authoritative.`);
L.push('');
fs.writeFileSync(path.join(OUT_DIR, 'modules.md'), L.join('\n'));
console.log(`files=${files.size} loc=${json.totals.loc} nonTest=${nonTest.size}/${nonTestLoc} packages=${packages.length} crates=${crateNames.length} waves=${maxWave + 1} cycles=${cycles.length} orphans=${orphans.length} crateCycles=${crateCycles.length} pkgCycles=${pkgCycles.length} crossing=${cyclesCrossingCrates.length}`);
