'use strict';
// Persistent server: inputs and result storage are prepared outside the timer.
// Coordinator sends warmup/run commands alternately to this process and Rust.
const fs=require('node:fs'), readline=require('node:readline'), assert=require('node:assert/strict');
const lib=require('./moderation_caps_source.cjs');
const data=JSON.parse(fs.readFileSync(process.env.DIMA_CAPS_REFERENCE_DIR+'/moderation_caps_reference.json','utf8'));
assert.deepEqual(data.metadata.hashes,lib.hashes); assert.deepEqual(data.metadata.pins,lib.pins);
const bits=b=>{const v=Buffer.alloc(8);v.writeBigUInt64BE(BigInt('0x'+b));return v.readDoubleBE();};
const string=u=>String.fromCharCode(...u);
const pool=data.cases.filter(c=>c.id.startsWith('bench-')).map(c=>({id:c.id, input:{text:string(c.text), emoteTexts:c.emotes===null?undefined:c.emotes.map(string)}, rule:{capsThresholdMode:c.mode,minCapsCount:bits(c.min),maxCapsPercentage:bits(c.max),minMessageLength:bits(c.length)}, expected:c}));
assert.equal(pool.length,8);
for(const p of pool){const v=lib.exports.evaluateCapsRule(p.rule,p.input); assert.equal(JSON.stringify(v),p.expected.wire);}
const repetitions=Number(process.env.DIMA_CAPS_BENCH_REPETITIONS || 2000); assert(Number.isSafeInteger(repetitions)&&repetitions>0&&repetitions<=100000);
const total=pool.length*repetitions;
const mix=(h,v)=>Math.imul(h^(v>>>0),16777619)>>>0;
function run(){
 const results=new Array(total);
 const start=process.hrtime.bigint();
 for(let i=0;i<total;i++){const p=pool[i%pool.length]; results[i]=lib.exports.evaluateCapsRule(p.rule,p.input);}
 const elapsed=process.hrtime.bigint()-start;
 let hash=2166136261; const b=Buffer.alloc(8);
 for(const v of results){b.writeDoubleBE(v.capsPercentage); hash=mix(hash,v.triggered?1:0);hash=mix(hash,v.capsCount);hash=mix(hash,v.letterCount);hash=mix(hash,b.readUInt32BE(0));hash=mix(hash,b.readUInt32BE(4));}
 return {elapsedNs:elapsed.toString(),checksum:hash,total};
}
console.log(JSON.stringify({ready:true,pool:pool.map(p=>p.id),repetitions,hashes:lib.hashes,nodeSha:lib.nodePin,referenceSha:lib.sha(fs.readFileSync(process.env.DIMA_CAPS_REFERENCE_DIR+'/moderation_caps_reference.json'))}));
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{if(line==='run'||line==='warmup') console.log(JSON.stringify(run()));else if(line==='quit') process.exit(0);else throw Error('unknown command');});
