from pathlib import Path
import json,hashlib,statistics
s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');w=s/'artifacts/ledger-persistence-e2e/attempt2';p=w/'prepared'
sha=lambda b:hashlib.sha256(b).hexdigest()
wire=lambda x:json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()
r=json.loads((p/'report.json').read_text());meta=json.loads((p/'source.json').read_text());inputs=json.loads((p/'inputs.json').read_text());dig=json.loads((w/'independent-prepared-hashes.json').read_text());binary=json.loads((w/'binary-provenance.json').read_text())
assert r['status']=='complete' and r['format']==1
for name,digest in dig.items():assert sha((p/name).read_bytes())==digest,name
assert r['inputSha256']==dig['inputs.json'] and r['sourceSha256']==dig['source.json']
assert r['sourceMetadata']==meta and r['nativeExecutableSha256']==binary['binaries'][0]['sha256']
assert sha((w/'bin/ai_usage_persistence_e2e_benchmark').read_bytes())==r['nativeExecutableSha256']
assert r['nodeExecutableSha256']=='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108'
assert sha(wire(meta['nativeHashes']))==r['nativeSourceManifestSha256']
# Rust serde Value sorts object properties; Node retains source DTO order.
# Recompute both pool hashes independently; input values are identical.
assert r['nativePreparedSha256']==sha(json.dumps(inputs['receipts'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode())
assert r['nodeFinish']['preparedSha256']==meta['preparedSha256']==sha(wire(inputs['receipts']))
assert r['cleanup']=={'databaseDropped':True,'redisMarkerDeleted':True}
log=(p/'samples.ndjson').read_bytes();assert sha(log)==r['sampleLogSha256'];assert [json.loads(n) for n in log.splitlines()]==r['samples'];assert len(r['samples'])==28 and len(r['warmups'])==8
workloads=[]
for workload in inputs['workloads']:
 for trial in range(7):
  pair=[v for v in r['samples'] if v['workload']==workload and v['trial']==trial];assert len(pair)==2
  assert [v['actor'] for v in pair]==(['node','rust'] if trial%2==0 else ['rust','node'])
  assert pair[0]['snapshot']==pair[1]['snapshot']
  for v in pair:
   assert v['operations']==32 and int(v['elapsedNs'])>0
   assert v['inserted']==(32 if workload=='insert' else 0) and v['duplicate']==(32 if workload=='duplicate-repair' else 0) and v['expired']==0
   assert v['validation']['receipts']==32 and v['validation']['dailyDays']==8 and v['validation']['dirty'] is True and v['validation']['leaseAbsent'] is True
   assert v['validation']['transactions']==32 and v['validation']['spentCredits']==sum(x['credits'] for x in inputs['receipts'])
   assert sha(wire(v['snapshot']))==v['snapshotSha256']
 actors={}
 for actor in ['node','rust']:
  values=[int(v['elapsedNs'])/32/1e6 for v in r['samples'] if v['workload']==workload and v['actor']==actor]
  actors[actor]={'medianMsPerReceipt':statistics.median(values),'minMsPerReceipt':min(values),'maxMsPerReceipt':max(values),'allSevenMsPerReceipt':values}
 workloads.append({'workload':workload,'operationsPerSample':32,'pairedTrials':7,**actors,'rustMedianTimeReductionPercent':100*(1-actors['rust']['medianMsPerReceipt']/actors['node']['medianMsPerReceipt'])})
receipt=json.loads((s/'artifacts/node-fixtures-1793299654020839804-receipt.json').read_text());assert receipt['success'] and receipt['production_unchanged'] and receipt['source_tree_sha256']==binary['sourceTreeSha256']
out={'scope':r['scope'],'excluded':r['excluded'],'all28ActorSamplesPairOrderBsonSnapshotsCountsHashesAndRecomputedTimingsVerified':True,'reportSha256':sha((p/'report.json').read_bytes()),'inputSha256':r['inputSha256'],'sourceSha256':r['sourceSha256'],'nativeExecutableSha256':r['nativeExecutableSha256'],'nodeExecutableSha256':r['nodeExecutableSha256'],'sourceTreeSha256':receipt['source_tree_sha256'],'workloads':workloads,'cleanup':r['cleanup'],'poolRepresentationBoundary':'Same32 input receipt values. Native pool digest uses serde sorted object keys; Node digest uses original DTO property order. Both independently recomputed.'}
q=w/'independent-helper-report-readback.json'
with q.open('x') as f:f.write(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
