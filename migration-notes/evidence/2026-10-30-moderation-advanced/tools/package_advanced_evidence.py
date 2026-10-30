#!/usr/bin/env python3
"""Bind advanced moderation source, paired benchmarks, failed checks and logs."""
import gzip,hashlib,json,subprocess,sys
from pathlib import Path
ROOT=Path('/root/saas-rust');STATE=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');ART=STATE/'artifacts';WAVE=ART/'moderation-advanced';TOOLS=Path(__file__).parent
OUT=ROOT/'migration-notes/evidence/2026-10-30-moderation-advanced'
sha=lambda b:hashlib.sha256(b).hexdigest()
load=lambda p:json.loads(p.read_text())
def git(args):return subprocess.check_output(['git',*args],cwd=ROOT)
def main():
 final_run=sys.argv[1];node_run=sys.argv[2];final_commit=git(['rev-parse','HEAD']).decode().strip()
 assert not OUT.exists(),str(OUT)
 selected=[]
 for p in sorted(ART.glob('*-receipt.json')):
  run=p.name.removesuffix('-receipt.json')
  try:n=int(run.split('-')[-1])
  except ValueError:continue
  if 1793328300000000000<=n<=max(int(final_run.split('-')[-1]),int(node_run.split('-')[-1])):selected.append(run)
 assert final_run in selected and node_run in selected
 receipts={run:load(ART/(run+'-receipt.json')) for run in selected}
 final=receipts[final_run];assert final['success'] and final['production_unchanged']; assert receipts[node_run]['success'] and receipts[node_run]['source_hashes']==final['source_hashes']
 maps={}
 for label,run,commit in [('baseline','compiler-1793329583774986538','5c50d884'),('optimized','compiler-1793330883511993201','71a4ff8c'),('value-adapter',final_run,final_commit)]:
  receipt=receipts[run];assert receipt['success'] and receipt['production_unchanged']
  hashes=receipt['source_hashes'];assert len(hashes)==1392
  assert sha(json.dumps(hashes,sort_keys=True).encode())==receipt['source_tree_sha256']
  sdk={};tracked={}
  previous=load(ROOT/'migration-notes/evidence/2026-10-30-moderation-rule-dispatcher/source-binding.json')['unchangedArchiveVerifiedSdkReferences']
  for name,digest in hashes.items():
   if name.startswith('verification/'):
    assert previous[name]==digest; sdk[name]=digest
   else:
    assert sha(git(['show',commit+':'+name]))==digest,(label,name);tracked[name]=digest
  assert (len(tracked),len(sdk))==(1382,10)
  maps[label]={'gitCommit':git(['rev-parse',commit]).decode().strip(),'receipt':run,'sourceTreeSha256':receipt['source_tree_sha256'],'gitInputs':tracked,'archiveVerifiedSdkInputs':sdk}
 for run,r in receipts.items():
  limits=r['limits'];assert r['limits_verified'] and r['production_unchanged']
  assert limits['cpus']==6 and limits['memory']==limits['memory_swap']==4*1024**3 and limits['pids']==256
  assert r['minimum_available_bytes']>=4*1024**3 and r['headroom_start']['mem_available_bytes']>=5*1024**3
  if r['phase']!='node':assert r['peak_cache_bytes']<=8*1024**3 and limits['cargo_jobs']==2
 for attempt in [1,2]:
  report=load(WAVE/f'paired-attempt{attempt}/advanced-paired-report.json');assert report['status']=='passed',report['status']
  assert report['hashesBefore']==report['hashesAfter']
  count=0
  for workload,data in report['workloads'].items():
   assert len(data['samples'])==7
   for i,sample in enumerate(data['samples']):
    assert sample['order']==(['node','rust'] if i%2==0 else ['rust','node'])
    for actor in ['node','rust']:
     m=sample[actor];assert m['operations']==8000 and m['warmupOperations']==24000 and m['checksum']==data['expected']['checksum'];count+=1
  assert count==70
 OUT.mkdir(parents=True);index={}
 def keep(p,rel):
  raw=p.read_bytes();dest=Path(rel);compressed=len(raw)>65536 or p.suffix=='.log'
  if compressed:dest=dest.with_name(dest.name+'.gz')
  data=gzip.compress(raw,mtime=0) if compressed else raw
  path=OUT/dest;assert not path.exists();path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
  index[str(dest)]={'sha256':sha(data),'bytes':len(data),'rawSha256':sha(raw),'rawBytes':len(raw),'compressed':compressed}
 for name in ['baseline-source','benchmark-attempt1','benchmark-attempt2','paired-attempt1','paired-attempt2','syntax-attempt1','unicode-attempt3']:
  for p in sorted((WAVE/name).rglob('*')):
   if p.is_file():keep(p,Path('artifacts')/p.relative_to(WAVE))
 for name in ['advanced-benchmarks.html','candidate-spotcheck1.json','baseline-benchmark-production-readback.json','optimized-benchmark-production-readback.json','value-adapter-production-readback.json']:
  keep(WAVE/name,Path('artifacts')/name)
 for attempt in [1,2]:keep(WAVE/f'benchmark-export-attempt{attempt}/binary-provenance.json',f'artifacts/benchmark-export-attempt{attempt}/binary-provenance.json')
 for run in selected:
  for suffix in ['-receipt.json','.log']:keep(ART/(run+suffix),Path('runs')/(run+suffix))
 names={'validate.py','apply_format.py','final_readback.py',Path(__file__).name}
 for pattern in ['advanced*','freeze_advanced*.py','freeze_rule_dispatcher.py','freeze_redis_application.py','freeze_seed_retirement.py','freeze_seed_plan.py','freeze_offenses.py','freeze_permit.py','prepare_posthog_sdk.py','re2_syntax_oracle*.sh']:
  names.update(f.name for f in TOOLS.glob(pattern) if f.is_file())
 for name in sorted(names):keep(TOOLS/name,Path('tools')/name)
 def write(name,value):
  dest=OUT/name;dest.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
 write('source-bindings.json',maps)
 write('verification-summary.json',{'acceptedValueAdapterRun':final_run,'acceptedFinalOracleRun':node_run,'codeCommit':final_commit,'baselineCommit':maps['baseline']['gitCommit'],'optimizedCommit':maps['optimized']['gitCommit'],'runs':{k:{a:b for a,b in v.items() if a!='source_hashes'} for k,v in receipts.items()},'applicationSourceCases':464,'semanticSourceCases':84,'semanticViewCrossChecks':83,'parseViewCrossChecks':233,'syntaxCases':4364,'sdkObservations':{'direct':91,'behavior':604,'wrapper':45},'benchmarkRounds':2,'benchmarkActorsPerRound':70,'productionContainers':18,'deployment':False,'push':False,'sourceRetirement':False,'limitations':['bounded regex compatibility corpus and native resource limits','SDK invalid-regex diagnostic wording/class differs','no caller adoption','prepared warm matching benchmark only; no CPU/RSS or production throughput measurement'],'reusedPrerequisiteEvidence':'../2026-10-30-advanced-moderation-prerequisites/index.json'})
 write('index.json',index)
 write('artifact-sha256.json',{str(p.relative_to(OUT)):sha(p.read_bytes()) for p in sorted(OUT.rglob('*')) if p.is_file()})
 print(json.dumps({'output':str(OUT),'runs':len(selected),'files':len(index),'gitInputsPerBinding':1382,'sdkInputsPerBinding':10}))
if __name__=='__main__':main()
