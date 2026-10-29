import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-text-benchmark';out=root/'migration-notes/evidence/2026-10-29-moderation-text-benchmark-baseline'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','f2c16a33'],cwd=root,text=True).strip();accepted=['node-1793307573090460748','compiler-1793307573088025938','node-1793307663869458394'];final=json.loads((art/(accepted[1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1329
retained={};compressed={}
def write(name,obj):
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2)+'\n')
def keep(p,name):
 raw=p.read_bytes();q=out/name;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log':
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:q.write_bytes(raw)
 retained[str(name)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for p in sorted(wave.rglob('*')):
 if p.is_file():keep(p,Path('artifacts')/p.relative_to(wave))
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler)-(\d+)-receipt.json',p.name)
 if m and 1793307536445171423<=int(m[2])<=1793307663869458394:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('moderation_text_benchmark_','moderation_text_paired','freeze_moderation_text_benchmark','export_moderation_text_benchmark')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified initial paired prepared benchmark with mixed results, including common-link and folding regressions. Broader migration remains incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1329,'acceptedRuns':accepted,'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':True,'benchmark':json.loads((wave/'attempt1/paired1/independent-readback.json').read_text()),'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Initial moderation text performance evidence\n\nFour separate equally weighted eight-case pools were measured in seven alternating pairs after three warmups per actor/workload, 8,000 operations per trial. Actual TypeScript runs in normal CommonJS; native execution uses the exact source-bound static release ELF. Prepared input parity, full manifest/binary/input hashes, all paired checksums, post-check and clean process exits passed. Timers include production function calls and storing their results, with prepared inputs and output-container allocation before timing; hashing, JSON encoding, checksum, IPC and destruction are outside timing.\n\nMedian ns/op (TypeScript / Rust): common links 967.84775 / 2452.192; long links 327477.8345 / 27472.622125; folding 469.380375 / 1073.271625; escaping 655.71075 / 288.789625. Common links and folding regress; long links and escaping improve in this synthetic run. Preserve all raw trials and input/source variants when optimizing; do not overwrite this baseline. This is one isolated host run with no CPU, RSS, or production-latency claim.\n\nCapped formatting, scoped Clippy, release compilation, exact static ELF inspection and runtime checks passed. All 19 production records stayed unchanged and no owned resources remained. No source retirement, caller adoption, deployment or push occurred. Performance optimization and the whole application migration remain open.\n')

write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1329}))
