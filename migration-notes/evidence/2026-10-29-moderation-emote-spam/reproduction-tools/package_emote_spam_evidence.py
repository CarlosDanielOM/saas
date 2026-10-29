import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-emote-spam';out=root/'migration-notes/evidence/2026-10-29-moderation-emote-spam'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','33bb8f46'],cwd=root,text=True).strip();accepted=['compiler-1793302248518831893','node-1793302248517993453','compiler-1793302461772086894'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1305
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
 if m and 1793302207225108236<=int(m[2])<=1793302461772086894:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('emote_spam_','freeze_emote_spam')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified pure emote-spam evaluator and equivalent type-only schema contract; broader moderation remains incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1305,'acceptedRuns':accepted,'sourceCases':360,'ordinaryTests':2,'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':False,'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Emote-spam evaluator evidence\n\nBoth source exports and the equivalent required numeric rule field map to a native pure evaluator. Two ordinary tests, all 360 actual-TypeScript result/binary64/wire comparisons and strict feature/profile checks passed. Source, schema, SDK, native, Node and fixture hashes were independently verified. See verification-summary.json for exact scope and receipts.\n\nThe schema import is type-only; this does not port moderation settings or enforcement. No evaluator speed benchmark, TypeScript retirement, caller adoption, deployment or push occurred.\n')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1305}))
