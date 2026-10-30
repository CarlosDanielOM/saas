'use strict';
// Parent-only: execute in the separately authorized, isolated capped environment.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const hash=file=>sha(fs.readFileSync(file));
const prefix='DIMA_BLACKLIST_PAIRED_';
function env(name){const value=process.env[prefix+name];assert(value,`missing ${prefix+name}`);return value;}
function absolute(name){const value=env(name);assert(path.isAbsolute(value),`${prefix+name} must be absolute`);return value;}
function pin(name){const value=env(name);assert(/^[a-f0-9]{64}$/.test(value),`invalid ${prefix+name}`);return value;}
const source=fs.realpathSync(absolute('SOURCE_ROOT')),workspace=path.dirname(source);
const node=fs.realpathSync(absolute('NODE')),binary=fs.realpathSync(absolute('BINARY'));
const input=fs.realpathSync(absolute('FIXTURE')),provenance=fs.realpathSync(absolute('PROVENANCE'));
const receipt=fs.realpathSync(absolute('RECEIPT')),buildLog=fs.realpathSync(absolute('BUILD_LOG'));
const reportDir=absolute('REPORT_DIR');
const iterations=Number(env('ITERATIONS'));assert(Number.isSafeInteger(iterations)&&iterations>0&&iterations<=100000);
const pins={node:pin('NODE_SHA256'),binary:pin('BINARY_SHA256'),input:pin('FIXTURE_SHA256'),provenance:pin('PROVENANCE_SHA256'),receipt:pin('RECEIPT_SHA256'),buildLog:pin('BUILD_LOG_SHA256'),oracle:pin('ORACLE_SHA256'),nodeBenchmark:pin('NODE_BENCHMARK_SHA256'),typescript:pin('TYPESCRIPT_SHA256'),typescriptPackage:pin('TYPESCRIPT_PACKAGE_SHA256'),sourceTree:pin('SOURCE_TREE_SHA256')};
const nodePin='569128f3066ac7be59b10b9e0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(pins.node,nodePin);assert.equal(node,fs.realpathSync(process.execPath));
const files={node,binary,input,provenance,receipt,buildLog,oracle:path.join(source,'tests/fixtures/moderation_blacklist_reference.cjs'),nodeBenchmark:path.join(source,'tests/fixtures/moderation_blacklist_benchmark.cjs'),typescript:path.join(source,'node_modules/typescript/lib/typescript.js'),typescriptPackage:path.join(source,'node_modules/typescript/package.json'),coordinator:fs.realpathSync(__filename)};
const reportPath=path.join(fs.realpathSync(path.dirname(reportDir)),path.basename(reportDir));
function external(base,target){const relative=path.relative(base,target);return relative==='..'||relative.startsWith('..'+path.sep);}
for(const base of [workspace,path.dirname(input)])assert(external(base,reportPath),'report must be outside source workspace and fixture directory');
fs.mkdirSync(reportDir,{mode:0o700});
const report={format:1,status:'running',iterations,order:[],workloads:{},hashesBefore:null,hashesAfter:null,caveats:['Each sample is a fresh process with three full workload warmups in that same process.','Timer covers prepared evaluation including folding and result retention, excluding compilation, checksums and serialization.','Separate synthetic workloads are not a production traffic distribution or end-to-end latency.']};
let manifest={};let child=null;
function hashes(){return {artifacts:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,hash(v)])),inputs:Object.fromEntries(Object.entries(manifest).map(([k,v])=>[k,hash(v)]))};}
function inspectElf(file){
 const b=fs.readFileSync(file);assert(b.length>=64&&b.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))&&b.readUInt16LE(18)===62,'expected x86-64 little-endian ELF');
 const start=Number(b.readBigUInt64LE(32)),size=b.readUInt16LE(54),count=b.readUInt16LE(56);assert(Number.isSafeInteger(start)&&size>=56&&start+size*count<=b.length);
 const headers=[];for(let i=0;i<count;i++){const off=start+i*size,kind=b.readUInt32LE(off);headers.push(kind);assert.notEqual(kind,3,'ELF interpreter');if(kind===2){const at=Number(b.readBigUInt64LE(off+8)),len=Number(b.readBigUInt64LE(off+32));assert(Number.isSafeInteger(at)&&Number.isSafeInteger(len)&&at+len<=b.length&&len%16===0);let end=false;for(let p=at;p<at+len;p+=16){const tag=b.readBigInt64LE(p);assert.notEqual(tag,1n,'DT_NEEDED');if(tag===0n){end=true;break;}}assert(end,'unterminated ELF dynamic section');}}
 return headers;
}
function validate(){
 for(const [key,expected] of Object.entries(pins))if(key!=='sourceTree')assert.equal(hash(files[key]),expected,`${key} digest`);
 const prov=JSON.parse(fs.readFileSync(provenance,'utf8')),rec=JSON.parse(fs.readFileSync(receipt,'utf8'));
 assert.equal(prov.buildReceipt,path.basename(receipt));assert(rec.success&&rec.production_unchanged&&rec.limits_verified);
 assert.equal(rec.source_tree_sha256,pins.sourceTree);assert.equal(prov.sourceTreeSha256,pins.sourceTree);assert.equal(prov.toolchainImage,rec.toolchain_image);
 const keys=Object.keys(rec.source_hashes).sort();assert(keys.length>0&&keys.every(k=>/^[\x20-\x7e]+$/.test(k)));
 const canonical='{'+keys.map(k=>JSON.stringify(k)+': '+JSON.stringify(rec.source_hashes[k])).join(', ')+'}';assert.equal(sha(canonical),pins.sourceTree);assert.equal(prov.sourceInputs,keys.length);
 for(const key of keys){assert(/^[a-f0-9]{64}$/.test(rec.source_hashes[key]));const resolved=fs.realpathSync(path.resolve(workspace,key));assert(resolved!==workspace&&!external(workspace,resolved),'manifest path escapes workspace');manifest[key]=resolved;assert.equal(hash(resolved),rec.source_hashes[key],`source ${key}`);}
 for(const key of ['dimabot/src/utils/moderation/rules/blacklist.rule.ts','dimabot/src/utils/moderation/normalize.ts','dimabot/src/utils/moderation/blacklist.rs','dimabot/src/utils/js_regexp_unicode.rs','dimabot/src/utils/js_regexp_unicode_data.rs','dimabot/src/utils/moderation/caps_unicode_data.rs','dimabot/tests/moderation_blacklist_benchmark.rs','dimabot/tests/support/sha256.rs','dimabot/tests/fixtures/moderation_blacklist_reference.cjs','dimabot/tests/fixtures/moderation_blacklist_benchmark.cjs','dimabot/Cargo.toml','dimabot/Cargo.lock','dimabot/rust-toolchain.toml'])assert(Object.hasOwn(rec.source_hashes,key),`required source absent: ${key}`);
 assert.equal(prov.binaries.length,1);const record=prov.binaries[0];assert.equal(record.name,'moderation_blacklist_benchmark');assert.equal(record.sha256,pins.binary);assert.equal(record.bytes,fs.statSync(binary).size);assert.equal(path.basename(record.artifactPath),path.basename(binary));assert.equal(record.elfMachine,'x86-64');assert.equal(record.staticNoInterpreterOrNeededLibraries,true);assert.equal(record.profile.test,true);assert.equal(record.profile.debug_assertions,false);assert.equal(record.profile.opt_level,'3');assert(record.cargoExecutable.includes('/x86_64-unknown-linux-musl/'),'musl target absent from build artifact path');assert.deepEqual(inspectElf(binary),record.programHeaderTypes);
 const logs=fs.readFileSync(buildLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(logs.at(-1),{reason:'build-finished',success:true});const artifacts=logs.filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='moderation_blacklist_benchmark'&&m.executable);assert.equal(artifacts.length,1);assert.equal(artifacts[0].executable,record.cargoExecutable);assert.deepEqual(artifacts[0].profile,record.profile);
 const data=JSON.parse(fs.readFileSync(input,'utf8'));assert.equal(data.format,1);const names=['short','long','many','unicode'];assert.deepEqual(Object.keys(data.suites).sort(),[...names].sort());
 const checksums={};for(const name of names){const cases=data.suites[name];assert(Array.isArray(cases)&&cases.length>0&&cases.length<=100);let checksum=2166136261;for(let i=0;i<iterations;i++)for(const c of cases){const e=c.evaluation;assert(e&&typeof e.triggered==='boolean'&&(e.matchedText===null||Array.isArray(e.matchedText)));const units=e.matchedText??[];assert(units.every(n=>Number.isInteger(n)&&n>=0&&n<=65535));for(const n of [e.triggered?1:0,...units,65536])checksum=Math.imul(checksum^n,16777619)>>>0;}checksums[name]={checksum,operations:iterations*cases.length};}
 return {names,checksums,sourceTreeSha256:pins.sourceTree,binarySha256:pins.binary};
}
function run(actor,suite){
 const executable=actor==='node'?node:binary,args=actor==='node'?[files.nodeBenchmark,'--sample',suite]:['benchmark_sample','--ignored','--exact','--nocapture'];
 const envVars={PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C',DIMA_BLACKLIST_SOURCE_ROOT:source,DIMA_BLACKLIST_BENCHMARK_FIXTURE:input,DIMA_BLACKLIST_BENCHMARK_SHA256:pins.input,DIMA_BLACKLIST_BENCH_ITERATIONS:String(iterations),DIMA_BLACKLIST_BENCH_SUITE:suite};
 const record={actor,suite,executable,args,cwd:source,env:envVars,stdout:'',stderr:'',exit:null};report.order.push(record);
 return new Promise((resolve,reject)=>{
  let failure=null,timer,killTimer;child=spawn(executable,args,{cwd:source,env:envVars,stdio:['ignore','pipe','pipe']});
  const fail=error=>{if(!failure)failure=error;if(child&&!child.killed){child.kill('SIGTERM');killTimer=setTimeout(()=>child?.kill('SIGKILL'),3000);}};
  child.on('error',fail);for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{const prior=Buffer.byteLength(record[key]);if(prior+chunk.length>1048576){record[key]+=chunk.subarray(0,Math.max(0,1048576-prior)).toString('utf8');fail(Error(`${actor} ${key} exceeded 1 MiB`));}else record[key]+=chunk.toString('utf8');});
  timer=setTimeout(()=>fail(Error(`${actor} ${suite} timed out after 120 seconds`)),120000);
  child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(killTimer);child=null;record.exit={code,signal};if(failure)return reject(failure);try{assert.deepEqual(record.exit,{code:0,signal:null});const parsed=[];for(const line of record.stdout.split('\n')){const index=line.indexOf('{');if(index<0)continue;try{const value=JSON.parse(line.slice(index));if(value&&Object.hasOwn(value,'actor'))parsed.push(value);}catch{}}assert.equal(parsed.length,1,`${actor} metric lines`);record.metric=parsed[0];resolve(record);}catch(e){reject(e);}});
 });
}
function verify(sample,expected){const m=sample.metric;assert.equal(m.actor,sample.actor);assert.equal(m.suite,sample.suite);assert.equal(m.iterations,iterations);assert.equal(m.operations,expected.operations);assert.equal(m.checksum,expected.checksum);assert.equal(m.warmups,3);assert.equal(m.inputSha256,pins.input);assert(typeof m.nanoseconds==='string'&&/^[1-9][0-9]*$/.test(m.nanoseconds));if(sample.actor==='node'){assert.equal(m.executableSha256,pins.node);assert(/^[a-f0-9]{64}$/.test(m.resultsSha256));}}
async function main(){
 try{const setup=validate();report.provenance=setup;report.hashesBefore=hashes();for(const suite of setup.names){const samples=[];report.workloads[suite]={expected:setup.checksums[suite],samples};for(let i=0;i<7;i++){const pair={pair:i+1,order:i%2===0?['node','rust']:['rust','node']};samples.push(pair);for(const actor of pair.order){const sample=await run(actor,suite);verify(sample,setup.checksums[suite]);pair[actor]=sample.metric;}}
  const metrics={};for(const actor of ['node','rust']){const times=samples.map(x=>BigInt(x[actor].nanoseconds)).sort((a,b)=>a<b?-1:a>b?1:0);metrics[actor]={minNs:times[0].toString(),medianNs:times[3].toString(),maxNs:times[6].toString(),medianNsPerOperation:Number(times[3])/setup.checksums[suite].operations};}report.workloads[suite].metrics=metrics;}
  report.hashesAfter=hashes();assert.deepEqual(report.hashesAfter,report.hashesBefore,'input changed during benchmark');report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1;}
 finally{if(child)child.kill('SIGKILL');if(!report.hashesAfter){try{report.hashesAfter=hashes();}catch(error){report.postHashError=String(error);}}fs.writeFileSync(path.join(reportDir,'blacklist-paired-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify({status:report.status,report:path.join(reportDir,'blacklist-paired-report.json')}));
}
main().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
