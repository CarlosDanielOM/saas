#!/usr/bin/env python3
"""Package frozen moderation decision model verification evidence.

This is a static evidence packager. It only reads Git objects, receipts, logs,
reference outputs, and source-binding records; it never runs application tests,
Node, Cargo, Docker, or network operations.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-decision-model'
UPSTREAM_BINDING = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json'
SDK_BINDING = 'cache-and-types'
SOURCE_TREE = '2db513b98a4e957935c10400f673e112ba6eecc899483c219524e1729d3af3f8'
CODE_COMMIT = '585850cdd71d01783d548186f6ec4e505b16528f'
FIRST_RUN = 1793343330313115612
FINAL_RUN = 1793344259615786190
ACCEPTED = [
    'node-1793343524741382017',
    'compiler-1793343524718387524',
    'compiler-1793343659277337179',
    'node-1793344051154522341',
    'compiler-fixtures-1793344052447834554',
    'compiler-1793344259615786190',
]
TOOLS = Path('/tmp/dimabot-full-migration-tools')


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
    feature_art = art / 'moderation-decision-model'
    assert feature_art.is_dir()
    if OUT.exists():
        existing = {path for path in OUT.rglob('*') if path.is_file()}
        assert existing <= {Path(__file__).resolve()}, f'refusing to overwrite existing evidence: {OUT}'
    assert args.readback.is_file()
    commit = git('rev-parse', args.code_commit).decode().strip()
    assert commit == args.code_commit == CODE_COMMIT, (commit, args.code_commit)

    receipts = {}
    accepted = []
    for run in ACCEPTED:
        path = art / f'{run}-receipt.json'
        assert path.is_file(), path
        receipt = load(path)
        assert receipt.get('success') is True, run
        assert receipt.get('production_unchanged') is True, run
        accepted.append((run, receipt))
        receipts[run] = receipt

    source_sets = {json.dumps(item['source_hashes'], sort_keys=True) for _, item in accepted}
    assert len(source_sets) == 1, 'accepted phases do not bind to one frozen source set'
    final_receipt = accepted[-1][1]
    source_hashes = final_receipt['source_hashes']
    source_tree = sha(json.dumps(source_hashes, sort_keys=True).encode())
    assert source_tree == final_receipt.get('source_tree_sha256') == SOURCE_TREE
    assert len(source_hashes) == 1437

    prior = load(UPSTREAM_BINDING)
    sdk = prior[SDK_BINDING]['archiveVerifiedSdkInputs']
    assert len(sdk) == 10
    sdk_in_snapshot = {name: digest for name, digest in source_hashes.items()
                       if name.startswith('verification/posthog-rs/')}
    assert sdk_in_snapshot == sdk, 'the ten reused SDK inputs differ from the accepted prior binding'
    git_inputs = {}
    for name, expected in source_hashes.items():
        if name in sdk:
            continue
        actual = sha(git('show', f'{commit}:{name}'))
        assert actual == expected, (name, expected, actual)
        git_inputs[name] = expected
    assert len(git_inputs) == 1427 and len(sdk) == 10

    readback_raw = args.readback.read_bytes()
    readback = json.loads(readback_raw)
    assert readback.get('productionUnchanged') is True
    assert readback.get('productionRecords') == 18
    assert all(value in (0, False, None, [], {})
               for value in readback.get('remainingOwnedResources', {}).values())

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
        if dest.exists():
            assert dest.resolve() == Path(__file__).resolve() and dest.read_bytes() == raw, dest
            manifest[str(rel)] = {
                'storedPath': str(stored_rel), 'rawSha256': sha(raw), 'rawBytes': len(raw),
                'storedSha256': sha(dest.read_bytes()), 'storedBytes': dest.stat().st_size,
                'compressed': compressed,
            }
            return
        dest.write_bytes(stored)
        manifest[str(rel)] = {
            'storedPath': str(stored_rel),
            'rawSha256': sha(raw),
            'rawBytes': len(raw),
            'storedSha256': sha(stored),
            'storedBytes': len(stored),
            'compressed': compressed,
        }

    # Keep every run receipt and log in the complete interval, including failures.
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
        for src in (receipt_path, log_path):
            put(Path('runs') / src.name, src.read_bytes(), force_gzip=src.suffix == '.log')
        retained.append({
            'run': stem,
            'phase': receipt.get('phase'),
            'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'elapsedSeconds': receipt.get('elapsed_seconds'),
            'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
            'peakCacheBytes': receipt.get('peak_cache_bytes'),
            'error': receipt.get('error'),
            'steps': receipt.get('steps'),
        })
    retained_names = {entry['run'] for entry in retained}
    assert set(ACCEPTED) <= retained_names
    assert f'format-{FIRST_RUN}' in retained_names and f'compiler-{FINAL_RUN}' in retained_names

    # Reference outputs from both authoring attempts and the final production readback.
    for src in sorted(feature_art.rglob('*')):
        if src.is_file():
            put(Path('artifacts/moderation-decision-model') / src.relative_to(feature_art), src.read_bytes())
    put(Path('artifacts/final-readback.json'), readback_raw)

    bindings = {
        'codeCommit': commit,
        'frozenSourceTreeSha256': source_tree,
        'acceptedRuns': [name for name, _ in accepted],
        'frozenInputCount': len(source_hashes),
        'gitInputCount': len(git_inputs),
        'gitInputs': git_inputs,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': SDK_BINDING,
            'gitCommit': prior[SDK_BINDING]['gitCommit'],
            'inputs': sdk,
        },
    }
    bindings_raw = (json.dumps(bindings, indent=2, sort_keys=True) + '\n').encode()
    (OUT / 'source-bindings.json').write_bytes(bindings_raw)

    phase_summaries = []
    for name, receipt in accepted:
        phase_summaries.append({
            'run': name,
            'phase': receipt.get('phase'),
            'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'elapsedSeconds': receipt.get('elapsed_seconds'),
            'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
            'peakCacheBytes': receipt.get('peak_cache_bytes'),
            'limits': receipt.get('limits'),
            'steps': receipt.get('steps'),
        })
    schema_ref = feature_art / 'attempt2/schema/moderation-decision-schema-reference.json'
    upsert_ref = feature_art / 'attempt2/insert/mongoose-set-on-insert-reference.json'
    variation_ref = feature_art / 'attempt2/variation-schema/moderation-variation-schema-reference.json'
    verification = {
        'codeCommit': commit,
        'frozenSourceTreeSha256': source_tree,
        'acceptedRuns': phase_summaries,
        'retainedRunCount': len(retained),
        'retainedRuns': retained,
        'retainedRunInterval': {'first': FIRST_RUN, 'last': FINAL_RUN},
        'sourceOracle': {
            'node': '24.22.1', 'typescript': '5.9.3', 'mongoose': '8.24.2', 'bson': '6.10.4',
            'decisionSchemaCases': 18, 'decisionSchemaSha256': sha(schema_ref.read_bytes()),
            'decisionSchemaPath': 'artifacts/moderation-decision-model/attempt2/schema/moderation-decision-schema-reference.json',
            'flatSetOnInsertCases': 11, 'flatSetOnInsertSha256': sha(upsert_ref.read_bytes()),
            'flatSetOnInsertPath': 'artifacts/moderation-decision-model/attempt2/insert/mongoose-set-on-insert-reference.json',
            'variationSchemaRegressionCases': 42, 'variationSchemaRegressionSha256': sha(variation_ref.read_bytes()),
            'variationSchemaRegressionPath': 'artifacts/moderation-decision-model/attempt2/variation-schema/moderation-variation-schema-reference.json',
        },
        'finalReadback': {'path': 'artifacts/final-readback.json', 'sha256': sha(readback_raw)},
        'productionAndCleanupReadback': readback,
        'deployment': False, 'push': False, 'typescriptRetirement': False,
        'callerAdoption': False, 'performanceBenchmark': False,
        'migrationStatus': 'partial local decision-model schema mapping; broader application dependency remains open',
        'limitations': [
            'The native schema descriptor/repository is not a general Mongoose document engine; hooks, validators, middleware, object identity, and implicit ID/version/timestamp behavior are not claimed.',
            'The flat insert helper accepts only flat equality filters and flat $setOnInsert documents; it excludes operators, dotted paths, nested schema types, top-level BSON Undefined, and implicit machinery.',
            'compiler_bson_json is a lossy compiler projection for JSON-like fields; raw BSON remains authoritative for Mixed and non-JSON values.',
            'The producer, handler/route, semantic worker, surrounding persistence adapter, and TypeScript caller adoption remain open.',
            'No benchmark or production latency claim was made.',
        ],
    }
    verification_raw = (json.dumps(verification, indent=2, sort_keys=True) + '\n').encode()
    (OUT / 'verification-summary.json').write_bytes(verification_raw)

    # Exact source-freeze, validator, regression and format/readback chain.
    required_tmp = [
        'freeze_model_stable.py', 'freeze_advanced_oracle.py', 'freeze_rule_dispatcher.py',
        'validate.py', 'apply_format.py', 'final_readback.py', 'validate_variation_jobs.py',
        'mongoose_package_guard.cjs',
    ]
    for name in required_tmp:
        src = TOOLS / name
        assert src.is_file(), src
        put(Path('reproduction-tools') / name, src.read_bytes())
    for src in sorted(TOOLS.glob('decision_model_*.sh')):
        put(Path('reproduction-tools') / src.name, src.read_bytes())
    for name in ['variation_jobs_runtime2.sh', 'prepare_variation_jobs_provenance.py']:
        src = ROOT / 'migration-notes/evidence/2026-10-30-variation-jobs/tools' / name
        assert src.is_file(), src
        put(Path('reproduction-tools') / name, src.read_bytes())
    for name in ['freeze_variations_stable.py', 'freeze_variations_candidate.py', 'freeze_variations.py']:
        src = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/tools' / name
        assert src.is_file(), src
        put(Path('reproduction-tools/upstream-variation-freeze') / name, src.read_bytes())
    put(Path('reproduction-tools') / Path(__file__).name, Path(__file__).read_bytes())

    (OUT / 'source-bindings.json').write_bytes(bindings_raw)
    (OUT / 'verification-summary.json').write_bytes(verification_raw)
    readme = '''# Moderation decision model evidence\n\nThis package binds the bounded model/schema and shared flat insert-preparation evidence to code commit `585850cdd71d01783d548186f6ec4e505b16528f` and frozen source tree `2db513b98a4e957935c10400f673e112ba6eecc899483c219524e1729d3af3f8`. The source binding checks 1,427 Git inputs against the commit and records ten reused verified SDK inputs from the `cache-and-types` binding in [moderation variations evidence](../../2026-10-30-moderation-variations/source-bindings.json).\n\nThe package retains all receipts and logs from the first format run through the final compiler phase, including failed intermediate attempts. That initial format receipt is retained as pre-freeze history; accepted feature phases bind to the frozen `2db513...` source. The accepted source replay covers 18 decision-model constructor cases and 11 flat `$setOnInsert` cases under pinned Node/TypeScript/Mongoose/BSON. A fresh 42-case variation-schema regression confirmed its expected output did not change. The exact phase receipts, source hashes, reference hashes, runtime bounds, and production/resource readback are in `verification-summary.json`. Log payloads are gzip-compressed; `artifact-sha256.json` records both raw and stored hashes and sizes.\n\nThe native model/schema mapping is partial. General Mongoose document behavior and the broader moderation decision producer, worker, handler/route, persistence adapter, and caller adoption remain open. The shared BSON/JSON helper is a lossy compiler projection only; raw BSON stays authoritative for Mixed and non-JSON values. No benchmark, deployment, TypeScript retirement, push, or total-migration claim is made.\n\nThe exact source-freeze chain, task scripts, variation-job regression runner, SDK package guard, and packager are under `reproduction-tools/`. This bundle preserves references and verification evidence without copying the current uncommitted decision creation/store draft files.\n'''
    (OUT / 'README.md').write_text(readme)

    payloads = {}
    for path in sorted(OUT.rglob('*')):
        if not path.is_file() or path.name in {'artifact-sha256.json', 'compressed-artifacts.json'}:
            continue
        payloads[str(path.relative_to(OUT))] = {
            'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size,
        }
    (OUT / 'artifact-sha256.json').write_text(json.dumps(payloads, indent=2, sort_keys=True) + '\n')
    compressed = {name: info for name, info in manifest.items() if info['compressed']}
    (OUT / 'compressed-artifacts.json').write_text(json.dumps(compressed, indent=2, sort_keys=True) + '\n')
    print(json.dumps({
        'output': str(OUT), 'gitInputs': len(git_inputs), 'sdkInputs': len(sdk),
        'retainedRuns': len(retained), 'payloads': len(payloads),
        'sourceTreeSha256': source_tree,
    }, sort_keys=True))


if __name__ == '__main__':
    main()
