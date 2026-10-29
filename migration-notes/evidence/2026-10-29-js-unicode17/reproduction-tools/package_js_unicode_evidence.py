import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'js-unicode17';out=root/'migration-notes/evidence/2026-10-29-js-unicode17'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','a1088ba9'],cwd=root,text=True).strip();accepted=['compiler-1793306075185634397','compiler-1793306144515399315','node-1793306075185472154'];final=json.loads((art/(accepted[1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1318
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
 if m and 1793304594190059854<=int(m[2])<=1793306144515399315 and (m[1]=='node' or int(m[2])>=1793306035981217563):
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('js_unicode_','js_unicode17_','unicode17_','freeze_js_unicode')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified reusable Unicode 17 string lowercase and NFD/Mark-removal fold core; no selected TypeScript leaf or AST caller adoption is completed by this core.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1318,'acceptedRuns':accepted,'allCodepoints':1114112,'lowerContexts':6432,'mixedCases':20,'ordinaryTests':1,'limits':final['limits'],'peakCacheBytes':final['peak_cache_bytes'],'minimumAvailableBytes':final['minimum_available_bytes'],'productionUnchangedRecords':19,'performanceMeasured':False,'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Unicode 17 core evidence\n\nThe shared lossless string core passed ordinary checks and exhaustive lowercase and actual-TypeScript fold comparisons over all 1,114,112 code-point values, including 2,048 lone surrogate values, plus 6,432 contextual goldens and 20 mixed/long UTF-16 cases. The pinned Node generator produced complete Unicode 17 mappings/properties and sparse NFD reference facts; independent Python readback checked all native table values, counts and hashes. The existing Unicode 18 normalization dependency is guarded by Unicode 17 assignment boundaries, then Unicode 17 marks are removed and UTF-16 re-decoded before lowering. No crate or lockfile change was added.\n\nThe exact 1,318-input source binding and successful capped fmt, scoped/strict Clippy, no-feature, Mongo/Redis and all-features/all-target checks are retained. Initial source guards and a missing output-directory preparation failed; raw failures and corrected source variants are retained, and no generated facts were silently overwritten. No performance benchmark or speed claim is made.\n\nThis is a reusable string core. The complete normalize.ts adapter, regexp escaping, AST adoption, wider application dependencies and caller adoption are separate work. No TypeScript retirement, deployment or push occurred. All 19 production records remained unchanged, and no owned resources remained after verification.\n')

write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1318}))
