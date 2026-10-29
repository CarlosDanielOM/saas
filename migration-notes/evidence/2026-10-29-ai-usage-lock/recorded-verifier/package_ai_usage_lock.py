"""Preserve verified AI lock source, protocol and isolated runtime evidence."""
import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'ai-usage-lock'
out=root/'migration-notes/evidence/2026-10-29-ai-usage-lock';assert not out.exists();out.mkdir(parents=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
retained={};compressed={}
def keep(f,r):
 raw=f.read_bytes();t=out/r;t.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or f.suffix=='.log':
  t=t.with_name(t.name+'.gz');t.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0));compressed[str(t.relative_to(out))]={'originalPath':str(r),'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:t.write_bytes(raw)
 retained[str(r)]={'storedPath':str(t.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for f in sorted(wave.rglob('*')):
 if f.is_file():keep(f,Path('artifacts')/f.relative_to(wave))
runs=[]
for f in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',f.name)
 if not m or not 1793273011921687926<=int(m[2])<=1793273748582165643:continue
 v=json.loads(f.read_text());log=f.with_name(f.name.replace('-receipt.json','.log'));assert log.is_file()
 keep(f,Path('runs')/f.name);keep(log,Path('runs')/log.name)
 runs.append({'receipt':retained[str(Path('runs')/f.name)]['storedPath'],'log':retained[str(Path('runs')/log.name)]['storedPath'],**{k:v[k] for k in ['phase','success','source_tree_sha256','production_unchanged']}})
folder=Path('/tmp/dimabot-full-migration-tools')
for f in sorted(folder.iterdir()):
 if f.is_file() and (f.name.startswith('ai_usage_lock_') or f.name in ['freeze_ai_usage_lock.py','validate.py','apply_format.py','prepare_posthog_sdk.py','package_ai_usage_lock.py']):keep(f,Path('recorded-verifier')/f.name)
final=json.loads((art/'compiler-fixtures-1793273489423847194-receipt.json').read_text());post=json.loads((art/'node-1793273748582165643-receipt.json').read_text())
assert final['success'] and post['success'] and final['production_unchanged'] and post['production_unchanged'];assert final['source_tree_sha256']==post['source_tree_sha256']
commit=subprocess.check_output(['git','rev-parse','8061af69'],cwd=root,text=True).strip();sdk={};git_files={}
for p,h in final['source_hashes'].items():
 if p.startswith('verification/'):
  assert sha((state/'source'/p).read_bytes())==h;sdk[p]=h
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+p],cwd=root))==h,p;git_files[p]=h
assert len(git_files)==1262 and len(sdk)==10
write(out/'source-binding.json',{'sourceTreeSha256':final['source_tree_sha256'],'gitCommit':commit,'gitFileHashes':git_files,'unchangedArchiveVerifiedSdkReferences':sdk})
initial=json.loads((art/'compiler-1793273119989217718-receipt.json').read_text());changes={}
for p,h in initial['source_hashes'].items():
 if final['source_hashes'].get(p)==h:continue
 f=wave/'attempt1/native-sources'/p;assert f.is_file() and sha(f.read_bytes())==h,p
 changes[p]={'sha256':h,'retainedPath':retained[str(Path('artifacts/attempt1/native-sources')/p)]['storedPath']}
assert list(changes)==['dimabot/tests/ai_usage_lock.rs']
write(out/'pre-fix-source-binding.json',{'sourceTreeSha256':initial['source_tree_sha256'],'currentGitCommitForUnchangedFiles':commit,'sourceHashes':initial['source_hashes'],'changedNativeFiles':changes,'fix':'Only source-oracle RESP fixture undefined/default handling; production native lock unchanged.'})
counts=list(map(int,re.findall(r'test result: ok\. (\d+) passed',(art/'compiler-fixtures-1793273489423847194.log').read_text())))
assert sum(counts)==10
write(out/'verification-summary.json',{'status':'Verified local request-time helper and concrete native Redis adapter; bootstrap telemetry/logging and broader application dependency closure remain open.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1272,'sourceOracleCases':291,'keyPairs':225,'concreteProtocolReplays':290,'separateDefaultAcquisitionCase':'Native child tests verify bootstrap success/failure and no callback after failure; original mock exception text is not claimed equivalent.','reportedExecutions':10,'executionGroups':counts,'countsAreUnique':False,'compilerRun':'compiler-fixtures-1793273489423847194','postNodeRun':'node-1793273748582165643','steps':final['steps'],'elapsedSeconds':final['elapsed_seconds'],'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'initialRuntimeFixtureFailure':'compiler-fixtures-1793273325709715164','all291SourceCasesUnchangedAfterFixtureFix':True,'runs':runs,'noProductionMutationPushDeploymentRetirementOrAdoption':True,'performanceMeasured':False,'readback':'artifacts/final-readback.json'})
write(out/'compressed-artifacts.json',compressed);write(out/'retained-artifacts.json',retained)
(out/'README.md').write_text('# Native AI usage lock evidence\n\nThe [summary](verification-summary.json) records the concrete native Redis helper and isolated checks. This is local feature evidence; bootstrap logging/telemetry and the broader application remain open. No TypeScript retirement, caller adoption, push or deployment occurred.\n\nThe [source binding](source-binding.json) maps 1,272 frozen inputs to commit '+commit+' plus ten unchanged SDK references. The [pre-fix binding](pre-fix-source-binding.json) retains the exact test bytes needed for the failed first runtime attempt. Only fixture undefined/default decoding changed; all 291 source cases and results remained identical.\n\nPinned TypeScript source generates 291 cases including 225 lossless UTF-16 account-key pairs. The concrete ConnectionManager replay covers 290; the remaining acquisition error is exercised through a separate native default-bootstrap child, with driver diagnostic text an explicit boundary. Ten reported executions include the protocol matrix, six guarded real-Redis/default tests, and three ordinary/library tests. Timer durations establish future lease maintenance and contention correctness, not speed.\n\nAll receipts/logs, including the failed RESP fixture attempt, are retained. Larger files and every log are compressed losslessly; raw hashes and sizes are in compressed-artifacts.json. Public Node/TypeScript artifacts are referenced by their existing independent hash provenance, not copied again. The final readback found 19 unchanged production records and no task-owned containers, networks or volumes.\n')
write(out/'artifact-sha256.json',{str(f.relative_to(out)):sha(f.read_bytes()) for f in sorted(out.rglob('*')) if f.is_file()})
print(json.dumps({'files':sum(f.is_file() for f in out.rglob('*')),'runs':len(runs),'compressed':len(compressed),'sourceInputsVerified':1272}))
