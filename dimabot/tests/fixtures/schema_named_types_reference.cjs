'use strict';
// Source-only oracle. Run in the isolated pinned Node environment; never connects to MongoDB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const bson = require('bson');
const {resolveSource} = require('./schema_source_resolver.cjs');
const root = path.resolve(__dirname, '../..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'src/schemas/admin.schema.ts':'b45fef05b1b176cac11283df5ec7d1d09b1fc327bae98e4e7ca4447f43baa2e0',
  'src/schemas/accounts.schema.ts':'7eab86b048cb05d44e9b17c7498c18b713e4c722b71f58f545158fde040431f1',
  'src/schemas/credit_gift.schema.ts':'f76f4472354751b42587baa1271214c198aac40b86b5fcb85fd046e4de9c0607',
  'src/schemas/credit_transaction.schema.ts':'14017b20e83ec2eebf7a10475b5ade495554cc9043685af3dd5045350a9e985f',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/bson/package.json':'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23',
  'node_modules/bson/lib/bson.cjs':'64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
};
const nodePin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
assert.equal(fs.realpathSync(require.resolve('bson')), fs.realpathSync(path.join(root,'node_modules/bson/lib/bson.cjs')));
assert.equal(sha(fs.readFileSync(process.execPath)), nodePin);
for (const [file, hash] of Object.entries(pins)) {
  const bytes = file.startsWith('src/schemas/') ? resolveSource(root,file,hash).bytes : fs.readFileSync(path.join(root,file));
  assert.equal(sha(bytes), hash, file);
}
const expected = {
  'admin':['IAdmin','AdminSchema'],
  'accounts':['IAccounts','AccountsSchema'],
  'credit_gift':['CreditGiftStatus','ICreditGift','CreditGiftSchema'],
  'credit_transaction':['TRANSACTION_TYPES','TransactionType','ICreditTransactionMetadata','ICreditTransaction','CreditTransactionSchema'],
};
const declarations = {}, imports = {}, sources = {}, provenance = {}, catalogs = {};
let extracted = 'declare namespace Types { class ObjectId { private _id: never; } }\n';
for (const [file, names] of Object.entries(expected)) {
  const logical = `src/schemas/${file}.schema.ts`;
  const resolved = resolveSource(root,logical,pins[logical]);
  const source = resolved.bytes.toString('utf8');
  provenance[logical] = resolved.provenance;
  const ast = ts.createSourceFile(logical,source,ts.ScriptTarget.ES2022,true);
  assert.deepEqual(ast.parseDiagnostics, []);
  sources[logical] = sha(source);
  imports[file] = ast.statements.filter(ts.isImportDeclaration).map(s => s.moduleSpecifier.text);
  assert.deepEqual(imports[file], ['mongoose']);
  const exports = [];
  for (const s of ast.statements) {
    if (!s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const nodes = ts.isVariableStatement(s) ? s.declarationList.declarations : [s];
    for (const n of nodes) {
      const name = n.name?.getText(ast); exports.push(name);
      const text = s.getText(ast);
      const members = ts.isInterfaceDeclaration(s) ? s.members.map(m => ({name:m.name.getText(ast),type:m.type.getText(ast),optional:!!m.questionToken})) : null;
      declarations[name] = {file:logical,kind:ts.SyntaxKind[s.kind],text,sha256:sha(text),members};
      if (!name.endsWith('Schema')) extracted += text + '\n';
      const literalUnion = node => { assert(ts.isUnionTypeNode(node)); return node.types.map(t => { assert(ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)); return t.literal.text; }); };
      if (name === 'IAdmin') catalogs.adminRoles = literalUnion(s.members.find(m => m.name.getText(ast) === 'role').type);
      if (name === 'CreditGiftStatus') catalogs.giftStatuses = literalUnion(s.type);
      if (name === 'ICreditTransactionMetadata') catalogs.rewardTargets = literalUnion(s.members.find(m => m.name.getText(ast) === 'rewardTargetType').type);
      if (name === 'TRANSACTION_TYPES') {
        assert(ts.isAsExpression(n.initializer) && ts.isObjectLiteralExpression(n.initializer.expression));
        catalogs.transactionTypes = n.initializer.expression.properties.map(p => { assert(ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)); return {key:p.name.getText(ast),value:p.initializer.text}; });
      }
    }
  }
  assert.deepEqual(exports,names);
}
// Type-check source declarations under strict null checking with a nominal ObjectId stub.
const virtual = path.join(root,'__schema_named_types_contract__.ts');
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[]};
const host = ts.createCompilerHost(options); const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
host.readFile = f => f === virtual ? extracted : read(f);
host.fileExists = f => f === virtual || exists(f);
const program = ts.createProgram([virtual],options,host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const checker=program.getTypeChecker(), checked=program.getSourceFile(virtual), signatures={};
for (const s of checked.statements) if (s.name && declarations[s.name.text]) {
  signatures[s.name.text] = ts.isInterfaceDeclaration(s)
    ? s.members.map(m => ({name:m.name.getText(checked),type:checker.typeToString(checker.getTypeAtLocation(m),undefined,ts.TypeFormatFlags.NoTruncation),optional:!!m.questionToken}))
    : checker.typeToString(checker.getTypeAtLocation(s.name),undefined,ts.TypeFormatFlags.NoTruncation);
}
const nativeFiles = Object.keys(expected).map(n=>`src/schemas/${n}.schema.rs`);
const hashes = Object.fromEntries([...nativeFiles,'src/schemas/schema.rs','src/utils/js_string.rs','tests/fixtures/schema_named_types_reference.cjs','tests/fixtures/schema_source_resolver.cjs','tests/schema_named_types.rs','tests/support/schema_source.rs','tests/support/sha256.rs'].map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
const bsonStrings = [[0x0061], [0xd800], [0xdc00], [0xd800,0x0061,0xdc00], [0xd83d,0xde00], [0x540d,0x0000,0x03a9]].map(units => {
  const input=String.fromCharCode(...units), bytes=bson.serialize({value:input});
  const output=bson.deserialize(bytes).value;
  return {units, bsonHex:bytes.toString('hex'), outputUnits:Array.from({length:output.length},(_,i)=>output.charCodeAt(i))};
});
const bsonNumbers = [["nan",NaN], ["positiveInfinity",Infinity], ["negativeInfinity",-Infinity], ["negativeZero",-0], ["fraction",1.5]].map(([name,value]) => {
  const bytes=bson.serialize({value:new bson.Double(value)}), output=bson.deserialize(bytes).value;
  assert(Number.isNaN(value) ? Number.isNaN(output) : Object.is(output,value));
  return {name,bsonHex:bytes.toString('hex')};
});
const result = {format:1,bsonStrings,bsonNumbers,versions:{node:process.version,v8:process.versions.v8,typescript:ts.version},nodePin,pins,sources,provenance,imports,declarations,signatures,catalogs,hashes};
const output=JSON.stringify(result,null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length);
const real=fs.realpathSync(dir), workspace=fs.realpathSync(path.join(root,'..'));
assert.equal(real,dir); assert(real!==workspace && !real.startsWith(workspace+path.sep));
const filename='schema-named-types-reference.json', target=path.join(real,filename);
assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[filename]);
if(mode==='--write') fs.writeFileSync(target,output,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(JSON.stringify({mode,sha256:sha(output)}));
