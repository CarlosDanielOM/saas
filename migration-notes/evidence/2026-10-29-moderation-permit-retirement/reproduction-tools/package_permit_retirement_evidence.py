import gzip, hashlib, json, re, subprocess
from pathlib import Path
root=Path('/root/saas-rust'); state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp'); art=state/'artifacts'; out=root/'migration-notes/evidence/2026-10-29-moderation-permit-retirement'
assert not out.exists()
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
def commit(c): return git('rev-parse',c).decode().strip()
def gj(c,p): return json.loads(git('show',f'{c}:{p}'))
finalcommit=commit('23355cca'); initial=commit('c962f437'); archive=commit('c7ecc396')
accepted=['compiler-1793309891342492944','node-1793309891350167771','compiler-fixtures-1793309985004657594']
final=json.loads((art/(accepted[0]+'-receipt.json')).read_text()); finalhash='154399463d3773c5d12c06279333ad024fd604adcf173aafb65408b40147238f'
inputs=json.loads((art/'moderation-rule-retirement/attempt2/source-inputs.json').read_text()); assert inputs==final['source_hashes'] and len(inputs)==1335
old=json.loads((root/'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json').read_text()); gh={};sdk={}
for name,digest in inputs.items():
 if name.startswith('verification/'):
  assert old['unchangedArchiveVerifiedSdkReferences'][name]==digest;sdk[name]=digest
 else:
  assert sha(git('show',finalcommit+':'+name))==digest,name;gh[name]=digest
assert len(sdk)==10
manifest=gj(archive,'archives/dimabot-typescript/2026-10-28/manifest.json'); assert len(manifest['files'])==24
for row in manifest['files']:
 assert sha(git('show',archive+':archives/dimabot-typescript/2026-10-28/'+row['source']))==row['sha256'],row['source']
ledger='migration-notes/dimabot-dependency-matrix-2026-10-28.json';before=gj(archive+'^',ledger)['files'];after=gj(archive,ledger)['files'];assert len(before)==len(after)==806
changes=[{'before':a,'after':b} for a,b in zip(before,after) if a!=b];assert len(changes)==3
readback=json.loads((art/'moderation-rule-retirement/attempt2/final-readback.json').read_text()); assert readback['productionUnchanged'] and readback['productionRecords']==19 and all(not x for x in readback['remainingOwnedResources'].values())
ind=json.loads((art/'moderation-rule-retirement/attempt2/independent-reference-readback.json').read_text());assert ind['caps']['sourceCases']==5348 and ind['emote']['sourceCases']==360 and ind['caps']['unchangedCaseObjects'] and ind['emote']['unchangedCaseObjects'] and ind['permit']['priorGroupsUnchanged']
retained={};compressed={}
def write(name,obj):
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2)+'\n')
def keep(p,name):
 raw=p.read_bytes();q=out/name;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log':
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,mtime=0));compressed[str(q.relative_to(out))]={'rawSha256':sha(raw),'rawBytes':len(raw),'compressedSha256':sha(q.read_bytes())}
 else:q.write_bytes(raw)
 retained[str(name)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for wave in ['moderation-permit','moderation-rule-retirement']:
 for p in sorted((art/wave).rglob('*')):
  if p.is_file():keep(p,Path('artifacts')/wave/p.relative_to(art/wave))
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 m=re.fullmatch(r'(format|node|compiler|compiler-fixtures)-(\d+)-receipt.json',p.name)
 if m and 1793308636087473181<=int(m[2])<=1793309985004657594:
  r=json.loads(p.read_text());run=p.stem.removesuffix('-receipt');negative=run=='compiler-1793309518205057473'
  assert r['production_unchanged'] and r['success']==(not negative)
  if run in accepted:assert r['source_tree_sha256']==finalhash
  log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file()
  if negative:assert 'read lost parent telemetry context' in log.read_text()
  runs.append({'run':run,'success':r['success'],'productionUnchanged':r['production_unchanged'],'sourceTreeSha256':r['source_tree_sha256'],'classification':'expected negative context test' if negative else 'successful'})
  keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
assert len(runs)==10 and len([r for r in runs if r['run'] in accepted])==3
for p in sorted(Path(__file__).parent.iterdir()):
 if p.is_file() and (p.name.startswith(('permit_','moderation_retirement_')) or p.name in ['validate.py','validate_permit.py','freeze_permit.py','apply_format.py','prepare_posthog_sdk.py','final_readback.py',Path(__file__).name]):keep(p,Path('reproduction-tools')/p.name)
write('source-binding.json',{'gitCommit':finalcommit,'sourceTreeSha256':finalhash,'gitFileHashes':gh,'unchangedArchiveVerifiedSdkReferences':sdk,'inputManifest':'artifacts/moderation-rule-retirement/attempt2/source-inputs.json.gz','initialPermitCommit':initial,'archiveCommit':archive,'negativeSourceTreeSha256':next(x['sourceTreeSha256'] for x in runs if x['classification'].startswith('expected'))})
write('archive-ledger-proof.json',{'archiveCommit':archive,'manifestFileCount':len(manifest['files']),'manifestEntries':manifest['files'],'ledgerRows':len(after),'unchangedRows':len(after)-len(changes),'changedRows':changes})
write('verification-summary.json',{'acceptedRuns':accepted,'sourceTreeSha256':finalhash,'sourceInputs':len(inputs),'gitInputs':len(gh),'sdkReferences':len(sdk),'runs':runs,'capsSourceCases':ind['caps']['sourceCases'],'emoteSourceCases':ind['emote']['sourceCases'],'permitNodeLogCounts':{'parsed':395,'keys':156,'grants':78,'reads':8},'productionUnchangedRecords':19,'remainingOwnedResources':readback['remainingOwnedResources'],'coverage':'Caps and emote-spam source/archive work complete; TypeScript dispatcher and combined blacklist test imports remain unadopted, leaving TypeScript build integration open. Permit remains partial: global telemetry, runtime process metrics and connection-event logging adapters are missing. Overall Rust migration incomplete.','benchmarkMeasured':False,'deployed':False,'pushed':False})
write('retained-artifacts.json',retained);write('compressed-artifacts.json',compressed)
(out/'README.md').write_text('''# Moderation permit and rule retirement evidence\n\nThe final accepted compiler, Node, and fixture runs bind to commit `23355cca` and the 1,335-input source manifest. All 1,325 Git inputs were checked against that commit and ten SDK references against the earlier independently verified binding. The initial permit implementation (`c962f437`), negative candidate and its expected context-test failure are retained separately; the failed run is not bound to the fixed source.\n\nThe archive readback records 5,348 caps and 360 emote-spam source cases unchanged from before archive. The final permit Node record reports 395 parses, 156 keys, 78 grants and eight reads; the preserved fixtures contain the remaining detailed scenarios. The final context test and fixture replays passed, including the isolated Redis transport test. Archive manifest hashes and the three changed ledger rows are checked against `c7ecc396` and its parent. Final readback records 19 unchanged production resources and no remaining owned containers, networks or volumes.\n\nCaps and emote-spam source/archive work is complete, while TypeScript dispatcher and combined blacklist test imports are not adopted and TypeScript build integration remains open. Permit remains partial because global telemetry, runtime process metrics and connection-event logging adapters are missing. Overall migration remains incomplete. No benchmark, deployment or push is claimed.\n''')
write('artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'inputs':len(inputs),'retained':len(retained)}))
