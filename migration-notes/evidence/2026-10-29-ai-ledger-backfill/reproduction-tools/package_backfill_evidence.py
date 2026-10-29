import gzip,hashlib,json,re,subprocess,sys
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'ledger-backfill';out=root/'migration-notes/evidence/2026-10-29-ai-ledger-backfill'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse',sys.argv[1]],cwd=root,text=True).strip()
accepted=['compiler-1793298764759098752','node-1793298764783132911','node-fixtures-1793298844986452413','compiler-1793298899575861137']
final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text())
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256'],n
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1294
retained={};compressed={}
def write(name,obj):
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2)+'\n')
def keep(p,name):
 raw=p.read_bytes();q=out/name;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log':
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:q.write_bytes(raw)
 retained[str(name)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
candidates={sha(p.read_bytes()):str(p.relative_to(wave)) for p in wave.rglob('*') if p.is_file() and 'source' in p.relative_to(wave).parts}
runs=[];bindings=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|node-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793298314599245881<=int(m[2])<=1793298899575861137:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']})
  keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
  if not r['success'] and r['phase']!='format':
   changes={}
   for name,digest in r['source_hashes'].items():
    if final['source_hashes'].get(name)==digest:continue
    assert digest in candidates,(p.name,name,digest);changes[name]={'sha256':digest,'retainedPath':candidates[digest]}
   bindings.append({'run':p.stem.removesuffix('-receipt'),'unchangedFilesBoundTo':commit,'changedFiles':changes})
for p in sorted(wave.rglob('*')):
 if p.is_file() and 'bin' not in p.relative_to(wave).parts:keep(p,Path('artifacts')/p.relative_to(wave))
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('backfill_','validate_backfill','export_backfill')) or p.name in ['validate.py','freeze_backfill.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('earlier-source-bindings.json',bindings)
write('verification-summary.json',{'status':'Verified bounded native backfill; full ledger and migration remain incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1294,'acceptedRuns':accepted,'ordinaryCases':6,'actualSourceCases':341,'privateProtocolSuites':1,'privateProtocolSeconds':3.32,'lockSourceCases':291,'productionUnchangedRecords':19,'limits':final['limits'],'minimumAvailableBytes':min(json.loads((art/(r['run']+'-receipt.json')).read_text())['minimum_available_bytes'] for r in runs),'peakCacheBytes':max(json.loads((art/(r['run']+'-receipt.json')).read_text()).get('peak_cache_bytes',0) for r in runs),'performanceMeasured':False,'noRetirementAdoptionDeploymentPush':True,'mongoServerMinimum':'8.0 (Client::bulk_write)','intentionalLegacyBoundary':'Inherited UnsupportedLegacy for Date/RegExp expiry arrays and top RegExp; guard retained before daily deletion.','runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Native ledger backfill evidence\n\nSix ordinary cases, all 341 actual-source records, concrete private Mongo8/Dragonfly failure and cancellation checks, and strict feature checks passed. See verification-summary.json and the dated migration note for exact scope and unresolved legacy coercion boundaries. No older-server compatibility or performance result is claimed.\n\nEarlier failures and source bytes are retained, including the protocol assertion that accidentally observed its own verification count aggregation. The assertion now runs before that readback. No case was dropped. Raw compiler/runtime receipts, source fixtures, exact static ELF provenance and reproduction scripts are indexed. Regenerable binaries/public dependencies are hash-bound rather than vendored. No source retirement, caller adoption, deployment or push occurred.\n')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'failedSourceBindings':len(bindings),'sourceInputsVerified':1294}))
