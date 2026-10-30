'use strict';
// Actual complete TypeScript declarations and disconnected pinned Mongoose.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),checkout=path.dirname(root),req=createRequire(path.join(root,'package.json'));
const {resolveSource,overlaySource}=require('./model_schema_source.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
const ts=req('typescript'),mongoose=req('mongoose'),br=createRequire(req.resolve('mongoose')),bson=br('bson'),bsonEntry=br.resolve('bson'),bsonPackage=path.join(path.dirname(bsonEntry),'..','package.json');
assert.equal(ts.version,'5.9.3');assert.equal(mongoose.version,'8.24.2');assert.equal(JSON.parse(fs.readFileSync(bsonPackage)).version,'6.10.4');
assert.equal(sha(fs.readFileSync(req.resolve('typescript'))),'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');assert.equal(sha(fs.readFileSync(req.resolve('typescript/package.json'))),'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6');
const zone=process.env.TZ;assert(['UTC','America/New_York','Europe/Berlin','Australia/Lord_Howe','Pacific/Apia'].includes(zone));
const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&!extra.length);assert.equal(fs.realpathSync(dir),dir);assert(fs.lstatSync(dir).isDirectory());assert(dir!==checkout&&!dir.startsWith(checkout+path.sep));
const sources={
 'src/schemas/follow_attack_log.schema.ts':'418077f7dae3dbfbea4e800eb1444920de2c202828dbe97b87c3e074cea0b032',
 'src/schemas/follow_defense_action.schema.ts':'0b56200c8aa2ad0c29668c82da87354517774c2e523e448868daf4c7fafc9cf4',
 'src/schemas/follow_hate_raid_source.schema.ts':'8b2321fcf3eed917304bd3d2e03bf975b5351a3a37494cbe1e8ad54947c1215e'};
const instance=new mongoose.Mongoose();instance.set('autoCreate',false);instance.set('autoIndex',false);instance.now=()=>new Date(1900000000000);
const apis=[],astEvidence=[],resolvedSources={};
for(const [file,pin] of Object.entries(sources)){
 const resolved=resolveSource(root,file,pin);resolvedSources[file]=resolved;const source=resolved.bytes.toString('utf8');assert.equal(sha(source),pin);
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true);assert.deepEqual(tree.parseDiagnostics,[]);
 const imports=tree.statements.filter(ts.isImportDeclaration).map(x=>x.getText(tree));
 const types=tree.statements.filter(x=>ts.isInterfaceDeclaration(x)||ts.isTypeAliasDeclaration(x)).map(x=>({name:x.name.text,exported:!!x.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),text:x.getText(tree)}));
 const exports=tree.statements.filter(ts.isVariableStatement).filter(x=>x.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).flatMap(x=>x.declarationList.declarations.map(d=>d.name.getText(tree)));
 astEvidence.push({file,imports,types,exports});
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const out={};new vm.Script(`(function(exports,require){${compiled}\n})`,{filename:file}).runInThisContext()(out,id=>{assert.equal(id,'mongoose');return {Schema:instance.Schema,model:instance.model.bind(instance),Types:instance.Types}});apis.push(out);
}
// Compile the actual modules, including the inferred action type, with their
// pinned installed declarations. No application bootstrap is executed.
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,skipLibCheck:true,noEmit:true,types:[]};
const host=ts.createCompilerHost(compilerOptions);for(const source of Object.values(resolvedSources))overlaySource(host,ts,source);
const program=ts.createProgram(Object.keys(sources).map(f=>path.join(root,f)),compilerOptions,host);
const diagnostics=ts.getPreEmitDiagnostics(program);assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const checker=program.getTypeChecker();const typeEvidence=[];
for(const file of Object.keys(sources)){const sf=program.getSourceFile(path.join(root,file));assert(sf);for(const decl of sf.statements){if(!(ts.isInterfaceDeclaration(decl)||ts.isTypeAliasDeclaration(decl))||!decl.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))continue;const sym=checker.getSymbolAtLocation(decl.name),type=checker.getDeclaredTypeOfSymbol(sym);typeEvidence.push({name:decl.name.text,text:checker.typeToString(type,decl,ts.TypeFormatFlags.NoTruncation),properties:checker.getPropertiesOfType(type).map(p=>({name:p.name,optional:!!(p.flags&ts.SymbolFlags.Optional),type:checker.typeToString(checker.getTypeOfSymbolAtLocation(p,decl),decl,ts.TypeFormatFlags.NoTruncation)}))});}}
const models=[apis[0].FollowAttackLogSchema,apis[1].FollowDefenseActionSchema,apis[1].FollowDefenseControlSchema,apis[2].FollowHateRaidSourceSchema];
const metadata=models.map(m=>({model:m.modelName,collection:m.collection.name,versionKey:m.schema.options.versionKey,timestamps:!!m.schema.options.timestamps,writeConcern:m.schema.options.writeConcern??null,indexes:m.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique,ttl:options.expireAfterSeconds??null})),hidden:Object.keys(m.schema.paths).filter(k=>m.schema.path(k).options.select===false)}));
const oid=new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'),date='2024-03-10T01:30:00';
const valid=[{_id:oid,targetChannelID:'channel',modeTriggered:'attack',triggeredBy:'manual',trackedFollows:[{followerID:'user',followedAt:date,eventID:'event'}]},
 {_id:'action',channelID:'channel',eventID:'event',kind:'ban',mode:'attack',authorizedAt:date,nextAttemptAt:date,expiresAt:date,purgeAt:date},
 {_id:'channel'}, {_id:oid,targetChannelID:'channel',raiderChannelID:'raider',firstSeenAt:date,lastSeenAt:date,appliedLogIDs:[oid]}];
const inputs=[];for(let i=0;i<4;i++){inputs.push({model:i,input:valid[i]});inputs.push({model:i,input:{}});inputs.push({model:i,input:{...valid[i],unknown:'drop'}});}
inputs.push({model:0,input:{...valid[0],modeTriggered:'bad'}},{model:0,input:{...valid[0],raidInfo:{raiderChannelID:'r'},trackedFollows:[{followerID:'f',eventID:'e',followedAt:date,banStatus:null}]}},{model:1,input:{...valid[1],status:null}},{model:2,input:{...valid[2],ratePerSecond:'7'}},{model:3,input:{...valid[3],appliedLogIDs:null}});
for(const text of ['\ud800','\udc00','\ud800\udc00','\ud800X\udc00']) inputs.push({model:0,input:{...valid[0],targetChannelLogin:text}});
inputs.push(
 {model:0,input:{...valid[0],targetChannelID:null}},
 {model:0,input:{...valid[0],trackedFollows:[]}},
 {model:0,input:{...valid[0],totalFollows:'1.5',velocity:'-2',isRaid:'true'}},
 {model:0,input:{...valid[0],raidInfo:null}},
 {model:0,input:{...valid[0],trackedFollows:[{followerID:'f',eventID:'e',followedAt:'not-a-date'}]}},
 {model:1,input:{...valid[1],kind:'invalid'}},
 {model:1,input:{...valid[1],followedAt:null}},
 {model:1,input:{...valid[1],attempts:'1.5',auditPending:'false'}},
 {model:2,input:{...valid[2],ratePerSecond:null,leaseToken:null}},
 {model:3,input:{...valid[3],appliedLogIDs:[]}},
 {model:3,input:{...valid[3],appliedLogIDs:['bad-object-id']}},
 {model:3,input:{...valid[3],count:'2.5'}}
);
for(const time of ['2024-03-10T02:30:00','2024-11-03T01:30:00','2011-12-30T12:00:00','2024-10-06T02:15:00',0,1.5,-1]) inputs.push({model:1,input:{...valid[1],authorizedAt:time}});
inputs.push({model:0,input:{...valid[0],_id:'invalid-object-id'}},{model:1,input:{...valid[1],_id:42}});
inputs.push(
 {model:0,input:{...valid[0],trackedFollows:null}},
 {model:0,input:{...valid[0],trackedFollows:[null]}},
 {model:0,input:{...valid[0],trackedFollows:[42]}},
 {model:0,input:{...valid[0],raidInfo:42}},
 {model:3,input:{...valid[3],appliedLogIDs:[null]}},
 {model:3,input:{...valid[3],appliedLogIDs:42}}
);
// Field-by-field source matrix: each required path in missing/null/empty form,
// each optional field absent/null/present, and every date path through fixed,
// numeric, invalid and local/DST strings in the current process TZ.
inputs.forEach((item,i)=>{item.label=`baseline-${i}`});
function baseFor(model,field){const value=bson.deserialize(bson.serialize(valid[model]));if(field.startsWith('raidInfo.'))value.raidInfo={raiderChannelID:'raider'};return value}
function putPath(object,field,value){const parts=field.split('.');let cursor=object;for(const p of parts.slice(0,-1))cursor=cursor[p];const key=parts.at(-1);if(value===undefined)delete cursor[key];else cursor[key]=value}
const required=[
 [0,'targetChannelID'],[0,'modeTriggered'],[0,'triggeredBy'],[0,'trackedFollows.0.followerID'],[0,'trackedFollows.0.followedAt'],[0,'trackedFollows.0.eventID'],[0,'raidInfo.raiderChannelID'],
 [1,'_id'],[1,'channelID'],[1,'eventID'],[1,'kind'],[1,'mode'],[1,'authorizedAt'],[1,'status'],[1,'nextAttemptAt'],[1,'expiresAt'],[1,'purgeAt'],
 [2,'_id'],[3,'targetChannelID'],[3,'raiderChannelID'],[3,'firstSeenAt'],[3,'lastSeenAt']
];
for(const [model,field] of required)for(const [tag,value] of [['missing',undefined],['null',null],['empty','']]){const input=baseFor(model,field);putPath(input,field,value);inputs.push({label:`required-${model}-${field}-${tag}`,model,input})}
const optional=[[0,'raidInfo',{raiderChannelID:'r'}],[0,'trackedFollows.0.banStatus',4],[0,'trackedFollows.0.banMessage','ok'],[1,'followedAt','2024-01-02T03:04:05Z'],[1,'completedAt','2024-01-02T03:04:05Z'],[3,'appliedLogIDs',[oid]]];
for(const [model,field,present] of optional)for(const [tag,value] of [['missing',undefined],['null',null],['present',present]]){const input=baseFor(model,field);putPath(input,field,value);inputs.push({label:`optional-${model}-${field}-${tag}`,model,input})}
const dateFields=[[0,'trackedFollows.0.followedAt'],[0,'createdAt'],[0,'updatedAt'],[1,'authorizedAt'],[1,'followedAt'],[1,'nextAttemptAt'],[1,'lockedUntil'],[1,'completedAt'],[1,'expiresAt'],[1,'purgeAt'],[1,'createdAt'],[1,'updatedAt'],[2,'cancelledThrough'],[2,'pendingUntil'],[2,'nextAllowedAt'],[2,'lastServedAt'],[2,'lockedUntil'],[3,'firstSeenAt'],[3,'lastSeenAt'],[3,'createdAt'],[3,'updatedAt']];
const dateInputs=[['zero',0],['fraction',1.5],['negative',-1],['utc','2024-01-02T03:04:05.678Z'],['invalid','not-a-date'],['spring','2024-03-10T02:30:00'],['autumn','2024-11-03T01:30:00'],['apia','2011-12-30T12:00:00'],['lord-howe','2024-10-06T02:15:00']];
for(const [model,field] of dateFields)for(const [tag,value] of dateInputs){const input=baseFor(model,field);putPath(input,field,value);inputs.push({label:`date-${model}-${field}-${tag}`,model,input})}
const coverage={required:required.map(([model,field])=>`${model}:${field}`),optional:optional.map(([model,field])=>`${model}:${field}`),dates:dateFields.map(([model,field])=>`${model}:${field}`),dateTags:dateInputs.map(([tag])=>tag)};
function hex(value){return bson.serialize(value).toString('hex')}
const cases=inputs.map(({label,model,input})=>{const document=new models[model](input),error=document.validateSync();const errors=error?Object.keys(error.errors).sort():[];return {label,model,inputHex:hex(input),errors,errorDetails:errors.map(key=>({path:key,name:error.errors[key].name,kind:error.errors[key].kind})),outputHex:error?null:hex(document.toObject({versionKey:true}))}});
// Source-backed strict typed DTO wire: actual model defaults and fixed timestamp
// initialization; only generated persistence _id/version metadata is omitted
// for the two interfaces that do not declare it.
const typedCases=[0,1,3].map(model=>{const doc=new models[model](valid[model]);assert.equal(doc.validateSync(),undefined);doc.initializeTimestamps();const output=doc.toObject({versionKey:true});if(model!==1){delete output._id;delete output.__v}return {model,outputHex:hex(output)}});
const deps=['src/schemas/follow_attack_log.schema.rs','src/schemas/follow_defense_action.schema.rs','src/schemas/follow_hate_raid_source.schema.rs','src/schemas/follow_defense_schema_values.rs','src/schemas/ordinary_model_values.rs','src/schemas/schema.rs','src/utils/bson_compat.rs','src/utils/mongoose_date.rs','src/utils/js_string.rs','tests/follow_defense_schemas.rs','tests/support/model_schema_source.rs','tests/fixtures/model_schema_source.cjs','tests/fixtures/follow_defense_schemas_reference.cjs','tests/support/sha256.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const output=JSON.stringify({schema:1,nodeSha,zone,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version,mongoose:mongoose.version,bson:'6.10.4'},sourceHashes:sources,sourceProvenance:Object.fromEntries(Object.entries(resolvedSources).map(([k,v])=>[k,v.provenance])),hashes:Object.fromEntries(deps.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))])),sdkHashes:{typescript:sha(fs.readFileSync(req.resolve('typescript'))),typescriptPackage:sha(fs.readFileSync(req.resolve('typescript/package.json'))),mongoose:sha(fs.readFileSync(req.resolve('mongoose'))),mongoosePackage:sha(fs.readFileSync(req.resolve('mongoose/package.json'))),bson:sha(fs.readFileSync(bsonEntry)),bsonPackage:sha(fs.readFileSync(bsonPackage))},astEvidence,typeEvidence,metadata,coverage,typedCases,caseCount:cases.length,cases},null,2)+'\n';
const target=path.join(dir,`follow-defense-schemas-${zone.replaceAll('/','_')}.json`);if(mode==='--write'){assert.equal(fs.readdirSync(dir).length,0);fs.writeFileSync(target,output,{flag:'wx'})}else assert.equal(fs.readFileSync(target,'utf8'),output);
