#!/usr/bin/env python3
"""Preserve exact verified variation/NFC sources, actors and failed checks."""
import gzip,hashlib,json,statistics,subprocess,sys
from pathlib import Path
ROOT=Path('/root/saas-rust');STATE=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');ART=STATE/'artifacts';WAVE=ART/'moderation-variations';TOOLS=Path(__file__).parent
OUT=ROOT/'migration-notes/evidence/2026-10-30-moderation-variations'
sha=lambda b:hashlib.sha256(b).hexdigest();load=lambda p:json.loads(p.read_text())
def git(args):return subprocess.check_output(['git',*args],cwd=ROOT)
def main():
 final_node=sys.argv[1];final_commit=git(['rev-parse','HEAD']).decode().strip();assert not OUT.exists()
 upper=int(final_node.split('-')[-1]);runs=[]
 for p in sorted(ART.glob('*-receipt.json')):
  run=p.name.removesuffix('-receipt.json')
  try:n=int(run.split('-')[-1])
  except ValueError:continue
  if 1793333090000000000<=n<=upper:runs.append(run)
 receipts={run:load(ART/(run+'-receipt.json')) for run in runs};assert receipts[final_node]['success']
 for run,r in receipts.items():
  lim=r['limits'];assert r['production_unchanged'] and r['limits_verified'];assert lim['cpus']==6 and lim['memory']==lim['memory_swap']==4*1024**3 and lim['pids']==256
  assert r['headroom_start']['mem_available_bytes']>=5*1024**3 and r['minimum_available_bytes']>=4*1024**3
  if r['phase']!='node':assert lim['cargo_jobs']==2 and r['peak_cache_bytes']<=8*1024**3
 previous=load(ROOT/'migration-notes/evidence/2026-10-30-moderation-rule-dispatcher/source-binding.json')['unchangedArchiveVerifiedSdkReferences'];bindings={}
 for label,run,commit,count in [('initial','compiler-1793333693921757368','3cb64568',1402),('cache-and-types','compiler-1793334353011847518','9b3803b4',1403),('nfc-utf8','compiler-1793335018338289470',final_commit,1403)]:
  r=receipts[run];assert r['success'];h=r['source_hashes'];assert len(h)==count and sha(json.dumps(h,sort_keys=True).encode())==r['source_tree_sha256'];tracked={};sdk={}
  for name,digest in h.items():
   if name.startswith('verification/'):assert previous[name]==digest;sdk[name]=digest
   else:assert sha(git(['show',commit+':'+name]))==digest,(label,name);tracked[name]=digest
  assert len(sdk)==10
  bindings[label]={'gitCommit':git(['rev-parse',commit]).decode().strip(),'receipt':run,'sourceTreeSha256':r['source_tree_sha256'],'gitInputs':tracked,'archiveVerifiedSdkInputs':sdk}
 medians={}
 for attempt in [1,2,3]:
  d=WAVE/f'paired-attempt{attempt}';r=load(d/'variations-paired-report.json');assert r['status']=='passed' and r['hashesBefore']==r['hashesAfter'] and len(r['order'])==70;metrics={};n=0
  for name,data in r['workloads'].items():
   assert len(data['samples'])==7;metrics[name]={}
   for actor in ['node','rust']:
    values=[]
    for i,s in enumerate(data['samples']):
     assert s['order']==(['node','rust'] if i%2==0 else ['rust','node']);m=load(d/f'sample-{actor}-{name}-{i+1}.json');assert m==s[actor] and m['operations']==8000 and m['warmupOperations']==24000 and m['checksum']==data['expected']['checksum'];values.append(int(m['nanoseconds'])/8000);n+=1
    assert statistics.median(values)==data['metrics'][actor]['medianNsPerOperation'];metrics[name][actor]=statistics.median(values)
  assert n==70;medians[str(attempt)]=metrics
 OUT.mkdir(parents=True);index={}
 def keep(p,rel):
  raw=p.read_bytes();dest=Path(rel);compress=len(raw)>65536 or p.suffix=='.log'
  if compress:dest=dest.with_name(dest.name+'.gz')
  data=gzip.compress(raw,mtime=0) if compress else raw;f=OUT/dest;assert not f.exists();f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data);index[str(dest)]={'sha256':sha(data),'bytes':len(data),'rawSha256':sha(raw),'rawBytes':len(raw),'compressed':compress}
 for p in sorted(WAVE.rglob('*')):
  if p.is_file() and p.name!='moderation_variations_benchmark':keep(p,Path('artifacts')/p.relative_to(WAVE))
 for p in sorted((ART/'js-unicode-nfc').rglob('*')):
  if p.is_file():keep(p,Path('artifacts/js-unicode-nfc')/p.relative_to(ART/'js-unicode-nfc'))
 for run in runs:
  for suffix in ['-receipt.json','.log']:keep(ART/(run+suffix),Path('runs')/(run+suffix))
 names={'validate.py','apply_format.py','final_readback.py',Path(__file__).name}
 for pattern in ['variations*','nfc_oracle*.sh','export_variations*.py','freeze_var*.py','freeze_advanced_oracle.py','freeze_rule_dispatcher.py','freeze_redis_application.py','freeze_seed_retirement.py','freeze_seed_plan.py','freeze_offenses.py','freeze_permit.py','prepare_posthog_sdk.py']:
  names.update(p.name for p in TOOLS.glob(pattern) if p.is_file())
 for name in sorted(names):keep(TOOLS/name,Path('tools')/name)
 def write(name,value):(OUT/name).write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
 write('source-bindings.json',bindings)
 write('verification-summary.json',{'codeCommit':final_commit,'runs':{k:{a:b for a,b in v.items() if a!='source_hashes'} for k,v in receipts.items()},'sourceCallCases':175,'pureCallCases':173,'requestCases':2,'transportObservations':15,'nfcCodepointValues':1114112,'nfcSurrogateCodepointValues':2048,'nfcContextCases':4116,'benchmarkRounds':3,'benchmarkActorsPerRound':70,'medianNsPerOperation':medians,'productionContainers':18,'deployment':False,'push':False,'typescriptRetirement':False,'limitations':['typed and ordinary JSON boundaries; undefined own-property identity is not modeled','existing JSON nesting and regex resource/diagnostic boundaries','no application caller adoption or variation-job orchestration acceptance','synthetic prepared pure calls, warm caches; no production throughput, CPU or RSS measurement'],'reusedSdkEvidence':'../2026-10-30-advanced-moderation-prerequisites/index.json'})
 write('index.json',index)
 write('artifact-sha256.json',{str(p.relative_to(OUT)):sha(p.read_bytes()) for p in sorted(OUT.rglob('*')) if p.is_file()})
 print(json.dumps({'output':str(OUT),'runs':len(runs),'retainedArtifacts':len(index),'actors':210}))
if __name__=='__main__':main()
