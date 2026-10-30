'use strict';
// Fixed input oracle: execute AST-extracted declarations from the actual source.
// Redis and Mongoose are boundary doubles; the blacklist compiler and defaults
// are actual source dependencies. Results are generated, never hand-authored.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), Module=require('node:module'), assert=require('node:assert/strict');
const leaf=require('./moderation_leaf_source_resolver.cjs');
const root=fs.realpathSync(process.env.DIMA_MODERATION_SOURCE_ROOT || path.resolve(__dirname,'../..'));
const read=p=>fs.readFileSync(leaf.sourcePath(root,p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pins={
 'src/handlers/moderation.handler.ts':'2b57bbd962c25bd1f552a52c9d1d215bc052886ca0b1f0c88109383f988c8e52',
 'src/utils/moderation/spam.ts':'eaa35698ebd7f7e2351e522ca4ece5a3d96b58a96acc41b162b6f22eb2adaaa8',
 'src/schemas/channel_moderation_settings.schema.ts':'e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653',
 'src/utils/moderation/rules/blacklist.rule.ts':'8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff',
 'src/utils/moderation/normalize.ts':'07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab',
 'src/utils/moderation/spam_categories.ts':'29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088',
 'node_modules/typescript/lib/typescript.js':'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675'
};
for(const [p,h] of Object.entries(pins)) assert.equal(sha(read(p)),h,p);
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const local=Module.createRequire(path.join(root,'package.json')), ts=local('typescript');
assert.equal(ts.version,'5.9.3');
assert.equal(fs.realpathSync(local.resolve('typescript')),fs.realpathSync(path.join(root,'node_modules/typescript/lib/typescript.js')));
const files=['src/handlers/moderation.handler.ts','src/utils/moderation/spam.ts','src/schemas/channel_moderation_settings.schema.ts'];
const asts=Object.fromEntries(files.map(file=>{const ast=ts.createSourceFile(file,read(file).toString('utf8'),ts.ScriptTarget.ES2022,true); assert.deepEqual(ast.parseDiagnostics,[]); return [file,ast];}));
function declaration(file,name) {
 const ast=asts[file], found=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name || ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 assert.equal(found.length,1,`${file}:${name}`); return found[0];
}
const h=files[0], spam=files[1], schema=files[2];
const handlerNames=['SETTINGS_CACHE_TTL_SECONDS','NO_SETTINGS_SENTINEL','compiledBlacklistPatterns','moderationSettingsCacheKey','invalidateModerationSettingsCache','primeModerationSettingsCache','loadSettings','getBlacklistPattern'];
const deps=[['../utils/moderation/spam_categories.js','DEFAULT_SPAM_THRESHOLD'],['../utils/databases/dragonfly.database.js','getDragonflyClient'],['../schemas/channel_moderation_settings.schema.js','ChannelModerationSettingsSchema'],['../utils/moderation/rules/blacklist.rule.js','compileBlacklistPattern'],['../utils/moderation/spam.js','defaultSpamModerationSettings']];
for(const [p,n] of deps) assert(asts[h].statements.some(s=>ts.isImportDeclaration(s)&&s.moduleSpecifier.text===p&&s.importClause?.namedBindings?.elements.some(e=>e.name.text===n)));
const evidence={};
for(const [file,names] of [[h,handlerNames],[spam,['spamProtectionSettings','defaultSpamModerationSettings']],[schema,['MODERATION_SETTINGS_DEFAULTS']]]) {
 evidence[file]=names.map(name=>{const n=declaration(file,name);return {name,kind:ts.SyntaxKind[n.kind],exported:!!n.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword),signature:ts.isFunctionDeclaration(n)?n.getText(asts[file]).slice(0,n.body.getStart(asts[file])-n.getStart(asts[file])).trim():n.getText(asts[file])};});
}
assert.deepEqual(evidence[h].map(x=>x.exported),[false,true,false,true,true,true,false,false]);
const blacklist=require('./moderation_blacklist_reference.cjs').api;
const categoriesSource=read('src/utils/moderation/spam_categories.ts').toString('utf8');
const cats=ts.transpileModule(categoriesSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true}); assert.deepEqual(cats.diagnostics,[]);
const mod=new Module(path.join(root,'src/utils/moderation/spam_categories.ts'),module);mod.filename=path.join(root,'src/utils/moderation/spam_categories.ts');mod._compile(cats.outputText,mod.filename);
const pieces=[declaration(schema,'MODERATION_SETTINGS_DEFAULTS').getText(asts[schema]),...['spamProtectionSettings','defaultSpamModerationSettings'].map(n=>declaration(spam,n).getText(asts[spam])),...handlerNames.map(n=>declaration(h,n).getText(asts[h]))];
const source=pieces.join('\n')+'\nexport {loadSettings,getBlacklistPattern,compiledBlacklistPatterns};';
const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.deepEqual(output.diagnostics,[]);
function harness(initial={}) {
 const state={map:new Map(Object.entries(initial.cache||{})), docs:initial.docs||{},log:[],errors:initial.errors||{},race:initial.race,removeWinner:initial.removeWinner,loser:false};
 const call=(name,...args)=>{state.log.push([name,...args]);if(state.errors[name]) throw Error(`injected:${name}`);};
 const cache={async get(key){call('get',key); if(state.loser && state.removeWinner){state.map.delete(key);state.removeWinner=false;} return state.map.get(key)??null;},async del(key){call('del',key);state.map.delete(key);return 1;},async set(key,value,options){call('set',key,value,options);if(options.NX&&state.race!==undefined){state.map.set(key,state.race);state.race=undefined;}if(options.NX&&state.map.has(key)){state.loser=true;return null;}state.map.set(key,value);return 'OK';}};
 const context={...mod.exports,compileBlacklistPattern:blacklist.compileBlacklistPattern,
   getDragonflyClient:async label=>{call('client',label);return cache;},
   ChannelModerationSettingsSchema:{findOne(query){call('findOne',query);return {lean:async()=>{call('lean');return state.docs[query.channelID]??null;}};}}};
 const run=new Function(...Object.keys(context),'exports',output.outputText+'\nreturn exports;');const api=run(...Object.values(context),{});
 return {api,state};
}
async function reference(){
 const cases=[];
 async function add(name,initial,fn){const x=harness(initial);let result;try{result=await fn(x.api,x.state);}catch(e){result={error:e.message};}cases.push({name,result,log:x.state.log,cache:[...x.state.map]});}
 const key='moderation:c:settings';
 await add('missing',{},a=>a.loadSettings('c'));
 await add('unicode-channel',{},a=>a.loadSettings('chan-😀-é'));
 await add('lone-surrogate-channel-outside-native-contract',{},a=>a.loadSettings('chan-\ud800'));
 await add('sentinel',{cache:{[key]:'{"none":true}'}},a=>a.loadSettings('c'));
 await add('hit',{cache:{[key]:'{"enabled":true,"settingsVersion":"1","custom":"\\ud800"}'}},a=>a.loadSettings('c'));
 await add('malformed-db',{cache:{[key]:'{'},docs:{c:{channelID:'c',settingsVersion:7,createdAt:new Date(0),custom:{a:1}}}},a=>a.loadSettings('c'));
 await add('nx-winner',{race:'{"settingsVersion":9,"enabled":true}'},a=>a.loadSettings('c'));
 await add('nx-malformed',{race:'{'},a=>a.loadSettings('c'));
 for(const stage of ['client','get','findOne','lean','set','del']) await add('error-'+stage,{errors:{[stage]:true}},a=>stage==='del'?a.invalidateModerationSettingsCache('c'):a.loadSettings('c'));
 function pattern(p){return p?{source:p.source,flags:p.flags}:null;}
 await add('patterns',{},async a=>{const s={settingsVersion:1},s2={settingsVersion:'1'}, rule={id:'\ud800',terms:['one']};const first=a.getBlacklistPattern('c',s,rule);const same=a.getBlacklistPattern('c',s,{id:'\ud800',terms:['two']});const changed=a.getBlacklistPattern('c',s2,{id:'\ud800',terms:['two']});const empty=a.getBlacklistPattern('c',s2,{id:'null',terms:[]});const stillEmpty=a.getBlacklistPattern('c',s2,{id:'null',terms:['one']});return {first:pattern(first),same:pattern(same),sameIdentity:first===same,changed:pattern(changed),empty:pattern(empty),stillEmpty:pattern(stillEmpty)};});
 for(const operation of ['invalidate','prime']) for(const fail of [false,true]) await add(`${operation}-${fail?'error':'ok'}`,{errors:fail?{[operation==='prime'?'set':'del']:true}:{}},async a=>{a.getBlacklistPattern('c',{settingsVersion:1},{id:'x',terms:['one']});let error=null;try{await (operation==='prime'?a.primeModerationSettingsCache('c',{channelID:'c',settingsVersion:2}):a.invalidateModerationSettingsCache('c'));}catch(e){error=e.message;}return {error,retained:a.compiledBlacklistPatterns.has('c')};});
 return {metadata:{pins,nodeSha,versions:process.versions,dependencies:deps,evidence,compiledSha:sha(output.outputText),provenance:leaf.provenance(root,['src/utils/moderation/normalize.ts','src/utils/moderation/spam_categories.ts'])},cases};
}
// Concrete-driver replay inputs. Each expected value and Redis command sequence
// comes from the extracted source, including its real defaults and compiler.
async function replay(channel) {
 assert(typeof channel==='string' && /^keyword-fixture-[A-Za-z0-9-]+:settings-[A-Za-z0-9-]+(?:-😀-é)?$/u.test(channel));
 const key=`moderation:${channel}:settings`;
 const doc={_id:'fixed-source-id',channelID:channel,settingsVersion:7,createdAt:new Date(0),extra:42};
 const mongoose=local('mongoose'); assert.equal(mongoose.version,'8.24.2');
 const mreq=Module.createRequire(local.resolve('mongoose'));
 const driverPath=mreq.resolve('mongodb/lib/bson.js'), driver=mreq('mongodb/lib/bson.js');
 const breq=Module.createRequire(driverPath), bsonPath=breq.resolve('bson'), bson=breq('bson');
 assert.equal(sha(fs.readFileSync(driverPath)),'1880a069aa02d09798a3a082d77198aafa4a2d6a1c0315691f25820b58c025ea');
 assert.equal(sha(fs.readFileSync(bsonPath)),'64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284');
 const bsonDoc=driver.deserialize(bson.serialize({_id:new bson.ObjectId('00112233445566778899aabb'),channelID:channel,settingsVersion:7,createdAt:new Date(0),safe:bson.Long.fromString('42'),large:bson.Long.fromString('9007199254740993')}),driver.resolveBSONOptions({}));
 const specs=[
  ['missing',{},'load'], ['sentinel',{cache:{[key]:'{"none":true}'}},'load'],
  ['empty',{cache:{[key]:''}},'load'], ['malformed',{cache:{[key]:'{'}},'load'],
  ['hit',{cache:{[key]:'{"enabled":true,"settingsVersion":"1"}'}},'load'],
  ['null',{cache:{[key]:'null'}},'load'], ['zero',{cache:{[key]:'0'}},'load'],
  ['db',{docs:{[channel]:doc}},'load'], ['db-bson',{docs:{[channel]:bsonDoc}},'load'], ['malformed-db',{cache:{[key]:'{'},docs:{[channel]:doc}},'load'],
  ['nx-winner',{race:'{"settingsVersion":9,"enabled":true}'},'load'],
  ['nx-malformed',{race:'{'},'load'], ['nx-missing',{race:'{\"settingsVersion\":9}',removeWinner:true},'load'], ['nx-sentinel',{race:'{"none":true}'},'load'],
  ['get-error',{errors:{get:true}},'load'], ['mongo-error',{errors:{findOne:true}},'load'], ['set-error',{errors:{set:true}},'load'], ['db-set-error',{errors:{set:true},docs:{[channel]:doc}},'load'],
  ['prime',{},'prime'], ['prime-error',{errors:{set:true}},'prime'],
  ['invalidate',{cache:{[key]:'old'}},'invalidate'], ['invalidate-error',{cache:{[key]:'old'},errors:{del:true}},'invalidate']
 ];
 const cases=[];
 for(const [name,initial,operation] of specs) {
  const {api,state}=harness(initial), version={settingsVersion:1}, rule={id:'rule',terms:['one']};
  if(operation!=='load') api.getBlacklistPattern(channel,version,rule);
  let result=null,error=null;
  try { if(operation==='load') result=await api.loadSettings(channel); else if(operation==='prime') await api.primeModerationSettingsCache(channel,{channelID:channel,settingsVersion:2}); else await api.invalidateModerationSettingsCache(channel); }
  catch(e){error=e.message;}
  const retained=operation==='load'?null:api.getBlacklistPattern(channel,version,{id:'rule',terms:['two']}).source.includes('one');
  cases.push({name,initial,operation,result,error,retained,ioLog:state.log.filter(x=>['get','set','del','findOne'].includes(x[0])),cache:state.map.get(key)??null});
 }
 const versions=[{}, {settingsVersion:1},{settingsVersion:1},{settingsVersion:'1'}, {settingsVersion:null}, {settingsVersion:0}, {settingsVersion:-0}, {settingsVersion:{x:1}}, {settingsVersion:{x:1}}];
 const {api}=harness(); const patterns=[];
 for(let i=0;i<versions.length;i++) { const settings=versions[i], first=api.getBlacklistPattern(channel,settings,{id:'𝄞',terms:['one']}), second=api.getBlacklistPattern(channel,settings,{id:'𝄞',terms:['two']}), empty=api.getBlacklistPattern(channel,settings,{id:'null',terms:[]}), still=api.getBlacklistPattern(channel,settings,{id:'null',terms:['two']});patterns.push({first:first?.source??null,second:second?.source??null,same:first===second,empty:empty?.source??null,still:still?.source??null}); }
 const loneApi=harness().api, loneSettings={settingsVersion:1};const loneFirst=loneApi.getBlacklistPattern(channel,loneSettings,{id:'\ud800',terms:['one']}),loneSecond=loneApi.getBlacklistPattern(channel,loneSettings,{id:'\ud800',terms:['two']});const lonePattern={first:loneFirst?.source??null,second:loneSecond?.source??null,same:loneFirst===loneSecond};
 const nativeFiles=['src/handlers/moderation_settings_store.rs','src/utils/bson_js_json.rs','src/utils/lossless_json.rs','src/utils/js_string.rs','src/utils/moderation/blacklist.rs','src/utils/moderation/spam.rs','tests/support/moderation_settings_store_protocol.rs','tests/moderation_settings_store.rs','tests/fixtures/moderation_settings_store_reference.cjs','tests/support/moderation_leaf_source.rs','tests/support/sha256.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
 return {metadata:{pins,nodeSha,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version},dependencies:deps,evidence,compiledSha:sha(output.outputText),bsonSha:sha(fs.readFileSync(bsonPath)),driverSha:sha(fs.readFileSync(driverPath)),nativeHashes:Object.fromEntries(nativeFiles.map(p=>[p,sha(read(p))])),provenance:leaf.provenance(root,['src/utils/moderation/normalize.ts','src/utils/moderation/spam_categories.ts'])},channel,key:harness().api.moderationSettingsCacheKey(channel),cases,patterns,lonePattern};
}
if(require.main===module) {
 const [mode,dir,...extra]=process.argv.slice(2);
 assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && extra.length===0);
 const real=fs.realpathSync(dir), workspace=fs.realpathSync(path.join(root,'..'));
 assert.equal(real,dir);assert(real!==workspace && !real.startsWith(workspace+path.sep));
 const filename='moderation-settings-store-reference.json';
 assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[filename]);
 replay(process.env.DIMA_SETTINGS_REPLAY_CHANNEL).then(result=>{
   const bytes=JSON.stringify(result,null,2)+'\n', file=path.join(real,filename);
   if(mode==='--write') fs.writeFileSync(file,bytes,{flag:'wx'});
   else assert.equal(fs.readFileSync(file,'utf8'),bytes);
   process.stdout.write(JSON.stringify({mode,sha256:sha(bytes),cases:result.cases.length,channel:result.channel})+'\n');
 }).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={reference,replay};
