#!/usr/bin/env python3
"""Package accepted moderation-decision evidence using static reads only.

The packager reads pinned Git objects, immutable task artifacts and the reused
SDK binding. It does not invoke Cargo, Node, Docker, tests, services or network
operations. Existing evidence is never overwritten.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-decisions'
UPSTREAM_BINDING = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json'
TOOLS = Path('/tmp/dimabot-full-migration-tools')
CODE_COMMIT = '1575f7edc76b5e51639bc76c16d473ddb459aa3f'
SOURCE_TREE = '631224c9ae10bd9e8df7bbf5f7446dfc6b4c229a1990b4fd7d2d83c066c6bd8d'
ACCEPTED = ['node-1793346195791403743', 'compiler-fixtures-1793346251694408763']
FIRST_RUN = 1793344777438566339
FINAL_RUN = 1793346251694408763


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load(path: Path):
    return json.loads(path.read_text())


def git(*args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=ROOT)


def deterministic_gzip(raw: bytes) -> bytes:
    return gzip.compress(raw, mtime=0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--code-commit', required=True)
    parser.add_argument('--readback', required=True, type=Path)
    parser.add_argument('--state', type=Path, default=STATE)
    args = parser.parse_args()
    state = args.state.resolve(strict=True)
    assert state.parent == Path('/root/.local/state') and state.name.startswith('rust-full-migration-20261028-')
    art = state / 'artifacts'
    feature_art = art / 'moderation-decisions'
    assert feature_art.is_dir()
    commit = git('rev-parse', args.code_commit).decode().strip()
    assert commit == args.code_commit == CODE_COMMIT
    assert args.readback.is_file()

    receipts = {}
    for run in ACCEPTED:
        receipt = load(art / f'{run}-receipt.json')
        assert receipt.get('success') is True and receipt.get('production_unchanged') is True
        receipts[run] = receipt
    source_sets = {json.dumps(r['source_hashes'], sort_keys=True) for r in receipts.values()}
    assert len(source_sets) == 1, 'accepted phases do not bind the same inputs'
    source_hashes = receipts[ACCEPTED[-1]]['source_hashes']
    source_tree = sha(json.dumps(source_hashes, sort_keys=True).encode())
    assert source_tree == SOURCE_TREE == receipts[ACCEPTED[-1]]['source_tree_sha256']

    prior = load(UPSTREAM_BINDING)
    sdk = prior['cache-and-types']['archiveVerifiedSdkInputs']
    assert len(sdk) == 10
    sdk_in_snapshot = {name: digest for name, digest in source_hashes.items()
                       if name.startswith('verification/posthog-rs/')}
    assert sdk_in_snapshot == sdk, 'reused SDK inputs differ from the accepted prior binding'
    git_inputs = {}
    for name, expected in source_hashes.items():
        if name in sdk:
            continue
        actual = sha(git('show', f'{commit}:{name}'))
        assert actual == expected, (name, expected, actual)
        git_inputs[name] = expected
    assert len(source_hashes) == 1442 and len(git_inputs) == 1432 and len(sdk) == 10

    readback_raw = args.readback.read_bytes()
    readback = json.loads(readback_raw)
    assert readback.get('productionUnchanged') is True
    assert readback.get('productionRecords') == 18
    assert all(value in (0, False, None, [], {})
               for value in readback.get('remainingOwnedResources', {}).values())

    if OUT.exists():
        files = {p for p in OUT.rglob('*') if p.is_file()}
        allowed = {OUT / 'reproduction-tools/package_moderation_decisions_evidence.py'}
        assert files <= allowed, f'refusing to overwrite evidence files: {sorted(map(str, files - allowed))[:4]}'
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}

    def put(rel: Path, raw: bytes, force_gzip: bool = False) -> None:
        rel = Path(rel)
        assert not rel.is_absolute() and '..' not in rel.parts
        compressed = force_gzip or len(raw) > 65_536
        stored = deterministic_gzip(raw) if compressed else raw
        stored_rel = Path(str(rel) + '.gz') if compressed else rel
        dest = OUT / stored_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        assert not dest.exists(), f'refusing to overwrite {dest}'
        dest.write_bytes(stored)
        manifest[str(rel)] = {
            'storedPath': str(stored_rel), 'rawSha256': sha(raw), 'rawBytes': len(raw),
            'storedSha256': sha(stored), 'storedBytes': len(stored), 'compressed': compressed,
        }

    retained = []
    for receipt_path in sorted(art.glob('*-receipt.json')):
        stem = receipt_path.name.removesuffix('-receipt.json')
        try:
            number = int(stem.rsplit('-', 1)[1])
        except (IndexError, ValueError):
            continue
        if not FIRST_RUN <= number <= FINAL_RUN:
            continue
        log_path = art / f'{stem}.log'
        assert log_path.is_file(), log_path
        receipt = load(receipt_path)
        assert receipt.get('production_unchanged') is True, stem
        put(Path('runs') / receipt_path.name, receipt_path.read_bytes())
        put(Path('runs') / log_path.name, log_path.read_bytes(), force_gzip=True)
        retained.append({
            'run': stem, 'phase': receipt.get('phase'), 'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'elapsedSeconds': receipt.get('elapsed_seconds'),
            'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
            'peakCacheBytes': receipt.get('peak_cache_bytes'), 'error': receipt.get('error'),
            'steps': receipt.get('steps'),
        })
    retained_names = {item['run'] for item in retained}
    assert set(ACCEPTED) <= retained_names
    assert f'format-{FIRST_RUN}' in retained_names

    for src in sorted(feature_art.rglob('*')):
        if src.is_file():
            put(Path('artifacts/moderation-decisions') / src.relative_to(feature_art), src.read_bytes())
    put(Path('artifacts/parent-final-facts.json'),
        (feature_art / 'final/parent-final-facts.json').read_bytes())
    put(Path('artifacts/final-production-readback.json'), readback_raw)

    # Retain the exact static harness, frozen environment/quality scripts and
    # the shared runtime/regression helpers those scripts source.
    tool_names = sorted(p.name for p in TOOLS.glob('decision_store_*'))
    tool_names += [
        'decision_model_env2.sh', 'decision_model_node1.sh', 'decision_model_node2.sh',
        'decision_model_pure2.sh', 'decision_model_runtime2.sh',
        'decision_model_variation_oracle2.sh', 'decision_model_variation_replay2.sh',
        'mongoose_package_guard.cjs', 'variation_jobs_runtime2.sh', 'validate_variation_jobs.py',
    ]
    for name in sorted(set(tool_names)):
        src = TOOLS / name
        assert src.is_file(), src
        put(Path('reproduction-tools') / name, src.read_bytes())

    bindings = {
        'codeCommit': commit, 'frozenSourceTreeSha256': source_tree,
        'acceptedRuns': ACCEPTED, 'frozenInputCount': len(source_hashes),
        'gitInputCount': len(git_inputs), 'gitInputs': git_inputs,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': 'cache-and-types',
            'gitCommit': prior['cache-and-types']['gitCommit'], 'inputs': sdk,
        },
    }
    bindings_raw = (json.dumps(bindings, indent=2, sort_keys=True) + '\n').encode()
    (OUT / 'source-bindings.json').write_bytes(bindings_raw)

    accepted_summaries = []
    for run in ACCEPTED:
        receipt = receipts[run]
        accepted_summaries.append({
            'run': run, 'phase': receipt.get('phase'), 'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'elapsedSeconds': receipt.get('elapsed_seconds'),
            'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
            'peakCacheBytes': receipt.get('peak_cache_bytes'), 'limits': receipt.get('limits'),
            'steps': receipt.get('steps'),
        })
    verification = {
        'codeCommit': commit, 'frozenSourceTreeSha256': source_tree,
        'acceptedRuns': accepted_summaries, 'retainedRunCount': len(retained),
        'retainedRuns': retained,
        'retainedRunInterval': {'first': FIRST_RUN, 'last': FINAL_RUN},
        'sourceOracle': {
            'hashCases': 6, 'createCases': 19, 'awaitCases': 16,
            'sourceCaseTotal': 41, 'actualMongooseNodeBsonWireProbe': True,
            'normalRustTests': 2, 'ignoredRustTestsPassed': 8,
            'allPrior41CasesAndQueryProbeUnchanged': True,
            'referenceSha256': 'ade6b18d2fb680e2b1a74e30d508d83cde891439fe14b2429d2487f154231b9f',
            'fixtureSha256': 'ade6b18d2fb680e2b1a74e30d508d83cde891439fe14b2429d2487f154231b9f',
        },
        'regressions': {
            'moderationVariationsJobs': 38, 'nativeCases': 4,
            'bootstrapRegressionPassed': True,
            'variationCompilerSourceCases': 175, 'variationCompilerNormalTests': 6,
            'variationProviderNormalTests': 3,
        },
        'finalReadback': {'path': 'artifacts/final-production-readback.json', 'sha256': sha(readback_raw)},
        'productionAndCleanupReadback': {
            'productionRecords': 18, 'productionUnchanged': True,
            'taskOwnedResourcesRemaining': 0,
        },
        'validation': {
            'nodeSourceOraclePassed': True, 'scopedStrictRustPassed': True,
            'minimalStrictRustPassed': True, 'mongoRedisStrictRustPassed': True,
            'allFeaturesStrictClippyPassed': True,
        },
        'deployment': False, 'push': False, 'typescriptRetirement': False,
        'callerAdoption': False, 'performanceBenchmark': False,
        'migrationStatus': 'partial local moderation-decision store and shared compiler mapping; broader application dependencies remain open',
        'limitations': [
            'The source reference hashes identifier strings before insertion. Creation uses the shared flat $setOnInsert compiler and one atomic Mongo upsert; general Mongoose document behavior is outside this mapping.',
            'The shared compiler avoids redundant whole-rule materialization. Cache FIFO access history can differ for trusted inputs above 1,000 entries or concurrent interleavings; keys and per-call identity remain unchanged.',
            'awaitSemanticDecision retains its 80 ms future-work poll, capped to the remaining deadline. This can finish earlier than a source overshoot; no pause is added when ready work exists.',
            'Native BSON default ignoreUndefined=false maps only the compiler-generated own-undefined symbolVersion sentinel to null. Unrelated raw BSON is preserved, and URI-level BSON overrides are not inferred.',
            'The typed JSON/BSON contract does not cover arbitrary JavaScript hooks, prototypes, getters, sparse arrays, proxies, or exact engine/driver diagnostic text.',
            'Semantic-worker success orchestration, billing, moderation consequences, route/handler integration, general Mongoose behavior, and caller adoption remain open.',
            'No new benchmark or performance claim was made; no TypeScript retirement, deployment, or push occurred.',
        ],
    }
    (OUT / 'verification-summary.json').write_text(json.dumps(verification, indent=2, sort_keys=True) + '\n')
    (OUT / 'artifact-sha256.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({
        'output': str(OUT), 'frozenInputs': len(source_hashes),
        'gitInputsVerified': len(git_inputs), 'reusedSdkInputs': len(sdk),
        'retainedRuns': len(retained), 'packagedPayloads': len(manifest),
    }, sort_keys=True))


if __name__ == '__main__':
    main()
