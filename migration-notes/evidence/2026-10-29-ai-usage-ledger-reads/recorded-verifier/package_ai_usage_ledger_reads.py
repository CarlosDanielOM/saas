import gzip,hashlib,importlib.util,json,re,subprocess,shutil
from pathlib import Path
root=Path('/root/saas-rust');s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=s/'artifacts';w=art/'ai-usage-ledger-reads';tools=Path(__file__).parent;out=root/'migration-notes/evidence/2026-10-29-ai-usage-ledger-reads';assert not out.exists();out.mkdir(parents=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(p,j):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(j,indent=2)+'\n')
commit=subprocess.check_output(['git','rev-parse','ba91a15b'],cwd=root,text=True).strip();final=json.loads((art/'compiler-fixtures-1793282076062196276-receipt.json').read_text());assert final['success'];git={};sdk={}
for p,h in final['source_hashes'].items():
 if p.startswith('verification/'):
  assert sha((s/'source'/p).read_bytes())==h;sdk[p]=h
 else:
  assert sha(subprocess.check_output(['git','show',commit+':'+p],cwd=root))==h,p;git[p]=h
assert len(git)==1268 and len(sdk)==10
write(out/'source-binding.json',{'gitCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'gitFileHashes':git,'unchangedArchiveVerifiedSdkReferences':sdk})
# Recover the original module bytes before the four visibility-only extensions.
initial=json.loads((art/'compiler-1793281320965219994-receipt.json').read_text());rel='dimabot/src/utils/ai_usage_ledger_reads.rs';raw=(s/'source'/rel).read_bytes()
for name in [b'ordinary_json',b'version_number',b'array_coercion_value',b'date_method']:
 before=b'pub(crate) fn '+name;assert raw.count(before)==1;raw=raw.replace(before,b'fn '+name)
assert sha(raw)==initial['source_hashes'][rel]
p=w/'attempt1/pre-bson-fixture-fix'/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
bindings=[]
for run,base in [('compiler-1793281320965219994','attempt1/pre-bson-fixture-fix'),('compiler-1793281703177079472','attempt2/pre-clippy')]:
 rr=json.loads((art/(run+'-receipt.json')).read_text());changes={}
 for p,h in rr['source_hashes'].items():
  if final['source_hashes'].get(p)==h:continue
  f=w/base/p;assert f.is_file() and sha(f.read_bytes())==h,p;changes[p]={'sha256':h,'retainedPath':str(f.relative_to(w))}
 bindings.append({'run':run,'sourceTreeSha256':rr['source_tree_sha256'],'changedFiles':changes,'unchangedFilesBoundTo':commit})
write(out/'earlier-source-bindings.json',bindings)
# Read-only production and task-specific ownership inventory.
spec=importlib.util.spec_from_file_location('reads_final_readback',tools/'validate.py');driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
initialprod=json.loads((s/'production-before.json').read_text());now=driver.production();assert now==initialprod
names=['full-rust-'+sha((str(s)+phase).encode())[:12] for phase in ['format','compiler','compiler-fixtures','inventory','node','node-fixtures']];owned={}
for kind,args in [('containers',['ps','-aq']),('networks',['network','ls','-q']),('volumes',['volume','ls','-q'])]:
 found=[]
 for name in names:found.extend(driver.docker(*args,'--filter','label=saas.task='+name).split())
 assert not found,(kind,found);owned[kind]=found
write(w/'attempt2/final-readback.json',{'productionUnchanged':True,'productionRecords':len(now),'remainingOwnedResources':owned,'sourceInputsVerifiedAgainstGit':1278,'codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'productionRecordsAfter':now})
retained={};compressed={};excluded=[]
def keep(p,rel):
 raw=p.read_bytes();q=out/rel;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log' or raw.endswith(b'\n\n'):
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'originalPath':str(rel),'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:q.write_bytes(raw)
 retained[str(rel)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for p in sorted(w.rglob('*')):
 if not p.is_file():continue
 rel=p.relative_to(w)
 if 'node-provenance' in rel.parts and p.name!='manifest.json':continue
 keep(p,Path('artifacts')/rel)
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',p.name)
 if not m or not 1793281285616721596<=int(m[2])<=1793282140582889970:continue
 rr=json.loads(p.read_text());log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name);runs.append({'run':p.name.removesuffix('-receipt.json'),'success':rr['success'],'sourceTreeSha256':rr['source_tree_sha256'],'productionUnchanged':rr['production_unchanged']})
for name in ['validate.py','validate_ledger_reads.py','freeze_ledger_reads.py','prepare_posthog_sdk.py','apply_format.py','ai_usage_ledger_reads_check.sh','ai_usage_ledger_reads_node.sh','ai_usage_ledger_reads_runtime.sh','ai_usage_ledger_reads_post_node.sh','copy_ledger_reads_node_provenance.cjs','package_ai_usage_ledger_reads.py']:keep(tools/name,Path('recorded-verifier')/name)
fixture=json.loads((w/'attempt2/reference/ai_usage_ledger_reads_reference.json').read_text());assert fixture['metadata']['caseCount']==216
post=json.loads((art/'node-1793282140582889970-receipt.json').read_text());strict=json.loads((art/'compiler-1793281865368129144-receipt.json').read_text());assert post['success'] and strict['success'];assert post['source_tree_sha256']==strict['source_tree_sha256']==final['source_tree_sha256']
write(out/'verification-summary.json',{'status':'Verified local three-export ledger-state read adapter. Full ledger/migration incomplete.','codeCommit':commit,'sourceTreeSha256':final['source_tree_sha256'],'sourceInputs':1278,'strictRun':'compiler-1793281865368129144','oracleRun':'node-1793281963678956437','runtimeRun':'compiler-fixtures-1793282076062196276','postNodeRun':'node-1793282140582889970','ordinaryTests':6,'ignoredTestsRun':2,'actualSourceCases':216,'sourceDeclarations':6,'publicPackageFilesHashed':445,'runtimeScriptSeconds':8.52,'runtimeTotalSeconds':final['elapsed_seconds'],'strictScriptSeconds':28.991,'strictTotalSeconds':strict['elapsed_seconds'],'peakCacheBytes':max(final['peak_cache_bytes'],strict['peak_cache_bytes']),'minimumAvailableBytes':min(final['minimum_available_bytes'],strict['minimum_available_bytes']),'limits':final['limits'],'productionUnchangedRecords':19,'ownedResourcesRemaining':owned,'earlierFailures':'Optional BSON extjson test API replaced by source/native BSON wrapper bytes; test-only chunk/if Clippy corrections. Original bytes and receipts retained. Native coercion bodies unchanged; four helper visibilities now crate-internal for query reuse.','runs':runs,'performanceMeasured':False,'noSourceRetirementCallerAdoptionDeploymentPush':True})
write(out/'retained-artifacts.json',retained);write(out/'compressed-artifacts.json',compressed);write(out/'excluded-regenerable-artifacts.json',[{'path':'artifacts/attempt2/node-provenance/root','reason':'445 public package files listed/hashes independently verified by replay; not vendored into Git. Existing pinned Node executable reused, hash retained.'}])
(out/'README.md').write_text('# AI usage ledger-state reads evidence\n\nThe three source helpers for coverage, status and raw state have a concrete shared-client Mongo adapter. Six ordinary tests, all 216 actual-source scenarios, private Mongo query/error/pool/cancellation tests, strict checks and final pinned source checks passed. The [summary](verification-summary.json) records runs, limits and boundaries. No performance was measured.\n\nThe [source binding](source-binding.json) maps 1,278 immutable inputs to the local code commit plus ten unchanged SDK references. Earlier compiler/test-helper API and Clippy failures retain exact changed bytes and source bindings. All run receipts/logs, source oracle/declarations/typecheck/compiled code, and fixture before/after hashes are retained. Public package bytes and the reused Node executable are independently hashed, with their manifest retained instead of vendoring dependencies. Compressed payloads retain raw size/hash.\n\nThe isolated Mongo has its own task-owned internal network and enables test commands solely for the exact guarded runtime script. Source/state clocks, comparison ordering, malformed lean fields, BSON promotion, UTF-16 replacement, query casting/projection, type bracketing, driver failures and cancellation/pool recovery are covered within the documented declared-input boundary. The native DTO carries raw BSON rather than claiming JavaScript prototype identity or identical exception wording.\n\nFinal readback verifies 19 unchanged production records and zero task-owned containers, networks or volumes. No caller adoption, TypeScript retirement, deployment or push occurred. Persistence, history/transaction queries, backfill, retention and broader ledger dependencies remain separate work.\n')
write(out/'artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'compressed':len(compressed),'sourceInputsVerified':1278,'productionUnchangedRecords':19,'remainingOwnedResources':owned}))
