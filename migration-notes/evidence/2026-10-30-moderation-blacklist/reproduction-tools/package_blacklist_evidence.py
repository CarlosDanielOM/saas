#!/usr/bin/env python3
"""Package verified blacklist evidence. Run only after final checks and commit.

Required JSON keys: codeCommit, finalAcceptedRuns, finalBuildRun,
finalBenchmarkRun, baselineAcceptedRuns, finalReadback. Paths are relative to
STATE; optional finalReport defaults to artifacts/moderation-blacklist/attempt2/
paired1/blacklist-paired-report.json. This script does not run validation.
"""
import gzip
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
ART = STATE / 'artifacts'
WAVE = ART / 'moderation-blacklist'
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-blacklist'
TOOLS = Path(__file__).resolve().parent
BASELINE_DIGEST = 'a57f5e2dfe36f39dbdd5297e9e58a58f0d4b36b48f392a878f337a4e8d9cfb03'
BASELINE_BINARY = '81df5d8d0672a48d4fce3fadddc9c044f1d283048be963b76d7a2e827d366348'
BASELINE_RUNS = ['compiler-1793322701237322608', 'node-1793322890142509580',
                 'compiler-1793322965278247652', 'node-1793323167311731526']
FIRST = 1793322221709262584
GIB = 1024 ** 3


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text())


def state_path(value):
    path = (STATE / value).resolve()
    require(path.is_relative_to(STATE.resolve()) and path.is_file(), f'invalid state path: {value}')
    return path


def receipt(run):
    require(re.fullmatch(r'(?:format|node|compiler)-\d+', run) is not None, f'invalid run: {run}')
    return load(ART / (run + '-receipt.json'))


def verify_receipt(run, digest, source_hashes):
    r = receipt(run)
    require(r['phase'] == run.split('-')[0] and r['success'] is True, f'failed receipt {run}')
    require(r['production_unchanged'] is True and r['limits_verified'] is True, f'unsafe receipt {run}')
    require(r['source_tree_sha256'] == digest and r['source_hashes'] == source_hashes, f'source mismatch {run}')
    lim = r['limits']
    require(lim['cpus'] == 6 and lim['memory'] == 4 * GIB and lim['memory_swap'] == 4 * GIB
            and lim['pids'] == 256 and (lim['cargo_jobs'] == 2 if r['phase'] == 'compiler'
                                        else lim['cargo_jobs'] is None), f'limits mismatch {run}')
    require(all(step['exit_code'] == 0 for step in r['steps']), f'failed step {run}')
    require(r['minimum_available_bytes'] > 0, f'missing headroom {run}')
    if r['phase'] == 'compiler':
        require(r['peak_cache_bytes'] <= 8 * GIB, f'cache limit {run}')
    return r


def bind(hashes, commit, sdk, overrides=None):
    git_files, sdk_files, staged = {}, {}, {}
    overrides = overrides or {}
    for name, expected in hashes.items():
        if name in overrides:
            data = (WAVE / 'attempt1/baseline-source' / name).read_bytes()
            require(sha(data) == expected == overrides[name], f'baseline override mismatch: {name}')
            staged[name] = expected
        elif name.startswith('verification/'):
            require(name in sdk and sdk[name] == expected, f'SDK binding mismatch: {name}')
            sdk_files[name] = expected
        else:
            data = subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT)
            require(sha(data) == expected, f'git binding mismatch: {name}')
            git_files[name] = expected
    require(len(sdk_files) == 10 and set(staged) == set(overrides), 'SDK or override count mismatch')
    return git_files, sdk_files, staged


def medians(report):
    require(report['status'] == 'passed' and report['workloads'], 'benchmark report not passed')
    return {name: {actor: workload['metrics'][actor]['medianNsPerOperation']
                   for actor in ('node', 'rust')}
            for name, workload in report['workloads'].items()}


def main():
    require(len(sys.argv) == 2, 'usage: package_blacklist_evidence.py CONFIG.json')
    config_path = Path(sys.argv[1]).resolve()
    config = load(config_path)
    require(not OUT.exists(), f'output already exists: {OUT}')
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', config['codeCommit'] + '^{commit}'], cwd=ROOT, text=True).strip()
    final_runs = config['finalAcceptedRuns']
    require(isinstance(final_runs, list) and len(final_runs) >= 4 and len(set(final_runs)) == len(final_runs), 'invalid final runs')
    require(config['baselineAcceptedRuns'] == BASELINE_RUNS, 'baseline run list differs')
    require(config['finalBuildRun'] in final_runs and config['finalBenchmarkRun'] in final_runs, 'build/benchmark run not accepted')
    final = receipt(config['finalBuildRun'])
    final_hashes = final['source_hashes']
    require(len(final_hashes) == 1366, 'unexpected final input count')
    final_receipts = {run: verify_receipt(run, final['source_tree_sha256'], final_hashes) for run in final_runs}
    baseline = receipt(BASELINE_RUNS[0])
    require(len(baseline['source_hashes']) == 1366, 'unexpected baseline input count')
    baseline_receipts = {run: verify_receipt(run, BASELINE_DIGEST, baseline['source_hashes']) for run in BASELINE_RUNS}
    sdk_binding = load(ROOT / 'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json')['unchangedArchiveVerifiedSdkReferences']
    git_files, sdk_files, _ = bind(final_hashes, commit, sdk_binding)
    overrides = load(WAVE / 'attempt1/baseline-source/manifest.json')
    require(len(overrides) == 4, 'unexpected baseline override count')
    intermediate_commit = subprocess.check_output(['git', 'rev-parse', '--verify', '1b177dc1^{commit}'], cwd=ROOT, text=True).strip()
    intermediate_runs = ['compiler-1793323441225536137', 'node-1793323469674628401', 'compiler-1793323488578461034', 'node-1793323686654730244']
    intermediate = receipt(intermediate_runs[0])
    for run in intermediate_runs:
        verify_receipt(run, intermediate['source_tree_sha256'], intermediate['source_hashes'])
    middle_git, middle_sdk, _ = bind(intermediate['source_hashes'], intermediate_commit, sdk_binding)
    prefilter_commit = subprocess.check_output(['git', 'rev-parse', '--verify', '78badad7^{commit}'], cwd=ROOT, text=True).strip()
    prefilter_receipt = receipt('compiler-1793323863681726952')
    prefilter_git, prefilter_sdk, _ = bind(prefilter_receipt['source_hashes'], prefilter_commit, sdk_binding)
    base_git, base_sdk, staged = bind(baseline['source_hashes'], commit, sdk_binding, overrides)
    require(sha((WAVE / 'attempt1/bin/moderation_blacklist_benchmark').read_bytes()) == BASELINE_BINARY, 'baseline binary mismatch')
    acknowledged = STATE / 'production-baselines/piper-removal-acknowledged-2026-10-30'
    ack, before, after = (load(acknowledged / n) for n in ('acknowledgement.json', 'before.json', 'after.json'))
    require(ack['remainingUnchanged'] == 18 and ack['changedOnly'] == ['/piper-tts'] and
            len(after) == 18 and len(before) == 19 and set(before) - set(after) == {'/piper-tts'} and
            all(before[k] == v for k, v in after.items()), 'production acknowledgement mismatch')
    readback_path = state_path(config['finalReadback'])
    readback = load(readback_path)
    require(readback['productionUnchanged'] is True and readback['productionRecords'] == 18 and
            readback['productionRecordsAfter'] == after and
            all(not resources for resources in readback['remainingOwnedResources'].values()) and
            set(readback['remainingOwnedResources']) == {'containers', 'networks', 'volumes'}, 'final readback mismatch')
    baseline_report = load(WAVE / 'attempt1/paired1/blacklist-paired-report.json')
    final_report_path = state_path(config.get('finalReport', 'artifacts/moderation-blacklist/attempt2/paired1/blacklist-paired-report.json'))
    final_report = load(final_report_path)
    base_medians, final_medians = medians(baseline_report), medians(final_report)
    require(set(base_medians) == set(final_medians), 'workload mismatch')
    end = int(config['finalBenchmarkRun'].rsplit('-', 1)[1])
    require(end >= FIRST and all(FIRST <= int(run.rsplit('-', 1)[1]) <= end for run in final_runs + BASELINE_RUNS), 'run range mismatch')
    runs = []
    for path in sorted(ART.glob('*-receipt.json')):
        match = re.fullmatch(r'(format|node|compiler)-(\d+)-receipt.json', path.name)
        if match and FIRST <= int(match[2]) <= end:
            run = path.name.removesuffix('-receipt.json')
            r = load(path)
            log = ART / (run + '.log')
            require(log.is_file(), f'missing log: {run}')
            runs.append((path, log, {'run': run, 'success': r['success'],
                                     'sourceTreeSha256': r.get('source_tree_sha256'),
                                     'productionUnchanged': r.get('production_unchanged')}))
    require(set(final_runs + BASELINE_RUNS).issubset({r[2]['run'] for r in runs}), 'missing accepted run')
    OUT.mkdir(parents=True, exist_ok=False)
    retained, compressed = {}, {}
    def keep(path, relative):
        raw = path.read_bytes()
        stored = Path(relative)
        if len(raw) > 65536 or path.suffix == '.log' or path.stat().st_mode & 0o111:
            stored = stored.with_name(stored.name + '.gz')
            data = gzip.compress(raw, mtime=0)
            compressed[str(stored)] = {'rawSha256': sha(raw), 'rawBytes': len(raw)}
        else:
            data = raw
        dest = OUT / stored
        require(not dest.exists(), f'duplicate output: {dest}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        retained[str(relative)] = {'storedPath': str(stored), 'rawSha256': sha(raw), 'rawBytes': len(raw)}
    def write(name, data):
        (OUT / name).write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    for path in sorted(WAVE.rglob('*')):
        if path.is_file():
            keep(path, Path('artifacts') / path.relative_to(WAVE))
    for path, log, _ in runs:
        keep(path, Path('runs') / path.name)
        keep(log, Path('runs') / log.name)
    for path in sorted(acknowledged.iterdir()):
        if path.is_file():
            keep(path, Path('production-baseline') / path.name)
    keep(readback_path, Path('production-baseline/final-readback.json'))
    if not final_report_path.is_relative_to(WAVE):
        keep(final_report_path, Path('reports/final-benchmark-report.json'))
    keep(config_path, Path('configuration.json'))
    for path in sorted(TOOLS.iterdir()):
        if path.is_file() and (('blacklist' in path.name) or path.name in {'freeze_redis_application.py', 'freeze_seed_retirement.py', 'freeze_seed_plan.py', 'freeze_offenses.py', 'freeze_permit.py', 'validate.py', 'apply_format.py', 'prepare_posthog_sdk.py', 'final_readback.py'}):
            keep(path, Path('reproduction-tools') / path.name)
    write('source-binding.json', {'gitCommit': commit, 'sourceTreeSha256': final['source_tree_sha256'],
          'gitFileHashes': git_files, 'unchangedArchiveVerifiedSdkReferences': sdk_files})
    write('long-prefilter-binding.json', {'gitCommit': prefilter_commit, 'sourceTreeSha256': prefilter_receipt['source_tree_sha256'], 'gitFileHashes': prefilter_git, 'unchangedArchiveVerifiedSdkReferences': prefilter_sdk})
    write('intermediate-binding.json', {'gitCommit': intermediate_commit, 'sourceTreeSha256': intermediate['source_tree_sha256'], 'acceptedRuns': intermediate_runs, 'gitFileHashes': middle_git, 'unchangedArchiveVerifiedSdkReferences': middle_sdk})
    write('baseline-binding.json', {'comparisonCommit': commit, 'sourceTreeSha256': BASELINE_DIGEST,
          'gitFileHashes': base_git, 'baselineSourceOverrides': staged,
          'unchangedArchiveVerifiedSdkReferences': base_sdk, 'binarySha256': BASELINE_BINARY})
    write('verification-summary.json', {'codeCommit': commit, 'baselineAcceptedRuns': BASELINE_RUNS,
          'finalAcceptedRuns': final_runs, 'finalBuildRun': config['finalBuildRun'],
          'finalBenchmarkRun': config['finalBenchmarkRun'], 'baselineSourceTreeSha256': BASELINE_DIGEST,
          'finalSourceTreeSha256': final['source_tree_sha256'], 'baselineReceipts': {k: {field: value for field, value in r.items() if field != 'source_hashes'} for k, r in baseline_receipts.items()},
          'finalReceipts': {k: {field: value for field, value in r.items() if field != 'source_hashes'} for k, r in final_receipts.items()}, 'baselineMediansNsPerOperation': base_medians,
          'intermediateMediansNsPerOperation': medians(load(WAVE / 'attempt2/paired1/blacklist-paired-report.json')),
          'longPrefilter40000IterationMediansNsPerOperation': medians(load(WAVE / 'attempt3/stability-paired1/blacklist-paired-report.json')),
          'longPrefilter4000IterationMediansNsPerOperation': medians(load(WAVE / 'attempt3/paired1/blacklist-paired-report.json')),
          'finalReportIterations': final_report['iterations'],
          'finalMediansNsPerOperation': final_medians, 'productionRecords': 18,
          'runs': [item[2] for item in runs]})
    write('retained-artifacts.json', retained)
    write('compressed-artifacts.json', compressed)
    write('artifact-sha256.json', {str(p.relative_to(OUT)): sha(p.read_bytes())
          for p in sorted(OUT.rglob('*')) if p.is_file() and p.name != 'artifact-sha256.json'})
    print(json.dumps({'output': str(OUT), 'runs': len(runs), 'sourceInputs': len(final_hashes)}))


if __name__ == '__main__':
    main()
