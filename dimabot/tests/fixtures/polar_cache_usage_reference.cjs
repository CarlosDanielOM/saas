'use strict';
// Author-only fixture. The parent runs this using the pinned isolated toolchain.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), vm=require('node:vm'), assert=require('node:assert/strict'), ts=require('typescript');
assert.equal(process.version,'v24.22.1'); assert.equal(process.versions.v8,'13.6.233.17-node.58'); assert.equal(ts.version,'5.9.3');
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && !extra.length);
assert(fs.statSync(dir).isDirectory());
const namespace=process.env.KEYWORD_FIXTURE_NAMESPACE;
assert.match(namespace??'',/^keyword-fixture-[a-f0-9]{12}:$/);
const root=path.resolve(__dirname,'../..');
const file='src/utils/polarsh.ts', source=fs.readFileSync(path.join(root,file),'utf8');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const runtimeHashes={node:hash(fs.readFileSync(process.execPath)),typescript:hash(fs.readFileSync(require.resolve('typescript'))),typescriptPackage:hash(fs.readFileSync(require.resolve('typescript/package.json')))};
assert.equal(runtimeHashes.node,'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
assert.equal(runtimeHashes.typescript,'3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
assert.equal(runtimeHashes.typescriptPackage,'822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6');
const artifactDir=fs.realpathSync(dir),repoDir=fs.realpathSync(root);
assert(artifactDir!==repoDir&&!artifactDir.startsWith(repoDir+path.sep));
assert.deepEqual(fs.readdirSync(artifactDir),mode==='--write'?[]:['polar-cache-usage.json']);

assert.equal(hash(source),'5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec');
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['INGEST_LOCK_PREFIX','INGEST_LOCK_TTL_MS','INGEST_LOCK_MAX_WAIT_MS','INGEST_LOCK_RETRY_MS','sleep','trackAcceptedUsage','projectAcceptedUsage','acquireIngestLock','releaseIngestLock','migrateLegacyQueueIfNeeded','queueEvent','ingestPolarSHEvent'];
const declarations=names.map(name=>{
 const matches=ast.statements.filter(n=>n.name?.text===name || ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 assert.equal(matches.length,1,name); const n=matches[0]; return {name,kind:ts.SyntaxKind[n.kind],text:n.getText(ast),sha256:hash(n.getText(ast))};
});
const types=['LLMMetadata','IngestPolarSHEventOptions','IngestPolarSHEventResponse','AccountingMetadata','EventData'].map(name=>{
 const n=ast.statements.find(n=>n.name?.text===name); assert(n&&ts.isInterfaceDeclaration(n));
 return {name,text:n.getText(ast),members:n.members.map(m=>({name:m.name.getText(ast),type:m.type?.getText(ast),optional:!!m.questionToken})),sha256:hash(n.getText(ast))};
});
const receiptSource=require('./ai_usage_producer_source.cjs').loadSource('vm');
const calls=[]; let state,now=1793232000123;
const reset=spec=>{calls.length=0; now=1793232000123; state={kind:spec.legacy===undefined?'none':'string',value:spec.legacy,list:[],lock:spec.contended?'other':null};};
const cache={
 set:async(k,v,o)=>{calls.push(['set',k,v,o]); if(state.lock)return null;state.lock=v;return 'OK';},
 get:async(k)=>{calls.push(['get',k]);if(k.startsWith('locks:')&&state.changeOwner)state.lock='new-owner';return k.startsWith('locks:')?state.lock:state.value;},
 del:async(k)=>{calls.push(['del',k]); if(k.startsWith('locks:'))state.lock=null;else {state.kind='none';state.value=null;}return 1;},
 type:async(k)=>{calls.push(['type',k]);return state.kind;},
 rPush:async(k,v)=>{calls.push(['rPush',k,v]);if(k==='cron:ai-usage-receipts:queue'){if(state.failReceipt)throw Error('fixture-receipt-failure');return 1;}if(state.failPush)throw Error('fixture-rpush-failure');state.kind='list';state.list.push(...(Array.isArray(v)?v:[v]));return state.list.length;},
};
class FixtureDate extends Date { constructor(...args){super(...(args.length?args:[1793232000123]));} static now(){return now;} }
const randomUUID=()=> 'fixture-lock-uuid';
const mocked={
 './databases/dragonfly.database.js':{getDragonflyClient:async()=>cache},
 './billing.js':{recordAiCreditUsage:async(...args)=>{calls.push(['project',...args.slice(0,3)]); if(state.failProjection)calls.push(['projection-error','fixture-projection-failure']);}},
 './logger.js':{error:async(...args)=>{calls.push(['error',...args]);},info:()=>{}},
 './posthog_events.js':{trackAiUsageRecorded:(arg)=>{calls.push(['track',arg]);if(state.failTracking)throw Error('fixture-track-failure');}},
 './ai_usage_ledger.js':{buildQueuedAiUsageReceipt:receiptSource.producer.buildQueuedAiUsageReceipt,enqueueAiUsageReceipt:receiptSource.producer.enqueueAiUsageReceipt},
 './ai_usage_event.js':receiptSource.event,
 'node:crypto':{randomUUID}, '@polar-sh/sdk':{Polar:class {constructor(){throw Error('Polar HTTP forbidden in cache fixture');}}},
};
const imports=ast.statements.filter(ts.isImportDeclaration).map(n=>n.getText(ast));
const extracted=imports.concat(declarations.map(d=>d.text)).join('\n');
const js=ts.transpileModule(extracted,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
vm.runInNewContext(js,{module:mod,exports:mod.exports,require:n=>{assert(mocked[n],`unexpected import ${n}`);return mocked[n];},Date:FixtureDate,setTimeout:f=>{now+=350;f();}}, {filename:file,timeout:10000});
const base={customerId:'customer',channelID:namespace+'channel',externalId:'moderation:decision',cost:0.000123456789,reason:'contextual_moderation',mode:'cache',llm:{model:'openai/model:variant',usage:{prompt_tokens:123,completion_tokens:0,total_tokens:123}},usage:{requestId:'decision',operation:'contextual_moderation',category:'other',source:'moderation',provider:'openrouter',resourceType:'llm_generation',resourceId:'message'}};
const cases=[
 {id:'semantic',options:base},
 {id:'missing-customer',options:{...base,customerId:''}},
 {id:'missing-channel',options:{...base,channelID:''}},
 ...[0,0.000000000001,0.000123456789,1.23456789012345,-0.000123456789,1e20].map((cost,i)=>({id:`cost-${i}`,options:{...base,cost}})),
 ...['','vendor','/model:extra','vendor/model/other:foo'].map((model,i)=>({id:`model-${i}`,options:{...base,llm:{...base.llm,model}}})),
 {id:'plain',options:{...base,llm:undefined}},
 {id:'audio',options:{...base,llm:undefined,_cost:0.25,characters:7}},
 {id:'context-override',options:{...base,usage:{...base.usage,entryId:'ignored',channelID:' alternate ',model:' custom ',quantity:0,unit:'minutes'}}},
 {id:'id-fallback',options:{...base,externalId:'',usage:{...base.usage,entryId:'  own-id  ',requestId:''}}},
 {id:'id-trimming',options:{...base,externalId:'  moderation:trimmed  ',usage:{...base.usage,channelID:'   ',model:'   '}}},
 {id:'utf16',options:{...base,customerId:'c\ud800',externalId:'id\udfff',reason:'r\ud800',llm:{...base.llm,model:'vendor/m\ud800:tag'},usage:{...base.usage,requestId:'request\ud800',resourceId:'message\udfff'}}},
 {id:'legacy',options:base,legacy:'[{"old":1},"x",null]'},
 {id:'legacy-malformed',options:base,legacy:'['},
 {id:'legacy-null',options:base,legacy:'null'},
 {id:'legacy-string',options:base,legacy:'"abc"'},
 {id:'legacy-arraylike-string',options:base,legacy:'{"length":"2"}'},
 {id:'legacy-arraylike-zero',options:base,legacy:'{"length":0}'},
 {id:'legacy-push-failure',options:base,legacy:'[{"old":1}]',failPush:true},
 {id:'contended',options:base,contended:true},
 {id:'changed-lock-owner',options:base,changeOwner:true},
 {id:'projection-failure',options:base,failProjection:true},
 {id:'receipt-failure',options:base,failReceipt:true},
 {id:'track-failure',options:base,failTracking:true},
 {id:'queue-failure',options:base,failPush:true},
];
(async()=>{
 const outputs=[];
 for(const spec of cases){reset(spec);Object.assign(state,{failPush:spec.failPush,failReceipt:spec.failReceipt,failTracking:spec.failTracking,failProjection:spec.failProjection,changeOwner:spec.changeOwner});const result=await mod.exports.ingestPolarSHEvent(spec.options);outputs.push({id:spec.id,input:spec.options,legacy:spec.legacy??null,contended:!!spec.contended,result,calls:JSON.parse(JSON.stringify(calls)),list:state.list,finalLock:state.lock});}
 const byId=id=>outputs.find(c=>c.id===id);
 assert.equal(byId('contended').result.message,'queued (flush in progress)');
 assert.equal(byId('changed-lock-owner').finalLock,'new-owner');
 assert(!byId('changed-lock-owner').calls.some(c=>c[0]==='del' && c[1].startsWith('locks:')));
 for(const id of ['semantic','contended','receipt-failure','projection-failure','track-failure']) {
   const c=byId(id).calls, queue=c.findIndex(x=>x[0]==='rPush'&&x[1].endsWith(':ai:polarshevent'));
   const projection=c.findIndex(x=>x[0]==='project'), receipt=c.findIndex(x=>x[0]==='rPush'&&x[1]==='cron:ai-usage-receipts:queue'), track=c.findIndex(x=>x[0]==='track');
   assert(queue>=0 && queue<projection && projection<receipt && receipt<track,id);
 }
 assert.equal(byId('queue-failure').calls.filter(c=>c[0]==='rPush'&&c[1].endsWith(':ai:polarshevent')).length,1);
 assert(!byId('queue-failure').calls.some(c=>c[0]==='project'));
 const payload=JSON.stringify({version:1,namespace,node:process.version,v8:process.versions.v8,typescript:ts.version,sourceHash:hash(source),declarations,types,runtimeHashes,dependencyHashes:Object.fromEntries(['src/utils/ai_usage_event.ts','src/utils/ai_usage_classification.ts','src/utils/ai_usage_ledger.ts','tests/fixtures/ai_usage_producer_source.cjs','tests/fixtures/polar_cache_usage_reference.cjs','package.json','package-lock.json','Cargo.toml','Cargo.lock'].map(name=>[name,hash(fs.readFileSync(path.join(root,name)))])),cases:outputs},null,2)+'\n';
 const out=path.join(dir,'polar-cache-usage.json');
 if(mode==='--write')fs.writeFileSync(out,payload,{flag:'wx'});else assert.equal(fs.readFileSync(out,'utf8'),payload);
})().catch(e=>{console.error(e);process.exitCode=1;});
