'use strict';
const leaf = require('./moderation_leaf_source_resolver.cjs');
// Full unchanged source and actual real disconnected Mongoose in the CommonJS realm.
// Bootstrap mirrors the pinned source oracle; no source or runtime implementation is stubbed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),assert=require('node:assert/strict');
const root=fs.realpathSync(process.env.DIMA_MODERATION_SCHEMA_BENCH_SOURCE_ROOT || path.join(__dirname,'../..'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');const read=f=>fs.readFileSync(leaf.sourcePath(root, f));
const pins={
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
 'src/utils/moderation/variations.ts':'f7a21881289f63a50de733df232570c00f851333d5762ef39e1258915287580e',
 'src/utils/moderation/advanced.ts':'e88c52a8662a1531bdca981129e91f9cfe3b84c2543f11d38584652aede8a4d7',
 'src/utils/permissions/expression.ts':'34a3d2900bbad64bde838504e16a73f361bf7d317ef4089dcbf58fe0b1e79ab2',
 'src/utils/permissions/roles.ts':'9469ce3029c6aedce85cc7a6ad3c180adf097051ef6d5c1aa0cac68b7396df20',
 'package.json':'cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef',
 'package-lock.json':'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
 'rust-toolchain.toml':'b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
 'node_modules/typescript/package.json':'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
 'node_modules/mongoose/package.json':'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba',
 'node_modules/mongoose/index.js':'59e21822580047abc5468d740b720d1383fa3569aa2da3ac70325265fbb0e25b',
};
for(const [file,digest] of Object.entries(pins))assert.equal(sha(read(file)),digest,file);
const nodePin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_MODERATION_SCHEMA_BENCH_NODE_SHA256,nodePin);assert.equal(sha(fs.readFileSync(process.execPath)),nodePin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local=Module.createRequire(path.join(root,'package.json')),ts=local('typescript'),mongoose=local('mongoose');assert.equal(ts.version,'5.9.3');assert.equal(mongoose.version,'8.24.2');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
assert.equal(fs.realpathSync(local.resolve('mongoose')),fs.realpathSync(path.join(root,'node_modules/mongoose/index.js')));
const schemaFile='src/schemas/channel_moderation_settings.schema.ts',spamFile='src/utils/moderation/spam_categories.ts';
const source=read(schemaFile).toString('utf8'),spam=read(spamFile).toString('utf8');
function ast(file){const a=ts.createSourceFile(file,read(file).toString('utf8'),ts.ScriptTarget.ES2022,true);assert.deepEqual(a.parseDiagnostics,[]);return a;}
const sf=ast(schemaFile),spamAst=ast(spamFile),advanced=ast('src/utils/moderation/advanced.ts'),variations=ast('src/utils/moderation/variations.ts'),expression=ast('src/utils/permissions/expression.ts'),roles=ast('src/utils/permissions/roles.ts');
const imports=sf.statements.filter(ts.isImportDeclaration).map(s=>({path:s.moduleSpecifier.text,typeOnly:!!s.importClause?.isTypeOnly,text:s.getText(sf)}));
assert.deepEqual(imports.map(i=>[i.path,i.typeOnly]),[['../utils/moderation/spam_categories.js',false],['../utils/moderation/variations.js',true],['crypto',false],['mongoose',false],['../utils/permissions/expression.js',true],['../utils/moderation/advanced.js',true]]);
function declarations(tree,names){return names.map(name=>{const item=tree.statements.find(s=>(ts.isTypeAliasDeclaration(s)||ts.isInterfaceDeclaration(s))&&s.name.text===name);assert(item,`missing type ${name}`);return item.getText(tree);}).join('\n');}
const roleConst=roles.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(roles)==='ROLE_TAGS'));assert(roleConst);
// Type-only dependencies are declarations extracted directly from actual ASTs;
// their unrelated runtime imports are not loaded or stubbed into the module.
const overlays={
 'src/utils/moderation/advanced.ts':`import type { SpamCategory } from './spam_categories.js';\n${declarations(advanced,['ModerationPattern','SemanticPolicy'])}`,
 'src/utils/moderation/variations.ts':`import type { ModerationPattern } from './advanced.js';\n${declarations(variations,['VariationMode','GeneratedVariation','VariationOverride','ModerationVariations'])}`,
 'src/utils/permissions/expression.ts':`import type { RoleTag } from './roles.js';\n${declarations(expression,['PermissionExpression'])}`,
 'src/utils/permissions/roles.ts':`${roleConst.getText(roles)}\n${declarations(roles,['RoleTag'])}`,
};
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']};
const host=leaf.overlaySource(ts.createCompilerHost(options), ts, root, ["src/utils/moderation/spam_categories.ts"]),origRead=host.readFile.bind(host),origGet=host.getSourceFile.bind(host);
const overlayFor=file=>overlays[path.relative(root,path.resolve(file)).split(path.sep).join('/')];
host.readFile=file=>overlayFor(file)??origRead(file);
host.getSourceFile=(file,version,...rest)=>{const text=overlayFor(file);return text===undefined?origGet(file,version,...rest):ts.createSourceFile(file,text,version,true,ts.ScriptKind.TS);};
const program=ts.createProgram([path.join(root,schemaFile)],options,host);
assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);
const localMongoose={Schema:instance.Schema,model:instance.model.bind(instance)};
const compiled={};
function load(name,text,required){const out=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});assert.deepEqual(out.diagnostics,[]);compiled[name]=sha(out.outputText);const m=new Module(path.join(root,name),module);m.filename=path.join(root,name);m.require=id=>{assert(Object.hasOwn(required,id),`unexpected runtime import ${id}`);return required[id];};m._compile(out.outputText,m.filename);return m.exports;}
const spamApi=load(spamFile,spam,{});
const api=load(schemaFile,source,{'../utils/moderation/spam_categories.js':spamApi,'crypto':crypto,'mongoose':localMongoose});
const expectedExports=['MODERATION_OFFENSE_DEFAULTS','MODERATION_RULE_DEFAULTS','MODERATION_SETTINGS_DEFAULTS','MAX_TIMEOUT_SECONDS','MIN_OFFENSE_WINDOW_SECONDS','MAX_OFFENSE_WINDOW_SECONDS','MAX_RULES_PER_CHANNEL','MAX_BLACKLIST_TERMS','MAX_ALLOWLIST_DOMAINS','buildDefaultModerationRules','ChannelModerationSettingsSchema'];
assert.deepEqual(Object.keys(api).sort(),expectedExports.sort());
const model=api.ChannelModerationSettingsSchema;
const readline=require('node:readline');
const nativeFiles=['src/schemas/channel_moderation_settings.schema.rs','src/schemas/schema.rs','src/utils/moderation/spam_categories.rs','src/utils/moderation/caps.rs','src/utils/bson_compat.rs','src/utils/json_number.rs','src/utils/js_compat.rs','src/utils/mongoose_date.rs','src/utils/js_date/mod.rs','src/utils/js_date/parser.rs','src/utils/js_date/local_time.rs','src/utils/js_string.rs','src/utils/moderation/caps_unicode_data.rs','tests/channel_moderation_settings_schema.rs','tests/channel_moderation_settings_store.rs','tests/fixtures/channel_moderation_settings_reference.cjs','tests/channel_moderation_settings_benchmark.rs','tests/fixtures/channel_moderation_settings_benchmark.cjs','Cargo.toml','Cargo.lock'];
const nativeHashes=Object.fromEntries(nativeFiles.map(f=>[f,sha(read(f))]));
const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version};
const id='507f1f77bcf86cd799439011';
const base=kind=>({id:kind,type:kind});
const inputs={
 defaults:[
  {channelID:'alpha'},{channelID:'beta',channel:'Streamer'}, {channelID:'gamma',enabled:true}, {channelID:'delta',spamProtection:null},
  {channelID:'echo',offenseWindowSeconds:120},{channelID:'foxtrot',settingsVersion:2},{channelID:'golf',channel:'Árbol 東京 😀'},{channelID:'hotel',spamProtection:{enabled:false}}],
 'four-rules':Array.from({length:8},(_,i)=>({channelID:`channel-${i}`,channel:i%2?'Canal Ω':'Streamer',enabled:!!(i%2),rules:[
  {...base('caps'),minCapsCount:8+i,exemptExpression:{role:'vip',nested:{},items:[{}, {value:i}]}},
  {...base('links'),allowlistDomains:['example.com','twitch.tv'],reason:'Links Ω'},
  {...base('emote_spam'),maxEmoteCount:10+i},
  {...base('blacklist'),enabled:false,terms:['café','東京'],variations:{mode:'off',entries:[{}, {label:'á'}]},patterns:[{id:'p',source:'x',boundary:'anywhere',ignoreCase:true}],semantic:{policy:'moderation',examples:[{message:'hello',label:'allow'}]}}
 ]})),
 invalid:[
  {},{channelID:''},{channelID:'a',offenseWindowSeconds:59},{channelID:'b',offenseWindowSeconds:86401},
  {channelID:'c',rules:[{id:'r',type:'caps',minCapsCount:0}]},{channelID:'d',rules:[{id:'r',type:'caps',maxEmoteCount:101}]},
  {channelID:'e',rules:[{id:'r',type:'invalid'}]},{channelID:'f',spamProtection:{categories:['invalid']}}],
};
const toInput=x=>({...x,_id:new mongoose.Types.ObjectId(id)});
// Timed work mirrors new Model + validateSync + toObject only on success.
function evaluate(input){const d=new model(input),error=d.validateSync();return error || d.toObject({minimize:true});}
function canonical(value){
 if(value instanceof mongoose.Types.ObjectId)return {'$oid':value.toHexString()};
 if(value instanceof Date)return {'$dateMs':value.getTime()};
 if(Array.isArray(value))return value.map(canonical);
 if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>[k,canonical(value[k])]));
 return value;
}
function toRecord(result){
 if(result instanceof mongoose.Error.ValidationError){const errors=Object.entries(result.errors).map(([p,e])=>({path:p,kind:e.name==='CastError'?'cast':e.kind||e.name})).sort((a,b)=>Buffer.compare(Buffer.from(a.path+'\0'+a.kind),Buffer.from(b.path+'\0'+b.kind)));return {ok:false,errors};}
 return {ok:true,document:canonical(result)};
}
function wire(record){return JSON.stringify(canonical(record));}
function checksum(wires){let h=2166136261;for(const value of wires){for(const b of Buffer.from(value,'utf8'))h=Math.imul(h^b,16777619)>>>0;h=Math.imul(h^0xffffffff,16777619)>>>0;}return h;}
function prepare(){const pools={};for(const [kind,list] of Object.entries(inputs)){assert.equal(list.length,8);pools[kind]=list.map((input,i)=>{const result=toRecord(evaluate(toInput(input)));assert.equal(result.ok,kind!=='invalid',`${kind}:${i}`);const output=wire(result);return {id:`${kind}-${i}`,input,expected:result,wire:output,checksum:checksum([output])};});}
 return {metadata:{format:1,sourceProvenance:leaf.provenance(root,["src/utils/moderation/spam_categories.ts"]),nodeSha:nodePin,versions,pins,nativeHashes,compiled,oracleSha:sha(read('tests/fixtures/channel_moderation_settings_reference.cjs')),objectId:id,realm:'commonjs-real-mongoose'},pools};}
const dirArg=process.env.DIMA_MODERATION_SCHEMA_BENCH_DIR;assert(dirArg&&path.isAbsolute(dirArg));const dir=fs.realpathSync(dirArg);assert.equal(dir,dirArg);
const workspace=fs.realpathSync(path.join(root,'..'));assert(dir!==workspace&&!dir.startsWith(workspace+path.sep));
const file=path.join(dir,'channel-moderation-settings-benchmark-input.json');const [mode,...extra]=process.argv.slice(2);assert(['--write','--check','--serve'].includes(mode)&&extra.length===0);
if(mode==='--write'||mode==='--check'){
 assert.deepEqual(fs.readdirSync(dir),mode==='--write'?[]:[path.basename(file)]);const content=JSON.stringify(prepare(),null,2)+'\n';
 if(mode==='--write')fs.writeFileSync(file,content,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),content);
 console.log(JSON.stringify({mode,inputSha:sha(content)}));
}else{
 const bytes=fs.readFileSync(file),inputSha=sha(bytes);assert.equal(inputSha,process.env.DIMA_MODERATION_SCHEMA_BENCH_INPUT_SHA256);
 const data=JSON.parse(bytes);assert.deepEqual(data.metadata,{format:1,nodeSha:nodePin,versions,pins,nativeHashes,compiled,oracleSha:sha(read('tests/fixtures/channel_moderation_settings_reference.cjs')),objectId:id,realm:'commonjs-real-mongoose'});
 const pools={};assert.deepEqual(Object.keys(data.pools),Object.keys(inputs));
 for(const [kind,rows] of Object.entries(data.pools)){
  assert.equal(rows.length,8);pools[kind]=rows.map(row=>{const input=toInput(row.input);const result=toRecord(evaluate(input));assert.deepEqual(result,row.expected);const output=wire(result);assert.equal(output,row.wire);assert.equal(checksum([output]),row.checksum);return {id:row.id,input};});
 }
 const reps=Number(process.env.DIMA_MODERATION_SCHEMA_BENCH_REPS||1000);assert(Number.isSafeInteger(reps)&&reps>0&&reps<=10000);
 function run(kind){const pool=pools[kind],total=pool.length*reps,results=new Array(total);const start=process.hrtime.bigint();for(let i=0;i<total;i++)results[i]=evaluate(pool[i%pool.length].input);const elapsed=process.hrtime.bigint()-start;const hash=checksum(results.map(x=>wire(toRecord(x))));return {workload:kind,elapsedNs:elapsed.toString(),total,checksum:hash};}
 console.log(JSON.stringify({ready:true,realm:'commonjs-real-mongoose',pools:Object.fromEntries(Object.entries(pools).map(([k,v])=>[k,v.map(x=>x.id)])),reps,inputSha,nodeSha:nodePin,compiled,nativeHashes}));
 readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const cmd=JSON.parse(line);if(cmd.command==='quit')process.exit(0);assert(['warmup','run'].includes(cmd.command)&&Object.hasOwn(pools,cmd.workload));console.log(JSON.stringify(run(cmd.workload)));});
}
