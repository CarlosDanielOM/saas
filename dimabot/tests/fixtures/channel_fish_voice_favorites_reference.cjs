// Actual source with controlled Mongoose and settings boundaries. No live resources.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript'),mongoose=require('mongoose');
const {pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const {resolveSource}=require('./schema_source_resolver.cjs');
const mongoRequire=createRequire(require.resolve('mongoose'));
const mongo=mongoRequire('mongodb'), bson=mongo.BSON;
const mongoEntry=mongoRequire.resolve('mongodb'),bsonEntry=createRequire(mongoEntry).resolve('bson');
const mongoPackage=path.join(path.dirname(mongoEntry),'..','package.json'),bsonPackage=path.join(path.dirname(bsonEntry),'..','package.json');
const mongoVersion=JSON.parse(fs.readFileSync(mongoPackage)).version,bsonVersion=JSON.parse(fs.readFileSync(bsonPackage)).version;
if(mongoVersion!=='6.20.0'||bsonVersion!=='6.10.4')throw Error('wrong MongoDB/BSON toolchain');
const root=path.resolve(__dirname,'../..'), sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version};
const nodeSha=sha(process.execPath);
if(mongoose.version!=='8.24.2')throw Error('wrong Mongoose');
if(JSON.stringify(versions)!==JSON.stringify({node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0',typescript:'5.9.3'})||nodeSha!=='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108')throw Error('toolchain mismatch');
const files=['src/schemas/channel_fish_voice_favorites.schema.ts','src/schemas/channel_fish_voice_favorites.schema.test.ts','src/schemas/channel_tts_settings.schema.ts','src/server/services/tts/fish_tts.service.ts','src/schemas/channel_fish_voice_favorites.schema.rs','src/schemas/channel_tts_settings.schema.rs','src/schemas/schema.rs','src/server/services/tts/fish_tts.rs','src/utils/js_string.rs','src/utils/js_compat.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/lossless_json.rs','tests/channel_fish_voice_favorites.rs','tests/support/schema_source.rs','tests/fixtures/schema_source_resolver.cjs','tests/fixtures/channel_fish_voice_favorites_reference.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const settingsLogical='src/schemas/channel_tts_settings.schema.ts';
const archivedLogicals=new Set([files[0],files[1],settingsLogical]);
const archived=Object.fromEntries([...archivedLogicals].map(f=>[f,resolveSource(root,f)]));
const resolved=Object.fromEntries(files.map(f=>[f,archived[f]?.path??path.join(root,f)]));
const sourcePaths=Object.fromEntries(files.map(f=>[f,path.relative(root,resolved[f])]));
const source=fs.readFileSync(resolved[files[0]],'utf8');
const sourceAst=ts.createSourceFile('favorites.ts',source,ts.ScriptTarget.Latest,true);
const errorClass=sourceAst.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='FavoriteAliasError');
if(!errorClass)throw Error('missing FavoriteAliasError');
const errorCtor=errorClass.members.find(ts.isConstructorDeclaration);
const errorClassDeclaration={name:errorClass.name.text,base:errorClass.heritageClauses[0].types[0].getText(sourceAst),parameters:errorCtor.parameters.map(p=>({name:p.name.getText(sourceAst),type:p.type.getText(sourceAst),public:!!p.modifiers?.some(m=>m.kind===ts.SyntaxKind.PublicKeyword)}))};
const typeDeclarations=sourceAst.statements.filter(ts.isInterfaceDeclaration).map(s=>({name:s.name.text,exported:!!s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),fields:s.members.map(m=>({name:m.name.getText(sourceAst),type:m.type.getText(sourceAst)}))}));
const fish=fs.readFileSync(path.join(root,files[3]),'utf8');
const fishAst=ts.createSourceFile('fish.ts',fish,ts.ScriptTarget.Latest,true);
const fishDecl=fishAst.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(fishAst)==='FISH_VOICES'));
if(!fishDecl)throw Error('missing fish constants');
const fishJs=ts.transpileModule(fishDecl.getText(fishAst),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const fishExports={}; vm.runInNewContext(fishJs,{exports:fishExports});
let current=null,calls=[],forceMiss=false,settings=[],renameMiss=null;
const model={
 findOne(filter){calls.push(['findOne',filter]);return {lean:async()=>current?structuredClone(current):null}},
 async updateOne(filter,change,options){calls.push(['updateOne',filter,change,options??null]);if(change.$setOnInsert&&!current)current={...structuredClone(change.$setOnInsert)};if(change.$pull&&current)current.favorites=current.favorites.filter(v=>v.id!==change.$pull.favorites.id)},
 findOneAndUpdate(filter,change,options){calls.push(['findOneAndUpdate',filter,change,options]);const action=()=>{if(forceMiss||!current)return null;if(renameMiss&&!change.$push){const mode=renameMiss;renameMiss=null;if(mode==='remove')current.favorites=[];if(mode==='same')current.favorites[0].alias=change.$set['favorites.$[target].alias'];return null}if(change.$push){let f=change.$push.favorites;if(current.favorites.some(v=>v.id===f.id||v.alias===f.alias)||current.favorites.length>=20)return null;current.favorites.push(structuredClone(f));return structuredClone(current)}let target=current.favorites.find(v=>v.id===filter['favorites.id']);if(!target||current.favorites.some(v=>v.alias===filter['favorites.alias'].$ne))return null;target.alias=change.$set['favorites.$[target].alias'];return structuredClone(current)};const promise=Promise.resolve().then(action);promise.lean=()=>promise;return promise;}
};
const settingsModel={async updateOne(...args){settings.push(args)}};
class Schema {constructor(...args){this.args=args}}
const exportsObj={};
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
vm.runInNewContext(code,{exports:exportsObj,require(id){if(id==='mongoose')return {Schema,model:()=>model};if(id.includes('fish_tts'))return fishExports;if(id.includes('channel_tts_settings'))return {ChannelTtsSettingsSchema:settingsModel};throw Error(id)},Object,Error,String,Set});
const api=exportsObj;
const inputs=[null,3,'',' Bill ','bill cypher','_bill','a'.repeat(41),'gojo','RIAS_GREMORY','\ufeffABC\u2028','İ','\ud800','K','Ａ','😀','\u0085bill','bill\u0085',' \u0085Bill\u00a0','\u0085'];
function capture(fn){try{return {value:fn()}}catch(e){return {error:{status:e.status,code:e.code,message:e.message}}}}
async function scenario(name,fn){current=null;calls=[];settings=[];forceMiss=false;renameMiss=null;let result;try{result={value:await fn()}}catch(e){result={error:{status:e.status??null,code:e.code??null,message:e.message}}}return {name,result,calls,settings,stored:current}}
async function main(){
 // Real disconnected models prove schema metadata, casting and timestamp middleware.
 // Boundary stubs replace only database collection I/O and unrelated imports.
 const loader=await import(pathToFileURL(path.join(root,'tests/fixtures/channel_tts_settings_reference.mjs')).href);
 const settingsSource=await loader.loadSource();
 if(settingsSource.sourcePaths[settingsLogical]!==sourcePaths[settingsLogical]||settingsSource.hashes[settingsLogical]!==sha(resolved[settingsLogical]))throw Error('settings source mismatch');
 const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);
 const realExports={};
 vm.runInNewContext(code,{exports:realExports,require(id){if(id==='mongoose')return {Schema:instance.Schema,model:instance.model.bind(instance)};if(id.includes('fish_tts'))return fishExports;if(id.includes('channel_tts_settings'))return settingsSource.api;throw Error(id)},Object,Error,String,Set});
 const realModel=realExports.ChannelFishVoiceFavoritesSchema, favoritePath=realModel.schema.path('favorites');
 const metadata={model:realModel.modelName,collection:realModel.collection.name,versionKey:realModel.schema.options.versionKey,timestamps:!!realModel.schema.options.timestamps,indexes:realModel.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique})),subdocumentId:favoritePath.schema.options._id,paths:Object.fromEntries(['channelID','favorites'].map(k=>[k,realModel.schema.path(k).instance])),favoritePaths:Object.fromEntries(['id','name','alias'].map(k=>[k,favoritePath.schema.path(k).instance]))};
 const schemaInputs=[{channelID:'channel'},{channelID:42,favorites:[{id:123,name:456,alias:789}]},{channelID:'channel',favorites:[{id:'x',name:'Voice',alias:'voice',extra:'ignored'}]}];
 const schemaCases=schemaInputs.map(input=>{const doc=new realModel({...input,_id:'507f1f77bcf86cd799439011'});const error=doc.validateSync();const output=doc.toObject();delete output._id;return {input,output,error:error?Object.keys(error.errors).sort():null}});
 const clock=1900000000000;settingsSource.instance.now=()=>new Date(clock);
 const settingsWrites=[];settingsSource.api.ChannelTtsSettingsSchema.collection.updateOne=async(filter,update,options)=>{settingsWrites.push({filter,update,options});return {acknowledged:true,matchedCount:1,modifiedCount:1}};
 realModel.findOne=()=>({lean:async()=>({favorites:[{id:'id',name:'Name',alias:'old'}]})});
 realModel.findOneAndUpdate=()=>({lean:async()=>({favorites:[{id:'id',name:'Name',alias:'new'}]})});
 await realExports.renameFishVoiceFavorite('channel','id','new');
 const settingsMiddleware={clock,operations:settingsWrites};
 const [mode,dir,...rest]=process.argv.slice(2);if(!['--write','--check'].includes(mode)||!dir||rest.length||fs.realpathSync(dir)!==path.resolve(dir)||dir===path.dirname(root)||dir.startsWith(path.dirname(root)+path.sep))throw Error('external canonical dir required');
 const cases=[];
 cases.push(await scenario('get_missing',()=>api.getFishVoiceFavorites('channel')));
 cases.push(await scenario('add',()=>api.addFishVoiceFavorite('channel','id','Café Voice')));
 cases.push(await scenario('existing',async()=>{await api.addFishVoiceFavorite('channel','id','Name');return api.addFishVoiceFavorite('channel','id','ignored')}));
 cases.push(await scenario('remove',async()=>{await api.addFishVoiceFavorite('channel','id','Name');await api.removeFishVoiceFavorite('channel','id');return api.getFishVoiceFavorites('channel')}));
 cases.push(await scenario('rename',async()=>{await api.addFishVoiceFavorite('channel','id','Name');return api.renameFishVoiceFavorite('channel','id',' New ')}));
 cases.push(await scenario('rename_missing',()=>api.renameFishVoiceFavorite('channel','id','new')));
 cases.push(await scenario('rename_taken',async()=>{await api.addFishVoiceFavorite('channel','id','Name');await api.addFishVoiceFavorite('channel','other','Other');return api.renameFishVoiceFavorite('channel','id','other')}));
 for(const mode of ['remove','same','conflict'])cases.push(await scenario('rename_fallthrough_'+mode,async()=>{await api.addFishVoiceFavorite('channel','id','Name');renameMiss=mode;return api.renameFishVoiceFavorite('channel','id','new')}));
 cases.push(await scenario('full',async()=>{for(let i=0;i<20;i++)await api.addFishVoiceFavorite('channel',String(i),'Name');return api.addFishVoiceFavorite('channel','extra','Name')}));
 cases.push(await scenario('conflict',async()=>{forceMiss=true;return api.addFishVoiceFavorite('channel','id','Name')}));
 const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
 const statuses=[0,-0,400,-2.5,1.25,1e300,NaN,Infinity,-Infinity];
 const errorCases=statuses.map((status,i)=>{
  const code=['plain','café','\ud800','\udc00','😀','x\ud800\udc00y','\ud800X\udc00','', 'error'][i];
  const message=['normal','é','\udc00','\ud800','😀','\ud800\udc00','\ud800A\udc00','','message'][i];
  const e=new api.FavoriteAliasError(status,code,message); const bits=Buffer.allocUnsafe(8);bits.writeDoubleBE(status);
  return {statusBits:bits.toString('hex'),codeUnits:units(e.code),messageUnits:units(e.message),name:e.name,isError:e instanceof Error,isFavorite:e instanceof api.FavoriteAliasError,wire:JSON.stringify({status:e.status,code:e.code,message:e.message,name:e.name})};
 });
 const bsonInputs=['plain','é😀','\ud800','\udc00','x\ud800\udc00y','x\ud800A\udc00y','\ud800\ud800\udc00','\udc00\ud800'];
 const bsonCases=bsonInputs.map(value=>{const input={channelID:value,id:value,name:value};const encoded=bson.serialize(input);const output=bson.deserialize(encoded);return {units:units(value),hex:encoded.toString('hex'),output:{channelID:units(output.channelID),id:units(output.id),name:units(output.name)}}});
 const aliases=['Café Voice','Gojo','  ','ＡＢＣ','a'.repeat(45),'a\ud800b','İstanbul','Ångström','Kelvin','ﬃ','😀Voice','a\u1ab0b','a\u0301b','a\udc00b','\u{1e030}','a'.repeat(40)].map(name=>({units:units(name),used:['cafe_voice','a'.repeat(40)],alias:api.makeFavoriteAlias(name,['cafe_voice','a'.repeat(40)])}));
 const output=JSON.stringify({schema:1,versions,nodeSha,hashes:Object.fromEntries(files.map(f=>[f,sha(resolved[f])])),sourcePaths,sharedNfkd:{implementation:'src/utils/js_unicode.rs',data:'src/utils/js_unicode_data.rs',test:'tests/js_unicode_nfkd.rs',oracle:'tests/fixtures/js_unicode_nfkd_reference.cjs',hashes:Object.fromEntries(['src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','tests/js_unicode_nfkd.rs','tests/fixtures/js_unicode_nfkd_reference.cjs'].map(f=>[f,sha(path.join(root,f))]))},mongoose:mongoose.version,sdkHashes:{typescript:sha(require.resolve('typescript')),mongoose:sha(require.resolve('mongoose')),settingsReference:sha(path.join(root,'tests/fixtures/channel_tts_settings_reference.mjs'))},metadata,schemaCases,settingsMiddleware,errorClassDeclaration,errorCases,bsonCases,mongoBson:{mongodbVersion:mongoVersion,bsonVersion, mongodbEntry:sha(mongoEntry),bsonEntry:sha(bsonEntry),mongodbPackage:sha(mongoPackage),bsonPackage:sha(bsonPackage)},exports:Object.keys(api).sort(),typeDeclarations,max:api.MAX_FISH_VOICE_FAVORITES,fish:fishExports.FISH_VOICES,normalization:inputs.map(input=>({input:typeof input==='string'?{units:units(input)}:input,...capture(()=>api.normalizeFavoriteAlias(input))})),aliases,cases},null,2)+'\n';
 const target=path.join(dir,'channel_fish_voice_favorites.json');if(mode==='--write'){if(fs.readdirSync(dir).length)throw Error('empty directory required');fs.writeFileSync(target,output,{flag:'wx'})}else if(fs.readFileSync(target,'utf8')!==output)throw Error('oracle mismatch');
}
main().catch(e=>{console.error(e);process.exitCode=1});
