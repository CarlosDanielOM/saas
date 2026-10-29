"""Retain the full three-candidate measurement series and exact-source proofs."""
import gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path('/root/saas-rust');s=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');art=s/'artifacts';w=art/'receipt-parser-benchmark';tools=Path('/tmp/dimabot-full-migration-tools')
out=root/'migration-notes/evidence/2026-10-29-receipt-parser-performance';assert not out.exists()
sha=lambda b:hashlib.sha256(b).hexdigest()
last=json.loads((w/'attempt4/final-verified-runs.json').read_text())
for key in ['strictRun','oracleRun','releaseRun','postNodeRun']:
 r=json.loads((art/(last[key]+'-receipt.json')).read_text());assert r['success'] and r['production_unchanged'];assert r['source_tree_sha256']==last['sourceTreeSha256']
assert json.loads((w/'attempt4/final-readback.json').read_text())['productionUnchanged']
out.mkdir(parents=True);retained={};compressed={};excluded=[]
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,indent=2)+'\n')
def keep(p,rel):
 raw=p.read_bytes();q=out/rel;q.parent.mkdir(parents=True,exist_ok=True)
 if len(raw)>65536 or p.suffix=='.log':
  q=q.with_name(q.name+'.gz');q.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0));compressed[str(q.relative_to(out))]={'originalPath':str(rel),'rawSha256':sha(raw),'rawBytes':len(raw)}
 else:q.write_bytes(raw)
 retained[str(rel)]={'storedPath':str(q.relative_to(out)),'rawSha256':sha(raw),'rawBytes':len(raw)}
for p in sorted(w.rglob('*')):
 if not p.is_file():continue
 rel=p.relative_to(w)
 if rel.parts[0] in ['attempt1','lookup-diagnostic','pre-lint-source'] or rel.name.startswith('initial-'):continue
 if p.name=='profile':
  excluded.append({'path':str(rel),'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size,'reason':'Regenerable diagnostic executable; source, release rlib hash and reports retained.'});continue
 keep(p,Path('artifacts')/rel)
runs=[]
for p in sorted(art.glob('*-receipt.json')):
 match=re.fullmatch(r'(format|node|compiler)-(\d+)-receipt.json',p.name)
 if not match or not 1793275264851514983<=int(match[2])<=int(last['postNodeRun'].split('-')[-1]):continue
 v=json.loads(p.read_text());log=p.with_name(p.name.replace('-receipt.json','.log'));assert log.is_file();keep(p,Path('runs')/p.name);keep(log,Path('runs')/log.name)
 runs.append({k:v[k] for k in ['phase','success','source_tree_sha256','production_unchanged']}|{'receipt':retained[str(Path('runs')/p.name)]['storedPath'],'log':retained[str(Path('runs')/log.name)]['storedPath']})
for p in sorted(tools.iterdir()):
 if p.is_file() and (p.name.startswith(('receipt_','borrowed_lookup_','prepare_receipt_','trim_pre_')) or p.name in ['freeze_receipt_parser_benchmark.py','validate.py','apply_format.py','prepare_posthog_sdk.py','package_receipt_parser_performance.py']):keep(p,Path('recorded-verifier')/p.name)
write(out/'verification-summary.json',last|{'runs':runs,'initialBaselineEvidence':'../2026-10-29-receipt-parser-baseline/README.md','stageDiagnosticsAreSeparateNotAdditive':True,'CPUandRSSmeasured':False,'noSourceRetirementCallerAdoptionDeploymentPush':True})
write(out/'compressed-artifacts.json',compressed);write(out/'retained-artifacts.json',retained);write(out/'excluded-regenerable-artifacts.json',excluded)
(out/'README.md').write_text('# Receipt parser performance evidence\n\nThree bounded native changes were measured against the same 42 saved TypeScript trials: borrowed key lookup, borrowed field serialization, and validated string scalar shortcuts. All six final Rust medians are lower than TypeScript. The [summary](verification-summary.json), [six-pool data](artifacts/attempt4/comparison-data.json), and raw reports retain every trial and range. These are sequential synthetic wall-time measurements; no statistical, CPU, RSS, database, queue, network, or whole-application claim is made.\n\nThe [initial baseline](../2026-10-29-receipt-parser-baseline/README.md) retains four original Rust regressions. Attempts 2 and 3 preserve intermediate candidates and their three remaining regressions. Every candidate has an audited native-only hash rebind: TypeScript source/harness, raw prepared inputs, 192 expected source wires, operation counts and saved trials remain unchanged. Independent SHA checks and pinned Node --check follow each native run.\n\nEach frozen candidate is bound to its local code commit and ten unchanged SDK source references. Actual-source parser results, producer recipes, wires, BSON expectations and all five timezone results stayed identical. Final validation includes strict checks, focused ordinary tests, the source corpus and producer/BSON replay under all five timezones. Earlier failed fixture setup, run receipts, exact Rlib stage diagnostics and scoped cache maintenance remain recorded. Raw compressed artifacts retain their decompressed hash and size; regenerable profile executables are excluded with hashes.\n\nFinal readback verifies 19 unchanged production records and no task-owned containers, networks or volumes. No TypeScript retirement, caller adoption, deployment or push occurred. The full migration remains incomplete.\n')
write(out/'artifact-sha256.json',{str(p.relative_to(out)):sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()})
print(json.dumps({'files':sum(p.is_file() for p in out.rglob('*')),'runs':len(runs),'compressed':len(compressed),'excludedExecutables':len(excluded)}))
