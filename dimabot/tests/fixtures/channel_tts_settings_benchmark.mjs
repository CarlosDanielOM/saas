// Isolated runtime: node channel_tts_settings_benchmark.mjs SOURCE_REFERENCE_JSON OUTPUT_DIR
// Both implementations consume the emitted prepared workloads; timed work is
// normalization, JSON.stringify/serialization, UTF-8 encoding and all-byte sum.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadSource,decodeCase} from './channel_tts_settings_reference.mjs';
const [fixturePath,outputDir,...extra]=process.argv.slice(2);
if(!fixturePath || !outputDir || extra.length) throw Error('usage: SOURCE_REFERENCE_JSON OUTPUT_DIR');
const source=await loadSource();
const fixtureBytes=await fs.readFile(fixturePath); const fixture=JSON.parse(fixtureBytes);
if(fixture.schema!==1 || !Array.isArray(fixture.cases) || fixture.cases.length<250) throw Error('invalid or missing fixture');
for(const [name,hash] of Object.entries(source.hashes)) if(fixture.provenance.hashes[name]!==hash) throw Error(`fixture provenance mismatch ${name}`);
// Numeric indices are intentionally not relied on: select a stable representative
// from each family and carry exact inputs and outputs into the benchmark document.
const choose = name => fixture.cases.find(x => x.name===name);
const selected=[choose('empty'),choose('provider-kokoro'),fixture.cases.find(x=>x.name.startsWith('number-') && x.inputJson.includes('12.9')),choose('tag-long-pause')];
if(selected.some(x=>!x || !x.ok)) throw Error('missing workload');
const large={channel:'large 😀',voices:{en:'a'.repeat(4000),es:'b'.repeat(4000)},filters:{expressiveTags:{inline:{happy:false,whisper:false}},maxLength:'0x100'},queue:{maxItems:12}};
selected.push({name:'large',inputJson:JSON.stringify(large),ok:true});
// A stored settings record normally contains every tag; include that read path,
// rather than measuring only absent or sparse tag objects.
const saved=source.api.createDefaultChannelTtsSettings('stored-id','saved-channel');
for (const [index,tag] of source.tags.EXPRESSIVE_TTS_TAGS.entries()) saved.filters.expressiveTags[tag]=index%2===0;
saved.provider='kokoro'; saved.voices.kokoroDefault='af_heart';
selected.push({name:'saved-all-tags',inputJson:JSON.stringify(saved),ok:true});
const id='id-😀\ud800',channel=' fallback ';
const prepared=selected.map(c=>{
  const input=decodeCase(c), outputJson=JSON.stringify(source.api.normalizeChannelTtsSettings(input,id,channel));
  if(c.outputJson && outputJson!==c.outputJson) throw Error(`oracle mismatch: ${c.name}`);
  return {name:c.name,input,inputJson:c.inputJson,outputJson,iterations:c.name==='large'?1000:10000};
});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const workloads=prepared.map(({input,...w})=>w);
await fs.mkdir(outputDir,{recursive:true});
const inputs=JSON.stringify({schema:1,idJson:JSON.stringify(id),channelJson:JSON.stringify(channel),workloads},null,2)+'\n';
await fs.writeFile(path.join(outputDir,'channel-tts-settings-benchmark-inputs.json'),inputs);
const runs=[];
for(const w of prepared){
  const run=()=>Buffer.from(JSON.stringify(source.api.normalizeChannelTtsSettings(w.input,id,channel)),'utf8');
  for(let i=0;i<100;i++){const bytes=run();let sum=0;for(const b of bytes)sum=(sum+b)>>>0;if(sum<0) throw Error('unreachable');}
  const samples=[];
  for(let sample=0;sample<7;sample++){
    let bytes=0,checksum=0;const start=process.hrtime.bigint();
    for(let i=0;i<w.iterations;i++){const output=run();bytes+=output.length;for(const b of output)checksum=(checksum+b)>>>0;}
    samples.push({elapsedNs:(process.hrtime.bigint()-start).toString(),bytes,checksum});
  }
  runs.push({name:w.name,iterations:w.iterations,samples});
}
const report={implementation:'actual-typescript',scope:'prepared normalize + JSON + UTF-8 + full byte sum',warmups:100,runs,provenance:{...source.hashes,benchmark:sha(await fs.readFile(fileURLToPath(import.meta.url))),fixture:sha(fixtureBytes),inputs:sha(inputs)}};
await fs.writeFile(path.join(outputDir,'channel-tts-settings-node-benchmark.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({workloads:workloads.length,runs}));
