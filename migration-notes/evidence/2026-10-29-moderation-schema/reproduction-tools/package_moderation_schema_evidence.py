import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'moderation-schema';out=root/'migration-notes/evidence/2026-10-29-moderation-schema'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
def resolve(c):return git('rev-parse',c).decode().strip()
commit=resolve('3bfbfbd1');core=resolve('956aa9dc');finalhash='f630b11bf6ed08984f28de5cc14262c139c6541c581823561c1d53e3d93630fd'
accepted=['node-1793311821006651643','compiler-1793311821020142484','compiler-fixtures-1793311873934271303'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text());inputs=json.loads((wave/'attempt4/source-inputs.json').read_text());assert inputs==final['source_hashes'] and len(inputs)==1341
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());gh={};sdk={}
for name,digest in inputs.items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(git('show',commit+':'+name))==digest,name;gh[name]=digest
assert len(sdk)==10
ind=json.loads((wave/'attempt4/independent-reference-readback.json').read_text());assert ind['sourceTreeSha256']==finalhash and ind['allSourceNativeSdkNodeHashesChecked'] and (ind['coreCases'],ind['coreSourceCases'],ind['modelCases'])==(97,4,56)
readback=json.loads((wave/'attempt4/final-readback.json').read_text());assert readback['productionUnchanged'] and readback['productionRecords']==19 and all(not x for x in readback['remainingOwnedResources'].values())
failures={'node-1793311058791146323':('oracle missing parenthesis','SyntaxError: missing )'),'compiler-1793311058806879224':('obsolete BSON v3 test API','cannot find function `to_document`'),'compiler-1793311232008086775':('nested Mixed source mismatch','case 75:'),'compiler-1793311337627170780':('stale Cargo include_bytes source hash guard, mtime issue','tests/fixtures/channel_moderation_settings_reference.cjs'),'compiler-fixtures-1793311587439324424':('cast-error harness label mismatch; source error metadata retained','case 14'),'compiler-1793311637676422299':('constructor/valueOf Mixed dispatch source mismatch','case 84:')}
retained={};compressed={}
def write(name,obj):
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2)+'\n')
def keep(p,name):
 raw=p.read_bytes();q=out/name;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log':
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'rawSha256':sha(raw),'rawBytes':len(raw),'compressedSha256':sha(q.read_bytes())}
 else:q.write_bytes(raw)
 retained[str(name)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for p in sorted(wave.rglob('*')):
 if p.is_file():keep(p,Path('artifacts')/p.relative_to(wave))
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793311038914214060<=int(m[2])<=1793311873934271303:
  r=json.loads(p.read_text());run=p.stem.removesuffix('-receipt');log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file() and r['production_unchanged']
  assert r['success']==(run not in failures)
  if run in failures:assert failures[run][1] in log.read_text()
  if run in accepted:assert r['source_tree_sha256']==finalhash
  runs.append({'run':run,'success':r['success'],'productionUnchanged':r['production_unchanged'],'sourceTreeSha256':r['source_tree_sha256'],'classification':failures[run][0] if run in failures else ('accepted final' if run in accepted else 'successful nonfinal candidate')})
  keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
assert len(runs)==17 and len([r for r in runs if r['run'] in accepted])==3
names={'validate.py','validate_moderation_schema.py','freeze_permit.py','freeze_moderation_schema.py','prepare_posthog_sdk.py','apply_format.py','final_readback.py','schema_reference_readback.py',Path(__file__).name}
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name in names or re.fullmatch(r'moderation_schema_(?:node.*|check1|runtime.*|replay2)\.sh',p.name)):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'coreCommit':core,'sourceTreeSha256':finalhash,'gitFileHashes':gh,'unchangedArchiveVerifiedSdkReferences':sdk,'inputManifest':'artifacts/attempt4/source-inputs.json.gz'})
write('verification-summary.json',{'status':'Bounded channel moderation schema and composite core source feature coverage; whole-application adoption and overall Rust migration remain incomplete.','acceptedRuns':accepted,'sourceTreeSha256':finalhash,'sourceInputs':len(inputs),'gitInputs':len(gh),'sdkReferences':len(sdk),'coreSourceCases':97,'selectedActualModelRecords':4,'fullModelCases':56,'runs':runs,'finalFixtureReceipt':{'steps':final['steps'],'elapsedSeconds':final['elapsed_seconds'],'minimumAvailableBytes':final['minimum_available_bytes'],'peakCacheBytes':final['peak_cache_bytes'],'limits':final['limits']},'productionUnchangedRecords':19,'remainingOwnedResources':readback['remainingOwnedResources'],'performanceMeasured':False,'typescriptRetired':False,'deployed':False,'pushed':False})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('''# Moderation schema evidence\n\nThe final accepted Node, compiler and fixture runs bind to model commit `3bfbfbd1` and core commit `956aa9dc`. All 1,341 frozen inputs are accounted for: 1,331 match Git at the model commit, and ten SDK references match the previously verified binding. All four candidate artifact waves and the full receipt/log interval are preserved. Earlier failures retain their own source hashes and classifications; the stale Cargo source-hash guard is not a model mismatch.\n\nThe independent readback records 97 core cases, four selected actual model records and 56 full model cases. Final runs report six ordinary new tests, two source replay tests, a new private Mongo test and an existing application persistence test; existing core, application and channel TTS regression tests also passed. No-feature, Mongo/Redis, all-features/all-targets and strict Clippy checks passed. The final fixture phase took 147.058 seconds within a 156.944 second run; minimum available memory was 7,823,761,408 bytes and peak cache was 4,800,012,288 bytes. Final readback records 19 unchanged production records and no remaining owned resources.\n\nMixed minimization is explicit opt-in and leaves existing descriptors unchanged. Ordinary JSON/BSON coverage does not establish parity for sparse or undefined JavaScript values, executable hooks, or exotic constructor metadata. This is bounded source-file feature coverage; whole-application adoption and overall migration remain incomplete. No benchmark, TypeScript retirement, deployment or push is claimed.\n''')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'inputs':len(inputs),'retained':len(retained)}))
