import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-text-benchmark';out=root/'migration-notes/evidence/2026-10-29-moderation-text-benchmark-optimized'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','5f55177e'],cwd=root,text=True).strip();accepted=['compiler-1793307998691861153','node-1793307998679265820','compiler-1793308084908088926','node-1793308237897067163'];final=json.loads((art/(accepted[2]+'-receipt.json')).read_text())
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
 if m and 1793307946390081543<=int(m[2])<=1793308237897067163:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('moderation_text_benchmark_','moderation_text_paired','moderation_text_opt','freeze_moderation_text_benchmark','export_moderation_text_benchmark')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py','final_readback.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified corrective candidate source parity and paired prepared benchmarks; all current medians lower in this run, common-link margin modest. Initial regressions preserved; broader migration incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1329,'acceptedRuns':accepted,'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':True,'benchmark':json.loads((wave/'attempt2/paired1/independent-readback.json').read_text()),'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Corrective moderation text performance evidence\n\nThe current candidate preserves exact prepared inputs, TypeScript compiled bytes, expected outputs and per-workload checksums from the initial baseline. Each of four separate eight-case pools has three warmups per actor and seven alternating paired trials, 8,000 operations per trial. Median ns/op (TypeScript / Rust): common links 890.222375 / 831.927; long links 333214.9865 / 29378.458; folding 599.8035 / 378.356125; escaping 741.421125 / 273.73525. The common-link margin is modest. No statistical, CPU, RSS or production-latency claim follows. The initial common-link/folding regressions and exact earlier artifacts remain retained.\n\nShort ASCII links use bounded stack tables and borrowed byte comparisons; longer/non-ASCII inputs retain the prior scanner. Folding streams canonical decomposition after a complete property test proves every reordered nonstarter from a Unicode 17-assigned scalar is removed by the Unicode 17 Mark filter. Sigma context is skipped when absent; malformed UTF-16 is re-decoded after mark removal. The property and independent ordered-NFD sequence tests, all-code-point/context replay, complete links/normalizer source corpora, strict profile checks and Clippy passed. Generated Unicode data and public APIs are unchanged.\n\nTimers include production calls and retaining results, with preparation and output-container allocation before timing and serialization/checksum/hash/IPC/destruction afterward. Exact static release ELF, full-source manifest, input/SDK/native hashes, clean exits, post-check and before/after hashes passed. All 19 production records remained unchanged with no owned resources after checks. No source retirement, caller adoption, new crate, deployment or push occurred.\n')

write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1329}))
