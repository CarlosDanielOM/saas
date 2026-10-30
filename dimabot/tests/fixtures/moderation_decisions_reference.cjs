'use strict';
// This fixture executes complete decisions.ts, real variations.ts and advanced.ts.
// The scripted Mongo model is an I/O boundary, not an implementation of Mongo,
// query casting, defaults, index enforcement, concurrency, or durable storage.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const lib = require('./moderation_decisions_source.cjs');
const readerPin = lib.independent('DIMA_DECISIONS_READER_SHA256', __filename);
const variations = require('./moderation_variations_source.cjs').realm();
const epoch = 1_700_000_000_123;
const baseInput = () => ({channelID:'channel', userID:'user', username:'name', messageID:'message', messageText:'hello', ruleID:'rule', rule:{id:'rule', patterns:[]}, settingsVersion:3, matches:[], context:[], mode:'literal', deadline:new Date(epoch+1000)});
const result = {_id:'saved',state:'completed',status:'persisted',unknown:{a:1}};
const cases = [];
const add = (name, operation, args, script=[], options={}) => cases.push({name,operation,args,script,options});
const response = (method,value,advance=0) => ({method,value,advance});
for (const [name,args] of [
 ['basic',['channel','message','rule']], ['delimiter-left',['a|b','c','d']], ['delimiter-right',['a','b|c','d']],
 ['utf16-lone',['😀','\ud800','\udc00']], ['escapes',['a\u0000\n"\\','\u2028','\u2029']], ['empty',['','','']],
]) add('hash-'+name,'moderationDecisionID',args);
for (const [name,patch] of [
 ['literal',{}], ['regex',{mode:'regex'}], ['unknown-mode',{mode:'unrecognized'}],
 ['semantic-default',{mode:'semantic'}], ['semantic-null',{mode:'semantic',rule:{id:'r',semantic:{thresholdPercent:null}}}],
 ['semantic-zero',{mode:'semantic',rule:{id:'r',semantic:{thresholdPercent:0,other:'preserved'}}}],
 ['semantic-false',{mode:'semantic',rule:{id:'r',semantic:{thresholdPercent:false}}}],
 ['semantic-undefined',{mode:'semantic',rule:{id:'r',semantic:{thresholdPercent:undefined}}}],
 ['semantic-object',{mode:'semantic',rule:{id:'r',semantic:{thresholdPercent:97,unknown:{keep:true}}}}],
 ['off',{rule:{id:'r',variations:{mode:'off',entries:[{untrusted:true}]}}}],
 ['missing-variations',{rule:{id:'r',unknown:{empty:{},x:1}}}],
 ['compiled-common',{rule:{id:'r',variations:{mode:'common',allowSpaces:true,entries:[variations.buildVariation('cat')]}}}],
 ['compiled-broad',{rule:{id:'r',variations:{mode:'broad',allowSpaces:false,entries:[variations.buildVariation('cat')]}}}],
 ['review-source',{reviewSource:'spam_continuous',extra:{keep:'raw'}}],
]) {
 const input={...baseInput(),...patch};
 add('create-'+name,'createModerationDecision',[input],[response('findOneAndUpdate',result)],{clockReads:[epoch,epoch+17]});
}
add('create-existing-idempotent','createModerationDecision',[{...baseInput(),messageText:'changed',mode:'semantic'}],[response('findOneAndUpdate',{...result,marker:'existing'})],{clockReads:[epoch,epoch+3]});
add('create-database-error','createModerationDecision',[baseInput()],[{method:'findOneAndUpdate',throw:{name:'Error',message:'database failed'}}]);
add('create-uncertain-write-no-retry','createModerationDecision',[baseInput()],[{method:'findOneAndUpdate',throw:{name:'MongoNetworkError',message:'unknown commit result'}}]);
add('create-invalid-variations','createModerationDecision',[{...baseInput(),rule:{variations:{mode:'common',entries:null}}}],[]);
add('create-null-rule','createModerationDecision',[{...baseInput(),rule:null}],[]);
const decision = deadline => ({_id:'decision-id',deadline:new Date(deadline)});
add('await-ready','awaitSemanticDecision',[decision(epoch+1000)],[response('findById',{_id:'decision-id',state:'completed',status:'violation'})]);
add('await-pending-completed','awaitSemanticDecision',[decision(epoch+1000)],[response('findById',{state:'pending'}),response('findById',{state:'completed',status:'worker'})]);
add('await-processing-completed','awaitSemanticDecision',[decision(epoch+1000)],[response('findById',{state:'processing'}),response('findById',{state:'completed',status:'worker'})]);
add('await-missing-then-completed','awaitSemanticDecision',[decision(epoch+1000)],[response('findById',null),response('findById',{state:'completed'})]);
add('await-at-deadline','awaitSemanticDecision',[decision(epoch)],[response('updateOne',{modifiedCount:1}),response('findById',{state:'completed',status:'timeout'})]);
add('await-past-deadline','awaitSemanticDecision',[decision(epoch-1)],[response('updateOne',{modifiedCount:0}),response('findById',null)]);
add('await-near-deadline-pending','awaitSemanticDecision',[decision(epoch+1)],[response('findById',{state:'pending'}),response('updateOne',{modifiedCount:1}),response('findById',{state:'completed',status:'timeout'})]);
add('await-near-deadline-processing','awaitSemanticDecision',[decision(epoch+79)],[response('findById',{state:'processing'}),response('updateOne',{modifiedCount:1}),response('findById',{state:'completed',status:'timeout'})]);
add('await-fence-race-completed','awaitSemanticDecision',[decision(epoch)],[response('updateOne',{modifiedCount:0}),response('findById',{state:'completed',status:'worker'})]);
add('await-timeout-then-missing','awaitSemanticDecision',[decision(epoch+80)],[response('findById',null),response('updateOne',{modifiedCount:0}),response('findById',null)]);
add('await-query-error','awaitSemanticDecision',[decision(epoch+1000)],[{method:'findById',throw:{name:'Error',message:'read failed'}}]);
add('await-update-error','awaitSemanticDecision',[decision(epoch)],[{method:'updateOne',throw:{name:'Error',message:'write failed'}}]);
add('await-uncertain-write-no-retry','awaitSemanticDecision',[decision(epoch)],[{method:'updateOne',throw:{name:'MongoNetworkError',message:'unknown commit result'}}]);
add('await-final-read-error','awaitSemanticDecision',[decision(epoch)],[response('updateOne',{modifiedCount:1}),{method:'findById',throw:{name:'Error',message:'final read failed'}}]);
add('await-read-crosses-deadline-completed','awaitSemanticDecision',[decision(epoch+1)],[response('findById',{state:'completed',status:'worker'},10)]);
add('await-read-crosses-deadline-pending','awaitSemanticDecision',[decision(epoch+1)],[response('findById',{state:'pending'},10),response('updateOne',{modifiedCount:1}),response('findById',{state:'completed',status:'timeout'})]);
async function mongooseWireProbe() {
  const captures=[];
  const {model,instance,bson} = lib.schemaRealm(async (filter, update, options) => {
    // The actual Mongoose query has cast its update and applied insert defaults
    // before reaching this disconnected collection boundary. Driver defaults
    // come from the pinned MongoDB SDK; this probe records its resolved default mode.
    const resolved = lib.driverBsonOptions.resolveBSONOptions(options);
    const encoded = bson.serialize(update, resolved);
    const decoded = bson.deserialize(encoded);
    const queryEntry=update.$setOnInsert.rule.variations.entries[0];
    const wireEntry=decoded.$setOnInsert.rule.variations.entries[0];
    captures.push({filter:lib.encode(filter), update:lib.encode(update), options:lib.encode(options), resolved:lib.encode(resolved), bsonHex:encoded.toString('hex'), decoded:lib.encode(decoded), symbolVersion:{queryOwn:Object.hasOwn(queryEntry,'symbolVersion'), queryValue:lib.encode(queryEntry.symbolVersion), wireOwn:Object.hasOwn(wireEntry,'symbolVersion'), wireValue:lib.encode(wireEntry.symbolVersion)}});
    return null;
  });
  const RealDate=Date;
  class FixtureDate extends RealDate { constructor(...args){super(...(args.length?args:[epoch]));} static now(){return epoch;} }
  const api=lib.realm({model,clock:FixtureDate,timeout:()=>{throw Error('unexpected timeout');}});
  const input={...baseInput(),rule:{id:'r',variations:{mode:'common',allowSpaces:true,entries:[variations.buildVariation('cat')]}}};
  await api.createModerationDecision(input);
  assert.equal(captures.length,1);assert.equal(instance.connection.readyState,0);
  return {name:'mongoose-cast-default-and-bson-compiled-common', capture:captures[0]};
}
async function run(c) {
 let cursor=0, now=epoch, clockIndex=0;
 const calls=[];
 class FixtureDate extends Date {
   constructor(...args) { super(...(args.length ? args : [clockRead()])); }
   static now() { return clockRead(); }
 }
 function clockRead() { const chosen=c.options.clockReads?.[clockIndex++]; if(chosen!==undefined) now=chosen; return now; }
 function take(method,args) {
   calls.push({method,args:lib.encode(args),at:now});
   const step=c.script[cursor++];assert(step,`${c.name}: unexpected ${method}`);assert.equal(step.method,method,c.name);
   now+=step.advance||0;
   if(step.throw){const error=new Error(step.throw.message);error.name=step.throw.name;throw error;}
   return step.value;
 }
 const model={
   findOneAndUpdate(...args){return {lean:async()=>take('findOneAndUpdate',args)};},
   findById(...args){return {lean:async()=>take('findById',args)};},
   async updateOne(...args){return take('updateOne',args);},
 };
 function timeout(resolve,ms){calls.push({method:'setTimeout',args:lib.encode([ms]),at:now});now+=ms;resolve();}
 const api=lib.realm({model,clock:FixtureDate,timeout});
 let outcome;
 try {outcome={ok:true,value:lib.encode(await api[c.operation](...c.args))};}
 catch(error){outcome={ok:false,name:lib.encode(error.name),message:lib.encode(error.message)};}
 assert.equal(cursor,c.script.length,`${c.name}: unconsumed model steps`);
 return {name:c.name,operation:c.operation,args:lib.encode(c.args),script:lib.encode(c.script),options:c.options,outcome,calls};
}
(async()=>{
 const observed=[];for(const c of cases) observed.push(await run(c));
 const queryProbe=await mongooseWireProbe();
 const reference={schema:1,queryProbe,provenance:{readerSha256:readerPin,loaderSha256:process.env.DIMA_DECISIONS_LOADER_SHA256,node:process.versions.node,v8:process.versions.v8,nodeSha256:lib.nodeSha,typescript:'5.9.3',mongoose:'8.24.2',mongodb:'6.20.0',bson:'6.10.4',re2Runtime:lib.re2Runtime,pins:lib.pins,compiled:lib.compiled,evidence:lib.evidence,mongooseFiles:lib.mongooseFiles,sdkLoaded:lib.sdk(),runtimeExports:['moderationDecisionID','createModerationDecision','awaitSemanticDecision'],caseCount:observed.length,boundary:'scripted model and clock; no Mongo casting or durable storage'},cases:observed};
 const [mode,dir,...extra]=process.argv.slice(2);
 assert(['--write','--check'].includes(mode)&&dir&&!extra.length,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
 const real=lib.external(dir), filename=path.join(real,'moderation-decisions-reference.json');
 assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(filename)]);
 const output=JSON.stringify(reference,null,2)+'\n';
 if(mode==='--write')fs.writeFileSync(filename,output,{flag:'wx'});else assert.equal(fs.readFileSync(filename,'utf8'),output);
 console.log(JSON.stringify({mode,sha256:lib.sha(output),cases:observed.length}));
})().catch(error=>{console.error(error);process.exitCode=1;});
