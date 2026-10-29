"""Reuse exact TypeScript observations after three audited native serialization/lookup hash changes."""
import hashlib,json
from pathlib import Path
state=Path('/root/.local/state/rust-full-migration-20261028-lu443ytp');wave=state/'artifacts/receipt-parser-benchmark';base=wave/'attempt1/benchmark';target=wave/'attempt3/benchmark';assert not target.exists();target.mkdir(parents=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
raw=(base/'inputs.json').read_bytes();old=json.loads(raw);changes={}
for entry in old['nativeFiles']:
 h=sha((state/'source/dimabot'/entry['file']).read_bytes())
 if h!=entry['sha256']:changes[entry['file']]={'before':entry['sha256'],'after':h}
assert set(changes)=={'src/utils/ai_usage_receipt_parser.rs','src/utils/lossless_json.rs','src/utils/lossless_json_view.rs'},changes
newraw=raw
for item in changes.values():
 assert newraw.count(item['before'].encode())==1
 newraw=newraw.replace(item['before'].encode(),item['after'].encode())
new=json.loads(newraw)
assert old['pools']==new['pools'] and old['harness']==new['harness'] and old['provenance']==new['provenance']
assert raw.count(b'"pools":')==1 and newraw.count(b'"pools":')==1
pools=raw[raw.index(b'"pools":'):];assert pools==newraw[newraw.index(b'"pools":'):]
for entry in new['nativeFiles']:assert sha((state/'source/dimabot'/entry['file']).read_bytes())==entry['sha256'],entry['file']
for entry in new['harness']+new['provenance']:assert sha((state/'source/dimabot'/entry['file']).read_bytes())==entry['sha256'],entry['file']
oldsha=sha(raw);newsha=sha(newraw);nodebytes=(base/'node-report.json').read_bytes();assert nodebytes.count(oldsha.encode())==1
newnode=nodebytes.replace(oldsha.encode(),newsha.encode());a=json.loads(nodebytes);b=json.loads(newnode);assert a['pools']==b['pools'] and a['runtime']==b['runtime']
(target/'inputs.json').write_bytes(newraw);(target/'node-report.json').write_bytes(newnode)
snapshot=json.loads((state/'snapshot.json').read_text())
(wave/'attempt3/benchmark-reuse-audit.json').write_text(json.dumps({'scope':'Only three native implementation hashes and the resulting input SHA rebound. Every TypeScript source, loader/harness, raw prepared-pool suffix, source wire, checksum, warmup, operation count and saved Node trial is unchanged. No Node timing rerun.','baselineInputSha256':oldsha,'candidateInputSha256':newsha,'baselineNodeReportSha256':sha(nodebytes),'candidateNodeReportSha256':sha(newnode),'nativeHashChanges':changes,'preparedPoolsRawBytesSha256':sha(pools),'sourceWires':192,'savedNodeTrials':42,'sourceTreeSha256':sha(json.dumps(snapshot,sort_keys=True).encode()),'requiredFollowup':'Independent input SHA before/after, native192wire/checksum prevalidation and fresh report, then actual pinned Node --check against current source.'},indent=2)+'\n')
print(json.dumps({'inputSha256':newsha,'nativeSourceChanges':changes,'sourceWires':192,'nodeTrialsRetained':42}))
