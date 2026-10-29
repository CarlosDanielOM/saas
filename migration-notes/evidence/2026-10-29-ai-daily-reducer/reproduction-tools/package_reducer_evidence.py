import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'ledger-reducer-benchmark';out=root/'migration-notes/evidence/2026-10-29-ai-daily-reducer'
assert not out.exists()
sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','a87d9ee7'],cwd=root,text=True).strip()
final=json.loads((art/'node-fixtures-1793298262170959463-receipt.json').read_text());assert final['success'] and final['production_unchanged']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text())
git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1291
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
 if p.is_file() and 'bin' not in p.relative_to(wave).parts:keep(p,Path('artifacts')/p.relative_to(wave))
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|node-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793293036272972066<=int(m[2])<=1793298262170959463:
  receipt=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':receipt['success'],'sourceTreeSha256':receipt['source_tree_sha256'],'productionUnchanged':receipt['production_unchanged']})
  keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('reducer_','export_reducer','validate_reducer','trim_reducer')) or p.name in ['validate.py','validate_persistence7.py','freeze_reducer.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
for name in ['production-baseline-before-ack-api-ee0635765a02.json','production-ack-api-ee0635765a02.json']:keep(art/name,Path('production-acknowledgement')/name)
final_runs=['compiler-1793297040655785471','node-1793297958690919782','node-fixtures-1793298262170959463']
for n in final_runs:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
reports=[json.loads((wave/f'attempt{i}/independent-report-readback.json').read_text()) for i in [1,2,3]]
assert all(r['all35SamplesCountsChecksumsAndRecomputedNsPerOpVerified'] for r in reports)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Prepared reducer remains slower than TypeScript across all five workloads in all three rounds; full migration incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1291,'acceptedFinalRuns':final_runs,'ordinaryCases':11,'actualSourceCases':204,'privateProtocolSuites':1,'pairedSamplesPerRound':35,'rounds':reports,'scope':reports[-1]['scope'],'laterBsonMaterializationExcluded':True,'productionUnchangedRecords':19,'noRetirementAdoptionDeploymentPush':True,'runs':runs,'binaryPolicy':'Exact static musl ELFs executed only in pinned capped Node image; public Node/SDK binaries and compiled native artifacts are hash-bound, regenerable, and not vendored.'})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Daily reducer evidence\n\nAll three paired rounds are retained, including all raw samples and independent checks. Rust was slower than TypeScript in every workload in every round. Read verification-summary.json and the result note for scope and limitations. The final candidate passed 11 ordinary cases, 204 actual-source cases, and concrete private MongoDB/Dragonfly protocol checks.\n\nCompiler/runtime images, binary hashes, successful and failed receipts/logs, source snapshots and reproduction scripts are retained. The pre-timing fixture-path failure is retained. Static musl binaries and public dependencies are represented by provenance hashes rather than vendored executables. No application performance, memory, CPU, source retirement, adoption, deployment, push or total migration completion claim is made.\n')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerifiedAgainstGitAndArchive':1291,'all105PairedSamplesVerified':True}))
