#!/usr/bin/env python3
"""Package parent-verified semantic moderation evidence; performs no validation.

Requires an explicit parent final-facts JSON that attests the last exact-source
run, final checks, and readback. This tool only binds, copies, compresses, and
indexes evidence. It never invokes Node, Cargo, Docker, application code, or a
network client.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
DEFAULT_STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-semantic'
RUN_NAME = re.compile(r'(?:format|node|compiler|compiler-fixtures)-\d+(?:-receipt\.json|\.log)$')
RUN_NUMBER = re.compile(r'-(\d+)(?:-receipt\.json|\.log)$')
REPRO_TOOLS = [
    'semantic_node_env1.sh', 'semantic_node1.sh', 'semantic_node2.sh',
    'semantic_node3.sh', 'semantic_node4.sh', 'semantic_quality1.sh',
    'semantic_quality2.sh', 'semantic_quality3.sh', 'freeze_semantic_stable.py',
    'freeze_advanced_oracle.py', 'freeze_rule_dispatcher.py', 'validate.py',
    'apply_format.py', 'final_readback.py',
]
FROZEN_SOURCE = [
    'dimabot/src/utils/moderation/semantic.ts',
    'dimabot/src/utils/ai/openrouter/app_attribution.util.ts',
    'dimabot/src/utils/moderation/semantic.rs',
    'dimabot/tests/fixtures/moderation_semantic_source.cjs',
    'dimabot/tests/fixtures/moderation_semantic_reference.cjs',
    'dimabot/tests/moderation_semantic.rs',
    'dimabot/tests/moderation_semantic_provider.rs',
    'dimabot/tests/moderation_semantic_source.rs',
    'dimabot/tests/support/moderation_semantic.rs',
    'dimabot/tests/support/sha256.rs',
    'dimabot/Cargo.toml', 'dimabot/Cargo.lock',
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text())


def git(*args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=ROOT)


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--code-commit', required=True, help='final committed source revision')
    ap.add_argument('--final-facts', required=True, type=Path,
                    help='parent-produced JSON with finalVerification=passed and exact source/run facts')
    ap.add_argument('--state', type=Path, default=DEFAULT_STATE)
    ap.add_argument('--first-run', required=True, type=int)
    ap.add_argument('--last-run', required=True, type=int)
    args = ap.parse_args()

    state = args.state.resolve(strict=True)
    assert state.parent == Path('/root/.local/state') and state.name.startswith('rust-full-migration-')
    if OUT.exists():
        old_index_path = OUT / 'index.json'
        assert old_index_path.is_file(), f'refusing to overwrite unindexed evidence directory: {OUT}'
        old_index = read_json(old_index_path)
        for rel, meta in old_index['files'].items():
            raw = (OUT / rel).read_bytes()
            assert len(raw) == meta['bytes'] and sha(raw) == meta['sha256'], f'previous bundle changed: {rel}'
    assert args.first_run <= args.last_run
    facts = read_json(args.final_facts.resolve(strict=True))
    assert facts.get('finalVerification') == 'passed', 'parent final verification is not attested as passed'
    assert facts.get('firstRun') == args.first_run and facts.get('lastRun') == args.last_run
    assert facts.get('codeCommit') == args.code_commit
    commit = git('rev-parse', args.code_commit).decode().strip()
    assert commit == args.code_commit

    art = state / 'artifacts'
    semantic_art = art / 'moderation-semantic'
    assert semantic_art.is_dir()
    accepted = facts.get('acceptedRuns')
    assert isinstance(accepted, list) and accepted
    receipts = {}
    for run in accepted:
        assert re.fullmatch(r'(?:format|node|compiler|compiler-fixtures)-\d+', run), run
        path = art / f'{run}-receipt.json'
        receipt = read_json(path)
        assert receipt.get('success') is True, f'accepted run failed: {run}'
        assert receipt.get('production_unchanged') is True, f'production readback failed: {run}'
        receipts[run] = receipt
    source_sets = {json.dumps(r.get('source_hashes'), sort_keys=True) for r in receipts.values()}
    assert len(source_sets) == 1, 'accepted runs do not share one frozen source binding'
    source_hashes = next(iter(receipts.values())).get('source_hashes')
    assert isinstance(source_hashes, dict) and source_hashes
    source_tree = sha(json.dumps(source_hashes, sort_keys=True).encode())
    assert all(r.get('source_tree_sha256') == source_tree for r in receipts.values())
    assert facts.get('sourceTreeSha256') == source_tree
    assert facts.get('sourceInputs') == len(source_hashes)

    sdk = facts.get('reusedSdkBindings', {})
    assert isinstance(sdk, dict)
    git_inputs, sdk_inputs = {}, {}
    for path, expected in source_hashes.items():
        if path in sdk:
            assert sdk[path] == expected, f'reused SDK mismatch: {path}'
            sdk_inputs[path] = expected
        else:
            actual = sha(git('show', f'{commit}:{path}'))
            assert actual == expected, f'source/commit binding mismatch: {path}'
            git_inputs[path] = expected

    counts = facts.get('actualSourceCounts')
    assert isinstance(counts, dict) and counts.get('pure') == 1071 and counts.get('evaluate') == 65
    assert counts.get('explicitPureBoundaries') == 3 and counts.get('evaluatorSeamAdaptations') == 10
    assert facts.get('verificationReadback') and facts['verificationReadback'].get('productionUnchanged') is True
    assert facts['verificationReadback'].get('remainingOwnedResources') in ({}, [], 0, None) or all(
        value in (0, False, None, [], {})
        for value in facts['verificationReadback']['remainingOwnedResources'].values()
    ), 'task-owned resources remain'
    reference = Path(facts['referenceArtifact']).resolve(strict=True)
    reference_sha = facts.get('referenceSha256')
    assert reference.is_file() and sha(reference.read_bytes()) == reference_sha
    assert facts.get('benchmark') == {'status': 'not-required'}
    assert facts['verificationTiming'].get('exit_code') == 0
    assert facts.get('runtimeSeconds', 0) > 0 and facts.get('minimumAvailableBytes', 0) >= 4 * 1024**3
    assert facts.get('peakCacheBytes', 0) <= 8 * 1024**3
    accounting_path = semantic_art / 'final/test-accounting.json'
    readback_path = semantic_art / 'final/production-readback.json'
    source_comparison_path = semantic_art / 'attempt4/source-comparison.json'
    assert accounting_path.is_file() and read_json(accounting_path) == facts['testAccounting']
    assert readback_path.is_file() and read_json(readback_path) == facts['verificationReadback']
    assert source_comparison_path.is_file()
    comparison = read_json(source_comparison_path)
    assert comparison.get('sourcePureRecordsUnchanged') == 1071
    assert comparison.get('sourceEvaluateRecordsUnchanged') == 65
    assert comparison.get('currentFixtureSha256') == reference_sha
    for name in REPRO_TOOLS:
        assert (Path(__file__).resolve().parent / name).is_file(), name
    run_files = []
    for path in sorted(art.iterdir()):
        match = RUN_NUMBER.search(path.name)
        if not RUN_NAME.fullmatch(path.name) or match is None:
            continue
        number = int(match.group(1))
        if args.first_run <= number <= args.last_run and path.name.endswith('-receipt.json'):
            receipt = read_json(path)
            assert receipt.get('production_unchanged') is True, f'missing production inspection: {path.name}'
            run = path.name.removesuffix('-receipt.json')
            log = art / f'{run}.log'
            assert log.is_file(), log
            run_files.append((run, path, log, receipt))
    assert set(accepted) <= {run for run, *_ in run_files}, 'accepted runs outside retained interval'

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'artifacts').mkdir(exist_ok=True)
    refs_dir = OUT / 'artifacts/references'
    refs_dir.mkdir(exist_ok=True)
    reference_hashes = {}
    for attempt in range(1, 5):
        src = semantic_art / f'attempt{attempt}/reference/moderation-semantic-reference.json'
        assert src.is_file(), src
        raw = src.read_bytes()
        dest = refs_dir / f'attempt{attempt}-moderation-semantic-reference.json.gz'
        with dest.open('wb') as raw_stream:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw_stream,
                               compresslevel=9, mtime=0) as stream:
                stream.write(raw)
        reference_hashes[dest.name] = {
            'rawSha256': sha(raw), 'rawBytes': len(raw),
            'gzipSha256': sha(dest.read_bytes()), 'gzipBytes': dest.stat().st_size,
        }
        old_raw = refs_dir / f'attempt{attempt}-moderation-semantic-reference.json'
        if old_raw.exists():
            old_raw.unlink()
    shutil.copy2(source_comparison_path, OUT / 'artifacts/source-comparison.json')
    shutil.copy2(accounting_path, OUT / 'artifacts/test-accounting.json')
    shutil.copy2(readback_path, OUT / 'artifacts/production-readback.json')
    dump(OUT / 'artifacts/reference-hashes.json', reference_hashes)
    dump(OUT / 'parent-final-facts.json', facts)
    dump(OUT / 'source-bindings.json', {
        'codeCommit': commit,
        'sourceTreeSha256': source_tree,
        'gitInputs': git_inputs,
        'reusedSdkInputs': sdk_inputs,
        'inputCount': len(source_hashes),
    })

    tools_dir = OUT / 'reproduction-tools'
    tools_dir.mkdir(exist_ok=True)
    for name in REPRO_TOOLS:
        source = Path(__file__).resolve().parent / name
        assert source.is_file(), source
        shutil.copy2(source, tools_dir / name)
    frozen_dir = tools_dir / 'frozen-source'
    for name in FROZEN_SOURCE:
        expected = source_hashes.get(name)
        assert expected is not None, f'frozen source is outside final snapshot: {name}'
        data = git('show', f'{commit}:{name}')
        assert sha(data) == expected, f'frozen source hash mismatch: {name}'
        path = frozen_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    sdk_dir = tools_dir / 'reused-sdk-inputs'
    for name, expected in sdk_inputs.items():
        src = state / 'source' / name
        data = src.read_bytes()
        assert sha(data) == expected, f'reused SDK file hash mismatch: {name}'
        path = sdk_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    shutil.copy2(Path(__file__), tools_dir / 'package_moderation_semantic_evidence.py')
    legacy_reference = OUT / 'artifacts/reference/moderation-semantic-reference.json'
    if legacy_reference.exists():
        legacy_reference.unlink()
        legacy_reference.parent.rmdir()

    run_summaries = []
    for run, receipt_path, log, receipt in run_files:
        pair = {'run': run, 'phase': receipt.get('phase'), 'success': receipt.get('success'),
                'sourceTreeSha256': receipt.get('source_tree_sha256')}
        dest = OUT / 'artifacts/runs' / receipt_path.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(receipt_path, dest)
        log_raw = log.read_bytes()
        gz = OUT / 'artifacts/runs' / f'{run}.log.gz'
        with gz.open('wb') as raw_stream:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw_stream,
                               compresslevel=9, mtime=0) as stream:
                stream.write(log_raw)
        pair['logSha256'] = sha(log_raw)
        pair['logGzipSha256'] = sha(gz.read_bytes())
        pair['logBytes'] = len(log_raw)
        pair['logGzipBytes'] = gz.stat().st_size
        run_summaries.append(pair)

    assert {r for r in accepted} <= {x['run'] for x in run_summaries}, 'accepted runs are outside retained interval'
    dump(OUT / 'verification-summary.json', {
        'finalFacts': facts,
        'acceptedRuns': accepted,
        'retainedRuns': run_summaries,
        'referenceArtifacts': reference_hashes,
        'benchmark': 'not required; no semantic performance claim',
    })
    readback = facts['verificationReadback']
    lines = [
        '# Moderation semantic verification evidence', '',
        f"Final code commit: `{commit}`. Frozen source tree SHA-256: `{source_tree}` "
        f"({len(git_inputs)} Git inputs and {len(sdk_inputs)} reused SDK inputs).",
        f"The final replay visited all {counts['pure']} pure and {counts['evaluate']} evaluator records; "
        f"fixture-4 SHA-256 is `{reference_sha}`. It reports {counts['explicitPureBoundaries']} explicit "
        f"pure boundary records and {counts['evaluatorSeamAdaptations']} evaluator seam adaptations; "
        'these are not unrestricted JavaScript parity.', '',
        'All four oracle JSON artifacts are retained as gzip files with raw and stored hashes in '
        '`artifacts/reference-hashes.json`.', '',
        '## Verification', '',
        f"Accepted final-source runs: `{', '.join(accepted)}`. The compiler phase took "
        f"{facts['verificationTiming']['seconds']} s ({facts['runtimeSeconds']} s total), minimum available "
        f"memory was {facts['minimumAvailableBytes']} bytes and peak cache was {facts['peakCacheBytes']} bytes.",
        'All scoped, minimal, Mongo/Redis and all-feature strict checks passed. The run also passed seven '
        'semantic ordinary tests, eight spam unit tests, and 1,636 spam source regression records.',
        'Accepted exact-source and strict-check runs are listed in `verification-summary.json`; '
        'all earlier attempts in the retained numeric interval remain indexed, including failures.',
        'The feature uses ordinary JSON/native adapters with the declared spam category enum. '
        'Source-only JavaScript shapes and other adapters remain identified in the migration note.',
        'No benchmark was required or run for this bounded helper. No performance claim is made.', '',
        f"Production readback: unchanged={readback.get('productionUnchanged')} across "
        f"{readback.get('productionRecords')} records; "
        f"task-owned resources remaining={readback.get('remainingOwnedResources', {})}.",
        'Caller adoption, TypeScript retirement, deployment, and push are separate and are not '
        'authorized or implied by this evidence.', '',
        'See [the migration note](../../moderation-semantic.md), '
        '[native handoff](../../moderation-semantic-native-handoff.md), and '
        '[oracle handoff](../../moderation-semantic-oracle-handoff.md).', '',
    ]
    (OUT / 'README.md').write_text('\n'.join(lines))

    indexed = {}
    for path in sorted(OUT.rglob('*')):
        if path.is_file() and path.name != 'index.json':
            rel = path.relative_to(OUT).as_posix()
            raw = path.read_bytes()
            indexed[rel] = {'sha256': sha(raw), 'bytes': len(raw)}
    dump(OUT / 'index.json', {'format': 1, 'files': indexed})
    print(json.dumps({'output': str(OUT), 'indexedFiles': len(indexed),
                      'sourceInputs': len(source_hashes), 'retainedRuns': len(run_summaries),
                      'sourceTreeSha256': source_tree}, sort_keys=True))


if __name__ == '__main__':
    main()
