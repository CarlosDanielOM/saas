'use strict';
// Pinned source contracts and BSON wire behavior; no application or DB startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const bson = require('bson');
const {resolveSource} = require('./schema_source_resolver.cjs');
const root = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  'src/schemas/command_timer.schema.ts':'db42c5b989f6e154551c714f51736585b0230fa743f6bc51fe935b54530af4f5',
  'src/schemas/countdown_timer.schema.ts':'5d6ab4812c726b2aab0a8fee4a3ca060c6dacc97f59b8aee66c46b669766b990',
  'src/schemas/countdown_timer_config.schema.ts':'b4cf0d5f8cfe85dc1e04f11970aac8bbab48a27c86fc9fab43d935cdbb1ada8a',
  'src/schemas/custom_timer.schema.ts':'6c59b38b43615325f87c870dcbd5dfe2cd0b50e91822dbe884d3c32dd45f387f',
  'src/schemas/chat_logs.schema.ts':'732abc7b27b820fa6ded0d62b1dc3bf3aed8539c7fd636a47f47d98f70b63433',
  'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
  'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
  'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
  'node_modules/bson/package.json':'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23',
  'node_modules/bson/lib/bson.cjs':'64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284',
};
const nodePin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.version,'v24.22.1');
assert.equal(process.versions.v8,'13.6.233.17-node.58');
assert.equal(ts.version,'5.9.3');
assert.equal(sha(fs.readFileSync(process.execPath)),nodePin);
assert.equal(fs.realpathSync(require.resolve('bson')),fs.realpathSync(path.join(root,'node_modules/bson/lib/bson.cjs')));
for(const [file,pin] of Object.entries(pins)) { const bytes=file.startsWith('src/schemas/')?resolveSource(root,file,pin).bytes:fs.readFileSync(path.join(root,file)); assert.equal(sha(bytes),pin,file); }
const expected={
  command_timer:['ICommandTimer','CommandTimerSchema'],
  countdown_timer:['ICountdownTimer','CountdownTimerSchema'],
  countdown_timer_config:['ICountdownTimerConfig','CountdownTimerConfigSchema'],
  custom_timer:['ICustomTimer','CustomTimerSchema'],
  chat_logs:['IChatLog','ChatLogSchema'],
};
const declarations={},imports={},hooks={},sources={},provenance={};
let extracted='declare namespace Types { class ObjectId { private _id: never; } }\n';
for(const [file,names] of Object.entries(expected)) {
  const logical=`src/schemas/${file}.schema.ts`,resolved=resolveSource(root,logical,pins[logical]),source=resolved.bytes.toString('utf8');
  provenance[logical]=resolved.provenance;
  sources[logical]=sha(source);
  const ast=ts.createSourceFile(logical,source,ts.ScriptTarget.ES2022,true);
  assert.deepEqual(ast.parseDiagnostics,[]);
  imports[file]=ast.statements.filter(ts.isImportDeclaration).map(s=>s.moduleSpecifier.text);
  assert.deepEqual(imports[file],['mongoose']);
  hooks[file]=[];
  const walk=node=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['pre','post'].includes(node.expression.name.text)) hooks[file].push(node.getText(ast)); ts.forEachChild(node,walk);};
  walk(ast); assert.deepEqual(hooks[file],[]);
  const exports=[];
  for(const statement of ast.statements) {
    if(!statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) continue;
    const nodes=ts.isVariableStatement(statement)?statement.declarationList.declarations:[statement];
    for(const node of nodes) {
      const name=node.name?.getText(ast), text=statement.getText(ast); exports.push(name);
      const members=ts.isInterfaceDeclaration(statement)?statement.members.map(m=>({name:m.name.getText(ast),type:m.type.getText(ast),optional:!!m.questionToken})):null;
      declarations[name]={file:logical,kind:ts.SyntaxKind[statement.kind],text,sha256:sha(text),members};
      if(!name.endsWith('Schema')) extracted+=text+'\n';
    }
  }
  assert.deepEqual(exports,names);
}
const virtual=path.join(root,'__timer_chat_contract__.ts');
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,skipLibCheck:true,types:[]};
const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host);
host.readFile=f=>f===virtual?extracted:read(f);host.fileExists=f=>f===virtual||exists(f);
const program=ts.createProgram([virtual],options,host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const checker=program.getTypeChecker(), checked=program.getSourceFile(virtual), signatures={};
for(const s of checked.statements) if(s.name&&declarations[s.name.text]&&ts.isInterfaceDeclaration(s)) signatures[s.name.text]=s.members.map(m=>({name:m.name.getText(checked),type:checker.typeToString(checker.getTypeAtLocation(m),undefined,ts.TypeFormatFlags.NoTruncation),optional:!!m.questionToken}));
const dependencies=[...Object.keys(expected).map(n=>`src/schemas/${n}.schema.rs`),'src/schemas/schema.rs','src/utils/js_string.rs','tests/fixtures/timer_chat_schema_types_reference.cjs','tests/fixtures/schema_source_resolver.cjs','tests/timer_chat_schema_types.rs','tests/support/schema_source.rs','tests/support/sha256.rs'];
const hashes=Object.fromEntries(dependencies.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
const bsonStrings=[[0x61],[0xd800],[0xdc00],[0xd800,0x61,0xdc00],[0xd83d,0xde00],[0x540d,0,0x3a9]].map(units=>{
  const bytes=bson.serialize({value:String.fromCharCode(...units)}), output=bson.deserialize(bytes).value;
  return {units,bsonHex:bytes.toString('hex'),outputUnits:Array.from({length:output.length},(_,i)=>output.charCodeAt(i))};
});
const bsonNumbers=[['nan',NaN],['positiveInfinity',Infinity],['negativeInfinity',-Infinity],['negativeZero',-0],['fraction',1.5]].map(([name,value])=>{
  const bytes=bson.serialize({value:new bson.Double(value)}),output=bson.deserialize(bytes).value;
  assert(Number.isNaN(value)?Number.isNaN(output):Object.is(output,value));
  return {name,bsonHex:bytes.toString('hex')};
});
const output=JSON.stringify({format:1,versions:{node:process.version,v8:process.versions.v8,typescript:ts.version},nodePin,pins,sources,provenance,imports,hooks,declarations,signatures,hashes,bsonStrings,bsonNumbers},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&!extra.length);
const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(root,'..'));
assert.equal(real,dir);assert(real!==workspace&&!real.startsWith(workspace+path.sep));
const filename='timer-chat-schema-types-reference.json',target=path.join(real,filename);
assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[filename]);
if(mode==='--write') fs.writeFileSync(target,output,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(JSON.stringify({mode,sha256:sha(output)}));
