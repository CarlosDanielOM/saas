import hashlib, json, math, statistics, sys
from pathlib import Path

wave = Path(sys.argv[1])
prepared = wave / 'prepared'
report_path = prepared / 'rust-node-trials.json'
report = json.loads(report_path.read_text())
independent = json.loads((wave / 'independent-input-hashes.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
input_hash = sha((prepared / 'inputs.json').read_bytes())
assert input_hash == independent['commonInputSha256']
assert report['inputSha256Before'] == report['inputSha256After'] == input_hash
assert report['nodeExecutableSha256'] == independent['pinnedNodeSha256']
source = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp/source/dimabot/src/utils/ai_usage_ledger_persistence.rs')
assert report['nativeSourceSha256'] == sha(source.read_bytes())
inputs = json.loads((prepared / 'inputs.json').read_text())
samples = report['samples']
assert len(samples) == 35
summaries, sink = [], 0
for days in [1, 30, 90, 366, 3660]:
    group_count = len(inputs[str(days)])
    warmup = max(3, min(10000, math.ceil(100000 / group_count)))
    ops = max(1, min(1000, math.ceil(50000 / group_count)))
    rows = [r for r in samples if r['days'] == days]
    assert sorted(r['trial'] for r in rows) == list(range(7))
    for r in rows:
        assert r['groupCount'] == group_count
        assert r['warmupOps'] == warmup and r['timedOps'] == ops
        assert r['checksum'] == days * ops
        assert r['first'] == ('node' if r['trial'] % 2 == 0 else 'rust')
        for language in ['node', 'rust']:
            elapsed = r[language + 'Ns']
            assert isinstance(elapsed, int) and elapsed > 0
            assert math.isclose(r[language + 'NsPerOp'], elapsed / ops, rel_tol=1e-14)
    sink += days * warmup + 7 * days * ops
    stats = {}
    for language in ['node', 'rust']:
        timings = [r[language + 'NsPerOp'] for r in rows]
        stats[language] = {'medianNsPerOp': statistics.median(timings),
                           'minNsPerOp': min(timings), 'maxNsPerOp': max(timings)}
    summaries.append({'days': days, 'groups': group_count, 'timedOpsPerTrial': ops,
                       'warmupOps': warmup, 'trials': 7, **stats})
assert report['nodeSink'] == sink % 2**32
summary = {'scope': 'Prepared finite-number ASCII daily reduction only; no DB, lock, transport, parsing or schema-construction timings.',
           'reportSha256': sha(report_path.read_bytes()), 'inputSha256': input_hash,
           'nativeSourceSha256': report['nativeSourceSha256'],
           'nodeExecutableSha256': report['nodeExecutableSha256'],
           'all35SamplesCountsChecksumsAndRecomputedNsPerOpVerified': True,
           'workloads': summaries}
output = wave / 'independent-report-readback.json'
assert not output.exists()
output.write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
