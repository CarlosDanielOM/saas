import gzip,hashlib,importlib.util,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=s/'artifacts';w=art/'ledger-query-retention';tools=Path(__file__).parent;out=root/'migration-notes/evidence/2026-10-29-ai-ledger-queries-retention';assert not out.exists()
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(p,j):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(j,indent=2)+'\n')
commit=subprocess.check_output(['git','rev-parse','4896f118'],cwd=root,text=True).strip();final=json.loads((art/'compiler-fixtures-1793284318631963243-receipt.json').read_text());assert final['success'];git={};sdk={}
for p,h in final['source_hashes'].items():
 if p.startswith('verification/'):
  assert sha((s/'source'/p).read_bytes())==h;sdk[p]=h
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+p],cwd=root))==h,p;git[p]=h
assert len(git)==1274 and len(sdk)==10
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793282715881625937<=int(m[2])<=1793285417559374117:runs.append((p,json.loads(p.read_text())))
# Every changed byte from failed executable checks must remain reconstructible.
candidates={}
for p in w.rglob('*'):
 if p.is_file() and 'dimabot' in p.relative_to(w).parts:candidates.setdefault(sha(p.read_bytes()),str(p.relative_to(w)))
bindings=[]
for p,rr in runs:
 if rr['success'] or rr['phase']=='format':continue
 changes={}
 for name,h in rr['source_hashes'].items():
  if final['source_hashes'].get(name)==h:continue
  assert h in candidates,(p.name,name,h)
  changes[name]={'sha256':h,'retainedPath':candidates[h]}
 bindings.append({'run':p.name.removesuffix('-receipt.json'),'sourceTreeSha256':rr['source_tree_sha256'],'unchangedFilesBoundTo':commit,'changedFiles':changes})
spec=importlib.util.spec_from_file_location('ledger_queries_final',tools/'validate.py');driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
initial=json.loads((s/'production-before.json').read_text());now=driver.production();assert now==initial
names=['full-rust-'+sha((str(s)+phase).encode())[:12] for phase in ['format','compiler','compiler-fixtures','inventory','node','node-fixtures']];owned={}
for kind,args in [('containers',['ps','-aq']),('networks',['network','ls','-q']),('volumes',['volume','ls','-q'])]:
 found=[]
 for name in names:found.extend(driver.docker(*args,'--filter','label=saas.task='+name).split())
 assert not found,(kind,found);owned[kind]=found
write(w/'attempt3/final-readback.json',{'productionUnchanged':True,'productionRecords':len(now),'remainingOwnedResources':owned,'sourceInputsVerifiedAgainstGit':1284,'codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'productionRecordsAfter':now})
out.mkdir(parents=True);write(out/'source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git,'unchangedArchiveVerifiedSdkReferences':sdk});write(out/'earlier-source-bindings.json',bindings)
retained={};compressed={}
def keep(p,rel):
 raw=p.read_bytes();q=out/rel;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log' or raw.endswith(b'\n\n'):
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'originalPath':str(rel),'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:q.write_bytes(raw)
 retained[str(rel)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for p in sorted(w.rglob('*')):
 if not p.is_file():continue
 rel=p.relative_to(w)
 if any(x.endswith('node-provenance') for x in rel.parts) and p.name!='manifest.json':continue
 keep(p,Path('artifacts')/rel)
run_records=[]
for p,rr in runs:
 log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name);run_records.append({'run':p.name.removesuffix('-receipt.json'),'success':rr['success'],'sourceTreeSha256':rr['source_tree_sha256'],'productionUnchanged':rr['production_unchanged']})
for name in ['validate.py','validate_ledger_next.py','prepare_posthog_sdk.py','apply_format.py','freeze_ledger_queries_retention.py','ledger_queries_retention_check.sh','ledger_queries_retention_node.sh','ledger_queries_retention_post_node.sh','copy_ledger_followup_node_provenance.cjs','ai_usage_ledger_queries_runtime.sh','ai_usage_retention_runtime.sh','ai_usage_retention_replay_runtime.sh','ledger_queries_nan_node.sh','ledger_nan_diagnostic.cjs','ledger_queries_release_check.sh','trim_pre_ledger_followup_cache.py','trim_pre_ledger_runtime_cache.py','trim_pre_ledger_release_cache.py','package_ai_ledger_queries_retention.py']:keep(tools/name,Path('recorded-verifier')/name)
maintenance=art/'receipt-parser-benchmark/pre-ledger-followup-cache-maintenance.json';keep(maintenance,Path('artifacts')/maintenance.name)
accepted=['compiler-1793284032019891565','node-1793284231647154788','compiler-fixtures-1793284318631963243','compiler-fixtures-1793284500245082430','compiler-fixtures-1793284538995629407','compiler-1793284759267735157','node-1793285417559374117']
for name in accepted:
 rr=json.loads((art/(name+'-receipt.json')).read_text());assert rr['success'] and rr['production_unchanged'];assert rr['source_tree_sha256']==final['source_tree_sha256']
write(out/'verification-summary.json',{'status':'Verified local ledger query/retention adapters; full ledger and migration incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1284,'strictRun':accepted[0],'oracleRun':accepted[1],'queryRuntimeRun':accepted[2],'retentionWireReplayRun':accepted[3],'retentionMutationRun':accepted[4],'queryReleaseRun':accepted[5],'postNodeRun':accepted[6],'queryOrdinaryTests':8,'retentionOrdinaryTests':2,'debugIgnoredSuitesRun':4,'releaseQueryOrdinaryTests':8,'releaseQuerySourceReplay':True,'querySourceScenarios':333,'queryDeclarations':22,'retentionSourceScenarios':34,'retentionDeclarations':4,'publicPackageFilesHashedPerFixture':445,'queryRuntimeScriptSeconds':9.985,'retentionWireScriptSeconds':7.152,'retentionMutationScriptSeconds':2.646,'releaseScriptSeconds':152.01,'releaseTotalSeconds':160.525,'peakCacheBytesIncludingFailedChecks':max(rr.get('peak_cache_bytes',0) for _,rr in runs),'minimumAvailableBytes':min(rr['minimum_available_bytes'] for _,rr in runs),'limits':final['limits'],'productionUnchangedRecords':19,'remainingOwnedResources':owned,'correctnessFix':'Pinned V8 Math.max canonical negative quiet NaN matched without changing shared Number coercion. Exact-bit assertions strengthened; all333 source records/protocols unchanged, native metadata hashes rebound by regeneration.','earlierFailuresPreserved':'Non-idempotent Rustfmt fixture branch, Clippy bool/chunk fixture styles, TypeScript reverse syntax-kind alias, then actual NaN sign discrepancy. Explicit Node/dependency fixture mounts corrected before runtime.','runtimeFeatureScope':'Independent single-feature all-target checks; runtime uses combined queries+retention graph to reuse task-private artifacts. Each server-scoped failure-injection suite gets a fresh private Mongo.','runs':run_records,'performanceMeasured':False,'noSourceRetirementCallerAdoptionDeploymentPush':True})
write(out/'retained-artifacts.json',retained);write(out/'compressed-artifacts.json',compressed);write(out/'excluded-regenerable-artifacts.json',[{'path':'artifacts/attempt2/{queries,retention}-node-provenance/root','reason':'Public445-file dependency trees and existing pinned Node executable independently hashed; manifests retained instead of vendoring packages or binaries.'}])
(out/'README.md').write_text('# Ledger queries and retention evidence\n\nTwo query exports and the batch retention export have concrete shared-client Mongo adapters. Eight query and two retention ordinary tests, all333 actual-source query scenarios, all34 retention command/clock/failure scenarios, and separate private Mongo suites passed. Targeted optimized query ordinary/source replay passed as well. The [summary](verification-summary.json) records exact runs and limits. No performance benchmark was measured for these exports.\n\nThe [source binding](source-binding.json) maps1,284 immutable inputs to the local code commit plus ten unchanged SDK references. [Earlier bindings](earlier-source-bindings.json) preserve every changed file from failed executable checks. All receipts/logs, actual-source/typechecking/extraction/compiled artifacts, protocols, public dependency manifests, independent fixture hashes, diagnostic and source-equivalence proof are retained. Compressed payloads retain raw hashes and sizes; public packages and the existing Node executable are not vendored.\n\nThe first query replay exposed a NaN sign discrepancy. The pinned cold/warm Node diagnostic distinguishes Number conversion from Math.max; only the new query Math.max branch was corrected, and ordinary bit assertions were strengthened. All333 source outputs/protocols stayed unchanged. Non-idempotent formatting, fixture Clippy and TypeScript enum-alias errors remain in the record. Checks were not softened.\n\nRuntime checks use the combined feature graph after separate feature-compilation checks. Fresh task-owned Mongo servers isolate each server-scoped failpoint suite. The API retains documented raw-BSON/declared-input boundaries, engine-specific error wording differences and Rust runtime ownership for detached deletes. Final readback verifies19 unchanged production records and zero task-owned containers/networks/volumes.\n\nNo caller adoption, source retirement, deployment or push occurred. Persistence, backfill, broader application bootstrap/model paths and the full Rust migration remain open.\n')
write(out/'artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'compressed':len(compressed),'sourceInputsVerified':1284,'earlierFailedBindings':len(bindings),'productionRecordsUnchanged':19,'ownedResourcesRemaining':owned}))
