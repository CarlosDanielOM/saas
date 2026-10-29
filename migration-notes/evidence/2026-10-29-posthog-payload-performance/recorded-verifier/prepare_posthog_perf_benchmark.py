"""Retain Node timing trials only after a byte-exact native-source-only audit."""
import hashlib
import json
from pathlib import Path

state = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
baseline = state/'artifacts/posthog-receipt/attempt4/benchmark'
output = state/'artifacts/posthog-payload-performance/attempt1/benchmark'
assert not output.exists()
snapshot = json.loads((state/'snapshot.json').read_text())
original = (baseline/'input.json').read_bytes()
node_original = (baseline/'node-report.json').read_bytes()
input_value = json.loads(original)
node_value = json.loads(node_original)
sha = lambda raw: hashlib.sha256(raw).hexdigest()
assert sha(original) == '0ab05c2240b6af9f930b0a2824f89bb239d5cc4bd5e24cd6b866aa29ac753e4d'
assert node_value['inputSha256'] == sha(original)
hashes = input_value['metadata']['hashes']
changes = {path:{'before':old,'after':snapshot['dimabot/'+path]}
           for path,old in hashes.items() if old != snapshot['dimabot/'+path]}
assert set(changes) == {'src/utils/js_string.rs','src/utils/lossless_json.rs',
                        'src/utils/posthog_tracking.rs'}, changes
candidate = original
node_candidate = node_original
for path,change in changes.items():
    old,new = change['before'].encode(),change['after'].encode()
    assert candidate.count(old)==1 and node_candidate.count(old)==1, path
    candidate = candidate.replace(old,new)
    node_candidate = node_candidate.replace(old,new)
new_sha = sha(candidate)
old_sha = sha(original).encode()
assert node_candidate.count(old_sha)==1
node_candidate = node_candidate.replace(old_sha,new_sha.encode())
new_input = json.loads(candidate)
new_node = json.loads(node_candidate)
assert new_input['pools']==input_value['pools']
assert new_node['pools']==node_value['pools']
assert new_node['metadata']==new_input['metadata']
assert all(snapshot['dimabot/'+p]==h for p,h in new_input['metadata']['hashes'].items())
assert len(new_input['pools'])==6
assert sum(len(p['inputs']) for p in new_input['pools'])==192
marker = original.index(b',"pools":')
assert candidate[marker:]==original[marker:]
output.mkdir(parents=True)
(output/'input.json').write_bytes(candidate)
(output/'node-report.json').write_bytes(node_candidate)
audit = {'scope':'Only three native implementation hashes and resulting input SHA rebound. All TypeScript, loaders/harnesses, prepared pool bytes, expected wires, checksums, workload sizes and every saved Node trial remain byte-identical. No Node timing rerun.',
    'baselineInputSha256':sha(original),'candidateInputSha256':new_sha,
    'baselineNodeReportSha256':sha(node_original),'candidateNodeReportSha256':sha(node_candidate),
    'nativeImplementationHashChanges':changes,
    'preparedPoolsBytesSha256':sha(original[marker:]),
    'expectedSourcePayloads':192,'savedNodeTrials':sum(len(p['trials']) for p in node_value['pools']),
    'sourceTreeSha256':sha(json.dumps(snapshot,sort_keys=True).encode()),
    'requiredFollowup':'Independent parent input SHA, native wire/checksum validation before timing, then actual pinned Node --check against current source after native report exists.'}
(output.parent/'benchmark-reuse-audit.json').write_text(json.dumps(audit,indent=2)+'\n')
(output.parent/'parent-input-before.sha256').write_text(new_sha+'  /artifacts/posthog-payload-performance/attempt1/benchmark/input.json\n')
print(json.dumps({'inputSha256':new_sha,'nativeHashChanges':list(changes),
                  'savedNodeTrials':audit['savedNodeTrials']}))
