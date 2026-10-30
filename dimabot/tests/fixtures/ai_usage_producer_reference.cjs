'use strict';
const {sourcePath: fixturePath, resolveSource} = require('./ai_usage_source_resolver.cjs');
// AUTHOR ONLY here: parent executes in its pinned isolated Node toolchain.
// --write DIR requires an EXISTING parent-owned directory, and uses exclusive
// creation. --check DIR is read-only and compares every byte, provenance included.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
assert.equal(process.version, 'v24.22.1', 'strict Node pin');
assert.equal(process.versions.v8, '13.6.233.17-node.58', 'strict V8 pin');
assert.equal(ts.version, '5.9.3', 'strict TS pin');
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && dir && !extra.length, 'usage: --write DIR | --check DIR');
assert(fs.statSync(dir).isDirectory(), 'parent must create and own fixture directory');
const namespace = process.env.DIMA_AI_USAGE_PRODUCER_NAMESPACE;
assert.match(namespace ?? '', /^producer-fixture-[A-Za-z0-9]{8,32}:$/, 'unique task-owned namespace required');
const {loadSource}=require('./ai_usage_producer_source.cjs');
const source=loadSource('vm');
const {root,sha,ledgerFile,extracted,evidence,types,imports,sourceModules,observedImports,producer,classification,event,fixedNow}=source;
const bits = n => { const b=Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };
const unbits = hex => { assert.match(hex,/^[a-f0-9]{16}$/); return Buffer.from(hex,'hex').readDoubleBE(); };
const base = {schemaVersion:1,pricingVersion:'legacy-polar-math-v1',entryId:'entry',requestId:'request',entryKind:'usage',category:'tts',operation:'synthesize',source:'tts_queue',provider:'fish'};
const specs=[];
const add=(id,patch={},options={})=>{
  const context={...base,...patch};
  const input={channelID:options.channelID ?? 'channel', customerId:options.customerId ?? 'customer',contextJson:JSON.stringify(context),creditsBits:bits(options.credits ?? 1.25),occurredAt:{present:!options.absentDate,bits:bits(options.date ?? 0)}};
  if (Object.hasOwn(context,'quantity') && typeof context.quantity==='number') input.quantityBits=bits(context.quantity);
  if (options.undefinedKeys) input.undefinedKeys=options.undefinedKeys;
  if (options.deleteKeys) { for(const k of options.deleteKeys) delete context[k]; input.contextJson=JSON.stringify(context); }
  if (options.nativeContext) input.nativeContext=options.nativeContext;
  specs.push({id,input});
};
for(const category of ['tts','ai_chat','ai_agent','memory','clip_recommendation','credit_adjustment','other','uncategorized']) add(`category:${category}`,{category});
for(const category of ['', 'TTS',' unknown ','💠','\ud800',null,0,false,[],{}]) add(`category:unknown:${specs.length}`,{category});
for(const adjustmentType of classification.ADJUSTMENT_TYPES) {
  add(`explicit:${adjustmentType}`,{entryKind:'adjustment',adjustmentType,source:'polar_meter_credit',operation:'monthly_reset'});
  add(`usage-explicit:${adjustmentType}`,{adjustmentType,operation:'refund'});
}
// All source/operation branches, both reset source spellings, and precedence
// collisions in each direction. Expected classification comes ONLY from TS.
const sources=['polar_meter_credit','free_credit_reset','free_credit_reset_worker','admin_credit_grant','credit_pack_purchase','activation','unknown','\ud800activation','activation\udc00'];
const operations=['monthly_reset','purchase_pack','refund','correction','grant','\ud800refund'];
for(const source of sources) for(const operation of operations) add(`policy:${source}:${operation}`,{entryKind:'adjustment',source,operation});
for(const reason of ['Free benefits',' Free benefits ','','\ud800']) add(`reason:${specs.length}`,{entryKind:'adjustment',reason});
for(const adjustmentType of ['',null,[],['refund'],{},42,'REFUND','\ud800refund']) add(`invalid-explicit:${specs.length}`,{entryKind:'adjustment',adjustmentType,operation:'correction'});
for(const credits of [0,-0,-1,-0.125,0.1,1/3,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,Number.MAX_SAFE_INTEGER,1e-7,1e21,NaN,Infinity,-Infinity]) add(`credits:${bits(credits)}`,{}, {credits});
for(const date of [0,-0,-0.99,0.99,-1.99,1.99,8640000000000000,-8640000000000000,8640000000000001,-8640000000000001,NaN,Infinity,-Infinity,-62167219200000,-62198755200000,253402300800000]) add(`date:${bits(date)}`,{}, {date});
add('date:absent',{}, {absentDate:true});
for(const channelID of ['', ' ', '\t\n', 'é😀\u0000"\\','\ud800c','c\udc00']) add(`channel:${specs.length}`,{}, {channelID});
for(const customerId of ['', ' ', '\t\n', 'é😀\u0000"\\','\ud800u','u\udc00']) add(`customer:${specs.length}`,{}, {customerId});
const optional=['requestId','parentRequestId','channelID','model','quantity','unit','resourceType','resourceId'];
for(const key of optional) {
  add(`optional:${key}:missing`,{}, {deleteKeys:[key]});
  add(`optional:${key}:undefined`,{}, {undefinedKeys:[key]});
  add(`optional:${key}:null`,{[key]:null});
  if(key==='quantity') for(const v of [0,-0,NaN,Infinity,-Infinity,0.125,-2]) add(`optional:quantity:${bits(v)}`,{quantity:v});
  else for(const v of ['', ' ', 'é😀','\ud800x','x\udc00']) add(`optional:${key}:${specs.length}`,{[key]:v});
}
for(const unit of ['characters','tokens','minutes']) add(`unit:valid:${unit}`,{unit});
for(const resourceType of ['speech','voice_preview','llm_generation','vod_analysis']) add(`resource:valid:${resourceType}`,{resourceType});
for(const key of ['entryId','requestId','operation','source','provider','model','resourceId']) {
  for(const v of ['',' \t\n ','é😀漢字\u2028\u2029','\ud800','\udc00','\ud800head','tail\udfff','\ud800\ud800','\ud83d\ude00']) add(`string:${key}:${specs.length}`,{[key]:v});
}
for(const key of ['entryId','entryKind','operation','source','provider']) {
  add(`own:${key}:undefined`,{}, {undefinedKeys:[key]});
  add(`own:${key}:null`,{[key]:null});
  add(`own:${key}:missing`,{}, {deleteKeys:[key]});
}
// Actual event utility contexts are also replayed through Rust's direct typed
// builder. Supply explicit IDs so the crypto UUID import need not be stubbed or
// random output frozen. NaN is additionally put on a publicly mutable context.
for(const reason of ['tts_fish','tts_kokoro','tts_piper','messages','harness_tools','harness_end','planner','coding_agent','stream_summary','weekly_summary','monthly_summary','vod_clip_recommendation','Free benefits','',' Odd ']) {
  const input={entryId:`aiu_native_${specs.length}`,requestId:'request',quantity:0,model:' model ',resourceType:'speech',unit:'characters',resourceId:' resource '};
  const c=event.createAiUsageContext(reason,input);
  add(`native:${reason}`,c,{nativeContext:{reason,input}});
}
for(const unit of ['characters','tokens','minutes']) for(const resourceType of ['speech','voice_preview','llm_generation','vod_analysis']) {
  const input={entryId:`aiu_native_enum_${specs.length}`,requestId:'',parentRequestId:' parent ',channelID:' channel ',unit,resourceType,quantity:-0,model:'',resourceId:''};
  add(`native:enum:${unit}:${resourceType}`,event.createAiUsageContext('messages',input),{nativeContext:{reason:'messages',input}});
}
add('native:direct-nan',{...base,quantity:NaN,model:'',resourceId:''},{nativeContext:{direct:true}});
add('all-missing',{}, {deleteKeys:Object.keys(base)});

for(const role of ['wire','utf16','concurrent-a','concurrent-b','error','cancel','disconnect','system','null']) {
  const patch={entryId:`${namespace}${role}`,requestId:'request',model:role==='utf16'?'\ud800😀\udc00':'é😀',quantity:role==='utf16'?NaN:0,resourceId:''};
  add(`integration:${role}`,patch,{credits:role==='null'?Infinity:0.125});
  specs.at(-1).integrationRole=role;
}

async function main() {
  const cases=[];
  let assertions=0;
  for(const spec of specs) {
    const {input}=spec;
    const context=JSON.parse(input.contextJson);
    if(input.quantityBits) context.quantity=unbits(input.quantityBits);
    for(const key of input.undefinedKeys ?? []) context[key]=undefined;
    const args={channelID:input.channelID,customerId:input.customerId,context,credits:unbits(input.creditsBits)};
    if(input.occurredAt.present) args.occurredAt=new Date(unbits(input.occurredAt.bits));
    source.resetClock();
    const receipt=producer.buildQueuedAiUsageReceipt(args);
    const builderClockCalls=source.readClock();
    const receiptWire=JSON.stringify(receipt);
    const numericBits=receipt===null?null:{credits:bits(receipt.credits),quantity:typeof receipt.quantity==='number'?bits(receipt.quantity):null};
    const runs=[];
    for(const fail of [false,true]) {
      source.resetClock();
      const calls=[];
      const sentinel=new Error('fixture-rpush-failure');
      const cache={rPush:async(key,wire)=>{ calls.push({key,wire}); if(fail) throw sentinel; return calls.length; }};
      let error=null;
      try { await producer.enqueueAiUsageReceipt(cache,receipt); } catch(e) { assert.equal(e,sentinel); error=e.message; assertions++; }
      assert.equal(source.readClock(),receipt===null?0:1); assertions++;
      assert.equal(calls.length,receipt===null?0:1); assertions++;
      if(receipt) { assert.equal(calls[0].key,producer.AI_USAGE_RECEIPT_QUEUE_KEY); assertions++; }
      runs.push({fail,clockCalls:source.readClock(),calls,error});
    }
    assert.equal(builderClockCalls,input.occurredAt.present?0:1); assertions++;
    if(receipt) { assert.equal(receipt.itemized,true); assert.equal(receipt.credits,args.credits); assertions+=2; }
    cases.push({...spec,output:{receiptWire,numericBits,builderClockCalls,runs}});
  }
  const tiers=[];
  for(const value of [undefined,null,false,true,0,-0,NaN,Infinity,-Infinity,'free','premium','pro','unknown',' Premium ','💠','\ud800','premium\udc00',[],{},['pro']]) {
    const token=value===undefined?{kind:'undefined'}:typeof value==='number'?{kind:'number',bits:bits(value)}:{kind:'json',wire:JSON.stringify(value)};
    tiers.push({input:token,days:producer.getAiUsageRetentionDays(value)});
  }
  assert(cases.length>=300); assert(tiers.length>=20); assert(assertions>=2000);
  assert.equal(cases.filter(c=>c.integrationRole).length,9);
  assert.equal(new Set(cases.filter(c=>c.integrationRole).map(c=>JSON.parse(c.input.contextJson).entryId)).size,9);
  const sources=[ledgerFile,'src/utils/ai_usage_classification.ts','src/utils/ai_usage_event.ts','src/utils/ai_usage_receipts.ts','src/schemas/ai_usage_receipt.schema.ts','src/utils/ai_usage.rs','src/utils/credit_policy.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/json_number.rs','src/utils/js_compat.rs','src/utils/ai_usage_receipts/values.rs','src/utils/ai_usage_receipts/queue.rs','src/utils/ai_usage_receipts.rs','package.json','package-lock.json','tests/ai_usage_producer.rs','tests/ai_usage_producer_redis.rs','tests/support/ai_usage_producer.rs','src/utils/ai_usage_producer.rs'];
  const hashes=Object.fromEntries(sources.map(f=>[f,sha(fs.readFileSync(fixturePath(root,f)))]));
  hashes.reader=sha(fs.readFileSync(__filename));
  hashes.loader=sha(fs.readFileSync(path.join(__dirname,'ai_usage_producer_source.cjs')));
  hashes.node=sha(fs.readFileSync(process.execPath));
  hashes.typescript=sha(fs.readFileSync(require.resolve('typescript')));
  hashes.typescriptPackage=sha(fs.readFileSync(require.resolve('typescript/package.json')));
  const out={metadata:{format:2,node:process.version,v8:process.versions.v8,typescript:ts.version,hashes,extractedSha256:sha(extracted),ast:{declarations:evidence,types,imports,sourceModules},caseCount:cases.length,tierCount:tiers.length,assertionCount:assertions,observedImports:[...new Set(observedImports)].sort(),contract:'plain declared fields plus null/missing, lossless UTF16 and binary64; no hooks/prototypes/arbitrary invalid field casts'},namespace,fixedNowBits:bits(fixedNow),queue:producer.AI_USAGE_RECEIPT_QUEUE_KEY,processing:producer.AI_USAGE_RECEIPT_PROCESSING_KEY,cases,tiers};
  const bytes=JSON.stringify(out,null,2)+'\n';
  const file=path.join(dir,'ai_usage_producer_reference.json');
  if(mode==='--write') fs.writeFileSync(file,bytes,{flag:'wx'});
  else assert.equal(fs.readFileSync(file,'utf8'),bytes,'source/toolchain/reader/outputs differ');
  process.stdout.write(JSON.stringify({file,caseCount:cases.length,tierCount:tiers.length,assertionCount:assertions,sha256:sha(bytes)})+'\n');
}
main().catch(e=>{process.stderr.write(String(e.stack)+'\n');process.exitCode=1;});
