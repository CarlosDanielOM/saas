import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-caps';out=root/'migration-notes/evidence/2026-10-29-moderation-caps'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','b44f3c9f'],cwd=root,text=True).strip();accepted=['compiler-1793304885449512726','compiler-1793305057976047544','node-1793305838560818548'];final=json.loads((art/(accepted[1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1313
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
 if m and 1793302898978941901<=int(m[2])<=1793305838560818548:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('caps_','freeze_caps','export_caps')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified caps evaluator, emote stripping and equivalent type-only schema contract; broader moderation remains incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1313,'acceptedRuns':accepted,'sourceCases':5348,'ordinaryTests':3,'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':True,'benchmark':json.loads((wave/'attempt2/paired1/independent-readback.json').read_text()),'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Caps evaluator evidence\n\nTwo runtime exports and their equivalent typed contracts map to the native caps evaluator and sequential emote stripping. All 5,348 actual-TypeScript cases, three ordinary tests, native source replay and strict feature/profile checks passed. Pinned Unicode 17 letter/uppercase tables were generated from the actual source regexes and independently read back. Source hashes, exact static release ELF and before/after runtime hashes are retained.\n\nThe paired prepared benchmark reports Rust 2.772507625 microseconds and Node 18.865917625 microseconds per evaluation (85.304146% lower Rust median), across seven alternating pairs of one equally weighted eight-case pool. It measures evaluator calls only, with prepared inputs and preallocated output containers; checksums, parsing, IPC, serialization and drop are outside timing. Every paired checksum matched. This is one isolated host run, not production latency, CPU, RSS or a whole-application result. Raw trials, independent readback and comparison HTML are retained.\n\nEarlier combined Node runs failed in the separate shared-Unicode generator after caps oracle generation/check had succeeded; those failures and their source variants are retained. The final standalone caps runtime and oracle check passed. Do not describe failed combined phases as passing.\n\nThe sole source import is type-only; broader moderation settings, registries and enforcement remain open. No TypeScript retirement, caller adoption, deployment or push occurred. All 19 production records remained unchanged, and no owned resources remained after checks.\n')

write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1313}))
