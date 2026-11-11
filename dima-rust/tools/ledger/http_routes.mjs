#!/usr/bin/env node
// Extracts every Express route registered by dimabot into a JSON list.
// Read-only: parses TypeScript sources with the compiler API from dimabot/node_modules.
// Usage: node dima-rust/tools/ledger/http_routes.mjs > routes.raw.json
// The ledger dima-rust/ledger/http.json was built from this output plus manual review.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bot = path.join(repo, 'dimabot');
const ts = createRequire(path.join(bot, 'package.json'))('typescript');
const rel = (f) => path.relative(repo, f);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.includes('test_util')) out.push(p);
  }
  return out;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'options', 'head']);
const files = walk(path.join(bot, 'src'));
const sources = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (!/express/.test(text)) continue;
  sources.set(f, ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

const line = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const endLine = (sf, node) => sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
const isExpressRouterCall = (n) => ts.isCallExpression(n) && (/^express\.Router$|^Router$|^express$/.test(n.expression.getText()));

// --- 1. routers per file -------------------------------------------------
const routers = new Map(); // id -> {file, name, kind, line, mergeParams}
const fileVars = new Map(); // file -> Map(varName -> routerId)
const exportsMap = new Map(); // file -> Map(exportName -> routerId)
for (const [f, sf] of sources) {
  const vars = new Map(); const exps = new Map();
  fileVars.set(f, vars); exportsMap.set(f, exps);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      let init = n.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (isExpressRouterCall(init)) {
        const id = `${rel(f)}#${n.name.text}@${line(sf, n)}`;
        routers.set(id, { id, file: rel(f), name: n.name.text, kind: init.expression.getText() === 'express' ? 'app' : 'router', line: line(sf, n), options: init.arguments.map(a => a.getText()).join(', ') });
        vars.set(n.name.text, id);
      } else if (ts.isIdentifier(init) && vars.has(init.text)) {
        vars.set(n.name.text, vars.get(init.text));
      } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        // factory function in same file returning a router (polar webhook)
        const fnName = init.expression.text;
        for (const [k, v] of vars) if (v.startsWith(`${rel(f)}#`) && routers.get(v).factory === fnName) vars.set(n.name.text, v);
      }
      if (n.parent?.parent?.parent && ts.isVariableStatement(n.parent.parent) && n.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && vars.has(n.name.text)) exps.set(n.name.text, vars.get(n.name.text));
    }
    if (ts.isFunctionDeclaration(n) && n.name) {
      // remember the factory owning a router declared inside it
      const before = new Set(vars.keys());
      ts.forEachChild(n, visit);
      for (const k of vars.keys()) if (!before.has(k)) routers.get(vars.get(k)).factory = n.name.text;
      return;
    }
    if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression) && vars.has(n.expression.text)) exps.set('default', vars.get(n.expression.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // second pass for aliases declared after the router (export const x = router)
  visit(sf);
}

// imports: local name -> routerId
function importedRouters(f) {
  const sf = sources.get(f); const out = new Map(fileVars.get(f) || []);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text; if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec.replace(/\.js$/, '.ts'));
    const exps = exportsMap.get(target); if (!exps) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
      const orig = (el.propertyName || el.name).text; if (exps.has(orig)) out.set(el.name.text, exps.get(orig));
    }
    if (st.importClause.name && exps.has('default')) out.set(st.importClause.name.text, exps.get('default'));
  }
  return out;
}

// local function declarations (top-level + nested consts with arrow fns)
function localFunctions(sf) {
  const map = new Map();
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) map.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) map.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

// --- 2. analyse handler bodies -------------------------------------------
function analyse(sf, nodes, fns, depth = 3, seen = new Set()) {
  const r = { status: new Set(), implicit200: false, envelopeOnly: new Set(), kinds: new Set(), headersRead: new Set(), headersSet: new Set(), notes: new Set(), helpers: new Set(), authCalls: new Set(), errorClasses: new Set() };
  const num = (e) => e && ts.isNumericLiteral(e) ? Number(e.text) : null;
  const inRange = (v) => v !== null && v >= 100 && v <= 599;
  const chainHasStatus = (expr) => { let e = expr; while (e) { if (ts.isCallExpression(e)) { const c = e.expression; if (ts.isPropertyAccessExpression(c) && ['status', 'sendStatus', 'writeHead'].includes(c.name.text)) return true; e = ts.isPropertyAccessExpression(c) ? c.expression : null; } else if (ts.isPropertyAccessExpression(e)) e = e.expression; else return false; } return false; };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
      const a0 = n.arguments[0];
      if (ts.isPropertyAccessExpression(c)) {
        if ((name === 'status' || name === 'sendStatus') && inRange(num(a0))) r.status.add(num(a0));
        if ((name === 'status' || name === 'sendStatus') && a0 && !num(a0)) r.notes.add(`dynamic status: ${c.getText(sf).slice(0, 20)}(${a0.getText(sf).slice(0, 60)})`);
        if (name === 'writeHead' && inRange(num(a0))) { r.status.add(num(a0)); }
        if (name === 'redirect') { r.kinds.add('redirect'); if (inRange(num(a0))) r.status.add(num(a0)); else r.status.add(302); }
        if (name === 'json' && /\bres\b|response|reply/i.test(c.expression.getText(sf).split('.')[0])) {
          r.kinds.add(a0 && ts.isObjectLiteralExpression(a0) && a0.properties.some(p => p.name?.getText(sf) === 'error') ? 'json envelope' : 'json');
          if (!chainHasStatus(c.expression)) r.implicit200 = true;
          if (a0 && ts.isObjectLiteralExpression(a0) && !chainHasStatus(c.expression)) for (const p of a0.properties) if (p.name?.getText(sf) === 'status' && ts.isPropertyAssignment(p) && inRange(num(p.initializer)) && num(p.initializer) !== 200) r.envelopeOnly.add(num(p.initializer));
        }
        if (name === 'send' && /^res\b/.test(c.expression.getText(sf))) { r.kinds.add('send'); if (!chainHasStatus(c.expression)) r.implicit200 = true; }
        if (name === 'sendStatus') r.kinds.add('empty');
        if (name === 'end' && /^res\b/.test(c.expression.getText(sf))) r.kinds.add('end');
        if (['sendFile', 'download', 'attachment'].includes(name)) { r.kinds.add('file/stream'); r.notes.add(`res.${name}`); if (!chainHasStatus(c.expression)) r.implicit200 = true; }
        if (name === 'pipe' || name === 'pipeline') { r.kinds.add('file/stream'); r.notes.add('stream pipe'); }
        if (name === 'write' && /^res\b/.test(c.expression.getText(sf))) r.notes.add('res.write (streaming body)');
        if (name === 'flushHeaders') r.notes.add('flushHeaders');
        if (name === 'cookie' || name === 'clearCookie') { r.notes.add(`sets cookie (res.${name})`); }
        if ((name === 'header' || name === 'get') && /^req\b/.test(c.expression.getText(sf)) && a0 && ts.isStringLiteral(a0)) r.headersRead.add(a0.text.toLowerCase());
        if ((name === 'setHeader' || name === 'set' || name === 'header' || name === 'type' || name === 'append') && /^res\b/.test(c.expression.getText(sf)) && a0) {
          if (ts.isStringLiteral(a0)) r.headersSet.add(name === 'type' ? `content-type=${a0.text}` : a0.text + (n.arguments[1] && ts.isStringLiteralLike(n.arguments[1]) ? `=${n.arguments[1].text}` : ''));
          else if (ts.isObjectLiteralExpression(a0)) for (const p of a0.properties) r.headersSet.add(p.name?.getText(sf).replace(/['"]/g, '') + (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer) ? `=${p.initializer.text}` : ''));
        }
        if (name === 'on' && /^(req|res)\b/.test(c.expression.getText(sf)) && a0 && ts.isStringLiteral(a0)) r.notes.add(`${c.expression.getText(sf)}.on('${a0.text}')`);
      }
      if (name && AUTH_RE.test(name) && !/^(set|get|has|includes|test|exec|replace)$/.test(name)) r.authCalls.add(name);
      if (ts.isIdentifier(c) && (name === 'pipeline' || name === 'serveAsset')) { r.kinds.add('file/stream'); r.notes.add(name === 'serveAsset' ? 'serveAsset (src/assets/http.ts:5): Range/206/416, HEAD, optional ETag+304' : 'stream pipeline'); }
      if (name === 'fetch') r.notes.add(`outbound fetch(${a0 ? a0.getText(sf).slice(0, 70) : ''})`);
      // helper(res, 400, ...) / fail(res, 429, ...)
      if (!['status', 'sendStatus', 'writeHead', 'setTimeout', 'setInterval', 'slice', 'substring', 'min', 'max', 'round', 'floor', 'ceil', 'toFixed', 'padStart', 'parseInt', 'Number', 'limit', 'skip', 'sort', 'repeat', 'hitRateLimit', 'rateLimit', 'expire', 'set', 'get', 'clamp'].includes(name)) {
        for (const a of n.arguments) { const v = num(a); if (inRange(v) && v >= 200 && /fail|err|send|respond|reply|status|http|json|deny|reject|problem|bad|abort|ok|forbid|unauth|notfound|conflict|result|finish|write/i.test(name)) { r.status.add(v); r.helpers.add(name); } }
      }
      if (ts.isIdentifier(c) && fns.has(c.text) && depth > 0 && !seen.has(c.text) && n.arguments.some(a => /\bres\b/.test(a.getText(sf)))) {
        seen.add(c.text); r.helpers.add(c.text);
        merge(r, analyse(sf, [fns.get(c.text)], fns, depth - 1, seen));
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && /Error$/.test(n.right.getText(sf))) r.errorClasses.add(n.right.getText(sf));
    if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText(sf))) r.errorClasses.add(n.expression.getText(sf));
    if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText(sf))) for (const a of n.arguments || []) { const v = num(a); if (inRange(v) && v >= 400) r.status.add(v); }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && /statusCode$/.test(n.left.getText(sf)) && inRange(num(n.right))) r.status.add(num(n.right));
    if (ts.isStringLiteralLike(n)) {
      if (n.text.startsWith('text/event-stream')) r.kinds.add('sse');
      if (/<!doctype html|<html/i.test(n.text)) r.kinds.add('html');
    }
    if (ts.isTemplateExpression(n) && /<!doctype html|<html/i.test(n.getText(sf))) r.kinds.add('html');
    if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === 'req.headers') r.headersRead.add(n.name.text.toLowerCase());
    if (ts.isElementAccessExpression(n) && /^req\.headers$/.test(n.expression.getText(sf)) && ts.isStringLiteral(n.argumentExpression)) r.headersRead.add(n.argumentExpression.text.toLowerCase());
    if (ts.isPropertyAccessExpression(n) && n.getText(sf) === 'req.ip') r.notes.add('uses req.ip (no trust proxy set: socket address)');
    if (ts.isIdentifier(n) && (n.text === 'setInterval')) r.notes.add('setInterval in handler');
    ts.forEachChild(n, visit);
  };
  for (const node of nodes) visit(node);
  return r;
}
const AUTH_RE = /auth|access|permission|admin|owner|token|verify|validat|signature|ticket|capabilit|premium|requirePlan|Plan$|browserUser|whitelist|creator|secret|session/i;
function merge(a, b) { for (const k of ['status', 'envelopeOnly', 'kinds', 'headersRead', 'headersSet', 'notes', 'helpers', 'authCalls', 'errorClasses']) for (const v of b[k]) a[k].add(v); a.implicit200 ||= b.implicit200; }

// --- 3. registrations ----------------------------------------------------
const regs = []; // {routerId, method, path, pathKind, args[], line, file, node, sf}
const unresolved = [];
for (const [f, sf] of sources) {
  const vars = importedRouters(f);
  const fns = localFunctions(sf);
  const visit = (n, loopBindings) => {
    // expand `for (const [method, path, ...] of [ [...], ... ] as const) X[method](path, ...)`
    if (ts.isForOfStatement(n)) {
      let arr = n.expression; while (ts.isAsExpression(arr)) arr = arr.expression;
      const decl = n.initializer.declarations?.[0];
      if (ts.isArrayLiteralExpression(arr) && decl && ts.isArrayBindingPattern(decl.name)) {
        const names = decl.name.elements.map(e => e.name?.text);
        for (const el of arr.elements) {
          if (!ts.isArrayLiteralExpression(el)) continue;
          const b = new Map(); names.forEach((nm, i) => { const v = el.elements[i]; if (nm && v && ts.isStringLiteral(v)) b.set(nm, v.text); });
          ts.forEachChild(n.statement, (c) => visit(c, b));
        }
        return;
      }
    }
    if (ts.isCallExpression(n)) {
      const c = n.expression; let target, method;
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && METHODS.has(c.name.text)) { target = c.expression.text; method = c.name.text; }
      if (ts.isElementAccessExpression(c) && ts.isIdentifier(c.expression)) { target = c.expression.text; const k = c.argumentExpression; method = ts.isIdentifier(k) && loopBindings?.get(k.text); if (!method && vars.has(target)) unresolved.push({ file: rel(f), line: line(sf, n), code: n.getText(sf).slice(0, 120), reason: 'computed method' }); }
      if (target && method && vars.has(target)) {
        const args = [...n.arguments];
        let p = null, pathKind = 'none';
        if (args[0] && (ts.isStringLiteralLike(args[0]) || ts.isRegularExpressionLiteral(args[0]) || ts.isArrayLiteralExpression(args[0]) || ts.isTemplateExpression(args[0]) || (ts.isIdentifier(args[0]) && loopBindings?.has(args[0].text)))) {
          const a = args.shift();
          if (ts.isStringLiteralLike(a)) { p = a.text; pathKind = 'string'; }
          else if (ts.isIdentifier(a)) { p = loopBindings.get(a.text); pathKind = 'string(loop)'; }
          else if (ts.isRegularExpressionLiteral(a)) { p = a.text; pathKind = 'regex'; }
          else { p = a.getText(sf); pathKind = 'dynamic'; unresolved.push({ file: rel(f), line: line(sf, n), code: n.getText(sf).slice(0, 120), reason: 'non-literal path' }); }
        } else if (method !== 'use' && args[0] && ts.isIdentifier(args[0]) && !fns.has(args[0].text) && !vars.has(args[0].text)) {
          unresolved.push({ file: rel(f), line: line(sf, n), code: n.getText(sf).slice(0, 120), reason: 'path is an identifier' });
        }
        regs.push({ routerId: vars.get(target), method, path: p, pathKind, args, line: line(sf, n), endLine: endLine(sf, n), file: f, sf, fns, vars, loopBound: Boolean(loopBindings), node: n });
      }
    }
    ts.forEachChild(n, (c) => visit(c, loopBindings));
  };
  visit(sf, null);
}

function argInfo(r, a) {
  const sf = r.sf; let e = a; while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e) && r.vars.has(e.text)) return { type: 'router', routerId: r.vars.get(e.text), text: e.text };
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { type: e.parameters.length === 4 ? 'errorHandler' : 'inline', text: `inline@${line(sf, e)}`, node: e, params: e.parameters.length };
  if (ts.isIdentifier(e)) { const fn = r.fns.get(e.text); return { type: fn && fn.parameters?.length === 4 ? 'errorHandler' : 'named', text: e.text, node: fn }; }
  return { type: 'call', text: e.getText(sf).replace(/\s+/g, ' ').slice(0, 160), node: e };
}

// --- 4. mount tree + flatten -------------------------------------------------
const join = (a, b) => { const s = (a + '/' + (b ?? '')).replace(/\/+/g, '/'); return s.length > 1 ? s.replace(/\/$/, '') : s; };
function pathRegex(p, end) {
  // Express 4 / path-to-regexp 0.1: params match [^/]+?, use() is prefix match on segment boundary, case-insensitive
  const src = p.replace(/[.+*?^${}()|[\]\\]/g, (m) => m === '*' ? '.*' : '\\' + m).replace(/\\?:(\w+)(\\\?)?/g, (_m, _n, opt) => opt ? '(?:[^/]+?)?' : '[^/]+?');
  return new RegExp('^' + (src === '/' ? '' : src) + (end ? '/?$' : '(?:/|$)'), 'i');
}
const roots = [...routers.values()].filter(r => r.kind === 'app');
const out = []; const mws = {}; const mounts = [];
function flatten(routerId, prefix, inherited, app, mountChain) {
  const own = regs.filter(r => r.routerId === routerId).sort((a, b) => a.node.pos - b.node.pos);
  const chain = [];
  for (const r of own) {
    const infos = r.args.map(a => argInfo(r, a));
    if (r.method === 'use') {
      const sub = infos.find(i => i.type === 'router');
      if (sub) {
        const prev = [...inherited, ...chain.filter(m => pathRegex(m.fullPath, false).test(join(prefix, r.path ?? '/')) || (m.fullPath === prefix))];
        mounts.push({ app, at: join(prefix, r.path ?? '/'), router: routers.get(sub.routerId).file + '#' + routers.get(sub.routerId).name, file: rel(r.file), line: r.line, extraMiddleware: infos.filter(i => i.type !== 'router').map(i => i.text) });
        flatten(sub.routerId, join(prefix, r.path ?? '/'), prev.filter(m => m.fullPath === '/' || true), app, [...mountChain, { file: rel(r.file), line: r.line }]);
        // middleware listed alongside the router in the same use() call
        continue;
      }
      for (const i of infos) {
        const m = { name: i.text, kind: i.type, fullPath: join(prefix, r.path ?? '/'), scope: r.path ?? '(all)', file: rel(r.file), line: r.line, node: i.node, sf: r.sf, fns: r.fns };
        chain.push(m);
        (mws[routerId] ||= []).push({ name: i.text, kind: i.type, path: r.path ?? null, mountedAt: join(prefix, r.path ?? '/'), file: rel(r.file), line: r.line });
      }
      continue;
    }
    const full = join(prefix, r.path ?? '/');
    const handler = infos[infos.length - 1];
    const routeMw = infos.slice(0, -1);
    const applicable = [...inherited, ...chain].filter(m => m.kind !== 'errorHandler' && (m.scope === '(all)' && m.fullPath === '/' ? true : pathRegex(m.fullPath, false).test(full.replace(/:\w+\??/g, 'X'))) );
    const errorHandlers = chain.filter(m => m.kind === 'errorHandler').concat(regs.filter(x => x.routerId === routerId && x.method === 'use' && x.node.pos > r.node.pos).flatMap(x => x.args.map(a => argInfo(x, a)).filter(i => i.type === 'errorHandler').map(i => ({ name: i.text, node: i.node, sf: x.sf, fns: x.fns, file: rel(x.file), line: line(x.sf, i.node) }))));
    const nodes = []; for (const i of [...routeMw, handler]) if (i.node) nodes.push(i.node);
    const an = analyse(r.sf, nodes, r.fns);
    // inline/local middlewares that can short-circuit
    const mwAn = analyse(r.sf, [], r.fns);
    for (const m of applicable) if (m.node && (m.kind === 'inline' || (m.kind === 'named' && m.node))) merge(mwAn, analyse(m.sf, [m.node], m.fns));
    const ehAn = analyse(r.sf, [], r.fns); for (const e of errorHandlers) if (e.node) merge(ehAn, analyse(e.sf, [e.node], e.fns));
    out.push({
      app, method: r.method.toUpperCase(), path: full, pathKind: r.pathKind, routerPath: r.path, file: rel(r.file), line: r.line, handlerLines: [r.line, r.endLine],
      mountChain,
      middlewareApplied: applicable.map(m => `${m.name}${m.scope !== '(all)' ? ` [use ${m.fullPath}]` : ''} (${m.file}:${m.line})`),
      routeMiddleware: routeMw.map(i => i.text),
      handler: handler?.text,
      statusFromHandler: [...an.status].sort(), implicit200: an.implicit200, envelopeStatusWithHttp200: [...an.envelopeOnly].sort(),
      statusFromMiddleware: [...mwAn.status].sort(), statusFromErrorHandler: [...ehAn.status].sort(), errorHandlers: errorHandlers.map(e => `${e.file}:${e.line}`),
      authCalls: [...new Set([...mwAn.authCalls, ...an.authCalls])], errorClasses: [...new Set([...an.errorClasses, ...mwAn.errorClasses, ...ehAn.errorClasses])], kinds: [...an.kinds], headersRead: [...an.headersRead, ...mwAn.headersRead], headersSet: [...new Set([...mwAn.headersSet, ...an.headersSet])], notes: [...an.notes], helpers: [...an.helpers], loopBound: r.loopBound,
    });
  }
}
for (const app of roots) flatten(app.id, '', [], app.file.includes('eventsub') ? 'eventsub' : app.file.includes('server.ts') ? 'api' : app.file, []);
const mountedRouters = new Set(mounts.map(m => m.router));
const unmounted = [...routers.values()].filter(r => r.kind === 'router' && !mountedRouters.has(r.file + '#' + r.name)).map(r => ({ file: r.file, name: r.name, line: r.line, registrations: regs.filter(x => x.routerId === r.id).map(x => `${x.method.toUpperCase()} ${x.path ?? ''} :${x.line}`) }));
// statuses each custom error class can carry: constructor default + numeric literals at every `new X(` site
const errorClassStatus = {};
for (const f of walk(path.join(bot, 'src'))) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  const v = (n) => {
    if (ts.isClassDeclaration(n) && n.name && /Error$/.test(n.name.text)) {
      const set = (errorClassStatus[n.name.text] ||= { defaults: [], literals: [], extends: n.heritageClauses?.[0]?.types[0]?.expression.getText(sf), at: `${rel(f)}:${line(sf, n)}` });
      for (const m of n.members) if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) if (p.initializer && ts.isNumericLiteral(p.initializer)) set.defaults.push(Number(p.initializer.text));
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /Error$/.test(n.expression.text)) for (const a of n.arguments || []) if (ts.isNumericLiteral(a) && +a.text >= 400 && +a.text <= 599) ((errorClassStatus[n.expression.text] ||= { defaults: [], literals: [] }).literals).push(+a.text);
    ts.forEachChild(n, v);
  };
  v(sf);
}
for (const k of Object.keys(errorClassStatus)) { const e = errorClassStatus[k]; e.literals = [...new Set(e.literals)].sort(); e.defaults = [...new Set(e.defaults)]; }
const counts = { registrationsTotal: regs.length, routeRegistrations: regs.filter(r => r.method !== 'use').length, flattenedRoutes: out.length };
process.stdout.write(JSON.stringify({ counts, errorClassStatus, routers: [...routers.values()], mounts, middlewares: mws, routes: out, unmounted, unresolved }, null, 1));
