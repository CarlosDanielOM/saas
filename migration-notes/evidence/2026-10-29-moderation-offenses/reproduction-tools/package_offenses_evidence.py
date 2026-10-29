import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');art=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts');wave=art/'moderation-offenses/attempt1';out=root/'migration-notes/evidence/2026-10-29-moderation-offenses'
assert not out.exists();sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
commit=git('rev-parse','26accd02').decode().strip();tree='3f82f243caaa2bf492931cc3612a0f7ec3b2e361974fbea6d99b172ca1030fba';accepted=['node-1793313351977708271','compiler-1793313351980481556','compiler-fixtures-1793313608426251022'];final=json.loads((art/(accepted[-1]+'-receipt.json')).read_text());inputs=json.loads((wave/'source-inputs.json').read_text());assert inputs==final['source_hashes'] and len(inputs)==1347
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text());gh={};sdk={}
for n,d in inputs.items():
 if n.startswith('verification/'):assert old['unchangedArchiveVerifiedSdkReferences'][n]==d;sdk[n]=d
 else:assert sha(git('show',commit+':'+n))==d,n;gh[n]=d
assert len(sdk)==10
ind=json.loads((wave/'independent-reference-readback.json').read_text());fixture='b7bf7bb80d0d7169be41f8aa47e90ec9436ac216621ab6cf6cba95dbe3ee809c';assert sha((wave/'reference/moderation-offenses-reference.json').read_bytes())==fixture==ind['fixtureSha256'];assert (ind['keys'],ind['steps'],ind['cases'])==(192,12,105) and ind['allSourceNativeSdkFileHashesChecked'];assert ind['abandonedPromiseCase']['afterRelease']==['connect','incr','expire']
block=json.loads((wave/'headroom-block.json').read_text());assert block['availableBytesAfterRefusal']==6425903104 and block['outcome']=='Refused before resource creation' and not block['productionMutation'];assert final['headroom_start']['mem_available_bytes']==9641693184
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
 if m and 1793313283457666223<=int(m[2])<=1793313608426251022:
  r=json.loads(p.read_text());run=p.stem.removesuffix('-receipt');log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file() and r['success'] and r['production_unchanged'];assert run not in accepted or r['source_tree_sha256']==tree
  runs.append({'run':run,'sourceTreeSha256':r['source_tree_sha256'],'classification':'accepted final' if run in accepted else 'successful preformat nonfinal','success':True,'productionUnchanged':True});keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
assert len(runs)==4
names={'validate.py','validate_permit.py','freeze_offenses.py','freeze_permit.py','prepare_posthog_sdk.py','apply_format.py','final_readback.py',Path(__file__).name}
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name in names or p.name.startswith('offenses_') and p.suffix=='.sh'):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':commit,'sourceTreeSha256':tree,'gitFileHashes':gh,'unchangedArchiveVerifiedSdkReferences':sdk,'inputManifest':'artifacts/attempt1/source-inputs.json.gz'})
write('verification-summary.json',{'acceptedRuns':accepted,'runs':runs,'fixtureSha256':fixture,'sourceInputs':len(inputs),'sourceCases':{'keys':192,'steps':12,'commandCases':105,'abandonedPromiseContinuation':ind['abandonedPromiseCase']},'canonicalAstDigest':ind['canonicalAstDigest'],'headroomRefusal':block,'acceptedFixtureReceipt':{'steps':final['steps'],'elapsedSeconds':final['elapsed_seconds'],'headroomStart':final['headroom_start'],'minimumAvailableBytes':final['minimum_available_bytes'],'peakCacheBytes':final['peak_cache_bytes'],'limits':final['limits']},'productionUnchangedRecords':19,'remainingOwnedResources':prod['remainingOwnedResources'],'coverage':'Partial: source bootstrap global metrics and connection-event logging adapters remain missing; no TypeScript retirement or caller adoption.','benchmarkMeasured':False,'deployed':False,'pushed':False})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('''# Moderation offenses evidence\n\nThe final accepted Node, compiler and fixture runs bind to commit `26accd02` and 1,347 inputs, including ten previously verified SDK references. The retained source oracle readback records 192 keys, 12 steps, 105 command cases and abandoned-promise continuation. Its canonical declarations digest is a derived TypeScript printer hash, not a file hash; the pinned Node `--check` independently recomputed it.\n\nThe isolated runtime checks cover the exact 336-byte Lua script, fixed-window expiry without refresh, concurrent deduplication and distinct decisions, wrong types and malformed receipts, partial-write errors, continued INCR/EXPIRE after caller cancellation, reply loss without mutation retry, and opt-in evaluation telemetry context. The initial fixture launch was refused before resources were created because available memory was 6,425,903,104 bytes, below the 8 GiB startup threshold. This was a resource guard, not a test failure. The accepted fixture run started at 9,641,693,184 bytes available, completed its fixture phase in 130.683 seconds and the full run in 143.224 seconds. Final readback records 19 unchanged production records and no remaining owned resources.\n\nCoverage remains partial because application-specific global metrics and connection-event logging adapters are missing. Caller adoption and TypeScript retirement remain open. No benchmark, deployment or push is claimed.\n''')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()});print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'inputs':len(inputs),'retained':len(retained)}))
