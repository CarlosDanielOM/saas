#!/usr/bin/env python3
"""Build the final moderation variation-jobs evidence bundle from immutable receipts.

Run only after the parent supplies the final code commit, accepted phase IDs, final
phase bound, and production/resource readback. This tool copies and hashes evidence;
it does not run Cargo, Node, Docker, tests, or alter source snapshots.
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
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
ART = STATE / 'artifacts'
JOBS_ART = ART / 'moderation-variation-jobs'
OUT = ROOT / 'migration-notes/evidence/2026-10-30-variation-jobs'
FIRST_RUN = 1793337209781427763
FINAL_SOURCE_TREE = 'f4d756d6b406385cc6e32f89f9971c9ce12cc03e907f2d8dee7fdcdfa43dca16'
FINAL_NODE_RUN = 'node-1793337869257910513'
FINAL_FIXTURE_RUN = 'compiler-fixtures-1793337683444735110'
SDK_SOURCE = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json'
SDK_BINDING = 'cache-and-types'


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def git(*args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=ROOT)


def load(path: Path):
    return json.loads(path.read_text())


def deterministic_gzip(raw: bytes) -> bytes:
    return gzip.compress(raw, mtime=0)


def number_from_run(name: str) -> int | None:
    match = re.search(r'-(\d+)(?:-receipt\.json|\.log)?$', name)
    return int(match.group(1)) if match else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--code-commit', required=True, help='final verified source commit')
    parser.add_argument('--accepted-run', action='append', required=True,
                        help='successful final source/oracle/runtime/quality phase; repeat')
    parser.add_argument('--last-run', required=True, type=int,
                        help='numeric bound of the final verification phase interval')
    parser.add_argument('--readback', required=True, type=Path,
                        help='final production identity and task-resource readback JSON')
    parser.add_argument('--state', type=Path, default=STATE,
                        help='task-owned full-migration validation state directory')
    args = parser.parse_args()

    state = args.state.resolve(strict=True)
    assert state.parent == Path('/root/.local/state') and state.name.startswith('rust-full-migration-20261028-')
    art = state / 'artifacts'
    jobs_art = art / 'moderation-variation-jobs'
    assert jobs_art.is_dir()
    assert not OUT.exists(), f'refusing to overwrite existing evidence: {OUT}'
    assert args.readback.is_file(), args.readback
    commit = git('rev-parse', args.code_commit).decode().strip()
    assert commit == args.code_commit, (commit, args.code_commit)
    last_run = args.last_run
    assert last_run >= FIRST_RUN

    receipts = {}
    accepted_receipts = []
    for run in args.accepted_run:
        receipt_path = art / f'{run}-receipt.json'
        assert receipt_path.is_file(), receipt_path
        receipt = load(receipt_path)
        assert receipt.get('success') is True, run
        assert receipt.get('production_unchanged') is True, run
        accepted_receipts.append((run, receipt))
        receipts[run] = receipt
    source_hash_sets = {json.dumps(r['source_hashes'], sort_keys=True) for _, r in accepted_receipts}
    assert len(source_hash_sets) == 1, 'accepted phases do not bind to one source snapshot'
    final_receipt = accepted_receipts[-1][1]
    source_hashes = final_receipt['source_hashes']
    source_tree_sha = sha(json.dumps(source_hashes, sort_keys=True).encode())
    assert source_tree_sha == final_receipt['source_tree_sha256'] == FINAL_SOURCE_TREE
    assert len(source_hashes) == 1412

    old_bindings = load(SDK_SOURCE)
    sdk = old_bindings[SDK_BINDING]['archiveVerifiedSdkInputs']
    assert len(sdk) == 10
    sdk_in_snapshot = {p: h for p, h in source_hashes.items() if p.startswith('verification/posthog-rs/')}
    assert sdk_in_snapshot == sdk
    git_inputs = {}
    for path, expected in source_hashes.items():
        if path in sdk:
            continue
        actual = sha(git('show', f'{commit}:{path}'))
        assert actual == expected, (path, expected, actual)
        git_inputs[path] = expected
    assert len(git_inputs) == 1402 and len(sdk) == 10
    assert len(git_inputs) + len(sdk) == len(source_hashes)
    assert FINAL_NODE_RUN in args.accepted_run and FINAL_FIXTURE_RUN in args.accepted_run

    readback_raw = args.readback.read_bytes()
    readback = json.loads(readback_raw)
    assert readback_raw and isinstance(readback, dict)
    assert readback.get('productionUnchanged') is True
    assert readback.get('productionRecords') == 18
    assert all(value in (0, False, None, [], {}) for value in readback.get('remainingOwnedResources', {}).values())

    run_paths = []
    retained_run_summaries = []
    for receipt_path in sorted(art.glob('*-receipt.json')):
        run_num = number_from_run(receipt_path.name)
        if run_num is None or not FIRST_RUN <= run_num <= last_run:
            continue
        run = receipt_path.name.removesuffix('-receipt.json')
        log_path = art / f'{run}.log'
        assert log_path.is_file(), log_path
        run_receipt = load(receipt_path)
        assert run_receipt.get('production_unchanged') is True, run
        retained_run_summaries.append({
            'run': run,
            'phase': run_receipt.get('phase'),
            'success': run_receipt.get('success'),
            'sourceTreeSha256': run_receipt.get('source_tree_sha256'),
            'error': run_receipt.get('error'),
            'steps': run_receipt.get('steps'),
        })
        run_paths.extend([(receipt_path, Path('runs') / receipt_path.name),
                          (log_path, Path('runs') / log_path.name)])
    included_runs = {source.name.removesuffix('-receipt.json') for source, _ in run_paths if source.name.endswith('-receipt.json')}
    assert all(run in included_runs for run in args.accepted_run), args.accepted_run
    assert any(number_from_run(run) == FIRST_RUN for run in included_runs), 'initial format phase is missing'
    assert any(number_from_run(run) == last_run for run in included_runs), 'last phase is missing'

    OUT.mkdir(parents=True)
    manifest = {}

    def put_bytes(rel: Path, raw: bytes, force_gzip: bool = False) -> None:
        rel = Path(rel)
        assert not rel.is_absolute() and '..' not in rel.parts
        compressed = force_gzip or len(raw) > 65_536
        stored = deterministic_gzip(raw) if compressed else raw
        stored_rel = Path(str(rel) + '.gz') if compressed else rel
        dest = OUT / stored_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        assert not dest.exists(), dest
        dest.write_bytes(stored)
        manifest[str(rel)] = {
            'storedPath': str(stored_rel),
            'rawSha256': sha(raw),
            'rawBytes': len(raw),
            'storedSha256': sha(stored),
            'storedBytes': len(stored),
            'compressed': compressed,
        }

    # Preserve every full receipt and stdout/stderr log in the requested interval.
    for source, rel in run_paths:
        put_bytes(rel, source.read_bytes(), force_gzip=source.suffix == '.log')

    # Preserve the source oracle, reference bytes, and every copied SDK/source pin.
    for source in sorted(jobs_art.rglob('*')):
        if source.is_file():
            put_bytes(Path('artifacts/moderation-variation-jobs') / source.relative_to(jobs_art),
                      source.read_bytes())
    put_bytes(Path('artifacts/final-readback.json'), readback_raw)

    # Exact task-owned reproduction and snapshot tools, plus the packager itself.
    task_tools = Path('/tmp/dimabot-full-migration-tools')
    required_tools = ['validate_variation_jobs.py', 'prepare_variation_jobs_provenance.py']
    required_tools.extend(sorted(p.name for p in task_tools.glob('variation_jobs_*.sh')))
    required_tools.append(Path(__file__).name)
    for name in required_tools:
        source = Path(__file__).resolve() if name == Path(__file__).name else task_tools / name
        assert source.is_file(), source
        put_bytes(Path('tools') / name, source.read_bytes())
    # Preserve the exact source-freeze/readback helpers used by the accepted
    # upstream variation evidence when present; that evidence also remains linked.
    upstream_tools = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/tools'
    for name in ['apply_format.py', 'final_readback.py', 'freeze_variations.py',
                 'freeze_variations_candidate.py', 'freeze_variations_stable.py',
                 'prepare_posthog_sdk.py']:
        source = upstream_tools / name
        if source.is_file():
            put_bytes(Path('tools/upstream-variation-freeze') / name, source.read_bytes())

    bindings = {
        'codeCommit': commit,
        'acceptedRuns': [run for run, _ in accepted_receipts],
        'sourceTreeSha256': source_tree_sha,
        'sourceInputCount': len(source_hashes),
        'gitInputCount': len(git_inputs),
        'gitInputs': git_inputs,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': SDK_BINDING,
            'gitCommit': old_bindings[SDK_BINDING]['gitCommit'],
            'inputs': sdk,
        },
    }
    (OUT / 'source-bindings.json').write_text(json.dumps(bindings, indent=2, sort_keys=True) + '\n')

    phase_summaries = []
    for run, receipt in accepted_receipts:
        phase_summaries.append({
            'run': run,
            'phase': receipt.get('phase'),
            'success': receipt.get('success'),
            'sourceTreeSha256': receipt.get('source_tree_sha256'),
            'elapsedSeconds': receipt.get('elapsed_seconds'),
            'minimumAvailableBytes': receipt.get('minimum_available_bytes'),
            'peakCacheBytes': receipt.get('peak_cache_bytes'),
            'limits': receipt.get('limits'),
            'steps': receipt.get('steps'),
        })
    verification = {
        'codeCommit': commit,
        'sourceTreeSha256': source_tree_sha,
        'acceptedRuns': phase_summaries,
        'retainedRunCount': len(included_runs),
        'retainedRuns': retained_run_summaries,
        'retainedRunInterval': {'first': FIRST_RUN, 'last': last_run},
        'sourceOracle': {
            'caseCount': 38,
            'referenceSha256': '4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b',
            'referencePath': 'artifacts/moderation-variation-jobs/attempt1/reference/moderation-variation-jobs-reference.json',
        },
        'finalReadback': {'path': 'artifacts/final-readback.json', 'sha256': sha(readback_raw)},
        'productionAndCleanupReadback': readback,
        'deployment': False,
        'push': False,
        'typescriptRetirement': False,
        'callerAdoption': False,
        'performanceBenchmark': False,
        'migrationStatus': 'partial local feature evidence; total migration remains incomplete',
        'limitations': [
            'The source own-property value symbolVersion: undefined is compared at the documented JSON serialization boundary; exact own-property identity is not claimed.',
            'Raw BSON is authoritative for Mixed and incomplete documents; typed DTOs are strict complete views.',
            'Arbitrary JavaScript prototypes/getters, sparse arrays, and unusual BSON-to-Node identity are outside this evidence.',
            'Native ORM/driver error text is compared by generic category at injected failure boundaries.',
            'Shared bootstrap console/connection-event logging and TypeScript route/worker adoption remain open.',
            'No variation-jobs performance benchmark or production latency/resource claim was made.',
        ],
    }
    (OUT / 'verification-summary.json').write_text(json.dumps(verification, indent=2, sort_keys=True) + '\n')
    (OUT / 'README.md').write_text('''# Moderation variation jobs evidence\n\nThis evidence bundle binds the bounded native moderation-variation-jobs implementation to the final source commit and successful parent-supplied phases. `source-bindings.json` hashes every snapshot input against that Git commit, except ten unchanged `verification/posthog-rs/` SDK inputs reused from the verified `cache-and-types` binding in the earlier variations evidence. The evidence retains every run receipt and log from the initial format run through the supplied final phase, the complete 38-case actual-source oracle and read-only source/SDK provenance, the final production/resource readback, and the exact reproduction tools. `.log` payloads are gzip-only; the index records raw and stored hashes/sizes for every file.\n\nThe 38-case oracle executes pinned actual TypeScript with scripted application boundaries. The separate capped Rust fixtures exercised the native service using task-owned MongoDB/Redis and a loopback Muse responder. See `verification-summary.json` for exact parent-supplied accepted phases, resource bounds and readback. Earlier failed source/style attempts remain included and are classified by their own receipts/logs; a successful final run does not erase them.\n\nThe source and schema rows are partial local mappings within the documented BSON/serialized/native-service boundaries. The source `symbolVersion: undefined` property is assessed at JSON serialization; exact JavaScript own-property identity is not claimed. Arbitrary prototypes/getters, sparse arrays, unusual BSON-to-Node identity, exact native error wording, complete source bootstrap logging, and TypeScript caller adoption remain open. The route and semantic-moderation worker remain on TypeScript. No benchmark, deployment, TypeScript retirement, push, or total-completion claim is made.\n\nThe shared variation/provider source-freeze chain and SDK binding are documented in [moderation variations evidence](../../2026-10-30-moderation-variations/index.json); schema details and its 42-case Mongoose replay are in [variation schema evidence](../../2026-10-30-variation-schema/README.md). The isolated compiler snapshot workflow and readback helpers are retained under `tools/`; all `variation_jobs_*.sh` scripts and the source-provenance preparer are included.\n''')

    # Inventory all bundle payloads except the two indexes being written now.
    payloads = {}
    for file in sorted(OUT.rglob('*')):
        if file.is_file() and file.name not in {'index.json', 'artifact-sha256.json'}:
            payloads[str(file.relative_to(OUT))] = {'sha256': sha(file.read_bytes()), 'bytes': file.stat().st_size}
    (OUT / 'index.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    hashes = {str(file.relative_to(OUT)): sha(file.read_bytes())
              for file in sorted(OUT.rglob('*')) if file.is_file() and file.name != 'artifact-sha256.json'}
    (OUT / 'artifact-sha256.json').write_text(json.dumps(hashes, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'output': str(OUT), 'sourceInputs': len(source_hashes),
                      'gitInputs': len(git_inputs), 'reusedSdkInputs': len(sdk),
                      'acceptedRuns': len(accepted_receipts), 'retainedRuns': len(included_runs),
                      'indexedPayloads': len(manifest), 'bundleFiles': len(payloads)}, sort_keys=True))


if __name__ == '__main__':
    main()
