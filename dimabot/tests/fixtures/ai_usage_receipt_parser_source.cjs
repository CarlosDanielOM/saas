'use strict';
// Extract actual declarations; no handwritten replacement for application logic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const specs = [
  ['src/utils/ai_usage_classification.ts', [['ADJUSTMENT_TYPES', true], ['classifyAdjustment', true]]],
  ['src/utils/ai_usage_ledger.ts', [['VALID_CATEGORIES', false], ['safeCategory', false], ['nullableString', false], ['finiteNumber', false], ['parseQueuedAiUsageReceipt', true]]],
];
function build() {
  const provenance = [];
  const modules = [];
  for (const [file, names] of specs) {
    const bytes = fs.readFileSync(path.join(root, file));
    const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text);
    assert.deepEqual(imports, file.includes('classification') ? [] : ['../schemas/ai_usage_dashboard.schema.js','./ai_usage_lock.js','./ai_usage_classification.js','redis','../schemas/ai_usage_daily.schema.js','../schemas/ai_usage_ledger_state.schema.js','../schemas/ai_usage_receipt.schema.js','./ai_usage_event.js','./ai_usage_receipts.js']);
    const declarations = names.map(([name, exported]) => {
      const found = source.statements.filter(n => n.name?.text === name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === name));
      assert.equal(found.length, 1, name);
      const node = found[0];
      assert.equal(!!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), exported, name);
      const text = node.getText(source);
      // Reject direct external, random and clock access even when added to a selected declaration.
      function audit(n) {
        if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || n.kind === ts.SyntaxKind.ImportKeyword) throw Error('unexpected import');
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const target = n.expression.getText(source);
          assert(['String','Number','Number.isFinite','Number.isNaN','Date','JSON.parse','Set','classifyAdjustment','finiteNumber','safeCategory','nullableString','occurredAt.getTime','occurredAt.toISOString','value.trim','value.trim().slice','VALID_CATEGORIES.has','ADJUSTMENT_TYPES.includes',"['free_credit_reset', 'free_credit_reset_worker'].includes"].includes(target), `unexpected call ${target}`);
          if (target === 'Date') assert.equal(n.arguments?.length, 1, 'Date must have explicit input');
        }
        ts.forEachChild(n, audit);
      }
      audit(node);
      if (name === 'parseQueuedAiUsageReceipt') {
        assert(ts.isFunctionDeclaration(node));
        assert.deepEqual(node.parameters.map(p => [p.name.getText(source), p.type.getText(source), !!p.questionToken]), [['raw', 'string', false]]);
        assert.equal(node.type.getText(source), 'QueuedAiUsageReceipt | null');
      }
      return {name, exported, kind:ts.SyntaxKind[node.kind], text, sha256:sha(text)};
    });
    provenance.push({file, sha256:sha(bytes), imports, declarations});
    const input = declarations.map(d => d.text).join('\n');
    const compiled = ts.transpileModule(input, {fileName:file, reportDiagnostics:true, compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}});
    assert(!compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error));
    modules.push(compiled.outputText);
  }
  return {provenance, modules};
}
function load(isolated) {
  const built = build();
  function evaluate(code, deps, filename) {
    const module = {exports:{}};
    const requireOnly = name => { assert.equal(name, './ai_usage_classification.js'); assert(deps); return deps; };
    if (isolated) vm.runInNewContext(`(function(exports,require,module){${code}\n})`, {}, {filename, timeout:10000})(module.exports, requireOnly, module);
    else {
      // Node's standard CommonJS wrapper executes in the normal realm, not a VM sandbox.
      const wrapped = Module.wrap(code);
      vm.runInThisContext(wrapped, {filename})(module.exports, requireOnly, module, filename, path.dirname(filename));
    }
    return module.exports;
  }
  const classifier = evaluate(built.modules[0], null, 'classification-extract.cjs');
  // The selected ledger declarations refer to the imported binding; retain the real compiled classifier.
  const ledger = evaluate('const {classifyAdjustment} = require("./ai_usage_classification.js");\n' + built.modules[1], classifier, 'ledger-extract.cjs');
  return {parse:ledger.parseQueuedAiUsageReceipt, provenance:built.provenance};
}
module.exports = {load, sha, root};
