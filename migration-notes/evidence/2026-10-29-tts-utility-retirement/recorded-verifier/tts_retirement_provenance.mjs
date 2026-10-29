import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const root='/source/dimabot';const base='/artifacts/tts-utility-retirement';
const require=createRequire(path.join(root,'package.json'));
const aliases={'typescript-entry':require.resolve('typescript'),'typescript-implementation':require.resolve('typescript'),'mongoose-entry':require.resolve('mongoose')};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const reports=[];
for(const relative of ['expressive/expressive-tts-reference.json','credit/tts-credit-fallback-reference.json','settings/channel-tts-settings-reference.json','fish/fish-tts-reference.json','piper-kokoro/piper-kokoro-reference.json','runtime/tts_runtime_reference.json','runtime/tts_runtime_dynamic_reference.json','benchmark-tooling-smoke/expressive-node-benchmark.json','normalization-prepared/fixtures.json']){
 const bytes=await fs.readFile(path.join(base,relative));const document=JSON.parse(bytes);const p=document.provenance??document;const hashes=p.sourceHashes??p.hashes;
 assert.ok(hashes&&Object.keys(hashes).length,'missing provenance '+relative);
 if(p.node)assert.equal(p.node.replace(/^v/,''),process.versions.node);
 if(p.v8??p.versions?.v8)assert.equal(p.v8??p.versions.v8,process.versions.v8);
 const checked=[];
 for(const [logical,expected] of Object.entries(hashes)){
  assert.ok(logical==='node-executable'||Object.hasOwn(aliases,logical)||['package.json','package-lock.json'].includes(logical)||/^(src|tests|node_modules)\//.test(logical),logical);
  let resolved=logical==='node-executable'?process.execPath:aliases[logical]??path.join(root,logical);
  if(logical.startsWith('src/')){
   const archive=path.join('/source/archives/dimabot-typescript/2026-10-28',logical);
   const live=await fs.access(resolved).then(()=>true,()=>false);const retired=await fs.access(archive).then(()=>true,()=>false);
   assert.notEqual(live,retired,'source must exist exactly once '+logical);if(retired)resolved=archive;
   if(p.sourcePaths?.[logical])assert.equal(path.relative(root,resolved),p.sourcePaths[logical]);
  }
  assert.equal(sha(await fs.readFile(resolved)),expected,logical);checked.push({logical,resolvedPath:resolved});
 }
 reports.push({fixture:relative,sha256:sha(bytes),sourceEntriesVerified:checked.length,sources:checked});
}
const semantic=[];
const comparisons=[
 ['expressive/expressive-tts-reference.json','/artifacts/tts-tag-types/expressive-tts-reference.json',['metadata','cases']],
 ['credit/tts-credit-fallback-reference.json','/artifacts/tts-credit-fallback/tts-credit-fallback-reference.json',['cases']],
 ['settings/channel-tts-settings-reference.json','/artifacts/channel-tts-settings/channel-tts-settings-reference.json',['metadata','defaultAfterMutation','cases','schemaCases']],
 ['fish/fish-tts-reference.json','/artifacts/fish-tts/fish-tts-reference.json',['cases','publicPathCases']],
 ['piper-kokoro/piper-kokoro-reference.json','/artifacts/piper-kokoro/piper-kokoro-reference.json',['cases','publicPathCases']],
 ['runtime/tts_runtime_reference.json','/artifacts/tts-runtime/tts_runtime_reference.json',null],
 ['runtime/tts_runtime_dynamic_reference.json','/artifacts/tts-runtime/tts_runtime_dynamic_reference.json',['cases']],
 ['normalization-prepared/fixtures.json','/artifacts/tts-normalization-prepared/fixtures.json',['workloads']],
];
const normalize=(value,from,to)=>typeof value==='string'?value.split(from).join(to):Array.isArray(value)?value.map(v=>normalize(v,from,to)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,from,to)])):value;
for(const [current,previous,selected] of comparisons){
 const before=JSON.parse(await fs.readFile(previous,'utf8'));
 const after=JSON.parse(await fs.readFile(path.join(base,current),'utf8'));const fields=selected??Object.keys(before).filter(k=>k!=='provenance');
 const oldRoot=path.dirname(previous);const newRoot=path.dirname(path.join(base,current));
 for(const field of fields)assert.deepEqual(normalize(after[field],newRoot,'<owned-fixture-root>'),normalize(before[field],oldRoot,'<owned-fixture-root>'),current+':'+field);
 semantic.push({fixture:current,previous,fields,comparison:'exact semantic equality; owned fixture root strings normalized only'});
}
const benchmark=JSON.parse(await fs.readFile(path.join(base,'benchmark-tooling-smoke/expressive-benchmark-inputs.json'),'utf8'));
const input=await fs.readFile(path.join(base,'benchmark-tooling-smoke/expressive-benchmark-inputs.json'));assert.equal(sha(input),'95bbc229a92de5f1b8d12c36e69ab2af3ed06cee160ec31dfe1d24c812a6b195');assert.equal(benchmark.workloads.length,9);
await fs.writeFile(path.join(base,'provenance-and-semantic-parity.json'),JSON.stringify({node:process.version,v8:process.versions.v8,reports,semantic,benchmarkInputSha256:sha(input),benchmarkInterpretation:'Node tooling execution only; no new paired benchmark or performance claim'},null,2)+'\n');
console.log(JSON.stringify({sourceFixtureReports:reports.map(x=>({fixture:x.fixture,sourceEntries:x.sourceEntriesVerified})),semanticComparisons:semantic.length,benchmarkInputSha256:sha(input)}));
