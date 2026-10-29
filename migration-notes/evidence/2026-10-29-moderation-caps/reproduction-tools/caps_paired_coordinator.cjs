'use strict';
// Author-only handoff: execute only inside the parent's isolated capped image.
// Invoke with absolute pinned Node and DIMA_CAPS_* paths as documented below.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const required = name => { const value = process.env[name]; assert(value && path.isAbsolute(value), `${name} must be absolute`); return value; };
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const binarySha = 'ae401e9a034de359dfeea70efaebd73b726e70e46dd7e8596e6454ee52150395';
const sourceTreeSha = '7fdc99bd3510a7710df688cd9598d59c57eeba7c90ade57fb70e4e2fcbe607f5';
const receiptName = 'compiler-1793305057976047544-receipt.json';
const source = fs.realpathSync(required('DIMA_CAPS_SOURCE_ROOT'));
const reference = path.join(fs.realpathSync(required('DIMA_CAPS_REFERENCE_DIR')), 'moderation_caps_reference.json');
const unicode = path.join(fs.realpathSync(required('DIMA_CAPS_UNICODE_DIR')), 'unicode-reference.json');
const reportDir = required('DIMA_CAPS_PAIRED_DIR');
const binary = fs.realpathSync(required('DIMA_CAPS_BENCH_BINARY'));
const provenance = fs.realpathSync(required('DIMA_CAPS_BINARY_PROVENANCE'));
const receipt = fs.realpathSync(required('DIMA_CAPS_COMPILER_RECEIPT'));
const buildLog = fs.realpathSync(required('DIMA_CAPS_BUILD_LOG'));
const node = fs.realpathSync(required('DIMA_CAPS_NODE_PATH'));
assert.equal(node, fs.realpathSync(process.execPath));
assert.equal(process.env.DIMA_CAPS_NODE_SHA256, nodeSha);
assert.equal(process.env.DIMA_CAPS_BENCH_REPETITIONS, '2000');
assert.equal(path.basename(receipt), receiptName);
const reportParent = fs.realpathSync(path.dirname(reportDir));
const resolvedReport = path.join(reportParent, path.basename(reportDir));
const relativeReport = path.relative(source, resolvedReport);
assert(relativeReport === '..' || relativeReport.startsWith('..'+path.sep), 'report directory must be outside source');
// The path must not exist: mkdir is an exclusive claim, never reuse or overwrite.
fs.mkdirSync(reportDir, {mode:0o700});
const report = {format:1, status:'running', warmups:[], trials:[], order:[], servers:{}, hashesBefore:null, hashesAfter:null,
  caveats:['One equally weighted mixed pool of eight prepared cases; not a production workload or a per-case distribution.',
    'Timers cover only the evaluator loop over prebuilt inputs with output containers allocated in advance. Parsing, IPC, wire serialization, checksum and destruction are outside the timer.',
    'Both processes share one capped execution environment; results do not establish end-to-end production latency.']};
const children = [];
const files = {
  node, binary, provenance, receipt, buildLog, reference, unicode, coordinator:__filename,
  sourceTs:path.join(source,'src/utils/moderation/rules/caps.rule.ts'),
  native:path.join(source,'src/utils/moderation/caps.rs'),
  table:path.join(source,'src/utils/moderation/caps_unicode_data.rs'),
  rustBenchmark:path.join(source,'tests/moderation_caps_benchmark.rs'),
  nodeBenchmark:path.join(source,'tests/fixtures/moderation_caps_benchmark.cjs'),
  loader:path.join(source,'tests/fixtures/moderation_caps_source.cjs'),
  oracle:path.join(source,'tests/fixtures/moderation_caps_reference.cjs'),
};
const fileHashes = () => Object.fromEntries(Object.entries(files).map(([key,file]) => [key,shaFile(file)]));
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
function validateInputs() {
  const prov=JSON.parse(fs.readFileSync(provenance,'utf8'));
  const rec=JSON.parse(fs.readFileSync(receipt,'utf8'));
  const ref=JSON.parse(fs.readFileSync(reference,'utf8'));
  const hashes=fileHashes();
  assert.equal(hashes.node,nodeSha); assert.equal(hashes.binary,binarySha);
  assert.equal(prov.buildReceipt,receiptName); assert.equal(prov.sourceTreeSha256,sourceTreeSha);
  assert.equal(rec.source_tree_sha256,sourceTreeSha); assert(rec.success && rec.production_unchanged && rec.limits_verified);
  assert.equal(prov.toolchainImage,rec.toolchain_image);
  assert.equal(prov.sourceInputs,Object.keys(rec.source_hashes).length);
  // Exporter used Python json.dumps(snapshot, sort_keys=True), default separators.
  // Every path and digest is ASCII; match that canonical serialization exactly.
  const keys=Object.keys(rec.source_hashes).sort();
  assert(keys.every(k=>/^[\x20-\x7e]*$/.test(k)));
  const canonical='{'+keys.map(k=>JSON.stringify(k)+': '+JSON.stringify(rec.source_hashes[k])).join(', ')+'}';
  assert.equal(sha(canonical),sourceTreeSha,'receipt source manifest digest');
  assert.equal(prov.binaries.length,1); const record=prov.binaries[0];
  assert.equal(record.name,'moderation_caps_benchmark'); assert.equal(record.sha256,binarySha);
  assert.equal(record.bytes,fs.statSync(binary).size); assert.equal(record.elfMachine,'x86-64');
  assert.equal(record.staticNoInterpreterOrNeededLibraries,true); assert.equal(record.profile.test,true);
  assert.equal(record.profile.debug_assertions,false); assert.equal(record.profile.opt_level,'3');
  assert.deepEqual(inspectElf(binary),record.programHeaderTypes);
  const messages=fs.readFileSync(buildLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(messages.at(-1),{reason:'build-finished',success:true});
  const builds=messages.filter(m=>m.reason==='compiler-artifact' && m.target?.name==='moderation_caps_benchmark' && m.executable);
  assert.equal(builds.length,1); assert.equal(builds[0].executable,record.cargoExecutable); assert.deepEqual(builds[0].profile,record.profile);
  assert.equal(ref.metadata.nodeSha,nodeSha);
  assert.deepEqual(ref.metadata.versions,{node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0',typescript:'5.9.3'});
  assert.equal(ref.metadata.total,ref.cases.length);
  for(const [name,digest] of Object.entries({...ref.metadata.pins,...ref.metadata.hashes})){
    assert.equal(shaFile(path.join(source,name)),digest,`reference input ${name}`);
    const sourceDigest=rec.source_hashes['dimabot/'+name];
    if(sourceDigest !== undefined) assert.equal(sourceDigest,digest,`compiler source ${name}`);
  }
  assert.equal(hashes.unicode,ref.metadata.unicodeReferenceSha);
  const pool=ref.cases.filter(c=>c.id.startsWith('bench-')).map(c=>c.id);
  assert.equal(pool.length,8); assert.equal(new Set(pool).size,8);
  return {hashes,ref,pool};
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
  async command(command){assert(!this.closed && !this.failure,`${this.name} unavailable`);this.child.stdin.write(command+'\n');return this.next();}
  waitClose(timeout=10000){
    if(this.closed)return Promise.resolve();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`${this.name} exit timed out`)),timeout);this.closeWaiters.push(()=>{clearTimeout(timer);resolve();});});
  }
}
function validateResult(reply, expectedChecksum){
  const v=reply.parsed; assert.equal(typeof v.elapsedNs,'string');assert(/^[1-9][0-9]*$/.test(v.elapsedNs));
  assert.equal(v.total,16000); assert(Number.isInteger(v.checksum) && v.checksum>=0 && v.checksum<=0xffffffff);
  if(expectedChecksum!==null) assert.equal(v.checksum,expectedChecksum,'checksum drift'); return v.checksum;
}
async function cleanup(){
  for(const server of children) if(!server.closed) server.child.kill('SIGTERM');
  await Promise.all(children.map(async server=>{if(server.closed)return;try{await server.waitClose(3000);}catch{server.child.kill('SIGKILL');try{await server.waitClose(3000);}catch{}}}));
}
async function main(){
  let result;
  try {
    const inputs=validateInputs(); report.hashesBefore=inputs.hashes;
    const nodeServer=new Server('node',node,[files.nodeBenchmark]);
    const rustServer=new Server('rust',binary,['prepared_benchmark_server','--ignored','--exact','--nocapture']);
    const nodeReady=await nodeServer.next(), rustReady=await rustServer.next();
    report.readiness={node:nodeReady,rust:rustReady};
    for(const r of [nodeReady.parsed,rustReady.parsed]){assert.equal(r.ready,true);assert.deepEqual(r.pool,inputs.pool);assert.equal(r.repetitions,2000);}
    const n=nodeReady.parsed;
    assert.equal(n.realm,'commonjs');assert.equal(n.crossCheckRealm,'vm');
    assert.equal(n.commonJsCompiledSha,inputs.ref.metadata.compiledSha);assert.equal(n.vmCompiledSha,inputs.ref.metadata.compiledSha);
    assert.equal(n.nodeSha,nodeSha);assert.equal(n.referenceSha,inputs.hashes.reference);assert.deepEqual(n.hashes,inputs.ref.metadata.hashes);
    let checksum=null;
    for(let i=0;i<3;i++){
      const pair={index:i+1};
      for(const server of i%2===0?[nodeServer,rustServer]:[rustServer,nodeServer]){
        report.order.push({phase:'warmup',index:i+1,server:server.name});const reply=await server.command('warmup');checksum=validateResult(reply,checksum);pair[server.name]=reply;
      } report.warmups.push(pair);
    }
    for(let i=0;i<7;i++){
      const pair={index:i+1};
      for(const server of i%2===0?[nodeServer,rustServer]:[rustServer,nodeServer]){
        report.order.push({phase:'trial',index:i+1,server:server.name});const reply=await server.command('run');checksum=validateResult(reply,checksum);pair[server.name]=reply;
      } report.trials.push(pair);
    }
    for(const server of [nodeServer,rustServer]){assert(!server.closed && !server.failure);server.child.stdin.write('quit\n');server.child.stdin.end();}
    await Promise.all([nodeServer.waitClose(),rustServer.waitClose()]);
    for(const server of [nodeServer,rustServer]){assert.deepEqual(server.closed,{code:0,signal:null});assert(!server.failure);assert.equal(server.queue.length,0);}
    report.hashesAfter=fileHashes();assert.deepEqual(report.hashesAfter,report.hashesBefore,'inputs changed during benchmark');
    const median=key=>report.trials.map(t=>BigInt(t[key].parsed.elapsedNs)).sort((a,b)=>a<b?-1:a>b?1:0)[3];
    const nodeMedian=median('node'), rustMedian=median('rust');
    report.metrics={checksum,nodeMedianNs:nodeMedian.toString(),rustMedianNs:rustMedian.toString(),nodeNsPerOp:Number(nodeMedian)/16000,rustNsPerOp:Number(rustMedian)/16000};
    report.status='passed';result=0;
  } catch(error) {
    report.status='failed';report.error=error && error.stack || String(error);result=1;
  } finally {
    await cleanup();
    if(!report.hashesAfter){try{report.hashesAfter=fileHashes();}catch(error){report.postHashError=String(error);}}
    fs.writeFileSync(path.join(reportDir,'caps-paired-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  if(result) { process.stderr.write(report.error+'\n'); process.exitCode=1; }
  else process.stdout.write(JSON.stringify({status:report.status,report:path.join(reportDir,'caps-paired-report.json'),metrics:report.metrics})+'\n');
}
main().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
