#!/usr/bin/env python3
"""Prepare the final moderation-spam evidence bundle from parent-supplied proof.

This packager deliberately has no implicit final checkout binding. It requires
the parent to provide the verified code commit, accepted source-bound runs,
the end of the retained run interval, benchmark report, and final readback.
It only copies, validates, hashes and indexes evidence; it does not run Node,
Cargo, Docker, application code, tests, or benchmarks.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
DEFAULT_STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
DEFAULT_FIRST_RUN = 1793338086044404827
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-spam'
BASELINE_CODE_COMMIT = '4de832378acd341f415f59f99150b8d556f54f66'
BASELINE_REPORT = DEFAULT_STATE / 'artifacts/moderation-spam/paired-attempt1/spam-paired-report.json'
BASELINE_READBACK = DEFAULT_STATE / 'artifacts/moderation-spam/paired-attempt1/independent-readback.json'
BASELINE_TOOLS = DEFAULT_STATE / 'artifacts/moderation-spam/paired-tools-attempt1'
PREVIOUS_BINDINGS = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json'
SDK_BINDING = 'cache-and-types'
EXPECTED_WORKLOADS = {'invitation', 'settings', 'rule_context', 'review_policy', 'marker'}
EXPECTED_BENCH_INPUT_SHA = '9f54153d86b2f91417733343c744d4f8e17d0a1a6bf744df1779ea3bcad6086b'
EXPECTED_BENCH_SOURCE_REPORT_SHA = 'dbebe74f3ca9e43ab7e69fb61bb021f2889e0472e50e71f2d6d98d754bfa7cad'
EXPECTED_BORROWED_CONFIG_SHA = '9f18b49ade942ad67fe4eadbe708222a17b7870129e9bbfcdd89d967e5436596'


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load(path: Path):
    return json.loads(path.read_text())


def git(*args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run_number(name: str) -> int | None:
    match = re.search(r'-(\d+)(?:-receipt\.json|\.log)?$', name)
    return int(match.group(1)) if match else None


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--code-commit', required=True, help='final locally verified source commit')
    parser.add_argument('--accepted-run', action='append', required=True,
                        help='successful source/oracle/functional/bootstrap/quality run; repeat')
    parser.add_argument('--last-run', required=True, type=int,
                        help='numeric run bound for complete retained attempt history')
    parser.add_argument('--readback', required=True, type=Path,
                        help='parent final production identity and owned-resource readback')
    parser.add_argument('--benchmark-report', required=True, type=Path,
                        help='parent-reviewed borrowed-view 70-record benchmark report')
    parser.add_argument('--baseline-code-commit', default=BASELINE_CODE_COMMIT,
                        help='code commit used by the immutable owned-JSON baseline')
    parser.add_argument('--baseline-run', action='append', required=True,
                        help='successful source-bound baseline run; repeat for strict and Node checks')
    parser.add_argument('--baseline-benchmark-report', type=Path, default=BASELINE_REPORT,
                        help='immutable original owned-JSON paired report')
    parser.add_argument('--baseline-readback', type=Path, default=BASELINE_READBACK,
                        help='independent readback for the original owned-JSON benchmark')
    parser.add_argument('--baseline-tools', type=Path, default=BASELINE_TOOLS,
                        help='immutable tools copied before baseline timing')
    parser.add_argument('--performance-review', required=True,
                        help='parent-reviewed benchmark interpretation, including representation and limits')
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE,
                        help='task-owned full-migration evidence state directory')
    parser.add_argument('--first-run', type=int, default=DEFAULT_FIRST_RUN)
    args = parser.parse_args()

    state = args.state.resolve(strict=True)
    assert state.parent == Path('/root/.local/state') and state.name.startswith('rust-full-migration-20261028-')
    art = state / 'artifacts'
    spam_art = art / 'moderation-spam'
    assert spam_art.is_dir(), spam_art
    assert not OUT.exists(), f'refusing to overwrite evidence: {OUT}'
    assert args.last_run >= args.first_run
    assert args.readback.is_file() and args.benchmark_report.is_file()
    assert args.performance_review.strip(), 'parent-reviewed benchmark interpretation is required'
    commit = git('rev-parse', args.code_commit).decode().strip()
    assert commit == args.code_commit, (commit, args.code_commit)
    baseline_commit = git('rev-parse', args.baseline_code_commit).decode().strip()
    assert baseline_commit == args.baseline_code_commit, (baseline_commit, args.baseline_code_commit)
    assert args.baseline_benchmark_report.is_file() and args.baseline_readback.is_file()
    assert args.baseline_tools.is_dir() and (args.baseline_tools / 'sha256.json').is_file()
    borrowed_config = Path('/tmp/dimabot-full-migration-tools/spam_borrowed_paired_config.json')
    assert borrowed_config.is_file() and sha(borrowed_config.read_bytes()) == EXPECTED_BORROWED_CONFIG_SHA
    prepared_input = spam_art / 'benchmark-attempt1/input.json'
    prepared_source_report = spam_art / 'benchmark-attempt1/source-report.json'
    extension_comparison = spam_art / 'attempt4/reference-extension-comparison.json'
    assert sha(prepared_input.read_bytes()) == EXPECTED_BENCH_INPUT_SHA
    assert sha(prepared_source_report.read_bytes()) == EXPECTED_BENCH_SOURCE_REPORT_SHA
    extension = load(extension_comparison)
    assert extension.get('original1267PureRecordsByteValuesUnchanged') is True
    assert extension.get('all37AsyncRecordsUnchanged') is True
    assert extension.get('additionalPureRecords') == 369

    receipts = []
    for run in args.accepted_run:
        receipt_path = art / f'{run}-receipt.json'
        assert receipt_path.is_file(), receipt_path
        receipt = load(receipt_path)
        assert receipt.get('success') is True, run
        assert receipt.get('production_unchanged') is True, run
        receipts.append((run, receipt))
    assert receipts
    source_sets = {json.dumps(receipt['source_hashes'], sort_keys=True) for _, receipt in receipts}
    assert len(source_sets) == 1, 'accepted phases do not bind to one immutable source snapshot'
    final_receipt = receipts[-1][1]
    source_hashes = final_receipt['source_hashes']
    source_tree = sha(json.dumps(source_hashes, sort_keys=True).encode())
    assert source_tree == final_receipt.get('source_tree_sha256')

    sdk_source = load(PREVIOUS_BINDINGS)
    sdk = sdk_source[SDK_BINDING]['archiveVerifiedSdkInputs']
    sdk_in_snapshot = {p: h for p, h in source_hashes.items() if p.startswith('verification/posthog-rs/')}
    assert sdk_in_snapshot == sdk, 'reused SDK snapshot inputs differ from the accepted prior binding'
    git_inputs = {}
    for path, expected in source_hashes.items():
        if path in sdk:
            continue
        actual = sha(git('show', f'{commit}:{path}'))
        assert actual == expected, (path, expected, actual)
        git_inputs[path] = expected
    assert len(git_inputs) + len(sdk) == len(source_hashes)

    # Keep a separate immutable binding for the original benchmark candidate.
    # Its timings are useful as a within-task comparison, but they do not bind to
    # the borrowed-view source tree accepted below.
    baseline_receipts = []
    for run in args.baseline_run:
        receipt_path = art / f'{run}-receipt.json'
        assert receipt_path.is_file(), receipt_path
        receipt = load(receipt_path)
        assert receipt.get('success') is True and receipt.get('production_unchanged') is True, run
        baseline_receipts.append((run, receipt))
    assert baseline_receipts
    baseline_source_sets = {json.dumps(receipt['source_hashes'], sort_keys=True)
                            for _, receipt in baseline_receipts}
    assert len(baseline_source_sets) == 1, 'baseline phases do not bind to one immutable source snapshot'
    baseline_source_hashes = baseline_receipts[-1][1]['source_hashes']
    baseline_source_tree = sha(json.dumps(baseline_source_hashes, sort_keys=True).encode())
    assert baseline_source_tree == baseline_receipts[-1][1].get('source_tree_sha256')
    baseline_git_inputs = {}
    for path, expected in baseline_source_hashes.items():
        if path in sdk:
            assert sdk[path] == expected, (path, expected, sdk[path])
            continue
        actual = sha(git('show', f'{baseline_commit}:{path}'))
        assert actual == expected, (path, expected, actual)
        baseline_git_inputs[path] = expected

    readback_raw = args.readback.read_bytes()
    readback = json.loads(readback_raw)
    assert readback.get('productionUnchanged') is True
    assert readback.get('all70ActorsAndChecksumsVerified') is True
    assert readback.get('alternatingPairOrderVerified') is True
    assert readback.get('beforeAfterHashesMatch') is True
    assert all(value in (0, False, None, [], {})
               for value in readback.get('remainingOwnedResources', {}).values())

    # Benchmark success requires five named workloads, seven fresh alternating
    # pairs per workload, matching actor checksums/input hashes and no failed
    # sample. Parent review remains required for the final interpretation.
    bench_raw = args.benchmark_report.read_bytes()
    benchmark = json.loads(bench_raw)
    workloads = benchmark.get('workloads')
    assert isinstance(workloads, dict) and set(workloads) == EXPECTED_WORKLOADS
    by_workload: dict[str, list] = {}
    for workload, value in workloads.items():
        pairs = value.get('samples')
        assert isinstance(pairs, list) and len(pairs) == 7
        for index, pair in enumerate(pairs, start=1):
            assert isinstance(pair, dict) and pair.get('pair') == index
            expected_order = ['node', 'rust'] if index % 2 else ['rust', 'node']
            assert pair.get('order') == expected_order
            assert {'node', 'rust'} <= pair.keys()
            for actor in ('node', 'rust'):
                metric = pair[actor]
                assert metric.get('actor') == actor and metric.get('workload') == workload
            assert pair['node'].get('checksum') == pair['rust'].get('checksum')
            assert pair['node'].get('inputSha256') == pair['rust'].get('inputSha256')
        by_workload[workload] = pairs
    assert benchmark.get('status') == 'passed'
    assert all(pair['rust'].get('representation') == 'borrowed-read-view'
               for pairs in by_workload.values() for pair in pairs)

    baseline_report_raw = args.baseline_benchmark_report.read_bytes()
    baseline_report = json.loads(baseline_report_raw)
    baseline_readback_raw = args.baseline_readback.read_bytes()
    baseline_readback = json.loads(baseline_readback_raw)
    assert baseline_report.get('status') == 'passed'
    assert baseline_readback.get('all70ActorsAndChecksumsVerified') is True
    assert baseline_readback.get('alternatingPairOrderVerified') is True
    assert baseline_readback.get('beforeAfterHashesMatch') is True
    assert set(baseline_report.get('workloads', {})) == EXPECTED_WORKLOADS
    for workload, value in baseline_report['workloads'].items():
        pairs = value.get('samples')
        assert isinstance(pairs, list) and len(pairs) == 7
        for index, pair in enumerate(pairs, start=1):
            assert pair.get('pair') == index
            assert pair.get('order') == (['node', 'rust'] if index % 2 else ['rust', 'node'])
            assert {'node', 'rust'} <= pair.keys()
            for actor in ('node', 'rust'):
                metric = pair[actor]
                assert metric.get('actor') == actor and metric.get('workload') == workload
            assert pair['node'].get('checksum') == pair['rust'].get('checksum')
            assert pair['node'].get('inputSha256') == pair['rust'].get('inputSha256')
    final_metrics = readback.get('metricsNsPerOperation')
    baseline_metrics = baseline_readback.get('metricsNsPerOperation')
    assert isinstance(final_metrics, dict) and set(final_metrics) == EXPECTED_WORKLOADS
    assert isinstance(baseline_metrics, dict) and set(baseline_metrics) == EXPECTED_WORKLOADS
    performance_comparison = {}
    for workload in sorted(EXPECTED_WORKLOADS):
        final_rust = final_metrics[workload]['rust']['median']
        baseline_rust = baseline_metrics[workload]['rust']['median']
        node_median = final_metrics[workload]['node']['median']
        assert all(isinstance(x, (int, float)) and x > 0
                   for x in (final_rust, baseline_rust, node_median))
        performance_comparison[workload] = {
            'nodeMedianNsPerOperation': node_median,
            'ownedJsonRustMedianNsPerOperation': baseline_rust,
            'borrowedRustMedianNsPerOperation': final_rust,
            'borrowedVsOwnedChangePercent': (final_rust / baseline_rust - 1) * 100,
        }
    baseline_tool_hashes = load(args.baseline_tools / 'sha256.json')
    for name, expected in baseline_tool_hashes.items():
        assert sha((args.baseline_tools / name).read_bytes()) == expected, name

    # Retain every run artifact in the supplied time interval, including failed
    # and superseded attempts. Do not infer a source binding from the checkout.
    run_pairs = []
    run_summaries = []
    for receipt_path in sorted(art.glob('*-receipt.json')):
        number = run_number(receipt_path.name)
        if number is None or not args.first_run <= number <= args.last_run:
            continue
        run = receipt_path.name.removesuffix('-receipt.json')
        log_path = art / f'{run}.log'
        assert log_path.is_file(), log_path
        receipt = load(receipt_path)
        assert receipt.get('production_unchanged') is True, run
        run_summaries.append({
            'run': run, 'phase': receipt.get('phase'), 'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'error': receipt.get('error'), 'steps': receipt.get('steps'),
        })
        run_pairs.extend([(receipt_path, Path('runs') / receipt_path.name),
                          (log_path, Path('runs') / log_path.name)])
    included = {p.name.removesuffix('-receipt.json') for p, _ in run_pairs
                if p.name.endswith('-receipt.json')}
    assert all(run in included for run, _ in receipts)
    assert any(run_number(run) == args.first_run for run in included)
    assert any(run_number(run) == args.last_run for run in included)

    OUT.mkdir(parents=True)
    index = {}

    def put(rel: Path, raw: bytes, force_gzip: bool = False) -> None:
        assert not rel.is_absolute() and '..' not in rel.parts
        compressed = force_gzip or len(raw) > 65_536
        stored = gzip.compress(raw, mtime=0) if compressed else raw
        stored_rel = Path(str(rel) + '.gz') if compressed else rel
        dest = OUT / stored_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        assert not dest.exists(), dest
        dest.write_bytes(stored)
        index[str(rel)] = {
            'storedPath': str(stored_rel), 'rawSha256': sha(raw), 'rawBytes': len(raw),
            'storedSha256': sha(stored), 'storedBytes': len(stored), 'compressed': compressed,
        }

    for src, rel in run_pairs:
        put(rel, src.read_bytes(), force_gzip=src.suffix == '.log')
    for src in sorted(spam_art.rglob('*')):
        if src.is_file():
            put(Path('artifacts/moderation-spam') / src.relative_to(spam_art), src.read_bytes())
    put(Path('artifacts/final-readback.json'), readback_raw)
    put(Path('artifacts/matched-benchmark-report.json'), bench_raw)
    put(Path('artifacts/baseline-owned-json-readback.json'), baseline_readback_raw)
    put(Path('artifacts/baseline-owned-json-benchmark-report.json'), baseline_report_raw)
    for src in sorted(args.baseline_tools.rglob('*')):
        if src.is_file():
            put(Path('artifacts/baseline-paired-tools-attempt1') / src.relative_to(args.baseline_tools),
                src.read_bytes())

    tools = Path('/tmp/dimabot-full-migration-tools')
    required = sorted(p.name for p in tools.glob('spam*.sh'))
    required += ['spam_paired_config.json', 'spam_borrowed_paired_config.json',
                 'matched_paired_coordinator.cjs', 'matched_benchmark_export.py',
                 'run_matched_bench.py', Path(__file__).name]
    for name in required:
        src = Path(__file__).resolve() if name == Path(__file__).name else tools / name
        assert src.is_file(), src
        put(Path('tools') / name, src.read_bytes())
    for name in ['moderation_spam_source.cjs', 'moderation_spam_reference.cjs',
                 'moderation_spam_benchmark.cjs']:
        rel = f'dimabot/tests/fixtures/{name}'
        assert rel in source_hashes
        raw = git('show', f'{commit}:{rel}')
        assert sha(raw) == source_hashes[rel]
        put(Path('frozen-source') / rel, raw)
    # Include the provenance/readers required to reproduce the actual-source
    # pins. They are retained by name and hash, never discovered from a live
    # node_modules tree at packaging time.
    for name in sorted(p.name for p in tools.glob('*moderation_spam*')
                       if p.is_file() and p.suffix in {'.py', '.json', '.cjs'}):
        if name not in required:
            put(Path('tools') / name, (tools / name).read_bytes())

    binding = {
        'codeCommit': commit, 'acceptedRuns': [run for run, _ in receipts],
        'sourceTreeSha256': source_tree, 'sourceInputCount': len(source_hashes),
        'gitInputCount': len(git_inputs), 'gitInputs': git_inputs,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': SDK_BINDING, 'gitCommit': sdk_source[SDK_BINDING]['gitCommit'],
            'inputs': sdk,
        },
    }
    baseline_binding = {
        'codeCommit': baseline_commit, 'acceptedRuns': [run for run, _ in baseline_receipts],
        'sourceTreeSha256': baseline_source_tree, 'sourceInputCount': len(baseline_source_hashes),
        'gitInputCount': len(baseline_git_inputs), 'gitInputs': baseline_git_inputs,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': SDK_BINDING, 'gitCommit': sdk_source[SDK_BINDING]['gitCommit'],
            'inputs': sdk,
        },
    }
    dump(OUT / 'source-bindings.json', {'borrowedView': binding, 'ownedJsonBaseline': baseline_binding})
    accepted = [{
        'run': run, 'phase': receipt.get('phase'), 'success': receipt.get('success'),
        'sourceTreeSha256': receipt.get('source_tree_sha256'),
        'elapsedSeconds': receipt.get('elapsed_seconds'),
        'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
        'peakCacheBytes': receipt.get('peak_cache_bytes'), 'limits': receipt.get('limits'),
        'steps': receipt.get('steps'),
    } for run, receipt in receipts]
    verification = {
        'codeCommit': commit, 'sourceTreeSha256': source_tree, 'acceptedRuns': accepted,
        'retainedRunInterval': {'first': args.first_run, 'last': args.last_run},
        'retainedRunCount': len(included), 'retainedRuns': run_summaries,
        'benchmark': {'path': 'artifacts/matched-benchmark-report.json', 'sha256': sha(bench_raw),
                      'recordCount': 70, 'workloads': sorted(by_workload),
                      'pairsPerWorkload': 7, 'parentReviewed': True,
                      'representation': 'borrowed-read-view',
                      'configSha256': EXPECTED_BORROWED_CONFIG_SHA,
                      'preparedInputSha256': EXPECTED_BENCH_INPUT_SHA,
                      'sourceReportSha256': EXPECTED_BENCH_SOURCE_REPORT_SHA},
        'stressExtensionComparison': {
            'path': 'artifacts/moderation-spam/attempt4/reference-extension-comparison.json',
            'sha256': sha(extension_comparison.read_bytes()),
            'originalPureRecordsUnchanged': 1267, 'asyncRecordsUnchanged': 37,
            'additionalPureRecords': 369,
        },
        'ownedJsonBaseline': {
            'codeCommit': baseline_commit, 'sourceTreeSha256': baseline_source_tree,
            'reportPath': 'artifacts/baseline-owned-json-benchmark-report.json',
            'reportSha256': sha(baseline_report_raw),
            'readbackPath': 'artifacts/baseline-owned-json-readback.json',
            'readbackSha256': sha(baseline_readback_raw),
            'immutableToolSnapshot': 'artifacts/baseline-paired-tools-attempt1',
        },
        'performanceComparison': {
            'workloads': performance_comparison,
            'parentReviewed': True,
            'parentInterpretation': args.performance_review.strip(),
            'scope': 'prepared synthetic helper workload; not production traffic or end-to-end latency',
        },
        'finalReadback': {'path': 'artifacts/final-readback.json', 'sha256': sha(readback_raw),
                          'value': readback},
        'callerAdoption': False, 'typescriptRetirement': False,
        'deployment': False, 'push': False,
        'limitations': [
            'Ordinary JSON adapters do not model executable prototypes/hooks, undefined, or sparse arrays.',
            'The owned semantic-policy vector does not preserve arbitrary mutable JavaScript example identity.',
            'Native driver error wording is not claimed identical to Mongoose/Node diagnostic text.',
            'The source console/connection logging boundary and TypeScript moderation callers remain active.',
            'Synthetic prepared workload timings are not production traffic or end-to-end latency.',
        ],
    }
    dump(OUT / 'verification-summary.json', verification)
    (OUT / 'index.json').write_text(json.dumps(index, indent=2, sort_keys=True) + '\n')
    hashes = {str(path.relative_to(OUT)): sha(path.read_bytes())
              for path in sorted(OUT.rglob('*')) if path.is_file()}
    dump(OUT / 'artifact-sha256.json', hashes)
    (OUT / 'README.md').write_text(
        '# Moderation spam evidence\n\n'
        'This bundle is created only after the parent supplies the frozen source commit, '
        'successful exact-source verification phases, matched benchmark report, and final '
        'production/resource readback. Source bindings hash the complete immutable receipt '
        'against that commit, with the previously verified SDK inputs listed separately. '
        'Every run receipt and log in the requested interval is retained, including failed '
        'attempts. Logs are gzip-only; `index.json` records raw and stored hashes and sizes.\n\n'
        'The functional note and verification summary describe the bounded native helper and '
        'its concrete adapters, source replay, isolated storage checks, measured workload, '
        'and remaining semantic limits. The benchmark is a prepared synthetic helper workload, '
        'not production traffic. TypeScript retirement, caller adoption, deployment and push '
        'remain separate. See [migration note](../../moderation-spam.md).\n'
    )
    print(json.dumps({'output': str(OUT), 'sourceInputs': len(source_hashes),
                      'gitInputs': len(git_inputs), 'sdkInputs': len(sdk),
                      'acceptedRuns': len(receipts), 'retainedRuns': len(included),
                      'benchmarkRecords': sum(len(v) * 2 for v in by_workload.values()),
                      'baselineAcceptedRuns': len(baseline_receipts),
                      'indexedFiles': len(index)}, sort_keys=True))


if __name__ == '__main__':
    main()
