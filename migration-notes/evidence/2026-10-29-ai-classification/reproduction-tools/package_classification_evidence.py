import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'ai-classification';out=root/'migration-notes/evidence/2026-10-29-ai-classification'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','e5fad37a'],cwd=root,text=True).strip();accepted=['compiler-1793299987183286077','node-1793299987184873431','compiler-1793300124243405961','node-1793300276390314123','compiler-1793300437308104735'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1298
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
 if m and 1793299935443473214<=int(m[2])<=1793300437308104735:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('classification_','validate_classification','freeze_classification')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified pure classification exports and native dependencies within ordinary JSON-data object boundary; broader application migration incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1298,'acceptedRuns':accepted,'classificationSourceCases':100,'ordinaryClassificationTests':2,'existingAiUsageLibraryTests':3,'consumerOrdinaryTests':38,'consumerSourceRecords':{'producer':338,'producerTiers':20,'parserPerTimezone':1362,'parserTimezones':5,'queries':333,'persistence':204,'backfill':341,'lockReferenceRechecked':291},'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':False,'noRetirementAdoptionDeploymentPush':True,'boundaries':['Ordinary JSON data, lossless UTF16, no executable coercion hooks/custom prototypes.','Top-level null outside declared object contract: TypeError name preserved but exact error message not reproduced.','Legacy serde entry point retains historical weaker coercion; new lossless API maps complete source boundary.'],'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# AI adjustment classification evidence\n\nThe two source exports map to the shared native registry/policy and lossless JSON classifier. All100 actual-TypeScript cases and independent source/native/toolchain hash checks passed. The legacy serde signature remains compatible. Consumer checks covered38 ordinary cases and the producer338/parser1362 across5 timezones/query333/persistence204/backfill341 source records. Strict feature/profile checks passed. See verification-summary.json for exact scope, exclusions and receipts.\n\nNo classifier speed benchmark, TypeScript retirement, caller adoption, deployment or push occurred. Broader AI usage/billing/ledger migration remains incomplete. The generic top-level-null error retains the TypeError name but not the exact message; root null is outside the declared object contract. Executable hooks/custom prototypes are excluded.\n')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1298}))
