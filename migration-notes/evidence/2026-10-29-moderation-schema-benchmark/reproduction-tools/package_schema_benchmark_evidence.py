import gzip,hashlib,json,re,statistics,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-schema-benchmark/attempt1';out=root/'migration-notes/evidence/2026-10-29-moderation-schema-benchmark'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
commit=git('rev-parse','84f95db0').decode().strip();finalhash='661a18bbdb26c596f586587f839e750dfd9adc9837a6ec588d7073f26634f8fe';accepted=['node-1793312408188925296','compiler-1793312408192802668','node-1793312710512591234','compiler-1793312997059829717'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text());inputs=json.loads((wave/'source-inputs.json').read_text());assert inputs==final['source_hashes'] and len(inputs)==1343
prior=json.loads((root/'migration-notes/evidence/2026-10-29-moderation-schema/source-binding.json').read_text());previous=prior['gitFileHashes']|prior['unchangedArchiveVerifiedSdkReferences'];assert len(previous)==1341 and all(inputs.get(k)==v for k,v in previous.items());added={k:v for k,v in inputs.items() if k not in previous};assert len(added)==2
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());gh={};sdk={}
for n,d in inputs.items():
 if n.startswith('verification/'):assert old['unchangedArchiveVerifiedSdkReferences'][n]==d;sdk[n]=d
 else:assert sha(git('show',commit+':'+n))==d,n;gh[n]=d
assert len(sdk)==10
inputsha='3a71358904c70226586adad936e0fc2394da43868a37a36169c49a497a97d5e1';binsha='7d00051b9adac3d809c3a4d4cc121a88086d4bf6a36bd790fe4112a6a3a188a2';assert sha((wave/'inputs/channel-moderation-settings-benchmark-input.json').read_bytes())==inputsha and sha((wave/'bin/channel_moderation_settings_benchmark').read_bytes())==binsha
ind=json.loads((wave/'independent-input-readback.json').read_text());assert ind['inputSha256']==inputsha and ind['all24CanonicalWiresAndChecksumsVerified'] and ind['allPreparedSourceNativeSdkHashesVerified'] and set(ind['pools'].values())=={8}
report=json.loads((wave/'paired1/moderation-schema-paired-report.json').read_text());assert report['status']=='passed' and report['hashesBefore']==report['hashesAfter'] and all(s['exit']['code']==0 and s['exit']['signal'] is None for s in report['servers'].values());assert report['hashesBefore']['artifacts']['input']==inputsha and report['hashesBefore']['artifacts']['binary']==binsha
expected={'defaults':433599429,'four-rules':4060612453,'invalid':4163112709};metrics={};order=[]
for name,checksum in expected.items():
 w=report['workloads'][name];assert len(w['warmups'])==3 and len(w['trials'])==7
 for phase,key in [('warmup','warmups'),('run','trials')]:
  for i,row in enumerate(w[key],1):
   assert row['index']==i
   servers=['node','rust'] if i%2 else ['rust','node']
   for server in servers:
    order.append({'workload':name,'phase':phase,'index':i,'server':server});v=row[server];assert json.loads(v['raw'])==v['parsed'];p=v['parsed'];assert p['workload']==name and p['total']==8000 and p['checksum']==checksum and int(p['elapsedNs'])>0
 vals={server:[int(row[server]['parsed']['elapsedNs'])/8000 for row in w['trials']] for server in ['node','rust']};n=statistics.median(vals['node']);r=statistics.median(vals['rust']);assert max(vals['rust'])<min(vals['node']);metrics[name]={'nodeMedianNs':n,'rustMedianNs':r,'nodeRangeNs':[min(vals['node']),max(vals['node'])],'rustRangeNs':[min(vals['rust']),max(vals['rust'])],'lowerMedianPercent':100*(1-r/n),'checksum':checksum}
assert report['order']==order and len(order)==60
readback=json.loads((wave/'independent-timing-readback.json').read_text());assert readback['reportSha256']==sha((wave/'paired1/moderation-schema-paired-report.json').read_bytes())
for n,v in metrics.items():
 for k in v:
  assert v[k]==readback['workloads'][n][k] or (isinstance(v[k],float) and abs(v[k]-readback['workloads'][n][k])<1e-10),(n,k)
prod=json.loads((wave/'final-readback.json').read_text());assert prod['productionUnchanged'] and prod['productionRecords']==19 and all(not x for x in prod['remainingOwnedResources'].values())
retained={};compressed={}
def write(n,o):
 p=out/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(o,indent=2)+'\n')
def keep(p,n):
 b=p.read_bytes();q=out/n;q.parent.mkdir(parents=True,exist_ok=True)
 if len(b)>65536 or p.suffix=='.log':q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(b,mtime=0));compressed[str(q.relative_to(out))]={'rawSha256':sha(b),'rawBytes':len(b),'compressedSha256':sha(q.read_bytes())}
 else:q.write_bytes(b)
 retained[str(n)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(b),'rawBytes':len(b)}
for p in sorted(wave.rglob('*')):
 if p.is_file():keep(p,Path('artifacts/attempt1')/p.relative_to(wave))
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793312354712071424<=int(m[2])<=1793312997059829717:
  r=json.loads(p.read_text());run=p.stem.removesuffix('-receipt');log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file() and r['success'] and r['production_unchanged'];assert run not in accepted or r['source_tree_sha256']==finalhash
  runs.append({'run':run,'sourceTreeSha256':r['source_tree_sha256'],'classification':'accepted final' if run in accepted else 'successful preformat nonfinal','success':True,'productionUnchanged':True});keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
assert len(runs)==5
names={'validate.py','freeze_schema_benchmark.py','freeze_moderation_schema.py','freeze_permit.py','apply_format.py','prepare_posthog_sdk.py','final_readback.py','export_schema_benchmark.py','moderation_schema_paired_coordinator.cjs',Path(__file__).name}
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name in names or p.name.startswith('schema_benchmark') and p.suffix=='.sh'):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':finalhash,'gitFileHashes':gh,'unchangedArchiveVerifiedSdkReferences':sdk,'priorSchemaInputsIdentical':len(previous),'addedBenchmarkInputs':added,'inputManifest':'artifacts/attempt1/source-inputs.json.gz'})
write('verification-summary.json',{'acceptedRuns':accepted,'runs':runs,'inputSha256':inputsha,'binarySha256':binsha,'sourceInputs':len(inputs),'metrics':metrics,'warmupsEach':3,'trialsEach':7,'opsPerSample':8000,'productionUnchangedRecords':19,'remainingOwnedResources':prod['remainingOwnedResources'],'scope':'Paired source constructor, validateSync and toObject versus native BSON construction. Excludes database, parsing, IPC, JSON serialization, canonicalization, hash and destruction; results held during timing. Eight equally weighted inputs per pool. Not production latency or statistical production evidence.','adopted':False,'archived':False,'deployed':False,'pushed':False})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('''# Moderation schema benchmark evidence\n\nFour accepted runs bind to commit `84f95db0` and 1,343 inputs: all 1,341 inputs from the earlier accepted schema binding are unchanged, with two benchmark inputs added. The preformat run is preserved separately. All wave artifacts, including the static binary, input, raw paired report and existing comparison HTML, are retained.\n\nThree warmups and seven paired trials per workload used alternating server order and 8,000 operations per sample. Independently recomputed medians in ns/op (Node / Rust) were 145,969.82925 / 10,361.43075 for defaults, 1,299,941.509125 / 112,769.9455 for four rules, and 323,482.888625 / 20,378.014125 for invalid inputs. Every trial checksum matched; measured ranges did not overlap. Both servers exited successfully, before/after hashes matched, and the post-run fixture check used the same input.\n\nThe timer covers source constructor, validation and conversion versus native BSON construction with results retained. Database work, parsing, IPC, JSON output, canonicalization, hashing and result destruction are outside it. Each pool has eight equally weighted inputs rather than a production traffic distribution. These measurements do not establish production latency, CPU, RSS or statistical production impact. The final readback records 19 unchanged production records and no remaining owned resources. No adoption, archive, deployment or push is claimed.\n''')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()});print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'inputs':len(inputs),'retained':len(retained),'metrics':metrics}))
