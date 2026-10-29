"""Preserve the parser benchmark baseline, including its four regressions."""
import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'receipt-parser-benchmark';out=root/'migration-notes/evidence/2026-10-29-receipt-parser-baseline';assert not out.exists();out.mkdir(parents=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
retained={};compressed={};excluded=[]
def keep(f,r):
 raw=f.read_bytes();t=out/r;t.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or f.suffix=='.log':
  t=t.with_name(t.name+'.gz');t.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0));compressed[str(t.relative_to(out))]={'originalPath':str(r),'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:t.write_bytes(raw)
 retained[str(r)]={'storedPath':str(t.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for f in sorted(wave.rglob('*')):
 if not f.is_file():continue
 r=f.relative_to(wave)
 if r==Path('lookup-diagnostic/profile'):
  excluded.append({'path':str(r),'sha256':sha(f.read_bytes()),'bytes':f.stat().st_size,'reason':'Regenerable diagnostic executable; source, read-only compile command, release rlib hash/fingerprint and results retained.'});continue
 keep(f,Path('artifacts')/r)
runs=[]
for f in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler)-(\d+)-receipt.json',f.name)
 if not m or not 1793273842956129714<=int(m[2])<=1793274681760889459:continue
 v=json.loads(f.read_text());log=f.with_name(f.name.replace('-receipt.json','.log'));assert log.is_file();keep(f,Path('runs')/f.name);keep(log,Path('runs')/log.name)
 runs.append({'receipt':retained[str(Path('runs')/f.name)]['storedPath'],'log':retained[str(Path('runs')/log.name)]['storedPath'],**{k:v[k] for k in ['phase','success','source_tree_sha256','production_unchanged']}})
folder=Path('/tmp/dimabot-full-migration-tools')
for f in sorted(folder.iterdir()):
 if f.is_file() and (f.name.startswith(('receipt_parser_benchmark_','receipt_lookup_profile')) or f.name in ['freeze_receipt_parser_benchmark.py','validate.py','apply_format.py','prepare_posthog_sdk.py','package_receipt_parser_baseline.py']):keep(f,Path('recorded-verifier')/f.name)
final=json.loads((art/'compiler-1793274264064252684-receipt.json').read_text());post=json.loads((art/'node-1793274460403768280-receipt.json').read_text());assert final['success'] and post['success'];assert final['production_unchanged'] and post['production_unchanged'];assert final['source_tree_sha256']==post['source_tree_sha256']
commit=subprocess.check_output(['git','rev-parse','0389561e'],text=True,cwd=root).strip();g={};sdk={}
for p,h in final['source_hashes'].items():
 if p.startswith('verification/'):
  assert sha((state/'source'/p).read_bytes())==h;sdk[p]=h
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+p],cwd=root))==h,p;g[p]=h
assert len(g)==1265 and len(sdk)==10
write(out/'source-binding.json',{'sourceTreeSha256':final['source_tree_sha256'],'gitCommit':commit,'gitFileHashes':g,'unchangedArchiveVerifiedSdkReferences':sdk})
initial=json.loads((art/'compiler-1793274004764681420-receipt.json').read_text());changes={}
for p,h in initial['source_hashes'].items():
 if final['source_hashes'].get(p)==h:continue
 f=wave/'pre-lint-source'/p;assert f.is_file() and sha(f.read_bytes())==h,p;changes[p]={'sha256':h,'retainedPath':retained[str(Path('artifacts/pre-lint-source')/p)]['storedPath']}
assert list(changes)==['dimabot/tests/ai_usage_receipt_parser_benchmark.rs']
write(out/'pre-lint-source-binding.json',{'sourceTreeSha256':initial['source_tree_sha256'],'gitCommitForUnchangedFiles':commit,'sourceHashes':initial['source_hashes'],'changedFiles':changes,'correction':'Constant assertion changed to equivalent release-profile guard; no benchmark data/timing/source-wire change.'})
write(out/'verification-summary.json',{'status':'Verified synthetic baseline; four Rust performance regressions remain open, two pools faster.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1275,'sourceWires':192,'pools':6,'inputsPerPool':32,'trialsPerPool':7,'compilerRun':'compiler-1793274264064252684','strictRun':'compiler-1793274083369420275','postNodeRun':'node-1793274460403768280','diagnosticRun':'compiler-1793274681760889459','initialLintFailure':'compiler-1793274004764681420','timedTestSeconds':41.21,'steps':final['steps'],'totalSeconds':final['elapsed_seconds'],'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'runs':runs,'comparison':'artifacts/initial-benchmark-comparison.json','readback':'artifacts/initial-final-readback.json','scope':'Prepared input parsing, ordered JSON wire encoding and UTF-8 byte checksum only; no Redis/Mongo/I/O/input setup, CPU, RSS or whole-application claim.','CPUandRSSmeasured':False,'noSourceRetirementCallerAdoptionDeploymentPush':True})
write(out/'compressed-artifacts.json',compressed);write(out/'retained-artifacts.json',retained);write(out/'excluded-regenerable-artifacts.json',excluded)
(out/'README.md').write_text('# Receipt parser benchmark baseline\n\nThis verified baseline preserves four native time regressions and two gains. It is not a performance acceptance or total Rust migration completion. The [comparison](artifacts/initial-benchmark-comparison.json) retains every trial and range; the [summary](verification-summary.json) records source, runs and limits. Both runtimes validate 192 source wires over six prepared pools before timing, with matching warmups and seven trials. The scope is parsing, ordered wire encoding and a UTF-8 byte checksum; no database, queue, I/O, CPU, RSS or production-latency gain is claimed.\n\nThe [source binding](source-binding.json) maps 1,275 frozen inputs to commit '+commit+' and ten unchanged SDK references. The [earlier lint binding](pre-lint-source-binding.json) retains the benchmark file before its constant-assert lint correction; business logic, prepared inputs and source wires did not change. Raw run receipts/logs, including the lint failure, are preserved. Compressed files retain raw hashes and sizes.\n\nThe native stage diagnostic uses one ASCII prepared input and the exact release rlib hash/fingerprint. Twenty named lookups took roughly 57 microseconds per pass versus roughly one microsecond for validation/indexing. These are separate diagnostic stages, not additive production latency or a TypeScript comparison. Source and read-only compile commands are retained; the regenerable executable is excluded with its hash. A lookup optimization is separate ongoing work.\n\nReadback confirms 19 unchanged production records and no task-owned containers, networks or volumes. No TypeScript source retirement, application adoption, deployment or push occurred.\n')
write(out/'artifact-sha256.json',{str(f.relative_to(out)):sha(f.read_bytes()) for f in sorted(out.rglob('*')) if f.is_file()})
print(json.dumps({'files':sum(f.is_file() for f in out.rglob('*')),'runs':len(runs),'compressed':len(compressed),'sourceInputsVerified':1275}))
