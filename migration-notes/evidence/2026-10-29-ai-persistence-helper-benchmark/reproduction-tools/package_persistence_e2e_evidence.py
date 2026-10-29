import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=state/'artifacts';wave=art/'ledger-persistence-e2e';out=root/'migration-notes/evidence/2026-10-29-ai-persistence-helper-benchmark'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','22cb791f'],cwd=root,text=True).strip();final=json.loads((art/'node-fixtures-1793299654020839804-receipt.json').read_text());assert final['success'] and final['production_unchanged']
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());git_hashes={};sdk={}
for name,digest in final['source_hashes'].items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+name],cwd=root))==digest,name;git_hashes[name]=digest
assert len(git_hashes)+len(sdk)==1296
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
 if m and 1793299252127899937<=int(m[2])<=1793299654020839804:
  r=json.loads(p.read_text());runs.append({'run':p.stem.removesuffix('-receipt'),'success':r['success'],'sourceTreeSha256':r['source_tree_sha256'],'productionUnchanged':r['production_unchanged']});keep(p,Path('runs')/p.name);log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(log,Path('runs')/log.name)
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('persistence_e2e_','validate_persistence_e2e','export_persistence_e2e','freeze_persistence_e2e')) or p.name in ['validate.py','apply_format.py','prepare_posthog_sdk.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
report=json.loads((wave/'attempt2/independent-helper-report-readback.json').read_text());assert report['all28ActorSamplesPairOrderBsonSnapshotsCountsHashesAndRecomputedTimingsVerified']
accepted=['compiler-1793299376013082945','node-1793299376008552028','node-fixtures-1793299654020839804']
for n in accepted:
 r=json.loads((art/(n+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'] and r['source_tree_sha256']==final['source_tree_sha256']
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git_hashes,'unchangedArchiveVerifiedSdkReferences':sdk})
write('verification-summary.json',{'status':'Verified single-host matched helper benchmark; no whole-application performance or migration completion claim.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1296,'acceptedRuns':accepted,'limits':final['limits'],'productionUnchangedRecords':19,'all28SamplesVerified':True,'scope':report['scope'],'excluded':report['excluded'],'workloads':report['workloads'],'reportSha256':report['reportSha256'],'noRetirementAdoptionDeploymentPush':True,'runs':runs})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('# Complete receipt persistence helper benchmark\n\nSeven alternating matched pairs per workload each process32 sequential receipts through real TypeScript and Rust helpers against the same private Mongo8/Redis resources. Every pair produced equivalent full BSON snapshots after normalizing only generated top-level document ids and object key ordering. All28 actor samples and eight warmup outcomes are retained. Independent readback verifies pair ordering, counts, hashes and recomputed times.\n\nInsert median time per receipt: TypeScript5.387853ms, Rust3.961479ms (26.47%lower). Duplicate-repair: TypeScript5.068453ms, Rust3.802758ms (24.97%lower). This is one isolated host run of the bounded helper; setup/producer/parsing/bootstrap/reset/readback/IPC/provider/error paths are excluded. No CPU, memory or production-latency claim. Prior reducer-only Rust regressions remain separately retained.\n\nSource/binary provenance, prepared data, all raw trials and BSON readbacks, successful and failed compiler/source checks and reproduction tools are indexed. Public dependencies and exact static native ELF are hash-bound rather than vendored. No TypeScript retirement, caller adoption, deployment or push occurred.\n')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'sourceInputsVerified':1296,'all28ActorSamplesVerified':True}))
