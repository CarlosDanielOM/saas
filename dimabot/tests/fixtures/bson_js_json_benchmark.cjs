'use strict';
// Prepared BSON projection benchmark. All SDK decoding and fixture work precede timing.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const assert=require('node:assert/strict'), {createRequire}=require('node:module');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length);
assert.equal(fs.realpathSync(dir),dir);
const root=fs.realpathSync(process.env.DIMA_BSON_SOURCE_ROOT);
assert.equal(root,process.env.DIMA_BSON_SOURCE_ROOT);
assert(dir!==root && !dir.startsWith(root+path.sep));
assert.deepEqual(fs.readdirSync(dir).sort(),mode==='--write'?[]:['bson-js-json-input.json','bson-js-json-node.json','bson-js-json-rust-borrowed.json','bson-js-json-rust.json']);
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)),nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode],['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const req=createRequire(path.join(root,'package.json')), mongoose=req('mongoose');
assert.equal(mongoose.version,'8.24.2');
const mreq=createRequire(req.resolve('mongoose')), driverPath=mreq.resolve('mongodb/lib/bson.js'), driver=mreq('mongodb/lib/bson.js');
const breq=createRequire(driverPath), bsonPath=breq.resolve('bson'), bson=breq('bson');
const mongoPackage=mreq.resolve('mongodb/package.json'), bsonPackage=path.join(path.dirname(bsonPath),'..','package.json');
const pins={bson:[bsonPath,'64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284'],bsonPackage:[bsonPackage,'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23'],mongodb:[driverPath,'1880a069aa02d09798a3a082d77198aafa4a2d6a1c0315691f25820b58c025ea'],mongodbPackage:[mongoPackage,'54edfda15c69f02c7d6ddf045f339caa1c94cef76b45c2383e1b35071024241b'],mongoosePackage:[req.resolve('mongoose/package.json'),'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba']};
for(const [file,hash] of Object.values(pins)) assert.equal(sha(fs.readFileSync(file)),hash);
assert.equal(JSON.parse(fs.readFileSync(mongoPackage)).version,'6.20.0');
assert.equal(JSON.parse(fs.readFileSync(bsonPackage)).version,'6.10.4');
const options=driver.resolveBSONOptions({});
assert.deepEqual(options,{raw:false,useBigInt64:false,promoteLongs:true,promoteValues:true,promoteBuffers:false,ignoreUndefined:false,bsonRegExp:false,serializeFunctions:false,fieldsAsRaw:{},enableUtf8Validation:true});
const files=['src/utils/bson_js_json.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/credit_policy.rs','src/utils/json_number.rs','tests/bson_js_json.rs','tests/fixtures/bson_js_json_reference.cjs','tests/bson_js_json_benchmark.rs','tests/fixtures/bson_js_json_benchmark.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
const {Long,Double,Int32,Decimal128,ObjectId,Binary,Timestamp,Code,MinKey,MaxKey}=bson;
const definitions=[['ordinary-numeric',65536],['nested-mixed',65536],['bson-specials',65536],['large-context-arrays',4096]];
const sum=bytes=>{let s=0; for(const b of bytes) s=(s+b)>>>0; return s;};
function make(name,i) {
  if(name==='ordinary-numeric') return {id:i,text:`hello café ${i}`,int:new Int32(i-16),fraction:new Double(i/8),nan:new Double(NaN),inf:new Double(Infinity),negativeZero:new Double(-0),small:Long.fromString('9007199254740992'),large:Long.fromString('9007199254740993')};
  if(name==='nested-mixed') return {id:i,outer:{'10':'ten','2':'two',items:[i,null,true,`😀-${i}`,{nested:[1,2,{x:i}]}]},date:new Date(1700000000000+i*1000)};
  if(name==='bson-specials') return {id:i,oid:new ObjectId('00112233445566778899aabb'),date:new Date(i*1000),binary:new Binary(Buffer.from([i,1,254,255])),uuid:new Binary(Buffer.from('00112233445566778899aabbccddeeff','hex'),4),decimal:Decimal128.fromString('1.23400'),timestamp:new Timestamp({t:100+i,i}),code:new Code('x+1'),min:new MinKey(),max:new MaxKey()};
  return {id:i,context:`${'metadata-é😀'.repeat(64)}-${i}`,items:Array.from({length:64},(_,j)=>({n:j+i,text:`item-${i}-${j}`,active:j%2===0,values:[j,j/4,null]}))};
}
const workloads=definitions.map(([name,iterations])=>({name,iterations,warmup:iterations,pool:Array.from({length:32},(_,i)=>{const raw=bson.serialize(make(name,i),{ignoreUndefined:false}); const value=driver.deserialize(raw,options); const wire=JSON.stringify(value); assert.equal(typeof wire,'string'); return {hex:raw.toString('hex'),wire,checksum:sum(Buffer.from(wire,'utf8'))};})}));
const input={format:1,label:'prepared BSON projection + JSON + UTF-8 byte sum',nodeSha,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,mongoose:mongoose.version,mongodb:'6.20.0',bson:'6.10.4'},options,sdkHashes:Object.fromEntries(Object.entries(pins).map(([k,v])=>[k,v[1]])),sourceHashes:hashes,workloads};
const inputBytes=JSON.stringify(input,null,2)+'\n',inputSha256=sha(inputBytes);
const inputPath=path.join(dir,'bson-js-json-input.json'),nodePath=path.join(dir,'bson-js-json-node.json'),rustPath=path.join(dir,'bson-js-json-rust.json'),borrowedPath=path.join(dir,'bson-js-json-rust-borrowed.json');
function expected(w) {let s=0; for(let i=0;i<w.iterations;i++) s=(s+w.pool[i%32].checksum)>>>0; return s;}
function validate(report,runtime) {
  assert.equal(report.format,1); assert.equal(report.label,input.label); assert.equal(report.runtime,runtime); assert.equal(report.inputSha256,inputSha256); assert.equal(report.workloads.length,workloads.length);
  report.workloads.forEach((r,i)=>{const w=workloads[i],e=expected(w); assert.equal(r.name,w.name); assert.equal(r.iterations,w.iterations); assert.equal(r.warmup,w.warmup); assert.equal(r.checksum,e); assert.equal(r.samples.length,7); assert.deepEqual(r.sampleChecksums,Array(7).fill(e)); for(const n of r.samples) assert(Number.isSafeInteger(n)&&n>0); assert.equal(r.medianNs,[...r.samples].sort((a,b)=>a-b)[3]);});
}
if(mode==='--write') {
  fs.writeFileSync(inputPath,inputBytes,{flag:'wx'});
  const results=workloads.map(w=>{
    const pool=w.pool.map(p=>driver.deserialize(Buffer.from(p.hex,'hex'),options));
    pool.forEach((v,i)=>assert.equal(JSON.stringify(v),w.pool[i].wire));
    function run(count) {let s=0; for(let i=0;i<count;i++) {const bytes=Buffer.from(JSON.stringify(pool[i%32]),'utf8'); for(const b of bytes) s=(s+b)>>>0;} return s;}
    assert.equal(run(w.warmup),expected(w));
    const samples=[],sampleChecksums=[];
    for(let i=0;i<7;i++) {const start=process.hrtime.bigint(), actual=run(w.iterations), elapsed=Number(process.hrtime.bigint()-start); assert(Number.isSafeInteger(elapsed)&&elapsed>0); assert.equal(actual,expected(w)); samples.push(elapsed); sampleChecksums.push(actual);}
    return {name:w.name,iterations:w.iterations,warmup:w.warmup,checksum:expected(w),samples,sampleChecksums,medianNs:[...samples].sort((a,b)=>a-b)[3]};
  });
  const report={format:1,label:input.label,runtime:'node-commonjs',inputSha256,workloads:results}; validate(report,'node-commonjs'); fs.writeFileSync(nodePath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
} else {assert.equal(fs.readFileSync(inputPath,'utf8'),inputBytes); validate(JSON.parse(fs.readFileSync(nodePath)),'node-commonjs'); validate(JSON.parse(fs.readFileSync(rustPath)),'rust-release'); validate(JSON.parse(fs.readFileSync(borrowedPath)),'rust-release-borrowed');}
console.log(JSON.stringify({mode,inputSha256}));
