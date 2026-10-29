'use strict';
// Execute only in the parent's isolated capped environment; inputs are read-only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const shaFile=file=>sha(fs.readFileSync(file));
const abs=name=>{const v=process.env[name];assert(v&&path.isAbsolute(v),`${name} must be an absolute path`);return v;};
const nodePin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const source=fs.realpathSync(abs('DIMA_MODERATION_TEXT_SOURCE_ROOT'));
const workspace=path.dirname(source);
const inputDir=fs.realpathSync(abs('DIMA_MODERATION_TEXT_BENCH_DIR'));
const input=path.join(inputDir,'moderation-text-benchmark-input.json');
const binary=fs.realpathSync(abs('DIMA_MODERATION_TEXT_BENCH_BINARY'));
const provenance=fs.realpathSync(abs('DIMA_MODERATION_TEXT_BINARY_PROVENANCE'));
const receipt=fs.realpathSync(abs('DIMA_MODERATION_TEXT_COMPILER_RECEIPT'));
const buildLog=fs.realpathSync(abs('DIMA_MODERATION_TEXT_BUILD_LOG'));
const node=fs.realpathSync(abs('DIMA_MODERATION_TEXT_NODE_PATH'));
const reportDir=abs('DIMA_MODERATION_TEXT_PAIRED_DIR');
const inputPin=process.env.DIMA_MODERATION_TEXT_INPUT_SHA256;
assert(/^[a-f0-9]{64}$/.test(inputPin||''));
assert.equal(process.env.DIMA_MODERATION_TEXT_NODE_SHA256,nodePin);
assert.equal(process.env.DIMA_MODERATION_TEXT_REPS,'1000');
assert.equal(node,fs.realpathSync(process.execPath));
const reportPath=path.join(fs.realpathSync(path.dirname(reportDir)),path.basename(reportDir));
for(const forbidden of [source,inputDir]) {const relative=path.relative(forbidden,reportPath);assert(relative==='..'||relative.startsWith('..'+path.sep),'report directory must be external to source and inputs');}
fs.mkdirSync(reportDir,{mode:0o700}); // Exclusive: never reuse an existing directory.
const report={format:1,status:'running',order:[],workloads:{},servers:{},hashesBefore:null,hashesAfter:null,caveats:[
  'Each workload is a separate eight-item equally weighted prepared pool, not a production traffic distribution.',
  'Timer covers production function calls and storage of results; parsing, preparation, IPC, serialization, checksumming, destruction and hashing are outside the timer.',
  'Both processes run in one capped environment; timings are not end-to-end production latency.'
]};
const children=[];
const files={node,binary,provenance,receipt,buildLog,input,coordinator:__filename,nodeBenchmark:path.join(source,'tests/fixtures/moderation_text_benchmark.cjs')};
let manifestFiles={};
const fileHashes=()=>({artifacts:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,shaFile(v)])), inputs:Object.fromEntries(Object.entries(manifestFiles).map(([k,v])=>[k,shaFile(v)]))});
function inspectElf(file) {
  const b=fs.readFileSync(file);
  assert(b.length>=64 && b.subarray(0,6).equals(Buffer.from([0x7f,69,76,70,2,1])) && b.readUInt16LE(18)===62,'expected little-endian x86-64 ELF');
  const start=Number(b.readBigUInt64LE(32)), size=b.readUInt16LE(54), count=b.readUInt16LE(56);
  assert(size>=56 && start+size*count<=b.length);
  const headers=[];
  for(let i=0;i<count;i++){
    const off=start+i*size, kind=b.readUInt32LE(off); headers.push(kind); assert.notEqual(kind,3,'ELF interpreter');
    if(kind===2){
      const at=Number(b.readBigUInt64LE(off+8)), len=Number(b.readBigUInt64LE(off+32));
      assert(at+len<=b.length && len%16===0); let terminated=false;
      for(let pos=at;pos<at+len;pos+=16){const tag=b.readBigInt64LE(pos);assert.notEqual(tag,1n,'ELF DT_NEEDED');if(tag===0n){terminated=true;break;}}
      assert(terminated,'unterminated dynamic section');
    }
  }
  return headers;
}
function validateInputs(){
 const prov=JSON.parse(fs.readFileSync(provenance,'utf8'));
 const rec=JSON.parse(fs.readFileSync(receipt,'utf8'));
 const data=JSON.parse(fs.readFileSync(input,'utf8'));
 assert.equal(shaFile(node),nodePin);assert.equal(shaFile(input),inputPin);
 assert.equal(prov.buildReceipt,path.basename(receipt));
 assert(rec.success && rec.production_unchanged && rec.limits_verified);
 assert.equal(prov.sourceTreeSha256,rec.source_tree_sha256);assert.equal(prov.toolchainImage,rec.toolchain_image);
 const keys=Object.keys(rec.source_hashes).sort();assert.equal(prov.sourceInputs,keys.length);
 assert(keys.every(k=>/^[\x20-\x7e]*$/.test(k)));
 const canonical='{'+keys.map(k=>JSON.stringify(k)+': '+JSON.stringify(rec.source_hashes[k])).join(', ')+'}';
 assert.equal(sha(canonical),rec.source_tree_sha256,'compiler receipt manifest digest');
 assert.equal(prov.binaries.length,1);const record=prov.binaries[0];
 assert.equal(record.name,'moderation_text_benchmark');assert.equal(record.sha256,shaFile(binary));
 assert.equal(path.basename(record.artifactPath),path.basename(binary));
 assert.equal(record.bytes,fs.statSync(binary).size);assert.equal(record.elfMachine,'x86-64');
 assert.equal(record.staticNoInterpreterOrNeededLibraries,true);assert.equal(record.profile.test,true);
 assert.equal(record.profile.debug_assertions,false);assert.equal(record.profile.opt_level,'3');
 assert.deepEqual(inspectElf(binary),record.programHeaderTypes);
 const messages=fs.readFileSync(buildLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(messages.at(-1),{reason:'build-finished',success:true});
 const builds=messages.filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='moderation_text_benchmark'&&m.executable);
 assert.equal(builds.length,1);assert.equal(builds[0].executable,record.cargoExecutable);assert.deepEqual(builds[0].profile,record.profile);
 assert.equal(data.metadata.format,1);assert.equal(data.metadata.realm,'commonjs');assert.equal(data.metadata.nodeSha,nodePin);
 assert.deepEqual(data.metadata.versions,{node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0',typescript:'5.9.3'});
 assert(/^[a-f0-9]{64}$/.test(data.metadata.compiledSha.links));assert(/^[a-f0-9]{64}$/.test(data.metadata.compiledSha.normalize));
 // Hash the entire receipt manifest against the mounted source, not only a
 // claimed source-tree digest. SDK entries additionally come from the input.
 for(const key of keys){
   const file=path.resolve(workspace,key);assert(file.startsWith(workspace+path.sep),'invalid receipt path');
   manifestFiles['receipt:'+key]=file;
 }
 for(const [key,expected] of [...Object.entries(data.metadata.pins),...Object.entries(data.metadata.nativeHashes)]){
   const file=path.resolve(source,key);assert(file.startsWith(source+path.sep),'invalid input path');
   manifestFiles['prepared:'+key]=file;assert.equal(shaFile(file),expected,`prepared ${key}`);
   const built=rec.source_hashes['dimabot/'+key];
   if(!key.startsWith('node_modules/')) {assert(built,`missing compiler source ${key}`);assert.equal(built,expected,`compiler source ${key}`);}
 }
 const hashes=fileHashes();
 for(const key of keys)assert.equal(hashes.inputs['receipt:'+key],rec.source_hashes[key],`receipt input ${key}`);
 const names=['link-common','link-large','fold-text','escape-regexp'];
 assert.deepEqual(Object.keys(data.pools).sort(),[...names].sort());
 const pools={};for(const name of names){const rows=data.pools[name];assert(Array.isArray(rows)&&rows.length===8);pools[name]=rows.map(row=>row.id);assert(pools[name].every(id=>typeof id==='string'));assert.equal(new Set(pools[name]).size,8);}
 return {hashes,data,pools,names,sourceTreeSha:rec.source_tree_sha256,binarySha:record.sha256};
}
class Server {
  constructor(name, executable, args){
    this.name=name; this.stdout=[]; this.stderr=''; this.buffer=''; this.queue=[]; this.waiter=null; this.closed=null; this.failure=null; this.closeWaiters=[];
    this.child=spawn(executable,args,{cwd:source,env:process.env,stdio:['pipe','pipe','pipe']});
    children.push(this); report.servers[name]={executable,args,stdout:this.stdout,stderr:''};
    this.child.on('error',e=>this.fail(e));
    this.child.stdin.on('error',e=>this.fail(e));
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>this.onData(chunk));
    this.child.stderr.on('data',chunk=>{
      if(Buffer.byteLength(this.stderr)+Buffer.byteLength(chunk)>65536){
        const remaining=Math.max(0,65536-Buffer.byteLength(this.stderr));
        this.stderr+=Buffer.from(chunk).subarray(0,remaining).toString('utf8');
        this.fail(Error(`${name} stderr limit exceeded`));
      } else this.stderr+=chunk;
      report.servers[name].stderr=this.stderr;
    });
    this.child.on('close',(code,signal)=>{this.closed={code,signal};report.servers[name].exit=this.closed; if(this.buffer) this.onLine(this.buffer);this.buffer=''; if(this.waiter) this.fail(Error(`${name} exited before reply`)); for(const f of this.closeWaiters)f();});
  }
  fail(err){ if(!this.failure)this.failure=err; if(this.waiter){const w=this.waiter;this.waiter=null;clearTimeout(w.timer);w.reject(this.failure);} }
  onData(chunk){
    if(Buffer.byteLength(this.buffer)+Buffer.byteLength(chunk)>262144){this.fail(Error(`${this.name} stdout line limit exceeded`));return;}
    this.buffer+=chunk;
    let index; while((index=this.buffer.indexOf('\n'))!==-1){const line=this.buffer.slice(0,index).replace(/\r$/,'');this.buffer=this.buffer.slice(index+1);this.onLine(line);}
  }
  onLine(line){
    this.stdout.push(line); if(this.stdout.reduce((n,l)=>n+Buffer.byteLength(l)+1,0)>1048576){this.fail(Error(`${this.name} stdout limit exceeded`));return;}
    const index=line.indexOf('{'); if(index<0)return;
    let obj; try{obj=JSON.parse(line.slice(index));}catch{return;}
    if(obj.ready!==true && !Object.hasOwn(obj,'elapsedNs'))return;
    if(this.waiter){const w=this.waiter;this.waiter=null;clearTimeout(w.timer);w.resolve({raw:line,parsed:obj});}else this.queue.push({raw:line,parsed:obj});
  }
  next(){
    if(this.failure)return Promise.reject(this.failure);
    if(this.queue.length)return Promise.resolve(this.queue.shift());
    if(this.closed)return Promise.reject(Error(`${this.name} already exited`));
    assert(!this.waiter);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=null;reject(Error(`${this.name} reply timed out`));},120000);this.waiter={resolve,reject,timer};});
  }
  async command(command){assert(!this.closed && !this.failure,`${this.name} unavailable`);this.child.stdin.write(JSON.stringify(command)+'\n');return this.next();}
  waitClose(timeout=10000){
    if(this.closed)return Promise.resolve();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`${this.name} exit timed out`)),timeout);this.closeWaiters.push(()=>{clearTimeout(timer);resolve();});});
  }
}
function validateResult(reply,kind,checksum){
 const v=reply.parsed;assert.equal(v.workload,kind);assert.equal(typeof v.elapsedNs,'string');assert(/^[1-9][0-9]*$/.test(v.elapsedNs));assert.equal(v.total,8000);assert(Number.isInteger(v.checksum)&&v.checksum>=0&&v.checksum<=0xffffffff);if(checksum!==null)assert.equal(v.checksum,checksum,`${kind} checksum drift`);return v.checksum;
}
async function cleanup(){
 for(const server of children)if(!server.closed)server.child.kill('SIGTERM');
 await Promise.all(children.map(async server=>{if(server.closed)return;try{await server.waitClose(3000);}catch{server.child.kill('SIGKILL');try{await server.waitClose(3000);}catch{}}}));
}
async function main(){
 let result;
 try{
  const inputs=validateInputs();report.hashesBefore=inputs.hashes;report.provenance={sourceTreeSha:inputs.sourceTreeSha,binarySha:inputs.binarySha};
  const nodeServer=new Server('node',node,[files.nodeBenchmark,'--serve']);
  const rustServer=new Server('rust',binary,['prepared_moderation_text_server','--ignored','--exact','--nocapture']);
  const nodeReady=await nodeServer.next(),rustReady=await rustServer.next();report.readiness={node:nodeReady,rust:rustReady};
  for(const reply of [nodeReady,rustReady]){
   const v=reply.parsed;assert.equal(v.ready,true);assert.deepEqual(v.pools,inputs.pools);assert.equal(v.reps,1000);assert.equal(v.inputSha,inputPin);assert.equal(v.nodeSha,nodePin);assert.deepEqual(v.compiledSha,inputs.data.metadata.compiledSha);assert.deepEqual(v.nativeHashes,inputs.data.metadata.nativeHashes);
  }
  assert.equal(nodeReady.parsed.realm,'commonjs');assert.equal(rustReady.parsed.realm,'native');
  for(const kind of inputs.names){
   let checksum=null;const entry={warmups:[],trials:[]};report.workloads[kind]=entry;
   for(const [phase,count] of [['warmup',3],['run',7]])for(let i=0;i<count;i++){
    const pair={index:i+1};
    for(const server of i%2===0?[nodeServer,rustServer]:[rustServer,nodeServer]){
     report.order.push({workload:kind,phase,index:i+1,server:server.name});
     const reply=await server.command({command:phase,workload:kind});checksum=validateResult(reply,kind,checksum);pair[server.name]=reply;
    }
    (phase==='warmup'?entry.warmups:entry.trials).push(pair);
   }
   const median=key=>entry.trials.map(t=>BigInt(t[key].parsed.elapsedNs)).sort((a,b)=>a<b?-1:a>b?1:0)[3];
   const nodeMedian=median('node'),rustMedian=median('rust');entry.metrics={checksum,nodeMedianNs:nodeMedian.toString(),rustMedianNs:rustMedian.toString(),nodeNsPerOp:Number(nodeMedian)/8000,rustNsPerOp:Number(rustMedian)/8000};
  }
  for(const server of [nodeServer,rustServer]){assert(!server.closed&&!server.failure);server.child.stdin.write(JSON.stringify({command:'quit'})+'\n');server.child.stdin.end();}
  await Promise.all([nodeServer.waitClose(),rustServer.waitClose()]);
  for(const server of [nodeServer,rustServer]){assert.deepEqual(server.closed,{code:0,signal:null});assert(!server.failure);assert.equal(server.queue.length,0);}
  report.hashesAfter=fileHashes();assert.deepEqual(report.hashesAfter,report.hashesBefore,'inputs changed during measurement');
  report.status='passed';result=0;
 }catch(error){report.status='failed';report.error=error&&error.stack||String(error);result=1;}
 finally{await cleanup();if(!report.hashesAfter){try{report.hashesAfter=fileHashes();}catch(error){report.postHashError=String(error);}}fs.writeFileSync(path.join(reportDir,'moderation-text-paired-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 if(result){process.stderr.write(report.error+'\n');process.exitCode=1;}else process.stdout.write(JSON.stringify({status:report.status,report:path.join(reportDir,'moderation-text-paired-report.json'),metrics:Object.fromEntries(Object.entries(report.workloads).map(([k,v])=>[k,v.metrics]))})+'\n');
}
main().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
