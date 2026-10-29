"""Record bounded follow-up performance evidence after verified code commits."""
import gzip,hashlib,json,re,subprocess,shutil
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'posthog-payload-performance'
out=root/'migration-notes/evidence/2026-10-29-posthog-payload-performance'
assert not out.exists()
out.mkdir(parents=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(path,value):path.write_text(json.dumps(value,indent=2)+'\n')
retained={};compressed={};excluded=[]
def keep(source,relative):
 target=out/relative;target.parent.mkdir(parents=True,exist_ok=True)
 h=hashlib.sha256();size=0
 if source.stat().st_size>65536 or source.suffix=='.log':
  target=target.with_name(target.name+'.gz')
  with source.open('rb') as src,target.open('xb') as dst:
   with gzip.GzipFile(filename='',mode='wb',fileobj=dst,mtime=0,compresslevel=6) as z:
    while chunk:=src.read(1024*1024):h.update(chunk);size+=len(chunk);z.write(chunk)
  compressed[str(target.relative_to(out))]={'originalPath':str(relative),'rawSha256':h.hexdigest(),'rawBytes':size}
 else:
  raw=source.read_bytes();target.write_bytes(raw);h.update(raw);size=len(raw)
 retained[str(relative)]={'storedPath':str(target.relative_to(out)),'rawSha256':h.hexdigest(),'rawBytes':size}
for f in sorted(wave.rglob('*')):
 if not f.is_file():continue
 r=f.relative_to(wave)
 if r==Path('number-diagnostic/probe'):
  excluded.append({'path':str(r),'sha256':sha(f.read_bytes()),'bytes':f.stat().st_size,'reason':'Regenerable diagnostic ELF; exact source, mounted-source correction and both run receipts retained.'});continue
 keep(f,Path('artifacts')/r)
runs=[]
for f in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',f.name)
 if not m or int(m[2])<1793267370297086967:continue
 v=json.loads(f.read_text());log=f.with_name(f.name.replace('-receipt.json','.log'))
 assert log.is_file()
 keep(f,Path('runs')/f.name);keep(log,Path('runs')/log.name)
 runs.append({'receipt':retained[str(Path('runs')/f.name)]['storedPath'],'log':retained[str(Path('runs')/log.name)]['storedPath'],**{k:v[k] for k in ['phase','success','source_tree_sha256','production_unchanged']}})
for f in sorted(Path('/tmp/dimabot-full-migration-tools').iterdir()):
 if f.is_file() and (f.name.startswith(('posthog_perf_','prepare_posthog_perf_','trim_pre_broad_','trim_completed_debug_')) or f.name in ['validate.py','apply_format.py','freeze_posthog_wave.py','prepare_posthog_sdk.py','trim_perf_stale_test_binaries.py','trim_private_binary_aliases.py','number_tie_probe.rs','package_posthog_performance.py']):keep(f,Path('recorded-verifier')/f.name)
final=json.loads((art/'compiler-fixtures-1793271955861772133-receipt.json').read_text())
other=json.loads((art/'compiler-1793272783195663615-receipt.json').read_text())
post=json.loads((art/'node-1793272491713187942-receipt.json').read_text())
assert all(v['success'] and v['production_unchanged'] for v in [final,other,post])
assert len({v['source_tree_sha256'] for v in [final,other,post]})==1
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
snapshot=final['source_hashes'];git_files={};sdk={}
for p,h in snapshot.items():
 if p.startswith('verification/'):
  assert sha((state/'source'/p).read_bytes())==h;sdk[p]=h
 else:
  raw=subprocess.check_output(['git','show',commit+':'+p],cwd=root)
  assert sha(raw)==h,p;git_files[p]=h
assert len(snapshot)==1269 and len(sdk)==10
write(out/'source-binding.json',{'sourceTreeSha256':final['source_tree_sha256'],'gitCommit':commit,'gitFileHashes':git_files,'unchangedArchiveVerifiedSdkReferences':sdk})
prior=[]
for label in ['compiler-1793268817230385594','compiler-1793270379734265688']:
 v=json.loads((art/(label+'-receipt.json')).read_text());changed={}
 for p,h in v['source_hashes'].items():
  if snapshot.get(p)==h:continue
  if p=='dimabot/src/utils/json_number.rs' and label.endswith('8817230385594'):
   raw=subprocess.check_output(['git','show','77141415:'+p],cwd=root);binding={'gitCommit':'77141415','path':p}
  else:
   f=wave/'failed-numeric-native-sources'/p;assert f.is_file(),p
   raw=f.read_bytes();binding={'retainedPath':retained[str(Path('artifacts/failed-numeric-native-sources')/p)]['storedPath']}
  assert sha(raw)==h,p;changed[p]={'sha256':h,**binding}
 prior.append({'run':label,'sourceTreeSha256':v['source_tree_sha256'],'sourceHashes':v['source_hashes'],'reusedCurrentBindingPaths':sum(snapshot.get(p)==h for p,h in v['source_hashes'].items()),'changedBindings':changed,'omittedCurrentPaths':sorted(set(snapshot)-set(v['source_hashes']))})
write(out/'prior-candidate-source-bindings.json',prior)
counts=lambda label:list(map(int,re.findall(r'test result: ok\. (\d+) passed',(art/(label+'.log')).read_text())))
summary={'status':'VERIFIED LOCAL FOLLOW-UP; six synthetic payload medians below retained TypeScript baseline; whole migration incomplete.','sourceTreeSha256':final['source_tree_sha256'],'codeCommit':commit,'runs':runs,'broadRun':'compiler-fixtures-1793271955861772133','broadReportedExecutions':sum(counts('compiler-fixtures-1793271955861772133')),'broadResultCounts':counts('compiler-fixtures-1793271955861772133'),'otherConsumerRun':'compiler-1793272783195663615','otherReportedExecutions':sum(counts('compiler-1793272783195663615')),'countsAreUnique':False,'numericEngineCases':35464,'originalFormatterDifferences':53,'correctedDifferences':0,'receiptCasesPerTimezone':1362,'timezones':5,'posthogSourceRecords':1042,'emoteDirectlyReplayed':57,'emoteSkipped':9,'emoteCorpus':66,'limits':final['limits'],'broadPeakCacheBytes':final['peak_cache_bytes'],'broadMinimumAvailableBytes':final['minimum_available_bytes'],'postNodeRun':'node-1793272491713187942','performance':'artifacts/current-benchmark-comparison.json','readback':'artifacts/final-readback.json','noPushDeploymentAdoptionOrRetirement':True,'CPUandRSSmeasured':False}
write(out/'verification-summary.json',summary)
write(out/'compressed-artifacts.json',compressed);write(out/'retained-artifacts.json',retained);write(out/'excluded-regenerable-artifacts.json',excluded)
(out/'README.md').write_text('# PostHog payload performance evidence\n\nVerified local synthetic follow-up. The full dimabot migration and caller adoption remain incomplete; no push, deployment or source retirement occurred. The original regressions remain preserved in the [initial baseline](../2026-10-29-posthog-receipt/README.md).\n\nThe [summary](verification-summary.json) identifies exact source and runs. The [comparison](artifacts/current-benchmark-comparison.json) and [chart](artifacts/current-payload-comparison.html) retain all six pools and sample ranges. All 42 TypeScript trials are retained unchanged; only four native source hashes were rebound, with byte-level reuse audits. Timing covers prepared payload builders, ordered JSON and UTF-8 checksum only. The smallest command gain has overlapping ranges. There is no significance, CPU, RSS, HTTP, queue or whole-application claim.\n\nThe [current source binding](source-binding.json) maps 1,269 frozen inputs to verified Git bytes and ten unchanged SDK reference hashes. [Earlier candidate bindings](prior-candidate-source-bindings.json) retain the exact failed formatter source and the first optimization candidate. The 35,464 raw inputs, group labels and engine String/JSON expectations are unchanged. All 53 initial failures are preserved, including the diagnostic proving the original formatter had the same differences.\n\nAll receipts and logs, including namespace/directory setup failures, the numeric parity failure, a parent-stopped overly broad follow-up compile and a cache-guarded scoped attempt, remain under runs/. The stopped all-features command script is clearly reconstructed from the recorded command rather than claimed contemporaneous. Large payloads and every log are compressed losslessly with raw hashes/lengths in the [compression manifest](compressed-artifacts.json). The regenerable diagnostic ELF is excluded with its hash; source and read-only rerun proof are retained. Public Node/package binaries referenced by earlier evidence remain private, with their existing hash manifests.\n\nThe final readback checks 19 unchanged production records and no owned containers, networks or volumes.\n')
write(out/'artifact-sha256.json',{str(f.relative_to(out)):sha(f.read_bytes()) for f in sorted(out.rglob('*')) if f.is_file()})
print(json.dumps({'files':sum(f.is_file() for f in out.rglob('*')),'compressed':len(compressed),'sourceInputsVerified':len(snapshot),'runs':len(runs)}))
