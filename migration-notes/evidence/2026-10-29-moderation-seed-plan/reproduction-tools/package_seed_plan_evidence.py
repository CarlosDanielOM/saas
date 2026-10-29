import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');art=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts');wave=art/'moderation-seed-plan/attempt1';out=root/'migration-notes/evidence/2026-10-29-moderation-seed-plan'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
commit=git('rev-parse','fb642a0c').decode().strip();tree='d8572c21fa330101815337afd904c2481b3c4a7c5a46afdfbf5a004456c9948a';accepted=['node-1793314343442641635','compiler-1793314343446707321','compiler-1793314472014779107'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text());inputs=json.loads((wave/'source-inputs.json').read_text());assert inputs==final['source_hashes'] and len(inputs)==1350
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());gh={};sdk={}
for n,d in inputs.items():
 if n.startswith('verification/'):assert old['unchangedArchiveVerifiedSdkReferences'][n]==d;sdk[n]=d
 else:assert sha(git('show',commit+':'+n))==d,n;gh[n]=d
assert len(sdk)==10
ind=json.loads((wave/'independent-reference-readback.json').read_text());fixture='09efa8c6312cf99fa60e6f6d9a324d652ab9ba87a70509a5135c039809f6c044';assert sha((wave/'reference/moderation-seed-plan-reference.json').read_bytes())==fixture==ind['fixtureSha256'];assert (ind['decisionCases'],ind['losslessViewCases'])==(110,5) and ind['allSourceNativeSdkHashesChecked']
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
 if m and 1793314113305779061<=int(m[2])<=1793314472014779107:
  r=json.loads(p.read_text());run=p.stem.removesuffix('-receipt');log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file() and r['success'] and r['production_unchanged'];assert run not in accepted or r['source_tree_sha256']==tree
  runs.append({'run':run,'sourceTreeSha256':r['source_tree_sha256'],'classification':'accepted final' if run in accepted else 'successful preformat nonfinal','success':True,'productionUnchanged':True});keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
assert len(runs)==4
names={'validate.py','freeze_seed_plan.py','freeze_offenses.py','freeze_permit.py','prepare_posthog_sdk.py','apply_format.py','final_readback.py',Path(__file__).name}
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name in names or p.name.startswith('seed_plan_') and p.suffix=='.sh'):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':tree,'gitFileHashes':gh,'unchangedArchiveVerifiedSdkReferences':sdk,'inputManifest':'artifacts/attempt1/source-inputs.json.gz'})
write('verification-summary.json',{'acceptedRuns':accepted,'runs':runs,'fixtureSha256':fixture,'sourceInputs':len(inputs),'decisionCases':110,'losslessViewCases':5,'headroomGuard':'Initial Node and compiler launches were refused before resource creation by the 8 GiB startup headroom guard; no available-byte reading was captured and no run receipts were produced.','acceptedFullReceipt':{'steps':final['steps'],'elapsedSeconds':final['elapsed_seconds'],'headroomStart':final['headroom_start'],'minimumAvailableBytes':final['minimum_available_bytes'],'peakCacheBytes':final['peak_cache_bytes'],'limits':final['limits']},'productionUnchangedRecords':19,'remainingOwnedResources':prod['remainingOwnedResources'],'coverage':'Pure source seed-plan exports and their required native model/core/default dependencies verified. Broader defaults.ts Mongo, cache, and registration paths and caller adoption remain open.','benchmarkMeasured':False,'typescriptRetired':False,'deployed':False,'pushed':False})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('''# Moderation seed plan evidence\n\nThe final Node and two compiler runs bind to commit `fb642a0c` and all 1,350 frozen inputs, including ten previously verified SDK references. The source fixture covers 110 decision cases and five lossless ordered view wires. It executes the unchanged seed, model and spam sources with real disconnected Mongoose and crypto, and checks the strict TypeScript closure. The ordinary native test covers all six view fields and independent owned rule vectors. No database access is required for this pure module; prior model evidence covers isolated native Mongo behavior.\n\nThe view holds borrowed UTF-16 channel strings and a fresh owned rules vector. Its JSON helper constructs and encodes a fresh view; it does not serialize a caller-mutated view. The typed candidate projects the rules length, which is all the source reads; arbitrary JavaScript runtime casts, prototypes and global defaults mutation are outside this contract.\n\nInitial Node and compiler launches were refused before resource creation by the 8 GiB startup headroom guard. No available-byte reading or run receipt was captured for those refusals. Accepted full checks ran afterward; their phase took 116.49 seconds and total time was 123.892 seconds. Final readback records 19 unchanged production records and no remaining owned resources. Broader defaults.ts Mongo, cache and registration paths and caller adoption remain open. No new benchmark, TypeScript retirement, deployment or push is claimed.\n''')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()});print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'inputs':len(inputs),'retained':len(retained)}))
