// Source-backed AST syntax fixtures for the dima-rust AST syntax port.
//
// Regenerate/check without a TS loader or application imports:
//   node dima-rust/tests/fixtures/ast_syntax_reference.mjs [--check]
//
// The authoritative sources are the actual TypeScript syntax modules
//   dimabot/src/utils/ast_parser/{types,tokenizer,registry,parser,render}.ts
// Only pure declarations are copied, every import/export-from is dropped, and
// the result runs in an isolated VM. render.ts imports the evaluator, so its
// evaluator-dependent `renderAstWithSourceReference` is deliberately excluded;
// the pure scanner/unescape declarations are extracted instead. No TS barrel,
// evaluator, function registry, service, network, clock, or environment module
// is imported or started.
//
// Every case stores the unmodified TypeScript oracle result (`source`) plus the
// expectations for two Rust modes:
//   - legacy:  byte-for-byte source behaviour (the oracle result; exact error
//              messages and exact [Parse error: ...] template text included)
//   - default: the same result for unchanged cases, or the explicit expectation
//              for a subcase of user-approved item 4 (scanner/template scanning,
//              including quote state inside ${...} interpolations) or item 5
//              (nested parse diagnostics). Those are five fixture categories,
//              not five semantic approvals; the four approved optimizations are
//              performance-only and are not semantic changes.
// The JSON manifest separates source parity from approved subcases; this is not
// a claim that the default mode has no semantic differences. A single source
// occurrence can exercise item 4 and item 5 at once (the bracket-aware scanner
// keeps one expression segment and the nested tokenizer then rejects it). Those
// cases stay inside the five categories: `approved.code` is the primary
// category and `approved.combinedCategories` names the second policy.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from '../../../dimabot/node_modules/typescript/lib/typescript.js';

const sourceRoot = new URL('../../../dimabot/src/utils/ast_parser/', import.meta.url);
const outputUrl = new URL('ast_syntax_cases.json', import.meta.url);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// types.ts is type-only: hash it, never transpile it. The other four modules
// have runtime declarations; only the listed statements are copied.
const SOURCE_FILES = ['types.ts', 'tokenizer.ts', 'registry.ts', 'parser.ts', 'render.ts'];
const SELECTIONS = {
  'tokenizer.ts': [
    'ESCAPABLE_CHARS', 'ESCAPE_REGEX', 'unescapeLiteral', 'validateDelimiters', 'tokenize'
  ],
  'registry.ts': [
    'parseVarName', 'parseLiteral', 'isLoopVarToken', 'createLoopVarNode', 'parseTokensToNodes',
    'parseTokensToSingleNode', 'findTopLevelToken', 'parseLoopVarOrAssignment', 'parseTemplateString',
    'splitArrayLiteralItems', 'parseArrayLiteral', 'parseArrayLiteralAccessor', 'parseArrayLiteralToken',
    'parseExpression', 'parseVarTarget', 'parseVariable', 'parseExists', 'parseDelete', 'parseCommandRef',
    'parseFunction', 'COMPARISON_OPERATORS', 'ARITHMETIC_HIGH', 'ARITHMETIC_LOW', 'ALL_BINARY_OPS',
    'isBinaryOperator', 'getPrecedence', 'parseAtom', 'parseStarExpression', 'parseForLoop', 'parseCompute',
    'createSyntaxRegistry', 'SyntaxRegistry', 'registerSyntax'
  ],
  'parser.ts': ['parse'],
  'render.ts': [
    'isEscaped', 'findExpressionEnd', 'getStartTokens', 'findMatchingStartToken',
    'unescapeRenderedText', 'scanSourceSegments'
  ]
};

const sources = {};
const chunks = [];
for (const file of SOURCE_FILES) {
  const input = await readFile(new URL(file, sourceRoot), 'utf8');
  sources[file] = sha256(input);
}
for (const [file, wanted] of Object.entries(SELECTIONS)) {
  const input = await readFile(new URL(file, sourceRoot), 'utf8');
  const ast = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
  const selected = new Set(wanted);
  const found = new Set();
  const statements = ast.statements.filter((statement) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return false;
    const names = ts.isFunctionDeclaration(statement)
      ? (statement.name ? [statement.name.text] : [])
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => declaration.name.getText(ast))
        : [];
    if (names.length === 0 || names.some((name) => !selected.has(name))) return false;
    names.forEach((name) => found.add(name));
    return true;
  });
  assert.deepEqual(
    [...found].sort(),
    [...selected].sort(),
    `declaration selection drift in ${file}`
  );
  chunks.push(`// ---- ${file} (selected pure declarations) ----\n${statements
    .map((statement) => statement.getText(ast))
    .join('\n')}`);
}

const transpiled = ts.transpileModule(chunks.join('\n'), {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
const diagnostics = (transpiled.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(
  diagnostics.length,
  0,
  `extracted declarations do not compile: ${diagnostics.map((d) => d.messageText).join('; ')}`
);
// Guard the isolation promise: the VM module must not pull in any runtime
// dependency (no evaluator, functions, services, environment, or clock).
assert.ok(!/\brequire\s*\(/.test(transpiled.outputText), 'extracted module must not require() anything');
assert.ok(!/\bevaluator\b/.test(transpiled.outputText), 'extracted module must not mention the evaluator');
assert.ok(!/renderAstWithSourceReference/.test(transpiled.outputText), 'evaluator-linked renderer must stay out');
assert.ok(!/\bimport\s+/.test(transpiled.outputText), 'extracted module must not retain imports');

const context = vm.createContext({ exports: {} });
new vm.Script(transpiled.outputText, { filename: 'ast-syntax.isolated.js' })
  .runInContext(context, { timeout: 2000 });
const api = context.exports;
for (const name of ['parse', 'tokenize', 'unescapeLiteral', 'scanSourceSegments', 'unescapeRenderedText']) {
  assert.equal(typeof api[name], 'function', `missing extracted symbol ${name}`);
}

const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The expected values are normalized to the finalized API contract:
//   parse / segment program: { outcome: "program", ast } or
//                            { outcome: "diagnostic", diagnostic }
//   diagnostic:              { code, message, span: { start, end } } (UTF-16)
// The raw TypeScript oracle result is still stored untouched in `source`
// (ast/error/thrown), so legacy expectations are never silently rewritten.
const CLOSER_PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const REGISTRY = api.SyntaxRegistry;
assert.equal(typeof REGISTRY?.get, 'function', 'missing extracted SyntaxRegistry');

function parseResult(source) {
  try {
    const result = api.parse(source);
    return result.error === undefined
      ? { ast: json(result.ast) }
      : { ast: json(result.ast), error: result.error };
  } catch (error) {
    return { thrown: { name: error.name, message: error.message } };
  }
}

function diagnosticCode(message) {
  if (message === 'Unclosed quoted string') return 'UNCLOSED_QUOTE';
  if (message === 'Unclosed array literal') return 'UNCLOSED_ARRAY';
  if (message.startsWith('Unexpected closing ')) return 'UNEXPECTED_CLOSING';
  if (message.startsWith('Unclosed ')) return 'UNCLOSED_DELIMITER';
  if (message.startsWith('Unexpected token ')) return 'UNEXPECTED_TOKEN';
  if (message === 'Unclosed expression') return 'UNCLOSED_EXPRESSION';
  if (message === 'Missing variable name') return 'MISSING_VARIABLE_NAME';
  throw new Error(`unmapped diagnostic message: ${message}`);
}

// Map the real tokenizer's ordered token list back onto UTF-16 source offsets.
// This locates diagnostics; it does not change or reimplement parsing.
function mapTokenSpans(source, tokens) {
  let cursor = 0;
  const spans = [];
  for (const token of tokens) {
    let start;
    let end;
    if (token.startsWith('__TEMPLATE__:')) {
      const content = token.slice('__TEMPLATE__:'.length);
      start = source.indexOf('"', cursor);
      assert.ok(start >= cursor, `quoted token not found in ${JSON.stringify(source)}`);
      assert.equal(source.slice(start + 1, start + 1 + content.length), content,
        `quoted token content drift in ${JSON.stringify(source)}`);
      end = start + 1 + content.length + 1;
    } else if (token.startsWith('__ARRAY__:')) {
      const content = token.slice('__ARRAY__:'.length);
      start = source.indexOf('%[', cursor);
      assert.ok(start >= cursor, `array token not found in ${JSON.stringify(source)}`);
      assert.equal(source.slice(start + 2, start + 2 + content.length), content,
        `array token content drift in ${JSON.stringify(source)}`);
      end = start + 2 + content.length + 1;
    } else {
      start = source.indexOf(token, cursor);
      assert.ok(start >= cursor, `token ${JSON.stringify(token)} not found at/after ${cursor} in ${JSON.stringify(source)}`);
      end = start + token.length;
    }
    spans.push({ token, start, end });
    cursor = end;
  }
  return { spans, cursor };
}

function locateDiagnostic(source, message) {
  const tokenized = api.tokenize(source);
  const { spans, cursor } = mapTokenSpans(source, tokenized.tokens);

  if (message === 'Unclosed quoted string') {
    const start = source.indexOf('"', cursor);
    assert.ok(start >= cursor, `unterminated quote not found in ${JSON.stringify(source)}`);
    return { start, end: source.length };
  }
  if (message === 'Unclosed array literal') {
    const start = source.indexOf('%[', cursor);
    assert.ok(start >= cursor, `unclosed array opener not found in ${JSON.stringify(source)}`);
    return { start, end: source.length };
  }

  const stack = [];
  for (const span of spans) {
    const { token } = span;
    if (REGISTRY.has(token)) {
      stack.push({ ...span, closing: REGISTRY.get(token).endToken });
    } else if (CLOSER_PAIRS[token]) {
      stack.push({ ...span, closing: CLOSER_PAIRS[token] });
    } else if (CLOSERS.has(token)) {
      if (stack.at(-1)?.closing !== token) {
        assert.ok(message.startsWith('Unexpected closing '), `unexpected stack mismatch for ${message}`);
        return { start: span.start, end: span.end };
      }
      stack.pop();
    }
  }

  const top = stack.at(-1);
  assert.ok(top, `no unmatched opener for ${message}`);
  assert.ok(message.startsWith('Unclosed '), `unmapped delimiter diagnostic ${message}`);
  return { start: top.start, end: top.end };
}

function diagnosticFor(source, message) {
  return { code: diagnosticCode(message), message, span: locateDiagnostic(source, message) };
}

function shiftDiagnostic(diagnostic, offset) {
  if (offset === 0) return diagnostic;
  return {
    ...diagnostic,
    span: { start: diagnostic.span.start + offset, end: diagnostic.span.end + offset }
  };
}

function normalizeParse(raw, source, offset = 0) {
  if (raw.thrown) throw new Error(`cannot normalize a source-oracle throw: ${JSON.stringify(source)}`);
  if (raw.error !== undefined) {
    return {
      outcome: 'diagnostic',
      diagnostic: shiftDiagnostic(diagnosticFor(source, raw.error), offset)
    };
  }
  return { outcome: 'program', ast: raw.ast };
}

function locateToken(source, token, from = 0) {
  const start = source.indexOf(token, from);
  assert.ok(start >= from, `token ${JSON.stringify(token)} not found in ${JSON.stringify(source)}`);
  assert.equal(source.slice(start, start + token.length), token);
  return { start, end: start + token.length };
}

// Attach UTF-16 half-open spans to scanner segments. Segments are contiguous
// and cover the input, so sequential matching is exact without re-tokenizing.
function withSpans(source, segments) {
  let cursor = 0;
  const result = segments.map((segment) => {
    const text = segment.kind === 'text' ? segment.text : segment.source;
    const start = source.indexOf(text, cursor);
    assert.ok(start >= cursor, `segment ${JSON.stringify(text)} not found at/after ${cursor} in ${JSON.stringify(source)}`);
    const span = { start, end: start + text.length };
    cursor = span.end;
    return { ...segment, span };
  });
  assert.equal(cursor, source.length, `segments do not cover source exactly: ${JSON.stringify(source)}`);
  return result;
}

// Compiled-template plan. Expression diagnostics are shifted to the original
// template source offsets (contract: UTF-16 offsets refer to original source).
function planSegments(source, segments) {
  return withSpans(source, segments).map((segment) => {
    if (segment.kind === 'text') return segment;
    if (segment.kind === 'unclosed') {
      return {
        ...segment,
        diagnostic: { code: 'UNCLOSED_EXPRESSION', message: 'Unclosed expression', span: segment.span }
      };
    }
    return {
      ...segment,
      program: normalizeParse(parseResult(segment.source), segment.source, segment.span.start)
    };
  });
}

const cases = [];
const seenNames = new Set();
let counter = 0;
const slug = (text) => text
  .replace(/[^A-Za-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 44) || 'empty';

function addCase(operation, section, sourceKey, input, source, expected, meta = {}) {
  counter += 1;
  const name = `${String(counter).padStart(4, '0')}-${section}-${slug(sourceKey)}`;
  assert.ok(!seenNames.has(name), `duplicate case name ${name}`);
  seenNames.add(name);
  cases.push({
    name,
    operation,
    input: json(input),
    source: json(source),
    expected: {
      legacy: json(expected.legacy),
      default: json(expected.default)
    },
    parity: meta.parity ?? 'source-parity',
    ...(meta.approved ? { approved: meta.approved } : {})
  });
}

function addParse(section, source) {
  const raw = parseResult(source);
  assert.ok(!raw.thrown, `unexpected source-oracle throw in a parity case: ${JSON.stringify(source)}`);
  const normalized = normalizeParse(raw, source);
  addCase('parse', section, source, { source }, raw, { legacy: normalized, default: normalized });
}

function addScan(section, source) {
  const raw = { segments: json(api.scanSourceSegments(source)) };
  const normalized = { segments: withSpans(source, raw.segments) };
  addCase('scan', section, source, { source }, raw, { legacy: normalized, default: normalized });
}

function addUnescape(section, surface, value) {
  const actual = surface === 'literal'
    ? { value: api.unescapeLiteral(value) }
    : { value: api.unescapeRenderedText(value) };
  addCase('unescape', section, `${surface}:${String(value)}`, { surface, value }, actual,
    { legacy: actual, default: actual });
}

function rawCompiledSegments(segments) {
  return segments.map((segment) => {
    if (segment.kind !== 'expr') return json(segment);
    return { kind: 'expr', source: segment.source, parse: parseResult(segment.source) };
  });
}

function addCompiled(section, source) {
  const rawSegments = json(api.scanSourceSegments(source));
  const raw = { segments: rawCompiledSegments(rawSegments) };
  const normalized = { segments: planSegments(source, rawSegments) };
  addCase('compiled-template', section, source, { source }, raw,
    { legacy: normalized, default: normalized });
}

const exprProgram = (source) => ({
  kind: 'expr',
  source,
  program: normalizeParse(parseResult(source), source)
});
const textCompiled = (text) => ({ kind: 'text', text });
const diagnosticOutcome = (code, message, span) => ({
  outcome: 'diagnostic',
  diagnostic: { code, message, span }
});
const arrayItemSpan = (source, token) => locateToken(source, token, source.indexOf('%[') + 2);
const lastTokenSpan = (source, token) => locateToken(source, token, source.lastIndexOf(token));
const nestedUnexpectedToken = (token) =>
  `Unexpected token ${JSON.stringify(token)} in nested expression`;

// Locate the text between a literal array's `%[` and its matching `]` inside an
// already-scanned expression. Brackets nest and a backslash escapes the next
// character, which is exactly the escape rule AC-5 keeps unchanged. This
// describes the nested tokenizer's input; it never reimplements parsing.
function arrayContentSpan(expression) {
  const open = expression.indexOf('%[');
  assert.ok(open >= 0, `no literal array opener in ${JSON.stringify(expression)}`);
  let depth = 0;
  for (let index = open + 2; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      if (depth === 0) return { start: open + 2, end: index };
      depth -= 1;
    }
  }
  assert.fail(`unterminated literal array in ${JSON.stringify(expression)}`);
}

// Approved AC-5 + AC-2 compiled plan: the bracket-aware scanner keeps the whole
// call as one expression segment, and the improved nested tokenizer rejects a
// closer that has no opening delimiter inside an array item. The item text and
// its offset are real facts: they are read from the scanned expression and
// tokenized by the real TypeScript tokenizer here. The rejection itself is the
// approved item-5 behaviour, so the derived code/message are asserted exactly.
function nestedArrayItemRejection(templateSource, segmentSource) {
  const segmentSpan = locateToken(templateSource, segmentSource);
  const content = arrayContentSpan(segmentSource);
  const itemText = segmentSource.slice(content.start, content.end);
  const tokenized = api.tokenize(itemText);
  assert.ok(tokenized.error, `expected the item tokenizer to reject ${JSON.stringify(itemText)}`);
  const closer = /^Unexpected closing "(.*)"$/.exec(tokenized.error);
  assert.ok(closer, `expected an unexpected-closing item error, got ${tokenized.error}`);
  assert.equal(closer[1], ')', 'compiled array-item approval fixtures only encode the ) closer');
  const inner = locateToken(itemText, closer[1]);
  return diagnosticOutcome(diagnosticCode(tokenized.error), tokenized.error, {
    start: segmentSpan.start + content.start + inner.start,
    end: segmentSpan.start + content.start + inner.end
  });
}

// Approved AC-5 + AC-2 compiled plan: the scanner keeps the whole call, so the
// nested tokenizer runs on an array item that is itself an unclosed opener.
// The item text and opener offset are facts; the propagated diagnostic is the
// approved item-5 behaviour.
function nestedArrayItemUnclosed(templateSource, segmentSource) {
  const segmentSpan = locateToken(templateSource, segmentSource);
  const content = arrayContentSpan(segmentSource);
  const itemText = segmentSource.slice(content.start, content.end);
  const tokenized = api.tokenize(itemText);
  assert.ok(tokenized.error?.startsWith('Unclosed '),
    `expected an unclosed item opener, got ${tokenized.error}`);
  const opener = /^Unclosed "(.*)"$/.exec(tokenized.error);
  assert.ok(opener, `expected an unclosed-delimiter item error, got ${tokenized.error}`);
  const inner = locateToken(itemText, opener[1]);
  return diagnosticOutcome(diagnosticCode(tokenized.error), tokenized.error, {
    start: segmentSpan.start + content.start + inner.start,
    end: segmentSpan.start + content.start + inner.end
  });
}

// Default plan for an approved compiled occurrence: the scanner kept one
// expression segment (AC-5), so the plan is leading text (if any) plus that
// expression, whose program carries the nested diagnostic.
function nestedRejectedExprPlan(templateSource, segmentSource) {
  const start = locateToken(templateSource, segmentSource).start;
  const segments = [];
  if (start > 0) segments.push(textCompiled(templateSource.slice(0, start)));
  segments.push({
    kind: 'expr',
    source: segmentSource,
    program: nestedArrayItemRejection(templateSource, segmentSource)
  });
  return segments;
}

const combinedCategory = (code, effect) => {
  const base = APPROVALS[code];
  assert.ok(base, `unknown combined approval ${code}`);
  return {
    code,
    userApprovedItem: base.userApprovedItem,
    userApprovedItemLabel: base.userApprovedItemLabel,
    category: base.category,
    effect
  };
};

const APPROVALS = {
  'AC-1': {
    code: 'AC-1',
    userApprovedItem: 4,
    userApprovedItemLabel: 'scanner/template scanning',
    category: 'scanner-contraction-apostrophe',
    summary: 'Scanner subcase: an intra-word ASCII apostrophe does not open a single-quoted region, so contractions inside an expression scan as valid. The same category also keeps a double quote inside a ${...} interpolation from ending the enclosing quoted template.'
  },
  'AC-2': {
    code: 'AC-2',
    userApprovedItem: 5,
    userApprovedItemLabel: 'nested parse diagnostics',
    category: 'nested-tokenizer-errors',
    summary: 'Nested-parse subcase: a tokenizer error inside an array item or template interpolation is propagated instead of being swallowed into a truncated node/text segment.'
  },
  'AC-3': {
    code: 'AC-3',
    userApprovedItem: 5,
    userApprovedItemLabel: 'nested parse diagnostics',
    category: 'template-inner-unconsumed-tokens',
    summary: 'Nested-parse subcase: an interpolation with unconsumed tokens rejects the whole parse with an UNEXPECTED_TOKEN diagnostic instead of silently dropping the tail.'
  },
  'AC-4': {
    code: 'AC-4',
    userApprovedItem: 5,
    userApprovedItemLabel: 'nested parse diagnostics',
    category: 'array-item-unconsumed-tokens',
    summary: 'Nested-parse subcase: an array item with unconsumed tokens rejects the whole parse with an UNEXPECTED_TOKEN diagnostic instead of silently dropping the tail.'
  },
  'AC-5': {
    code: 'AC-5',
    userApprovedItem: 4,
    userApprovedItemLabel: 'scanner/template scanning',
    category: 'scanner-array-bracket-context',
    summary: 'Scanner subcase: [ ] depth is tracked inside an expression so a ) inside an array item does not end the expression; quote and escape handling is unchanged.'
  }
};

function approval(code, rationale, extra = {}) {
  const base = APPROVALS[code];
  assert.ok(base, `unknown approval ${code}`);
  return { ...base, rationale, ...extra };
}

function addApprovedParse(section, source, defaultOutcome, code, rationale, options = {}) {
  const raw = parseResult(source);
  const hardened = Boolean(options.harden);
  const legacy = hardened ? options.legacyOutcome : normalizeParse(raw, source);
  if (hardened) {
    assert.ok(raw.thrown, `hardening case must throw in the source oracle: ${JSON.stringify(source)}`);
    assert.equal(legacy?.outcome, 'diagnostic', `hardened legacy must be a safe diagnostic for ${JSON.stringify(source)}`);
  } else {
    assert.ok(!raw.thrown, `approved correction case must not throw in the source oracle: ${JSON.stringify(source)}`);
    assert.notDeepEqual(legacy, defaultOutcome,
      `approved correction must differ from source: ${JSON.stringify(source)}`);
  }
  addCase('parse', section, options.label ?? source, { source }, raw, {
    legacy,
    default: defaultOutcome
  }, {
    parity: hardened ? 'source-throw-hardened' : 'approved-correction',
    approved: approval(code, rationale, hardened ? {
      hardenedFromOracleThrow: raw.thrown,
      legacyRelaxation: 'Source oracle throws; legacy mode only has to return a safe diagnostic, and the recorded MISSING_VARIABLE_NAME outcome is the current expected legacy diagnosis, not a source fact.'
    } : {})
  });
}

function addApprovedScan(section, source, defaultSegments, code, rationale) {
  const raw = { segments: json(api.scanSourceSegments(source)) };
  const legacy = { segments: withSpans(source, raw.segments) };
  const expectedDefault = { segments: withSpans(source, defaultSegments) };
  assert.notDeepEqual(legacy, expectedDefault,
    `approved scan correction must differ from source: ${JSON.stringify(source)}`);
  addCase('scan', section, source, { source }, raw, {
    legacy,
    default: expectedDefault
  }, {
    parity: 'approved-correction',
    approved: approval(code, rationale)
  });
}

function addApprovedCompiled(section, source, defaultSegments, code, rationale, options = {}) {
  const rawSegments = json(api.scanSourceSegments(source));
  const raw = { segments: rawCompiledSegments(rawSegments) };
  const legacy = { segments: planSegments(source, rawSegments) };
  const expectedDefault = { segments: withSpans(source, defaultSegments) };
  assert.notDeepEqual(legacy, expectedDefault,
    `approved compiled correction must differ from source: ${JSON.stringify(source)}`);
  addCase('compiled-template', section, source, { source }, raw, {
    legacy,
    default: expectedDefault
  }, {
    parity: 'approved-correction',
    approved: approval(code, rationale, options.approvalExtra ?? {})
  });
}

// ===========================================================================
// parse: plain text, literal boundaries, quoted strings, Unicode
// ===========================================================================
const plainSources = [
  '', 'hello world', 'Hello, world!', 'a b   c', 'multiple\nlines\tand\ttabs',
  'unicode: héllo 世界 🎉', 'emoji 👨‍👩‍👧‍👦', 'spaces     ', '\n\t', ';', ')', '}', ']', '{', '[',
  'a;b', 'a)b', 'a}b', 'a]b', 'a[b]c', 'a{b}c', 'x.y.z', '5.5', '1.2.3', '.5',
  'abc123', '_x', '#x', '*x', '**x', '##x', '%', '*', '#', '?', ':', '+', '-', '/',
  'a?b:c', 'a:b', 'a+b', 'a-b', 'a/b', 'a*b', 'a%b', 'a=b', 'a==b', 'a<>b',
  'single\'quote', 'single\' quote', '\'single\'', 'two\'s', 'don\'t stop',
  '"double"', '"a b"', '""', '" "', '"a\\"b"', '"a\\nb"', '"a\\\\b"', '"unterminated',
  '"${1}"', '"${1 2}"', '"${}"', '"${ }"', '"a ${%(x)} b"', '"a ${%(x} b"',
  'trailing space ', ' leading space', '\u00a0', '\ufeff', '\u2028', '\u2029', '\u0085',
  'a\u0085b', 'a\u00a0b', '\u3000', 'x\u3000y', 'tab\there'
];
for (const source of plainSources) addParse('plain', source);

// ===========================================================================
// parse: every start token, unmatched closers, and boundary token streams
// ===========================================================================
for (const opener of ['$(', '%(', '*(', '^(', '%del(', '#(']) {
  for (const tail of ['', 'x', ' x', ')', 'x)', 'x))', ';', ' x y', '%(', '[']) {
    addParse('start-token', opener + tail);
  }
}
for (const closer of [')', ']', '}', '))', ']]', '}}', ');', ')]', ')}']) {
  addParse('closer', closer);
  addParse('closer', `text ${closer} tail`);
  addParse('closer', `$(say x)${closer}`);
}
for (const source of ['$(say x', '%(x', '*(x', '^(x', '%del(x', '#(x', '%[x', '"x', '{x', '[x']) {
  addParse('unclosed', source);
}

// ===========================================================================
// parse: functions, nested calls, dotted names, argument boundaries
// ===========================================================================
const functionSources = [
  '$(user)', '$(say hello world)', '$(say "hello world")', '$(say "")', '$(say )',
  '$(say ,)', '$(random 6)', '$(say score (5-3))', '$(say nested ((deep)) end)',
  '$(say hello \\:\\\))', '$(say smiley \\; done)', '$(say what\\?)',
  '$(say escaped \\( and \\) here)', '$(say backslash \\\\)', '$(say "quoted :) here")',
  '$(say https://example.com/path)', '$(say https://example.com/a?b=c&d=e)',
  '$(say.ping hi)', '$(say.)', '$(say hi)tail', '$(say $(user))',
  '$(say %(x) %(*deaths) #i)', '$(noop %(a 1) %(a 2))', '$(say don\'t panic)',
  '$(say can\'t)', '$(say y\'all)', '$(say rock\'n\'roll)',
  '$(https://example.com/x)', '$()', '$( )', '$((say hi))', '$(say (a) (b))',
  '$(say a (b c) d)', '$(say ((nested)))', '$(say 5.5)', '$(say -5)',
  '$(say @user)', '$(say &t)', '$(say {x})', '$(say [x])', '$(say ;)',
  '$(say ?)', '$(say :)', '$(say ==)', '$(say ~=)',
  '$(say unbalanced (oops)', '$(say hi))', '$(user', '$(user))'
];
for (const source of functionSources) addParse('function', source);

// ===========================================================================
// parse: variables, all storages and accessors, read/set/exists/delete
// ===========================================================================
const STORAGES = [
  ['memory', ''], ['cache', '#'], ['cacheUser', '##'], ['db', '*'], ['dbUser', '**']
];
const READ_ACCESSORS = ['', '[]', '[0]', '[-1]', '[random]', '[].length', '.length'];
for (const [storage, prefix] of STORAGES) {
  for (const accessor of READ_ACCESSORS) {
    addParse('getVar', `%(${prefix}x${accessor})`);
    addParse('exists', `^(${prefix}x${accessor})`);
  }
  for (const accessor of ['', '[]', '[0]', '[-1]', '[random]']) {
    addParse('deleteVar', `%del(${prefix}x${accessor})`);
  }
  addParse('setVar', `%(x 1)`);
  addParse('setVar', `%(${prefix}x 1)`);
  addParse('append', `%(${prefix}x[] 1)`);
  addParse('setIndex', `%(${prefix}x[0] 1)`);
  addParse('setIndex', `%(${prefix}x[-1] ZZZ)`);
}
const variableSources = [
  '%(x)', '%(x 1)', '%(x "")', '%(x "a b")', '%(x %[a,b])', '%(x $(user))',
  '%(x 1) tail', '%(x y) %(x)', '%(x[0]) %(x[1])', '%(x[1+1])', '%(x[*(1+1)])',
  '%(x[-1])', '%(x[- 1])', '%(x[random])', '%(x[].length)', '%(x.length)',
  '%(x[,])', '%(x[ ])', '%(x[)])', '%(x[)])', '%(x[0] 1)', '%(x[] a b)',
  '%(##points($(touser)))', '%(##points($(touser)) 1)', '%(**points($(touser)))',
  '%(##tmp(&p1))', '%(**x($(user)))', '%(x($(user)))',
  '%del(x)', '%del(#x)', '%del(##x)', '%del(*x)', '%del(**x)',
  '%del(x[])', '%del(x[0])', '%del(x[-1])', '%del(x[random])', '%del(**x($(user)))',
  '%del(x) %(x)', '%del(x[random]) %(x[random])',
  '^(x)', '^(#x)', '^(##x)', '^(*x)', '^(**x)', '^(x[])', '^(x[0])',
  '^(x[].length)', '^(**x($(user)))', '^(*seen) &t %del(##tmp(&p1))',
  '%(x', '%(x)', '%(', '%()', '%( )', '%(x])', '%(x[)', '%(x[)]',
  '%del(', '%del()', '%del(x', '^(', '^()', '^(x', '%(#x[random])', '%(**points($(touser)) 1)'
];
for (const source of variableSources) addParse('variable', source);

// ===========================================================================
// parse: binary/unary/ternary operators, precedence, associativity
// ===========================================================================
const BINARY_OPERATORS = ['==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>', '+', '-', '*', '/', '%'];
for (const operator of BINARY_OPERATORS) {
  addParse('binary', `*(1 ${operator} 2)`);
  addParse('unary-combination', `*(-1 ${operator} 2)`);
}
// Deterministic precedence/associativity matrix: every operator pair over the
// same three operands. `a op1 b op2 c` is parsed by the real source.
for (const left of BINARY_OPERATORS) {
  for (const right of BINARY_OPERATORS) {
    addParse('precedence', `*(1 ${left} 2 ${right} 3)`);
  }
}
const operatorSources = [
  '*(1 + 2)', '*(1 + 2 * 3)', '*(1 * 2 + 3)', '*(1 - 2 - 3)', '*(8 / 4 / 2)',
  '*(7 % 3)', '*(1 + 2 * 3 - 4 / 2)', '*(1 + 2 == 3)', '*(1 == 1 + 2)',
  '*((1 + 2) * 3)', '*(1 + (2 * 3))', '*(1 == (2 == 2))',
  '*(-1)', '*(+1)', '*(- 1)', '*(-(1 + 2))', '*(+%(x))', '*(-#i)',
  '*(--1)', '*(++1)', '*(!1)', '*(~1)', '*(1 ? "yes" : "no")',
  '*(1 ? 2 ? 3 : 4 : 5)', '*(^(sumiso) ? : %(sumiso 42))', '*(1 ? 2)',
  '*(1 ? : 3)', '*(1 ? 2 : )', '*(1 ? "a" : "b")', '*(1 ? : )',
  '*((1) ? 2 : 3)', '*(%(x) ? %(y) : %(z))', '*(1 2)', '*(1 + 2 3)',
  '*(%(x) %(*x))', '*(5.5 > 5 ? "yes" : "no")', '*(1.5 + 2.25)',
  '*(5abc == 5 ? "yes" : "no")', '*(5 == 5 ? "yes" : "no")',
  '*(1 + 2', '*(1 + )', '*(*1)', '*(/1)', '*(%1)', '*(1 ** 2)',
  '*(1 / 0)', '*(1 % 0)', '*(1 = = 2)', '*(1 === 2)', '*(1 !== 2)'
];
for (const source of operatorSources) addParse('operator', source);

// ===========================================================================
// parse: loops, every loop-assign operator, foreach, nesting, loop errors
// ===========================================================================
const LOOP_ASSIGN_OPERATORS = ['=', '+=', '-=', '*=', '/=', '%=', '++', '--'];
for (const operator of LOOP_ASSIGN_OPERATORS) {
  addParse('loop-update', `*(for #i = 0; #i < 3; #i ${operator} 1 { %(out[] #i) })`);
}
const loopSources = [
  '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })',
  '*(for #i=0;#i<3;#i++{%(out[] #i)})',
  '*(for #x in %(list[]) { $(say #x) })',
  '*(for #item in %(items[]) { %(out[] #item) })',
  '*(for #i = 0; #i < 3; #i += 1 { %(a #i) %(b #i) })',
  '*(for #i = 0; #i < 2; #i++ { *(for #j = 0; #j < 2; #j++ { %(x #j) }) })',
  '*(for #i = 0; #i < 2; #i++ {})',
  '*(for #i = 0; #i < 3; #i++ { #i })',
  '*(for #i = 0; #i < 5; #i++ { *(#i == 2 ? $(continue) : "") %(out[] #i) })',
  '*(for #i = 0; #i < 6; #i++ { *(#i == 3 ? $(break) : "") %(out[] #i) })',
  '*(for #i = 0; #i < 40; #i++ { %(out[] #i) })',
  '*(for #x in %(list[]) { %(out[] #x) })',
  '*(for #i in %[a,b] { %(out[] #i) })',
  '*(for)', '*(for #i)', '*(for 1 = 0; 1 < 2; 1++ {})',
  '*(for #i = 0; #i < 2; #i++ {', '*(for #i = 0; #i < 2; #i++ )',
  '*(for #i = 0; #i < 2 {})', '*(for #i 0; #i < 2; #i++ {})',
  '*(FOR #i = 0; #i < 2; #i++ {})', '*(for #i IN %(x) {})',
  '*(for #i = 0; #i < 2; #i++ { %(x #i)', '*(for #i = 0; #i < 2; #i++ }',
  '#count', '#i', '#(cmd)', '##cache', '#cache'
];
for (const source of loopSources) addParse('loop', source);

// ===========================================================================
// parse: command references
// ===========================================================================
const commandRefSources = [
  '#(discord)', '#(discord arg)', '#(echo &t)', '#(so $(raid.channel))',
  '#(cmd a b c)', '#(a (b c) d)', '#(cmd %(x))', '#()', '#( )', '#( cmd )',
  '#(cmd -x)', '#(cmd +x)', '#(cmd (unclosed)', '#(cmd', '#(cmd))',
  '#(cmd a) #(cmd b)', 'text #(cmd) tail', '#(cmd %[a,b])', '#(cmd "quoted")',
  '#(cmd a;b)', '#(cmd a:b)', '#(cmd a?b)', '#(cmd (a) (b))',
  '#(cmd $(user))', '#(cmd #(nested))', '#(cmd \\), still arg)'
];
for (const source of commandRefSources) addParse('command-ref', source);

// ===========================================================================
// parse: templates (quoted strings), interpolation and escaping
// ===========================================================================
const templateSources = [
  '"plain"', '"a b c"', '""', '" "', '"${1}"', '"${1 + 2}"', '"${%(x)}"',
  '"${}"', '"${ }"', '"${1} ${2}"', '"a ${1} b ${2} c"', '"${*(1 + 2)}"',
  '"${"${1}"}"', '"${1 2}"', '"a ${1 2} b"', '"${1 + 2 3}"', '"${%(x) 2}"',
  '"${1; 2}"', '"${(1) 2}"', '"${%(x) %(y)}"', '"a ${1"', '"a ${1} b',
  '"${1}}"', '"{{${1}}}"', '"${$(say hi)}"', '"${#(cmd)}"', '"${%[a,b]}"',
  '"${%del(x)}"', '"${^(x)}"', '"${for}"', '"\\${1}"', '"a\\nb"', '"a\\tb"',
  '"a\\"b"', '"a\\\\b"', '"${1}\\n${2}"', '"${%[a,b][0]}"', '"${*(1 2)}"',
  '"${1 ? 2 : 3}"', '"${#i}"', '"${#(cmd arg)}"', '"${%(*deaths)}"'
];
for (const source of templateSources) addParse('template', source);

// ===========================================================================
// parse: array literals, accessors, nesting, quoting, boundaries
// ===========================================================================
const arraySources = [
  '%[1,2,3]', '%[a, b]', '%[apple, banana, cherry][1]', '%[x, y, z][-1]',
  '%[a, b][].length', '%[1,2,3][random]', '%[1,2,3][*(1+1)]', '%[a,b][]',
  '%[a,b][].length', '%[a,b][random]', '%[a,b][random].length', '%[a]b',
  '%[a] b', '%[a,b,]', '%[]', '%[ ]', '%[,,]', '%[a,,b]', '%[ a , b ]',
  '%[%[a],%[b,c]]', '%[%[a]]', '%[%[%[a]]]', '%[%[a], b]', '%[a, %[b]]',
  '%["a,b", "c d"]', '%[\'a,b\']', '%["a]b"]', '%["a)b"]', '%[a\\]b, c]',
  '%[%(x), $(user)]', '%[%(x) 2]', '%[$(say hi there)]', '%[1 + 2, 3]',
  '%[1 + 2 3]', '%[1 2]', '%[a b, c]', '%[1; 2]', '%[1 2][0]', '%["a b" c]',
  '%[a,b][0]x', '%[a,b][0] tail', '%[a,b', '%[%(x]', '%[a,%(x]',
  '%[%(x)]', '%[%()]', '%[%del(x)]', '%[^(x)]', '%[#(x)]', '%[$(x)]',
  '%[%(x', '%[%del(x', '%[^(x', '%[$(x', '%[#(x',
  '%[a,[b,c]]', '%[[a],[b]]', '%[a,b][0][1]', '%[a,b][0].length'
];
for (const source of arraySources) addParse('array', source);

// ===========================================================================
// parse: URLs
// ===========================================================================
const urlSources = [
  'https://example.com', 'http://x.y/z?a=1&b=2#frag',
  'visit https://example.com/path now', 'https://example.com/path $(user)',
  '$(say https://example.com/path)', '$(say http://example.com)',
  'https://example.com/a)b', 'https://', 'http://', 'xhttps://example.com/y',
  'https://example.com/%(*x)', 'before https://example.com/$(user) after'
];
for (const source of urlSources) addParse('url', source);

// ===========================================================================
// parse: escapes
// ===========================================================================
const escapeSources = [
  'a\\)b', 'a\\(b', '\\(', '\\)', '\\[', '\\]', '\\{', '\\}', '\\;', '\\?', '\\:', '\\\\',
  'a\\$b', 'a\\%b', 'a\\*b', 'a\\#b', 'a\\^b', 'a\\qb', '\\n', '\\t', '\\/',
  'trailing\\', 'double\\\\slash', 'triple\\\\\\slash',
  '$(say hello \\:\\\\))', '$(say smiley \\; done)', '$(say what\\?)',
  '$(say escaped \\( and \\) here)', '$(say backslash \\\\)',
  '%(mood \\:\\\\))', '%(mood)', '%(x a\\;b)', '%(x a\\)b)',
  '"a\\"b"', '"a\\\\b"', '"a\\nb"', '"a\\tb"', '"a\\qb"',
  '\\$(user)', '\\%(x)', '\\*(1+1)', '\\^(x)', '\\#(cmd)',
  'a\\$(b) c', 'a\\%(*x)', 'a\\*(1+1)', 'a\\^(x)', 'a\\#(cmd)'
];
for (const source of escapeSources) addParse('escape', source);

// ===========================================================================
// parse: JavaScript/UTF-16 whitespace (js_compat semantics)
// ===========================================================================
const JS_WHITESPACE = [
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
  '\u2000', '\u2007', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'
];
for (const whitespace of JS_WHITESPACE) {
  addParse('whitespace', `$(say${whitespace}x)`);
  addParse('whitespace', `${whitespace}$(user)${whitespace}`);
}
// U+0085 NEL is intentionally not ECMAScript whitespace; js_compat must keep it.
for (const source of ['\u0085', 'a\u0085b', '$(say\u0085x)', '$(say x\u0085)', '\u0085$(user)']) {
  addParse('whitespace-nel', source);
}
for (const source of ['$(say \u00a0 x)', '$(say\u3000x)', '\ufeff$(user)\ufeff']) {
  addParse('whitespace-mixed', source);
}

// ===========================================================================
// parse: source examples from existing suites and checks
// ===========================================================================
const SOURCE_EXAMPLES = [
  // syntax_errors.test.ts
  '$(user', '%(x', '"unterminated', '%[one,two', '$(user))', '%(x])', '*(1 + 2))',
  '$(say score (5-3))', '%(items[0])', '$(say https://example.com/path)',
  'before $(user', 'before $(say %[one,two)', '"Hello ${%(x}"',
  // parens.test.ts
  '$(say nested ((deep)) end)', '$(say hello \\:\\\\))', '$(say smiley \\; done)',
  '$(say what\\?)', '$(say escaped \\( and \\) here)', '$(say backslash \\\\)',
  '%(mood \\:\\\\)) %(mood)', '$(say "quoted :) here")', '$(say unbalanced (oops)',
  '$(noop %(a 1) %(a 2)) %(a)', '$(say hello world) tail',
  // arrays.test.ts
  '%[apple, banana, cherry][1]', '%[a, b][].length', '%[x, y, z][-1]', '%[1,2,3]',
  '*(%[1,2,3][].length * 1.5)', '%(items[-1])', '%(items[-3])', '%(items[-4])',
  '%(items[*(1+1)])', '^(items[-1])', '^(items[-9])', '%del(items[-1]) %(items[])',
  '%(items[-1] ZZZ) %(items[])', '*(5.5 > 5 ? "yes" : "no")', '*(1.5 + 2.25)',
  '%(items[].length)', '*(5abc == 5 ? "yes" : "no")', '*(5 == 5 ? "yes" : "no")',
  // loop.test.ts
  '*(for #item in %(items[]) { %(out[] #item) }) %(out[])',
  '*(for #i = 0; #i < 3; #i++ { %(out[] #i) }) %(out[])',
  '*(for #i = 0; #i < 5; #i++ { *(#i == 2 ? $(continue) : "") %(out[] #i) }) %(out[])',
  '*(for #i = 0; #i < 6; #i++ { *(#i == 3 ? $(break) : "") %(out[] #i) }) %(out[])',
  '*(for #i = 0; #i < 40; #i++ { %(out[] #i) }) %(out[].length)',
  '#count', '%del(count) %(count)', '%del(items[1]) %(items[])',
  '%del(items[]) %(items[])', '%del(nonexistent) %(nonexistent)', '%del(#cachevar)',
  // ternary.test.ts
  '*(^(sumiso) ? : %(sumiso 42))',
  // command_references.test.ts
  'Join us on: #(discord)', '#(discord)', 'Once #(loop)', 'A #(b)', 'B #(a)',
  'Root #(a) #(a)', 'C0 #(c1)', '#(a) '.repeat(4), 'Root #(echo &t)',
  '%(v outer) #(echo hello) #(echo goodbye) %(v)', 'Root #(missing) #(disabled)',
  // ast_blocks.test.ts import sources
  '$(user) hugs $(touser) <3',
  '*($(random 6) == 0 ? "BANG! ${$(user)} is out" : "click... survives")',
  '%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)',
  'Thanks for the raid $(raid.channel)! #(so $(raid.channel))',
  '*(for #x in %(list[]) { $(say #x) })',
  '^(*seen) &t %del(##tmp(&p1)) *(-1 + 2)',
  'hi %(pen $(randomuser) extra) bye', 'type \\$(user) to see',
  'Hello $(user)! Deaths: %(*deaths) :) welcome   back',
  '%(*deaths *(%(*deaths) + 1))Deaths: %(*deaths)',
  '*(($(user) == cdom201) ? "Welcome back, boss" : "Hi ${$(user)}")',
  '%(**points($(touser)))', '%(list[] %[one, "two words"])', '%(list[0])',
  '%(#list[random])', '%del(*list[])', '$(say "hello there" "-5" ok)',
  // command-blocks-api.mjs
  'Hello $(user)! Deaths: %(*deaths) :) *(%(*deaths) > 3 ? "ouch ${$(user)}" : fine)',
  'Hello $(user)! Deaths: %(*deaths) :) *((%(*deaths) > 3) ? "ouch ${$(user)}" : fine)',
  'Hi $(user)! Deaths: %(*deaths). Winner: *($(random 6) == 0 ? "yes" : "no")',
  '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })'
];
for (const source of SOURCE_EXAMPLES) addParse('source-example', source);

// ===========================================================================
// scan: source segmentation (raw top-level text preserved exactly)
// ===========================================================================
const scanSources = [
  '', 'plain text only', 'a b   c', 'multiple\nlines\tand\ttabs',
  'unicode héllo 世界 🎉', 'Hi $(user)!', 'before $(user) after',
  '$(user)', '$(user)$(user)', 'a$(user)b$(user)c', '%(x) tail', '*x', '*x tail',
  'Hi $(user)! Deaths: %(*deaths). Winner: *($(random 6) == 0 ? "yes" : "no")',
  'before $(user', 'before %(x', 'before *(1', 'before ^(x', 'before %del(x', 'before #(x',
  '$(user))', '$(say hi) trailing', '$(say hi) )', 'text ) tail',
  '$()', '%()', '*()', '^()', '%del()', '#()',
  '$(say "quoted ) text")', '$(say "quoted \\" text")', '$(say \'single quoted\')',
  '$(say :) and :) more)', '$(say don\'t panic)', '$(say can\'t stop)',
  '$(say rock\'n\'roll)', '$(say dogs\' bones)',
  'it\'s $(user)\'s turn', 'a \'b\' c', 'a "b" c', 'a [b] c',
  '[plain] $(user)', '%[a,b] plain', '%[%(x] tail', '%[1 2] tail',
  '$(say %[one,two])', '$(say %[a] b)', '$(say %[a)b])', '$(say %[a[)]] b)',
  '$(say %[a\\]b)])', '$(say %["a]b)c"])', '$(say %[\'a]b)c\'])',
  '$(say a[0]) tail', '$(say x] y) tail',
  '\\$(user)', 'a\\$(b) c', '\\\\$(user)', '\\%(x)', '\\*(1+1)', '\\^(x)', '\\#(cmd)',
  '\\\\$(user) after', 'a\\\\$(b) c',
  '\ufeff$(user)\ufeff', '\u00a0$(user)\u00a0', '\u2028$(user)\u2029', '\u3000$(user)',
  'a\u0085$(user)\u0085b', 'x\u00a0y $(user) z\u3000w',
  '$(say ${1 2})', '$(say "${1 2}")', '$(say %[1 2])',
  'dense $(user) %(*x) $(user) %(*x) $(user) %(*x)'
];
for (const source of scanSources) addScan('segments', source);

// Deterministic scan combinations (text / expression / literal-looking text).
const scanParts = [
  'plain ', ' $(user) ', '%(x)', '*x', ' %(*x) ', 'tail', ' [brackets] ',
  ' \'apostrophe\' ', ' "quoted" ', ' `tick` ', ' %[a,b] ', ' \\$(escaped) '
];
for (let i = 0; i < scanParts.length; i += 1) {
  for (const j of [0, 3, 6, 9, 11]) {
    addScan('combination', scanParts[i] + scanParts[(i + j) % scanParts.length] + scanParts[(i + j + 4) % scanParts.length]);
  }
}

// ===========================================================================
// compiled-template: scan + per-expression parse, never evaluation
// ===========================================================================
const compiledSources = [
  'Hi $(user)!', 'before $(user) after', 'a$(user)b', 'plain text only',
  'Hi $(user)! Deaths: %(*deaths). Winner: *($(random 6) == 0 ? "yes" : "no")',
  '$(say hi) tail', '$(say %[one,two])', '$(say %[a] b)',
  '$(say "quoted ) text")', '$(say don\'t panic)',
  '$(user', 'before $(user', 'before $(say %[one,two)', '$(user))',
  '%(x)', '*x', '\\$(user)', 'a\\$(b) c',
  '$(say %[a)b])', '$(say %[a[)]] b)', '$(say %["a]b)c"])',
  '\ufeff$(user)\ufeff', 'x\u00a0y $(user) z\u3000w',
  '$(say "${1 2}")', '$(say %[1 2])', '$(say %[%(x])'
];
for (const source of compiledSources) addCompiled('render-plan', source);
for (const source of scanParts) addCompiled('render-plan-parts', source);

// ===========================================================================
// unescape: tokenizer literal escapes and rendered-text escapes
// ===========================================================================
const ESCAPABLE = ['(', ')', '[', ']', '{', '}', ';', '?', ':', '\\'];
for (const character of ESCAPABLE) {
  addUnescape('literal', 'literal', `\\${character}`);
  addUnescape('literal', 'literal', `a\\${character}b`);
  addUnescape('literal', 'literal', `\\${character}\\${character}`);
}
for (const source of [
  '', 'plain', '\\$', '\\%', '\\*', '\\#', '\\^', '\\n', '\\t', '\\q', '\\/', '\\,',
  'a\\qb', 'trailing\\', '\\\\', '\\\\\\\\', '\\\\)', 'a\\\\)b', '\\\\(a\\\\)',
  '\\\\\\)', 'a\\$b', '\\$\\%\\*\\#\\^', 'héllo \\; 世界'
]) {
  addUnescape('literal-mixed', 'literal', source);
}
for (const source of [
  '', 'plain', '\\$', '\\%', '\\*', '\\#', '\\^', '\\(' , '\\)', '\\\\',
  'a\\$b', 'a\\%b', 'a\\*b', 'a\\#b', 'a\\^b', '\\$\\%\\*\\#\\^',
  '\\$ not \\% but \\q', 'cost: \\$5', '100\\% done', 'a\\#b\\^c',
  'héllo \\$ 世界'
]) {
  addUnescape('rendered', 'rendered', source);
}
// unescape_rendered_text takes &str in the finalized API. The TypeScript
// caller path always passes a string, so non-string/ToString coercion is
// deliberately outside this port's corpus (no duplicate JS coercion system).

// ===========================================================================
// Approved corrections (five individually reasoned differences)
// ===========================================================================
// AC-1: intra-word apostrophes (contractions) do not open a quote in the
// scanner. Quote openers after whitespace/delimiters behave exactly as before.
// The same item-4 scanner category keeps a double quote inside a ${...}
// interpolation from ending the enclosing quoted template; that appended
// correction is a scanner concern, not an item-5 nested-parse diagnostic.
const contractionScan = [
  ['$(say don\'t panic)', [{ kind: 'expr', source: '$(say don\'t panic)' }]],
  ['$(say can\'t stop)', [{ kind: 'expr', source: '$(say can\'t stop)' }]],
  ['$(say y\'all)', [{ kind: 'expr', source: '$(say y\'all)' }]],
  ['$(say it\'s fine)', [{ kind: 'expr', source: '$(say it\'s fine)' }]],
  ['$(say user\'s)', [{ kind: 'expr', source: '$(say user\'s)' }]],
  ['$(say don\'t "stop")', [{ kind: 'expr', source: '$(say don\'t "stop")' }]],
  ['before $(say can\'t stop) after', [
    { kind: 'text', text: 'before ' },
    { kind: 'expr', source: '$(say can\'t stop)' },
    { kind: 'text', text: ' after' }
  ]],
  ['$(say y\'all) $(user)', [
    { kind: 'expr', source: '$(say y\'all)' },
    { kind: 'text', text: ' ' },
    { kind: 'expr', source: '$(user)' }
  ]]
];
for (const [source, segments] of contractionScan) {
  addApprovedScan('approval-ac1', source, segments, 'AC-1',
    'An apostrophe with an ASCII word character on both sides is prose, not a quote opener; the source scanner wrongly reports an unclosed expression. Quotes opened after a space or delimiter still open normally.');
}
// AC-5: array bracket context inside an expression. A `)` inside `[ ]` is not
// structural; quotes and backslash escapes are still honored.
const bracketScan = [
  ['$(say %[a)b])', [{ kind: 'expr', source: '$(say %[a)b])' }]],
  ['before $(say %[x)y]) after', [
    { kind: 'text', text: 'before ' },
    { kind: 'expr', source: '$(say %[x)y])' },
    { kind: 'text', text: ' after' }
  ]],
  ['$(say %[a[)]] b)', [{ kind: 'expr', source: '$(say %[a[)]] b)' }]],
  ['$(say %[%[a)b]])', [{ kind: 'expr', source: '$(say %[%[a)b]])' }]],
  ['$(say %[a\\]b)])', [{ kind: 'expr', source: '$(say %[a\\]b)])' }]]
];
for (const [source, segments] of bracketScan) {
  addApprovedScan('approval-ac5', source, segments, 'AC-5',
    'The scanner must track literal-array bracket depth: a ) while a [ ] pair is open does not finish the expression. The source scanner stops at the first ) and splits the call. Matched quotes and \\) escapes keep their existing meaning.');
}

// AC-5 escape alignment for parse: the escaped closer `\]` is already item
// content for the scanner, so the item boundary must stay the same when the
// array is parsed. The expected AST is derived from the item text alone (one
// literal token per item plus literal unescape), not from any engine output.
const escapedArrayItemSource = '%[a\\]b, c]';
assert.deepEqual(json(api.tokenize('a\\]b').tokens), ['a\\]b']);
assert.equal(api.unescapeLiteral('a\\]b'), 'a]b');
assert.deepEqual(json(api.tokenize('c').tokens), ['c']);
assert.equal(api.unescapeLiteral('c'), 'c');
assert.equal(parseResult(escapedArrayItemSource).error, 'Unexpected closing "]"');
addApprovedParse('approval-ac5-escape', escapedArrayItemSource, {
  outcome: 'program',
  ast: {
    type: 'root',
    children: [{
      type: 'arrayLiteral',
      items: [{ type: 'literal', value: 'a]b' }, { type: 'literal', value: 'c' }]
    }]
  }
}, 'AC-5',
  'The literal array has one item containing an escaped closer and one plain item. The real item tokenizer reads `a\\]b` as a single literal token (literal unescape: a]b) and `c` as a literal, so the escape changes the text, not the item boundary. The source parser instead reports the array\'s own closing ] as an unexpected closer because its delimiter validation ignores the escaped bracket. Quote/escape handling is unchanged; only array bracket context is corrected, and the raw source result is kept verbatim in `source`.');

// AC-2: an array item that starts a call whose closer is missing is rejected by
// propagating that item's tokenizer error, instead of silently parsing a
// truncated getVar/exists/deleteVar/function/commandRef node.
assert.equal(api.tokenize('%(x').error, 'Unclosed "%("');
assert.equal(api.tokenize('^(x').error, 'Unclosed "^("');
assert.equal(api.tokenize('%del(x').error, 'Unclosed "%del("');
assert.equal(api.tokenize('$(x').error, 'Unclosed "$("');
assert.equal(api.tokenize('#(x').error, 'Unclosed "#("');
const missingInnerCloser = [
  ['%[%(x]', '%(', 'Unclosed "%("'],
  ['%[a,%(x]', '%(', 'Unclosed "%("'],
  ['%[^(x]', '^(', 'Unclosed "^("'],
  ['%[%del(x]', '%del(', 'Unclosed "%del("'],
  ['%[$(x]', '$(', 'Unclosed "$("'],
  ['%[#(x]', '#(', 'Unclosed "#("']
];
for (const [source, opener, message] of missingInnerCloser) {
  addApprovedParse('approval-ac2', source,
    diagnosticOutcome('UNCLOSED_DELIMITER', message, arrayItemSpan(source, opener)),
    'AC-2',
    `The outer array scanner ends at ] while the inner ${JSON.stringify(opener)} call is still open. The source parser ignores the item tokenizer error and emits a truncated node; the default mode propagates that nested tokenizer error with the inner opener span.`);
}
// Template interpolations follow the same item-5 policy: an inner tokenizer
// error propagates in the default profile. Legacy keeps the exact TypeScript
// [Parse error: ...] text segment in the template AST.
const templateTokenizerErrors = [
  ['"${%(x}"', diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "%("', { start: 3, end: 5 }),
    'Unclosed "%(" inside a template interpolation'],
  ['"${%del(x}"', diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "%del("', { start: 3, end: 8 }),
    'Unclosed "%del(" inside a template interpolation'],
  ['"${#(}"', diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "#("', { start: 3, end: 5 }),
    'Unclosed "#(" inside a template interpolation'],
  ['"${1]}"', diagnosticOutcome('UNEXPECTED_CLOSING', 'Unexpected closing "]"', { start: 4, end: 5 }),
    'Unexpected closing "]" inside a template interpolation'],
  ['"${%[a}"', diagnosticOutcome('UNCLOSED_ARRAY', 'Unclosed array literal', { start: 3, end: 6 }),
    'Unclosed array literal inside a template interpolation'],
  ['"a ${%(x} b"', diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "%("', { start: 5, end: 7 }),
    'Unclosed "%(" inside a template interpolation with surrounding text'],
  ['"Hello ${%(x}"', diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "%("', { start: 9, end: 11 }),
    'Unclosed "%(" inside a template interpolation from an existing source example']
];
for (const [source, outcome, detail] of templateTokenizerErrors) {
  addApprovedParse('approval-ac2-template', source, outcome, 'AC-2',
    `${detail}. The source parser catches the inner tokenizer error and stores the exact [Parse error: ...] text segment; the default profile returns the nested diagnostic instead.`);
}
// Caught inner throw regression: `"${%[%(]}"`. The interpolation body is the
// array `%[%(]`, whose item `%(` has no operand, so the source template parser
// catches the inner TypeError and stores the exact text segment
// `[Parse error: %[%(]]`. That is a caught *inner* error, not a top-level
// source throw: this is `approved-correction`, the legacy plan keeps the exact
// source AST, and the default mode propagates the item tokenizer diagnostic.
const caughtInnerThrowTemplate = '"${%[%(]}"';
assert.deepEqual(parseResult(caughtInnerThrowTemplate), {
  ast: {
    type: 'root',
    children: [{ type: 'template', segments: [{ type: 'text', value: '[Parse error: %[%(]]' }] }]
  }
});
assert.equal(api.tokenize('%(').error, 'Unclosed "%("');
assert.deepEqual(arrayItemSpan(caughtInnerThrowTemplate, '%('), { start: 5, end: 7 });
addApprovedParse('approval-ac2-caught-throw', caughtInnerThrowTemplate,
  diagnosticOutcome('UNCLOSED_DELIMITER', 'Unclosed "%("', arrayItemSpan(caughtInnerThrowTemplate, '%(')),
  'AC-2',
  'Inside the interpolation the array item `%(` has no operand, so the source template parser catches the inner TypeError and stores the exact [Parse error: %[%(]] text segment instead of failing the whole parse. The default mode propagates the nested unclosed-delimiter diagnostic for that item at its opener span (UTF-16 5..7). Legacy keeps the exact source text segment; this is not top-level throw hardening, because the source oracle returns an AST.',
  { label: 'template' });
// Empty-argument openers throw in the source oracle when they appear as an
// array item. Rust must diagnose them, never panic/throw. Legacy mode cannot
// reproduce a JS throw; its recorded safe diagnosis is explicit and relaxed.
for (const [source, opener, message] of [
  ['%[%(]', '%(', 'Unclosed "%("'],
  ['%[^(]', '^(', 'Unclosed "^("'],
  ['%[%del(]', '%del(', 'Unclosed "%del("'],
  ['%[ %(]', '%(', 'Unclosed "%("']
]) {
  const span = arrayItemSpan(source, opener);
  const defaultOutcome = diagnosticOutcome('UNCLOSED_DELIMITER', message, span);
  addApprovedParse('approval-ac2-hardened', source, defaultOutcome, 'AC-2',
    'The source oracle throws TypeError because an array item contains an opener with no operand. Rust has no equivalent throw path; the default mode returns the nested tokenizer diagnostic and legacy returns a safe diagnostic instead of panicking.', {
    harden: true,
    legacyOutcome: diagnosticOutcome('MISSING_VARIABLE_NAME', 'Missing variable name', span)
  });
}

// AC-3: a template interpolation whose inner expression leaves tokens behind
// rejects the whole parse with UNEXPECTED_TOKEN. Legacy silently keeps the
// first node in the template AST.
const templateExtraTokens = [
  ['"${1 2}"', '2'],
  ['"a ${1 2} b"', '2'],
  ['"${1 + 2 3}"', '3'],
  ['"${%(x) 2}"', '2'],
  ['"${1; 2}"', ';'],
  ['"${(1) 2}"', '2'],
  ['"${%(x) %(y)}"', '%('],
  ['"${1 %(x)}"', '%(']
];
for (const [source, token] of templateExtraTokens) {
  addApprovedParse('approval-ac3', source,
    diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken(token), lastTokenSpan(source, token)),
    'AC-3',
    `A template interpolation is a single expression. The source parser stops after the first expression and drops ${JSON.stringify(token)}; the default strict core rejects the whole parse with UNEXPECTED_TOKEN and the first unconsumed token span.`);
}
// AC-3 with a nested compute body: `"${*(1 2)}"`. The source template parser
// keeps the literal 1 and drops the trailing 2; the approved strict default
// rejects that unconsumed token. The span is the real UTF-16 position of the
// token inside the interpolation (7..8), asserted independently of any engine.
const nestedComputeTemplate = '"${*(1 2)}"';
assert.deepEqual(lastTokenSpan(nestedComputeTemplate, '2'), { start: 7, end: 8 });
addApprovedParse('approval-ac3', nestedComputeTemplate,
  diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken('2'), lastTokenSpan(nestedComputeTemplate, '2')),
  'AC-3',
  'The interpolation body is a nested compute *(1 2). The source template parser keeps the first literal (1) and drops the remaining token (2), so the source AST is a one-segment template; the default strict core rejects the whole parse with UNEXPECTED_TOKEN and the first unconsumed token span (UTF-16 7..8). This is the approved item-5 rejection, not source parity.');

// AC-4: an array item whose expression leaves tokens behind rejects the whole
// literal with the first unconsumed token.
const arrayExtraTokens = [
  ['%[1 2]', '2'],
  ['%[a b, c]', 'b'],
  ['%[1 + 2 3]', '3'],
  ['%[%(x) 2]', '2'],
  ['%[1; 2]', ';'],
  ['%[1 2][0]', '2'],
  ['%["a b" c]', 'c'],
  ['%[a $(say hi)]', '$('],
  ['%[1 %(x)]', '%(']
];
for (const [source, token] of arrayExtraTokens) {
  addApprovedParse('approval-ac4', source,
    diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken(token), arrayItemSpan(source, token)),
    'AC-4',
    `Array items must consume all of their tokens. The source parser keeps the parsed prefix and drops ${JSON.stringify(token)}; the default mode rejects the whole literal with UNEXPECTED_TOKEN and the first unconsumed token span.`);
}
// AC-4 with a nested-bracket item. The item text is `[b,c]` / `[a]`: the
// legacy item parse keeps `[` as a literal and silently ignores the rest, and
// the approved stricter consumption now rejects the first unconsumed item
// token (the text between the item's leading `[` and its closing `]`).
// Independent token proof: the identical item text with the required `%[`
// prefix is a nested array in the real source, so those tokens are syntax, not
// ignorable text. The leftover spans are the exact token ranges.
assert.deepEqual(json(api.parse('%[a, %[b,c]]').ast), {
  type: 'root',
  children: [{
    type: 'arrayLiteral',
    items: [
      { type: 'literal', value: 'a' },
      { type: 'arrayLiteral', items: [{ type: 'literal', value: 'b' }, { type: 'literal', value: 'c' }] }
    ]
  }]
});
assert.deepEqual(json(api.parse('%[%[a],%[b]]').ast), {
  type: 'root',
  children: [{
    type: 'arrayLiteral',
    items: [
      { type: 'arrayLiteral', items: [{ type: 'literal', value: 'a' }] },
      { type: 'arrayLiteral', items: [{ type: 'literal', value: 'b' }] }
    ]
  }]
});
const nestedBracketItems = [
  ['%[a,[b,c]]', '[b,c]', 'b,c'],
  ['%[[a],[b]]', '[a]', 'a']
];
for (const [source, group, leftover] of nestedBracketItems) {
  const span = arrayItemSpan(source, leftover);
  assert.deepEqual(span, leftover === 'b,c' ? { start: 5, end: 8 } : { start: 3, end: 4 },
    `nested-bracket leftover span drifted for ${JSON.stringify(source)}`);
  addApprovedParse('approval-ac4-nested-brackets', source,
    diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken(leftover), span),
    'AC-4',
    `One array item is the bracket group ${JSON.stringify(group)}. The source parser keeps the literal "[" and drops the remaining item text ${JSON.stringify(leftover)}; the approved stricter item consumption rejects the whole literal with UNEXPECTED_TOKEN at the first unconsumed token span (UTF-16 ${span.start}..${span.end}). The same item text with the required %[ prefix parses to a nested array literal in the real source (asserted above), so the rejected tail is real syntax rather than ignorable text.`);
}

// Approved corrections as they appear through the compiled-template operation.
addApprovedCompiled('approval-ac1-compiled', '$(say don\'t panic)',
  [exprProgram('$(say don\'t panic)')], 'AC-1',
  'Scanning the contraction yields one expression segment; per-expression parse is unchanged, so the render plan has one parsed expression instead of an unclosed segment.');
// AC-5 + AC-2 compiled occurrences. The bracket-aware scanner keeps the whole
// call (AC-5); the improved nested tokenizer then rejects the stray closer in
// the array item (AC-2), so the plan keeps one expression segment whose program
// is a diagnostic. The default is deliberately NOT source parity: the source
// scanner splits the call and the source parser silently ignores the closer.
const bracketCompiled = [
  ['approval-ac5-compiled', '$(say %[a)b])', { start: 9, end: 10 },
    'The stray ) sits directly in the array item, so the source scanner ends the call there and the source parser drops it.'],
  ['approval-ac5-compiled-nested', '$(say %[a[)]] b)', { start: 10, end: 11 },
    'The stray ) sits one bracket level deep; the source scanner ends the call there and splits the remaining ]] b) into text.'],
  ['approval-ac5-compiled-offset', 'prefix $(say %[a[)]] b)', { start: 17, end: 18 },
    'The same nested case follows a text segment, so the absolute plan diagnostic starts at the expression offset.']
];
for (const [section, source, expectedSpan, detail] of bracketCompiled) {
  const segmentSource = source.slice(source.indexOf('$('));
  const plan = nestedRejectedExprPlan(source, segmentSource);
  const program = plan.at(-1).program;
  assert.equal(program.outcome, 'diagnostic');
  assert.equal(program.diagnostic.message, 'Unexpected closing ")"');
  assert.deepEqual(program.diagnostic.span, expectedSpan,
    `compiled nested-closer span drifted for ${JSON.stringify(source)}`);
  addApprovedCompiled(section, source,
    plan, 'AC-5',
    `Bracket depth keeps the whole call as one expression segment (AC-5). The nested tokenizer then rejects the stray ) inside the array item instead of ignoring it (AC-2), so the expression program is an UNEXPECTED_CLOSING diagnostic at that closer. ${detail}`,
    {
      approvalExtra: {
        combinedCategories: [combinedCategory('AC-2',
          'The same occurrence also exercises the approved nested-tokenizer policy: the array item error is propagated instead of being swallowed into a truncated AST.')]
      }
    });
}
const unclosedItemCompiled = '$(say %[%(x])';
const unclosedItemProgram = nestedArrayItemUnclosed(unclosedItemCompiled, unclosedItemCompiled);
assert.equal(unclosedItemProgram.diagnostic.message, 'Unclosed "%("',
  'the array-item diagnostic must keep the exact source message (no space after %)');
assert.deepEqual(unclosedItemProgram.diagnostic.span, { start: 8, end: 10 },
  'the array-item opener span drifted');
addApprovedCompiled('approval-ac5-compiled-ac2', unclosedItemCompiled,
  [{
    kind: 'expr',
    source: unclosedItemCompiled,
    program: unclosedItemProgram
  }], 'AC-5',
  'The source scanner treats this call as unclosed. The bracket-aware scanner keeps the whole call as one expression segment (AC-5), and the array item %(x is still an unclosed opener, so the improved nested tokenizer rejects the expression program with UNCLOSED_DELIMITER, Unclosed "%(", at the opener inside the item (UTF-16 8..10). The default plan is a parsed expression carrying that diagnostic, not an unclosed source segment and not source parity.',
  {
    approvalExtra: {
      combinedCategories: [combinedCategory('AC-2',
        'The same occurrence also exercises the approved nested-tokenizer policy: the missing closer of the array item is diagnosed instead of the truncated legacy plan.')]
    }
  });
addApprovedCompiled('approval-ac3-compiled', '$(say "${1 2}")', [{
  kind: 'expr',
  source: '$(say "${1 2}")',
  program: diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken('2'), lastTokenSpan('$(say "${1 2}")', '2'))
}], 'AC-3',
  'The compiled render plan parses the callable expression; the unconsumed interpolation token now makes that expression program an UNEXPECTED_TOKEN diagnostic instead of a truncated AST.');
addApprovedCompiled('approval-ac4-compiled', '$(say %[1 2])',
  [{
    kind: 'expr',
    source: '$(say %[1 2])',
    program: diagnosticOutcome('UNEXPECTED_TOKEN', nestedUnexpectedToken('2'), arrayItemSpan('$(say %[1 2])', '2'))
  }], 'AC-4',
  'The compiled render plan parses the callable expression; the array argument now rejects the leftover token instead of silently dropping it. The plan diagnostic span is absolute to the original template source.');

// AC-1 quote state inside a ${...} interpolation. The source scanner treats the
// first double quote inside the interpolation as the end of the enclosing
// quoted template, so it ends the call at the ) inside that inner quote. A
// quote inside an interpolation starts a nested quoted string in that
// interpolation; it does not terminate the outer template. The real TypeScript
// parse of each complete expression is valid (asserted below), and the default
// compiled plan uses that parse unchanged. This is the item-4 scanner category,
// not item 5: the inner expression is a valid source parse with no diagnostic.
const quotedInterpolationSources = [
  ['$(say "${")"}") tail', '$(say "${")"}")'],
  ['$(say "a ${")"} b") tail', '$(say "a ${")"} b")']
];
for (const [source, expression] of quotedInterpolationSources) {
  assert.equal(source.slice(0, -' tail'.length), expression,
    `quote-interpolation source must end in one literal tail: ${JSON.stringify(source)}`);
  const parsed = parseResult(expression);
  assert.ok(!parsed.thrown,
    `quote-interpolation expression must not throw: ${JSON.stringify(expression)}`);
  assert.equal(parsed.error, undefined,
    `quote-interpolation expression must parse: ${JSON.stringify(expression)}`);
  assert.ok(parsed.ast, `quote-interpolation expression must produce an AST: ${JSON.stringify(expression)}`);
  const early = json(api.scanSourceSegments(source));
  assert.equal(early[0]?.kind, 'expr', `source scanner must start with an expression: ${JSON.stringify(source)}`);
  assert.notEqual(early[0].source, expression,
    `source scanner must split early for ${JSON.stringify(source)}`);
  assert.ok(expression.startsWith(early[0].source),
    `source scanner prefix must stay inside the complete expression: ${JSON.stringify(source)}`);
  addApprovedScan('approval-ac1-quote-interpolation', source,
    [{ kind: 'expr', source: expression }, { kind: 'text', text: ' tail' }],
    'AC-1',
    'A double quote inside a ${...} interpolation is inner interpolation text, not a terminator for the enclosing quoted template. The source scanner loses the outer quote state at that inner quote and finishes the call at the ) inside it, so the rest of the call becomes literal text. The corrected quote state keeps the whole call as one expression followed by the literal tail; the expression itself is a valid source parse (asserted above), and the compiled plan uses that unchanged AST. This is the approved item-4 scanner category, distinct from the item-5 nested-parse diagnostics.');
  addApprovedCompiled('approval-ac1-quote-interpolation', source,
    [exprProgram(expression), textCompiled(' tail')],
    'AC-1',
    'The same approved quote-state correction through compile_template: one expression segment covers the whole call with the source-valid AST, followed by the literal tail. Legacy keeps the source scanner split and the UNCLOSED_QUOTE program for the truncated expression segment exactly as the source produces it. This is item 4, not item 5.');
}

// The same source can appear in a general corpus list and in an approved list.
// Keep one case per operation+input, preferring the approved case because it
// carries explicit legacy and default expectations for both Rust modes.
const deduped = [];
const caseByKey = new Map();
for (const item of cases) {
  const key = `${item.operation}|${JSON.stringify(item.input)}`;
  const existing = caseByKey.get(key);
  if (!existing) {
    caseByKey.set(key, item);
    deduped.push(item);
    continue;
  }
  if (item.approved && !existing.approved) {
    deduped[deduped.indexOf(existing)] = item;
    caseByKey.set(key, item);
  }
}
cases.length = 0;
cases.push(...deduped);
for (const item of cases) {
  const key = `${item.operation}|${JSON.stringify(item.input)}`;
  assert.equal(caseByKey.get(key), item, `duplicate case not resolved for ${key}`);
}

// ===========================================================================
// Coverage + assertions
// ===========================================================================
function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  switch (node.type) {
    case 'root': node.children.forEach((child) => walkAst(child, visit)); break;
    case 'setVar':
      if (node.accessor?.index) walkAst(node.accessor.index, visit);
      walkAst(node.value, visit);
      if (node.userSelector) walkAst(node.userSelector, visit);
      break;
    case 'getVar':
    case 'exists':
    case 'deleteVar':
      if (node.accessor?.index) walkAst(node.accessor.index, visit);
      if (node.userSelector) walkAst(node.userSelector, visit);
      break;
    case 'function':
    case 'commandRef': node.args.forEach((arg) => walkAst(arg, visit)); break;
    case 'binary': walkAst(node.left, visit); walkAst(node.right, visit); break;
    case 'unary': walkAst(node.argument, visit); break;
    case 'ternary':
      walkAst(node.test, visit); walkAst(node.consequent, visit); walkAst(node.alternate, visit);
      break;
    case 'template':
      node.segments.forEach((segment) => { if (segment.type === 'expr') walkAst(segment.node, visit); });
      break;
    case 'arrayLiteral':
      node.items.forEach((item) => walkAst(item, visit));
      if (node.accessor?.index) walkAst(node.accessor.index, visit);
      break;
    case 'loopAssign': if (node.value) walkAst(node.value, visit); break;
    case 'forLoop':
      ['init', 'condition', 'update', 'iterable'].forEach((key) => { if (node[key]) walkAst(node[key], visit); });
      node.body.forEach((child) => walkAst(child, visit));
      break;
    default: break;
  }
}

const coverage = {
  nodeTypes: new Set(),
  storages: new Set(),
  accessors: new Set(),
  binaryOperators: new Set(),
  unaryOperators: new Set(),
  loopAssignOperators: new Set(),
  loopModes: new Set()
};
let parseErrorCases = 0;
let loopErrorLiterals = 0;
let templateErrorTexts = 0;
let thrownCases = 0;
let unclosedSegments = 0;
for (const item of cases) {
  if (item.source?.thrown) thrownCases += 1;
  if (item.source?.error) parseErrorCases += 1;
  if (item.source?.ast) {
    walkAst(item.source.ast, (node) => {
      coverage.nodeTypes.add(node.type);
      if (node.storage) coverage.storages.add(node.storage);
      if (node.accessor?.type) coverage.accessors.add(node.accessor.type);
      if (node.type === 'binary') coverage.binaryOperators.add(node.operator);
      if (node.type === 'unary') coverage.unaryOperators.add(node.operator);
      if (node.type === 'loopAssign') coverage.loopAssignOperators.add(node.operator);
      if (node.type === 'forLoop') coverage.loopModes.add(node.mode);
      if (node.type === 'literal' && String(node.value).startsWith('[Loop error:')) {
        loopErrorLiterals += 1;
      }
      if (node.type === 'template') {
        for (const segment of node.segments) {
          if (segment.type === 'text' && segment.value.startsWith('[Parse error:')) {
            templateErrorTexts += 1;
          }
        }
      }
    });
  }
  if (item.operation === 'scan' || item.operation === 'compiled-template') {
    const segments = item.source.segments ?? [];
    for (const segment of segments) if (segment.kind === 'unclosed') unclosedSegments += 1;
  }
}

const EXPECTED_NODE_TYPES = [
  'root', 'setVar', 'getVar', 'deleteVar', 'function', 'literal', 'exists', 'binary',
  'unary', 'ternary', 'template', 'arrayLiteral', 'commandRef', 'loopVar', 'loopAssign',
  'forLoop'
];
for (const type of EXPECTED_NODE_TYPES) {
  assert.ok(coverage.nodeTypes.has(type), `corpus does not cover node type ${type}`);
}
for (const storage of ['memory', 'cache', 'cacheUser', 'db', 'dbUser']) {
  assert.ok(coverage.storages.has(storage), `corpus does not cover storage ${storage}`);
}
for (const accessor of ['array', 'index', 'random', 'length', 'append', 'setIndex', 'remove', 'clear']) {
  assert.ok(coverage.accessors.has(accessor), `corpus does not cover accessor ${accessor}`);
}
for (const operator of ['==', '!=', '>=', '<=', '>', '<', '=', '~=', '<>', '+', '-', '*', '/', '%']) {
  assert.ok(coverage.binaryOperators.has(operator), `corpus does not cover binary operator ${operator}`);
}
for (const operator of ['+', '-']) {
  assert.ok(coverage.unaryOperators.has(operator), `corpus does not cover unary operator ${operator}`);
}
for (const operator of ['=', '+=', '-=', '*=', '/=', '%=', '++', '--']) {
  assert.ok(coverage.loopAssignOperators.has(operator), `corpus does not cover loop assign ${operator}`);
}
for (const mode of ['range', 'foreach']) {
  assert.ok(coverage.loopModes.has(mode), `corpus does not cover loop mode ${mode}`);
}
assert.ok(parseErrorCases > 20, 'expected many exact parse errors');
assert.ok(loopErrorLiterals > 0, 'expected loop error literal nodes');
assert.ok(templateErrorTexts > 0, 'expected template parse-error text segments');
assert.ok(thrownCases > 0, 'expected recorded source-oracle throws');
assert.ok(unclosedSegments > 0, 'expected unclosed scan segments');
for (const item of cases.filter((entry) => entry.operation === 'unescape')) {
  assert.equal(typeof item.input.value, 'string',
    `unescape inputs are string-only in the finalized API: ${item.name}`);
}

// Every fixture span must be a valid UTF-16 half-open range of its input. This
// catches hand-authored approved spans drifting outside the source.
function assertSpan(span, name, limit) {
  assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end), `non-integer span: ${name}`);
  assert.ok(span.start >= 0 && span.start <= span.end && span.end <= limit,
    `span ${JSON.stringify(span)} out of range 0..${limit}: ${name}`);
}
for (const item of cases) {
  const limit = item.input.source?.length ?? 0;
  const checkOutcome = (outcome) => {
    if (outcome?.outcome === 'diagnostic') assertSpan(outcome.diagnostic.span, item.name, limit);
  };
  checkOutcome(item.expected.legacy);
  checkOutcome(item.expected.default);
  for (const plan of [item.expected.legacy, item.expected.default]) {
    for (const segment of plan.segments ?? []) {
      if (segment.span) assertSpan(segment.span, item.name, limit);
      if (segment.diagnostic) assertSpan(segment.diagnostic.span, item.name, limit);
      checkOutcome(segment.program);
    }
  }
}

// Never silently rewrite the legacy source result: for every source-parity
// case the normalized legacy expectation must still carry the oracle's AST or
// exact error message, and both Rust modes must agree.
let maxCaseAstDepth = 0;
for (const item of cases) {
  if (item.source?.ast) maxCaseAstDepth = Math.max(maxCaseAstDepth, maxAstDepth(item.source.ast));
  if (item.parity !== 'source-parity') continue;
  assert.deepEqual(item.expected.legacy, item.expected.default,
    `parity modes disagree for ${item.name}`);
  if (item.operation === 'parse') {
    assert.ok(!item.source.thrown, `parity case throws: ${item.name}`);
    if (item.source.error !== undefined) {
      assert.equal(item.expected.legacy.outcome, 'diagnostic', item.name);
      assert.equal(item.expected.legacy.diagnostic.message, item.source.error, item.name);
    } else {
      assert.equal(item.expected.legacy.outcome, 'program', item.name);
      assert.deepEqual(item.expected.legacy.ast, item.source.ast, item.name);
    }
    const end = item.input.source.length;
    const span = item.expected.legacy.diagnostic?.span;
    if (span) {
      assert.ok(span.start >= 0 && span.start <= span.end && span.end <= end,
        `diagnostic span out of range for ${item.name}`);
    }
  } else if (item.operation === 'scan') {
    assert.equal(item.expected.legacy.segments.length, item.source.segments.length, item.name);
    for (const [index, segment] of item.expected.legacy.segments.entries()) {
      const raw = item.source.segments[index];
      assert.equal(segment.kind, raw.kind, item.name);
      assert.equal(segment.text ?? segment.source, raw.text ?? raw.source, item.name);
      assert.ok(segment.span.start >= 0 && segment.span.end <= item.input.source.length, item.name);
    }
  } else if (item.operation === 'compiled-template') {
    assert.equal(item.expected.legacy.segments.length, item.source.segments.length, item.name);
  }
}
assert.ok(maxCaseAstDepth <= 16,
  `source-parity cases must stay modestly nested (${maxCaseAstDepth} exceeds 16)`);

// ===========================================================================
// Benchmarks (syntax only; no evaluation and no effects)
// ===========================================================================
function maxAstDepth(node) {
  if (!node || typeof node !== 'object') return 0;
  let childMax = 0;
  const visit = (child) => { childMax = Math.max(childMax, maxAstDepth(child)); };
  switch (node.type) {
    case 'root': node.children.forEach(visit); break;
    case 'arrayLiteral': node.items.forEach(visit); break;
    case 'function':
    case 'commandRef': node.args.forEach(visit); break;
    case 'binary': visit(node.left); visit(node.right); break;
    case 'unary': visit(node.argument); break;
    case 'ternary': visit(node.test); visit(node.consequent); visit(node.alternate); break;
    case 'template': node.segments.forEach((s) => { if (s.type === 'expr') visit(s.node); }); break;
    case 'setVar': visit(node.value); break;
    case 'loopAssign': if (node.value) visit(node.value); break;
    case 'forLoop':
      ['init', 'condition', 'update', 'iterable'].forEach((k) => { if (node[k]) visit(node[k]); });
      node.body.forEach(visit); break;
    default: break;
  }
  return 1 + childMax;
}
function nestedArraySource(depth) { return `${'%['.repeat(depth)}x${']'.repeat(depth)}`; }
function nestedComputeSource(depth) { return `${'*('.repeat(depth)}1${')'.repeat(depth)}`; }
function benchmarkExpectation(source) {
  const segments = json(api.scanSourceSegments(source));
  const parsed = parseResult(source);
  assert.ok(!parsed.thrown, `benchmark source must not throw: ${JSON.stringify(source.slice(0, 40))}`);
  return {
    sourceUtf16Length: source.length,
    segmentKinds: segments.map((segment) => segment.kind),
    expressionSegmentCount: segments.filter((segment) => segment.kind === 'expr').length,
    parseError: parsed.error ?? null,
    topLevelChildCount: parsed.ast?.children.length ?? 0,
    topLevelNodeTypes: parsed.ast?.children.map((child) => child.type) ?? [],
    maxAstDepth: parsed.ast ? maxAstDepth(parsed.ast) : 0
  };
}

const plain8000 = 'plain text '.repeat(800).slice(0, 8000);
assert.equal(plain8000.length, 8000);
const dense100 = '$(user) %(*x) '.repeat(50);
const dense500 = '$(user) %(*x) '.repeat(250);
assert.equal(dense100.length, 700);
assert.equal(dense500.length, 3500);

const benchmarks = [];
function addBenchmark(name, description, source, extra = {}) {
  const expected = benchmarkExpectation(source);
  benchmarks.push({
    name,
    description,
    source,
    ...extra,
    effects: false,
    expected
  });
}
addBenchmark('short-hi', 'Shortest representative mixed template: one text run and one call.', 'Hi $(user)!');
addBenchmark('mixed',
  'Representative mixed template from the command-blocks API check: text, call, database variable, decimal ternary.',
  'Hi $(user)! Deaths: %(*deaths). Winner: *($(random 6) == 0 ? "yes" : "no")');
addBenchmark('loop',
  'Representative range loop with a nested call and loop variable.',
  '*(for #i = 0; #i < 3; #i++ { $(say ping #i) })');
addBenchmark('plain8000', 'Eight thousand characters of plain text: one scan text segment.', plain8000,
  { generated: { kind: 'repeat+slice', unit: 'plain text ', repeats: 800, slice: 8000 } });
addBenchmark('dense100', 'Dense alternating expressions: 50 repeats x 2 expressions = 100 expressions.', dense100,
  { generated: { kind: 'repeat', unit: '$(user) %(*x) ', repeats: 50, expressions: 100 } });
addBenchmark('dense500', 'Dense alternating expressions: 250 repeats x 2 expressions = 500 expressions.', dense500,
  { generated: { kind: 'repeat', unit: '$(user) %(*x) ', repeats: 250, expressions: 500 } });
for (const depth of [8, 16, 32, 64, 128]) {
  addBenchmark(`nested-arrays-${depth}`, `Nested literal arrays at depth ${depth}.`,
    nestedArraySource(depth), { generated: { kind: 'nested-array', depth } });
}
for (const depth of [32, 64, 128]) {
  addBenchmark(`nested-compute-${depth}`, `Nested compute wrappers at depth ${depth}; the AST collapses to the inner literal.`,
    nestedComputeSource(depth), { generated: { kind: 'nested-compute', depth } });
}
for (const benchmark of benchmarks) {
  assert.equal(benchmark.expected.parseError, null, `benchmark must parse: ${benchmark.name}`);
  assert.equal(benchmark.expected.topLevelChildCount > 0, true, `benchmark AST must not be empty: ${benchmark.name}`);
  assert.ok(benchmark.source.length <= 10_000, `benchmark exceeds the default source limit: ${benchmark.name}`);
  assert.ok(!/"(ast|program|segments)"\s*:/.test(JSON.stringify(benchmark)),
    `deep benchmarks must stay source-only definitions, no AST: ${benchmark.name}`);
}
const nestedArray128 = benchmarks.find((benchmark) => benchmark.name === 'nested-arrays-128');
assert.equal(nestedArray128.expected.maxAstDepth, 130, '128 nested arrays plus root and literal');

// ===========================================================================
// Manifest + deterministic output
// ===========================================================================
const operationCounts = {};
for (const item of cases) operationCounts[item.operation] = (operationCounts[item.operation] ?? 0) + 1;
const parityCounts = {};
for (const item of cases) parityCounts[item.parity] = (parityCounts[item.parity] ?? 0) + 1;
const approvedCounts = {};
const approvedReasons = {};
for (const item of cases) {
  if (!item.approved) continue;
  approvedCounts[item.approved.code] = (approvedCounts[item.approved.code] ?? 0) + 1;
  approvedReasons[item.approved.code] = {
    userApprovedItem: item.approved.userApprovedItem,
    userApprovedItemLabel: item.approved.userApprovedItemLabel,
    category: item.approved.category,
    summary: item.approved.summary
  };
}
for (const code of Object.keys(APPROVALS)) {
  assert.ok(approvedCounts[code] > 0, `approved correction ${code} has no fixtures`);
}
// Occurrences that exercise two approved improvements at once (AC-5 scanner
// bracket context plus AC-2 nested-tokenizer propagation). They stay inside the
// five fixture categories: `approved.code` is the primary category and
// `approved.combinedCategories` records the second policy.
const combinedCases = cases.filter((item) => item.approved?.combinedCategories?.length);
assert.ok(combinedCases.length > 0, 'expected at least one combined approved occurrence');
for (const item of combinedCases) {
  assert.equal(item.approved.code, 'AC-5', `combined occurrence must stay in the AC-5 category: ${item.name}`);
  assert.deepEqual(item.approved.combinedCategories.map((entry) => entry.code), ['AC-2'],
    `combined occurrence must name AC-2 explicitly: ${item.name}`);
  assert.ok(item.approved.combinedCategories[0].effect.length > 0,
    `combined occurrence needs a documented second effect: ${item.name}`);
}
assert.ok(cases.length >= 1000 && cases.length <= 4000, `case count out of bounds: ${cases.length}`);

const sortedCoverage = (set) => [...set].sort();
function jsonDepth(value) {
  if (Array.isArray(value)) {
    return 1 + value.reduce((max, entry) => Math.max(max, jsonDepth(entry)), 0);
  }
  if (value && typeof value === 'object') {
    return 1 + Object.values(value).reduce((max, entry) => Math.max(max, jsonDepth(entry)), 0);
  }
  return 0;
}
const corpusHash = sha256(JSON.stringify(cases));
const output = {
  schemaVersion: 2,
  fixtureId: 'dima-rust-ast-syntax-reference',
  description:
    'Source-backed AST syntax cases for the dima-rust parser/tokenizer/scanner port. Generated from the actual TypeScript syntax modules; do not hand-edit. Source parity is recorded separately from five fixture categories that implement two user-approved improvements: scanner/template scanning (item 4) and nested parse diagnostics (item 5). The four approved optimizations are performance-only.',
  contract: {
    api: '/tmp/ast-syntax-api-contract.md',
    fixtureSchema: '/tmp/ast-syntax-fixture-contract.md',
    modes: {
      default: 'SyntaxEngine::default() — approved improved semantics',
      legacy: 'SyntaxEngine::typescript_compatible() — TypeScript legacy policies'
    },
    operations: {
      parse: 'engine.parse(input.source) -> Result<CompiledProgram, Diagnostic>; expected is {outcome:"program",ast} or {outcome:"diagnostic",diagnostic}.',
      scan: 'engine.scan_template(input.source) -> Result<Vec<SourceSegment>, Diagnostic>; expected.segments carry UTF-16 spans.',
      'compiled-template': 'engine.compile_template(input.source); text/expr/unclosed plans match expected.segments; expression diagnostics are absolute to the original template source.',
      unescape: 'surface="rendered" calls unescape_rendered_text(&str) with string input only. surface="literal" calls the now-public tokenizer literal unescape with string input.'
    },
    limits: {
      sourceUtf16Units: 10_000,
      tokens: 20_000,
      nodes: 4_000,
      nesting: 128,
      note: 'Corpus cases are far below the limits; benchmarks include the 128 nesting boundary as source-only definitions.'
    },
    spanConvention: 'UTF-16 code-unit, half-open [start,end). Scanner/plan spans and compiled-plan diagnostics are absolute to the input template. Parse diagnostics are relative to the parse input. For source-parity errors the exact TypeScript message is the source fact; code is the contract enum mapping and span is derived metadata that the adapter may relax to bounds. The legacy expectation of an approved case keeps that same derived code/span convention: it reproduces the source result, not a new TypeScript fact. Approved default diagnostics carry exact additive code/message/span.',
    diagnosticCodes: {
      UNEXPECTED_CLOSING: 'A closer does not match the innermost open delimiter (message names the closer).',
      UNCLOSED_DELIMITER: 'An opener token has no matching closer (message names the opener).',
      UNCLOSED_ARRAY: 'A literal array %[ reaches the end of input.',
      UNCLOSED_QUOTE: 'A double-quoted string reaches the end of input.',
      UNCLOSED_EXPRESSION: 'A compiled-template expression segment has no closing parenthesis; the plan retains its source and diagnostic.',
      UNEXPECTED_TOKEN: 'A nested expression leaves tokens unconsumed; message is Unexpected token "<tok>" in nested expression.',
      MISSING_VARIABLE_NAME: 'Legacy safe diagnosis for an empty variable name (used only by source-throw hardening fixtures).',
      SOURCE_LIMIT: 'Resource limit (not present in this corpus).',
      TOKEN_LIMIT: 'Resource limit (not present in this corpus).',
      NODE_LIMIT: 'Resource limit (not present in this corpus).',
      NESTING_LIMIT: 'Resource limit (only the 128 benchmark boundary exercises it conceptually; source-only).',
      INVALID_GRAMMAR: 'Grammar preparation error (not present in this corpus).'
    },
    normalization:
      'The raw TypeScript result is always stored in `source` (ast/error/thrown) and is never rewritten. `expected` is normalized to the finalized API. For source-parity cases expected.legacy equals expected.default and represents `source` with the same AST or exact message. Rendered unescape is string-only because the Rust API is &str; JS ToString coercion is intentionally not ported.'
  },
  sourceParityNotice:
    'This corpus is NOT a claim of full semantic parity. Every `source` value is the unmodified TypeScript result. `expected.legacy` represents it for source-parity cases; `expected.default` equals it except for five fixture categories implementing user-approved items 4 (scanner/template scanning) and 5 (nested parse diagnostics), plus explicitly labelled source-throw hardening. Rationale is stored per case.',
  userApprovedItems: {
    note: 'Only items 4 and 5 change AST syntax behaviour in this fixture. Other approved items and the four optimizations are outside this syntax corpus; this file does not infer semantics for them.',
    item4: {
      label: 'scanner/template scanning',
      fixtureCategories: ['AC-1', 'AC-5'],
      summary: 'Contraction-aware apostrophe scanning, literal-array bracket depth in expression scanning, and escape-aligned array item boundaries (an escaped closer stays item text). AC-1 also keeps a double quote inside a ${...} interpolation from ending the enclosing quoted template.'
    },
    item5: {
      label: 'nested parse diagnostics',
      fixtureCategories: ['AC-2', 'AC-3', 'AC-4'],
      summary: 'Nested tokenizer errors propagate, including into compiled template expression plans; unconsumed tokens in interpolations and array items reject the parse with UNEXPECTED_TOKEN.'
    }
  },
  approvedOptimizationsNote:
    'The four approved optimizations are performance/implementation concerns, not semantics. This corpus supplies their representative benchmark inputs (short/mixed/loop/plain8000/dense100/dense500/nested-array/nested-compute) and asserts no speedup; it does not encode optimisation flags.',
  benchmarkPolicy:
    'Benchmark entries are source/workload definitions. Their expected fields describe the unmodified TypeScript source (segments, AST summary) and intentionally store no AST. Boundary-depth entries (nesting 128) are workload definitions; do not treat their expected fields as a required Rust success assertion at an exact resource-limit boundary.',
  extraction: {
    modules: Object.keys(SELECTIONS),
    typeOnlyHashed: ['types.ts'],
    excludedDeclarations: [
      'render.ts#renderAstWithSourceReference (imports the evaluator; not transpiled)'
    ],
    imports: 'All import and export-from declarations are stripped; the selected declarations run in an isolated vm context with no require().',
    verifiedIsolation: [
      'no require()',
      'no evaluator reference',
      'no renderAstWithSourceReference',
      'no import statements retained'
    ]
  },
  sources,
  counts: {
    cases: cases.length,
    ...Object.fromEntries(Object.entries(operationCounts).sort()),
    parity: Object.fromEntries(Object.entries(parityCounts).sort())
  },
  approvedCorrections: Object.keys(APPROVALS).sort().map((code) => ({
    ...APPROVALS[code],
    cases: approvedCounts[code],
    ...approvedReasons[code]
  })),
  combinedApprovals: {
    count: combinedCases.length,
    primaryCodes: [...new Set(combinedCases.map((item) => item.approved.code))].sort(),
    secondaryCodes: [...new Set(combinedCases.flatMap((item) => item.approved.combinedCategories.map((entry) => entry.code)))].sort(),
    cases: combinedCases.map((item) => item.name),
    note: 'Occurrences that exercise two approved improvements at once. The corpus still has exactly five fixture categories: `approved.code` is the primary category (AC-5 scanner array/bracket context) and `approved.combinedCategories` records the nested-diagnostic policy (AC-2) the same occurrence also exercises. Their default expectations are additive spec, never source parity.'
  },
  coverage: {
    nodeTypes: sortedCoverage(coverage.nodeTypes),
    nodeTypesUnreachableFromParser: [
      { type: 'custom', reason: 'No registry/parser handler constructs a custom node; custom nodes are an evaluator/consumer extension point.' }
    ],
    storages: sortedCoverage(coverage.storages),
    accessors: sortedCoverage(coverage.accessors),
    binaryOperators: sortedCoverage(coverage.binaryOperators),
    unaryOperators: sortedCoverage(coverage.unaryOperators),
    loopAssignOperators: sortedCoverage(coverage.loopAssignOperators),
    loopModes: sortedCoverage(coverage.loopModes),
    errorChannels: {
      parseErrorCases,
      loopErrorLiteralNodes: loopErrorLiterals,
      templateParseErrorTextSegments: templateErrorTexts,
      sourceOracleThrowsRecorded: thrownCases,
      unclosedScanSegments: unclosedSegments
    },
    maxCaseAstDepth,
    maxCorpusJsonDepth: 0
  },
  approvedErrorContract: {
    'AC-1': 'Scanner category implementing item 4: intra-word apostrophes do not open a quote. The same category treats a double quote inside a ${...} interpolation as inner interpolation text rather than a terminator for the enclosing quoted template; the category code/name is retained for schema compatibility.',
    'AC-2': 'Nested-parse category implementing item 5: nested tokenizer errors (array items and template interpolations) propagate in default mode. Legacy keeps the source result, including its exact [Parse error: ...] text segments, and that includes an inner error the source template parser caught rather than a top-level throw. Where the source throws, legacy must only return a safe diagnostic; the recorded MISSING_VARIABLE_NAME outcome is the current expected legacy diagnosis, not a source fact.',
    'AC-3': 'Nested-parse category implementing item 5: an interpolation with unconsumed tokens rejects the whole parse with UNEXPECTED_TOKEN and message Unexpected token "<tok>" in nested expression. It is NOT an error-text template AST in default mode; legacy retains the exact TypeScript truncation.',
    'AC-4': 'Nested-parse category implementing item 5: an array item with unconsumed tokens rejects the whole parse with UNEXPECTED_TOKEN and the first unconsumed token span; no truncated AST is produced. This includes a bracket-group item (unprefixed [b,c] / [a]), whose rejected tail is proved to be real syntax by the same item text with the required %[ prefix.',
    'AC-5': 'Scanner category implementing item 4: [ ] depth inside an expression is tracked for ) termination while quote/escape behaviour is preserved, and an escaped closer stays inside the item text. In compiled templates the same occurrence is combined with AC-2 (see combinedApprovals): the bracket-aware scanner keeps one expression segment and the nested tokenizer then rejects a stray closer or missing array-item closer inside it, so the expression program is a diagnostic instead of the legacy unclosed segment or silently truncated AST.'
  },
  caveats: [
    'Approved diagnostics (AC-2/AC-3/AC-4) carry additive code/message/span; only the source-parity exact message and source AST/text segments are facts from the TypeScript oracle.',
    'AC-1\'s contraction rule is limited to an ASCII word character on both sides of the apostrophe; possessives after punctuation or a nested expression are outside that rule and are not asserted. Within AC-1, a double quote inside a ${...} interpolation does not close the enclosing quoted template; that quote-state correction is scanner policy (item 4), separate from the item-5 nested-parse diagnostics.',
    'The scanner does not treat quotes in top-level plain text as shields for start tokens (e.g. "${%(x)}" splits into text/expr/text). This is legacy behaviour and is preserved; no approved fix changes it.',
    'Malformed bracket depth inside an expression (an unclosed "[" before the final ")") has unspecified default scan behaviour and is deliberately not asserted.',
    'Legacy quirks are preserved on purpose and only in legacy mode: %[a,b][] is not accepted as a length accessor, an unprefixed [b,c] inside an array item is not a nested array (legacy keeps the literal "[" and drops the tail, while the default mode rejects the leftover tokens per AC-4), and %[%()] parses a getVar named ")".',
    'AC-5 compiled occurrences are not source parity: the bracket-aware scanner keeps one expression segment where the source scanner ended the call at the first ), and the approved nested tokenizer then reports a stray closer or a missing array-item closer as that expression program. The legacy plan keeps the exact source split/unclosed segment.',
    'An escaped closer (%[a\\]b, c]) stays item text for the scanner, so the default parse reads the array item boundary the same way; the source parser reports the array\'s own final ] as an unexpected closer. The default AST is derived from the item tokenizer and literal unescape, not copied from an engine result.',
    'Lone UTF-16 surrogates are excluded because they are not valid Rust String values; valid astral characters and JavaScript whitespace code units are covered. U+0085 NEL is not ECMAScript whitespace and must stay literal (js_compat).',
    'Parse rules that are not part of the approved fixes are retained even when surprising: extra tokens after *(...) and %(x ...) keep their source behaviour, empty ternary consequents remain supported, and loop syntax errors remain literal [Loop error: ...] nodes.',
    'unescape_rendered_text is string-only in the finalized API; non-string/ToString coercion is intentionally outside this port. The literal unescape helper is public and string-only.',
    'The four approved optimizations are performance-only. No timing or speedup is recorded, and benchmarks never evaluate an expression or touch IO.',
    'Deep benchmarks (nested arrays 8..128, compute 32..128) are source-only definitions: the corpus stores no deep AST, keeping the fixture well under serde_json default recursion limits. Source-parity cases stay at AST depth <= 16.',
    'Spans are UTF-16 half-open offsets. Legacy TypeScript exposed no spans: source-parity spans, and the legacy code/span of an approved case, are derived from the real token/segment stream for verification, not from source facts. Approved default code/message/span are additive spec and are asserted exactly.'
  ],
  corpusHash,
  cases,
  benchmarks
};
output.coverage.maxCorpusJsonDepth = jsonDepth(output);
assert.ok(output.coverage.maxCorpusJsonDepth < 120,
  `fixture JSON nesting ${output.coverage.maxCorpusJsonDepth} approaches serde_json's default recursion limit`);

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(outputUrl, 'utf8');
  assert.equal(existing, serialized, 'Fixture/source drift: regenerate ast_syntax_cases.json');
  console.log(`Checked ${cases.length} AST syntax cases (${corpusHash.slice(0, 12)}) against ${SOURCE_FILES.length} hashed TS sources and ${benchmarks.length} benchmarks.`);
} else {
  await writeFile(outputUrl, serialized);
  console.log(`Generated ${cases.length} AST syntax cases (${corpusHash.slice(0, 12)}) from ${SOURCE_FILES.length} hashed TS sources: ${JSON.stringify(operationCounts)}; parity ${JSON.stringify(parityCounts)}; approved ${JSON.stringify(approvedCounts)}; ${benchmarks.length} benchmarks.`);
}
