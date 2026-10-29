'use strict';
// Preserve the original TypeScript trials. Only the native implementation hash
// changes; payloads, expected wires, operations and the Node harness stay exact.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const old='/artifacts/ai-credit-receipt-baseline',current='/artifacts/ai-credit-receipt';
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file));
const text=value=>JSON.stringify(value,null,2)+'\n';
const before=read(`${old}/producer/ai_usage_producer_reference.json`),after=read(`${current}/producer/ai_usage_producer_reference.json`);
const changed=[];
for(const [key,hash]of Object.entries(before.metadata.hashes))if(hash!==after.metadata.hashes[key])changed.push(key);
assert.deepEqual(changed,['src/utils/ai_usage_producer.rs']);
const strip=value=>{const copy=structuredClone(value);delete copy.metadata.hashes;return copy;};
assert.deepEqual(strip(before),strip(after),'all source behavior/evidence unchanged');
const oldInputBytes=fs.readFileSync(`${old}/producer-benchmark/ai-usage-producer-benchmark-input.json`);
assert.equal(sha(oldInputBytes),'72a0a095c23891dd0b38bdc095ad5b09018c20dd5f7df98da3bd004e07f34fda');
const input=JSON.parse(oldInputBytes),nativePath='src/utils/ai_usage_producer.rs';
assert.equal(input.hashes[nativePath],before.metadata.hashes[nativePath]);
input.hashes[nativePath]=after.metadata.hashes[nativePath];
const encoded=text(input),newInputSha=sha(encoded);
const oldNodeBytes=fs.readFileSync(`${old}/producer-benchmark/ai-usage-producer-node-benchmark.json`);
const node=JSON.parse(oldNodeBytes);assert.equal(node.inputSha256,sha(oldInputBytes));
node.inputSha256=newInputSha;
fs.writeFileSync(`${current}/producer-benchmark/ai-usage-producer-benchmark-input.json`,encoded,{flag:'wx'});
fs.writeFileSync(`${current}/producer-benchmark/ai-usage-producer-node-benchmark.json`,text(node),{flag:'wx'});
const report={baselineInputSha256:sha(oldInputBytes),inputSha256:newInputSha,baselineNodeReportSha256:sha(oldNodeBytes),changedSourceHashes:changed,behaviorRecordsIdentical:true,nodeTrialsReusedUnchanged:true,changedReportFields:['inputSha256'],scope:'Only native core provenance rebound; source TypeScript, harness, prepared payloads, expected wires, checksums and seven timing trials unchanged.'};
fs.writeFileSync(`${current}/benchmark-reuse-audit.json`,text(report),{flag:'wx'});
console.log(JSON.stringify(report));
