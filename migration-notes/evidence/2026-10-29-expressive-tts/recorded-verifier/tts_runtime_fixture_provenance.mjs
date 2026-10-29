import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const inputs=['fish-tts/fish-sdk-protocol.json','fish-tts/fish-tts-reference.json','piper-kokoro/piper-kokoro-reference.json','fish-catalog/fish-catalog-reference.json'];
const reports=[];const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const input of inputs){
 const bytes=await fs.readFile('/artifacts/'+input);const fixture=JSON.parse(bytes);assert.equal(fixture.provenance.node,process.version);assert.equal(fixture.provenance.versions.v8,process.versions.v8);
 const checked=[];
 for(const [file,expected] of Object.entries(fixture.provenance.sourceHashes)){
  assert.ok(file==='node-executable'||['package.json','package-lock.json'].includes(file)||/^(src|tests|node_modules)\//.test(file));
  const filename=file==='node-executable'?process.execPath:'/source/dimabot/'+file;
  assert.equal(hash(await fs.readFile(filename)),expected,file);checked.push(file);
 }
 reports.push({fixture:input,sha256:hash(bytes),sourceEntriesVerified:checked.length,sourceFiles:checked});
}
await fs.writeFile('/artifacts/tts-runtime/reused-fixture-provenance.json',JSON.stringify({node:process.version,v8:process.versions.v8,reports},null,2)+'\n');
console.log(JSON.stringify(reports.map(({fixture,sha256,sourceEntriesVerified})=>({fixture,sha256,sourceEntriesVerified}))));
