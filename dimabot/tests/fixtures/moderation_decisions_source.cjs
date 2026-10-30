'use strict';
// Full source modules, with only the Mongo model and wall-clock/scheduler at
// explicitly recorded fixture boundaries. The real variation compiler runs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const variation = require('./moderation_variations_source.cjs');
const audited = require('./moderation_spam_source.cjs');
const local = Module.createRequire(path.join(variation.root, 'package.json'));
const ts = local('typescript');
const mongoose = local('mongoose');
assert.equal(process.versions.node, '24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
assert.equal(mongoose.version, '8.24.2');
const mongooseLocal = Module.createRequire(local.resolve('mongoose'));
const driverPath = fs.realpathSync(mongooseLocal.resolve('mongodb'));
assert.equal(driverPath, fs.realpathSync(path.join(variation.root,'node_modules/mongoose/node_modules/mongodb/lib/index.js')));
const driverRequire = Module.createRequire(driverPath);
assert.equal(fs.realpathSync(driverRequire.resolve('bson')), fs.realpathSync(path.join(variation.root,'node_modules/bson/lib/bson.cjs')));
assert.equal(JSON.parse(variation.read('node_modules/mongoose/node_modules/mongodb/package.json')).version, '6.20.0');
assert.equal(JSON.parse(variation.read('node_modules/bson/package.json')).version, '6.10.4');
const pins = {
  'src/utils/moderation/decisions.ts': 'd31e15014f43ae4959971942511048f7a71b42ab7ba41104221d125921c4ef96',
  'src/utils/databases/mongodb.database.ts': '76f1b67bd33420402f6c33f11f3bd5d6e1d0ee5c7bd07b66469a3a2c80aa9cec',
  'node_modules/mongoose/node_modules/mongodb/lib/bson.js': '1880a069aa02d09798a3a082d77198aafa4a2d6a1c0315691f25820b58c025ea',
  'node_modules/mongoose/node_modules/mongodb/package.json': '54edfda15c69f02c7d6ddf045f339caa1c94cef76b45c2383e1b35071024241b',
  'node_modules/bson/lib/bson.cjs': '64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284',
  'node_modules/bson/package.json': 'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23',
  'node_modules/mongoose/node_modules/mongodb/lib/index.js': 'd58c7e45c97513297d1ea31bd2a0331be96595dc9887856abab89f91cf944783',
  'node_modules/mongoose/node_modules/mongodb/lib/operations/find_and_modify.js': '635a1dee2dc9a2a4add02f2c6c6e47060887ba2e9102018edf89e4faa30bf003',
  'node_modules/mongoose/lib/query.js': '4613f14a4626d00e1ad85f0cb0c0e1326266be8b8a7eadc372fd93875820816a',
  'node_modules/mongoose/lib/helpers/query/castUpdate.js': 'b2b53126ed947f1fb2fe267fcb3814e40f12181454a7a6ee24f82c48687cef9b',
  'node_modules/mongoose/lib/helpers/setDefaultsOnInsert.js': '45959792d1854b183e28359d34cefb49ca76ac9f2cb711b309ea6be26b9fb4f7',
  'src/schemas/moderation_decision.schema.ts': '749f450beb060ccba72447cc765f4e372b8d6fcbfa20d7c74ecd21a7d09b4466',
  'tests/fixtures/moderation_variations_source.cjs': 'a90b6a9bf8e6c9a859c2454c76b0222d99d1c8b6d3e0c930ce4ee1f072a28653',
  'tests/fixtures/moderation_spam_source.cjs': '24173a6f2eb5979c89aa27cf5804c4c2c9f92df02daf7a66d9479e5e52cb7b8a',
};
for (const [file, hash] of Object.entries(pins)) assert.equal(variation.sha(variation.read(file)), hash, file);
audited.independent('DIMA_DECISIONS_LOADER_SHA256', __filename);
const files = ['src/utils/moderation/decisions.ts', 'src/schemas/moderation_decision.schema.ts'];
const expectedImports = [
  [['./variations.js', false, "{ compileRuleVariations }"], ['node:crypto', false, "{ createHash }"], ['../../schemas/moderation_decision.schema.js', false, "{ ModerationDecision, type IModerationDecision }"], ['./advanced.js', false, "{ DECISION_POLICY_VERSION, MODERATION_RETENTION_DAYS, SEMANTIC_MODEL }"]],
  [['mongoose', false, '{ Schema, model }'], ['./channel_moderation_settings.schema.js', true, 'type { IModerationRule }'], ['../utils/moderation/advanced.js', true, 'type { ModerationMatch }']],
];
const compiled = {}, evidence = {}, outputs = {};
for (const [i, file] of files.entries()) {
  const source = variation.read(file).toString('utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  assert.deepEqual(ast.parseDiagnostics, [], file);
  const imports = ast.statements.filter(ts.isImportDeclaration).map(s => [s.moduleSpecifier.text, !!s.importClause?.isTypeOnly, s.importClause?.getText(ast)]);
  assert.deepEqual(imports, expectedImports[i], file);
  const declarations = ast.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || ts.isExportDeclaration(s)).map(s => ({kind:ts.SyntaxKind[s.kind], text:s.getText(ast)}));
  const out = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:true}, reportDiagnostics:true});
  assert.deepEqual(out.diagnostics, [], file);
  outputs[file] = out.outputText;
  compiled[file] = variation.sha(out.outputText);
  evidence[file] = {imports, declarations};
}
assert.deepEqual(evidence[files[0]].declarations.map(x => x.text.match(/^export (?:async )?function (\w+)/)?.[1]), ['moderationDecisionID','createModerationDecision','awaitSemanticDecision']);
assert.deepEqual(evidence[files[1]].declarations.map(x => x.text.match(/^export (?:interface|const) (\w+)/)?.[1]), ['ModerationContextMessage','IModerationDecision','ModerationDecision']);
function realm({model, clock, timeout}) {
  assert(model && clock && timeout);
  const module = new Module(path.join(variation.root, files[0]), moduleParent());
  module.filename = path.join(variation.root, files[0]);
  const actualVariations = variation.realm();
  const actualAdvanced = require('./moderation_advanced_source.cjs').realm().api;
  module.require = id => {
    if (id === './variations.js') return actualVariations;
    if (id === './advanced.js') return actualAdvanced;
    if (id === '../../schemas/moderation_decision.schema.js') return {ModerationDecision:model};
    if (id === 'node:crypto') return require(id);
    if (id === 'fixture:clock') return clock;
    if (id === 'fixture:timeout') return timeout;
    throw Error(`unexpected import ${id}`);
  };
  module._compile("const Date = require('fixture:clock'); const setTimeout = require('fixture:timeout');\n" + outputs[files[0]], module.filename);
  const api = module.exports;
  assert.deepEqual(Object.keys(api).sort(), ['moderationDecisionID','createModerationDecision','awaitSemanticDecision'].sort());
  return api;
}
function schemaRealm(collectionHook) {
  const instance = new mongoose.Mongoose();
  instance.set('bufferCommands', false);
  assert.equal(instance.connection.readyState, 0);
  const mod = new Module(path.join(variation.root, files[1]), module);
  mod.filename = path.join(variation.root, files[1]);
  mod.require = id => {
    if (id === 'mongoose') return {Schema:mongoose.Schema, model:instance.model.bind(instance)};
    throw Error(`unexpected schema runtime import ${id}`);
  };
  mod._compile(outputs[files[1]], mod.filename);
  assert.deepEqual(Object.keys(mod.exports), ['ModerationDecision']);
  const model = mod.exports.ModerationDecision;
  model.collection.findOneAndUpdate = collectionHook;
  return {model, instance, bson:mongoose.mongo.BSON};
}
function moduleParent() { return module; }
module.exports = { ...audited, realm, schemaRealm, driverBsonOptions:require(path.join(path.dirname(driverPath),'bson.js')), pins:{...audited.pins,...variation.variationPins,...pins}, compiled:{...audited.compiled,...variation.variationCompiled,...compiled}, evidence:{...audited.evidence,...variation.variationEvidence,...evidence}, re2Runtime:variation.re2Runtime, nodeSha:variation.nodeSha };
