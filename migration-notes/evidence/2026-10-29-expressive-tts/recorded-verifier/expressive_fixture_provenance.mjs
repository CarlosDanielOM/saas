import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const inputs=['fish-tts/fish-sdk-protocol.json','fish-tts/fish-tts-reference.json','piper-kokoro/piper-kokoro-reference.json','fish-catalog/fish-catalog-reference.json','tts-credit-fallback/tts-credit-fallback-reference.json'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const reports=[];
for(const input of inputs){
 const bytes=await fs.readFile('/artifacts/'+input); const fixture=JSON.parse(bytes);const p=fixture.provenance;
 assert.equal(p.node,process.version);assert.equal(p.versions?.v8??p.v8,process.versions.v8);
 const checked=[];
 for(const [file,expected] of Object.entries(p.sourceHashes??p.hashes)){
  assert.ok(file==='node-executable'||['package.json','package-lock.json'].includes(file)||/^(src|tests|node_modules)\//.test(file));
  let filename=file==='node-executable'?process.execPath:'/source/dimabot/'+file;
  if(file.startsWith('src/')){
   const archive='/source/archives/dimabot-typescript/2026-10-28/'+file;
   const activeExists=await fs.access(filename).then(()=>true,()=>false);const archiveExists=await fs.access(archive).then(()=>true,()=>false);
   assert.notEqual(activeExists,archiveExists,'expected exactly one live/archive source '+file);
   if(archiveExists)filename=archive;
  }
  assert.equal(hash(await fs.readFile(filename)),expected,file);checked.push({source:file,resolvedPath:filename});
 }
 reports.push({fixture:input,sha256:hash(bytes),sourceEntriesVerified:checked.length,sourceFiles:checked});
}
await fs.writeFile('/artifacts/expressive-tts/reused-fixture-provenance.json',JSON.stringify({node:process.version,v8:process.versions.v8,reports},null,2)+'\n');
console.log(JSON.stringify(reports.map(({fixture,sha256,sourceEntriesVerified})=>({fixture,sha256,sourceEntriesVerified}))));
