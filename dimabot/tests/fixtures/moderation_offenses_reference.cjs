#!/usr/bin/env node
'use strict';
// Execute the whole unchanged TypeScript module; mock only Redis boundary.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), vm=require('node:vm'), assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const pin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_OFFENSE_NODE_SHA256,pin); assert.equal(hash(fs.readFileSync(process.execPath)),pin);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg=process.env.DIMA_OFFENSE_SOURCE_ROOT; assert(rootArg && path.isAbsolute(rootArg));
const root=fs.realpathSync(rootArg); assert.equal(root,rootArg);
const [mode,dirArg,...extra]=process.argv.slice(2); assert(['--write','--check'].includes(mode) && dirArg && path.isAbsolute(dirArg) && !extra.length);
const dir=fs.realpathSync(dirArg); assert.equal(dir,dirArg); assert(fs.statSync(dir).isDirectory() && dir!==root && !dir.startsWith(root+path.sep));
const name='moderation-offenses-reference.json'; assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:[name]); if(mode==='--check') assert(fs.lstatSync(path.join(dir,name)).isFile());
const read=f=>fs.readFileSync(path.join(root,f)), req=createRequire(path.join(root,'package.json')), ts=req('typescript'); assert.equal(ts.version,'5.9.3');
const source=read('src/utils/moderation/offenses.ts'); assert.equal(hash(source),'4a299b2b0882fbeaa3ae284a1d0bd4ee63deb0c05a8b96540368a501de401187');
const sf=ts.createSourceFile('offenses.ts',source.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS); assert.equal(sf.parseDiagnostics.length,0);
const imports=sf.statements.filter(ts.isImportDeclaration); assert.equal(imports.length,2);
assert.equal(imports[0].moduleSpecifier.text,'../databases/dragonfly.database.js'); assert.equal(imports[1].moduleSpecifier.text,'../../schemas/channel_moderation_settings.schema.js'); assert.equal(imports[1].importClause.isTypeOnly,true);
const exported=sf.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
assert.deepEqual(exported.map(s=>s.name.text),['offenseKey','recordOffense','resolveOffenseStep']); assert(exported.every(ts.isFunctionDeclaration));
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const wire=s=>Buffer.from(s,'utf8').toString('hex');
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
let events=[], modeFailure='', incrValue=1, evalValue=1, incrHold=null;
const cache={
 async incr(key) { events.push({cmd:'incr',key:units(key),keyHex:wire(key)}); if(modeFailure==='incr') throw Error('incr failure'); if(incrHold){incrHold.started();await incrHold.gate;} return incrValue; },
 async expire(key,seconds) { events.push({cmd:'expire',key:units(key),keyHex:wire(key),secondsBits:bits(seconds),secondsText:String(seconds)}); if(modeFailure==='expire') throw Error('expire failure'); if(incrHold)incrHold.finished(); return true; },
 async eval(script,options) { events.push({cmd:'eval',script,keys:Array.from(options.keys,units),keyHex:Array.from(options.keys,wire),arguments:Array.from(options.arguments)}); if(modeFailure==='eval') throw Error('eval failure'); return evalValue; },
};
const sandbox={exports:{},require(name){assert.equal(name,'../databases/dragonfly.database.js');return {getDragonflyClient:async caller=>{events.push({cmd:'connect',caller});if(modeFailure==='connect')throw Error('connect failure');return cache;}};}};
const js=ts.transpileModule(source.toString('utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(js,sandbox,{filename:'offenses.ts'}); const api=sandbox.exports;
assert.deepEqual(Object.keys(api).sort(),['offenseKey','recordOffense','resolveOffenseStep'].sort());
const inputs=['','ABC','a:b','\0','😀','\ud800','\udc00','A\ud801\udc00'];
const keys=[]; for(const channel of inputs) for(const rule of inputs) for(const user of ['','Ab','\ud800']) {const key=api.offenseKey(channel,rule,user);keys.push({channel:units(channel),rule:units(rule),user:units(user),key:units(key),wire:wire(key)});}
const ladder={firstOffense:{identity:'first',action:'warn',timeoutSeconds:60},secondOffense:{identity:'second',action:'delete',timeoutSeconds:60},thirdOffense:{identity:'third',action:'timeout',timeoutSeconds:600}};
const steps=[-Infinity,-3,-0,0,1,1.0000001,1.5,2,2.0000001,3,Infinity,NaN].map(n=>{const selected=api.resolveOffenseStep(ladder,n);return {numberBits:bits(n),identity:selected===ladder.firstOffense?'first':selected===ladder.secondOffense?'second':selected===ladder.thirdOffense?'third':'unknown'};});
const cases=[];
async function run() {
 const windows=[-Infinity,-10,-0,0,59.9,60,60.9,61.9,600,1e21,Infinity,NaN];
 for(const window of windows) for(const decision of [undefined,'','d','\ud800']) for(const count of [1,2]) {
   events=[]; modeFailure=''; incrValue=count; evalValue=count;
   const result=await api.recordOffense('C\ud800','R','U',window,decision);
   cases.push({channel:units('C\ud800'),rule:units('R'),user:units('U'),windowBits:bits(window),decision:decision===undefined?null:units(decision),count,resultBits:bits(result),events});
 }
 for(const decision of [undefined,'d']) for(const failure of ['connect','incr','expire','eval']) {
   if((decision && ['incr','expire'].includes(failure)) || (!decision && failure==='eval')) continue;
   events=[]; modeFailure=failure; incrValue=1; evalValue=1;
   let error=false; try{await api.recordOffense('c','r','u',60,decision);}catch{error=true;}
   assert(error); cases.push({channel:units('c'),rule:units('r'),user:units('u'),windowBits:bits(60),decision:decision===undefined?null:units(decision),count:1,error,events});
 }
 for(const evalReply of [null,0,42,9007199254740992]) {
   events=[];modeFailure='';evalValue=evalReply;
   const result=await api.recordOffense('c','r','u',60,'duplicate');
   cases.push({channel:units('c'),rule:units('r'),user:units('u'),windowBits:bits(60),decision:units('duplicate'),count:evalReply,resultBits:bits(result),events});
 }
 // Start the actual source function and discard the returned Promise while its
 // mocked INCR reply is held. EXPIRE must still be reached after release.
 events=[];modeFailure='';incrValue=1;
 let release,started,finished;
 const gate=new Promise(resolve=>{release=resolve;});
 const startedPromise=new Promise(resolve=>{started=resolve;});
 const finishedPromise=new Promise(resolve=>{finished=resolve;});
 incrHold={gate,started,finished};
 void api.recordOffense('abandoned','r','u',60);
 await startedPromise;
 const beforeRelease=events.map(event=>event.cmd);
 assert.deepEqual(beforeRelease,['connect','incr']);
 release();await finishedPromise;
 const afterRelease=events.map(event=>event.cmd);
 assert.deepEqual(afterRelease,['connect','incr','expire']);
 const abandonedCase={beforeRelease,afterRelease,secondsText:events[2].secondsText};
 incrHold=null;
 const files=['src/utils/moderation/offenses.ts','src/schemas/channel_moderation_settings.schema.ts','src/utils/moderation/permit_offenses.test.ts','src/utils/databases/dragonfly.database.ts','src/utils/databases/dragonfly.database.rs','src/utils/observability/telemetry.ts','src/utils/observability/mod.rs','src/utils/moderation/offenses.rs','src/utils/js_string.rs','src/utils/js_compat.rs','src/utils/json_number.rs','tests/moderation_offenses.rs','tests/moderation_offenses_redis.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
 const hashes=Object.fromEntries(files.map(f=>[f,hash(read(f))]));
 for(const [key,module] of [['typescript-js','typescript'],['typescript-package','typescript/package.json']])hashes[key]=hash(fs.readFileSync(req.resolve(module)));
 hashes['oracle-script']=hash(fs.readFileSync(__filename)); hashes['canonical-declarations']=hash(ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}).printFile(sf));
 const result=JSON.stringify({format:1,implementation:'actual-typescript',versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version},nodeExecutableSha256:pin,sourceSha256:hashes,keys,steps,cases,abandonedCase},null,2)+'\n';
 const target=path.join(dir,name); if(mode==='--write')fs.writeFileSync(target,result,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),result);
 console.log(`${name} sha256=${hash(result)} keys=${keys.length} steps=${steps.length} cases=${cases.length}`);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
